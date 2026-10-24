'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.existsSync(path.join(__dirname, '../player-audio-bridge.js')) ?
    '../player-audio-bridge.js' : '../player-audio-bridge.js';
const { create } = require(source);

class EventValue {
    constructor(type, options = {}) { this.type = type; this.bubbles = options.bubbles; this.target = null; }
}
class NodeValue {
    constructor(tagName, parent = null) {
        this.tagName = tagName; this.parentElement = parent; this.listeners = new Map();
        this.attributes = new Map(); this.children = []; this.isConnected = Boolean(parent);
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    dispatchEvent(event) {
        event.target ||= this;
        for (const listener of [...(this.listeners.get(event.type) || [])]) listener(event);
        if (event.bubbles) this.parentElement?.dispatchEvent(event);
        return true;
    }
    appendChild(node) { this.children.push(node); node.parentElement = this; node.isConnected = true; return node; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; this.isConnected = false; }
}
function fixture() {
    const doc = new NodeValue('#document'), win = new NodeValue('window');
    doc.documentElement = new NodeValue('HTML', doc); doc.body = new NodeValue('BODY', doc);
    doc.createElement = name => new NodeValue(name.toUpperCase());
    let pane = doc.body.appendChild(new NodeValue('DIV')), supported = true, focusValid = true, now = 0, sequence = 0;
    doc.getElementById = () => pane;
    win.Event = EventValue; win.queueMicrotask = queueMicrotask;
    const timers = new Map();
    win.setTimeout = (fn, delay) => { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; };
    win.clearTimeout = id => timers.delete(id);
    doc.documentElement.setAttribute('data-umininn-player-audio-intent', 'intent-0');
    doc.documentElement.setAttribute('data-umininn-player-unified-audio-ready', '');
    const events = [];
    for (const type of ['before', 'after', 'abort']) doc.addEventListener('umininn-player-layout-' + type, event => {
        events.push({ type, ticket: event.target.getAttribute('data-umininn-layout-audio-ticket'),
            focus: event.target.getAttribute('data-umininn-layout-audio-focus'),
            bookmark: event.target.getAttribute('data-umininn-layout-bookmark-audio') });
    });
    const bridge = create({ document: doc, window: win, getPane: () => pane, available: () => supported,
        isFocusCurrent: focus => focusValid && focus.target.isConnected && focus.target.parentElement === pane });
    const emit = (target, type) => target.dispatchEvent(new EventValue(type, { bubbles: true }));
    return { bridge, doc, win, events, timers,
        get pane() { return pane; }, setSupported(value) { supported = value; }, setFocusValid(value) { focusValid = value; },
        intent(value) { doc.documentElement.setAttribute('data-umininn-player-audio-intent', value); },
        target() { return pane.appendChild(new NodeValue('VIDEO')); },
        ack(type = 'ready', target = pane, ticket = target.getAttribute('data-umininn-layout-audio-ticket')) {
            target.setAttribute('data-umininn-layout-audio-ack', ticket); emit(target, 'umininn-player-layout-' + type);
        },
        replacePane() { pane.remove(); pane = doc.body.appendChild(new NodeValue('DIV')); },
        hide() { emit(win, 'pagehide'); }, show() { emit(win, 'pageshow'); }, emit,
        async advance(ms) {
            const end = now + ms;
            for (;;) {
                const item = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!item) break;
                timers.delete(item[0]); now = item[1].at; item[1].fn(); await Promise.resolve();
            }
            now = end; await Promise.resolve();
        }
    };
}

test('audio bridge leaves unsupported and idle no-op actions synchronous without any audio handshake', () => {
    const f = fixture(); let called = 0;
    f.setSupported(false);
    assert.equal(f.bridge.run(() => ++called), 1);
    f.setSupported(true);
    assert.equal(f.bridge.run(() => ++called, { requiresLayout: () => false }), 2);
    assert.deepEqual(f.events, []); assert.equal(f.timers.size, 0);
    f.bridge.dispose();
});

test('audio bridge captures once and commits queued actions in order, including nested guarded actions', async () => {
    const f = fixture(), order = [];
    const owner = { label: 'owner' };
    const guarded = f.bridge.guard(function (value) { assert.equal(this, owner); order.push(value); return value; });
    const first = f.bridge.run(() => { order.push('first'); assert.equal(f.bridge.depth, 1); return guarded.call(owner, 'nested'); });
    const second = f.bridge.run(() => { order.push('second'); return 22; });
    assert.equal(f.events.length, 1); assert.equal(f.bridge.queueLength, 2); assert.deepEqual(order, []);
    f.ack(); assert.deepEqual(order, ['first', 'nested', 'second']);
    assert.equal(f.bridge.depth, 0); assert.equal(f.bridge.batch.phase, 'restore');
    f.ack('restored'); assert.deepEqual(await Promise.all([first, second]), ['nested', 22]);
    assert.equal(f.bridge.batch, null); assert.equal(f.timers.size, 0);
});

test('audio bridge does not bypass a queued apparent no-op that becomes meaningful after an earlier move', async () => {
    const f = fixture(); let position = 0;
    const move = f.bridge.run(() => ++position);
    const reset = f.bridge.run(() => { position = 0; return true; }, { requiresLayout: () => position !== 0 });
    assert.equal(position, 0); assert.equal(f.bridge.queueLength, 2);
    f.ack(); f.ack('restored'); await Promise.all([move, reset]);
    assert.equal(position, 0); assert.deepEqual(f.events.map(value => value.type), ['before', 'after']);
});

test('audio bridge retains FIFO order if the userscript capability disappears during capture', async () => {
    const f = fixture(), order = [];
    const first = f.bridge.run(() => { order.push('first'); return 1; });
    f.setSupported(false);
    const second = f.bridge.run(() => { order.push('second'); return 2; });
    assert.deepEqual(order, []); assert.equal(f.bridge.queueLength, 2);
    await f.advance(6500);
    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.deepEqual(order, ['first', 'second']);
    assert.deepEqual(f.events.map(value => value.type), ['before', 'abort']);
    assert.equal(f.bridge.batch, null); assert.equal(f.timers.size, 0);
});

test('audio bridge does not wait for restoration when the capability disappears before ready or inside the commit', async () => {
    for (const duringCommit of [false, true]) {
        const f = fixture();
        const task = f.bridge.run(() => { if (duringCommit) f.setSupported(false); return 3; });
        if (!duringCommit) f.setSupported(false);
        f.ack(); assert.equal(await task, 3);
        assert.deepEqual(f.events.map(value => value.type), ['before', 'abort']);
        assert.equal(f.timers.size, 0);
    }
});

test('audio bridge runs a later queued batch in order without a handshake after capability removal', async () => {
    const f = fixture(), order = [];
    const first = f.bridge.run(() => { order.push('first'); return 1; });
    f.ack();
    const second = f.bridge.run(() => { order.push('second'); return 2; });
    f.setSupported(false); f.ack('restored');
    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.deepEqual(order, ['first', 'second']);
    assert.deepEqual(f.events.map(value => value.type), ['before', 'after']);
    assert.equal(f.bridge.batch, null); assert.equal(f.timers.size, 0);
});

test('audio bridge resolves successful requests and rejects one failed action without dropping later actions', async () => {
    const f = fixture(); const error = new Error('operation failed');
    const bad = f.bridge.run(() => { throw error; });
    const good = f.bridge.run(() => 42);
    const rejection = assert.rejects(bad, value => value === error);
    f.ack(); f.ack('restored'); await rejection;
    assert.equal(await good, 42); assert.equal(f.timers.size, 0);
});

test('audio bridge ignores wrong target, wrong ticket and restored acknowledgements during capture', async () => {
    const f = fixture(); let applied = 0;
    const task = f.bridge.run(() => ++applied), ticket = f.bridge.batch.ticket;
    f.ack('restored'); f.ack('ready', f.target(), ticket); f.ack('ready', f.pane, String(Number(ticket) + 1));
    assert.equal(applied, 0); assert.equal(f.bridge.batch.phase, 'prepare');
    f.ack('ready', f.pane, ticket); f.ack('restored', f.pane, ticket);
    assert.equal(await task, 1);
});

test('audio bridge preparation and restoration timeouts are bounded and do not replay an action', async () => {
    const f = fixture(); let applied = 0;
    const timedCapture = f.bridge.run(() => ++applied);
    await f.advance(6500); assert.equal(await timedCapture, 1);
    assert.deepEqual(f.events.map(value => value.type), ['before', 'abort']);
    f.ack(); assert.equal(applied, 1);
    const timedRestore = f.bridge.run(() => ++applied);
    f.ack(); await f.advance(10000); assert.equal(await timedRestore, 2);
    assert.deepEqual(f.events.map(value => value.type), ['before', 'abort', 'before', 'after', 'abort']);
    assert.equal(f.timers.size, 0);
});

test('audio bridge commits only the latest valid focus intent and never acts on a stale player lease', async () => {
    const f = fixture(), target = f.target(), entry = {};
    const focus = f.bridge.beginFocus('a', entry, target);
    assert.equal(focus.intent, 'intent-0');
    const stale = f.bridge.run(() => true, { focus });
    f.intent('newer-manual-volume'); f.ack();
    assert.equal(f.events.at(-1).focus, null); f.ack('restored'); await stale;
    const replaced = f.bridge.run(() => true, { focus: { ...focus, intent: 'newer-manual-volume' } });
    f.setFocusValid(false); f.ack(); assert.equal(f.events.at(-1).focus, null); f.ack('restored'); await replaced;
    f.setFocusValid(true);
    const current = f.bridge.beginFocus('a', entry, target), task = f.bridge.run(() => true, { focus: current });
    f.ack(); assert.equal(f.events.at(-1).focus, current.id); f.ack('restored'); await task;
    const detached = f.bridge.run(() => true, { focus: current });
    target.remove(); f.ack(); assert.equal(f.events.at(-1).focus, null); f.ack('restored'); await detached;
    assert.equal(f.bridge.beginFocus('a', entry, target), undefined);
});

test('audio bridge chooses the last applied audio policy while stale bookmark intent cannot overwrite a new manual command', async () => {
    const f = fixture(), audio = { version: 1, audible: [] }, target = f.target();
    const bookmark = f.bridge.run(() => ({ applied: 1 }), { bookmarkAudio: audio, audioIntent: f.bridge.bookmarkIntent() });
    const focus = f.bridge.beginFocus('a', {}, target), focusTask = f.bridge.run(() => true, { focus });
    f.ack(); assert.equal(f.events.at(-1).bookmark, null); assert.equal(f.events.at(-1).focus, focus.id);
    f.ack('restored'); await Promise.all([bookmark, focusTask]);
    const stale = f.bridge.run(() => ({ applied: 1 }), { bookmarkAudio: audio, audioIntent: 'intent-0' });
    f.intent('manual'); f.ack(); assert.equal(f.events.at(-1).bookmark, null); f.ack('restored'); await stale;
});

test('audio bridge cancels pending capture on pagehide, ignores late acknowledgements and resumes only on pageshow', async () => {
    const f = fixture(); let applied = 0;
    const first = f.bridge.run(() => ++applied), ticket = f.bridge.batch.ticket;
    const second = f.bridge.run(() => ++applied);
    f.hide(); assert.deepEqual(await Promise.all([first, second]), [false, false]);
    assert.equal(f.bridge.run(() => ++applied), false);
    f.ack('ready', f.pane, ticket); await f.advance(20000);
    assert.equal(applied, 0); assert.equal(f.bridge.batch, null); assert.equal(f.timers.size, 0);
    f.show(); const next = f.bridge.run(() => ++applied); assert.notEqual(f.bridge.batch.ticket, ticket);
    f.ack(); f.ack('restored'); assert.equal(await next, 1);
});

test('audio bridge reentrant pagehide inside an action cancels its result and does not execute the remaining batch', async () => {
    const f = fixture(), order = [];
    const first = f.bridge.run(() => { order.push('first'); f.hide(); return 10; });
    const second = f.bridge.run(() => { order.push('second'); return 20; });
    f.ack(); assert.deepEqual(await Promise.all([first, second]), [false, false]);
    assert.deepEqual(order, ['first']); assert.equal(f.events.some(value => value.type === 'after'), false);
    assert.equal(f.bridge.depth, 0); assert.equal(f.bridge.batch, null); assert.equal(f.timers.size, 0);
});

test('audio bridge detects a new controller or pane installed by an action before later actions or restore attributes', async () => {
    for (const replacePane of [false, true]) {
        const f = fixture(), order = [];
        const first = f.bridge.run(() => {
            order.push('first');
            if (replacePane) f.replacePane();
            f.pane.setAttribute('data-umininn-layout-audio-ticket', '90000002');
            f.pane.setAttribute('data-umininn-layout-audio-focus', 'new-focus');
            return 1;
        });
        const second = f.bridge.run(() => { order.push('second'); return 2; });
        f.ack();
        assert.deepEqual(await Promise.all([first, second]), [false, false]);
        assert.deepEqual(order, ['first']);
        assert.equal(f.pane.getAttribute('data-umininn-layout-audio-ticket'), '90000002');
        assert.equal(f.pane.getAttribute('data-umininn-layout-audio-focus'), 'new-focus');
        assert.equal(f.events.some(value => value.type === 'after'), false);
        assert.equal(f.bridge.batch, null); assert.equal(f.bridge.depth, 0); assert.equal(f.timers.size, 0);
    }
});

test('audio bridge reentrant pagehide during timeout abort cancels before geometry commit', async () => {
    const f = fixture(); let applied = 0;
    f.doc.addEventListener('umininn-player-layout-abort', () => f.hide());
    const task = f.bridge.run(() => ++applied);
    await f.advance(6500); assert.equal(await task, false); assert.equal(applied, 0); assert.equal(f.timers.size, 0);
});

test('audio bridge cancelling restoration also cancels later queued work and cannot be revived by a stale callback', async () => {
    const f = fixture(); let applied = 0;
    const first = f.bridge.run(() => ++applied); f.ack();
    const ticket = f.bridge.batch.ticket, second = f.bridge.run(() => ++applied);
    f.hide(); assert.deepEqual(await Promise.all([first, second]), [false, false]);
    f.show(); f.ack('restored', f.pane, ticket); await Promise.resolve();
    assert.equal(applied, 1); assert.equal(f.bridge.batch, null); assert.equal(f.bridge.queueLength, 0);
});

test('audio bridge never commits an old pane transaction into a replacement pane', async () => {
    const f = fixture(); let applied = 0;
    const oldPane = f.pane, task = f.bridge.run(() => ++applied), ticket = f.bridge.batch.ticket;
    f.replacePane(); f.ack('ready', oldPane, ticket); await f.advance(6500);
    assert.equal(await task, false); assert.equal(applied, 0); assert.equal(f.timers.size, 0);
});

test('audio bridge stale acknowledgements cannot overwrite or abort another controller ticket on the same pane', async () => {
    const f = fixture(); let applied = 0;
    const task = f.bridge.run(() => ++applied), oldTicket = f.bridge.batch.ticket;
    f.pane.setAttribute('data-umininn-layout-audio-ticket', '90000000');
    f.ack('ready', f.pane, oldTicket); await f.advance(6500);
    assert.equal(await task, false); assert.equal(applied, 0);
    assert.equal(f.pane.getAttribute('data-umininn-layout-audio-ticket'), '90000000');
    assert.deepEqual(f.events.map(value => value.type), ['before']);
});

test('audio bridge restoration timeout cannot abort a newer controller ticket or run its old queued work', async () => {
    const f = fixture(); let applied = 0;
    const first = f.bridge.run(() => ++applied); f.ack();
    const second = f.bridge.run(() => ++applied);
    f.pane.setAttribute('data-umininn-layout-audio-ticket', '90000001');
    f.pane.setAttribute('data-umininn-layout-audio-focus', 'new-controller-focus');
    await f.advance(10000);
    assert.deepEqual(await Promise.all([first, second]), [false, false]);
    assert.equal(applied, 1);
    assert.equal(f.pane.getAttribute('data-umininn-layout-audio-ticket'), '90000001');
    assert.equal(f.pane.getAttribute('data-umininn-layout-audio-focus'), 'new-controller-focus');
    assert.deepEqual(f.events.map(value => value.type), ['before', 'after']);
    assert.equal(f.bridge.batch, null); assert.equal(f.bridge.queueLength, 0); assert.equal(f.timers.size, 0);
});

test('audio bridge captures bookmark audio once and removes its request after completion, timeout or lifecycle cancellation', async () => {
    const f = fixture(); const audio = { version: 1, audible: [{ key: 'a', volume: 0.4 }] };
    const captured = f.bridge.captureBookmark(['a']);
    let node = f.doc.body.children.find(value => value.tagName === 'SPAN');
    assert.equal(node.getAttribute('data-umininn-bookmark-audio-keys'), '["a"]');
    node.setAttribute('data-umininn-bookmark-audio-result', JSON.stringify(audio));
    f.emit(node, 'umininn-player-bookmark-audio-result'); assert.deepEqual(await captured, audio);
    assert.equal(node.isConnected, false); assert.equal(f.timers.size, 0);
    const timed = assert.rejects(f.bridge.captureBookmark(['a']), /逾時/); await f.advance(5500); await timed;
    const cancelled = assert.rejects(f.bridge.captureBookmark(['a']), /頁面已離開/); f.hide(); await cancelled;
    assert.equal(f.doc.body.children.some(value => value.tagName === 'SPAN'), false); assert.equal(f.timers.size, 0);
});

test('audio bridge disposal removes listeners and disallows every late action, focus or capture', async () => {
    const f = fixture(), target = f.target(); let applied = 0;
    const task = f.bridge.run(() => ++applied); f.bridge.dispose();
    assert.equal(await task, false); assert.equal(f.bridge.run(() => ++applied), false);
    assert.equal(f.bridge.beginFocus('a', {}, target), undefined); assert.equal(f.bridge.bookmarkIntent(), undefined);
    await assert.rejects(f.bridge.captureBookmark(['a']), /頁面已離開/);
    f.show(); f.ack(); assert.equal(applied, 0); assert.equal(f.timers.size, 0);
    assert.equal(f.doc.listeners.get('umininn-player-layout-ready').size, 0);
    assert.equal(f.win.listeners.get('pagehide').size, 0);
});
