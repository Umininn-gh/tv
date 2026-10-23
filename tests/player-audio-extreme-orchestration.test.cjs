'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Use the production urgent safety lane with controlled acknowledgements. This
// isolates scheduling, rather than duplicating the implementation in a model.
function urgentLaneFixture(count = 24) {
    const source = fs.readFileSync(path.join(__dirname, '../browser-extension/site-ui.js'), 'utf8');
    const start = source.indexOf('        function muteImmediately(');
    const end = source.indexOf('\n        function setGlobalMuted(', start);
    assert.ok(start > 0 && end > start, 'reviewed urgent-lane production seam exists');
    const entries = Array.from({ length: count }, (_, id) => ({ id, kind: 'frame', target: { id }, busy: false }));
    const issued = [], pending = [];
    const context = vm.createContext({
        currentEntries: () => entries,
        execute(entry, command) {
            issued.push({ id: entry.id, command: { ...command } });
            return new Promise(resolve => pending.push(() => resolve({ ok: false, code: 'timeout' })));
        },
        Promise
    });
    vm.runInContext(`let disposed = false, audioControlGeneration = 1;\nconst urgentAudioTasks = new Set();\n${source.slice(start, end)}\n` +
        'globalThis.debugLane = { run: () => muteImmediately(true), supersede: () => ++audioControlGeneration, settle: () => Promise.all([...urgentAudioTasks]) };', context);
    return { context, issued, pending, run: () => context.debugLane.run(), supersede: () => context.debugLane.supersede(),
        settle: () => context.debugLane.settle(), releaseWave: () => pending.splice(0).forEach(resolve => resolve()) };
}

test('extreme audio: superseding a 24-player safety mute drains only its four issued operations', async () => {
    const lane = urgentLaneFixture();
    lane.run();
    assert.equal(lane.issued.length, 4, 'at most four operations start before acknowledgements');
    lane.supersede(); // A later manual volume/mute command wins now.
    const settled = lane.settle();
    lane.releaseWave();
    await new Promise(resolve => setImmediate(resolve));
    const issuedAfterSupersede = lane.issued.length;
    // Drain the baseline's remaining promises too, so a failure never leaks work.
    while (lane.pending.length) {
        lane.releaseWave();
        await new Promise(resolve => setImmediate(resolve));
    }
    await settled;
    assert.equal(issuedAfterSupersede, 4,
        'the newer manual command must wait only for issued operations, not five additional stale timeout waves');
    assert.equal(lane.issued.length, 4, 'no queued guard from an obsolete intent may start');
});

test('extreme audio: a safely opened target with a peer volume warning stays focused and reports the warning truthfully', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../browser-extension/site-ui.js'), 'utf8');
    const start = source.indexOf('        async function restoreUnifiedFocus(');
    const end = source.indexOf('\n        function originalMuteClick(', start);
    assert.ok(start > 0 && end > start, 'reviewed unified-status production seam exists');
    const statuses = [];
    const target = { getAttribute: () => 'target-key' };
    const entry = { name: { textContent: '目標格' }, result: { state: { available: true, muted: false, volume: 1 } } };
    const result = { ok: false, code: 'PARTIAL', ticket: '1', pending: 0, failed: 0, skipped: 1,
        results: [{ key: 'target-key', status: 'restored', reason: '' },
            { key: 'peer-key', status: 'skipped', reason: 'volume-unsupported' }] };
    const context = vm.createContext({
        target, entry,
        layoutAudioFlow: { restore: async () => result },
        validUnifiedTarget: () => true,
        audioFingerprint: () => 'confirmed-final-state',
        showAudioFocusStatus: value => statuses.push(value),
        queueAudioFocusReconcile() {}, Promise
    });
    vm.runInContext('let disposed = false;\nlet audioFocusIntent = { unified: true, target, entry, runId: 0 };\n' +
        source.slice(start, end) + '\nglobalThis.debugRestore = () => restoreUnifiedFocus(audioFocusIntent, "1");' +
        '\nglobalThis.debugFocused = () => audioFocusIntent.focused;', context);
    await context.debugRestore();
    assert.equal(context.debugFocused(), true,
        'an unrelated peer volume warning must not classify the audible, restored target as unopened');
    assert.equal(statuses.at(-1).phase, 'focused', 'the displayed result must agree with confirmed playback sound');
    assert.equal(statuses.at(-1).volumeWarning, true, 'the skipped peer volume still appears as a warning');
});

function handshakeFixture({ candidate = false } = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../browser-extension/site-ui.js'), 'utf8');
    const start = source.indexOf('        function onFrameMessage(');
    const end = source.indexOf('\n        function invalidateLayoutAudio(', start);
    const validStart = source.indexOf('        function validUnifiedTarget(');
    const validEnd = source.indexOf('\n        function newUnifiedIntent(', validStart);
    assert.ok(start > 0 && end > start && validStart > end && validEnd > validStart);
    const pane = {}, target = { isConnected: true, parentElement: pane }, frameWindow = {};
    const entry = { element: target, frame: { src: 'https://player.twitch.tv/?channel=test', contentWindow: frameWindow },
        kind: 'frame', generation: 0, target: null, busy: false };
    const intent = { unified: true, target, entry, generation: 0, awaitingFirstTarget: true };
    const otherIntent = { unified: true, target: {}, entry: {}, generation: 1 };
    let invalidations = 0;
    const context = vm.createContext({
        entry, intent, otherIntent, candidate, URL,
        doc: { getElementById: () => pane },
        win: { location: { href: 'https://umininn-gh.github.io/tv/' } },
        entries: new Map([[target, entry]]), guardedEntries: new Map(),
        cfg: { isPlayerUrl: () => true },
        validResult: () => true,
        clearProbeTimers() {}, applyResult() {}, execute() {},
        invalidateLayoutAudio: () => invalidations++
    });
    vm.runInContext('let messageChannel = "test", messageVersion = 1, globalMuted = null, layoutTicket = null;\n' +
        'let audioFocusIntent = candidate ? otherIntent : intent;\n' +
        'const layoutFocusCandidates = new Map([["candidate", intent]]);\n' + source.slice(start, end) + '\n' +
        source.slice(validStart, validEnd) +
        '\nglobalThis.debugHandshake = event => onFrameMessage(event);\nglobalThis.debugValid = () => validUnifiedTarget(intent);', context);
    return { entry, intent, valid: () => context.debugValid(), invalidations: () => invalidations,
        ready(token = 'a'.repeat(32)) { context.debugHandshake({ source: frameWindow, origin: 'https://player.twitch.tv', data: {
            channel: 'test', version: 1, type: 'frame:ready', frameId: 1, token, documentId: token, result: { ok: true, state: {} }
        } }); } };
}

test('extreme audio: a deferred candidate binds its first handshake while a newer candidate is selected', () => {
    const f = handshakeFixture({ candidate: true });
    f.ready();
    assert.equal(f.intent.generation, f.entry.generation,
        'the older successful geometry candidate must acquire its initial lease even while a newer candidate is current');
    assert.equal(f.intent.awaitingFirstTarget, false);
    assert.equal(f.valid(), true, 'a later failed candidate may fall back to the successful target');
    assert.equal(f.invalidations(), 0, 'an initial handshake must not cancel the other pending candidate');
});

test('extreme audio: a selected pending frame binds once and a later document replacement invalidates its sound policy', () => {
    const f = handshakeFixture();
    f.ready();
    assert.equal(f.intent.generation, 1);
    assert.equal(f.intent.awaitingFirstTarget, false);
    assert.equal(f.valid(), true);
    f.ready('b'.repeat(32));
    assert.equal(f.invalidations(), 1, 'a replacement document cannot inherit the selected initial-document lease');
    assert.equal(f.intent.generation, 1, 'the original sound lease never follows the replacement token');
    assert.equal(f.valid(), false);
});
