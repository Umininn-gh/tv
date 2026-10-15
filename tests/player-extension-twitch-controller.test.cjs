const assert = require('node:assert/strict');
const test = require('node:test');
const { createMediaController } = require('../browser-extension/shared/media-controller.js');
const { createTwitchController, isTwitchUrl } = require('../browser-extension/shared/twitch-controller.js');

class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    emit(type) { for (const fn of [...(this.listeners.get(type) || [])]) fn({ type, currentTarget: this }); }
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
        constructor(tag = 'div') {
            super(); this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
            this.style = {}; this.attributes = new Map(); this.rect = { left: 0, top: 0, width: 640, height: 360 };
            this.hidden = false; this.inert = false; this.disabled = false; this.clickCalls = 0;
        }
        get parentElement() { return this.parentNode?.tagName ? this.parentNode : null; }
        get isConnected() { return this === doc || Boolean(this.parentNode?.isConnected) || Boolean(this.host?.isConnected); }
        getRootNode() { return this.parentNode ? this.parentNode.getRootNode() : this; }
        append(node) { node.parentNode = this; this.children.push(node); return node; }
        remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
        contains(node) { return node === this || this.children.some(child => child.contains(node)); }
        setAttribute(key, value) { this.attributes.set(key, String(value)); }
        getAttribute(key) { return this.attributes.get(key) ?? null; }
        matches(selector) { return selector === ':disabled' && this.disabled; }
        querySelectorAll(selector) {
            const all = this.children.flatMap(node => [node, ...node.querySelectorAll('*')]);
            if (selector === '*') return all;
            if (selector === 'video,audio') return all.filter(node => ['VIDEO', 'AUDIO'].includes(node.tagName));
            if (selector === 'button[data-a-target]') return all.filter(node => node.tagName === 'BUTTON' && node.getAttribute('data-a-target') !== null);
            throw new Error('Unexpected selector: ' + selector);
        }
        getBoundingClientRect() { return this.rect; }
        click() { this.clickCalls++; if (this.clickError) throw this.clickError; this.onClick?.(); }
    }
    class Media extends Node {
        constructor() { super('video'); this._volume = 0.8; this._muted = true; this.paused = true; this.ended = false; this.readyState = 0; this.error = null; this.playCalls = 0; this.pauseCalls = 0; this.loadCalls = 0; }
        get volume() { return this._volume; }
        set volume(value) { this._volume = value; this.emit('volumechange'); }
        get muted() { return this._muted; }
        set muted(value) { this._muted = value; this.emit('volumechange'); }
        get src() { throw new Error('Do not read source'); }
        set src(_) { throw new Error('Do not replace source'); }
        play() { this.playCalls++; if (this.playImpl) return this.playImpl(); start(this); return Promise.resolve(); }
        pause() { this.pauseCalls++; this.paused = true; this.emit('pause'); }
        load() { this.loadCalls++; throw new Error('Do not reload'); }
    }
    const doc = new Node(); doc.tagName = undefined;
    doc.documentElement = doc.append(new Node('html'));
    doc.location = { href: 'https://player.twitch.tv/?channel=fixture&parent=localhost' };
    const mutations = [], sizes = [];
    const view = new Events();
    Object.assign(view, { parent: {}, innerWidth: 1280, innerHeight: 720, location: doc.location,
        getComputedStyle: node => ({ display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto', ...node.style }),
        MutationObserver: class { constructor(callback) { this.callback = callback; this.targets = new Set(); mutations.push(this); } observe(node) { this.targets.add(node); } disconnect() { this.targets.clear(); } },
        ResizeObserver: class { constructor(callback) { this.callback = callback; this.targets = new Set(); sizes.push(this); } observe(node) { this.targets.add(node); } unobserve(node) { this.targets.delete(node); } disconnect() { this.targets.clear(); } } });
    doc.defaultView = view;
    const addMedia = () => doc.documentElement.append(new Media());
    function addButton(target = 'player-overlay-play-button', label = 'Play', parent = doc.documentElement) {
        const button = parent.append(new Node('button'));
        button.rect = { left: 200, top: 120, width: 80, height: 50 };
        if (target !== null) button.setAttribute('data-a-target', target);
        if (label !== null) button.setAttribute('aria-label', label);
        return button;
    }
    function start(media) { media.readyState = 4; media.paused = false; media.emit('playing'); }
    function mount() {
        const native = createMediaController({ document: doc, clock });
        const controller = createTwitchController({ document: doc, mediaController: native, clock });
        return { native, controller };
    }
    return { doc, view, clock, tick, Node, mutations, sizes, addMedia, addButton, mount, start,
        mutate: () => mutations.forEach(observer => { if (observer.targets.size) observer.callback([]); }) };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('only exact HTTPS Twitch iframe uses the adapter; other origins/top frames pass through', () => {
    for (const url of ['https://player.twitch.tv.attacker.test/', 'http://player.twitch.tv/', 'https://user:secret@player.twitch.tv/', 'https://player.twitch.tv:8443/', 'https://www.twitch.tv/']) {
        assert.equal(isTwitchUrl(url), false, url);
        const f = fixture(), native = createMediaController({ document: f.doc, clock: f.clock });
        assert.equal(createTwitchController({ document: f.doc, location: url, mediaController: native, clock: f.clock }), native);
        native.dispose();
    }
    assert.equal(isTwitchUrl('https://player.twitch.tv:443/?channel=fixture'), true);
    const f = fixture(); f.view.parent = f.view;
    const native = createMediaController({ document: f.doc, clock: f.clock });
    assert.equal(createTwitchController({ document: f.doc, mediaController: native, clock: f.clock }), native);
    native.dispose();
});

test('only manual recover clicks the unique cover Play; real observed Traditional Chinese controls coexist', async () => {
    const f = fixture(), media = f.addMedia();
    const overlay = f.addButton('player-overlay-play-button', '遊玩');
    const controls = f.addButton('player-play-pause-button', '播放 (空白鍵/k)');
    overlay.onClick = () => f.start(media);
    const { controller } = f.mount();
    const states = [], unsubscribe = controller.subscribe(value => states.push(value.state));
    assert.equal(controller.getState().state.platformRecoverSupported, true);
    await controller.execute({ action: 'setVolume', value: 0.25 });
    await controller.execute({ action: 'setMuted', value: false });
    f.mutate(); f.tick(80);
    assert.equal(overlay.clickCalls + controls.clickCalls, 0);
    const result = await controller.execute({ action: 'recover' });
    assert.equal(result.ok, true); assert.equal(result.state.playbackStatus, 'playing');
    assert.equal(overlay.clickCalls, 1); assert.equal(controls.clickCalls, 0);
    assert.equal(media.playCalls, 0); assert.equal(media.pauseCalls, 0); assert.equal(media.loadCalls, 0);
    assert.equal(media.volume, 0.25); assert.equal(media.muted, false);
    assert.ok(states.some(value => value.recovering));
    unsubscribe(); controller.dispose();
});

test('cover Play can initialize media that did not exist; native playing confirms it', async () => {
    const f = fixture(), overlay = f.addButton();
    let media;
    overlay.onClick = () => { media = f.addMedia(); f.mutate(); };
    const { controller } = f.mount();
    const before = controller.getState();
    assert.equal(before.code, 'NO_MEDIA'); assert.equal(before.state.available, false);
    assert.equal(before.state.recoverSupported, true); assert.equal(before.state.platformRecoverSupported, true);
    const request = controller.execute({ action: 'recover' });
    let done = false; request.then(() => { done = true; }); await flush();
    assert.equal(done, false); assert.equal(media.playCalls, 0);
    f.tick(80); f.start(media);
    const result = await request;
    assert.equal(result.ok, true); assert.equal(result.state.available, true);
    assert.equal(media.playCalls, 0); controller.dispose();
});

test('click completion is not playback confirmation and timeout never calls pause or native play', async () => {
    const f = fixture(), media = f.addMedia(), overlay = f.addButton();
    const { controller } = f.mount();
    const request = controller.execute({ action: 'recover' });
    let done = false; request.then(() => { done = true; }); await flush();
    assert.equal(done, false);
    f.tick(2999); await flush(); assert.equal(done, false);
    f.tick(1);
    const result = await request;
    assert.equal(result.ok, false); assert.equal(result.code, 'PLAY_TIMEOUT');
    assert.equal(result.state.paused, true); assert.equal(result.state.recovering, false);
    assert.equal(overlay.clickCalls, 1); assert.equal(media.playCalls, 0); assert.equal(media.pauseCalls, 0); assert.equal(media.loadCalls, 0);
    assert.equal(f.clock.timers.size, 0); controller.dispose();
});

test('after timeout a late platform-created video still reports actual playback without more clicks', async () => {
    const f = fixture(), overlay = f.addButton();
    const { controller } = f.mount(), reports = [];
    controller.subscribe(value => reports.push(value));
    const request = controller.execute({ action: 'recover' });
    f.tick(3000);
    const timedOut = await request; assert.equal(timedOut.code, 'PLAY_TIMEOUT');
    f.tick(1500);
    const media = f.addMedia(); f.start(media); f.mutate(); f.tick(80);
    assert.equal(controller.getState().state.playbackStatus, 'playing');
    assert.equal(timedOut.code, 'PLAY_TIMEOUT');
    assert.ok(reports.some(value => value.state.playbackStatus === 'playing'));
    assert.equal(overlay.clickCalls, 1); assert.equal(media.playCalls, 0); assert.equal(media.pauseCalls, 0);
    controller.dispose();
});

test('clear toolbar Play is used once when no cover control exists, including keyboard hints', async () => {
    for (const label of [' Play (K) ', 'play ( space / k )', '播放（空白鍵/k）', '播放 (空格键 / k)', '播放', 'Play']) {
        const f = fixture(), media = f.addMedia(), button = f.addButton('player-play-pause-button', label);
        button.onClick = () => f.start(media);
        const { controller } = f.mount();
        assert.equal((await controller.execute({ action: 'recover' })).ok, true, label);
        assert.equal(button.clickCalls, 1, label); assert.equal(media.playCalls, 0, label);
        controller.dispose();
    }
});

test('unknown labels, Pause controls, generic Play buttons and conflicting labels never get clicked', async () => {
    for (const [target, label, title] of [
        ['player-play-pause-button', 'Pause (k)'], ['player-play-pause-button', '暫停 (空白鍵/k)'],
        ['player-play-pause-button', 'Play / Pause'], ['player-overlay-play-button', 'Replay'],
        ['player-overlay-play-button', 'Play advertisement'], [null, 'Play'], ['unrelated-play', 'Play'],
        ['player-play-pause-button', null], ['player-play-pause-button', 'Play', 'Pause'],
        ['player-play-pause-button', '遊玩']
    ]) {
        const f = fixture(), media = f.addMedia(), button = f.addButton(target, label);
        if (title) button.setAttribute('title', title);
        const { controller } = f.mount();
        assert.equal(controller.getState().state.platformRecoverSupported, false, String(label));
        assert.equal((await controller.execute({ action: 'recover' })).ok, true);
        assert.equal(button.clickCalls, 0, String(label)); assert.equal(media.playCalls, 1);
        assert.equal(media.pauseCalls, 0); controller.dispose();
    }
});

test('title-only explicit Play is accepted but unrelated visible buttons are ignored', async () => {
    const f = fixture(), media = f.addMedia();
    const button = f.addButton('player-play-pause-button', null); button.setAttribute('title', 'Play (space)');
    const unrelated = f.addButton(null, 'Play');
    button.onClick = () => f.start(media);
    const { controller } = f.mount();
    assert.equal((await controller.execute({ action: 'recover' })).ok, true);
    assert.equal(button.clickCalls, 1); assert.equal(unrelated.clickCalls, 0); controller.dispose();
});

test('hidden, disabled, inert, clipped, offscreen and covered controls use safe native fallback', async () => {
    const alterations = [
        (f, button) => { button.hidden = true; },
        (f, button) => { button.disabled = true; },
        (f, button) => button.setAttribute('aria-disabled', 'true'),
        (f, button) => { button.inert = true; },
        (f, button) => { button.style.opacity = '0'; },
        (f, button) => { button.style.pointerEvents = 'none'; },
        (f, button) => { button.rect.left = 2000; },
        (f, button) => { const clip = f.doc.documentElement.append(new f.Node()); clip.rect.width = 0; clip.style.overflow = 'hidden'; button.remove(); clip.append(button); },
        (f, button) => { f.doc.elementFromPoint = () => f.doc.documentElement; }
    ];
    for (const alter of alterations) {
        const f = fixture(), media = f.addMedia(), button = f.addButton(); alter(f, button);
        const { controller } = f.mount();
        assert.equal((await controller.execute({ action: 'recover' })).ok, true);
        assert.equal(button.clickCalls, 0); assert.equal(media.playCalls, 1); assert.equal(media.pauseCalls, 0);
        controller.dispose();
    }
});

test('a hit on a Play button child counts as visible', async () => {
    const f = fixture(), media = f.addMedia(), button = f.addButton();
    const icon = button.append(new f.Node('span')); f.doc.elementFromPoint = () => icon;
    button.onClick = () => f.start(media);
    const { controller } = f.mount();
    assert.equal((await controller.execute({ action: 'recover' })).ok, true);
    assert.equal(button.clickCalls, 1); controller.dispose();
});

test('multiple cover Plays or multiple toolbar Plays are ambiguous, so none are clicked', async () => {
    for (const target of ['player-overlay-play-button', 'player-play-pause-button']) {
        const f = fixture(), media = f.addMedia(), first = f.addButton(target), second = f.addButton(target);
        const { controller } = f.mount();
        assert.equal(controller.getState().state.platformRecoverSupported, false);
        assert.equal((await controller.execute({ action: 'recover' })).ok, true);
        assert.equal(first.clickCalls + second.clickCalls, 0); assert.equal(media.playCalls, 1);
        controller.dispose();
    }
});

test('simultaneous manual recover requests share one platform click and confirmation', async () => {
    const f = fixture(), media = f.addMedia(), button = f.addButton();
    const { controller } = f.mount();
    const one = controller.execute({ action: 'recover' }), two = controller.execute({ action: 'recover' });
    assert.equal(button.clickCalls, 1); f.start(media);
    assert.equal((await one).ok, true); assert.equal((await two).ok, true);
    assert.equal(f.clock.timers.size, 0); controller.dispose();
});

test('already-playing native state never clicks a stale cover Play', async () => {
    const f = fixture(), media = f.addMedia(), button = f.addButton(); f.start(media);
    const { controller } = f.mount();
    assert.equal((await controller.execute({ action: 'recover' })).ok, true);
    assert.equal(button.clickCalls, 0); assert.equal(media.playCalls, 0); controller.dispose();
});

test('Play is revalidated after subscribers: a slow start changing it to Pause is never toggled', async () => {
    const f = fixture(), media = f.addMedia(), button = f.addButton('player-play-pause-button');
    const { controller } = f.mount(); let changed = false;
    controller.subscribe(value => {
        if (value.state.recovering && !changed) {
            changed = true; button.setAttribute('aria-label', 'Pause (k)'); f.start(media);
        }
    });
    assert.equal((await controller.execute({ action: 'recover' })).ok, true);
    assert.equal(button.clickCalls, 0); assert.equal(media.playCalls, 0); controller.dispose();
});

test('platform may replace an empty media node while starting; confirmation follows replacement', async () => {
    const f = fixture(), old = f.addMedia(), button = f.addButton(); let replacement;
    button.onClick = () => { old.remove(); replacement = f.addMedia(); f.mutate(); };
    const { controller } = f.mount();
    const request = controller.execute({ action: 'recover' });
    f.tick(80); f.start(replacement);
    const result = await request;
    assert.equal(result.ok, true); assert.equal(result.state.mediaId, 2);
    assert.equal(old.pauseCalls, 0); assert.equal(old.playCalls, 0); assert.equal(replacement.playCalls, 0);
    controller.dispose();
});

test('button capability changes notify without polling or automatic playback', () => {
    const f = fixture(), { controller } = f.mount(), reports = [];
    controller.subscribe(value => reports.push(value));
    assert.equal(f.clock.timers.size, 0);
    const button = f.addButton(); f.mutate(); f.tick(80);
    assert.equal(reports.at(-1).state.platformRecoverSupported, true);
    button.setAttribute('aria-label', 'Pause'); f.mutate(); f.tick(80);
    assert.equal(reports.at(-1).state.platformRecoverSupported, false);
    f.tick(100000); assert.equal(button.clickCalls, 0); assert.equal(f.clock.timers.size, 0);
    controller.dispose();
});

test('no media and no trustworthy Play stays unsupported; click failure is honest with no extra play', async () => {
    const f = fixture(), { controller } = f.mount();
    assert.equal((await controller.execute({ action: 'recover' })).code, 'NO_MEDIA');
    assert.equal(controller.getState().state.recoverSupported, false);
    const button = f.addButton(); button.clickError = new Error('platform rejected click');
    const result = await controller.execute({ action: 'recover' });
    assert.equal(result.ok, false); assert.equal(result.code, 'CONTROL_FAILED');
    assert.equal(button.clickCalls, 1); assert.equal(f.clock.timers.size, 0); controller.dispose();
});

test('native fallback timeout never triggers a later platform click or pause', async () => {
    const f = fixture(), media = f.addMedia(); media.playImpl = () => new Promise(() => {});
    const { controller } = f.mount();
    const request = controller.execute({ action: 'recover' }); await flush();
    const button = f.addButton(); f.mutate(); f.tick(3000);
    assert.equal((await request).code, 'PLAY_TIMEOUT');
    assert.equal(button.clickCalls, 0); assert.equal(media.playCalls, 1); assert.equal(media.pauseCalls, 0);
    f.tick(1500); f.start(media);
    assert.equal(controller.getState().state.playbackStatus, 'playing'); assert.equal(button.clickCalls, 0);
    controller.dispose();
});

test('dispose resolves platform confirmation and clears timers/listeners; late playing does nothing', async () => {
    const f = fixture(), media = f.addMedia(), button = f.addButton();
    const { controller } = f.mount(), reports = [];
    controller.subscribe(value => reports.push(value));
    const request = controller.execute({ action: 'recover' }); f.mutate();
    controller.dispose();
    assert.equal((await request).code, 'DISPOSED'); assert.equal(f.clock.timers.size, 0);
    const count = reports.length; f.start(media); f.mutate(); f.tick(10000);
    assert.equal(reports.length, count); assert.equal(button.clickCalls, 1); assert.equal(media.pauseCalls, 0);
    assert.ok(f.mutations.every(observer => observer.targets.size === 0));
    assert.equal((await controller.execute({ action: 'recover' })).code, 'DISPOSED');
    assert.equal(controller.getState().state.disposed, true);
});

test('subscriber disposal before platform click prevents any playback side effect', async () => {
    const f = fixture(), media = f.addMedia(), button = f.addButton();
    const { controller } = f.mount();
    controller.subscribe(value => { if (value.state.recovering) controller.dispose(); });
    assert.equal((await controller.execute({ action: 'recover' })).code, 'DISPOSED');
    assert.equal(button.clickCalls, 0); assert.equal(media.playCalls, 0); assert.equal(f.clock.timers.size, 0);
});
