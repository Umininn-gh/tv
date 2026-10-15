const assert = require('node:assert/strict');
const test = require('node:test');
const { createRecoveryFlow } = require('../browser-extension/shared/player-recovery.js');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const paused = (extra = {}) => ({ available: true, paused: true, ended: false, readyState: 4, playbackStatus: 'paused', errorCode: null, recovering: false, recoverSupported: true, ...extra });
const result = (state = paused(), extra = {}) => ({ ok: true, code: 'OK', message: '', state, ...extra });
const playing = () => result(paused({ paused: false, playbackStatus: 'playing' }));
function fixture(count = 1, additions = {}) {
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
    const entries = Array.from({ length: count }, (_, id) => ({ id, generation: 0, kind: 'frame', busy: false, current: true, result: result() }));
    const calls = [], statuses = [];
    const options = {
        clock, operationTimeoutMs: 100, getEntries: () => entries,
        isCurrent: (entry, generation) => entry.current && entry.generation === generation && entries.includes(entry),
        refresh: async (entry, context) => { calls.push({ type: 'refresh', id: entry.id, generation: context.generation }); return entry.fresh || entry.result; },
        recover: async (entry, context) => { calls.push({ type: 'recover', id: entry.id, generation: context.generation }); return entry.recovery || playing(); },
        onStatus: value => statuses.push(value), ...additions
    };
    const flow = createRecoveryFlow(options);
    return { flow, entries, calls, statuses, clock, tick };
}

test('each distinct entry gets one fresh state and at most one recovery per pass', async () => {
    const f = fixture(2); f.entries.push(f.entries[0]);
    const summary = await f.flow.run();
    assert.equal(summary.code, 'COMPLETE'); assert.equal(summary.ok, true);
    assert.equal(summary.total, 2); assert.equal(summary.checked, 2); assert.equal(summary.attempted, 2); assert.equal(summary.recovered, 2);
    for (const id of [0, 1]) {
        assert.equal(f.calls.filter(call => call.id === id && call.type === 'refresh').length, 1);
        assert.equal(f.calls.filter(call => call.id === id && call.type === 'recover').length, 1);
    }
    assert.equal(f.clock.timers.size, 0); assert.equal(f.flow.isRunning(), false);
    assert.doesNotThrow(() => JSON.stringify(summary));
    f.flow.dispose();
});

test('fresh state overrides stale announcements before deciding what needs recovery', async () => {
    const f = fixture(2);
    f.entries[0].result = playing(); f.entries[0].fresh = result();
    f.entries[1].result = result(); f.entries[1].fresh = playing();
    const summary = await f.flow.run();
    assert.deepEqual(f.calls.filter(call => call.type === 'recover').map(call => call.id), [0]);
    assert.equal(summary.recovered, 1); assert.equal(summary.skipped.playing, 1); f.flow.dispose();
});

test('unpaused buffering/playing players are checked and skipped; busy and unsupported entries are not contacted', async () => {
    const f = fixture(6);
    f.entries[0].fresh = playing();
    f.entries[1].fresh = result(paused({ paused: false, readyState: 1, playbackStatus: 'waiting' }));
    f.entries[2].busy = true;
    f.entries[3].kind = 'unsupported';
    f.entries[4].fresh = result(paused({ recovering: true }));
    f.entries[5].fresh = result(paused({ recoverSupported: false }));
    const summary = await f.flow.run();
    assert.equal(summary.attempted, 0); assert.equal(summary.checked, 4);
    assert.equal(summary.skipped.playing, 2); assert.equal(summary.skipped.busy, 2); assert.equal(summary.skipped.unsupported, 2);
    assert.equal(f.calls.some(call => [2, 3].includes(call.id)), false); f.flow.dispose();
});

test('no-media platform Play is recoverable, but unknown state and explicit capability denial are not guessed', async () => {
    const f = fixture(4);
    f.entries[0].fresh = result(paused({ available: false, paused: null, readyState: null, playbackStatus: 'no-media', platformRecoverSupported: true }), { ok: false, code: 'NO_MEDIA' });
    f.entries[1].fresh = result(paused({ paused: null, playbackStatus: 'waiting' }));
    f.entries[2].fresh = result(paused(), { capabilities: { recover: false } });
    f.entries[3].fresh = result(paused(), { ok: false, code: 'timeout' });
    const summary = await f.flow.run();
    assert.deepEqual(f.calls.filter(call => call.type === 'recover').map(call => call.id), [0]);
    assert.equal(summary.recovered, 1); assert.equal(summary.skipped.unknown, 1);
    assert.equal(summary.skipped.unsupported, 1); assert.equal(summary.failed, 1); f.flow.dispose();
});

test('only ok plus actual consistent playing state counts as recovered; waiting, timeout and blocked remain distinct', async () => {
    const f = fixture(5);
    f.entries[0].recovery = playing();
    f.entries[1].recovery = result(paused());
    f.entries[2].recovery = result(paused({ paused: false, readyState: 1, playbackStatus: 'waiting' }));
    f.entries[3].recovery = result(paused(), { ok: false, code: 'PLAY_TIMEOUT' });
    f.entries[4].recovery = result(paused({ playbackStatus: 'blocked' }), { ok: false, code: 'PLAY_BLOCKED' });
    const summary = await f.flow.run();
    assert.equal(summary.recovered, 1); assert.equal(summary.waiting, 2); assert.equal(summary.failed, 2);
    assert.equal(summary.code, 'PARTIAL'); assert.equal(summary.ok, false);
    assert.equal(summary.results[4].code, 'PLAY_BLOCKED'); f.flow.dispose();
});

test('refresh/recover combined concurrency never exceeds four, even when a larger limit was requested', async () => {
    const pending = []; let live = 0, peak = 0;
    const callback = type => (entry) => {
        live++; peak = Math.max(peak, live);
        const d = deferred(); pending.push({ type, entry, resolve: () => { live--; d.resolve(type === 'refresh' ? result() : playing()); } });
        return d.promise;
    };
    const f = fixture(13, { concurrency: 20, refresh: callback('refresh'), recover: callback('recover') });
    const request = f.flow.run(); await flush();
    assert.equal(pending.length, 4);
    while (f.flow.isRunning()) {
        const batch = pending.splice(0); assert.ok(batch.length > 0);
        batch.forEach(item => item.resolve()); await flush();
    }
    const summary = await request;
    assert.equal(peak, 4); assert.equal(summary.recovered, 13); assert.equal(summary.attempted, 13);
    assert.equal(f.clock.timers.size, 0); f.flow.dispose();
});

test('multiple clicks share the same promise throughout prepare and batch work', async () => {
    const ready = deferred(); let prepares = 0;
    const f = fixture(1, { prepare: async context => { prepares++; assert.equal(context.reason, 'manual'); await ready.promise; } });
    const one = f.flow.run({ reason: 'manual' });
    assert.equal(f.flow.run({ reason: 'start' }), one); assert.equal(f.flow.isRunning(), true);
    assert.equal(f.calls.length, 0);
    ready.resolve(); const summary = await one;
    assert.equal(prepares, 1); assert.equal(summary.reason, 'manual'); assert.equal(summary.recovered, 1); f.flow.dispose();
});

test('prepare owns load/discovery settling and snapshot includes entries discovered before it resolves', async () => {
    const ready = deferred(); let context;
    const f = fixture(0, { prepare: value => { context = value; return ready.promise; } });
    const request = f.flow.run({ reason: 'start' });
    f.entries.push({ id: 4, generation: 2, kind: 'frame', current: true, result: result() });
    assert.equal(f.calls.length, 0); assert.equal(context.isCancelled(), false); assert.equal(context.signal.aborted, false);
    ready.resolve(); const summary = await request;
    assert.equal(summary.total, 1); assert.equal(summary.recovered, 1);
    assert.equal(f.calls[0].generation, 2); f.flow.dispose();
});

test('cancel immediately resolves a run even if prepare never resolves; late prepare cannot start old work', async () => {
    const oldPrepare = deferred(); let oldContext, cleanups = 0;
    const f = fixture(1, { prepare(context) {
        if (context.reason !== 'old') return;
        oldContext = context;
        const timer = f.clock.setTimeout(() => { throw new Error('prepare timer must be cancelled'); }, 5000);
        context.signal.addEventListener('abort', () => { cleanups++; f.clock.clearTimeout(timer); }, { once: true });
        return oldPrepare.promise;
    } });
    const oldRun = f.flow.run({ reason: 'old' });
    f.flow.cancel();
    assert.equal((await oldRun).code, 'CANCELLED'); assert.equal(oldContext.isCancelled(), true);
    assert.equal(oldContext.signal.aborted, true); assert.equal(cleanups, 1); assert.equal(f.clock.timers.size, 0);
    const newRun = await f.flow.run({ reason: 'start' }); assert.equal(newRun.recovered, 1);
    const count = f.calls.length; oldPrepare.resolve(); await flush();
    assert.equal(f.calls.length, count); f.flow.dispose();
});

test('removed or replaced identities and generations after refresh do not receive recovery', async () => {
    const fresh = deferred();
    const f = fixture(1, { refresh: () => fresh.promise });
    const request = f.flow.run(); await flush();
    f.entries[0].generation++;
    fresh.resolve(result()); const summary = await request;
    assert.equal(summary.skipped.stale, 1); assert.equal(summary.attempted, 0); f.flow.dispose();
});

test('queued entries use their current generation, while entries removed before their turn are skipped', async () => {
    const first = deferred(), generations = [];
    const f = fixture(3, { concurrency: 1, refresh(entry, context) {
        generations.push([entry.id, context.generation]); return entry.id === 0 ? first.promise : playing();
    } });
    const request = f.flow.run(); await flush();
    f.entries[1].generation = 7; f.entries[2].current = false;
    first.resolve(playing()); const summary = await request;
    assert.deepEqual(generations, [[0, 0], [1, 7]]);
    assert.equal(summary.skipped.playing, 2); assert.equal(summary.skipped.stale, 1); f.flow.dispose();
});

test('a generation change during recovery cannot be counted as recovered', async () => {
    const recovery = deferred();
    const f = fixture(1, { recover: () => recovery.promise });
    const request = f.flow.run(); await flush();
    f.entries[0].generation++;
    recovery.resolve(playing()); const summary = await request;
    assert.equal(summary.attempted, 1); assert.equal(summary.recovered, 0); assert.equal(summary.skipped.stale, 1); f.flow.dispose();
});

test('failed refresh and recover callbacks are isolated and never retried', async () => {
    const calls = [];
    const f = fixture(3, {
        refresh(entry) { calls.push(['refresh', entry.id]); if (entry.id === 0) throw new Error('read failed'); return result(); },
        recover(entry) { calls.push(['recover', entry.id]); return entry.id === 1 ? Promise.reject(new Error('play blocked')) : playing(); }
    });
    const summary = await f.flow.run();
    assert.equal(summary.failed, 2); assert.equal(summary.recovered, 1); assert.equal(summary.attempted, 2);
    assert.equal(calls.length, 5); assert.equal(f.clock.timers.size, 0); f.flow.dispose();
});

test('refresh timeout stops its lane; unresolved callbacks retain slots across subsequent runs', async () => {
    const reads = []; let instant = false;
    const f = fixture(20, { refresh() { if (instant) return playing(); const d = deferred(); reads.push(d); return d.promise; } });
    const first = f.flow.run(); await flush(); assert.equal(reads.length, 4);
    f.tick(100); await flush();
    const timedOut = await first;
    assert.equal(timedOut.failed, 4); assert.equal(timedOut.skipped.unknown, 16); assert.equal(f.clock.timers.size, 0);
    const second = f.flow.run(); await flush(); assert.equal(reads.length, 4);
    f.tick(100); await flush();
    const noCapacity = await second;
    assert.equal(noCapacity.results.filter(row => row.code === 'NO_CAPACITY').length, 4); assert.equal(reads.length, 4);
    const count = f.statuses.length; reads.forEach(d => d.resolve(playing())); await flush();
    assert.equal(f.statuses.length, count);
    instant = true;
    const third = await f.flow.run(); assert.equal(third.skipped.playing, 20); f.flow.dispose();
});

test('recovery timeout stays unconfirmed, does not retry, and ignores late success in the completed summary', async () => {
    const recovery = deferred(); let attempts = 0;
    const f = fixture(1, { recover() { attempts++; return recovery.promise; } });
    const request = f.flow.run(); await flush(); f.tick(100); await flush();
    const summary = await request;
    assert.equal(summary.waiting, 1); assert.equal(summary.recovered, 0); assert.equal(attempts, 1);
    const count = f.statuses.length; recovery.resolve(playing()); await flush();
    assert.equal(summary.waiting, 1); assert.equal(f.statuses.length, count); assert.equal(attempts, 1); f.flow.dispose();
});

test('cancel-to-new-run maintains four unresolved operations and cancels queued capacity timers', async () => {
    const reads = [];
    const f = fixture(8, { refresh() { const d = deferred(); reads.push(d); return d.promise; } });
    const old = f.flow.run(); await flush(); assert.equal(reads.length, 4);
    f.flow.cancel(); assert.equal((await old).code, 'CANCELLED');
    const next = f.flow.run(); await flush(); assert.equal(reads.length, 4);
    f.flow.cancel(); assert.equal((await next).code, 'CANCELLED'); await flush();
    assert.equal(f.clock.timers.size, 0);
    reads.forEach(d => d.reject(new Error('late failure'))); await flush();
    assert.equal(reads.length, 4); f.flow.dispose();
});

test('dispose during prepare or callbacks resolves promptly and suppresses all later notifications/actions', async () => {
    for (const stage of ['prepare', 'refresh', 'recover']) {
        const d = deferred(); let sideEffects = 0;
        const overrides = { [stage]: () => { sideEffects++; return d.promise; } };
        const f = fixture(1, overrides);
        const request = f.flow.run(); await flush();
        f.flow.dispose(); const count = f.statuses.length;
        assert.equal((await request).code, 'DISPOSED'); await flush(); assert.equal(f.clock.timers.size, 0);
        d.resolve(stage === 'refresh' ? result() : playing()); await flush();
        assert.equal(f.statuses.length, count); assert.equal(sideEffects, 1);
        assert.equal((await f.flow.run()).code, 'DISPOSED'); assert.equal(f.statuses.length, count);
    }
});

test('status callbacks may cancel reentrantly before any refresh; consumer mutations do not corrupt summaries', async () => {
    let f;
    f = fixture(1, { onStatus(status) {
        if (status.phase === 'checking') f.flow.cancel();
        status.skipped.playing = 999; status.results.push({ index: 20 });
    } });
    const summary = await f.flow.run();
    assert.equal(summary.code, 'CANCELLED'); assert.equal(summary.skipped.playing, 0); assert.equal(summary.results.length, 0);
    assert.equal(f.calls.length, 0); f.flow.dispose();
});

test('an abort listener starting a new pass is not overwritten by the old cancellation status', async () => {
    const oldReady = deferred(), newReady = deferred(); let f, next;
    f = fixture(1, { prepare(context) {
        if (context.reason === 'old') {
            context.signal.addEventListener('abort', () => { next = f.flow.run({ reason: 'new' }); }, { once: true });
            return oldReady.promise;
        }
        return newReady.promise;
    } });
    const old = f.flow.run({ reason: 'old' });
    f.flow.cancel();
    assert.equal((await old).code, 'CANCELLED');
    assert.equal(f.statuses.at(-1).reason, 'new'); assert.equal(f.statuses.at(-1).phase, 'preparing');
    newReady.resolve(); assert.equal((await next).recovered, 1);
    oldReady.resolve(); await flush(); f.flow.dispose();
});

test('prepare rejection and empty cohorts complete without player commands or lingering timers', async () => {
    const failing = fixture(1, { prepare: () => Promise.reject(new Error('load not ready')) });
    assert.equal((await failing.flow.run()).code, 'PREPARE_FAILED'); assert.equal(failing.calls.length, 0); failing.flow.dispose();
    const empty = fixture(0);
    assert.equal((await empty.flow.run()).total, 0); assert.equal(empty.calls.length, 0); assert.equal(empty.clock.timers.size, 0); empty.flow.dispose();
});

test('a ready player recovers while another remains unready and prepare is still pending', async () => {
    const ready = deferred(); let context;
    const f = fixture(2, { prepare(value) { context = value; return ready.promise; } });
    const request = f.flow.run(); let finished = false; request.then(() => { finished = true; });
    assert.equal(context.enqueueReady([f.entries[0]]), 1);
    await flush();
    assert.equal(f.calls.filter(call => call.type === 'recover' && call.id === 0).length, 1);
    assert.equal(f.calls.some(call => call.id === 1), false);
    assert.equal(f.statuses.at(-1).total, 2); assert.equal(f.statuses.at(-1).recovered, 1);
    assert.equal(f.flow.isRunning(), true); assert.equal(finished, false); assert.equal(f.clock.timers.size, 0);
    f.flow.cancel(); assert.equal((await request).code, 'CANCELLED');
    ready.resolve(); await flush(); assert.equal(f.calls.length, 2); f.flow.dispose();
});

test('duplicate ready notifications never reread or replay an entry, including after generation changes', async () => {
    const ready = deferred(), recovery = deferred(); let context;
    const f = fixture(1, { prepare(value) { context = value; return ready.promise; }, recover: () => recovery.promise });
    const request = f.flow.run();
    assert.equal(context.enqueueReady([f.entries[0], f.entries[0]]), 1);
    assert.equal(context.enqueueReady(f.entries), 0); await flush();
    assert.equal(context.enqueueReady(f.entries), 0);
    recovery.resolve(playing()); await flush();
    f.entries[0].generation++;
    assert.equal(context.enqueueReady(f.entries), 0);
    ready.resolve(); const summary = await request;
    assert.equal(summary.checked, 1); assert.equal(summary.attempted, 1); assert.equal(summary.recovered, 1);
    assert.equal(summary.results.length, 1); assert.equal(context.enqueueReady(f.entries), 0); f.flow.dispose();
});

test('each enqueue registers all discovered entries with stable indices independent of ready order', async () => {
    const ready = deferred(); let context;
    const f = fixture(2, { prepare(value) { context = value; return ready.promise; } });
    const request = f.flow.run();
    assert.equal(context.enqueueReady([f.entries[1]]), 1); await flush();
    const late = { id: 9, generation: 0, kind: 'native', current: true, result: result() };
    const first = f.entries[0], second = f.entries[1];
    f.entries.splice(0, 2, second, late, first);
    assert.equal(context.enqueueReady([late]), 1); await flush();
    assert.equal(f.statuses.at(-1).total, 3);
    ready.resolve(); const summary = await request;
    assert.deepEqual(summary.results.map(row => [row.index, row.id]), [[0, 0], [1, 1], [2, 9]]);
    assert.equal(summary.recovered, 3);
    assert.deepEqual(f.calls.filter(call => call.type === 'recover').map(call => call.id), [1, 9, 0]); f.flow.dispose();
});

test('prepare completion adds only unqueued entries and waits for an early recovery still in flight', async () => {
    const ready = deferred(), recovery = deferred(); let context, finished = false;
    const f = fixture(2, { prepare(value) { context = value; return ready.promise; }, recover: entry => entry.id === 0 ? recovery.promise : playing() });
    const request = f.flow.run(); request.then(() => { finished = true; });
    context.enqueueReady([f.entries[0]]); await flush();
    ready.resolve(); await flush();
    assert.equal(finished, false); assert.equal(context.enqueueReady(f.entries), 0);
    assert.equal(f.calls.filter(call => call.type === 'refresh' && call.id === 0).length, 1);
    assert.equal(f.calls.filter(call => call.type === 'refresh' && call.id === 1).length, 1);
    recovery.resolve(playing()); const summary = await request;
    assert.equal(summary.recovered, 2); assert.equal(summary.attempted, 2); assert.equal(summary.results.length, 2); f.flow.dispose();
});

test('foreign ready entries are ignored and removed registered entries are reported stale at the final snapshot', async () => {
    const ready = deferred(); let context;
    const f = fixture(2, { prepare(value) { context = value; return ready.promise; } });
    const request = f.flow.run();
    assert.equal(context.enqueueReady([{ id: 44, generation: 0, current: true }]), 0);
    assert.equal(f.statuses.at(-1).total, 2);
    f.entries[1].current = false; f.entries.pop();
    context.enqueueReady(f.entries); await flush();
    ready.resolve(); const summary = await request;
    assert.equal(summary.total, 2); assert.equal(summary.recovered, 1); assert.equal(summary.skipped.stale, 1);
    assert.equal(f.calls.some(call => call.id === 1), false); f.flow.dispose();
});

test('early and late ready queues share the same four-operation limit throughout discovery', async () => {
    const ready = deferred(), pending = []; let context, live = 0, peak = 0;
    const callback = type => entry => {
        live++; peak = Math.max(peak, live); const d = deferred();
        pending.push({ entry, type, resolve() { live--; d.resolve(type === 'refresh' ? result() : playing()); } });
        return d.promise;
    };
    const f = fixture(12, { prepare(value) { context = value; return ready.promise; }, refresh: callback('refresh'), recover: callback('recover') });
    const request = f.flow.run();
    context.enqueueReady(f.entries.slice(0, 6)); await flush(); assert.equal(pending.length, 4);
    context.enqueueReady(f.entries.slice(6));
    let completed = 0;
    while (completed < 24) {
        const batch = pending.splice(0); assert.ok(batch.length > 0);
        batch.forEach(item => item.resolve()); completed += batch.length; await flush();
    }
    assert.equal(f.flow.isRunning(), true); assert.equal(peak, 4);
    ready.resolve(); const summary = await request;
    assert.equal(summary.total, 12); assert.equal(summary.recovered, 12); assert.equal(summary.attempted, 12);
    assert.equal(f.clock.timers.size, 0); f.flow.dispose();
});

test('cancelled early work retains global capacity and late prepare/ready notifications cannot affect a new run', async () => {
    const oldReady = deferred(), nextReady = deferred(), reads = [], contexts = new Map();
    const f = fixture(8, { prepare(context) { contexts.set(context.reason, context); return context.reason === 'old' ? oldReady.promise : nextReady.promise; },
        refresh() { const d = deferred(); reads.push(d); return d.promise; } });
    const old = f.flow.run({ reason: 'old' });
    contexts.get('old').enqueueReady(f.entries); await flush(); assert.equal(reads.length, 4);
    f.flow.cancel(); assert.equal((await old).code, 'CANCELLED');
    const next = f.flow.run({ reason: 'next' });
    contexts.get('next').enqueueReady(f.entries); await flush(); assert.equal(reads.length, 4);
    assert.equal(contexts.get('old').enqueueReady(f.entries), 0);
    oldReady.resolve(); await flush(); assert.equal(reads.length, 4);
    f.tick(100); await flush();
    assert.equal(f.flow.isRunning(), true); assert.equal(reads.length, 4);
    nextReady.resolve(); const summary = await next;
    assert.equal(summary.failed, 4); assert.equal(summary.skipped.unknown, 4);
    const statuses = f.statuses.length; reads.forEach(d => d.resolve(playing())); await flush();
    assert.equal(f.statuses.length, statuses); assert.equal(reads.length, 4); assert.equal(f.clock.timers.size, 0); f.flow.dispose();
});

test('an early timeout does not let repeated ready notifications restart that lane or exceed capacity', async () => {
    const ready = deferred(), reads = []; let context;
    const f = fixture(6, { prepare(value) { context = value; return ready.promise; }, refresh() { const d = deferred(); reads.push(d); return d.promise; } });
    const request = f.flow.run();
    context.enqueueReady(f.entries.slice(0, 4)); await flush(); f.tick(100); await flush();
    assert.equal(reads.length, 4); assert.equal(context.enqueueReady(f.entries), 2);
    await flush(); assert.equal(reads.length, 4);
    assert.equal(context.enqueueReady(f.entries), 0);
    ready.resolve(); const summary = await request;
    assert.equal(summary.failed, 4); assert.equal(summary.skipped.unknown, 2);
    reads.forEach(d => d.resolve(playing())); await flush(); f.flow.dispose();
});

test('enqueueReady is reentrancy-safe when status consumers enqueue the same cohort again', async () => {
    const ready = deferred(); let context, f, statuses = 0;
    f = fixture(2, { prepare(value) { context = value; return ready.promise; }, onStatus() {
        statuses++;
        if (context) context.enqueueReady(f.entries);
    } });
    const request = f.flow.run();
    context.enqueueReady(f.entries); await flush();
    assert.ok(statuses < 20); assert.equal(f.calls.filter(call => call.type === 'recover').length, 2);
    ready.resolve(); const summary = await request;
    assert.equal(summary.recovered, 2); assert.equal(summary.results.length, 2); f.flow.dispose();
});

test('cancel or dispose reentrantly while enqueue reports status prevents callbacks from being dispatched', async () => {
    for (const action of ['cancel', 'dispose']) {
        const ready = deferred(); let context, f;
        f = fixture(1, { prepare(value) { context = value; return ready.promise; }, onStatus(status) {
            if (status.phase === 'checking') f.flow[action]();
        } });
        const request = f.flow.run(); context.enqueueReady(f.entries); await flush();
        assert.equal((await request).code, action === 'cancel' ? 'CANCELLED' : 'DISPOSED');
        assert.equal(f.calls.length, 0); assert.equal(context.enqueueReady(f.entries), 0);
        ready.resolve(); await flush(); assert.equal(f.calls.length, 0); assert.equal(f.clock.timers.size, 0); f.flow.dispose();
    }
});

test('dispose after an early completion closes discovery and ignores all late entries and prepare resolution', async () => {
    const ready = deferred(); let context;
    const f = fixture(2, { prepare(value) { context = value; return ready.promise; } });
    const request = f.flow.run(); context.enqueueReady([f.entries[0]]); await flush();
    f.flow.dispose(); const summary = await request, statuses = f.statuses.length;
    assert.equal(summary.code, 'DISPOSED'); assert.equal(summary.recovered, 1); assert.equal(summary.total, 2);
    assert.equal(context.enqueueReady(f.entries), 0);
    ready.resolve(); await flush(); assert.equal(f.statuses.length, statuses); assert.equal(f.calls.length, 2); assert.equal(f.clock.timers.size, 0);
});

test('isCurrent cancelling reentrantly cannot authorize a stale operation', async () => {
    let f;
    f = fixture(1, { isCurrent() { f.flow.cancel(); return true; } });
    const summary = await f.flow.run(); await flush();
    assert.equal(summary.code, 'CANCELLED'); assert.equal(f.calls.length, 0); assert.equal(f.clock.timers.size, 0); f.flow.dispose();
});
