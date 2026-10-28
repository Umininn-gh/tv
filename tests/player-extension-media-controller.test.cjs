const assert = require('node:assert/strict');
const test = require('node:test');
const { createMediaController } = require('../browser-extension/shared/media-controller.js');
const config = require('../browser-extension/shared/config.js');

class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    emit(type, fields = {}) { for (const fn of [...(this.listeners.get(type) || [])]) fn({ type, currentTarget: this, ...fields }); }
    count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}
function fixture() {
    const clock = { now: 0, next: 0, timers: new Map(),
        setTimeout(fn, delay) { const id = ++this.next; this.timers.set(id, { fn, at: this.now + delay }); return id; },
        clearTimeout(id) { this.timers.delete(id); } };
    function tick(ms) {
        const end = clock.now + ms;
        for (;;) {
            const next = [...clock.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            clock.now = next[1].at; clock.timers.delete(next[0]); next[1].fn();
        }
        clock.now = end;
    }
    class Node extends Events {
        constructor(tag = 'div') { super(); this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.style = {}; this.attributes = new Map(); this.hidden = false; this.rect = { left: 0, top: 0, width: 640, height: 360 }; }
        get parentElement() { return this.parentNode?.tagName ? this.parentNode : null; }
        get isConnected() { return this === doc || Boolean(this.parentNode?.isConnected) || Boolean(this.host?.isConnected); }
        getRootNode() { return this.parentNode ? this.parentNode.getRootNode() : this; }
        append(node) { node.parentNode = this; this.children.push(node); return node; }
        remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
        removeAttribute(name) { this.attributes.delete(name); }
        querySelectorAll(selector) {
            const all = this.children.flatMap(node => [node, ...node.querySelectorAll('*')]);
            return selector === '*' ? all : all.filter(node => ['VIDEO', 'AUDIO'].includes(node.tagName));
        }
        getBoundingClientRect() { return this.rect; }
    }
    class Media extends Node {
        constructor(tag = 'video') { super(tag); this._volume = 0.8; this._muted = false; this.paused = true; this.ended = false; this.readyState = 4; this.error = null; this.playCalls = 0; this.pauseCalls = 0; this.loadCalls = 0; }
        get volume() { return this._volume; }
        set volume(value) { this._volume = value; this.emit('volumechange'); }
        get muted() { return this._muted; }
        set muted(value) { this._muted = value; this.emit('volumechange'); }
        get src() { throw new Error('Source URL must not be read'); }
        set src(_) { throw new Error('Source URL must not be changed'); }
        play() { this.playCalls++; if (this.playImpl) return this.playImpl(); this.paused = false; this.emit('playing'); return Promise.resolve(); }
        pause() { this.pauseCalls++; this.paused = true; this.emit('pause'); }
        load() { this.loadCalls++; throw new Error('Must never reload'); }
    }
    const doc = new Node(); doc.tagName = undefined; doc.URL = 'https://player.example.test/offline'; doc.readyState = 'complete';
    doc.documentElement = doc.append(new Node('html'));
    const mutations = [], sizes = [];
    const view = new Events();
    Object.assign(view, { innerWidth: 1280, innerHeight: 720,
        getComputedStyle: node => ({ display: 'block', visibility: 'visible', opacity: '1', ...node.style }),
        MutationObserver: class { constructor(callback) { this.callback = callback; this.targets = new Set(); this.options = new Map(); this.records = []; mutations.push(this); } observe(node, options) { this.targets.add(node); this.options.set(node, options); } takeRecords() { return this.records.splice(0); } disconnect() { this.targets.clear(); this.options.clear(); this.records.length = 0; } },
        ResizeObserver: class { constructor(callback) { this.callback = callback; this.targets = new Set(); sizes.push(this); } observe(node) { this.targets.add(node); } unobserve(node) { this.targets.delete(node); } disconnect() { this.targets.clear(); } } });
    doc.defaultView = view;
    const childDocument = (frame, url = 'about:blank') => {
        const child = new Node(); child.tagName = undefined; child.host = frame; child.URL = url; child.readyState = 'complete';
        child.documentElement = child.append(new Node('html'));
        child.documentElement.append(new Node('head')); child.body = child.documentElement.append(new Node('body'));
        child.defaultView = Object.assign(new Events(), { frameElement: frame });
        return child;
    };
    const addFrame = (parent = doc.documentElement, url = 'about:blank') => {
        const frame = parent.append(new Node('iframe')); frame.setAttribute('src', url);
        frame.contentDocument = childDocument(frame, url); return frame;
    };
    const add = (tag = 'video', parent = doc.documentElement) => parent.append(new Media(tag));
    const mount = (scope = doc) => createMediaController({ document: doc, scope, clock });
    return { doc, view, Node, Media, add, addFrame, childDocument, mount, clock, tick, mutations, sizes,
        mutate: () => mutations.forEach(observer => observer.callback([])) };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('an observed empty guarded player reports silence proof without inventing mute or volume values', async () => {
    const f = fixture(), controller = f.mount();
    assert.equal(controller.getState().state.emptyGuardConfirmed, false);
    const result = await controller.execute({ action: 'setMuted', value: true, guard: true });
    assert.equal(result.code, 'NO_MEDIA'); assert.equal(result.ok, false);
    assert.equal(result.state.available, false); assert.equal(result.state.muteGuardActive, true);
    assert.equal(result.state.emptyGuardConfirmed, true);
    assert.equal(result.state.muted, null); assert.equal(result.state.volume, null);
    assert.equal(result.state.muteSupported, false); assert.equal(f.clock.timers.size, 0);
    controller.dispose(); assert.equal(controller.getState().state.emptyGuardConfirmed, false);
});

test('empty proof requires working observers and rejects embedded documents and hidden media', async () => {
    for (const tag of ['iframe', 'object', 'embed']) {
        const f = fixture(), embedded = f.doc.documentElement.append(new f.Node(tag)), controller = f.mount();
        assert.equal((await controller.execute({ action: 'setMuted', value: true, guard: true })).state.emptyGuardConfirmed, false, tag);
        embedded.remove(); assert.equal(controller.getState().state.emptyGuardConfirmed, true);
        controller.dispose();
    }
    const hidden = fixture(), video = hidden.add(); video.hidden = true;
    const controller = hidden.mount(), result = await controller.execute({ action: 'setMuted', value: true, guard: true });
    assert.equal(result.state.emptyGuardConfirmed, false); assert.equal(result.state.muted, true);
    assert.equal(video.muted, true); controller.dispose();
    const missing = fixture(); missing.view.MutationObserver = undefined;
    const noObserver = missing.mount(); assert.equal((await noObserver.execute({ action: 'setMuted', value: true, guard: true })).state.emptyGuardConfirmed, false); noObserver.dispose();
    const refused = fixture(); refused.view.MutationObserver = class { observe() { throw new Error('unavailable'); } disconnect() {} };
    const broken = refused.mount(); assert.equal((await broken.execute({ action: 'setMuted', value: true, guard: true })).state.emptyGuardConfirmed, false); broken.dispose();
});

test('a hidden same-origin about:blank child is fully observed and permits honest empty proof', async () => {
    const f = fixture(), frame = f.addFrame(); frame.style.visibility = 'hidden';
    const child = frame.contentDocument, controller = f.mount();
    const result = await controller.execute({ action: 'setMuted', value: true, guard: true });
    assert.equal(result.code, 'NO_MEDIA'); assert.equal(result.state.emptyGuardConfirmed, true);
    assert.equal(result.state.available, false); assert.equal(result.state.muted, null); assert.equal(result.state.volume, null);
    assert.equal(result.state.muteGuardActive, true); assert.equal(result.state.muteSupported, false);
    assert.equal(f.mutations[0].targets.has(child), true);
    for (const attribute of ['src', 'srcdoc', 'sandbox']) assert.ok(f.mutations[0].options.get(f.doc).attributeFilter.includes(attribute));
    controller.dispose(); assert.equal(frame.count(), 0); assert.equal(child.count(), 0); assert.equal(child.defaultView.count(), 0);
});

test('late child media and its open shadow audio are guarded without becoming the primary player', async () => {
    const f = fixture(), frame = f.addFrame(), child = frame.contentDocument, reports = [], controller = f.mount();
    controller.subscribe(result => reports.push(result));
    await controller.execute({ action: 'setMuted', value: true, guard: true });
    const video = f.add('video', child.body), host = child.body.append(new f.Node('open-player'));
    host.shadowRoot = new f.Node(); host.shadowRoot.tagName = undefined; host.shadowRoot.host = host;
    const audio = f.add('audio', host.shadowRoot); audio.hidden = true;
    f.mutations[0].callback([{ type: 'childList', addedNodes: [video, host], removedNodes: [] }]);
    assert.equal(reports.at(-1).state.emptyGuardConfirmed, false);
    assert.equal(reports.at(-1).state.muteGuardActive, true, 'navigation and new routes retain the requested guard');
    f.tick(80); const result = controller.getState();
    assert.equal(result.code, 'NO_MEDIA'); assert.equal(result.state.available, false); assert.equal(result.state.mediaId, null);
    assert.equal(result.state.muted, true); assert.equal(result.state.volume, null); assert.equal(result.state.muteSupported, true);
    assert.equal(result.state.emptyGuardConfirmed, false); assert.ok(f.mutations[0].targets.has(host.shadowRoot));
    for (const node of [video, audio]) {
        assert.equal(node.muted, true); assert.equal(node.volume, .8);
        assert.deepEqual([node.playCalls, node.pauseCalls, node.loadCalls], [0, 0, 0]);
    }
    assert.equal((await controller.execute({ action: 'recover' })).code, 'NO_MEDIA');
    controller.dispose(); assert.equal(video.count(), 0); assert.equal(audio.count(), 0);
});

test('nested unknown frames cannot hide behind confirmed muted child media', async () => {
    for (const unknown of ['cross-origin', 'custom', 'failed-read']) {
        const f = fixture(), frame = f.addFrame(), child = frame.contentDocument;
        const audio = f.add('audio', child.body); audio.hidden = true;
        if (unknown === 'custom') child.body.append(new f.Node('closed-player'));
        else {
            const nested = child.body.append(new f.Node('iframe'));
            if (unknown === 'failed-read') Object.defineProperty(nested, 'contentDocument', { get() { throw new Error('denied'); } });
            else nested.contentDocument = null;
        }
        const controller = f.mount(), result = await controller.execute({ action: 'setMuted', value: true, guard: true });
        assert.equal(audio.muted, true); assert.equal(result.code, 'NOT_APPLIED', unknown);
        assert.equal(result.state.emptyGuardConfirmed, false); assert.equal(result.state.muted, null);
        assert.equal(result.state.muteSupported, false); assert.equal(result.state.muteGuardActive, true);
        controller.dispose();
    }
});

test('a frame load revokes proof, replaces observed documents and removes stale document listeners', async () => {
    const f = fixture(), frame = f.addFrame(), old = frame.contentDocument, reports = [], controller = f.mount();
    controller.subscribe(result => reports.push(result));
    await controller.execute({ action: 'setMuted', value: true, guard: true });
    const child = f.childDocument(frame, 'https://player.example.test/settled'); frame.setAttribute('src', child.URL); frame.contentDocument = child;
    frame.emit('load'); assert.equal(reports.at(-1).state.emptyGuardConfirmed, false);
    assert.equal(reports.at(-1).state.muteGuardActive, true);
    f.tick(80); assert.equal(controller.getState().state.emptyGuardConfirmed, true);
    assert.equal(f.mutations[0].targets.has(old), false); assert.equal(f.mutations[0].targets.has(child), true);
    assert.equal(old.count(), 0); assert.equal(old.defaultView.count(), 0);
    old.emit('pointerdown', { isTrusted: true }); assert.equal(controller.getState().state.audioUserRevision, 0);
    controller.dispose(); assert.equal(child.count(), 0); assert.equal(child.defaultView.count(), 0); assert.equal(frame.count(), 0);
    frame.emit('load'); assert.equal(f.clock.timers.size, 0);
});

test('iframe navigation attributes immediately withdraw proof until a settled load', async () => {
    for (const attribute of ['src', 'srcdoc', 'sandbox']) {
        const f = fixture(), frame = f.addFrame(), reports = [], controller = f.mount();
        controller.subscribe(result => reports.push(result));
        await controller.execute({ action: 'setMuted', value: true, guard: true });
        frame.setAttribute(attribute, attribute === 'src' ? 'https://player.example.test/new' : '');
        f.mutations[0].callback([{ type: 'attributes', attributeName: attribute, target: frame }]);
        assert.equal(reports.at(-1).state.emptyGuardConfirmed, false, attribute);
        f.tick(80); assert.equal(controller.getState().state.emptyGuardConfirmed, false);
        frame.contentDocument = f.childDocument(frame, attribute === 'src' ? 'https://player.example.test/new' : attribute === 'srcdoc' ? 'about:srcdoc' : 'about:blank');
        frame.emit('load'); f.tick(80); assert.equal(controller.getState().state.emptyGuardConfirmed, true, attribute);
        controller.dispose(); assert.equal(f.clock.timers.size, 0);
    }
});

test('a readable initial blank document for a pending URL or srcdoc never authorizes opening', async () => {
    for (const source of ['https://foreign.example.test/player', '/same-origin-pending', 'srcdoc']) {
        const f = fixture(), frame = f.addFrame();
        if (source === 'srcdoc') frame.setAttribute('srcdoc', '<p>not loaded yet</p>'); else frame.setAttribute('src', source);
        const controller = f.mount(), result = await controller.execute({ action: 'setMuted', value: true, guard: true });
        assert.equal(result.code, 'NOT_APPLIED'); assert.equal(result.state.emptyGuardConfirmed, false);
        assert.equal(f.mutations[0].targets.has(frame.contentDocument), false);
        controller.dispose();
    }
});

test('a child navigating through pagehide to an unreadable destination withdraws proof and can recover after a readable load', async () => {
    const f = fixture(), frame = f.addFrame(), old = frame.contentDocument, reports = [], controller = f.mount();
    controller.subscribe(result => reports.push(result));
    await controller.execute({ action: 'setMuted', value: true, guard: true });
    old.defaultView.emit('pagehide'); assert.equal(reports.at(-1).state.emptyGuardConfirmed, false);
    f.tick(80); assert.equal(controller.getState().state.emptyGuardConfirmed, false);
    frame.contentDocument = null; frame.emit('load'); f.tick(80);
    const opaque = controller.getState(); assert.equal(opaque.code, 'NOT_APPLIED'); assert.equal(opaque.state.emptyGuardConfirmed, false);
    frame.contentDocument = f.childDocument(frame); frame.emit('load'); f.tick(80);
    assert.equal(controller.getState().state.emptyGuardConfirmed, true);
    controller.dispose();
});

test('a departed child WindowProxy denying listener access cannot throw during scan or disposal', async () => {
    for (const disposeDirectly of [false, true]) {
        const f = fixture(), frame = f.addFrame(), child = frame.contentDocument, controller = f.mount();
        await controller.execute({ action: 'setMuted', value: true, guard: true });
        Object.defineProperty(child.defaultView, 'removeEventListener', { get() { throw Object.assign(new Error('cross-origin WindowProxy'), { name: 'SecurityError' }); } });
        if (!disposeDirectly) {
            frame.contentDocument = null; frame.emit('load');
            assert.doesNotThrow(() => f.tick(80));
            const result = controller.getState(); assert.equal(result.code, 'NOT_APPLIED'); assert.equal(result.state.emptyGuardConfirmed, false);
        } else Object.defineProperty(frame, 'removeEventListener', { get() { throw new Error('frame cleanup refused'); } });
        assert.doesNotThrow(() => controller.dispose());
        assert.equal(child.count(), 0); assert.equal(controller.getState().state.emptyGuardConfirmed, false);
        frame.emit('load'); assert.equal(f.clock.timers.size, 0);
    }
});

test('trusted child document controls revoke the guard while synthetic controls do not', async () => {
    for (const type of ['pointerdown', 'keydown']) {
        const f = fixture(), frame = f.addFrame(), child = frame.contentDocument, audio = f.add('audio', child.body), controller = f.mount();
        await controller.execute({ action: 'setMuted', value: true, guard: true });
        child.emit(type, { isTrusted: false }); audio.muted = false; f.tick(80); assert.equal(audio.muted, true);
        child.emit(type, { isTrusted: true }); assert.equal(controller.getState().state.audioUserRevision, 1);
        assert.equal(controller.getState().state.muteGuardActive, false);
        audio.muted = false; f.tick(80); assert.equal(audio.muted, false);
        controller.dispose(); assert.equal(child.count(), 0); assert.equal(child.defaultView.count(), 0);
    }
});

test('a failed child root observer, unreadable query or a document cycle cannot prove silence', async () => {
    for (const failure of ['observe', 'query', 'cycle', 'depth']) {
        const f = fixture(), frame = f.addFrame(), child = frame.contentDocument;
        if (failure === 'observe') f.view.MutationObserver = class { observe(root) { if (root === child) throw new Error('refused'); } disconnect() {} };
        if (failure === 'query') child.querySelectorAll = () => { throw new Error('unreadable'); };
        if (failure === 'cycle') frame.contentDocument = f.doc;
        if (failure === 'depth') { let nested = frame; for (let index = 0; index < 18; index++) nested = f.addFrame(nested.contentDocument.body); }
        const controller = f.mount(), result = await controller.execute({ action: 'setMuted', value: true, guard: true });
        assert.equal(result.code, 'NOT_APPLIED', failure); assert.equal(result.state.emptyGuardConfirmed, false, failure);
        controller.dispose(); assert.equal(child.count(), 0); assert.equal(child.defaultView.count(), 0); assert.equal(frame.count(), 0);
    }
});

test('an opaque ancillary frame preserves baseline control of the visible primary without inventing empty proof', async () => {
    const f = fixture(), video = f.add(); f.doc.documentElement.append(new f.Node('iframe'));
    const controller = f.mount(), result = await controller.execute({ action: 'setMuted', value: true, guard: true });
    assert.equal(result.ok, true); assert.equal(result.code, 'OK');
    assert.equal(result.state.available, true); assert.equal(result.state.muted, true); assert.equal(result.state.muteSupported, true);
    assert.equal(video.muted, true); assert.equal(result.state.emptyGuardConfirmed, false);
    controller.dispose();
});

test('custom players with inaccessible shadow roots cannot prove an empty guarded inventory', async () => {
    const f = fixture(), host = f.doc.documentElement.append(new f.Node('closed-player'));
    const closedRoot = new f.Node(); closedRoot.tagName = undefined; closedRoot.host = host;
    const hiddenAudio = f.add('audio', closedRoot); hiddenAudio.hidden = true;
    host.shadowRoot = null;
    const controller = f.mount(), result = await controller.execute({ action: 'setMuted', value: true, guard: true });
    assert.equal(result.code, 'NOT_APPLIED'); assert.equal(result.state.emptyGuardConfirmed, false);
    assert.equal(result.state.muted, null); assert.equal(result.state.volume, null);
    assert.equal(hiddenAudio.muted, false, 'inaccessible audio cannot be claimed as controlled');
    assert.equal(f.mutations[0].targets.has(closedRoot), false);
    host.remove(); assert.equal(controller.getState().state.emptyGuardConfirmed, true);
    controller.dispose();
});

test('open custom roots are observed before empty proof and late shadow media revoke and repair it', async () => {
    const f = fixture(), host = f.doc.documentElement.append(new f.Node('open-player'));
    host.shadowRoot = new f.Node(); host.shadowRoot.tagName = undefined; host.shadowRoot.host = host;
    const controller = f.mount(), reports = [];
    controller.subscribe(result => reports.push(result));
    const empty = await controller.execute({ action: 'setMuted', value: true, guard: true });
    assert.equal(empty.state.emptyGuardConfirmed, true);
    assert.equal(f.mutations[0].targets.has(host.shadowRoot), true);
    const audio = f.add('audio', host.shadowRoot); audio.hidden = true;
    f.mutations[0].callback([{ type: 'childList', addedNodes: [audio], removedNodes: [] }]);
    assert.equal(reports.at(-1).state.emptyGuardConfirmed, false, 'late shadow audio immediately revokes the proof');
    f.tick(80); assert.equal(audio.muted, true); assert.equal(controller.getState().state.emptyGuardConfirmed, false);
    assert.deepEqual([audio.playCalls, audio.pauseCalls, audio.loadCalls], [0, 0, 0]);
    controller.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('late opaque custom players revoke proof immediately both directly and inside added wrappers', async () => {
    for (const wrapped of [false, true]) {
        const f = fixture(), controller = f.mount(), reports = [];
        controller.subscribe(result => reports.push(result));
        await controller.execute({ action: 'setMuted', value: true, guard: true });
        assert.equal(reports.at(-1).state.emptyGuardConfirmed, true);
        const host = new f.Node('late-player'), added = wrapped ? new f.Node('div') : host;
        if (wrapped) added.append(host);
        f.doc.documentElement.append(added);
        f.mutations[0].callback([{ type: 'childList', addedNodes: [added], removedNodes: [] }]);
        assert.equal(reports.at(-1).state.emptyGuardConfirmed, false, `queued ${wrapped ? 'nested' : 'direct'} custom player`);
        f.tick(80); assert.equal(controller.getState().state.emptyGuardConfirmed, false);
        added.remove();
        f.mutations[0].callback([{ type: 'childList', addedNodes: [], removedNodes: [added] }]);
        f.tick(80); assert.equal(controller.getState().state.emptyGuardConfirmed, true);
        controller.dispose(); assert.equal(f.clock.timers.size, 0);
    }
});

test('new open roots revoke empty proof until observed, covering media added before the queued scan', async () => {
    for (const lateAudio of [false, true]) {
        const f = fixture(), controller = f.mount(), reports = [];
        controller.subscribe(result => reports.push(result));
        await controller.execute({ action: 'setMuted', value: true, guard: true });
        const host = f.doc.documentElement.append(new f.Node('new-open-player'));
        host.shadowRoot = new f.Node(); host.shadowRoot.tagName = undefined; host.shadowRoot.host = host;
        f.mutations[0].callback([{ type: 'childList', addedNodes: [host], removedNodes: [] }]);
        assert.equal(f.mutations[0].targets.has(host.shadowRoot), false);
        assert.equal(reports.at(-1).state.emptyGuardConfirmed, false, 'an unobserved open root is not proven empty');
        const audio = lateAudio ? f.add('audio', host.shadowRoot) : null;
        // No root observer can report this insertion before the pending scan.
        f.tick(80);
        assert.equal(f.mutations[0].targets.has(host.shadowRoot), true);
        assert.equal(controller.getState().state.emptyGuardConfirmed, !lateAudio);
        if (audio) {
            assert.equal(audio.muted, true);
            assert.deepEqual([audio.playCalls, audio.pauseCalls, audio.loadCalls], [0, 0, 0]);
        }
        controller.dispose(); assert.equal(f.clock.timers.size, 0);
    }
});

test('new DOM revokes an empty proof immediately and late media are guarded without starting playback', async () => {
    const f = fixture(), controller = f.mount(), reports = [];
    controller.subscribe(result => reports.push(result));
    await controller.execute({ action: 'setMuted', value: true, guard: true });
    assert.equal(reports.at(-1).state.emptyGuardConfirmed, true);
    const late = f.add(); late.muted = false; f.mutate();
    assert.equal(reports.at(-1).state.emptyGuardConfirmed, false, 'a queued scan cannot leave an old empty proof valid');
    f.tick(80); assert.equal(late.muted, true); assert.equal(controller.getState().state.emptyGuardConfirmed, false);
    assert.deepEqual([late.playCalls, late.pauseCalls, late.loadCalls], [0, 0, 0]);
    await controller.execute({ action: 'setMuted', value: false }); assert.equal(controller.getState().state.emptyGuardConfirmed, false);
    controller.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('decorative empty-player DOM updates retain proof without repeated sound-policy repairs', async () => {
    const f = fixture(), controller = f.mount(), reports = [];
    controller.subscribe(result => reports.push(result));
    await controller.execute({ action: 'setMuted', value: true, guard: true });
    const before = reports.length;
    for (let index = 0; index < 8; index++) {
        const banner = f.doc.documentElement.append(new f.Node('span'));
        f.mutations[0].callback([{ type: 'childList', addedNodes: [banner], removedNodes: [] }]);
        f.tick(80);
    }
    assert.equal(reports.length, before, 'unchanged silence proof must not exhaust the focus repair budget');
    const wrapper = new f.Node('div'); wrapper.append(new f.Node('iframe')); f.doc.documentElement.append(wrapper);
    f.mutations[0].callback([{ type: 'childList', addedNodes: [wrapper], removedNodes: [] }]);
    assert.equal(reports.at(-1).state.emptyGuardConfirmed, false);
    f.tick(80); assert.equal(controller.getState().state.emptyGuardConfirmed, false);
    controller.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('DOM bursts coalesce full inventories while explicit reads and controls cancel covered pending scans', async () => {
    const f = fixture(), video = f.add(), banner = f.doc.documentElement.append(new f.Node('div'));
    let scopeScans = 0;
    const query = f.doc.querySelectorAll.bind(f.doc);
    f.doc.querySelectorAll = selector => { if (selector === '*') scopeScans++; return query(selector); };
    const controller = f.mount(), reports = [];
    controller.subscribe(value => reports.push(value));
    const before = scopeScans;
    for (let index = 0; index < 12; index++) {
        const label = banner.append(new f.Node('span'));
        f.mutations[0].callback([{ type: 'childList', target: banner, addedNodes: [label], removedNodes: [] },
            { type: 'attributes', target: banner, attributeName: 'class' }]);
    }
    assert.equal(f.clock.timers.size, 1, 'one pending scan covers the entire DOM burst');
    assert.equal(scopeScans, before, 'DOM events debounce before the full inventory');
    f.tick(80); assert.equal(scopeScans, before + 1, 'decorative DOM retains a full late-route discovery opportunity');
    video._volume = .41; video.emit('volumechange');
    assert.equal(reports.at(-1).state.volume, .41, 'actual sound values are still read for event reports');
    f.mutations[0].callback([{ type: 'attributes', target: banner, attributeName: 'style' }]);
    controller.getState(); assert.equal(scopeScans, before + 2, 'explicit reads keep a fresh route inventory');
    assert.equal(f.clock.timers.size, 0); f.tick(80); assert.equal(scopeScans, before + 2, 'a covered pending DOM scan must not run again');
    f.mutations[0].callback([{ type: 'attributes', target: banner, attributeName: 'class' }]);
    await controller.execute({ action: 'setVolume', value: .29 });
    assert.equal(scopeScans, before + 3); assert.equal(video.volume, .29); assert.equal(f.clock.timers.size, 0);
    const replacement = f.add(); replacement.rect = { width: 800, height: 500 };
    f.mutations[0].callback([{ type: 'childList', target: f.doc.documentElement, addedNodes: [replacement], removedNodes: [] }]);
    f.tick(80); assert.equal(scopeScans, before + 4);
    assert.equal(reports.at(-1).state.volume, .29, 'explicit volume carries to the newly selected primary');
    controller.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('primary candidates are fully re-evaluated after style, resize and scroll changes', () => {
    const f = fixture(), small = f.add(), large = f.add();
    small.rect = { width: 320, height: 180 }; small._volume = .21;
    large._volume = .71;
    const controller = f.mount(), reports = [];
    controller.subscribe(value => reports.push(value));
    assert.equal(reports.at(-1).state.volume, .71);
    large.style.display = 'none';
    f.mutations[0].callback([{ type: 'attributes', target: large, attributeName: 'style' }]);
    f.tick(80); assert.equal(reports.at(-1).state.volume, .21);
    large.style.display = 'block'; f.sizes[0].callback([]); f.tick(80);
    assert.equal(reports.at(-1).state.volume, .71);
    large.rect.left = 2000; f.doc.emit('scroll'); f.tick(80);
    assert.equal(reports.at(-1).state.volume, .21);
    large.rect.left = 0; f.view.emit('resize'); f.tick(80);
    assert.equal(reports.at(-1).state.volume, .71);
    controller.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('guard media events coalesce a fresh inventory and a control read covers the pending repair', async () => {
    const f = fixture(), video = f.add(); let scopeScans = 0, measurements = 0;
    const query = f.doc.querySelectorAll.bind(f.doc), rect = video.getBoundingClientRect.bind(video);
    f.doc.querySelectorAll = selector => { if (selector === '*') scopeScans++; return query(selector); };
    video.getBoundingClientRect = () => { measurements++; return rect(); };
    const controller = f.mount(); await controller.execute({ action: 'setMuted', value: true, guard: true });
    const before = [scopeScans, measurements];
    video.muted = false; assert.equal(video.muted, false, 'platform resets coalesce until the repair or an explicit read');
    video.emit('playing'); video.emit('canplay');
    assert.equal(f.clock.timers.size, 1); assert.deepEqual([scopeScans, measurements], before);
    controller.getState();
    assert.equal(video.muted, true);
    assert.deepEqual([scopeScans, measurements], before.map(value => value + 1), 'the fresh read covers the whole event burst');
    f.tick(80); assert.deepEqual([scopeScans, measurements], before.map(value => value + 1), 'the covered repair cannot scan again');
    assert.equal(f.clock.timers.size, 0); controller.dispose();
});

test('five hundred healthy guard events perform at most one coalesced full scan and leave no polling timer', async () => {
    const f = fixture(), video = f.add(); let scopeScans = 0;
    const query = f.doc.querySelectorAll.bind(f.doc);
    f.doc.querySelectorAll = selector => { if (selector === '*') scopeScans++; return query(selector); };
    const controller = f.mount(); await controller.execute({ action: 'setMuted', value: true, guard: true });
    const before = scopeScans;
    for (let index = 0; index < 500; index++) {
        if (index % 3 === 0) video.volume = (index % 100) / 100;
        else video.emit(index % 2 ? 'canplay' : 'playing');
    }
    assert.equal(scopeScans, before); assert.equal(f.clock.timers.size, 1);
    f.tick(80); assert.equal(scopeScans, before + 1); assert.equal(video.muted, true);
    f.tick(20000); assert.equal(scopeScans, before + 1); assert.equal(f.clock.timers.size, 0);
    controller.dispose(); assert.equal(video.count(), 0);
});

test('guard repair discovers late shadow audio without mutation records even when layout work was queued first', async () => {
    for (const event of ['volumechange', 'loadedmetadata']) {
        const f = fixture(), video = f.add(), host = f.doc.documentElement.append(new f.Node('div'));
        const controller = f.mount(), reports = [];
        controller.subscribe(value => reports.push(value));
        await controller.execute({ action: 'setMuted', value: true, guard: true });
        // attachShadow on an existing host does not emit an observable parent
        // mutation. The known video's next sound event is a fresh safety gate.
        host.shadowRoot = new f.Node(); host.shadowRoot.tagName = undefined; host.shadowRoot.host = host;
        const audio = f.add('audio', host.shadowRoot); audio.hidden = true;
        video._muted = false; video.emit(event);
        f.tick(80);
        assert.equal(video.muted, true, event); assert.equal(audio.muted, true, event);
        assert.equal(reports.at(-1).state.muted, true); assert.equal(reports.at(-1).state.muteGuardActive, true);
        assert.equal(f.mutations[0].targets.has(host.shadowRoot), true);
        f.tick(80);
        assert.equal(f.clock.timers.size, 0); controller.dispose(); assert.equal(audio.count(), 0);
    }
});

test('a visible primary retains baseline controls while the full DOM scan guards newly inserted hidden audio', async () => {
    const f = fixture(), video = f.add(), controller = f.mount(), reports = [];
    controller.subscribe(value => reports.push(value));
    await controller.execute({ action: 'setMuted', value: true, guard: true });
    assert.equal(reports.at(-1).state.muted, true);
    const audio = f.add('audio'); audio.hidden = true;
    f.mutations[0].callback([{ type: 'childList', target: f.doc.documentElement, addedNodes: [audio], removedNodes: [] }]);
    assert.equal(video.muted, true); assert.equal(audio.muted, false);
    assert.equal(reports.at(-1).code, 'OK'); assert.equal(reports.at(-1).state.available, true);
    assert.equal(reports.at(-1).state.muted, true); assert.equal(reports.at(-1).state.muteSupported, true);
    assert.equal(reports.at(-1).state.emptyGuardConfirmed, false);
    f.tick(80);
    assert.equal(audio.muted, true); assert.equal(reports.at(-1).code, 'OK'); assert.equal(reports.at(-1).state.muted, true);
    assert.equal((await controller.execute({ action: 'setVolume', value: .44 })).ok, true);
    assert.equal(video.volume, .44); assert.equal(audio.muted, true);
    assert.equal(f.clock.timers.size, 0); controller.dispose(); assert.equal(audio.count(), 0);
});

test('a pending frame announcement cannot turn healthy waiting-to-playing events into an unknown mute report', async () => {
    const { createFrameClient } = require('../userscript/transport.js');
    const f = fixture(), video = f.add(), messages = [];
    video.paused = false;
    const channelConfig = { ...config, CHANNEL: 'umininn-tv-userscript' };
    const parent = { postMessage(message) { if (message.type === 'frame:ready') messages.push(message); } };
    Object.assign(f.view, { document: f.doc, parent, top: parent, location: { href: 'https://player.kick.com/sample' },
        crypto: require('node:crypto').webcrypto, setTimeout: f.clock.setTimeout.bind(f.clock), clearTimeout: f.clock.clearTimeout.bind(f.clock) });
    let controller;
    const client = createFrameClient({ window: f.view, config: channelConfig,
        media: { createMediaController() { controller = f.mount(); return controller; } } });
    f.view.emit('message', { source: parent, origin: 'https://umininn-gh.github.io',
        data: { channel: channelConfig.CHANNEL, version: channelConfig.VERSION, type: 'frame:probe' } });
    await controller.execute({ action: 'setMuted', value: true, guard: true });
    f.tick(100); messages.length = 0;
    for (let index = 0; index < 8; index++) {
        // A waiting report is already due before the later playing event's old
        // 80ms repair timer. That announcement must not publish false uncertainty
        // while the unchanged player has remained muted throughout the cycle.
        video.emit('waiting'); f.tick(70); video.emit('playing'); video.emit('canplay');
        f.tick(30);
        assert.equal(video.muted, true);
        assert.ok(messages.length > index);
        assert.ok(messages.every(message => message.result.state.muted === true), 'healthy media events must not trigger a parent safety repair');
        f.tick(5900);
    }
    client.dispose(); assert.equal(f.clock.timers.size, 0); assert.equal(video.count(), 0);
});

test('a fresh frame announcement discovers late shadow audio before its pending guard repair deadline', async () => {
    const { createFrameClient } = require('../userscript/transport.js');
    const f = fixture(), video = f.add(), host = f.doc.documentElement.append(new f.Node('div')), messages = [];
    video.paused = false;
    const channelConfig = { ...config, CHANNEL: 'umininn-tv-userscript' };
    const parent = { postMessage(message) { if (message.type === 'frame:ready') messages.push(message); } };
    Object.assign(f.view, { document: f.doc, parent, top: parent, location: { href: 'https://player.kick.com/sample' },
        crypto: require('node:crypto').webcrypto, setTimeout: f.clock.setTimeout.bind(f.clock), clearTimeout: f.clock.clearTimeout.bind(f.clock) });
    let controller;
    const client = createFrameClient({ window: f.view, config: channelConfig,
        media: { createMediaController() { controller = f.mount(); return controller; } } });
    f.view.emit('message', { source: parent, origin: 'https://umininn-gh.github.io',
        data: { channel: channelConfig.CHANNEL, version: channelConfig.VERSION, type: 'frame:probe' } });
    await controller.execute({ action: 'setMuted', value: true, guard: true }); f.tick(100); messages.length = 0;
    video.emit('waiting'); f.tick(70);
    host.shadowRoot = new f.Node(); host.shadowRoot.tagName = undefined; host.shadowRoot.host = host;
    const audio = f.add('audio', host.shadowRoot); audio.hidden = true;
    video.emit('playing'); video.emit('canplay');
    assert.equal(audio.muted, false, 'the new shadow route has not emitted an observable mutation');
    f.tick(30); // The existing 100ms announcement precedes the 80ms guard timer.
    assert.equal(audio.muted, true, 'an outgoing silence report must first rediscover and guard the actual routes');
    assert.equal(messages.at(-1).result.state.muted, true); assert.equal(f.mutations[0].targets.has(host.shadowRoot), true);
    assert.equal(f.clock.timers.size, 0, 'announcement discovery cancels the covered guard repair');
    client.dispose(); assert.equal(audio.count(), 0);
});

test('queued mutations are drained before a full passive event scan repairs newly inserted media', async () => {
    const f = fixture(), video = f.add(), controller = f.mount();
    await controller.execute({ action: 'setMuted', value: true, guard: true });
    f.mutations[0].callback([{ type: 'attributes', target: video, attributeName: 'class' }]);
    const late = f.add('audio'); late.hidden = true;
    f.mutations[0].records.push({ type: 'childList', target: f.doc.documentElement, addedNodes: [late], removedNodes: [] });
    f.tick(80);
    assert.equal(late.muted, true, 'a queued observer delivery cannot hide new audio from the full event scan');
    assert.equal(f.mutations[0].records.length, 0); assert.equal(f.clock.timers.size, 0);
    controller.dispose(); assert.equal(late.count(), 0);
});

test('removing an empty open root releases its observer and re-adding it requires fresh proof', async () => {
    for (const wrapped of [false, true]) {
        const f = fixture(), host = new f.Node('div'), added = wrapped ? new f.Node('section') : host;
        if (wrapped) added.append(host);
        host.shadowRoot = new f.Node(); host.shadowRoot.tagName = undefined; host.shadowRoot.host = host;
        f.doc.documentElement.append(added);
        const controller = f.mount(), reports = [];
        controller.subscribe(value => reports.push(value));
        await controller.execute({ action: 'setMuted', value: true, guard: true });
        assert.equal(reports.at(-1).state.emptyGuardConfirmed, true);
        assert.equal(f.mutations[0].targets.has(host.shadowRoot), true);
        added.remove();
        f.mutations[0].callback([{ type: 'childList', target: f.doc.documentElement, addedNodes: [], removedNodes: [added] }]);
        assert.equal(reports.at(-1).state.emptyGuardConfirmed, false);
        f.tick(80); assert.equal(f.mutations[0].targets.has(host.shadowRoot), false);
        assert.equal(reports.at(-1).state.emptyGuardConfirmed, true);
        f.doc.documentElement.append(added);
        f.mutations[0].callback([{ type: 'childList', target: f.doc.documentElement, addedNodes: [added], removedNodes: [] }]);
        assert.equal(reports.at(-1).state.emptyGuardConfirmed, false);
        f.tick(80); assert.equal(f.mutations[0].targets.has(host.shadowRoot), true);
        assert.equal(reports.at(-1).state.emptyGuardConfirmed, true);
        controller.dispose(); assert.equal(f.mutations[0].targets.size, 0); assert.equal(f.clock.timers.size, 0);
    }
});

test('an attribute event on an existing host or descendant discovers a late open root and immediately revokes proof', async () => {
    for (const descendant of [false, true]) {
        const f = fixture(), host = f.doc.documentElement.append(new f.Node('div'));
        let target = host;
        if (descendant) for (let index = 0; index < 20; index++) target = target.append(new f.Node('div'));
        const controller = f.mount(), reports = [];
        controller.subscribe(value => reports.push(value));
        await controller.execute({ action: 'setMuted', value: true, guard: true });
        host.shadowRoot = new f.Node(); host.shadowRoot.tagName = undefined; host.shadowRoot.host = host;
        f.mutations[0].callback([{ type: 'attributes', target, attributeName: 'class' }]);
        assert.equal(reports.at(-1).state.emptyGuardConfirmed, false);
        assert.equal(f.mutations[0].targets.has(host.shadowRoot), false);
        const audio = f.add('audio', host.shadowRoot); audio.hidden = true;
        f.tick(80); assert.equal(audio.muted, true);
        assert.equal(f.mutations[0].targets.has(host.shadowRoot), true);
        assert.equal(reports.at(-1).state.emptyGuardConfirmed, false);
        controller.dispose(); assert.equal(audio.count(), 0); assert.equal(f.clock.timers.size, 0);
    }
});

test('explicit reads and controls discover a late shadow route even without any mutation delivery', async () => {
    for (const action of ['read', 'control']) {
        const f = fixture(), host = f.doc.documentElement.append(new f.Node('div')), controller = f.mount();
        await controller.execute({ action: 'setMuted', value: true, guard: true });
        host.shadowRoot = new f.Node(); host.shadowRoot.tagName = undefined; host.shadowRoot.host = host;
        const audio = f.add('audio', host.shadowRoot); audio.hidden = true;
        const result = action === 'read' ? controller.getState() : await controller.execute({ action: 'getState' });
        assert.equal(result.state.emptyGuardConfirmed, false); assert.equal(result.state.muted, true);
        assert.equal(audio.muted, true); assert.equal(f.mutations[0].targets.has(host.shadowRoot), true);
        controller.dispose(); assert.equal(f.clock.timers.size, 0);
    }
});

test('unrelated DOM, resize and scroll events discover late shadow audio in empty and visible guarded scopes', async () => {
    for (const visible of [false, true]) for (const event of ['attribute', 'childList', 'resize', 'scroll', 'media-resize']) {
        if (!visible && event === 'media-resize') continue;
        const f = fixture(); if (visible) f.add();
        const host = f.doc.documentElement.append(new f.Node('div')), decoration = f.doc.documentElement.append(new f.Node('span'));
        const controller = f.mount(), reports = [];
        controller.subscribe(value => reports.push(value));
        await controller.execute({ action: 'setMuted', value: true, guard: true });
        host.shadowRoot = new f.Node(); host.shadowRoot.tagName = undefined; host.shadowRoot.host = host;
        const audio = f.add('audio', host.shadowRoot); audio.hidden = true; await audio.play();
        // Neither the new open root nor its audio events have an observer yet.
        // Baseline full event discovery must also work when the notifying node
        // is unrelated to that host, including a previously empty inventory.
        if (event === 'attribute') f.mutations[0].callback([{ type: 'attributes', target: decoration, attributeName: 'style' }]);
        else if (event === 'childList') {
            const label = decoration.append(new f.Node('b'));
            f.mutations[0].callback([{ type: 'childList', target: decoration, addedNodes: [label], removedNodes: [] }]);
        } else if (event === 'media-resize') f.sizes[0].callback([]);
        else (event === 'scroll' ? f.doc : f.view).emit(event);
        assert.equal(audio.muted, false, `${visible}/${event}: the late audio was not accidentally discovered by a control read`);
        assert.equal(f.clock.timers.size, 1);
        f.tick(80);
        assert.equal(audio.muted, true, `${visible}/${event}: full discovery guards the new route`);
        assert.equal(reports.at(-1).state.muted, true); assert.equal(reports.at(-1).state.emptyGuardConfirmed, false);
        assert.equal(f.mutations[0].targets.has(host.shadowRoot), true);
        assert.equal(f.clock.timers.size, 0); controller.dispose(); assert.equal(audio.count(), 0);
    }
});

test('observers without usable takeRecords fall back to fresh event scans without adding a polling loop', async () => {
    for (const failure of ['missing', 'throws']) {
        const f = fixture(), video = f.add(), controller = f.mount();
        await controller.execute({ action: 'setMuted', value: true, guard: true });
        f.mutations[0].takeRecords = failure === 'missing' ? undefined : () => { throw new Error('unavailable'); };
        const hidden = f.add('audio'); hidden.hidden = true;
        video.muted = false; f.tick(80);
        assert.equal(hidden.muted, true); assert.equal(video.muted, true);
        assert.equal(f.clock.timers.size, 0);
        controller.getState(); assert.equal(f.clock.timers.size, 0);
        controller.dispose(); assert.equal(hidden.count(), 0);
    }
});

test('missing or incomplete root observers retain full event discovery of new hidden audio', async () => {
    for (const failure of ['missing', 'shadow-root-refused']) {
        const f = fixture(), video = f.add(), host = f.doc.documentElement.append(new f.Node('div'));
        host.shadowRoot = new f.Node(); host.shadowRoot.tagName = undefined; host.shadowRoot.host = host;
        if (failure === 'missing') f.view.MutationObserver = undefined;
        else {
            const Observer = f.view.MutationObserver;
            f.view.MutationObserver = class extends Observer { observe(root, options) {
                if (root === host.shadowRoot) throw new Error('refused');
                super.observe(root, options);
            } };
        }
        const controller = f.mount(); await controller.execute({ action: 'setMuted', value: true, guard: true });
        const hidden = f.add('audio', host.shadowRoot); hidden.hidden = true;
        video.muted = false; f.tick(80);
        assert.equal(video.muted, true); assert.equal(hidden.muted, true);
        assert.equal(controller.getState().state.emptyGuardConfirmed, false); assert.equal(f.clock.timers.size, 0);
        controller.dispose(); assert.equal(hidden.count(), 0);
    }
});

test('routes inserted by a page handler during guard application revoke the just-collected proof', async () => {
    const f = fixture(), audio = f.add('audio'); audio.hidden = true;
    let inserted = false;
    Object.defineProperty(audio, 'muted', { get() { return this._muted; }, set(value) {
        this._muted = value; this.emit('volumechange');
        if (!inserted) {
            inserted = true;
            const frame = f.doc.documentElement.append(new f.Node('iframe'));
            f.mutations[0].records.push({ type: 'childList', target: f.doc.documentElement, addedNodes: [frame], removedNodes: [] });
        }
    } });
    const controller = f.mount(), reports = [];
    controller.subscribe(value => reports.push(value));
    const result = await controller.execute({ action: 'setMuted', value: true, guard: true });
    assert.equal(result.code, 'NOT_APPLIED'); assert.equal(result.state.muted, null);
    assert.equal(result.state.emptyGuardConfirmed, false); assert.equal(audio.muted, true);
    f.tick(80); assert.equal(reports.at(-1).code, 'NOT_APPLIED'); assert.equal(f.clock.timers.size, 0);
    controller.dispose(); assert.equal(audio.count(), 0);
});

test('a missing or throwing takeRecords cannot confirm hidden-route silence after a setter inserts an unknown iframe', async () => {
    for (const failure of ['missing', 'throws']) {
        const f = fixture(), audio = f.add('audio'); audio.hidden = true;
        const controller = f.mount();
        f.mutations[0].takeRecords = failure === 'missing' ? undefined : () => { throw new Error('unavailable'); };
        let inserted = false;
        Object.defineProperty(audio, 'muted', { get() { return this._muted; }, set(value) {
            this._muted = value; this.emit('volumechange');
            if (!inserted) {
                inserted = true;
                const frame = f.doc.documentElement.append(new f.Node('iframe'));
                f.mutations[0].records.push({ type: 'childList', target: f.doc.documentElement, addedNodes: [frame], removedNodes: [] });
            }
        } });
        const result = await controller.execute({ action: 'setMuted', value: true, guard: true });
        assert.equal(result.code, 'NOT_APPLIED', failure); assert.equal(result.state.muted, null, failure);
        assert.equal(result.state.muteSupported, false); assert.equal(result.state.emptyGuardConfirmed, false);
        assert.equal(audio.muted, true, 'known audio is still muted despite the unverified inventory');
        assert.equal(f.clock.timers.size, 0, 'an unavailable flush must not create a permanent retry timer');
        f.tick(20000); assert.equal(f.clock.timers.size, 0);
        controller.dispose(); assert.equal(audio.count(), 0);
    }
});

test('a visible primary setter keeps baseline control when it adds an opaque route, including unavailable flushes', async () => {
    for (const flush of ['working', 'missing', 'throws']) {
        const f = fixture(), video = f.add(), controller = f.mount();
        if (flush !== 'working') f.mutations[0].takeRecords = flush === 'missing' ? undefined : () => { throw new Error('unavailable'); };
        let inserted = false;
        Object.defineProperty(video, 'muted', { get() { return this._muted; }, set(value) {
            this._muted = value; this.emit('volumechange');
            if (!inserted) {
                inserted = true;
                const frame = f.doc.documentElement.append(new f.Node('iframe'));
                f.mutations[0].records.push({ type: 'childList', target: f.doc.documentElement, addedNodes: [frame], removedNodes: [] });
            }
        } });
        const result = await controller.execute({ action: 'setMuted', value: true, guard: true });
        assert.equal(result.ok, true, flush); assert.equal(result.code, 'OK', flush);
        assert.equal(result.state.available, true); assert.equal(result.state.muted, true); assert.equal(result.state.muteSupported, true);
        assert.equal(result.state.emptyGuardConfirmed, false);
        assert.equal(video.muted, true, 'known primary is still silenced');
        assert.equal((await controller.execute({ action: 'setVolume', value: .37 })).ok, true);
        assert.equal(video.volume, .37);
        f.tick(80); assert.equal(f.clock.timers.size, 0, 'failed verification must not create a polling loop');
        controller.dispose(); assert.equal(video.count(), 0);
    }
});

test('visible video with an ad iframe or custom route preserves baseline controls and still guards every known hidden medium', async () => {
    for (const tag of ['iframe', 'ad-player']) {
        const f = fixture(), video = f.add(), soundtrack = f.add('audio'); soundtrack.hidden = true;
        f.doc.documentElement.append(new f.Node(tag));
        const controller = f.mount();
        const guarded = await controller.execute({ action: 'setMuted', value: true, guard: true });
        assert.equal(guarded.code, 'OK', tag); assert.equal(guarded.ok, true);
        assert.equal(guarded.state.available, true); assert.equal(guarded.state.muted, true); assert.equal(guarded.state.muteSupported, true);
        assert.equal(guarded.state.emptyGuardConfirmed, false);
        assert.equal(video.muted, true); assert.equal(soundtrack.muted, true);
        const volume = await controller.execute({ action: 'setVolume', value: .36 });
        assert.equal(volume.ok, true); assert.equal(video.volume, .36); assert.equal(soundtrack.muted, true);
        const unmute = await controller.execute({ action: 'setMuted', value: false });
        assert.equal(unmute.ok, true); assert.equal(video.muted, false);
        assert.equal(soundtrack.muted, true, 'ordinary controls retain their primary-only behavior');
        assert.equal(unmute.state.emptyGuardConfirmed, false);
        controller.dispose(); assert.equal(f.clock.timers.size, 0);
    }
});

test('no-media and invalid commands return honest JSON without changing defaults', async () => {
    const f = fixture(), controller = f.mount();
    assert.equal(controller.getState().code, 'NO_MEDIA');
    assert.equal(controller.getState().state.available, false);
    for (const value of [-1, 1.01, NaN, Infinity, '0.5', null]) assert.equal((await controller.execute({ action: 'setVolume', value })).code, 'INVALID_VALUE');
    for (const value of ['true', 1, null]) assert.equal((await controller.execute({ action: 'setMuted', value })).code, 'INVALID_VALUE');
    assert.equal((await controller.execute({ action: 'reload' })).code, 'INVALID_ACTION');
    assert.equal((await controller.execute({ action: 'recover' })).code, 'NO_MEDIA');
    const video = f.add(); f.mutate(); f.tick(80);
    assert.equal(video.volume, 0.8); assert.equal(video.muted, false); assert.equal(video.playCalls, 0);
    assert.doesNotThrow(() => JSON.stringify(controller.getState()));
    controller.dispose();
});

test('controls one largest visible video, with video preference and visible audio fallback', async () => {
    const f = fixture();
    const audio = f.add('audio'); audio.rect = { width: 1000, height: 600 };
    const small = f.add(); small.rect = { width: 100, height: 80 };
    const main = f.add();
    const hidden = f.add(); hidden.rect = { width: 1200, height: 700 }; hidden.hidden = true;
    const offscreen = f.add(); offscreen.rect = { left: 2000, width: 1200, height: 700 };
    const controller = f.mount();
    await controller.execute({ action: 'setVolume', value: 0.25 });
    assert.equal(main.volume, 0.25);
    for (const other of [audio, small, hidden, offscreen]) assert.equal(other.volume, 0.8);
    main.remove(); small.remove(); f.mutate(); f.tick(80);
    assert.equal(controller.getState().state.mediaType, 'audio');
    assert.equal(audio.volume, 0.25);
    controller.dispose();
});

test('a large video clipped by a hidden-overflow ancestor is not the primary player', async () => {
    const f = fixture(), main = f.add();
    const carousel = f.doc.documentElement.append(new f.Node());
    carousel.style.overflow = 'hidden'; carousel.rect = { width: 0, height: 100 };
    const clipped = f.add('video', carousel); clipped.rect = { width: 1200, height: 700 };
    const controller = f.mount(); await controller.execute({ action: 'setMuted', value: true });
    assert.equal(main.muted, true); assert.equal(clipped.muted, false); controller.dispose();
});

test('scope isolates native players, including scope itself and open shadow roots', async () => {
    const f = fixture();
    const outside = f.add(); outside.rect = { width: 1200, height: 700 };
    const scope = f.doc.documentElement.append(new f.Node());
    const host = scope.append(new f.Node('player-host'));
    host.shadowRoot = new f.Node(); host.shadowRoot.tagName = undefined; host.shadowRoot.host = host;
    const video = f.add('video', host.shadowRoot);
    const controller = f.mount(scope);
    assert.equal(controller.getState().state.mediaType, 'video');
    await controller.execute({ action: 'setMuted', value: true });
    assert.equal(video.muted, true); assert.equal(outside.muted, false);
    assert.ok(f.mutations[0].targets.has(host.shadowRoot));
    controller.dispose();
    const direct = f.mount(outside);
    await direct.execute({ action: 'setVolume', value: 0.45 });
    assert.equal(outside.volume, 0.45); assert.equal(video.volume, 0.8);
    direct.dispose();
});

test('sound commands preserve pause/volume and never play, reload, or fight platform changes', async () => {
    const f = fixture(), video = f.add(), controller = f.mount();
    await controller.execute({ action: 'setVolume', value: 0.33 });
    await controller.execute({ action: 'setMuted', value: true });
    await controller.execute({ action: 'setMuted', value: false });
    assert.equal(video.volume, 0.33); assert.equal(video.paused, true);
    assert.equal(video.playCalls, 0); assert.equal(video.loadCalls, 0);
    video.volume = 0.12;
    assert.equal(controller.getState().state.volume, 0.12);
    const replacement = f.add(); video.remove(); f.mutate(); f.tick(80);
    assert.equal(replacement.volume, 0.33); assert.equal(replacement.muted, false);
    assert.equal(replacement.playCalls, 0); assert.equal(video.count(), 0);
    controller.dispose();
});

test('focus mute guard silences every connected scoped media including hidden audio and open shadows', async () => {
    const f = fixture(), outside = f.add();
    const scope = f.doc.documentElement.append(new f.Node());
    const main = f.add('video', scope), hidden = f.add('audio', scope), offscreen = f.add('video', scope);
    hidden.hidden = true; offscreen.rect.left = 2000;
    const host = scope.append(new f.Node('player-host'));
    host.shadowRoot = new f.Node(); host.shadowRoot.tagName = undefined; host.shadowRoot.host = host;
    const shadow = f.add('audio', host.shadowRoot); shadow.hidden = true;
    const controller = f.mount(scope);
    const value = await controller.execute({ action: 'setMuted', value: true, guard: true });
    assert.equal(value.ok, true); assert.equal(value.state.muted, true); assert.equal(value.state.muteGuardActive, true);
    for (const node of [main, hidden, offscreen, shadow]) {
        assert.equal(node.muted, true); assert.equal(node.volume, 0.8);
        assert.equal(node.playCalls, 0); assert.equal(node.pauseCalls, 0); assert.equal(node.loadCalls, 0);
    }
    assert.equal(outside.muted, false);
    controller.dispose();
});

test('focus guard remembers a request before media exists and mutes late hidden and replacement nodes', async () => {
    const f = fixture(), controller = f.mount();
    const empty = await controller.execute({ action: 'setMuted', value: true, guard: true });
    assert.equal(empty.code, 'NO_MEDIA'); assert.equal(empty.state.muteGuardActive, true); assert.equal(empty.state.muted, null);
    const main = f.add(), hidden = f.add('audio'); hidden.hidden = true;
    f.mutate(); f.tick(80);
    assert.equal(main.muted, true); assert.equal(hidden.muted, true);
    main.remove(); const replacement = f.add(); f.mutate(); f.tick(80);
    assert.equal(replacement.muted, true); assert.equal(controller.getState().state.muted, true);
    hidden._muted = false; hidden.emit('playing'); f.tick(80);
    assert.equal(hidden.muted, true); assert.equal(f.clock.timers.size, 0);
    controller.dispose();
});

test('focus guard repairs deferred platform unmute and source events while volume changes preserve the guard', async () => {
    const f = fixture(), video = f.add(), hidden = f.add('audio'); hidden.hidden = true;
    const controller = f.mount();
    await controller.execute({ action: 'setMuted', value: true, guard: true });
    await controller.execute({ action: 'setVolume', value: 1 });
    for (const event of ['volumechange', 'play', 'playing', 'loadedmetadata', 'canplay', 'emptied']) {
        hidden._muted = false; hidden.emit(event); f.tick(80);
        assert.equal(hidden.muted, true, event);
    }
    assert.equal(video.volume, 1); assert.equal(controller.getState().state.muteGuardActive, true);
    assert.equal(video.playCalls, 0); assert.equal(hidden.playCalls, 0);
    assert.equal(f.clock.timers.size, 0); controller.dispose();
});

test('ordinary mute commands revoke focus guard without changing existing primary-only manual semantics', async () => {
    const f = fixture(), video = f.add(), hidden = f.add('audio'); hidden.hidden = true;
    const controller = f.mount();
    await controller.execute({ action: 'setMuted', value: true, guard: true });
    await controller.execute({ action: 'setMuted', value: true });
    assert.equal(controller.getState().state.muteGuardActive, false);
    video.muted = false; hidden.muted = false; f.tick(500);
    assert.equal(video.muted, false); assert.equal(hidden.muted, false);
    await controller.execute({ action: 'setMuted', value: true, guard: true });
    const target = await controller.execute({ action: 'setMuted', value: false });
    assert.equal(target.state.muteGuardActive, false); assert.equal(video.muted, false); assert.equal(hidden.muted, true);
    controller.dispose();
});

test('bookmark focus restores its saved volume to primary and previously audible hidden routes while leaving muted preload silent', async () => {
    const f = fixture(), outside = f.add(), scope = f.doc.documentElement.append(new f.Node());
    const main = f.add('video', scope), soundtrack = f.add('audio', scope), preload = f.add('video', scope);
    soundtrack.hidden = true; soundtrack.volume = .64;
    preload.hidden = true; preload.muted = true; preload.volume = .13;
    const controller = f.mount(scope);
    assert.equal((await controller.execute({ action: 'setMuted', value: true, guard: true })).ok, true);
    assert.deepEqual([main.muted, soundtrack.muted, preload.muted], [true, true, true]);
    const volume = await controller.execute({ action: 'setVolume', value: .37, focus: true });
    assert.equal(volume.ok, true); assert.equal(volume.state.volume, .37);
    assert.equal(volume.state.muteGuardActive, true, 'volume is restored before any previously audible route may unmute');
    assert.deepEqual([main.volume, soundtrack.volume, preload.volume], [.37, .37, .13]);
    assert.deepEqual([main.muted, soundtrack.muted, preload.muted], [true, true, true]);
    assert.equal(volume.state.focusRestorePending, true);
    const restored = await controller.execute({ action: 'setMuted', value: false, focus: true });
    assert.equal(restored.ok, true); assert.equal(restored.state.muteGuardActive, false); assert.equal(restored.state.focusRestorePending, false);
    assert.deepEqual([main.muted, soundtrack.muted, preload.muted], [false, false, true]);
    assert.deepEqual([main.volume, soundtrack.volume, preload.volume], [.37, .37, .13]);
    assert.deepEqual([outside.muted, outside.volume], [false, .8], 'other player scopes are unaffected');
    for (const node of [main, soundtrack, preload, outside]) {
        assert.equal(node.playCalls, 0); assert.equal(node.pauseCalls, 0); assert.equal(node.loadCalls, 0);
    }
    assert.equal(f.clock.timers.size, 0); controller.dispose();
});

test('invalid focus commands cannot change a guarded player or its remembered hidden audio', async () => {
    const f = fixture(), main = f.add(), soundtrack = f.add('audio'); soundtrack.hidden = true;
    const controller = f.mount(); await controller.execute({ action: 'setMuted', value: true, guard: true });
    const invalid = [
        ...[NaN, Infinity, -.01, 1.01, '.37', null].map(value => ({ action: 'setVolume', value, focus: true })),
        { action: 'setVolume', value: .37, focus: false }, { action: 'setVolume', value: .37, focus: true, guard: true },
        { action: 'setMuted', value: true, focus: true, guard: true }, { action: 'setMuted', value: false, focus: true, guard: false },
        { action: 'setMuted', value: true, focus: true }, { action: 'recover', focus: true }, { action: 'getState', focus: true }
    ];
    for (const command of invalid) {
        assert.equal((await controller.execute(command)).code, 'INVALID_VALUE');
        assert.deepEqual([main.muted, soundtrack.muted, main.volume, soundtrack.volume], [true, true, .8, .8]);
        assert.equal(controller.getState().state.muteGuardActive, true);
        assert.equal(controller.getState().state.focusRestorePending, true);
    }
    assert.equal(main.playCalls, 0); assert.equal(soundtrack.playCalls, 0);
    assert.equal(f.clock.timers.size, 0); controller.dispose();
});

test('trusted native controls revoke focus guard and carry-over while synthetic activity does not', async () => {
    for (const type of ['pointerdown', 'keydown']) {
        const f = fixture(), video = f.add(), controller = f.mount(), received = [];
        controller.subscribe(value => received.push(value));
        await controller.execute({ action: 'setMuted', value: true, guard: true });
        f.doc.emit(type, { isTrusted: false }); video.muted = false; f.tick(80);
        assert.equal(video.muted, true);
        f.doc.emit(type, { isTrusted: true });
        assert.equal(received.at(-1).state.muteGuardActive, false);
        video.muted = false; f.tick(80); assert.equal(video.muted, false);
        video.remove(); const replacement = f.add(); f.mutate(); f.tick(80);
        assert.equal(replacement.muted, false); controller.dispose();
    }
});

test('trusted native volume intent clears old script volume for future media replacements, with or without a focus guard', async () => {
    for (const type of ['pointerdown', 'keydown']) for (const guarded of [false, true]) {
        const f = fixture(), first = f.add(), controller = f.mount();
        await controller.execute({ action: 'setVolume', value: 0.33 });
        await controller.execute({ action: 'setMuted', value: true, ...(guarded ? { guard: true } : {}) });
        const revision = controller.getState().state.audioUserRevision;

        f.doc.emit(type, { isTrusted: false }); first.volume = 0.17;
        first.remove(); const second = f.add(); f.mutate(); f.tick(80);
        assert.equal(second.volume, 0.33, `${type}/${guarded}: synthetic activity preserves the explicit script setting`);
        assert.equal(controller.getState().state.audioUserRevision, revision);

        f.doc.emit(type, { isTrusted: true }); second.volume = 0.61; second.muted = false;
        assert.equal(controller.getState().state.volume, 0.61);
        assert.equal(controller.getState().state.audioUserRevision, revision + 1);
        assert.equal(controller.getState().state.muteGuardActive, false);
        second.remove(); const third = f.add(); third.volume = 0.74;
        f.mutate(); f.tick(80);
        assert.equal(third.volume, 0.74, `${type}/${guarded}: a later platform video cannot inherit the superseded 0.33 script volume`);
        assert.equal(third.muted, false);
        assert.equal(third.playCalls, 0); assert.equal(third.pauseCalls, 0); assert.equal(third.loadCalls, 0);
        assert.equal(first.count(), 0); assert.equal(second.count(), 0);
        assert.equal(f.clock.timers.size, 0);
        controller.dispose();
    }
});

test('focus guard reports every refused or hidden audible setter without false mute confirmation', async () => {
    const f = fixture(), video = f.add(), hidden = f.add('audio'); hidden.hidden = true;
    Object.defineProperty(hidden, 'muted', { get: () => false, set() { throw new Error('platform refused'); } });
    const controller = f.mount();
    const value = await controller.execute({ action: 'setMuted', value: true, guard: true });
    assert.equal(value.ok, false); assert.equal(value.code, 'NOT_APPLIED'); assert.equal(value.state.muted, false);
    assert.equal(video.muted, true); assert.equal(value.state.muteGuardActive, true);
    assert.equal(f.clock.timers.size, 0); controller.dispose();
});

test('focus repair bounds setter bursts and repeated platform resets without polling or a setter loop', async () => {
    const f = fixture(), video = f.add(), controller = f.mount(); let writes = 0;
    Object.defineProperty(video, 'muted', { get() { return this._muted; }, set(value) { writes++; this._muted = value; this.emit('volumechange'); } });
    await controller.execute({ action: 'setMuted', value: true, guard: true });
    for (let index = 0; index < 20; index++) {
        video._muted = false;
        video.emit('volumechange'); video.emit('playing'); video.emit('canplay');
        assert.ok(f.clock.timers.size <= 1); f.tick(80);
    }
    assert.ok(writes <= 8, `bounded writes: ${writes}`);
    const exhausted = controller.getState();
    assert.equal(exhausted.code, 'NOT_APPLIED'); assert.equal(exhausted.state.muted, false);
    assert.equal(exhausted.state.muteGuardActive, true);
    f.tick(20000); assert.equal(f.clock.timers.size, 0); assert.ok(writes <= 8);
    video.emit('volumechange'); f.tick(500); controller.getState();
    assert.equal(f.clock.timers.size, 0); assert.ok(writes <= 8, 'an exhausted node remains blocked until a new explicit guard request');
    const retried = await controller.execute({ action: 'setMuted', value: true, guard: true });
    assert.equal(retried.ok, true); assert.equal(video.muted, true);
    controller.dispose();
});

test('focus guard validates opt-in, cancels pending event repairs and exposes revoked state on disposal', async () => {
    const f = fixture(), video = f.add(), controller = f.mount();
    for (const command of [{ action: 'setMuted', value: false, guard: true }, { action: 'setMuted', value: true, guard: false },
        { action: 'setVolume', value: 1, guard: true }, { action: 'recover', guard: true }]) {
        assert.equal((await controller.execute(command)).code, 'INVALID_VALUE');
    }
    await controller.execute({ action: 'setMuted', value: true, guard: true });
    video.muted = false; assert.equal(video.muted, false); assert.equal(f.clock.timers.size, 1);
    controller.dispose(); f.tick(500);
    assert.equal(video.muted, false); assert.equal(video.count(), 0); assert.equal(f.clock.timers.size, 0);
    assert.equal(controller.getState().state.muteGuardActive, false);
});

test('replacement and removal notify after debounced DOM events without a polling timer', async () => {
    const f = fixture(), video = f.add(), controller = f.mount(), received = [];
    const unsubscribe = controller.subscribe(value => received.push(value));
    const before = received.at(-1).state.mediaId;
    video.remove(); const replacement = f.add(); f.mutate(); f.mutate(); f.mutate();
    assert.equal(f.clock.timers.size, 1); f.tick(80);
    assert.notEqual(received.at(-1).state.mediaId, before);
    assert.equal(f.clock.timers.size, 0);
    replacement.remove(); f.mutate(); f.tick(80);
    assert.equal(received.at(-1).code, 'NO_MEDIA');
    unsubscribe(); const count = received.length;
    f.add(); f.mutate(); f.tick(80); assert.equal(received.length, count);
    controller.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('manual recover confirms playback and never reloads or rewrites sound', async () => {
    const f = fixture(), video = f.add(), controller = f.mount();
    video._volume = 0.42; video._muted = true;
    const value = await controller.execute({ action: 'recover' });
    assert.equal(value.ok, true); assert.equal(value.state.paused, false);
    assert.equal(video.playCalls, 1); assert.equal(video.loadCalls, 0);
    assert.equal(video.volume, 0.42); assert.equal(video.muted, true);
    await controller.execute({ action: 'recover' }); assert.equal(video.playCalls, 1);
    assert.equal(f.clock.timers.size, 0); controller.dispose();
});

test('NotAllowedError is reported as blocked and does not retry automatically', async () => {
    const f = fixture(), video = f.add();
    video.playImpl = () => Promise.reject(Object.assign(new Error('policy'), { name: 'NotAllowedError' }));
    const controller = f.mount();
    const value = await controller.execute({ action: 'recover' });
    assert.equal(value.code, 'PLAY_BLOCKED'); assert.equal(value.state.playbackStatus, 'blocked');
    f.tick(20000); assert.equal(video.playCalls, 1); assert.equal(f.clock.timers.size, 0);
    controller.dispose();
});

test('a manual pause cancels a pending recover without retrying or swallowing that pause', async () => {
    const f = fixture(), video = f.add(); let resolve;
    video.playImpl = () => new Promise(done => { resolve = done; });
    const controller = f.mount(), request = controller.execute({ action: 'recover' });
    video.pause(); assert.equal((await request).code, 'CANCELLED');
    resolve(); await flush(); f.tick(20000);
    assert.equal(video.paused, true); assert.equal(video.playCalls, 1); assert.equal(f.clock.timers.size, 0);
    controller.dispose();
});

test('read-only or ignored sound setters are reported as failures', async () => {
    const f = fixture(), video = f.add();
    Object.defineProperty(video, 'volume', { get: () => 0.8, set() {} });
    Object.defineProperty(video, 'muted', { get: () => false, set() { throw new Error('denied'); } });
    const controller = f.mount();
    assert.equal((await controller.execute({ action: 'setVolume', value: 0.2 })).code, 'NOT_APPLIED');
    assert.equal((await controller.execute({ action: 'setMuted', value: true })).code, 'NOT_SUPPORTED');
    assert.equal(video.playCalls, 0); controller.dispose();
});

test('a fulfilled play Promise alone does not report unconfirmed playback as success', async () => {
    const f = fixture(), video = f.add(); video.playImpl = () => Promise.resolve();
    const controller = f.mount(); let settled = false;
    const pending = controller.execute({ action: 'recover' }).then(value => { settled = true; return value; });
    await flush(); f.tick(2999); assert.equal(settled, false);
    f.tick(1); const value = await pending;
    assert.equal(value.code, 'PLAY_TIMEOUT'); assert.equal(value.ok, false);
    assert.equal(video.playCalls, 1); assert.equal(video.pauseCalls, 0); assert.equal(video.loadCalls, 0);
    assert.equal(f.clock.timers.size, 0); controller.dispose();
});

test('a slow manual play can start after the confirmation deadline without being paused', async () => {
    const f = fixture(), video = f.add();
    video.playImpl = () => {
        video.paused = false; video.readyState = 0; video.emit('waiting');
        return new Promise(resolve => f.clock.setTimeout(() => {
            video.readyState = 4; video.emit('playing'); resolve();
        }, 4500));
    };
    const controller = f.mount(), received = [];
    controller.subscribe(value => received.push(value));
    const request = controller.execute({ action: 'recover' });
    f.tick(3000); const timeout = await request;
    assert.equal(timeout.code, 'PLAY_TIMEOUT'); assert.equal(timeout.ok, false);
    assert.equal(timeout.state.playbackStatus, 'waiting'); assert.equal(timeout.state.paused, false);
    assert.equal(video.pauseCalls, 0, 'a confirmation timeout must not cancel the user request');
    f.tick(1500); await flush();
    assert.equal(controller.getState().state.playbackStatus, 'playing');
    assert.equal(received.at(-1).state.playbackStatus, 'playing');
    assert.equal(timeout.code, 'PLAY_TIMEOUT', 'the expired command must not be retroactively reported as successful');
    assert.equal(video.playCalls, 1); assert.equal(video.pauseCalls, 0); assert.equal(video.loadCalls, 0);
    controller.dispose(); assert.equal(video.pauseCalls, 0, 'completed playback does not belong to an outstanding request');
});

test('an unresolved play after timeout is still cancelled on replacement and ignores late rejection', async () => {
    const f = fixture(), old = f.add(); let reject;
    old.playImpl = () => new Promise((_, fail) => { reject = fail; });
    const controller = f.mount(), request = controller.execute({ action: 'recover' });
    f.tick(3000); assert.equal((await request).code, 'PLAY_TIMEOUT'); assert.equal(old.pauseCalls, 0);
    old.remove(); const replacement = f.add(); f.mutate(); f.tick(80);
    assert.equal(old.pauseCalls, 1); assert.equal(replacement.pauseCalls, 0);
    const id = controller.getState().state.mediaId;
    reject(Object.assign(new Error('late policy result'), { name: 'NotAllowedError' })); await flush();
    assert.equal(controller.getState().state.mediaId, id);
    assert.equal(controller.getState().state.playbackStatus, 'paused'); assert.equal(replacement.playCalls, 0);
    controller.dispose();
});

test('dispose cancels an unresolved native request even after its confirmation timed out', async () => {
    const f = fixture(), video = f.add(); let resolve;
    video.playImpl = () => new Promise(done => { resolve = done; });
    const controller = f.mount(), request = controller.execute({ action: 'recover' });
    f.tick(3000); assert.equal((await request).code, 'PLAY_TIMEOUT'); assert.equal(video.pauseCalls, 0);
    controller.dispose(); assert.equal(video.pauseCalls, 1);
    resolve(); await flush(); assert.equal(controller.getState().code, 'DISPOSED');
    assert.equal(f.clock.timers.size, 0);
});

test('late results from an expired command cannot settle a newer recovery request', async () => {
    const f = fixture(), video = f.add(), requests = [];
    video.playImpl = () => new Promise((resolve, reject) => requests.push({ resolve, reject }));
    const controller = f.mount(), first = controller.execute({ action: 'recover' });
    f.tick(3000); assert.equal((await first).code, 'PLAY_TIMEOUT');
    const second = controller.execute({ action: 'recover' });
    requests[0].reject(Object.assign(new Error('old result'), { name: 'NotAllowedError' })); await flush();
    assert.equal(controller.getState().state.recovering, true);
    assert.notEqual(controller.getState().state.playbackStatus, 'blocked');
    video.paused = false; video.emit('playing'); requests[1].resolve();
    assert.equal((await second).ok, true); assert.equal(video.pauseCalls, 0);
    controller.dispose();
});

test('a subscriber disposing during recovery notification prevents the native play call', async () => {
    const f = fixture(), video = f.add(), controller = f.mount();
    controller.subscribe(value => { if (value.state.recovering) controller.dispose(); });
    assert.equal((await controller.execute({ action: 'recover' })).code, 'DISPOSED');
    assert.equal(video.playCalls, 0); assert.equal(video.pauseCalls, 0);
    assert.equal(f.clock.timers.size, 0);
});

test('media waiting, error and real playing are exposed without auto recovery', async () => {
    const f = fixture(), video = f.add(), controller = f.mount();
    video.paused = false; video.emit('waiting'); assert.equal(controller.getState().state.playbackStatus, 'waiting');
    video.error = { code: 3 }; video.emit('error'); assert.equal(controller.getState().state.playbackStatus, 'error');
    video.error = null; video.emit('playing'); assert.equal(controller.getState().state.playbackStatus, 'playing');
    assert.equal(video.playCalls, 0); assert.equal(video.loadCalls, 0); controller.dispose();
});

test('dispose cancels an outstanding manual play and ignores its late Promise result', async () => {
    const f = fixture(), video = f.add(); let resolve;
    video.playImpl = () => new Promise(done => { resolve = done; });
    const controller = f.mount(), received = []; controller.subscribe(value => received.push(value));
    const request = controller.execute({ action: 'recover' }); controller.dispose();
    assert.equal((await request).code, 'DISPOSED');
    const count = received.length; resolve(); await flush(); video.emit('playing');
    assert.equal(received.length, count); assert.equal(video.pauseCalls, 1);
    assert.equal(video.count(), 0); assert.equal(f.clock.timers.size, 0);
    assert.equal(f.mutations[0].targets.size, 0); assert.equal(f.sizes[0].targets.size, 0);
    assert.equal((await controller.execute({ action: 'recover' })).code, 'DISPOSED');
});

test('replacement cancels recover on the old node and a late rejection cannot block the replacement', async () => {
    const f = fixture(), old = f.add(); let reject;
    old.playImpl = () => new Promise((_, fail) => { reject = fail; });
    const controller = f.mount(), request = controller.execute({ action: 'recover' });
    old.remove(); const replacement = f.add(); f.mutate(); f.tick(80);
    assert.equal((await request).code, 'MEDIA_CHANGED');
    reject(Object.assign(new Error(), { name: 'NotAllowedError' })); await flush();
    assert.equal(controller.getState().state.playbackStatus, 'paused');
    assert.equal(replacement.playCalls, 0); assert.equal(old.pauseCalls, 1);
    controller.dispose();
});

test('config keeps site and media QA paths separate and rejects hostile host lookalikes', () => {
    assert.equal(config.isSiteUrl('https://umininn-gh.github.io/tv/?x=1'), true);
    assert.equal(config.isSiteUrl('http://localhost:8767/work/extension-site-basic.html'), true);
    assert.equal(config.isSiteUrl('http://127.0.0.1:8768/work/extension-media-basic.html'), false);
    assert.equal(config.isPlayerUrl('http://127.0.0.1:8768/work/extension-media-basic.html'), true);
    assert.equal(config.isPlayerUrl('http://localhost:8767/work/extension-site-basic.html'), false);
    assert.equal(config.isPlayerUrl('https://player.kick.com/qa'), true);
    assert.equal(config.isPlayerUrl('https://player.kick.com.attacker.test/qa'), false);
    assert.equal(config.isPlayerUrl('https://user:secret@player.kick.com/qa'), false);
    assert.equal(config.isSiteUrl('https://umininn-gh.github.io/tv/channel-manager.html'), false);
});
