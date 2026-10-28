const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { aggregateAudio, validResult, isManagedPlayerSlot, canControl, confirmedSilentPeer, retainedGuardResult, renderAudioControls, unifiedFocusFailures,
    isWatchStartTarget, isRecoveryReady, createAudioFocusFlow } = require('../browser-extension/site-ui.js');
const { createMediaController } = require('../browser-extension/shared/media-controller.js');

function managedSlotScanFixture() {
    const clock = { next: 0, timers: new Map(), setTimeout(fn) { const id = ++this.next; this.timers.set(id, fn); return id; }, clearTimeout(id) { this.timers.delete(id); } };
    class Node extends EventTarget {
        constructor(tag = 'div', attributes = {}) { super(); this.tagName = tag.toUpperCase(); this.attributes = new Map(Object.entries(attributes));
            this.children = []; this.parentElement = null; this.isConnected = true; this.hidden = false; }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        matches(selector) { return selector.split(',').some(tag => tag.toUpperCase() === this.tagName); }
        append(node) { node.parentElement = this; this.children.push(node); return node; }
        querySelectorAll(selector) { const nodes = this.children.flatMap(node => [node, ...node.querySelectorAll('*')]);
            return selector === '*' ? nodes : nodes.filter(node => node.matches(selector)); }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 360 }; }
        getRootNode() { return this.parentElement ? this.parentElement.getRootNode() : this; }
    }
    class Media extends Node {
        constructor() { super('audio'); this.hidden = true; this._muted = false; this.volume = .62;
            this.paused = false; this.readyState = 4; this.ended = false; this.playCalls = 0; }
        get muted() { return this._muted; }
        set muted(value) { this._muted = value; this.dispatchEvent(new Event('volumechange')); }
        play() { this.playCalls++; throw new Error('the managed slot controller must not start media'); }
    }
    const view = new EventTarget(), container = new Node(), doc = new EventTarget(), entries = new Map(), created = [];
    Object.assign(view, { innerWidth: 1280, innerHeight: 720, setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock),
        getComputedStyle() { return { display: 'block', visibility: 'visible', opacity: '1' }; },
        MutationObserver: class { observe() {} takeRecords() { return []; } disconnect() {} } });
    Object.assign(doc, { defaultView: view, documentElement: { clientWidth: 1280, clientHeight: 720 },
        getElementById(id) { return id === 'multi-stream-container' ? container : null; } });
    const state = { scanTimer: null, disposed: false, list: {}, doc, entries, sequence: 0, isManagedPlayerSlot,
        cfg: { isPlayerUrl(url) { return url.startsWith('https://player.kick.com/'); } },
        factory: { createMediaController(options) { created.push(options); return createMediaController({ ...options, clock }); } },
        addRow(entry) { entry.name = {}; entry.row = { style: {} }; entry.volume = { setAttribute() {} }; },
        applyResult(entry, result) { entry.result = result; }, globalMuted: null, audioFocusIntent: null, layoutTicket: null,
        removeEntry(entry) { entry.unsubscribe?.(); entry.controller?.dispose(); entries.delete(entry.element); },
        currentEntries() { return [...entries.values()]; }, revealOrder: '', revealedEntry: null,
        describe(entry) { return entry.element.getAttribute('data-channel-name') || 'unknown'; },
        renderEntry() {}, refreshSummary() {}, updateHighlights() {}, scheduleHighlights() {}, queueAudioFocusReconcile() {},
        layoutAudioFlow: null, scheduleProbe() {} };
    const source = fs.readFileSync(require.resolve('../browser-extension/site-ui.js'), 'utf8');
    const start = source.indexOf('        function scan() {'), end = source.indexOf('\n        function queueScan()', start);
    assert.ok(start > 0 && end > start, 'production scan seam must exist');
    const scan = vm.runInNewContext('(' + source.slice(start, end).trim() + ')', state);
    const slot = (attributes = {}) => container.append(new Node('div', { 'data-umininn-player-slot': '1', 'data-channel-key': 'm3u8|managed', ...attributes }));
    return { Node, Media, container, doc, clock, entries, created, scan, slot,
        dispose() { for (const entry of [...entries.values()]) state.removeEntry(entry); assert.equal(clock.timers.size, 0); } };
}

test('only explicitly managed channel slots can join the native controller without media', () => {
    const f = managedSlotScanFixture(), known = f.slot();
    const unknown = f.container.append(new f.Node('div', { 'data-channel-key': 'm3u8|unknown', 'data-umininn-player-placeholder': 'error' }));
    unknown.textContent = '⚠️ 無法播放直播，請再試一次';
    const keyless = f.slot({ 'data-channel-key': '' }), whitespace = f.slot({ 'data-channel-key': '  ' });
    assert.equal(isManagedPlayerSlot(known), true);
    for (const element of [null, {}, unknown, keyless, whitespace,
        ...['0', 'true', '01', '2', 1].map(value => f.slot({ 'data-umininn-player-slot': value }))]) assert.equal(isManagedPlayerSlot(element), false);
    f.scan();
    assert.deepEqual([...f.entries.keys()], [known]); assert.equal(f.created.length, 1);
    assert.equal(f.created[0].scope, known); assert.equal(f.created[0].document, f.doc);
    f.dispose();
});

test('managed loading and status slots use a real observed controller without relying on error text or presentation markers', async () => {
    for (const presentation of [null, 'loading', 'status', 'error']) {
        const f = managedSlotScanFixture(), known = f.slot(); known.textContent = 'Preparing channel';
        if (presentation) known.attributes.set('data-umininn-player-placeholder', presentation);
        f.scan(); const entry = f.entries.get(known);
        assert.equal(entry.kind, 'native'); assert.equal(entry.result.code, 'NO_MEDIA');
        assert.equal(entry.result.state.emptyGuardConfirmed, false, 'metadata alone does not prove silence');
        const result = await entry.controller.execute({ action: 'setMuted', value: true, guard: true });
        assert.equal(result.code, 'NO_MEDIA'); assert.equal(result.state.emptyGuardConfirmed, true);
        assert.equal(result.state.muted, null); assert.equal(result.state.volume, null);
        entry.result = result;
        for (const action of ['setMuted', 'setVolume', 'recover']) assert.equal(canControl(entry, action), false);
        f.dispose();
    }
});

test('managed slots must really mute hidden or later media rather than receiving static empty proof', async () => {
    for (const late of [false, true]) {
        const f = managedSlotScanFixture(), known = f.slot(), audio = new f.Media();
        if (!late) known.append(audio);
        f.scan(); const entry = f.entries.get(known);
        await entry.controller.execute({ action: 'setMuted', value: true, guard: true });
        if (late) known.append(audio);
        const result = entry.controller.getState();
        assert.equal(audio.muted, true); assert.equal(audio.volume, .62); assert.equal(audio.playCalls, 0);
        assert.equal(result.code, 'NO_MEDIA'); assert.equal(result.state.emptyGuardConfirmed, false);
        assert.equal(result.state.muted, true); assert.equal(result.state.muteGuardActive, true);
        f.dispose();
    }
});

test('managed slot metadata cannot bypass an unknown iframe or make its parent an empty native controller', () => {
    const f = managedSlotScanFixture(), known = f.slot(), frame = known.append(new f.Node('iframe'));
    frame.src = 'https://opaque.invalid/player'; f.scan();
    const entry = f.entries.get(known);
    assert.equal(entry.kind, 'unsupported'); assert.equal(entry.frame, frame); assert.equal(f.created.length, 0);
    assert.equal(canControl(entry, 'setMuted'), false); assert.equal(canControl(entry, 'setVolume'), false);
    f.dispose();
});

test('losing managed slot ownership metadata disposes the previous controller instead of retaining its silence proof', async () => {
    for (const attribute of ['data-channel-key', 'data-umininn-player-slot']) {
        const f = managedSlotScanFixture(), known = f.slot(); f.scan(); const old = f.entries.get(known).controller;
        await old.execute({ action: 'setMuted', value: true, guard: true });
        known.attributes.delete(attribute); f.scan();
        assert.equal(f.entries.size, 0); assert.equal(old.getState().code, 'DISPOSED');
        f.dispose();
    }
});

test('changing presentation markers does not replace a managed slot controller or invent a new silence policy', async () => {
    const f = managedSlotScanFixture(), known = f.slot({ 'data-umininn-player-placeholder': 'loading' });
    f.scan(); const old = f.entries.get(known).controller;
    await old.execute({ action: 'setMuted', value: true, guard: true });
    for (const presentation of ['status', 'error', null]) {
        if (presentation) known.attributes.set('data-umininn-player-placeholder', presentation);
        else known.attributes.delete('data-umininn-player-placeholder');
        f.scan(); assert.equal(f.entries.get(known).controller, old);
        assert.equal(old.getState().state.emptyGuardConfirmed, true);
    }
    f.dispose();
});

function audioControlFixture(state) {
    const control = () => ({ value: '100', textContent: '', disabled: false, attributes: new Map(),
        setAttribute(key, value) { this.attributes.set(key, String(value)); },
        getAttribute(key) { return this.attributes.get(key) ?? null; } });
    const entry = { kind: 'frame', target: { frameId: 4 }, busy: false,
        volume: control(), level: control(), mute: control(), recover: control(), result: { ok: true, code: 'OK', state } };
    return { entry, render(next = state, activeElement) { entry.result.state = next; renderAudioControls(entry, next, activeElement); } };
}

test('unavailable sound never appears unmuted or retains a previously confirmed slider level', () => {
    const f = audioControlFixture({ muted: false, volume: 1, available: true });
    f.render(); assert.equal(f.entry.volume.value, '100'); assert.equal(f.entry.mute.getAttribute('aria-pressed'), 'false');
    f.entry.result.code = 'NO_MEDIA';
    f.render({ available: false, playbackStatus: 'no-media', volume: null, muted: null,
        volumeSupported: false, muteSupported: false, muteGuardActive: true, emptyGuardConfirmed: true });
    assert.equal(f.entry.volume.value, '0', 'a disabled placeholder must not claim the old 100% is current');
    assert.equal(f.entry.volume.getAttribute('aria-valuetext'), '未知'); assert.equal(f.entry.level.textContent, '—');
    assert.equal(f.entry.volume.disabled, true); assert.equal(f.entry.mute.textContent, '狀態未知');
    assert.equal(f.entry.mute.getAttribute('aria-pressed'), 'mixed'); assert.equal(f.entry.mute.disabled, true);
    f.entry.result.code = 'OK';
    f.render({ available: true, volume: .37, muted: true, volumeSupported: true, muteSupported: true });
    assert.equal(f.entry.volume.value, '37'); assert.equal(f.entry.level.textContent, '37%');
    assert.equal(f.entry.volume.getAttribute('aria-valuetext'), '37%'); assert.equal(f.entry.volume.disabled, false);
    assert.equal(f.entry.mute.textContent, '開聲'); assert.equal(f.entry.mute.getAttribute('aria-pressed'), 'true');
    assert.equal(f.entry.mute.disabled, false);
});

test('missing, unsupported and malformed sound values remain independently unknown and disabled', () => {
    for (const volume of [undefined, null, NaN, Infinity, -1, 1.01, '1']) {
        const f = audioControlFixture({ muted: true, volume }); f.render();
        assert.equal(f.entry.volume.disabled, true); assert.equal(f.entry.level.textContent, '—');
        assert.equal(f.entry.volume.getAttribute('aria-valuetext'), '未知');
        assert.equal(f.entry.mute.disabled, false, 'a known mute state remains controllable even when volume is unknown');
    }
    for (const muted of [undefined, null, 0, 1, 'false']) {
        const f = audioControlFixture({ muted, volume: .5 }); f.render();
        assert.equal(f.entry.mute.disabled, true); assert.equal(f.entry.mute.textContent, '狀態未知');
        assert.equal(f.entry.mute.getAttribute('aria-pressed'), 'mixed'); assert.equal(f.entry.volume.disabled, false);
    }
    const f = audioControlFixture(null); f.render();
    assert.equal(f.entry.volume.disabled, true); assert.equal(f.entry.mute.disabled, true);
    assert.equal(f.entry.recover.disabled, true);
});

test('zero volume and false mute stay real values while an active slider keeps its uncommitted input', () => {
    const f = audioControlFixture({ muted: false, volume: 0 }); f.render();
    assert.equal(f.entry.volume.disabled, false); assert.equal(f.entry.level.textContent, '0%');
    assert.equal(f.entry.volume.getAttribute('aria-valuetext'), '0%');
    assert.equal(f.entry.mute.textContent, '靜音'); assert.equal(f.entry.mute.getAttribute('aria-pressed'), 'false');
    f.entry.volume.value = '57'; f.render({ muted: false, volume: .2 }, f.entry.volume);
    assert.equal(f.entry.volume.value, '57', 'a live report cannot move a slider currently being adjusted');
    f.entry.busy = true; f.render({ muted: false, volume: .2 });
    assert.equal(f.entry.volume.disabled, true); assert.equal(f.entry.mute.disabled, true);
});

test('an empty guard only qualifies as peer silence when the current authenticated state explicitly confirms it', () => {
    const empty = { available: false, muteGuardActive: true, emptyGuardConfirmed: true, muteSupported: false,
        volumeSupported: false, muted: null, volume: null };
    assert.equal(confirmedSilentPeer(empty), true);
    assert.equal(confirmedSilentPeer({ ...empty, muted: undefined, volume: undefined }), true);
    assert.equal(confirmedSilentPeer({ available: true, muted: true, muteGuardActive: true }), true);
    for (const state of [null, {}, { available: false },
        { available: false, muteGuardActive: true }, { available: false, emptyGuardConfirmed: true },
        { available: false, muteGuardActive: false, emptyGuardConfirmed: true },
        { ...empty, muted: false }, { ...empty, volume: 1 }, { ...empty, volume: 0 },
        { ...empty, muteSupported: true }, { ...empty, muteSupported: undefined },
        { available: true, muted: false, muteGuardActive: true, emptyGuardConfirmed: true },
        { available: true, muted: true, muteGuardActive: false },
        { muted: null, muteGuardActive: true, emptyGuardConfirmed: 'true' }]) assert.equal(confirmedSilentPeer(state), false);
    const f = audioControlFixture({ available: false, playbackStatus: 'no-media', muteGuardActive: true, emptyGuardConfirmed: true,
        muted: null, volume: null, recoverSupported: true, platformRecoverSupported: true }); f.render();
    assert.equal(f.entry.mute.disabled, true); assert.equal(f.entry.volume.disabled, true);
    assert.equal(f.entry.recover.disabled, false, 'peer-only safety cannot disable a supported platform Play');
});

function automaticGuardFixture(result) {
    // Exercise the real execute shortcut and its surrounding budget checks
    // without mounting unrelated controls or constructing a browser document.
    const source = fs.readFileSync(require.resolve('../browser-extension/site-ui.js'), 'utf8');
    const start = source.indexOf('        async function execute(entry, command, settings = {}) {');
    const end = source.indexOf('\n        async function applyAll(', start);
    assert.ok(start > 0 && end > start, 'production command seam must exist');
    const entry = { kind: 'native', element: {}, generation: 7, busy: false, guardInFlight: false, result };
    const writes = new Map([[entry, { generation: 7, count: 4 }]]), guarded = new Map();
    const intent = { automatic: true, guardWrites: writes, repairs: 4 };
    const state = { entries: new Map([[entry.element, entry]]), disposed: false,
        audioFocusIntent: intent, guardedEntries: guarded,
        retainedGuardResult, can() { throw new Error('guard must not consult opening capabilities'); },
        renderEntry() { throw new Error('retaining a guard must not start another command'); } };
    const execute = vm.runInNewContext('(' + source.slice(start, end).trim() + ')', state);
    return { entry, writes, guarded, intent, execute: () => execute(entry, { action: 'setMuted', value: true, guard: true }) };
}

function retiredEntryFixture() {
    const pane = {}, live = { element: { isConnected: true, parentElement: pane }, generation: 9 };
    const intent = { guardWrites: new Map([[live, { generation: 9, count: 4 }]]) };
    const fallback = { guardWrites: new Map([[live, { generation: 9, count: 3 }]]) };
    const state = { revealedEntry: null, entries: new Map([[live.element, live]]), guardedEntries: new Map(),
        preparedCohort: new Set([live.element]), audioFocusIntent: intent, layoutFocusCandidates: new Map([[1, fallback], [2, intent]]),
        doc: { getElementById() { return pane; } }, clearProbeTimers(entry) { entry.probeTimers = []; } };
    const source = fs.readFileSync(require.resolve('../browser-extension/site-ui.js'), 'utf8');
    const start = source.indexOf('        function removeEntry(entry) {'), end = source.indexOf('\n        function scan()', start);
    assert.ok(start > 0 && end > start, 'production entry retirement seam must exist');
    const removeEntry = vm.runInNewContext('(' + source.slice(start, end).trim() + ')', state);
    return { state, pane, live, intent, fallback, removeEntry };
}

test('retiring many players releases retained guard bookkeeping without resetting a live player budget', () => {
    const f = retiredEntryFixture(); let disposed = 0, unsubscribed = 0;
    const liveWrite = f.intent.guardWrites.get(f.live), fallbackWrite = f.fallback.guardWrites.get(f.live);
    for (let i = 0; i < 200; i++) {
        const entry = { element: { isConnected: false, parentElement: f.pane }, generation: i, probeTimers: [i],
            controller: { dispose() { disposed++; } }, unsubscribe() { unsubscribed++; } };
        f.state.entries.set(entry.element, entry); f.state.guardedEntries.set(entry, i);
        f.state.preparedCohort.add(entry.element);
        for (const intent of [f.intent, f.fallback]) intent.guardWrites.set(entry, { generation: i, count: 4 });
        f.removeEntry(entry);
        assert.equal(f.state.entries.has(entry.element), false); assert.equal(f.state.guardedEntries.has(entry), false);
        assert.equal(f.state.preparedCohort.has(entry.element), false);
    }
    assert.equal(disposed, 200); assert.equal(unsubscribed, 200);
    assert.equal(f.intent.guardWrites.size, 1); assert.equal(f.fallback.guardWrites.size, 1);
    assert.equal(f.intent.guardWrites.get(f.live), liveWrite); assert.equal(liveWrite.count, 4);
    assert.equal(f.fallback.guardWrites.get(f.live), fallbackWrite); assert.equal(fallbackWrite.count, 3);
});

test('retiring a controller keeps its connected slot in recovery until replacement is ready', () => {
    const f = retiredEntryFixture();
    f.removeEntry(f.live);
    assert.equal(f.state.entries.has(f.live.element), false);
    assert.equal(f.state.preparedCohort.has(f.live.element), true, 'a source/frame replacement keeps the same pending layout slot');
    const elsewhere = { element: { isConnected: true, parentElement: {} }, generation: 0 };
    f.state.preparedCohort.add(elsewhere.element); f.removeEntry(elsewhere);
    assert.equal(f.state.preparedCohort.has(elsewhere.element), false, 'a slot moved out of the player pane cannot remain retained');
});

function recoveryLifetimeFixture() {
    const makeDeferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
    const runs = [], restore = makeDeferred();
    const state = { disposed: false, recoveryStartGeneration: 0, preparedCohort: new Set([{}]),
        automaticRecoveryReason: 'start', layoutTicket: 42, layoutUserEpoch: 3, layoutCompletion: Promise.resolve(),
        recoveryFlow: { run() { const run = makeDeferred(); runs.push(run); return run.promise; } },
        layoutAudioFlow: { restore() { return restore.promise; } }, afterAudioFocus(action) { return action(); },
        watchStartTimer: null, win: { clearTimeout() { assert.fail('no watch timer should exist'); } } };
    const source = fs.readFileSync(require.resolve('../browser-extension/site-ui.js'), 'utf8');
    const start = source.indexOf('        async function runRecovery(reason, generation = ++recoveryStartGeneration) {');
    const end = source.indexOf('\n        function scheduleRecoveryAfterLayout(', start);
    assert.ok(start > 0 && end > start, 'production recovery lifetime seam must exist');
    const api = vm.runInNewContext(source.slice(start, end) + '\n({ runRecovery, cancelPendingRecovery })', state);
    return { state, runs, restore, ...api };
}

test('a recovery retains its cohort through media checks and audio restoration then releases it', async () => {
    const f = recoveryLifetimeFixture(), pending = f.runRecovery('start');
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.runs.length, 1);
    assert.equal(f.state.preparedCohort.size, 1);
    f.runs[0].resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.state.preparedCohort.size, 1, 'audio restoration still belongs to this recovery');
    f.restore.resolve(); await pending;
    assert.equal(f.state.preparedCohort.size, 0); assert.equal(f.state.automaticRecoveryReason, null);
});

test('cancelled or obsolete recovery completion cannot retain old nodes or clear a newer cohort', async () => {
    const f = recoveryLifetimeFixture(), first = f.runRecovery('manual');
    assert.equal(f.runs.length, 1); f.cancelPendingRecovery(); assert.equal(f.state.preparedCohort.size, 0);
    const replacement = {}; f.state.preparedCohort = new Set([replacement]);
    const second = f.runRecovery('manual'); assert.equal(f.runs.length, 2);
    f.runs[0].resolve(); await first;
    assert.equal(f.state.preparedCohort.has(replacement), true, 'the old generation cannot release new recovery data');
    f.runs[1].resolve(); await second; assert.equal(f.state.preparedCohort.size, 0);
});

test('failed media recovery also releases its completed generation cohort', async () => {
    const f = recoveryLifetimeFixture(); f.state.recoveryFlow.run = () => Promise.reject(new Error('player failure'));
    await assert.rejects(f.runRecovery('manual'), /player failure/);
    assert.equal(f.state.preparedCohort.size, 0);
});

test('automatic guard retains an empty NO_MEDIA acknowledgement without rearming an exhausted guard budget', async () => {
    const result = { ok: false, code: 'NO_MEDIA', state: { available: false, muted: null, volume: null,
        muteSupported: false, volumeSupported: false, muteGuardActive: true, emptyGuardConfirmed: true } };
    const f = automaticGuardFixture(result), previous = f.writes.get(f.entry);
    const ack = await f.execute();
    assert.equal(ack.ok, false); assert.equal(ack.code, 'NO_MEDIA');
    assert.deepEqual(ack.state, result.state); assert.notEqual(ack.state, result.state);
    assert.equal(ack.state.muted, null); assert.equal(ack.state.volume, null);
    assert.equal(f.writes.get(f.entry), previous); assert.equal(previous.count, 4);
    assert.equal(f.intent.repairs, 4);
    assert.equal(f.guarded.get(f.entry), 7);
    assert.equal(f.entry.busy, false); assert.equal(f.entry.guardInFlight, false);
});

test('automatic guard acknowledges real mute while rejecting opaque, unproven and contradictory empty reports', async () => {
    const empty = { available: false, muted: null, volume: null, muteSupported: false,
        muteGuardActive: true, emptyGuardConfirmed: true };
    const cases = [
        { code: 'OK', state: { available: true, muted: true, volume: .4, muteGuardActive: true }, expected: 'OK', ok: true },
        { code: 'NO_MEDIA', state: { ...empty, muted: true, muteSupported: true }, expected: 'OK', ok: true },
        ...[false, undefined, 'true'].map(emptyGuardConfirmed => ({ code: 'NO_MEDIA',
            state: { ...empty, emptyGuardConfirmed }, expected: 'NOT_APPLIED', ok: false })),
        ...[{ muted: false }, { volume: 0 }, { available: true }, { muteSupported: true }].map(change => ({ code: 'NO_MEDIA',
            state: { ...empty, ...change }, expected: 'NOT_APPLIED', ok: false })),
        ...['ERROR', 'NOT_APPLIED', 'OK', 'no_media'].map(code => ({ code, state: empty, expected: 'NOT_APPLIED', ok: false }))
    ];
    for (const value of cases) {
        const f = automaticGuardFixture({ ok: false, code: value.code, state: value.state });
        const ack = await f.execute();
        assert.equal(ack.code, value.expected, JSON.stringify(value)); assert.equal(ack.ok, value.ok);
        assert.deepEqual(ack.state, value.state); assert.equal(f.writes.get(f.entry).count, 4);
        assert.equal(f.entry.busy, false); assert.equal(f.entry.guardInFlight, false);
    }
});

test('retaining a live, empty, invalidated then live guard never spends another automatic write attempt', async () => {
    const f = automaticGuardFixture(null), previous = f.writes.get(f.entry);
    const empty = { available: false, muted: null, volume: null, muteSupported: false,
        muteGuardActive: true, emptyGuardConfirmed: true };
    const sequence = [
        { code: 'OK', state: { available: true, muted: true, volume: .4, muteGuardActive: true } },
        { code: 'NO_MEDIA', state: empty },
        { code: 'NO_MEDIA', state: { ...empty, emptyGuardConfirmed: false } },
        { code: 'NO_MEDIA', state: empty },
        { code: 'OK', state: { available: true, muted: true, volume: .9, muteGuardActive: true } }
    ];
    const codes = [];
    for (const result of sequence) { f.entry.result = { ok: result.code === 'OK', ...result }; codes.push((await f.execute()).code); }
    assert.deepEqual(codes, ['OK', 'NO_MEDIA', 'NOT_APPLIED', 'NO_MEDIA', 'OK']);
    assert.equal(f.writes.get(f.entry), previous); assert.equal(previous.count, 4);
    assert.equal(f.intent.repairs, 4);
    assert.equal(f.guarded.get(f.entry), 7);
});

function unifiedReconcileFixture() {
    const source = fs.readFileSync(require.resolve('../browser-extension/site-ui.js'), 'utf8');
    const seam = (startText, endText) => {
        const start = source.indexOf(startText), end = source.indexOf(endText, start);
        assert.ok(start > 0 && end > start, 'production reconciliation seam must exist');
        return '(' + source.slice(start, end).trim() + ')';
    };
    const pane = {}, target = { isConnected: true, parentElement: pane }, peer = {};
    const entry = { generation: 1 }, intent = { unified: true, committed: true, target, entry, generation: 1,
        holding: false, running: false, focused: false, repairs: 0, ticket: 11, lastFingerprint: 'before' };
    const f = { intent, entry, target, peer, timers: [], restores: [], statuses: [], notifications: 0, fingerprint: 'changed',
        cohort: [{ key: target, state: { available: true, muted: true, muteGuardActive: true } },
            { key: peer, state: { available: false, muted: null, volume: null, muteSupported: false,
                muteGuardActive: true, emptyGuardConfirmed: false } }],
        completesFocused: false };
    const state = { disposed: false, audioFocusIntent: intent, audioReconcileTimer: null,
        doc: { getElementById: () => pane }, entries: new Map([[target, entry]]),
        win: { setTimeout(callback) { f.timers.push(callback); return f.timers.length; } },
        confirmedSilentPeer, audioFingerprint: () => f.fingerprint, audioFocusSnapshot: () => f.cohort,
        layoutAudioFlow: { notify() { f.notifications++; } },
        clearAudioIntent() { f.cleared = true; state.audioFocusIntent = null; },
        showAudioFocusStatus(value) { f.statuses.push(value); },
        restoreUnifiedFocus(value, ticket) {
            f.restores.push({ intent: value, ticket, repairs: value.repairs, fingerprint: f.fingerprint });
            value.holding = true; value.running = true;
            f.queue(); // getState/applyResult during the real restore marks dirty.
            value.running = false; value.holding = false; value.focused = f.completesFocused;
            value.lastFingerprint = f.fingerprint;
            f.queue(); // The production restore schedules its retained follow-up.
        } };
    state.validUnifiedTarget = vm.runInNewContext(seam('        function validUnifiedTarget(', '\n        function finishAudioRefresh('), state);
    f.queue = vm.runInNewContext(seam('        function queueAudioFocusReconcile(', '\n        function muteImmediately('), state);
    f.run = () => { let limit = 20; while (f.timers.length && limit--) f.timers.shift()();
        assert.ok(limit >= 0, 'a retained intent must not form an unbounded notification loop'); };
    f.manualOverride = () => { state.audioFocusIntent = { ...intent, target: {} }; };
    return f;
}

test('dirty getState reports with the same fingerprint cannot consume four automatic repair attempts', () => {
    const f = unifiedReconcileFixture();
    f.queue(); f.run();
    assert.equal(f.restores.length, 1); assert.equal(f.intent.repairs, 1);
    assert.equal(f.notifications, 1); assert.equal(f.intent.dirty, false);
    f.intent.dirty = true; f.queue(); f.run();
    assert.equal(f.restores.length, 1); assert.equal(f.intent.repairs, 1);
    assert.equal(f.intent.dirty, false);
});

test('a fresh empty proof can release a withheld target after four unsafe repairs without resetting their budget', () => {
    const f = unifiedReconcileFixture(); f.intent.repairs = 4;
    f.queue(); f.run(); assert.equal(f.restores.length, 0);
    f.cohort[1].state.emptyGuardConfirmed = true; f.fingerprint = 'fresh-empty-proof'; f.completesFocused = true;
    f.queue(); f.run();
    assert.equal(f.restores.length, 1); assert.equal(f.intent.repairs, 4);
    assert.equal(f.restores[0].ticket, 11); assert.equal(f.restores[0].intent, f.intent);
    assert.equal(f.intent.automatic, true); assert.equal(f.intent.focused, true);
    f.intent.dirty = true; f.queue(); f.run(); assert.equal(f.restores.length, 1);
    f.cohort[1].state.emptyGuardConfirmed = false; f.fingerprint = 'unsafe-again';
    f.queue(); f.run(); assert.equal(f.restores.length, 1); assert.equal(f.intent.repairs, 4);
    f.intent.focused = false;
    f.cohort[1].state = { available: true, muted: true, volume: .6, muteGuardActive: true };
    f.fingerprint = 'live-media-guard-confirmed'; f.queue(); f.run();
    assert.equal(f.restores.length, 2); assert.equal(f.intent.repairs, 4); assert.equal(f.intent.focused, true);
});

test('an unsafe peer remains blocked at the exhausted budget despite fresh fingerprints and dirty notifications', () => {
    const f = unifiedReconcileFixture(); f.intent.repairs = 4;
    for (const fingerprint of ['loading', 'new-opaque-route', 'refused-mute']) {
        f.fingerprint = fingerprint; f.intent.dirty = true; f.queue(); f.run();
    }
    assert.equal(f.restores.length, 0); assert.equal(f.intent.repairs, 4);
    assert.equal(f.intent.lastFingerprint, 'refused-mute'); assert.equal(f.intent.dirty, false);
});

test('fresh safe proof cannot reopen a removed target or its changed controller identity', () => {
    for (const change of [f => { f.target.isConnected = false; },
        f => { f.target.parentElement = {}; }, f => { f.entry.generation++; }]) {
        const f = unifiedReconcileFixture(); f.intent.repairs = 4;
        f.cohort[1].state.emptyGuardConfirmed = true; change(f);
        f.queue(); f.run();
        assert.equal(f.restores.length, 0); assert.equal(f.cleared, true);
        assert.deepEqual(f.statuses.map(value => value.phase), ['removed']);
    }
});

test('a newer explicit sound intent wins over a queued proof-based automatic recovery', () => {
    const f = unifiedReconcileFixture(); f.intent.repairs = 4;
    f.cohort[1].state.emptyGuardConfirmed = true; f.queue(); f.manualOverride(); f.run();
    assert.equal(f.restores.length, 0); assert.equal(f.cleared, undefined);
    assert.deepEqual(f.statuses, []); assert.equal(f.intent.repairs, 4);
});

test('uppercase no-media cannot expose manual sound controls even if a malformed reply has numeric fields', () => {
    const entry = { kind: 'frame', target: {}, result: { ok: false, code: 'NO_MEDIA', state: { muted: false, volume: 1 } } };
    assert.equal(canControl(entry, 'setMuted'), false); assert.equal(canControl(entry, 'setVolume'), false);
    entry.result = { ok: true, code: 'OK', state: { available: false, muted: true, volume: 1,
        muteGuardActive: true, emptyGuardConfirmed: true } };
    assert.equal(canControl(entry, 'setMuted'), false, 'empty peer safety never enables opening the empty row');
    assert.equal(canControl(entry, 'setVolume'), false);
});

test('unified focus failure identifies the actual peer instead of blaming the requested target', () => {
    const names = new Map([['native|gold', '3. 金剛'], ['kick|fire', '7. 火']]);
    const failures = unifiedFocusFailures({ code: 'PARTIAL', results: [
        { key: 'native|gold', status: 'failed', reason: 'focus-withheld' },
        { key: 'kick|fire', status: 'failed', reason: 'setMuted-unconfirmed' }
    ] }, 'native|gold', names, '3. 金剛');
    assert.deepEqual(failures, [{ name: '7. 火', code: 'setMuted-unconfirmed' }]);
});

test('unified focus still names a genuine target failure and does not expose raw missing channel keys', () => {
    const names = new Map([['native|gold', '3. 金剛'], ['kick|fire', '7. 火']]);
    assert.deepEqual(unifiedFocusFailures({ code: 'PARTIAL', results: [
        { key: 'native|gold', status: 'failed', reason: 'volume-unconfirmed' },
        { key: 'kick|fire', status: 'restored', reason: '' }
    ] }, 'native|gold', names, '3. 金剛'), [{ name: '3. 金剛', code: 'volume-unconfirmed' }]);
    assert.deepEqual(unifiedFocusFailures({ code: 'PARTIAL', results: [
        { key: 'm3u8|https://private.example/?token=secret', status: 'stale', reason: 'lease-changed' },
        { key: 'native|gold', status: 'failed', reason: 'focus-withheld' }
    ] }, 'native|gold', names, '3. 金剛'), [{ name: '未就緒的播放器', code: 'lease-changed' }]);
    assert.deepEqual(unifiedFocusFailures({ code: 'PARTIAL', results: [
        { key: 'native|gold', status: 'failed', reason: 'focus-withheld' }
    ] }, 'native|gold', names, '3. 金剛'), [{ name: '其他播放器', code: 'unconfirmed' }]);
    assert.deepEqual(unifiedFocusFailures({ code: 'CANCELLED', results: [] }, 'native|gold', names, '3. 金剛'),
        [{ name: '3. 金剛', code: 'stale' }]);
});

test('global mute follows actual player state after individual changes', () => {
    assert.equal(aggregateAudio([{muted:true,volume:0.5},{muted:true,volume:0.5}]).muted, true);
    assert.equal(aggregateAudio([{muted:false,volume:0.5},{muted:true,volume:0.5}]).muted, false);
    assert.equal(aggregateAudio([{muted:false,volume:0.5},{muted:false,volume:0.5}]).muted, false);
});
test('master volume reflects a shared level including zero', () => {
    assert.equal(aggregateAudio([{volume:0.5},{volume:0.5}]).volume, 0.5);
    assert.equal(aggregateAudio([{volume:0},{volume:0}]).volume, 0);
    assert.equal(aggregateAudio([{volume:1},{volume:1}]).volume, 1);
});
test('mixed or unknown player levels are not falsely shown as a shared level', () => {
    assert.deepEqual(aggregateAudio([{volume:0.2},{volume:0.8}]), {muted:false,volume:null,mixed:true});
    assert.equal(aggregateAudio([{volume:0.5},{volume:null}]).volume, null);
    assert.deepEqual(aggregateAudio([]), {muted:false,volume:null,mixed:false});
    assert.equal(aggregateAudio([{volume:NaN},{volume:-1}]).volume, null);
});
test('invalid or missing results cannot be applied as successful controls', () => {
    for (const result of [null, {}, {ok:'true',code:'OK'}, {ok:true}, {ok:true,code:3}]) assert.equal(Boolean(validResult(result)), false);
    assert.equal(Boolean(validResult({ok:false,code:'NO_MEDIA',state:null})), true);
    assert.equal(Boolean(validResult({ok:true,code:'OK',state:{volume:0.5}})), true);
});

test('a connected Twitch platform Play stays usable before the video is created', () => {
    const entry = { kind: 'frame', target: { frameId: 4 }, result: { ok: false, code: 'NO_MEDIA', state: {
        available: false, playbackStatus: 'no-media', volume: null, muted: null,
        recoverSupported: true, platformRecoverSupported: true, volumeSupported: false, muteSupported: false
    } } };
    assert.equal(canControl(entry, 'recover'), true);
    assert.equal(canControl(entry, 'setVolume'), false);
    assert.equal(canControl(entry, 'setMuted'), false);
    entry.result.state.platformRecoverSupported = false;
    assert.equal(canControl(entry, 'recover'), false);
});

test('platform recovery cannot enable an unconnected, unsupported or explicitly disabled player', () => {
    const entry = { kind: 'frame', target: { frameId: 4 }, result: { ok: false, code: 'NO_MEDIA', state: {
        playbackStatus: 'no-media', recoverSupported: true, platformRecoverSupported: true
    } } };
    assert.equal(canControl({ ...entry, target: null }, 'recover'), false);
    assert.equal(canControl({ ...entry, kind: 'unsupported' }, 'recover'), false);
    entry.result.capabilities = { recover: false };
    assert.equal(canControl(entry, 'recover'), false);
    entry.result.capabilities = {};
    entry.result.state.recoverSupported = false;
    assert.equal(canControl(entry, 'recover'), false);
});

test('only the actual selection Start Watching handler triggers the automatic pass', () => {
    const target = (onclick, parent = 'channel-selection') => ({ closest: selector => {
        assert.equal(selector, 'button');
        return { parentElement: { id: parent }, getAttribute: key => key === 'onclick' ? onclick : null };
    } });
    assert.equal(isWatchStartTarget(target('watchSelectedChannels()')), true);
    assert.equal(isWatchStartTarget(target(' watchSelectedChannels ( ) ; ')), true);
    for (const handler of ['checkAllLiveChannels()', 'clearAllChannelSelection()', 'watchSelectedChannels();other()', null]) {
        assert.equal(isWatchStartTarget(target(handler)), false);
    }
    assert.equal(isWatchStartTarget(target('watchSelectedChannels()', 'other-menu')), false);
    assert.equal(isWatchStartTarget(null), false);
});

test('native and connected iframe startup wait for metadata while a Twitch cover can be ready without video', () => {
    const entry = { kind: 'native', result: { state: { available: true, paused: true, readyState: 0 } } };
    assert.equal(isRecoveryReady(entry), false);
    entry.result.state.readyState = 1;
    assert.equal(isRecoveryReady(entry), true);
    const frame = { kind: 'frame', target: { frameId: 4 }, result: { state: {
        available: false, readyState: null, platformRecoverSupported: true
    } } };
    assert.equal(isRecoveryReady(frame), true);
    frame.target = null;
    assert.equal(isRecoveryReady(frame), false);
    frame.target = { frameId: 4 }; frame.result.state.platformRecoverSupported = false;
    assert.equal(isRecoveryReady(frame), false);
    Object.assign(frame.result.state, { available: true, paused: true, readyState: 0 });
    assert.equal(isRecoveryReady(frame), false, 'a connected empty Twitch video is not initialized');
    frame.result.state.readyState = 1;
    assert.equal(isRecoveryReady(frame), true);
    frame.result.state.readyState = 0; frame.result.state.paused = false;
    assert.equal(isRecoveryReady(frame), true, 'an already-starting player can be skipped without waiting for metadata');
    frame.result.state.paused = true; frame.result.state.ended = true;
    assert.equal(isRecoveryReady(frame), true);
});

test('unavailable players and terminal media errors do not hold the whole startup indefinitely', () => {
    assert.equal(isRecoveryReady({ kind: 'unsupported' }), true);
    assert.equal(isRecoveryReady({ kind: 'native', result: { state: { errorCode: 3, readyState: 0 } } }), true);
    assert.equal(isRecoveryReady({ kind: 'native', result: { state: { disposed: true } } }), true);
    assert.equal(isRecoveryReady({ kind: 'frame', result: null }), false);
});

test('the final recovery readiness check uses fresh state instead of an older ready announcement', () => {
    const entry = { kind: 'frame', target: { frameId: 4 }, result: { state: {
        available: true, paused: true, readyState: 4, platformRecoverSupported: true
    } } };
    const fresh = { state: { available: true, paused: true, readyState: 0, platformRecoverSupported: false } };
    assert.equal(isRecoveryReady(entry), true);
    assert.equal(isRecoveryReady(entry, fresh), false);
    assert.equal(entry.result.state.readyState, 4);
});

const flushFocus = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
function focusFixture(count = 3, extra = {}) {
    const clock = { now: 0, sequence: 0, timers: new Map(),
        setTimeout(callback, delay) { const id = ++this.sequence; this.timers.set(id, { callback, at: this.now + delay }); return id; },
        clearTimeout(id) { this.timers.delete(id); } };
    const f = { clock, calls: [], statuses: [], gates: new Map(), entries: Array.from({ length: count }, (_, index) => ({
        key: `tile-${index}`, identity: {}, generation: 0, name: `台 ${index}`, current: true, readiness: 'ready',
        state: { muted: false, volume: 0.6 }, volumeSupported: true
    })) };
    f.gate = key => { let resolve; const promise = new Promise(done => { resolve = done; }); f.gates.set(key, promise); return resolve; };
    f.flow = createAudioFocusFlow({ clock, now: () => clock.now, waitMs: 6000,
        snapshot: () => f.entries.map(entry => ({ ...entry, state: { ...entry.state } })),
        readiness: item => item.readiness,
        isCurrent: item => f.entries.some(entry => entry.key === item.key && entry.identity === item.identity && entry.generation === item.generation && entry.current),
        canSetVolume: item => item.volumeSupported,
        onStatus: value => f.statuses.push(value),
        async execute(item, command) {
            f.calls.push({ key: item.key, ...command });
            const gate = f.gates.get(`${item.key}:${command.action}:${command.value}`);
            if (gate) await gate;
            const entry = f.entries.find(value => value.key === item.key && value.identity === item.identity);
            if (!entry || entry.generation !== item.generation || !entry.current) return { ok: false, code: 'stale' };
            if (entry.fail === command.action + ':' + command.value) return { ok: false, code: 'NOT_APPLIED', state: { ...entry.state } };
            entry.state = { ...entry.state, [command.action === 'setMuted' ? 'muted' : 'volume']: command.value };
            return { ok: true, code: 'OK', state: { ...entry.state } };
        }, ...extra });
    f.tick = async ms => {
        const end = clock.now + ms;
        await flushFocus();
        for (;;) {
            const next = [...clock.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            clock.now = next[1].at; clock.timers.delete(next[0]); next[1].callback(); await flushFocus();
        }
        clock.now = end; await flushFocus();
    };
    return f;
}

test('audio focus awaits every confirmed mute before opening only the requested tile', async () => {
    const f = focusFixture(), release = f.gate('tile-2:setMuted:true');
    const request = f.flow.request('tile-0');
    await flushFocus();
    assert.deepEqual(f.calls, [0, 1, 2].map(index => ({ key: `tile-${index}`, action: 'setMuted', value: true, guard: true })));
    assert.equal(f.entries[0].state.muted, true);
    release();
    assert.equal((await request).phase, 'focused');
    assert.deepEqual(f.calls.at(-1), { key: 'tile-0', action: 'setMuted', value: false });
    assert.deepEqual(f.entries.map(entry => entry.state.muted), [false, true, true]);
    assert.ok(f.calls.every(call => ['setMuted', 'setVolume'].includes(call.action)), 'focus never plays, recovers or reloads');
    f.flow.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('rapid enlargement requests discard the old and intermediate target before opening the latest', async () => {
    const f = focusFixture(), release = f.gate('tile-2:setMuted:true');
    const first = f.flow.request('tile-0'); await flushFocus();
    const middle = f.flow.request('tile-1'), last = f.flow.request('tile-2');
    release();
    assert.equal((await first).phase, 'cancelled'); assert.equal((await middle).phase, 'cancelled');
    assert.equal((await last).phase, 'focused');
    assert.deepEqual(f.calls.filter(call => call.action === 'setMuted' && call.value === false), [{ key: 'tile-2', action: 'setMuted', value: false }]);
});

test('an already-issued older unmute settles before the newer complete mute barrier', async () => {
    const f = focusFixture(), release = f.gate('tile-0:setMuted:false');
    const first = f.flow.request('tile-0'); await flushFocus();
    const second = f.flow.request('tile-1'); await flushFocus();
    assert.equal(f.calls.length, 5, 'new worker waits for the in-flight old unmute');
    release();
    assert.equal((await first).phase, 'cancelled'); assert.equal((await second).phase, 'focused');
    assert.deepEqual(f.entries.map(entry => entry.state.muted), [true, false, true]);
    assert.deepEqual(f.calls.slice(5, 8), [0, 1, 2].map(index => ({ key: `tile-${index}`, action: 'setMuted', value: true, guard: true })));
});

test('explicit controls can cancel then await in-flight focus without a late surprise unmute', async () => {
    const f = focusFixture(), release = f.gate('tile-0:setMuted:false');
    const request = f.flow.request('tile-0'); await flushFocus();
    let manualRan = false;
    const override = f.flow.cancel().then(() => { manualRan = true; for (const entry of f.entries) entry.state.muted = true; });
    await flushFocus(); assert.equal(manualRan, false);
    release(); await override;
    assert.equal((await request).phase, 'cancelled'); assert.equal(manualRan, true);
    assert.deepEqual(f.entries.map(entry => entry.state.muted), [true, true, true]);
    assert.ok(!f.statuses.some(status => status.phase === 'focused'));
});

test('pending/busy players have a bounded readiness wait and cancel promptly with no timers left', async () => {
    const f = focusFixture(); f.entries[1].readiness = 'pending';
    const request = f.flow.request('tile-0');
    await f.tick(5999); assert.deepEqual(f.calls, [0, 2].map(index => ({ key: `tile-${index}`, action: 'setMuted', value: true, guard: true })));
    await f.tick(1); const result = await request;
    assert.equal(result.phase, 'partial'); assert.deepEqual(result.failures, [{ key: 'tile-1', name: '台 1', code: 'pending' }]);
    assert.ok(!f.calls.some(call => call.value === false)); assert.equal(f.clock.timers.size, 0);
    const next = f.flow.request('tile-0'); await flushFocus();
    await f.flow.cancel(); assert.equal((await next).phase, 'cancelled'); assert.equal(f.clock.timers.size, 0);
});

test('late readiness uses the same wrapper identity and starts as soon as all players can mute', async () => {
    const f = focusFixture(); f.entries[0].readiness = 'pending';
    const request = f.flow.request('tile-0'); await f.tick(400);
    f.entries[0].readiness = 'ready'; await f.tick(100);
    assert.equal((await request).phase, 'focused'); assert.equal(f.clock.now, 500);
    assert.equal(f.entries[0].state.muted, false);
});

test('unsupported or rejected mute is named precisely and never permits the target to unmute', async () => {
    for (const mode of ['unsupported', 'rejected']) {
        const f = focusFixture();
        if (mode === 'unsupported') f.entries[1].readiness = 'unsupported';
        else f.entries[1].fail = 'setMuted:true';
        const result = await f.flow.request('tile-0');
        assert.equal(result.phase, 'partial');
        assert.deepEqual(result.failures, [{ key: 'tile-1', name: '台 1', code: mode === 'unsupported' ? 'unsupported' : 'NOT_APPLIED' }]);
        assert.equal(f.entries[0].state.muted, true);
        assert.ok(!f.calls.some(call => call.action === 'setMuted' && call.value === false));
    }
});

test('target removal, replacement and generation change abort after the mute phase', async () => {
    for (const change of ['removed', 'replacement', 'generation']) {
        const f = focusFixture(), release = f.gate('tile-2:setMuted:true');
        const request = f.flow.request('tile-0'); await flushFocus();
        if (change === 'removed') f.entries.shift();
        else if (change === 'replacement') f.entries[0] = { ...f.entries[0], identity: {} };
        else f.entries[0].generation++;
        release(); assert.equal((await request).phase, 'removed');
        assert.ok(!f.calls.some(call => call.action === 'setMuted' && call.value === false));
    }
});

test('new players, changed generations and late unmuted peers are repaired before the complete mute barrier opens sound', async () => {
    for (const change of ['new', 'generation', 'unmuted']) {
        const f = focusFixture(), release = f.gate('tile-2:setMuted:true');
        const request = f.flow.request('tile-0'); await flushFocus();
        if (change === 'new') f.entries.push({ ...f.entries[1], key: 'new-tile', identity: {}, name: '新台' });
        else if (change === 'generation') f.entries[1].generation++;
        else f.entries[1].state.muted = false;
        release(); assert.equal((await request).phase, 'focused');
        assert.ok(f.entries.every(entry => entry.key === 'tile-0' ? !entry.state.muted : entry.state.muted));
    }
});

test('every focused target is set to exactly 100 percent before unmute, preserving all other levels', async () => {
    for (const previous of [0, 0.27, 1, null]) {
        const f = focusFixture(); f.entries[0].state.volume = previous;
        f.entries[1].state.volume = 0;
        assert.equal((await f.flow.request('tile-0')).phase, 'focused');
        assert.deepEqual(f.calls.filter(call => call.action === 'setVolume'), [{ key: 'tile-0', action: 'setVolume', value: 1 }]);
        assert.equal(f.entries[0].state.volume, 1);
        assert.equal(f.entries[1].state.volume, 0);
        assert.equal(f.entries[2].state.volume, 0.6);
        assert.deepEqual(f.calls.at(-1), { key: 'tile-0', action: 'setMuted', value: false });
    }
});

test('a rejected or unsupported 100 percent volume command leaves the focused tile muted', async () => {
    for (const mode of ['unsupported', 'rejected']) for (const previous of [0, 0.27, 1]) {
        const f = focusFixture(); f.entries[0].state.volume = previous;
        if (mode === 'unsupported') f.entries[0].volumeSupported = false;
        else f.entries[0].fail = 'setVolume:1';
        const result = await f.flow.request('tile-0');
        assert.equal(result.phase, 'partial');
        assert.equal(result.failures[0].code, mode === 'unsupported' ? 'volume-unsupported' : 'NOT_APPLIED');
        assert.equal(f.entries[0].state.muted, true);
        assert.ok(!f.calls.some(call => call.action === 'setMuted' && call.value === false));
    }
});

test('a successful response without confirmed 100 percent volume cannot open sound', async () => {
    let f;
    f = focusFixture(2, { async execute(item, command) {
        const entry = f.entries.find(value => value.key === item.key);
        f.calls.push({ key: item.key, ...command });
        if (command.action === 'setMuted') entry.state.muted = command.value;
        // A platform may claim success but retain its previous volume.
        return { ok: true, code: 'OK', state: { ...entry.state } };
    } });
    const result = await f.flow.request('tile-0');
    assert.equal(result.phase, 'partial');
    assert.equal(result.failures[0].code, 'volume-unconfirmed');
    assert.equal(f.entries[0].state.muted, true);
    assert.ok(!f.calls.some(call => call.action === 'setMuted' && call.value === false));
});

test('dispose cancels pending readiness and queued targets without retaining timers or opening sound', async () => {
    const f = focusFixture(); f.entries[1].readiness = 'pending';
    const first = f.flow.request('tile-0'); await flushFocus();
    const second = f.flow.request('tile-2'); f.flow.dispose(); await flushFocus();
    assert.equal((await first).phase, 'cancelled'); assert.equal((await second).phase, 'cancelled');
    assert.ok(f.calls.every(call => call.action === 'setMuted' && call.value === true && call.guard === true)); assert.equal(f.clock.timers.size, 0);
    assert.equal((await f.flow.request('tile-0')).phase, 'cancelled');
});

test('peers added, replaced or unmuted during the final target-unmute reply are repaired before success', async () => {
    for (const change of ['new', 'replacement', 'unmuted']) {
        const f = focusFixture(), release = f.gate('tile-0:setMuted:false');
        const request = f.flow.request('tile-0'); await flushFocus();
        if (change === 'new') f.entries.push({ ...f.entries[1], key: 'late-tile', identity: {}, state: { muted: false, volume: .8 } });
        else if (change === 'replacement') f.entries[1] = { ...f.entries[1], identity: {}, generation: 2, state: { muted: false, volume: .8 } };
        else f.entries[1].state.muted = false;
        release();
        assert.equal((await request).phase, 'focused');
        assert.deepEqual(f.entries.filter(entry => !entry.state.muted).map(entry => entry.key), ['tile-0']);
    }
});

test('a post-unmute peer that refuses mute remutes the target and never reports success', async () => {
    const f = focusFixture(), release = f.gate('tile-0:setMuted:false');
    const request = f.flow.request('tile-0'); await flushFocus();
    f.entries[1].state.muted = false; f.entries[1].fail = 'setMuted:true';
    release();
    const result = await request;
    assert.equal(result.phase, 'partial');
    assert.equal(f.entries[0].state.muted, true);
    assert.deepEqual(result.failures, [{ key: 'tile-1', name: '台 1', code: 'NOT_APPLIED' }]);
});

test('a repair pass mutes new peers without changing the existing target volume or unmute state', async () => {
    const f = focusFixture();
    assert.equal((await f.flow.request('tile-0')).phase, 'focused');
    f.entries[0].state.volume = .37;
    f.entries.push({ ...f.entries[1], key: 'late-tile', identity: {}, state: { muted: false, volume: .8 } });
    f.calls.length = 0;
    assert.equal((await f.flow.request('tile-0', { repair: true })).phase, 'focused');
    assert.equal(f.entries[0].state.volume, .37); assert.equal(f.entries[0].state.muted, false);
    assert.ok(f.calls.every(call => call.key !== 'tile-0' && call.action === 'setMuted' && call.value && call.guard));
});

test('large cohorts never exceed four concurrent commands or the userscript pending capacity', async () => {
    let active = 0, maximum = 0, f;
    f = focusFixture(40, { async execute(item, command) {
        active++; maximum = Math.max(maximum, active);
        await Promise.resolve();
        const entry = f.entries.find(entry => entry.key === item.key);
        entry.state[command.action === 'setMuted' ? 'muted' : 'volume'] = command.value;
        active--;
        return { ok: true, code: 'OK', state: { ...entry.state } };
    } });
    assert.equal((await f.flow.request('tile-0')).phase, 'focused');
    assert.equal(maximum, 4);
    assert.equal(f.entries.filter(entry => !entry.state.muted).length, 1);
});

test('transient BUSY replies retry finitely while ready peers mute immediately', async () => {
    let attempts = 0, f;
    f = focusFixture(3, { async execute(item, command) {
        f.calls.push({ key: item.key, ...command });
        if (item.key === 'tile-1' && command.value === true && attempts++ < 2) return { ok: false, code: 'BUSY' };
        const entry = f.entries.find(entry => entry.key === item.key);
        entry.state[command.action === 'setMuted' ? 'muted' : 'volume'] = command.value;
        return { ok: true, code: 'OK', state: { ...entry.state } };
    } });
    const request = f.flow.request('tile-0'); await flushFocus();
    assert.equal(f.entries[2].state.muted, true);
    await f.tick(200);
    assert.equal((await request).phase, 'focused'); assert.equal(attempts, 3);
    assert.equal(f.clock.timers.size, 0);
});

test('repeated BUSY ends after three attempts and leaves the target safely muted', async () => {
    let attempts = 0, f;
    f = focusFixture(2, { async execute(item, command) {
        const entry = f.entries.find(entry => entry.key === item.key);
        if (item.key === 'tile-1') { attempts++; return { ok: false, code: 'BUSY' }; }
        entry.state[command.action === 'setMuted' ? 'muted' : 'volume'] = command.value;
        return { ok: true, code: 'OK', state: { ...entry.state } };
    } });
    const request = f.flow.request('tile-0'); await f.tick(300);
    assert.equal((await request).phase, 'partial'); assert.equal(attempts, 3);
    assert.equal(f.entries[0].state.muted, true); assert.equal(f.clock.timers.size, 0);
});

test('an urgent mute lane settles before any target volume or unmute command can run', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const f = focusFixture(3, { settle: () => gate });
    const request = f.flow.request('tile-0'); await flushFocus();
    assert.equal(f.calls.length, 3);
    assert.ok(f.calls.every(call => call.action === 'setMuted' && call.value === true));
    release();
    assert.equal((await request).phase, 'focused');
    assert.deepEqual(f.entries.filter(entry => !entry.state.muted).map(entry => entry.key), ['tile-0']);
});

test('a target that resets its sound during a late peer confirmation cannot be reported focused', async () => {
    for (const change of ['muted', 'volume']) {
        const f = focusFixture(), releaseTarget = f.gate('tile-0:setMuted:false');
        const request = f.flow.request('tile-0'); await flushFocus();
        const releasePeer = f.gate('late-tile:setMuted:true');
        f.entries.push({ ...f.entries[1], key: 'late-tile', identity: {}, state: { muted: false, volume: .8 } });
        releaseTarget(); await flushFocus();
        f.entries[0].state[change] = change === 'muted' ? true : .2;
        releasePeer();
        assert.equal((await request).phase, 'partial');
        assert.equal(f.entries[0].state.muted, true);
    }
});
