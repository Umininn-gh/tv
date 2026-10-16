'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createFrameClient } = require('../userscript/transport.js');
const baseConfig = require('../browser-extension/shared/config.js');

const AT = 'https://player.angelthump.com/?channel=fixture';
const SITE = 'https://umininn-gh.github.io';
const STYLE = 'umininn-angelthump-logo-style';

class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback, options) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        const capture = options === true || Boolean(options?.capture);
        if (!this.listeners.get(type).some(item => item.callback === callback && item.capture === capture)) this.listeners.get(type).push({ callback, capture });
    }
    removeEventListener(type, callback, options) {
        const capture = options === true || Boolean(options?.capture);
        this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item.callback !== callback || item.capture !== capture));
    }
    count(type) { return (this.listeners.get(type) || []).length; }
    emit(type, fields = {}) {
        const event = { type, target: this, bubbles: true, defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; }, ...fields };
        // Non-bubbling media events reach the document only in capture phase.
        for (const { callback, capture } of [...(this.listeners.get(type) || [])]) if (event.bubbles || capture) callback(event);
        return event;
    }
}

class Node extends Events {
    constructor(tag) {
        super(); this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null;
        this.attributes = new Map(); this.textContent = ''; this.hover = false; this.dispatched = [];
    }
    get id() { return this.getAttribute('id') || ''; }
    set id(value) { this.setAttribute('id', value); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    appendChild(node) { node.remove(); this.children.push(node); node.parentElement = this; return node; }
    remove() {
        if (!this.parentElement) return;
        const parent = this.parentElement; parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null;
    }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    matches(selector) {
        return selector.split(',').some(part => {
            const simple = part.trim();
            if (simple === ':hover') return this.hover;
            const match = /^(?:([a-zA-Z]+))?(?:\[([\w-]+)="([^"]*)"\])?$/.exec(simple);
            if (!match) throw new Error(`Unhandled fixture selector: ${simple}`);
            return (!match[1] || this.tagName === match[1].toUpperCase()) && (!match[2] || this.getAttribute(match[2]) === match[3]);
        });
    }
    querySelectorAll(selector) {
        return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    dispatchEvent(event) { event.target = this; this.dispatched.push(event); return true; }
}

function fixture({ mounted = true, paused = false, ended = false, readyState = 4,
    href = AT, embedded = true, tabindex = '-1' } = {}) {
    const forbidden = () => { throw new Error('Controls helper must not poll, fetch or create observers'); };
    class MouseEvent {
        constructor(type, options = {}) { this.type = type; this.bubbles = false; this.relatedTarget = null; Object.assign(this, options); }
    }
    const win = new Events(), parent = { sent: [], postMessage(message, origin) { this.sent.push({ message, origin }); } };
    win.location = new URL(href); win.parent = embedded ? parent : win; win.top = win.parent;
    win.MouseEvent = MouseEvent; win.setTimeout = win.setInterval = win.requestAnimationFrame = forbidden;
    win.MutationObserver = win.ResizeObserver = forbidden;
    const html = new Node('html'), head = new Node('head'), body = new Node('body');
    html.appendChild(head); html.appendChild(body);
    const doc = Object.assign(new Events(), { defaultView: win, documentElement: html, head, body, activeElement: body,
        createElement: tag => new Node(tag), querySelectorAll: selector => html.querySelectorAll(selector),
        getElementById(id) {
            const search = node => node.id === id ? node : node.children.map(search).find(Boolean);
            return search(html) || null;
        } });
    win.document = doc;
    const surface = new Node('div'); surface.setAttribute('tabindex', tabindex);
    const video = new Node('video'), controls = new Node('div'), button = new Node('button');
    Object.assign(video, { paused, ended, readyState, volume: 0.37, muted: true, src: 'https://media.example/live.m3u8', currentTime: 42 });
    const actions = { play: 0, pause: 0, load: 0 };
    for (const action of Object.keys(actions)) video[action] = () => { actions[action]++; throw new Error(`Helper must not ${action} media`); };
    controls.appendChild(button); surface.appendChild(video); surface.appendChild(controls);
    if (mounted) body.appendChild(surface);
    const sandbox = { module: { exports: {} }, URL, setTimeout: forbidden, setInterval: forbidden,
        requestAnimationFrame: forbidden, MutationObserver: forbidden, ResizeObserver: forbidden, fetch: forbidden };
    vm.runInNewContext(fs.readFileSync(require.resolve('../userscript/angelthump-logo.js'), 'utf8'), sandbox,
        { filename: 'userscript/angelthump-logo.js' });
    const api = sandbox.module.exports;
    return { win, parent, doc, html, head, body, surface, video, controls, button, actions, api,
        start: () => api.createLogoController({ document: doc, location: win.location }),
        playing(changes = {}, target = video) { Object.assign(video, changes); return doc.emit('playing', { target, bubbles: false }); },
        key(target, key, fields = {}) { return doc.emit('keydown', { target, key, ...fields }); },
        types: () => surface.dispatched.map(event => event.type) };
}

function assertNoMediaActions(f) {
    assert.deepEqual(f.actions, { play: 0, pause: 0, load: 0 });
    assert.equal(f.video.volume, 0.37); assert.equal(f.video.muted, true);
    assert.equal(f.video.src, 'https://media.example/live.m3u8'); assert.equal(f.video.currentTime, 42);
}

test('an already-playing video receives one bubbling mouseout on its direct platform surface, including when that surface was auto-focused', () => {
    for (const autoFocus of [false, true]) {
        const f = fixture(); if (autoFocus) f.doc.activeElement = f.surface;
        const controller = f.start();
        assert.deepEqual(f.types(), ['mouseout']);
        const event = f.surface.dispatched[0];
        assert.equal(event.target, f.surface); assert.equal(event.bubbles, true); assert.equal(event.relatedTarget, null);
        assert.equal(f.doc.activeElement, autoFocus ? f.surface : f.body, 'helper does not blur or steal focus');
        assert.equal(f.doc.count('playing'), 0); assert.equal(f.doc.count('keydown'), 1);
        assert.equal(f.doc.listeners.get('keydown')[0].capture, true);
        f.playing(); f.playing(); assert.deepEqual(f.types(), ['mouseout']);
        assertNoMediaActions(f); controller.dispose();
    }
});

test('a late-mounted player is handled by one capture playing listener without observers or polling', () => {
    const f = fixture({ mounted: false, paused: true, readyState: 0 });
    const controller = f.start();
    assert.ok(f.doc.getElementById(STYLE)); assert.equal(f.doc.count('playing'), 1);
    assert.equal(f.doc.listeners.get('playing')[0].capture, true);
    f.body.appendChild(f.surface); f.playing();
    assert.deepEqual(f.types(), []); assert.equal(f.doc.count('playing'), 1);
    f.playing({ paused: false, readyState: 4 });
    assert.deepEqual(f.types(), ['mouseout']); assert.equal(f.doc.count('playing'), 0);
    f.playing(); assert.deepEqual(f.types(), ['mouseout']); assertNoMediaActions(f); controller.dispose();
});

for (const state of [{ paused: true }, { ended: true }, { readyState: 0 }, { readyState: 1 }]) {
    test(`paused/ended/not-ready media waits without hiding or resuming: ${JSON.stringify(state)}`, () => {
        const f = fixture(state), controller = f.start();
        assert.deepEqual(f.types(), []); assert.equal(f.doc.count('playing'), 1);
        f.playing(); assert.deepEqual(f.types(), []);
        f.playing({ paused: false, ended: false, readyState: 2 });
        assert.deepEqual(f.types(), ['mouseout']); assert.equal(f.doc.count('playing'), 0);
        assertNoMediaActions(f); controller.dispose();
    });
}

test('a recognizable direct DIV tabindex=-1 and actual VIDEO are required before consuming the initial check', () => {
    const f = fixture({ tabindex: '0' }), controller = f.start();
    f.playing(); assert.deepEqual(f.types(), []); assert.equal(f.doc.count('playing'), 1);
    const audio = new Node('audio'); Object.assign(audio, { paused: false, ended: false, readyState: 4 });
    const foreign = new Node('div'); foreign.setAttribute('tabindex', '-1'); foreign.appendChild(audio); f.body.appendChild(foreign);
    f.playing({}, audio); assert.deepEqual(f.types(), []);
    f.surface.setAttribute('tabindex', '-1'); f.playing();
    assert.deepEqual(f.types(), ['mouseout']); assert.equal(f.doc.count('playing'), 0); controller.dispose();
});

test('unapproved hosts, paths, protocols and top-level documents create neither style nor control listeners', () => {
    for (const options of [{ href: 'https://player.twitch.tv/' }, { href: 'https://player.angelthump.com/not-player' },
        { href: 'http://player.angelthump.com/' }, { href: 'https://player.angelthump.com.evil.example/' }, { embedded: false }]) {
        const f = fixture(options), controller = f.start();
        assert.equal(f.doc.getElementById(STYLE), null);
        assert.equal(f.doc.count('playing'), 0); assert.equal(f.doc.count('keydown'), 0);
        assert.deepEqual(f.types(), []); controller.dispose();
    }
});

test('a real hover skips and completes initial settling, while later keyboard use can still reveal platform controls', () => {
    const f = fixture(); f.surface.hover = true; const controller = f.start();
    assert.deepEqual(f.types(), []); assert.equal(f.doc.count('playing'), 0);
    f.surface.hover = false; f.playing(); assert.deepEqual(f.types(), [], 'a skipped initial check is never retried');
    const key = f.key(f.button, ' ');
    assert.equal(key.defaultPrevented, false); assert.deepEqual(f.types(), ['mousemove']);
    assert.equal(f.surface.dispatched[0].bubbles, true); assertNoMediaActions(f); controller.dispose();
});

test('focused descendant controls skip initial hiding without losing focus or consuming later keyboard input', () => {
    for (const tag of ['button', 'input', 'div']) {
        const f = fixture(), focused = tag === 'button' ? f.button : new Node(tag);
        if (focused !== f.button) f.controls.appendChild(focused);
        f.doc.activeElement = focused; const controller = f.start();
        assert.deepEqual(f.types(), []); assert.equal(f.doc.count('playing'), 0); assert.equal(f.doc.activeElement, focused);
        assert.equal(f.key(focused, 'ArrowRight').defaultPrevented, false);
        assert.deepEqual(f.types(), ['mousemove']); assertNoMediaActions(f); controller.dispose();
    }
});

for (const role of ['menu', 'menuitem']) {
    test(`an open platform ${role} prevents initial dismissal even without hovered/focused controls`, () => {
        const f = fixture(), menu = new Node('div'); menu.setAttribute('role', role); f.controls.appendChild(menu);
        const controller = f.start();
        assert.deepEqual(f.types(), []); assert.equal(f.doc.count('playing'), 0);
        menu.remove(); f.playing(); assert.deepEqual(f.types(), [], 'closing a menu does not restart the one-time check');
        controller.dispose();
    });
}

test('keyboard activity before first playback preserves controls instead of being interrupted by initial hiding', () => {
    const f = fixture({ paused: true }), controller = f.start();
    assert.equal(f.key(f.surface, 'm').defaultPrevented, false); assert.deepEqual(f.types(), ['mousemove']);
    f.playing({ paused: false });
    assert.deepEqual(f.types(), ['mousemove']); assert.equal(f.doc.count('playing'), 0);
    assert.equal(f.key(f.surface, 'Tab').defaultPrevented, false, 'skipped initial hiding never arms first-Tab prevention');
    assertNoMediaActions(f); controller.dispose();
});

test('the first surface/body Tab after initial hiding reveals controls without moving focus, then all following Tabs remain native', () => {
    for (const targetName of ['surface', 'body']) {
        for (const shiftKey of [false, true]) {
            const f = fixture(); f.doc.activeElement = f[targetName]; const controller = f.start();
            const focused = f.doc.activeElement;
            assert.deepEqual(f.types(), ['mouseout']);
            const first = f.key(f[targetName], 'Tab', { shiftKey });
            assert.equal(first.defaultPrevented, true, 'one Tab is reserved for React to reveal its controls');
            assert.deepEqual(f.types(), ['mouseout', 'mousemove']); assert.equal(f.doc.activeElement, focused);
            for (let i = 0; i < 3; i++) {
                assert.equal(f.key(f[targetName], 'Tab', { shiftKey }).defaultPrevented, false, 'Tab is never trapped or repeatedly prevented');
            }
            assert.equal(f.doc.activeElement, focused, 'helper never focuses an element; later native navigation belongs to the browser');
            assertNoMediaActions(f); controller.dispose();
        }
    }
});

test('a non-Tab keyboard reveal never prevents the shortcut and consumes the one-time reveal flag', () => {
    for (const key of ['m', ' ', 'ArrowRight', 'Enter']) {
        const f = fixture(), controller = f.start();
        assert.deepEqual(f.types(), ['mouseout']);
        assert.equal(f.key(f.surface, key).defaultPrevented, false);
        assert.deepEqual(f.types(), ['mouseout', 'mousemove']);
        assert.equal(f.key(f.surface, 'Tab').defaultPrevented, false, 'after another reveal, the next Tab already has native behavior');
        assertNoMediaActions(f); controller.dispose();
    }
});

test('a first Tab already targeting a descendant control is not prevented and does not leave a later Tab trap', () => {
    const f = fixture(), controller = f.start();
    f.doc.activeElement = f.button;
    assert.equal(f.key(f.button, 'Tab').defaultPrevented, false);
    assert.deepEqual(f.types(), ['mouseout', 'mousemove']);
    assert.equal(f.key(f.surface, 'Tab').defaultPrevented, false);
    assert.equal(f.doc.activeElement, f.button); assertNoMediaActions(f); controller.dispose();
});

test('modified, composing and out-of-player key events cannot consume the pending initial keyboard reveal', () => {
    const f = fixture(), controller = f.start(), outside = new Node('button'); f.body.appendChild(outside);
    for (const fields of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
        assert.equal(f.key(f.surface, 'Tab', fields).defaultPrevented, false);
    }
    assert.equal(f.key(outside, 'Tab').defaultPrevented, false);
    assert.equal(f.key(f.html, 'Tab').defaultPrevented, false);
    assert.deepEqual(f.types(), ['mouseout']);
    assert.equal(f.key(f.body, 'Tab').defaultPrevented, true, 'the first eligible reveal still reserves exactly one Tab');
    assert.equal(f.key(f.body, 'Tab').defaultPrevented, false);
    assertNoMediaActions(f); controller.dispose();
});

test('hover, descendant focus or an open menu that skipped initial hiding never arms first-Tab prevention', () => {
    for (const reason of ['hover', 'focus', 'menu']) {
        const f = fixture();
        if (reason === 'hover') f.surface.hover = true;
        else if (reason === 'focus') f.doc.activeElement = f.button;
        else { const menu = new Node('div'); menu.setAttribute('role', 'menu'); f.controls.appendChild(menu); }
        const controller = f.start();
        assert.deepEqual(f.types(), []);
        assert.equal(f.key(f.surface, 'Tab').defaultPrevented, false);
        assert.equal(f.key(f.body, 'Tab').defaultPrevented, false);
        assert.deepEqual(f.types(), ['mousemove', 'mousemove']); assertNoMediaActions(f); controller.dispose();
    }
});

test('body Tab/Shift-Tab can reveal controls; unrelated body/outside keys cannot claim player keyboard activity', () => {
    for (const shiftKey of [false, true]) {
        const f = fixture({ paused: true }), controller = f.start();
        assert.equal(f.key(f.body, 'Tab', { shiftKey }).defaultPrevented, false);
        assert.deepEqual(f.types(), ['mousemove']);
        f.playing({ paused: false }); assert.deepEqual(f.types(), ['mousemove']); controller.dispose();
    }
    const f = fixture({ paused: true }), outside = new Node('button'); f.body.appendChild(outside);
    const controller = f.start(); f.key(f.body, 'm'); f.key(outside, 'Tab'); f.key(outside, ' '); f.key(f.html, 'Tab');
    assert.deepEqual(f.types(), []);
    f.playing({ paused: false }); assert.deepEqual(f.types(), ['mouseout']); controller.dispose();
});

test('modified and composing keys do not synthesize mouse events or inhibit the first genuine playback check', () => {
    const f = fixture({ paused: true }), controller = f.start();
    for (const fields of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
        const event = f.key(f.surface, 'm', fields); assert.equal(event.defaultPrevented, false);
    }
    assert.deepEqual(f.types(), []);
    f.playing({ paused: false }); assert.deepEqual(f.types(), ['mouseout']); assertNoMediaActions(f); controller.dispose();
});

test('dispose before or after settling removes both exact capture listeners and only its own style, ignoring late callbacks', () => {
    for (const paused of [false, true]) {
        const f = fixture({ paused }), unrelated = new Node('style'); unrelated.id = 'unrelated'; f.head.appendChild(unrelated);
        const controller = f.start(), previous = [...f.types()];
        const playing = f.doc.listeners.get('playing')?.[0]?.callback;
        const keydown = f.doc.listeners.get('keydown')[0].callback;
        controller.dispose(); controller.dispose();
        assert.equal(f.doc.count('playing'), 0); assert.equal(f.doc.count('keydown'), 0);
        assert.equal(f.doc.getElementById(STYLE), null); assert.equal(f.doc.getElementById('unrelated'), unrelated);
        f.playing({ paused: false }); f.key(f.surface, ' ');
        playing?.({ target: f.video }); keydown({ target: f.surface, key: ' ' });
        assert.deepEqual(f.types(), previous); assertNoMediaActions(f);
        assert.equal(f.surface.children[0], f.video); assert.equal(f.controls.children[0], f.button);
    }
});

test('duplicate installation creates no additional control listeners and cannot dispose another owner', () => {
    const f = fixture({ paused: true }), owner = f.start(), other = f.start();
    const style = f.doc.getElementById(STYLE);
    assert.equal(f.doc.count('playing'), 1); assert.equal(f.doc.count('keydown'), 1);
    other.dispose(); assert.equal(f.doc.getElementById(STYLE), style); assert.equal(f.doc.count('keydown'), 1);
    f.playing({ paused: false }); assert.deepEqual(f.types(), ['mouseout']); owner.dispose();
    assert.equal(f.doc.count('keydown'), 0);
});

test('actual transport authorizes one initial check per start, including cleanup and fresh authorization after bfcache', () => {
    const f = fixture(), config = { ...baseConfig, CHANNEL: 'umininn-tv-userscript' };
    let seed = 0, mediaDisposed = 0;
    f.win.crypto = { getRandomValues(values) { values.forEach((_, index) => { values[index] = ++seed % 255; }); return values; } };
    f.win.clearTimeout = () => {};
    const client = createFrameClient({ window: f.win, config, angelthump: f.api,
        media: { createMediaController() { return {
            getState: () => ({ ok: true, code: 'OK', message: '', state: { available: true, paused: false, readyState: 4 } }),
            subscribe: () => () => {}, dispose() { mediaDisposed++; }
        }; } } });
    const probe = (origin = SITE, source = f.parent) => f.win.emit('message', { source, origin,
        data: { channel: config.CHANNEL, version: config.VERSION, type: 'frame:probe' } });
    probe('https://evil.example'); probe(SITE, {});
    assert.deepEqual(f.types(), []); assert.equal(f.doc.count('keydown'), 0);
    probe(); probe(); assert.deepEqual(f.types(), ['mouseout']); assert.equal(f.doc.count('keydown'), 1);
    f.win.emit('pagehide', { persisted: true });
    assert.equal(f.doc.count('keydown'), 0); assert.equal(f.doc.getElementById(STYLE), null); assert.equal(mediaDisposed, 1);
    probe(); assert.deepEqual(f.types(), ['mouseout']);
    f.win.emit('pageshow', { persisted: true }); probe(); probe();
    assert.deepEqual(f.types(), ['mouseout', 'mouseout']); assert.equal(f.doc.count('keydown'), 1);
    assertNoMediaActions(f); client.dispose(); assert.equal(f.doc.count('keydown'), 0); assert.equal(mediaDisposed, 2);
});
