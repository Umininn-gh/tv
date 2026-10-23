'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMediaController } = require('../browser-extension/shared/media-controller.js');
const { createFrameClient, createSiteTransport } = require('../userscript/transport.js');
const originalConfig = require('../browser-extension/shared/config.js');

const config = { ...originalConfig, CHANNEL: 'umininn-tv-userscript' };
const SITE = 'https://umininn-gh.github.io/tv/';
const PLAYER = 'https://player.kick.com/longevity';
const siteOrigin = new URL(SITE).origin;
const playerOrigin = new URL(PLAYER).origin;
const envelope = (type, extra = {}) => ({ channel: config.CHANNEL, version: config.VERSION, type, ...extra });
const flush = () => new Promise(resolve => setImmediate(resolve));

class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    emit(type, fields = {}) {
        const event = { type, currentTarget: this, target: this, ...fields };
        for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
    }
    dispatchEvent(event) { this.emit(event.type, event); return true; }
}
function createClock() {
    const clock = { now: 0, next: 0, timers: new Map(),
        setTimeout(fn, ms) { const id = ++clock.next; clock.timers.set(id, { fn, at: clock.now + ms }); return id; },
        clearTimeout(id) { clock.timers.delete(id); },
        tick(ms) {
            const end = clock.now + ms;
            let budget = 10000;
            for (;;) {
                const next = [...clock.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                assert.ok(--budget > 0, 'controller timers must remain bounded');
                clock.now = next[1].at; clock.timers.delete(next[0]); next[1].fn();
            }
            clock.now = end;
        }
    };
    return clock;
}
let seed = 0;
function createWindow(href, clock) {
    const win = new Events();
    Object.assign(win, {
        location: { href }, innerWidth: 1280, innerHeight: 720,
        setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        crypto: { getRandomValues(values) { const ownSeed = ++seed; values.forEach((_, i) => { values[i] = (ownSeed * 31 + i) % (values.BYTES_PER_ELEMENT === 1 ? 256 : 4294967296); }); return values; } },
        getComputedStyle: node => ({ display: 'block', visibility: 'visible', opacity: '1', ...node.style }),
        CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } }
    });
    Object.defineProperty(win, 'now', { get: () => clock.now });
    win.top = win; win.parent = win;
    return win;
}
function mediaFixture() {
    const clock = createClock(), win = createWindow(PLAYER, clock), mutations = [];
    class Node extends Events {
        constructor(tag) { super(); this.tagName = tag; this.children = []; this.style = {}; this.hidden = false; this.rect = { left: 0, top: 0, width: 640, height: 360 }; }
        get isConnected() { return this === doc || Boolean(this.parentNode?.isConnected) || Boolean(this.host?.isConnected); }
        get parentElement() { return this.parentNode?.tagName ? this.parentNode : null; }
        getRootNode() { return this.parentNode ? this.parentNode.getRootNode() : this; }
        append(node) { node.parentNode = this; this.children.push(node); return node; }
        remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
        querySelectorAll(selector) {
            const nodes = this.children.flatMap(node => [node, ...node.querySelectorAll('*')]);
            return selector === '*' ? nodes : nodes.filter(node => ['VIDEO', 'AUDIO'].includes(node.tagName));
        }
        getBoundingClientRect() { return this.rect; }
    }
    class Media extends Node {
        constructor(tag = 'VIDEO') { super(tag); this._muted = false; this._volume = 0.3; this.paused = false; this.ended = false; this.readyState = 4; this.error = null; this.playCalls = 0; this.pauseCalls = 0; this.loadCalls = 0; this.writes = []; }
        get volume() { return this._volume; }
        set volume(value) { this.writes.push(['volume', value]); this._volume = value; this.emit('volumechange'); }
        get muted() { return this._muted; }
        set muted(value) { this.writes.push(['muted', value]); this._muted = value; this.emit('volumechange'); }
        get src() { assert.fail('audio focus must not read the media source'); }
        set src(_) { assert.fail('audio focus must not replace the media source'); }
        play() { this.playCalls++; this.paused = false; return Promise.resolve(); }
        pause() { this.pauseCalls++; this.paused = true; }
        load() { this.loadCalls++; assert.fail('audio focus must not reload media'); }
    }
    const doc = new Node(); doc.defaultView = win; doc.documentElement = doc.append(new Node('HTML'));
    win.document = doc;
    win.MutationObserver = class { constructor(fn) { this.fn = fn; mutations.push(this); } observe() {} disconnect() {} };
    const add = (tag = 'VIDEO', parent = doc.documentElement) => parent.append(new Media(tag));
    const mount = () => createMediaController({ document: doc, clock });
    return { clock, win, doc, Node, Media, add, mount, mutate() { for (const observer of mutations) observer.fn([]); } };
}
function connectedFixture(options = {}) {
    const f = mediaFixture(), site = createWindow(SITE, f.clock);
    const frame = Object.assign(new Events(), { tagName: 'IFRAME', src: PLAYER, contentWindow: f.win, isConnected: true });
    const container = { isConnected: true, children: [frame] };
    site.document = { documentElement: {}, getElementById: id => id === 'multi-stream-container' ? container : null };
    site.MutationObserver = class { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} };
    f.win.parent = site; f.win.top = site;
    f.win.postMessage = (data, origin) => {
        assert.equal(origin, playerOrigin);
        queueMicrotask(() => f.win.emit('message', { data, origin: siteOrigin, source: site }));
    };
    site.postMessage = (data, origin) => {
        assert.equal(origin, siteOrigin);
        queueMicrotask(() => site.emit('message', { data, origin: playerOrigin, source: f.win }));
    };
    let identity;
    site.addEventListener('message', event => { if (event.data.type === 'frame:ready') identity = event.data; });
    const transport = createSiteTransport({ window: site, config });
    const client = createFrameClient({ window: f.win, config, media: { createMediaController: options.createMediaController || f.mount } });
    return { ...f, site, frame, transport, client,
        probe() { f.win.postMessage(envelope('frame:probe'), playerOrigin); },
        get identity() { return identity; },
        command(action, value, extra = {}) {
            assert.ok(identity, 'player handshake completed');
            const { frameId, token, documentId } = identity;
            return transport.sendMessage(envelope('site:command', { target: { frameId, token, documentId }, command: { action, ...(value === undefined ? {} : { value }), ...extra } }));
        },
        dispose() { client.dispose(); transport.dispose(); }
    };
}

test('longevity: a previously guarded player releases the hidden active audio it muted, while keeping an originally muted preload silent', async () => {
    const f = mediaFixture(), video = f.add(), audio = f.add('AUDIO'), preload = f.add();
    audio.hidden = true; preload.hidden = true; preload._muted = true; preload.paused = true;
    const controller = f.mount();
    await controller.execute({ action: 'setMuted', value: true, guard: true });
    assert.ok([video, audio, preload].every(node => node.muted), 'peer protection covers every media node');
    f.clock.tick(2 * 24 * 60 * 60 * 1000);
    await controller.execute({ action: 'setVolume', value: 1, focus: true });
    const result = await controller.execute({ action: 'setMuted', value: false, focus: true });
    assert.equal(result.ok, true);
    assert.equal(video.muted, false);
    assert.equal(audio.muted, false, 'releasing our earlier guard must release a separate active soundtrack');
    assert.equal(audio.volume, 1, 'the now selected player soundtrack receives the requested 100% volume');
    assert.equal(preload.muted, true, 'a platform-owned muted preload must not accidentally become audible');
    for (const node of [video, audio, preload]) assert.deepEqual([node.playCalls, node.pauseCalls, node.loadCalls], [0, 0, 0]);
    controller.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('longevity: explicit focus can rearm a guard after repeated platform overrides exhausted its bounded repair budget', async () => {
    const f = mediaFixture(), video = f.add(), controller = f.mount();
    await controller.execute({ action: 'setMuted', value: true, guard: true });
    for (let i = 0; i < 12; i++) { video._muted = false; video.emit('volumechange'); f.clock.tick(80); }
    assert.equal(controller.getState().ok, false, 'a hostile platform must not cause an unbounded setter loop');
    f.clock.tick(24 * 60 * 60 * 1000);
    const result = await controller.execute({ action: 'setMuted', value: true, guard: true });
    assert.equal(result.ok, true); assert.equal(video.muted, true);
    await controller.execute({ action: 'setVolume', value: 1, focus: true });
    await controller.execute({ action: 'setMuted', value: false, focus: true });
    assert.equal(video.volume, 1); assert.equal(video.muted, false);
    controller.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('longevity: repeated safety mutes retain the original ownership of a separate soundtrack across a replacement', async () => {
    const f = mediaFixture(), main = f.add(), oldAudio = f.add('AUDIO'); oldAudio.hidden = true;
    const controller = f.mount();
    await controller.execute({ action: 'setMuted', value: true, guard: true });
    f.clock.tick(24 * 60 * 60 * 1000);
    oldAudio.remove(); const audio = f.add('AUDIO'); audio.hidden = true;
    const preload = f.add(); preload.hidden = true; preload._muted = true; preload.paused = true;
    f.mutate(); f.clock.tick(80);
    const removedWrites = oldAudio.writes.length;
    assert.equal(audio.muted, true, 'late soundtrack is muted by the retained peer policy');
    for (let i = 0; i < 4; i++) await controller.execute({ action: 'setMuted', value: true, guard: true });
    await controller.execute({ action: 'setVolume', value: 1, focus: true });
    await controller.execute({ action: 'setMuted', value: false, focus: true });
    assert.equal(main.muted, false); assert.equal(audio.muted, false);
    assert.equal(audio.volume, 1); assert.equal(preload.muted, true);
    assert.equal(oldAudio.writes.length, removedWrites, 'no release may write to a disconnected old soundtrack');
    controller.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('longevity: an explicit ordinary mute supersedes an old guard without later reopening its hidden media', async () => {
    const f = mediaFixture(), video = f.add(), hidden = f.add('AUDIO'); hidden.hidden = true;
    const controller = f.mount();
    await controller.execute({ action: 'setMuted', value: true, guard: true });
    await controller.execute({ action: 'setMuted', value: true });
    await controller.execute({ action: 'setMuted', value: false });
    assert.equal(video.muted, false);
    assert.equal(hidden.muted, true, 'an explicitly superseded focus guard must not revive stale hidden media');
    controller.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('longevity: a genuine native player action relinquishes the old hidden-route ownership before a later solo request', async () => {
    const f = mediaFixture(), video = f.add(), hidden = f.add('AUDIO'); hidden.hidden = true;
    const controller = f.mount();
    await controller.execute({ action: 'setMuted', value: true, guard: true });
    f.doc.emit('pointerdown', { isTrusted: true });
    assert.equal(controller.getState().state.audioUserRevision, 1);
    assert.equal(controller.getState().state.muteGuardActive, false);
    await controller.execute({ action: 'setVolume', value: 1, focus: true });
    await controller.execute({ action: 'setMuted', value: false, focus: true });
    assert.equal(video.muted, false);
    assert.equal(hidden.muted, true, 'native intent relinquished ownership; a later request may not revive the stale hidden route');
    controller.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('longevity: guard persists without polling for days and captures hidden replacement audio created after an ad/media swap', async () => {
    const f = mediaFixture(), video = f.add(), controller = f.mount();
    await controller.execute({ action: 'setMuted', value: true, guard: true });
    const writes = video.writes.length;
    f.clock.tick(7 * 24 * 60 * 60 * 1000);
    assert.equal(video.writes.length, writes, 'idle days do not issue volume or mute writes');
    assert.equal(f.clock.timers.size, 0, 'no permanent guard polling');
    video.remove(); const replacement = f.add(), hidden = f.add('AUDIO'); hidden.hidden = true;
    f.mutate(); f.clock.tick(80);
    assert.equal(replacement.muted, true); assert.equal(hidden.muted, true);
    assert.equal(controller.getState().state.muteGuardActive, true);
    controller.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('longevity: authenticated userscript controls and capabilities remain usable after seven idle days and many focus cycles', async () => {
    const f = connectedFixture(), video = f.add();
    f.probe(); await flush(); const first = f.identity;
    f.clock.tick(7 * 24 * 60 * 60 * 1000); await flush();
    for (let i = 0; i < 40; i++) {
        assert.equal((await f.command('setMuted', true, { guard: true })).ok, true);
        assert.equal((await f.command('setVolume', 1, { focus: true })).ok, true);
        assert.equal((await f.command('setMuted', false, { focus: true })).ok, true);
    }
    assert.equal(video.muted, false); assert.equal(video.volume, 1);
    assert.equal(f.identity.token, first.token, 'an idle approved document has no expiring token');
    assert.equal(f.identity.documentId, first.documentId);
    assert.deepEqual([video.playCalls, video.pauseCalls, video.loadCalls], [0, 0, 0]);
    f.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('longevity: authenticated native audio intent revisions survive userscript result and state announcement sanitization', async () => {
    const f = connectedFixture(); f.add(); f.probe(); await flush();
    assert.equal(f.identity.result.state.audioUserRevision, 0, 'initial authenticated state carries a bounded revision');
    await f.command('setMuted', true, { guard: true });
    f.doc.emit('pointerdown', { isTrusted: true });
    const result = await f.command('getState');
    assert.equal(result.state.audioUserRevision, 1, 'the site must distinguish a real native override from delayed platform state');
    assert.equal(result.state.muteGuardActive, false);
    f.clock.tick(100); await flush();
    assert.equal(f.identity.result.state.audioUserRevision, 1, 'coalesced ready reports must carry the same revision');
    f.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('longevity: native audio revisions are nonnegative safe integers on the authenticated transport', async () => {
    let revision = 0;
    const snapshot = () => ({ ok: true, code: 'OK', message: '', state: { available: true, muted: true, volume: 1,
        volumeSupported: true, muteSupported: true, audioUserRevision: revision } });
    const f = connectedFixture({ createMediaController() {
        return { getState: snapshot, execute: snapshot, subscribe: () => () => {}, dispose() {} };
    } });
    f.probe(); await flush();
    for (const value of [0, 1, 200000, Number.MAX_SAFE_INTEGER]) {
        revision = value;
        const result = await f.command('getState');
        assert.equal(result.state.audioUserRevision, value, `valid revision ${value} survives`);
    }
    for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
        revision = value;
        const result = await f.command('getState');
        assert.equal(result.state.audioUserRevision, undefined, `invalid revision ${String(value)} is removed`);
    }
    f.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('longevity: only the two explicit solo-opening commands may carry the focus capability flag', async () => {
    const f = connectedFixture(), video = f.add(); f.probe(); await flush();
    for (const [action, value, extra] of [
        ['getState', undefined, { focus: true }], ['recover', undefined, { focus: true }],
        ['setVolume', 0.5, { focus: true }], ['setVolume', 1, { focus: false }],
        ['setMuted', true, { focus: true }], ['setMuted', false, { focus: false }],
        ['setMuted', true, { focus: true, guard: true }], ['setMuted', false, { focus: true, guard: true }],
        ['setVolume', 1, { focus: 'true' }], ['setMuted', false, { focus: null }]
    ]) {
        const writes = video.writes.length;
        const result = await f.command(action, value, extra);
        assert.equal(result.code, 'INVALID_COMMAND', `${action} ${String(value)} ${JSON.stringify(extra)} rejected`);
        assert.equal(video.writes.length, writes, 'malformed or non-opening focus flags never reach media');
    }
    const result = await f.command('setVolume', 1, { focus: true });
    assert.equal(result.ok, true); assert.equal(video.volume, 1);
    assert.equal((await f.command('setMuted', false, { focus: true })).ok, true);
    f.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('longevity: a focused soundtrack refusing unmute must not be reported as successfully opened', async () => {
    const f = mediaFixture(), video = f.add(), audio = f.add('AUDIO'); audio.hidden = true;
    const controller = f.mount();
    await controller.execute({ action: 'setMuted', value: true, guard: true });
    Object.defineProperty(audio, 'muted', { configurable: true, get: () => true,
        set(value) { audio.writes.push(['muted', value]); audio.emit('volumechange'); } });
    await controller.execute({ action: 'setVolume', value: 1, focus: true });
    const result = await controller.execute({ action: 'setMuted', value: false, focus: true });
    assert.equal(result.ok, false, 'primary video alone cannot prove that the separate soundtrack opened');
    assert.equal(result.code, 'NOT_APPLIED');
    assert.equal(audio.muted, true); assert.equal(video.volume, 1);
    controller.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('longevity: native input after a partial focus failure also relinquishes retained hidden-route ownership', async () => {
    const f = mediaFixture(), video = f.add(), audio = f.add('AUDIO'); audio.hidden = true;
    const controller = f.mount();
    await controller.execute({ action: 'setMuted', value: true, guard: true });
    let refuse = true;
    Object.defineProperty(audio, 'muted', { configurable: true, get: () => audio._muted,
        set(value) { if (!refuse) audio._muted = value; audio.emit('volumechange'); } });
    await controller.execute({ action: 'setVolume', value: 1, focus: true });
    const failed = await controller.execute({ action: 'setMuted', value: false, focus: true });
    assert.equal(failed.ok, false); assert.equal(failed.state.muteGuardActive, false);
    assert.equal(failed.state.focusRestorePending, true, 'failed secondary opening remains explicitly pending');
    f.doc.emit('pointerdown', { isTrusted: true });
    assert.equal(controller.getState().state.focusRestorePending, false, 'native intent clears ownership even without an active guard');
    refuse = false;
    await controller.execute({ action: 'setMuted', value: false, focus: true });
    assert.equal(video.muted, false); assert.equal(audio.muted, true, 'old failed focus must not revive a native-overridden route');
    controller.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('longevity: pending hidden-route focus restoration survives authenticated state and reply sanitization', async () => {
    const f = connectedFixture(); f.add(); const audio = f.add('AUDIO'); audio.hidden = true;
    f.probe(); await flush();
    assert.equal(f.identity.result.state.focusRestorePending, false);
    const guarded = await f.command('setMuted', true, { guard: true });
    assert.equal(guarded.state.focusRestorePending, true, 'a hidden route actually silenced by us requires explicit release');
    f.clock.tick(100); await flush();
    assert.equal(f.identity.result.state.focusRestorePending, true, 'ready announcements preserve the same pending flag');
    await f.command('setVolume', 1, { focus: true });
    const opened = await f.command('setMuted', false, { focus: true });
    assert.equal(opened.state.focusRestorePending, false);
    assert.equal(audio.muted, false); assert.equal(audio.volume, 1);
    f.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('longevity: cached frame restoration renews capabilities and controls replacement media without reopening old media', async () => {
    const f = connectedFixture(), first = f.add(); f.probe(); await flush();
    await f.command('setMuted', true, { guard: true });
    const old = f.identity;
    f.site.emit('pagehide', { persisted: true }); f.win.emit('pagehide', { persisted: true });
    first.remove(); const replacement = f.add(); replacement._muted = true;
    f.clock.tick(24 * 60 * 60 * 1000);
    f.site.emit('pageshow', { persisted: true }); f.win.emit('pageshow', { persisted: true });
    f.clock.tick(0); await flush();
    assert.notEqual(f.identity.documentId, old.documentId);
    await f.command('setVolume', 1, { focus: true }); await f.command('setMuted', false, { focus: true });
    assert.equal(replacement.muted, false); assert.equal(replacement.volume, 1);
    assert.equal(first.muted, true, 'an obsolete disconnected document/media must never reopen');
    f.dispose(); assert.equal(f.clock.timers.size, 0);
});
