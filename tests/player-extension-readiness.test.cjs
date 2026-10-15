const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadinessPass, isRecoveryReady } = require('../browser-extension/site-ui.js');
const { createRecoveryFlow } = require('../browser-extension/shared/player-recovery.js');
const flush = async () => { for (let i = 0; i < 45; i++) await Promise.resolve(); };
const state = (extra = {}) => ({ available: true, readyState: 4, paused: true, ended: false,
    playbackStatus: 'paused', recoverSupported: true, ...extra });
const entry = (id, kind = 'native', extra = {}) => ({ id, kind, generation: 0, current: true,
    target: kind === 'frame' ? { frameId: id + 1 } : null, result: { ok: true, code: 'OK', state: state(extra) } });
function fixture(initial = []) {
    const clock = { now: 0, next: 0, timers: new Map(),
        setTimeout(fn, ms) { const id = ++this.next; this.timers.set(id, { fn, at: this.now + ms }); return id; },
        clearTimeout(id) { this.timers.delete(id); } };
    async function tick(ms) {
        const end = clock.now + ms;
        await flush();
        for (;;) {
            const next = [...clock.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            clock.now = next[1].at; clock.timers.delete(next[0]); next[1].fn(); await flush();
        }
        clock.now = end; await flush();
    }
    const f = { clock, tick, entries: initial, wrappers: [], queued: [], waiting: [], samples: [], cancelled: false };
    f.abort = new AbortController();
    f.context = { signal: f.abort.signal, isCancelled: () => f.cancelled, enqueueReady: entries => { f.queued.push(...entries.map(e => ({ id: e.id, at: clock.now }))); return entries.length; } };
    f.start = (extra = {}) => createReadinessPass({ clock, context: f.context, now: () => clock.now,
        snapshot: () => ({ entries: f.entries, pendingWrappers: f.wrappers }),
        refresh: e => f.samples.push({ id: e.id, at: clock.now }),
        onWaiting: (entries, wrappers) => f.waiting.push({ at: clock.now, ids: entries.map(e => e.id), wrappers: wrappers.length }), ...extra });
    return f;
}

test('ready paused Twitch and native players enqueue at 600 ms even beside two permanently unready players', async () => {
    const f = fixture([entry(0), entry(1, 'frame', { available: false, platformRecoverSupported: true }),
        entry(2, 'native', { readyState: 0 }), entry(3, 'frame', { available: false, platformRecoverSupported: false })]);
    const pass = f.start(); let done = false; pass.promise.then(() => { done = true; });
    await f.tick(599); assert.deepEqual(f.queued, []);
    await f.tick(1); assert.deepEqual(f.queued, [{ id: 0, at: 600 }, { id: 1, at: 600 }]);
    assert.equal(done, false); assert.deepEqual(f.waiting.at(-1).ids, [2, 3]);
    await f.tick(29400); await pass.promise;
    assert.equal(done, true); assert.equal(f.clock.timers.size, 0);
    assert.equal(f.queued.length, 2);
    assert.equal(f.samples.filter(s => s.id === 1 && s.at > 600).length, 0);
});

test('readiness sampling admits a connected frame whose Play appears later without needing an announcement', async () => {
    const frame = entry(0, 'frame', { available: false, platformRecoverSupported: false });
    const f = fixture([frame]);
    const pass = f.start({ refresh(e, time) { if (time >= 1400) e.result.state.platformRecoverSupported = true; } });
    await f.tick(1999); assert.deepEqual(f.queued, []);
    await f.tick(1); await pass.promise;
    assert.deepEqual(f.queued, [{ id: 0, at: 2000 }]);
});

test('a connected frame with an empty video waits for metadata rather than consuming recovery at 600 ms', async () => {
    const frame = entry(0, 'frame', { available: true, readyState: 0, platformRecoverSupported: false });
    const f = fixture([frame, entry(1)]);
    const pass = f.start({ refresh(e, time) { if (e === frame && time >= 1800) e.result.state.readyState = 1; } });
    await f.tick(600);
    assert.deepEqual(f.queued, [{ id: 1, at: 600 }]);
    await f.tick(1799);
    assert.deepEqual(f.queued, [{ id: 1, at: 600 }]);
    await f.tick(1); await pass.promise;
    assert.deepEqual(f.queued, [{ id: 1, at: 600 }, { id: 0, at: 2400 }]);
});

test('actual scheduler and coordinator wait for late Twitch Play even when its empty video already exists', async () => {
    const frame = entry(0, 'frame', { available: true, readyState: 0, platformRecoverSupported: false });
    const f = fixture([frame]), calls = [];
    const flow = createRecoveryFlow({ clock: f.clock,
        getEntries: () => f.entries,
        isCurrent: (e, generation) => e.current && e.generation === generation,
        prepare(context) { return f.start({ context,
            refresh(e, time) { if (time >= 1400) e.result.state.platformRecoverSupported = true; }
        }).promise; },
        refresh: async e => { calls.push({ type: 'refresh', at: f.clock.now }); return e.result; },
        isReady: isRecoveryReady,
        recover: async e => {
            calls.push({ type: 'recover', at: f.clock.now });
            assert.equal(e.result.state.platformRecoverSupported, true);
            return { ok: true, code: 'OK', state: state({ paused: false, playbackStatus: 'playing' }) };
        }
    });
    const run = flow.run();
    await f.tick(600); assert.deepEqual(calls, []);
    await f.tick(1399); assert.deepEqual(calls, []);
    await f.tick(1); const summary = await run;
    assert.deepEqual(calls, [{ type: 'refresh', at: 2000 }, { type: 'recover', at: 2000 }]);
    assert.equal(summary.recovered, 1); assert.equal(summary.attempted, 1);
    await f.tick(30000); assert.equal(calls.length, 2);
    flow.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('late iframe in a tracked wrapper gets its own stability period without replaying an early entry', async () => {
    const f = fixture([entry(0)]); f.wrappers = [{}]; const pass = f.start();
    await f.tick(2000); assert.deepEqual(f.queued, [{ id: 0, at: 600 }]);
    f.entries.push(entry(1, 'frame', { available: false, platformRecoverSupported: true })); f.wrappers = [];
    await f.tick(800); await pass.promise;
    assert.deepEqual(f.queued, [{ id: 0, at: 600 }, { id: 1, at: 2800 }]);
});

test('generation changes and loss of readiness reset only that entry stability interval', async () => {
    const f = fixture([entry(0), entry(1)]); const pass = f.start();
    await f.tick(400); f.entries[1].generation++;
    await f.tick(200); assert.deepEqual(f.queued, [{ id: 0, at: 600 }]);
    f.entries[1].result.state.readyState = 0;
    await f.tick(200); f.entries[1].result.state.readyState = 4;
    await f.tick(799); assert.equal(f.queued.length, 1);
    await f.tick(1); await pass.promise;
    assert.deepEqual(f.queued.at(-1), { id: 1, at: 1600 });
});

test('abort ends the wait and a later-ready frame cannot enqueue into a cancelled pass', async () => {
    const f = fixture([entry(0, 'frame', { available: false })]); const pass = f.start();
    await f.tick(1200); f.cancelled = true; f.abort.abort(); await pass.promise;
    const samples = f.samples.length; f.entries[0].result.state.available = true;
    await f.tick(30000);
    assert.equal(f.samples.length, samples); assert.deepEqual(f.queued, []); assert.equal(f.clock.timers.size, 0);
});

test('synchronous cancellation during ready notification leaves no trailing timer', async () => {
    const f = fixture([entry(0), entry(1, 'native', { readyState: 0 })]);
    f.context.enqueueReady = () => { f.cancelled = true; f.abort.abort(); return 0; };
    const pass = f.start(); await f.tick(600); await pass.promise;
    assert.equal(f.clock.timers.size, 0);
});

test('synchronous cancellation during waiting notification cannot enqueue ready players', async () => {
    const f = fixture([entry(0)]);
    const pass = f.start({ onWaiting() { if (f.clock.now >= 600) { f.cancelled = true; f.abort.abort(); } } });
    await f.tick(600); await pass.promise;
    assert.deepEqual(f.queued, []); assert.equal(f.clock.timers.size, 0);
});

test('an empty SDK wrapper is bounded by 30 seconds while an empty selection finishes after stability', async () => {
    const f = fixture(); f.wrappers = [{}]; const pass = f.start(); let done = false; pass.promise.then(() => { done = true; });
    await f.tick(29999); assert.equal(done, false);
    await f.tick(1); await pass.promise; assert.equal(done, true); assert.equal(f.queued.length, 0);
    f.wrappers = []; const empty = f.start(); await f.tick(600); await empty.promise;
    assert.equal(f.clock.timers.size, 0);
});

test('removing the last unready player stops waiting rather than waiting until the deadline', async () => {
    const f = fixture([entry(0), entry(1, 'native', { readyState: 0 })]); const pass = f.start();
    await f.tick(800); f.entries.splice(1); await f.tick(200); await pass.promise;
    assert.deepEqual(f.queued, [{ id: 0, at: 600 }]); assert.equal(f.clock.now, 1000);
});

test('actual readiness scheduler and coordinator recover ready Twitch once and report unready media at the 30 second deadline', async () => {
    const f = fixture([entry(0, 'frame', { available: false, platformRecoverSupported: true }),
        entry(1, 'native', { readyState: 0 }), entry(2, 'frame', { readyState: 0, platformRecoverSupported: false })]);
    const calls = [];
    const flow = createRecoveryFlow({ clock: f.clock,
        getEntries: () => f.entries,
        isCurrent: (e, generation) => e.current && e.generation === generation,
        prepare(context) { return f.start({ context }).promise; },
        refresh: async e => { calls.push({ type: 'refresh', id: e.id, at: f.clock.now }); return e.result; },
        isReady: isRecoveryReady,
        recover: async e => { calls.push({ type: 'recover', id: e.id, at: f.clock.now }); return { ok: true, code: 'OK', state: state({ paused: false, playbackStatus: 'playing' }) }; }
    });
    const run = flow.run(); await f.tick(600);
    assert.deepEqual(calls, [{ type: 'refresh', id: 0, at: 600 }, { type: 'recover', id: 0, at: 600 }]);
    assert.equal(flow.isRunning(), true);
    await f.tick(29400); const summary = await run;
    assert.equal(summary.total, 3); assert.equal(summary.recovered, 1); assert.equal(summary.attempted, 1);
    assert.equal(summary.skipped.unknown, 2);
    assert.deepEqual(summary.results.find(result => result.id === 1), { index: 1, id: 1, outcome: 'unknown', code: 'NOT_READY' });
    assert.equal(calls.filter(c => c.type === 'recover' && c.id === 0).length, 1);
    assert.equal(calls.find(c => c.id === 1).at, 30000);
    assert.equal(calls.find(c => c.id === 2).at, 30000);
    assert.equal(calls.filter(c => c.type === 'recover' && c.id === 1).length, 0);
    assert.equal(calls.filter(c => c.type === 'recover' && c.id === 2).length, 0);
    flow.dispose(); assert.equal(f.clock.timers.size, 0);
});
