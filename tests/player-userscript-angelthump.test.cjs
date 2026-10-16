'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const baseConfig = require('../browser-extension/shared/config.js');
const transport = require('../userscript/transport.js');

const AT = 'https://player.angelthump.com/?channel=fixture';
const SITE = 'https://umininn-gh.github.io/tv/';
const SITE_ORIGIN = new URL(SITE).origin;
const STYLE_ID = 'umininn-angelthump-logo-style';
const config = { ...baseConfig, CHANNEL: 'umininn-tv-userscript' };
const envelope = (type, fields = {}) => ({ channel: config.CHANNEL, version: config.VERSION, type, ...fields });
const snapshot = () => ({ ok: true, code: 'OK', message: '', state: {
    available: true, volume: 0.4, muted: false, paused: true, ended: false,
    readyState: 4, playbackStatus: 'paused', recoverSupported: true, volumeSupported: true, muteSupported: true
} });
const flush = () => new Promise(resolve => setImmediate(resolve));

function events() {
    const listeners = new Map();
    return { listeners,
        addEventListener(type, callback) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(callback);
        },
        removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
        emit(type, event = {}) { for (const callback of [...(listeners.get(type) || [])]) callback(event); }
    };
}

class Node {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attributes = new Map(); this.textContent = ''; }
    get id() { return this.getAttribute('id') || ''; }
    set id(value) { this.setAttribute('id', value); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    appendChild(node) { node.remove(); this.children.push(node); node.parentNode = this; return node; }
    remove() {
        if (!this.parentNode) return;
        const index = this.parentNode.children.indexOf(this);
        if (index >= 0) this.parentNode.children.splice(index, 1);
        this.parentNode = null;
    }
}

let randomSeed = 0;
function environment(href = AT, embedded = true) {
    const win = { ...events(), location: new URL(href), sent: [], timers: new Map(),
        crypto: { getRandomValues(values) {
            const seed = ++randomSeed;
            for (let i = 0; i < values.length; i++) values[i] = (seed * 17 + i) % (values.BYTES_PER_ELEMENT === 1 ? 256 : 4294967296);
            return values;
        } },
        postMessage(message, origin) { this.sent.push({ message, origin }); }
    };
    let nextTimer = 0;
    win.setTimeout = (callback, delay) => { const id = ++nextTimer; win.timers.set(id, { callback, delay }); return id; };
    win.clearTimeout = id => win.timers.delete(id);
    win.setInterval = () => { throw new Error('No interval polling is allowed'); };
    win.runTimers = () => {
        const pending = [...win.timers.values()]; win.timers.clear();
        for (const timer of pending) timer.callback();
    };
    const parent = { ...events(), location: new URL(SITE), sent: [],
        postMessage(message, origin) { this.sent.push({ message, origin }); } };
    win.parent = embedded ? parent : win; win.top = embedded ? parent : win;
    const documentElement = new Node('html'), head = new Node('head'), body = new Node('body');
    documentElement.appendChild(head); documentElement.appendChild(body);
    const doc = { defaultView: win, documentElement, head, body,
        createElement: tag => new Node(tag),
        getElementById(id) {
            const walk = node => node.id === id ? node : node.children.map(walk).find(Boolean);
            return walk(documentElement) || null;
        } };
    win.document = doc;
    const video = new Node('video'); video.src = 'https://media.example/live.m3u8';
    video.volume = 0.37; video.muted = true; video.paused = false;
    const controls = new Node('div'); controls.id = 'platform-controls';
    const play = new Node('button'); play.onclick = () => { throw new Error('Logo cleanup must not click player controls'); };
    controls.appendChild(play); body.appendChild(video); body.appendChild(controls);
    return { win, parent, doc, video, controls, play };
}

function loadLogo() {
    const forbidden = () => { throw new Error('Logo module must not poll, observe, fetch or execute timers'); };
    const context = { module: { exports: {} }, URL, setTimeout: forbidden, setInterval: forbidden,
        requestAnimationFrame: forbidden, MutationObserver: forbidden, ResizeObserver: forbidden, fetch: forbidden };
    vm.runInNewContext(fs.readFileSync(require.resolve('../userscript/angelthump-logo.js'), 'utf8'), context,
        { filename: 'userscript/angelthump-logo.js' });
    return context.module.exports;
}

// Validate the entire emitted CSS grammar, rather than assuming arbitrary CSS
// would be safe. This unit seam intentionally accepts only exact anchor href
// selectors and one display:none!important rule; browser QA checks rendering.
function hiddenLinks(doc) {
    const css = doc.getElementById(STYLE_ID)?.textContent || '';
    if (!css) return new Set();
    const rule = /^\s*([^{}]+)\{\s*display\s*:\s*none\s*!important\s*;?\s*\}\s*$/.exec(css);
    assert.ok(rule, 'only the exact banner-hiding rule may be injected');
    return new Set(rule[1].split(',').map(selector => {
        const match = /^\s*a\[href="([^"]+)"\]\s*$/.exec(selector);
        assert.ok(match, 'selectors cannot hide images, video, controls, or arbitrary Patreon links');
        return match[1];
    }));
}

function frameFixture({ href = AT, embedded = true, angelthump = loadLogo(), bootstrap = false } = {}) {
    const f = environment(href, embedded), reports = new Set(), calls = [];
    let created = 0, disposed = 0, client;
    const media = { createMediaController({ document }) {
        assert.equal(document, f.doc); created++;
        return { getState: snapshot, execute(command) { calls.push(command); return snapshot(); },
            subscribe(callback) { reports.add(callback); callback(snapshot()); return () => reports.delete(callback); },
            dispose() { disposed++; } };
    } };
    if (bootstrap) {
        const scope = { UmininnConfig: baseConfig, UmininnMedia: media, UmininnAngelThump: angelthump,
            UmininnUserscript: { createFrameClient(options) { client = transport.createFrameClient(options); return client; } },
            userscriptVersion: 'fixture' };
        vm.runInNewContext(fs.readFileSync(require.resolve('../userscript/bootstrap.js'), 'utf8'),
            { window: f.win, document: f.doc, scope, URL }, { filename: 'userscript/bootstrap.js' });
    } else client = transport.createFrameClient({ window: f.win, config, media, angelthump });
    return { ...f, reports, calls, client,
        get created() { return created; }, get disposed() { return disposed; },
        probe(fields = {}, origin = SITE_ORIGIN, source = f.parent) {
            f.win.emit('message', { source, origin, data: envelope('frame:probe', fields) });
        } };
}

test('logo controller is limited to HTTPS root-path AngelThump iframe documents', () => {
    const api = loadLogo();
    for (const href of [AT, 'https://player.angelthump.com:443/?channel=another#fragment', 'https://player.angelthump.com/']) {
        const f = environment(href); const controller = api.createLogoController({ document: f.doc, location: f.win.location });
        assert.equal(f.doc.head.children.length, 1); assert.ok(f.doc.getElementById(STYLE_ID)); controller.dispose();
    }
    for (const href of ['http://player.angelthump.com/', 'https://player.angelthump.com:8443/',
        'https://player.angelthump.com/index.html', 'https://player.angelthump.com/embed/',
        'https://player.angelthump.com.evil.example/', 'https://evil.player.angelthump.com/',
        'https://player.twitch.tv/', 'https://user:password@player.angelthump.com/']) {
        const f = environment(href); api.createLogoController({ document: f.doc, location: f.win.location }).dispose();
        assert.equal(f.doc.head.children.length, 0, href);
    }
    const top = environment(AT, false); api.createLogoController({ document: top.doc, location: top.win.location }).dispose();
    assert.equal(top.doc.head.children.length, 0);
    assert.doesNotThrow(() => api.createLogoController().dispose());
    assert.doesNotThrow(() => api.createLogoController({ document: {} }).dispose());
});

test('one static rule hides only the four exact Patreon campaign link variants, including future mounts, without timers', () => {
    const api = loadLogo(), f = environment();
    f.win.setTimeout = f.win.setInterval = () => { throw new Error('Logo feature must not create timers'); };
    const controller = api.createLogoController({ document: f.doc, location: f.win.location });
    const expected = ['https://patreon.com/join/angelthump', 'https://patreon.com/join/angelthump/',
        'https://www.patreon.com/join/angelthump', 'https://www.patreon.com/join/angelthump/'];
    const hidden = hiddenLinks(f.doc);
    assert.deepEqual([...hidden].sort(), expected.sort());
    for (const href of expected) {
        const late = new Node('a'); late.setAttribute('href', href); f.doc.body.appendChild(late);
        assert.equal(hidden.has(late.getAttribute('href')), true, 'static CSS covers a later React banner without observation');
    }
    for (const href of ['https://patreon.com/join/another', 'https://patreon.com/angelthump',
        'https://patreon.com/join/angelthump?tracking=1', 'https://patreon.com/join/angelthump/other',
        'https://evil.example/?url=https://patreon.com/join/angelthump']) assert.equal(hidden.has(href), false);
    assert.equal(f.win.timers.size, 0); controller.dispose();
});

test('duplicate controllers preserve the existing style and each dispose owns only its inserted node', () => {
    const api = loadLogo(), f = environment();
    const first = api.createLogoController({ document: f.doc });
    const style = f.doc.getElementById(STYLE_ID);
    const duplicate = api.createLogoController({ document: f.doc });
    assert.equal(f.doc.head.children.length, 1);
    duplicate.dispose(); assert.equal(f.doc.getElementById(STYLE_ID), style, 'no-op duplicate cannot remove another controller style');
    first.dispose(); first.dispose(); assert.equal(f.doc.getElementById(STYLE_ID), null);
    const replacement = api.createLogoController({ document: f.doc });
    const newStyle = f.doc.getElementById(STYLE_ID); assert.notEqual(newStyle, style);
    first.dispose(); assert.equal(f.doc.getElementById(STYLE_ID), newStyle, 'late dispose cannot remove a replacement style');
    replacement.dispose();
    const external = new Node('style'); external.id = STYLE_ID; external.textContent = '/* pre-existing owner */'; f.doc.head.appendChild(external);
    api.createLogoController({ document: f.doc }).dispose();
    assert.equal(f.doc.getElementById(STYLE_ID), external); assert.equal(external.textContent, '/* pre-existing owner */');
});

test('creation/disposal preserve video, controls, audio, source and unrelated DOM; missing head uses document root', () => {
    const api = loadLogo(), f = environment();
    const bodyChildren = [...f.doc.body.children], playAction = f.play.onclick;
    const unrelated = new Node('style'); unrelated.id = 'unrelated'; unrelated.textContent = 'body { color: white }'; f.doc.head.appendChild(unrelated);
    const original = { volume: f.video.volume, muted: f.video.muted, paused: f.video.paused, src: f.video.src };
    const controller = api.createLogoController({ document: f.doc }); controller.dispose();
    assert.deepEqual(f.doc.body.children, bodyChildren); assert.equal(f.play.onclick, playAction);
    assert.deepEqual({ volume: f.video.volume, muted: f.video.muted, paused: f.video.paused, src: f.video.src }, original);
    assert.equal(f.doc.head.children.length, 1); assert.equal(f.doc.head.children[0], unrelated);
    f.doc.head = null;
    const fallback = api.createLogoController({ document: f.doc });
    assert.equal(f.doc.getElementById(STYLE_ID).parentNode, f.doc.documentElement); fallback.dispose();
    assert.deepEqual(f.doc.body.children, bodyChildren);
});

test('transport applies the optional cosmetic factory only after an approved direct-parent userscript probe and once per start', () => {
    const applied = []; let removed = 0;
    const f = frameFixture({ angelthump: { createLogoController(options) { applied.push(options); return { dispose() { removed++; } }; } } });
    assert.equal(applied.length, 0); assert.equal(f.created, 0);
    f.probe({}, 'https://evil.example'); f.probe({}, SITE_ORIGIN, {});
    f.probe({ channel: baseConfig.CHANNEL }); f.probe({ version: 2 });
    assert.equal(applied.length, 0); assert.equal(f.created, 0);
    f.probe(); f.probe();
    assert.equal(applied.length, 1); assert.equal(f.created, 1);
    assert.equal(applied[0].document, f.doc); assert.equal(applied[0].location, f.win.location);
    assert.equal(f.parent.sent.at(-1).message.type, 'frame:ready'); assert.equal(f.calls.length, 0);
    f.client.dispose(); f.client.dispose(); assert.equal(removed, 1); assert.equal(f.disposed, 1);
});

test('top-level/unapproved player documents and a changed parent cannot activate the logo feature', () => {
    for (const options of [{ href: AT, embedded: false }, { href: 'https://evil.example/' }, { href: 'http://player.angelthump.com/' }]) {
        const f = frameFixture(options); f.probe();
        assert.equal(f.doc.getElementById(STYLE_ID), null); assert.equal(f.created, 0); f.client.dispose();
    }
    const f = frameFixture(); f.win.parent = {}; f.probe();
    assert.equal(f.created, 0); assert.equal(f.doc.getElementById(STYLE_ID), null); f.client.dispose();
});

test('approved non-AngelThump players retain transport controls but receive no cosmetic style', () => {
    for (const href of ['https://player.kick.com/fixture', 'https://player.twitch.tv/?channel=fixture', 'https://player.angelthump.com/other']) {
        const f = frameFixture({ href }); f.probe();
        assert.equal(f.created, 1); assert.equal(f.parent.sent.at(-1).message.type, 'frame:ready');
        assert.equal(f.doc.getElementById(STYLE_ID), null); f.client.dispose();
    }
});

test('bfcache removes the logo rule and media controller, then waits for a new approved probe before reapplying once', () => {
    const f = frameFixture(); f.probe();
    const original = f.doc.getElementById(STYLE_ID), identity = f.parent.sent.at(-1).message;
    const nodes = [...f.doc.body.children]; assert.ok(original);
    f.win.emit('pagehide', { persisted: true });
    assert.equal(f.doc.getElementById(STYLE_ID), null); assert.equal(f.disposed, 1);
    assert.equal(f.reports.size, 0); assert.equal(f.win.timers.size, 0);
    f.probe(); assert.equal(f.created, 1);
    f.win.emit('pageshow', { persisted: true });
    assert.equal(f.doc.getElementById(STYLE_ID), null, 'a cached restore does not silently authorize the patch');
    f.probe(); f.probe();
    assert.equal(f.created, 2); assert.notEqual(f.doc.getElementById(STYLE_ID), original);
    assert.equal(f.doc.head.children.length, 1); assert.notEqual(f.parent.sent.at(-1).message.token, identity.token);
    assert.deepEqual(f.doc.body.children, nodes);
    f.win.emit('pagehide', { persisted: false });
    assert.equal(f.doc.getElementById(STYLE_ID), null); assert.equal(f.disposed, 2);
    assert.equal(f.win.listeners.get('message').size, 0); f.probe(); assert.equal(f.created, 2);
});

test('bootstrap passes its private AngelThump module to the frame transport and prevents duplicate installation', () => {
    const f = environment(), angelthump = loadLogo(), options = [];
    const scope = { UmininnConfig: baseConfig, UmininnMedia: {}, UmininnTwitch: {}, UmininnAngelThump: angelthump,
        UmininnUserscript: { createFrameClient(value) { options.push(value); return { dispose() {} }; } }, userscriptVersion: 'fixture' };
    const code = fs.readFileSync(require.resolve('../userscript/bootstrap.js'), 'utf8');
    const sandbox = vm.createContext({ window: f.win, document: f.doc, scope, URL });
    vm.runInContext(code, sandbox); vm.runInContext(code, sandbox);
    assert.equal(options.length, 1); assert.equal(options[0].angelthump, angelthump);
    assert.equal(options[0].media, scope.UmininnMedia); assert.equal(options[0].twitch, scope.UmininnTwitch);
    assert.equal(f.doc.getElementById(STYLE_ID), null, 'bootstrap itself does not bypass parent authorization');
    f.win.emit('pagehide', { persisted: false });
    assert.equal(f.doc.documentElement.hasAttribute('data-umininn-player-userscript'), false);
});

test('real bootstrap/transport remove and reauthorize the cosmetic style across cached restores', () => {
    const f = frameFixture({ bootstrap: true });
    assert.equal(f.doc.getElementById(STYLE_ID), null); f.probe(); assert.ok(f.doc.getElementById(STYLE_ID));
    f.win.emit('pagehide', { persisted: true });
    assert.equal(f.doc.getElementById(STYLE_ID), null);
    assert.equal(f.doc.documentElement.hasAttribute('data-umininn-player-userscript'), true);
    f.win.emit('pageshow', { persisted: true }); assert.equal(f.doc.getElementById(STYLE_ID), null);
    f.probe(); assert.ok(f.doc.getElementById(STYLE_ID)); assert.equal(f.created, 2);
    f.win.emit('pagehide', { persisted: false });
    assert.equal(f.doc.getElementById(STYLE_ID), null); assert.equal(f.disposed, 2);
    assert.equal(f.doc.documentElement.hasAttribute('data-umininn-player-userscript'), false);
    for (const type of ['message', 'pagehide', 'pageshow']) assert.equal(f.win.listeners.get(type).size, 0);
});

test('a cosmetic creation failure does not delay the first approved playback-control handshake', () => {
    const f = frameFixture({ angelthump: { createLogoController() { throw new Error('cosmetic creation failed'); } } });
    f.probe();
    assert.equal(f.parent.sent.at(-1)?.message.type, 'frame:ready');
    assert.equal(f.created, 1); f.client.dispose(); assert.equal(f.disposed, 1);
});

test('a cosmetic disposal failure cannot prevent media cleanup, listener cleanup or late-command cancellation', async () => {
    const f = frameFixture({ angelthump: { createLogoController() { return { dispose() { throw new Error('cosmetic disposal failed'); } }; } } });
    f.probe(); const ready = f.parent.sent.at(-1).message;
    f.win.emit('message', { source: f.parent, origin: SITE_ORIGIN, data: envelope('userscript:command', {
        frameId: ready.frameId, token: ready.token, documentId: ready.documentId,
        requestId: `${'d'.repeat(48)}_1`, sessionId: 'c'.repeat(48), sequence: 1, command: { action: 'recover' }
    }) });
    assert.doesNotThrow(() => f.client.dispose()); await flush();
    assert.equal(f.disposed, 1); assert.equal(f.calls.length, 0); assert.equal(f.reports.size, 0); assert.equal(f.win.timers.size, 0);
    for (const type of ['message', 'pagehide', 'pageshow']) assert.equal(f.win.listeners.get(type).size, 0);
});
