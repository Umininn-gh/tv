'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomFillSync } = require('node:crypto');
const { observe, startFrameNotifier } = require('../menu-dismiss.js');

class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(handler); }
    removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
    emit(type, fields = {}) {
        const event = { type, isTrusted: true, target: this, ...fields };
        for (const handler of [...(this.listeners.get(type) || [])]) handler(event);
        return event;
    }
    count() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
}
class Element extends Target {
    constructor(tag, ownerDocument, id = '') { super(); Object.assign(this, { tagName: tag.toUpperCase(), ownerDocument, id, nodeType: 1, children: [], parentNode: null, attrs: {} }); }
    append(child) { child.parentNode?.remove(child); this.children.push(child); child.parentNode = this; child.ownerDocument = this.ownerDocument; return child; }
    remove(child) { this.children = this.children.filter(value => value !== child); child.parentNode = null; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    get isConnected() { return Boolean(this.parentNode && (this.parentNode.nodeType === 9 || this.parentNode.isConnected)); }
    querySelectorAll(selector) {
        const result = [];
        for (const child of this.children) {
            if (selector === '*' || selector === 'iframe' && child.tagName === 'IFRAME') result.push(child);
            result.push(...child.querySelectorAll(selector));
        }
        return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    matches(selector) { return selector.split(',').includes(this.tagName.toLowerCase()); }
}
function windowFixture(href = 'https://umininn-gh.github.io/tv/') {
    const win = new Target(), timers = new Map(), observers = [], sent = [];
    let timerId = 0;
    Object.assign(win, { URL, location: new URL(href), crypto: { getRandomValues: randomFillSync }, sent, parent: null });
    win.parent = win;
    win.setTimeout = (handler, delay) => { const id = ++timerId; timers.set(id, { handler, delay }); return id; };
    win.clearTimeout = id => timers.delete(id);
    win.postMessage = (data, origin) => sent.push({ data, origin });
    win.MutationObserver = class {
        constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
        observe(target) { this.targets.push(target); }
        disconnect() { this.targets = []; }
    };
    const doc = new Target();
    Object.assign(doc, { nodeType: 9, hidden: false, focused: true, hasFocus() { return this.focused; } });
    doc.documentElement = new Element('html', doc);
    doc.documentElement.parentNode = doc;
    doc.body = doc.documentElement.append(new Element('body', doc));
    doc.activeElement = doc.body;
    doc.querySelectorAll = selector => doc.documentElement.querySelectorAll(selector);
    doc.getElementById = id => doc.querySelectorAll('*').find(node => node.id === id) || null;
    win.document = doc;
    function append(tag, id, parent = doc.body) { return parent.append(new Element(tag, doc, id)); }
    function tick(delay) {
        for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.handler(); }
    }
    function mutate(document, mutation) {
        for (const observer of observers) if (observer.targets.includes(document)) observer.callback([mutation]);
    }
    function frame(child, id, parent = doc.body) {
        const element = append('iframe', id, parent);
        element.contentWindow = child.window;
        element.setAttribute('src', child.window.location.href);
        child.window.parent = win;
        return element;
    }
    return { window: win, doc, timers, observers, sent, append, tick, mutate, frame };
}
function gesture(win, target, fields = {}) { win.emit('pointerdown', { target, composedPath: () => [target], ...fields }); }
function officialFixture() {
    const f = windowFixture(), child = windowFixture('https://www.twitch.tv/embed/test_channel/chat?darkpopout');
    const chat = f.frame(child, 'chat_embed');
    Object.defineProperty(child.window, 'document', { get() { throw new Error('Cross-origin document'); } });
    const panel = f.append('div', 'panel'), trigger = f.append('button', 'trigger');
    f.doc.activeElement = trigger;
    const watch = () => child.sent.filter(value => value.data.type === 'watch').at(-1).data;
    const deliver = (data, fields = {}) => f.window.emit('message', { data, source: child.window, origin: child.window.location.origin, ...fields });
    return { ...f, child, chat, panel, trigger, watch, deliver };
}

test('inside composed paths retain menu controls while outside gestures keep their original action', () => {
    const f = windowFixture(), host = f.append('div', 'shadow-host'), panel = f.append('div', 'panel'), trigger = f.append('button', 'trigger');
    const slider = f.append('input', 'slider', panel), other = f.append('button', 'other');
    let closed = 0, actions = 0;
    const subscription = observe({ window: f.window, inside: [panel, trigger], onOutside() { closed++; } });
    gesture(f.window, host, { composedPath: () => [slider, panel, host] });
    gesture(f.window, trigger);
    gesture(f.window, other, { isTrusted: false });
    f.window.emit('scroll', { target: other });
    assert.equal(closed, 0);
    assert.equal(f.window.listeners.has('scroll'), false, 'automatic scroll is never treated as input');
    other.addEventListener('click', () => actions++);
    gesture(f.window, other);
    other.emit('click');
    assert.equal(closed, 1); assert.equal(actions, 1);
    assert.equal(f.timers.size, 0, 'outside input stops the focus fallback immediately');
    assert.equal(f.window.count(), 0); assert.equal(f.doc.count(), 0);
    subscription.dispose();
});

test('same-origin nested scrollbar gestures dismiss without moving iframe focus; owned iframes stay inside', () => {
    const f = windowFixture(), child = windowFixture(), nested = windowFixture(), owned = windowFixture();
    const panel = f.append('div', 'panel'), trigger = f.append('button', 'trigger');
    f.doc.activeElement = trigger;
    f.frame(child, 'chat_embed'); child.frame(nested, 'preview'); f.frame(owned, 'owned', panel);
    let closed = 0;
    observe({ window: f.window, inside: [panel, trigger], onOutside() { closed++; } });
    gesture(owned.window, owned.doc.body); assert.equal(closed, 0);
    gesture(nested.window, nested.doc.body, { isTrusted: false }); assert.equal(closed, 0);
    gesture(nested.window, nested.doc.body);
    assert.equal(closed, 1); assert.equal(f.doc.activeElement, trigger, 'no focus calls are needed for a native scrollbar');
    assert.equal(child.window.count(), 0); assert.equal(nested.window.count(), 0);
    assert.ok(f.observers.every(value => value.targets.length === 0));
});

test('new and navigated iframe documents rebind; stale or disconnected documents cannot dismiss', () => {
    const f = windowFixture(), child = windowFixture(), next = windowFixture();
    const panel = f.append('div', 'panel'), trigger = f.append('button', 'trigger');
    let closed = 0;
    const subscription = observe({ window: f.window, inside: [panel, trigger], onOutside() { closed++; } });
    const chat = f.frame(child, 'chat_embed');
    f.mutate(f.doc, { type: 'childList', addedNodes: [chat], removedNodes: [] }); f.tick(0);
    assert.ok(child.window.count() > 0);
    child.window.document = next.doc;
    gesture(child.window, child.doc.body); assert.equal(closed, 0, 'a previous document cannot act during the navigation gap');
    f.doc.emit('load', { target: chat }); f.tick(0);
    chat.parentNode.remove(chat);
    gesture(child.window, next.doc.body); assert.equal(closed, 0, 'a removed frame cannot send a late gesture');
    f.mutate(f.doc, { type: 'childList', addedNodes: [], removedNodes: [chat] }); f.tick(0);
    assert.equal(child.window.count(), 0);
    const message = f.append('div', 'ordinary-chat-message');
    f.mutate(f.doc, { type: 'childList', addedNodes: [message], removedNodes: [] });
    assert.equal([...f.timers.values()].filter(value => value.delay === 0).length, 0, 'new chat text does not schedule a frame scan');
    subscription.dispose();
});

test('focus fallback ignores app switches, catches outside native media, and stops after pagehide', () => {
    const f = windowFixture(), panel = f.append('div', 'panel'), video = f.append('video', 'native');
    let closed = 0;
    observe({ window: f.window, inside: [panel], onOutside() { closed++; } });
    f.doc.activeElement = video; f.doc.focused = false; f.tick(200); assert.equal(closed, 0);
    f.doc.focused = true; f.tick(200); assert.equal(closed, 1); assert.equal(f.timers.size, 0);
    observe({ window: f.window, inside: [panel], onOutside() { closed++; } });
    f.window.emit('pagehide'); f.tick(200); assert.equal(closed, 1); assert.equal(f.window.count(), 0);
});

test('shadow descendants belong to their host owner for native media focus and gestures', () => {
    const f = windowFixture(), host = f.append('div', 'panel-host');
    const shadow = new Element('shadow-root', f.doc); shadow.nodeType = 11; shadow.host = host; host.shadowRoot = shadow;
    const video = shadow.append(new Element('video', f.doc)); shadow.activeElement = video;
    f.doc.activeElement = host;
    let closed = 0;
    const subscription = observe({ window: f.window, inside: [host], onOutside() { closed++; } });
    gesture(f.window, video); f.tick(200); assert.equal(closed, 0, 'host ownership crosses a shadow root without treating all sibling controls as inside');
    subscription.dispose();
});

test('same-origin to foreign navigation cannot abort cleanup and returning documents rebind', () => {
    const f = windowFixture(), child = windowFixture(), returned = windowFixture();
    const chat = f.frame(child, 'chat_embed'), panel = f.append('div', 'panel');
    let foreign = false, currentDocument = child.doc, closed = 0;
    const originalRemove = child.window.removeEventListener;
    Object.defineProperty(child.window, 'document', { get() { if (foreign) throw new Error('SecurityError'); return currentDocument; } });
    Object.defineProperty(child.window, 'removeEventListener', { get() {
        if (foreign) throw new Error('SecurityError');
        return function (...args) { if (foreign) throw new Error('SecurityError'); return originalRemove.apply(this, args); };
    } });
    observe({ window: f.window, inside: [panel], onOutside() { closed++; } });
    const oldObserver = f.observers.find(observer => observer.targets.includes(child.doc)); assert.ok(oldObserver);
    foreign = true;
    f.doc.emit('load', { target: chat }); assert.doesNotThrow(() => f.tick(0));
    assert.deepEqual(oldObserver.targets, [], 'foreign WindowProxy cleanup still disconnects the old document observer');
    foreign = false; currentDocument = returned.doc;
    f.doc.emit('load', { target: chat }); f.tick(0);
    gesture(child.window, currentDocument.body); assert.equal(closed, 1);
    assert.equal(f.timers.size, 0);
});

test('foreign chat notifications require current identity, origin, source and token; reopening invalidates old watches', () => {
    const f = officialFixture(); let closed = 0;
    const open = () => observe({ window: f.window, inside: [f.panel, f.trigger], onOutside() { closed++; } });
    const first = open(), old = f.watch();
    const interaction = watch => ({ ...watch, type: 'interaction' });
    f.deliver(interaction(old), { source: {} }); f.deliver(interaction(old), { origin: 'https://evil.example' });
    f.deliver({ ...interaction(old), token: '0'.repeat(32) });
    f.deliver({ ...interaction(old), href: old.href + '&wrong=1' }); assert.equal(closed, 0);
    first.dispose(); const second = open(), current = f.watch();
    assert.notEqual(current.id, old.id); assert.notEqual(current.token, old.token);
    f.deliver(interaction(old)); assert.equal(closed, 0);
    f.deliver(interaction(current)); assert.equal(closed, 1);
    assert.equal(f.child.sent.at(-1).data.type, 'unwatch'); second.dispose();
    open(); const beforeNavigation = f.watch();
    f.chat.setAttribute('src', 'https://www.twitch.tv/embed/next_channel/chat');
    f.deliver(interaction(beforeNavigation)); assert.equal(closed, 1, 'src changes invalidate the previous document before its load');
    f.doc.emit('load', { target: f.chat }); f.tick(0);
    assert.notEqual(f.watch().id, beforeNavigation.id);
    f.window.emit('pagehide'); assert.equal(f.window.count(), 0);
});

test('foreign ready handshake supports late injection and independent simultaneous menu observers', () => {
    const f = officialFixture(); let first = 0, second = 0;
    observe({ window: f.window, inside: [f.panel], onOutside() { first++; } });
    const one = f.watch();
    const other = observe({ window: f.window, inside: [f.trigger], onOutside() { second++; } });
    const two = f.watch(); assert.notEqual(one.id, two.id);
    const count = f.child.sent.length;
    f.deliver({ channel: 'umininn-menu-interaction', version: 1, type: 'ready', href: two.href });
    assert.equal(f.child.sent.length, count + 2, 'each still-open observer renews its subscription after injection');
    f.deliver({ ...one, type: 'interaction' }); assert.equal(first, 1); assert.equal(second, 0);
    f.deliver({ ...two, type: 'interaction' }); assert.equal(second, 1); other.dispose();
});

test('frame notifier emits no content and only accepts an exact parent watch while active', () => {
    const parent = windowFixture(), f = windowFixture('https://www.twitch.tv/embed/test_channel/chat?darkpopout');
    f.window.parent = parent.window;
    const origin = parent.window.location.origin;
    const notifier = startFrameNotifier({ window: f.window, parentOrigin: origin });
    assert.equal(parent.sent.at(-1).data.type, 'ready'); parent.sent.length = 0;
    const watch = { channel: 'umininn-menu-interaction', version: 1, type: 'watch', id: 'a'.repeat(32), token: 'b'.repeat(32), href: f.window.location.href };
    const deliver = (data, fields = {}) => f.window.emit('message', { data, source: parent.window, origin, ...fields });
    gesture(f.window, f.doc.body); assert.equal(parent.sent.length, 0);
    deliver(watch, { source: {} }); deliver(watch, { origin: 'https://evil.example' });
    deliver({ ...watch, href: watch.href + '&wrong' }); deliver({ ...watch, id: {} });
    gesture(f.window, f.doc.body); assert.equal(parent.sent.length, 0);
    deliver(watch); gesture(f.window, f.doc.body, { isTrusted: false }); f.window.emit('scroll'); assert.equal(parent.sent.length, 0);
    f.window.emit('keydown', { target: f.doc.body, key: 'secret draft', clientX: 10 });
    assert.deepEqual(parent.sent[0], { origin, data: { ...watch, type: 'interaction' } }, 'only subscription identity is sent, never keys, text or coordinates');
    deliver({ ...watch, type: 'unwatch', token: 'c'.repeat(32) }); gesture(f.window, f.doc.body); assert.equal(parent.sent.length, 2);
    deliver({ ...watch, type: 'unwatch' }); gesture(f.window, f.doc.body); assert.equal(parent.sent.length, 2);
    notifier.dispose(); assert.equal(f.window.count(), 0);
});

test('notifier never attaches on unrelated Twitch pages, direct chats or an invalid parent origin', () => {
    for (const href of ['https://www.twitch.tv/test_channel', 'https://www.twitch.tv/popout/test_channel/chat', 'https://www.twitch.tv/embed/name/chat/extra', 'https://www.twitch.tv.evil.example/embed/name/chat']) {
        const f = windowFixture(href); f.window.parent = windowFixture().window;
        startFrameNotifier({ window: f.window, parentOrigin: 'https://umininn-gh.github.io' }); assert.equal(f.window.count(), 0);
    }
    const f = windowFixture('https://www.twitch.tv/embed/name/chat');
    startFrameNotifier({ window: f.window, parentOrigin: 'https://umininn-gh.github.io' }); assert.equal(f.window.count(), 0);
    f.window.parent = windowFixture().window;
    startFrameNotifier({ window: f.window, parentOrigin: 'https://umininn-gh.github.io/path' }); assert.equal(f.window.count(), 0);
});

test('restoring a cached chat requires a fresh parent watch and never revives the previous subscription', () => {
    const parent = windowFixture(), f = windowFixture('https://www.twitch.tv/embed/name/chat');
    f.window.parent = parent.window;
    const origin = parent.window.location.origin;
    startFrameNotifier({ window: f.window, parentOrigin: origin });
    const watch = { channel: 'umininn-menu-interaction', version: 1, type: 'watch', id: 'd'.repeat(32), token: 'e'.repeat(32), href: f.window.location.href };
    const deliver = data => f.window.emit('message', { data, source: parent.window, origin });
    deliver(watch); f.window.emit('pagehide', { persisted: true }); parent.sent.length = 0;
    gesture(f.window, f.doc.body); assert.equal(parent.sent.length, 0);
    f.window.emit('pageshow', { persisted: true }); assert.equal(parent.sent.at(-1).data.type, 'ready');
    gesture(f.window, f.doc.body); assert.equal(parent.sent.length, 1, 'restoration alone does not reinstate an old open-menu identity');
    deliver({ ...watch, id: 'f'.repeat(32), token: 'a'.repeat(32) });
    gesture(f.window, f.doc.body); assert.equal(parent.sent.at(-1).data.id, 'f'.repeat(32));
    f.window.emit('pagehide', { persisted: false }); assert.equal(f.window.count(), 0);
});
