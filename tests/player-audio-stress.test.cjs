const test = require('node:test');
const assert = require('node:assert/strict');
const { createLayoutAudioFlow } = require('../browser-extension/shared/layout-audio.js');

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function flush() { for (let index = 0; index < 220; index++) await Promise.resolve(); }
function clock() {
    let time = 0, next = 0; const jobs = new Map();
    return { get now() { return time; }, get pending() { return jobs.size; },
        setTimeout(callback, delay) { const id = ++next; jobs.set(id, { at: time + delay, callback }); return id; },
        clearTimeout(id) { jobs.delete(id); },
        async tick(ms) { const end = time + ms; for (;;) { await flush(); const due = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]; if (!due) break; time = due[1].at; jobs.delete(due[0]); due[1].callback(); } time = end; await flush(); }
    };
}
const player = (key, muted = true, volume = 0.3) => ({ key, identity: {}, version: 1, ready: true,
    state: { available: true, muted, volume, muteSupported: true, volumeSupported: true, muteGuardActive: false } });
function fixture(count = 3) {
    const f = { items: Array.from({ length: count }, (_, index) => player(`p${index}`, index === 0)), calls: [], reports: [], clock: clock(), hook: null };
    f.settings = { clock: f.clock, getEntries: () => f.items,
        isCurrent: item => f.items.some(value => value.key === item.key && value.identity === item.identity && value.version === item.version),
        read: async item => ({ ok: true, state: { ...f.items.find(value => value.key === item.key).state } }),
        write: async (item, command) => { const target = f.items.find(value => value.key === item.key); f.calls.push({ key: item.key, ...command });
            if (f.hook) await f.hook(item, command);
            target.state[command.action === 'setMuted' ? 'muted' : 'volume'] = command.value;
            if (command.action === 'setMuted') target.state.muteGuardActive = command.value && command.guard === true;
            return { ok: true, state: { ...target.state } }; },
        onStatus: status => f.reports.push(status) };
    f.flow = createLayoutAudioFlow(f.settings);
    f.focus = item => ({ focus: { key: item.key, identity: item.identity, element: item.element } });
    return f;
}

test('stress: expired focused restoration cannot reopen through a same-intent retry', async () => {
    const f = fixture(2), [a, b] = f.items;
    await f.flow.prepare(1); b.ready = false;
    assert.equal((await f.flow.restore(1, f.focus(a))).code, 'PENDING');
    await f.clock.tick(6000);
    assert.equal(f.reports.at(-1).code, 'TIMEOUT');
    b.ready = true; f.calls.length = 0;
    assert.equal((await f.flow.restore(1, f.focus(a))).code, 'TIMEOUT');
    assert.equal(a.state.muted, true);
    assert.equal(f.calls.length, 0);
    assert.equal(f.clock.pending, 0);
});

test('stress: ready peer appearing during final target confirmation is eventually guarded without another external event', async () => {
    const f = fixture(2), [a] = f.items, c = player('late-peer', false, 0.7);
    await f.flow.prepare(1);
    const read = f.settings.read; let targetReads = 0;
    f.settings.read = async item => { if (item.key === a.key && ++targetReads === 2) f.items.push(c); return read(item); };
    const initial = await f.flow.restore(1, f.focus(a));
    assert.notEqual(initial.code, 'COMPLETE');
    await f.clock.tick(1000);
    assert.equal(c.state.muted, true);
    assert.equal(c.state.muteGuardActive, true);
    assert.equal(a.state.muted, false);
    assert.equal(f.reports.at(-1).code, 'COMPLETE');
    assert.equal(f.clock.pending, 0);
});

test('stress: rejected guard support cannot count as an active mute guard', async () => {
    const f = fixture(2), [a, b] = f.items;
    await f.flow.prepare(1);
    const write = f.settings.write;
    f.settings.write = async (item, command) => { const result = await write(item, command); if (item.key === b.key && command.guard) { b.state.muteGuardActive = false; result.state.muteGuardActive = false; } return result; };
    assert.equal((await f.flow.restore(1, f.focus(a))).code, 'PARTIAL');
    assert.equal(a.state.muted, true);
    assert.equal(a.state.volume, 0.3);
    assert.equal(f.clock.pending, 0);
});

test('stress: a malformed write acknowledgment reports failure and releases every stage timer', async () => {
    const f = fixture(2), [a] = f.items;
    await f.flow.prepare(1);
    f.settings.write = async () => undefined;
    const result = await f.flow.restore(1, f.focus(a));
    assert.equal(result.code, 'PARTIAL');
    assert.equal(a.state.muted, true);
    assert.equal(f.clock.pending, 0);
});

test('stress: cancellation of a permanently stalled peer read releases the caller and all timers', async () => {
    const f = fixture(12), gate = deferred();
    await f.flow.prepare(1);
    f.settings.read = async () => gate.promise;
    const restoring = f.flow.restore(1, f.focus(f.items[0])); await flush();
    f.flow.cancel();
    assert.equal((await restoring).code, 'CANCELLED');
    assert.equal(f.clock.pending, 0);
    gate.resolve({ ok: true, state: { available: true, muted: false, volume: 1 } }); await flush();
    assert.equal(f.calls.length, 0);
});

test('stress: held target volume ACK and 75 rapid replacement intents retain only the latest opening', async () => {
    const f = fixture(8), gate = deferred();
    await f.flow.prepare(1); let entered = false;
    f.hook = async (item, command) => { if (!entered && item.key === 'p0' && command.action === 'setVolume') { entered = true; await gate.promise; } };
    const first = f.flow.restore(1, f.focus(f.items[0])); await flush(); assert.equal(entered, true);
    const preparing = [];
    for (let ticket = 2; ticket <= 76; ticket++) preparing.push(f.flow.prepare(ticket));
    await flush();
    assert.equal((await first).code, 'CANCELLED');
    gate.resolve();
    const results = await Promise.all(preparing);
    assert.equal(results.filter(result => result.code === 'CANCELLED').length, 74);
    assert.equal((await f.flow.restore(76, f.focus(f.items[7]))).code, 'COMPLETE');
    assert.deepEqual(f.items.filter(item => !item.state.muted).map(item => item.key), ['p7']);
    assert.equal(f.calls.some(call => call.key === 'p0' && call.action === 'setMuted' && call.value === false), false);
    assert.equal(f.clock.pending, 0);
});

test('stress: 120 seeded mixed-platform churn runs never open before current peers acknowledge guarded mute', async () => {
    for (let seed = 1; seed <= 120; seed++) {
        const f = fixture(2 + seed % 13), target = f.items[seed % f.items.length];
        target.state.muted = true;
        for (const [index, item] of f.items.entries()) item.state.volume = ((seed * 17 + index * 13) % 100) / 100;
        await f.flow.prepare(seed);
        let injected = false;
        f.hook = async (item, command) => {
            if (item.key === target.key && (command.action === 'setVolume' || command.action === 'setMuted' && command.value === false)) {
                for (const peer of f.items.filter(value => value !== target)) {
                    assert.equal(peer.state.muted, true, `seed ${seed}: ${peer.key} not muted before ${command.action}`);
                    assert.equal(peer.state.muteGuardActive, true, `seed ${seed}: ${peer.key} not guarded`);
                }
            }
            if (!injected && item.key !== target.key && command.guard) {
                injected = true;
                if (seed % 3 === 0) f.items.push(player(`new-${seed}`, false, 0.4));
                if (seed % 5 === 0) { const peer = f.items.find(value => value !== target && value.key !== item.key); if (peer) { peer.version++; peer.state.muted = false; peer.state.muteGuardActive = false; } }
            }
        };
        const result = await f.flow.restore(seed, f.focus(target));
        if (result.code === 'PENDING') await f.clock.tick(1000);
        assert.equal(f.reports.at(-1).code, 'COMPLETE', `seed ${seed} did not finish`);
        assert.deepEqual(f.items.filter(item => !item.state.muted).map(item => item.key), [target.key], `seed ${seed}`);
        assert.equal(target.state.volume, 1, `seed ${seed}`);
        assert.ok(f.calls.length <= 4 * f.items.length + 5, `seed ${seed}: unbounded commands`);
        assert.equal(f.clock.pending, 0, `seed ${seed}: leaked timer`);
    }
});

test('stress: 50 timed-out replacement captures share at most four permanently stalled reads', async () => {
    const f = fixture(40), gate = deferred(); let outstanding = 0, peak = 0, requested = 0;
    f.settings.read = async () => { requested++; outstanding++; peak = Math.max(peak, outstanding); await gate.promise; outstanding--; return { ok: true, state: { available: true, muted: false, volume: 0.2 } }; };
    for (let ticket = 1; ticket <= 50; ticket++) {
        const preparing = f.flow.prepare(ticket); await flush(); await f.clock.tick(2500);
        assert.equal((await preparing).code, 'PARTIAL');
        assert.equal(f.clock.pending, 0);
        assert.equal(requested, 4);
    }
    f.flow.cancel(); gate.resolve(); await flush();
    assert.equal(outstanding, 0); assert.equal(peak, 4);
    assert.equal(f.calls.length, 0); assert.equal(f.clock.pending, 0);
});

test('stress: a timed-out held peer write cannot start queued target writes after its late acknowledgment', async () => {
    const f = fixture(12), [a] = f.items, gate = deferred(); let entered = false;
    await f.flow.prepare(1);
    f.hook = async (item, command) => { if (!entered && item !== a && command.guard) { entered = true; await gate.promise; } };
    const restoring = f.flow.restore(1, f.focus(a)); await flush(); assert.equal(entered, true);
    await f.clock.tick(6000); assert.equal((await restoring).code, 'TIMEOUT');
    const count = f.calls.length;
    assert.equal(f.calls.some(call => call.key === a.key), false);
    assert.equal(f.clock.pending, 0);
    gate.resolve(); await f.flow.settle(); await flush();
    assert.equal(f.calls.length, count);
    assert.equal(a.state.muted, true); assert.equal(a.state.volume, 0.3);
    assert.equal(f.clock.pending, 0);
});

test('stress: duplicate peer keys and malformed identities fail closed with bounded commands', async () => {
    for (const corruption of ['duplicate', 'empty', 'null', 'not-iterable']) {
        const f = fixture(3), [a] = f.items;
        await f.flow.prepare(corruption);
        if (corruption === 'duplicate') f.items.push(player('p1', false));
        if (corruption === 'empty') f.items.push(player(' ', false));
        if (corruption === 'null') f.items.push(null);
        if (corruption === 'not-iterable') f.settings.getEntries = () => ({});
        const result = await f.flow.restore(corruption, f.focus(a));
        assert.notEqual(result.code, 'COMPLETE', corruption);
        assert.equal(f.calls.some(call => call.key === a.key && (call.action === 'setVolume' || call.value === false)), false, corruption);
        assert.ok(f.calls.length <= 3, corruption);
        assert.equal(f.clock.pending, 0, corruption);
    }
});

test('stress: target identity replacement during held peer ACK never inherits an earlier opening request', async () => {
    const f = fixture(3), [a] = f.items, gate = deferred(); let held = false;
    await f.flow.prepare(1);
    f.hook = async (item, command) => { if (!held && item.key !== a.key && command.guard) { held = true; await gate.promise; } };
    const restoring = f.flow.restore(1, f.focus(a)); await flush(); assert.equal(held, true);
    const replacement = player(a.key, false, 0.8); f.items[0] = replacement;
    gate.resolve();
    const result = await restoring;
    if (result.code === 'PENDING') await f.clock.tick(1000);
    assert.equal(f.reports.at(-1).code, 'PARTIAL');
    assert.equal(replacement.state.muted, true);
    assert.equal(replacement.state.volume, 0.3);
    assert.equal(f.calls.some(call => call.key === a.key && (call.action === 'setMuted' && call.value === false || call.action === 'setVolume' && call.value === 1)), false);
    assert.equal(f.clock.pending, 0);
});

function hiddenControllerFixture(fakeClock, { populated = true, observable = false } = {}) {
    const { createMediaController } = require('../browser-extension/shared/media-controller.js');
    const observed = new Set();
    const view = new EventTarget();
    Object.assign(view, { innerWidth: 1280, innerHeight: 720, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) });
    if (observable) view.MutationObserver = class {
        observe(target) { observed.add(target); }
        takeRecords() { return []; }
        disconnect() { observed.clear(); }
    };
    const media = new EventTarget();
    Object.assign(media, { tagName: 'AUDIO', isConnected: true, hidden: true, muted: false, volume: 0.63, paused: false, ended: false, readyState: 4, error: null,
        getBoundingClientRect: () => ({ width: 640, height: 360, left: 0, top: 0 }), querySelectorAll: () => [], play() { throw new Error('No playback changes allowed'); } });
    const doc = new EventTarget();
    Object.assign(doc, { defaultView: view, documentElement: { clientWidth: 1280, clientHeight: 720 }, querySelectorAll: () => populated ? [media] : [] });
    const controller = createMediaController({ document: doc, clock: fakeClock });
    return { controller, media, observed };
}

test('stress: real media controller can guard a hidden-only peer reporting NO_MEDIA before target opens', async () => {
    const f = fixture(2), [a, b] = f.items, hidden = hiddenControllerFixture(f.clock, { observable: true });
    b.ready = false; b.readable = true;
    const initial = hidden.controller.getState();
    assert.equal(initial.ok, false); assert.equal(initial.code, 'NO_MEDIA');
    assert.equal(initial.state.available, false); assert.equal(initial.state.muteSupported, false);
    const read = f.settings.read, write = f.settings.write;
    f.settings.read = item => item.key === b.key ? hidden.controller.getState() : read(item);
    f.settings.write = async (item, command) => {
        if (item.key !== b.key) return write(item, command);
        f.calls.push({ key: item.key, ...command });
        return hidden.controller.execute(command);
    };
    await f.flow.prepare(1);
    const result = await f.flow.restore(1, f.focus(a));
    assert.equal(result.code, 'COMPLETE');
    assert.equal(hidden.media.muted, true); assert.equal(hidden.media.volume, 0.63);
    assert.equal(a.state.muted, false); assert.equal(a.state.volume, 1);
    assert.deepEqual(f.calls.filter(call => call.key === b.key), [{ key: b.key, action: 'setMuted', value: true, guard: true }]);
    assert.equal(hidden.controller.getState().state.available, false);
    assert.equal(hidden.controller.getState().state.muteGuardActive, true);
    assert.equal(hidden.observed.size, 1, 'the complete hidden-media inventory has a registered observer');
    hidden.controller.dispose(); f.flow.cancel(); assert.equal(f.clock.pending, 0);
});

test('stress: muting known hidden media without observers cannot claim silence for every possible peer route', async () => {
    const f = fixture(2), [a, b] = f.items, hidden = hiddenControllerFixture(f.clock);
    b.ready = false; b.readable = true;
    const guard = await hidden.controller.execute({ action: 'setMuted', value: true, guard: true });
    assert.equal(hidden.media.muted, true, 'the directly known route is muted');
    assert.equal(guard.ok, false); assert.equal(guard.code, 'NOT_APPLIED');
    assert.equal(guard.state.muted, null); assert.equal(guard.state.muteSupported, false);
    assert.equal(guard.state.muteGuardActive, true); assert.equal(guard.state.emptyGuardConfirmed, false);
    assert.equal(hidden.observed.size, 0);
    const read = f.settings.read, write = f.settings.write;
    f.settings.read = item => item.key === b.key ? hidden.controller.getState() : read(item);
    f.settings.write = async (item, command) => item.key === b.key ? hidden.controller.execute(command) : write(item, command);
    await f.flow.prepare(1);
    assert.equal((await f.flow.restore(1, f.focus(a))).code, 'PARTIAL');
    assert.equal(a.state.muted, true); assert.equal(a.state.volume, 0.3);
    assert.equal(f.calls.some(call => call.key === a.key && (call.action === 'setVolume' || call.value === false)), false);
    hidden.controller.dispose(); f.flow.cancel(); assert.equal(f.clock.pending, 0);
});

test('stress: an empty NO_MEDIA peer cannot claim confirmed silence merely by arming an empty guard', async () => {
    const f = fixture(2), [a, b] = f.items, hidden = hiddenControllerFixture(f.clock, { populated: false });
    b.ready = false; b.readable = true;
    const read = f.settings.read, write = f.settings.write;
    f.settings.read = item => item.key === b.key ? hidden.controller.getState() : read(item);
    f.settings.write = async (item, command) => item.key === b.key ? hidden.controller.execute(command) : write(item, command);
    await f.flow.prepare(1);
    assert.equal((await f.flow.restore(1, f.focus(a))).code, 'PARTIAL');
    assert.equal(a.state.muted, true); assert.equal(a.state.volume, 0.3);
    assert.equal(hidden.controller.getState().state.muted, null);
    hidden.controller.dispose(); f.flow.cancel(); assert.equal(f.clock.pending, 0);
});

test('stress: hidden-only target still cannot be opened through peer guard fallback', async () => {
    const f = fixture(2), [a] = f.items, hidden = hiddenControllerFixture(f.clock, { observable: true });
    a.ready = false; a.readable = true;
    const read = f.settings.read, write = f.settings.write;
    f.settings.read = item => item.key === a.key ? hidden.controller.getState() : read(item);
    f.settings.write = async (item, command) => {
        if (item.key !== a.key) return write(item, command);
        f.calls.push({ key: item.key, ...command }); return hidden.controller.execute(command);
    };
    await f.flow.prepare(1);
    assert.equal((await f.flow.restore(1, f.focus(a))).code, 'PARTIAL');
    assert.equal(f.calls.some(call => call.key === a.key), false);
    assert.equal(hidden.media.volume, 0.63);
    hidden.controller.dispose(); f.flow.cancel(); assert.equal(f.clock.pending, 0);
});
