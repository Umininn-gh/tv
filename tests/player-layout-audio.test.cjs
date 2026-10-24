const test = require('node:test');
const assert = require('node:assert/strict');
const { createLayoutAudioFlow } = require('../browser-extension/shared/layout-audio.js');

function deferred() {
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
async function flush() { for (let index = 0; index < 160; index++) await Promise.resolve(); }
function fakeClock() {
    let time = 0, next = 0;
    const jobs = new Map();
    return {
        get now() { return time; },
        setTimeout(callback, delay) { const id = ++next; jobs.set(id, { at: time + delay, callback }); return id; },
        clearTimeout(id) { jobs.delete(id); },
        get pending() { return jobs.size; },
        async tick(ms) {
            const end = time + ms;
            for (;;) {
                await flush();
                const job = [...jobs].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
                if (!job) break;
                time = job[1].at; jobs.delete(job[0]); job[1].callback();
            }
            time = end;
            await flush();
        }
    };
}
function player(key, muted, volume, ready = true) {
    return { key, identity: {}, version: 1, ready, state: { available: true, muted, volume, muteSupported: true, volumeSupported: true } };
}
function fixture(initial) {
    const clock = fakeClock(), calls = [], reports = [];
    let items = initial;
    const settings = {
        clock,
        getEntries: () => items,
        isCurrent: item => items.some(value => value.key === item.key && value.identity === item.identity && value.version === item.version),
        read: async item => ({ ok: true, state: { ...items.find(value => value.key === item.key).state } }),
        write: async (item, command) => {
            calls.push({ key: item.key, ...command });
            const target = items.find(value => value.key === item.key);
            target.state[command.action === 'setMuted' ? 'muted' : 'volume'] = command.value;
            if (command.action === 'setMuted' && ownGuard(command)) target.state.muteGuardActive = command.value && command.guard === true;
            return { ok: true, state: { ...target.state } };
        },
        onStatus: status => reports.push(status)
    };
    const flow = createLayoutAudioFlow(settings);
    return { flow, clock, calls, reports, settings, get items() { return items; }, set items(value) { items = value; } };
}
function ownGuard(command) { return command.guard === true || command.value === false; }
function focus(item) { return { focus: { key: item.key, identity: item.identity, element: item.element } }; }

test('preserves distinct channel audio by key, including false and zero, after position changes', async () => {
    const a = player('twitch|a', false, 0), b = player('kick|b', true, 0.27);
    const f = fixture([a, b]);
    assert.equal((await f.flow.prepare('one')).captured, 2);
    a.state.muted = true; a.state.volume = 1;
    b.state.muted = false; b.state.volume = 1;
    f.items = [b, a];
    const result = await f.flow.restore('one');
    assert.equal(result.code, 'COMPLETE');
    assert.equal(a.state.muted, false); assert.equal(a.state.volume, 0);
    assert.equal(b.state.muted, true); assert.equal(b.state.volume, 0.27);
    assert.equal(f.calls[0].key, b.key);
    assert.deepEqual(f.calls[0], { key: b.key, action: 'setMuted', value: true });
    const open = f.calls.findIndex(item => item.action === 'setMuted' && item.value === false);
    assert.equal(open, f.calls.length - 1);
    assert.equal(f.clock.pending, 0);
});

test('fresh prepare reads supersede stale entry.state rather than saving the cache', async () => {
    const a = player('native|a', true, 1), f = fixture([a]);
    f.settings.read = async () => ({ ok: true, state: { muted: false, volume: 0.36 } });
    await f.flow.prepare(1);
    f.settings.read = async () => ({ ok: true, state: { ...a.state } });
    await f.flow.restore(1);
    assert.equal(a.state.muted, false); assert.equal(a.state.volume, 0.36);
});

test('pure CSS changes with unchanged audio issue no writes', async () => {
    const f = fixture([player('native|a', false, 0.46), player('native|b', true, 1)]);
    await f.flow.prepare(1);
    f.items.reverse();
    assert.equal((await f.flow.restore(1)).code, 'COMPLETE');
    assert.deepEqual(f.calls, []);
    assert.equal(f.clock.pending, 0);
});

test('same-key replacement during the layout may bind once, while new channels receive no writes', async () => {
    const f = fixture([player('kick|a', false, 0.4)]);
    await f.flow.prepare(1);
    f.items = [player('kick|new', false, 0.9), player('kick|a', true, 1)];
    assert.equal((await f.flow.restore(1)).code, 'COMPLETE');
    assert.deepEqual(f.calls.map(item => item.key), ['kick|a', 'kick|a']);
    assert.equal(f.items[0].state.volume, 0.9);
    assert.equal(f.items[1].state.volume, 0.4); assert.equal(f.items[1].state.muted, false);
});

test('loading documents may change before their first ready lease, then restore on notify', async () => {
    const f = fixture([player('twitch|a', true, 0.12)]);
    await f.flow.prepare(1);
    f.items = [player('twitch|a', false, 1, false)];
    assert.equal((await f.flow.restore(1)).code, 'PENDING');
    assert.equal(f.calls.length, 0);
    f.items[0].version++;
    f.items[0].ready = true;
    f.flow.notify();
    await flush();
    assert.equal(f.items[0].state.muted, true); assert.equal(f.items[0].state.volume, 0.12);
    assert.equal(f.clock.pending, 0);
});

test('a lease change after a write starts prevents subsequent volume or unmute writes', async () => {
    const a = player('kick|a', true, 0.35), f = fixture([a]);
    await f.flow.prepare(1);
    a.state.muted = false; a.state.volume = 1;
    const gate = deferred(), original = f.settings.write;
    f.settings.write = async (...args) => { await gate.promise; return original(...args); };
    const restoring = f.flow.restore(1);
    await flush();
    a.version++;
    gate.resolve();
    const result = await restoring;
    assert.equal(result.code, 'PARTIAL');
    assert.equal(result.results[0].status, 'stale');
    assert.deepEqual(f.calls.map(item => item.action), ['setMuted']);
});

test('removed channels never reappear from a pending snapshot', async () => {
    const a = player('kick|a', true, 0.3), f = fixture([a]);
    await f.flow.prepare(1);
    a.ready = false;
    await f.flow.restore(1);
    f.items = [];
    f.flow.notify(); await flush();
    f.items = [player(a.key, false, 1)];
    f.flow.notify(); await f.clock.tick(2000);
    assert.deepEqual(f.calls, []);
    assert.equal(f.clock.pending, 0);
});

test('unknown and unsupported audio fields are skipped independently without guessing false or zero', async () => {
    const a = player('native|a', false, 0.6), b = player('native|b', true, 0.2), c = player('native|c', false, 0.4);
    a.state.muted = null; b.state.volume = NaN; c.state.muteSupported = false; c.state.volumeSupported = false;
    const f = fixture([a, b, c]);
    const prepared = await f.flow.prepare(1);
    assert.equal(prepared.captured, 2); assert.equal(prepared.skipped, 1);
    a.state.muted = true; a.state.volume = 1;
    b.state.muted = false; b.state.volume = 1;
    c.state.muted = true; c.state.volume = 1;
    await f.flow.restore(1);
    assert.deepEqual(f.calls, [
        { key: b.key, action: 'setMuted', value: true },
        { key: a.key, action: 'setVolume', value: 0.6 }
    ]);
    assert.equal(a.state.muted, true); assert.equal(b.state.volume, 1);
});

test('capture deadline bounds stalled reads, and read capacity is shared across replacements', async () => {
    const f = fixture(Array.from({ length: 9 }, (_, index) => player(`native|${index}`, false, 0.2)));
    const gate = deferred(); let reads = 0;
    f.settings.read = async () => { reads++; return gate.promise; };
    const first = f.flow.prepare(1);
    await flush(); assert.equal(reads, 4);
    await f.clock.tick(2500);
    assert.equal((await first).code, 'PARTIAL');
    const second = f.flow.prepare(2);
    await flush(); assert.equal(reads, 4);
    await f.clock.tick(2500);
    assert.equal((await second).code, 'PARTIAL');
    f.flow.cancel(); gate.resolve({ ok: true, state: { muted: false, volume: 0.2 } }); await flush();
    assert.equal(f.clock.pending, 0);
});

test('cancel promptly releases capture waits and never applies late reads', async () => {
    const f = fixture([player('kick|a', false, 0.2)]), gate = deferred();
    f.settings.read = () => gate.promise;
    const capture = f.flow.prepare(1);
    await flush(); f.flow.cancel();
    assert.equal((await capture).code, 'CANCELLED');
    gate.resolve({ ok: true, state: { muted: false, volume: 0.2 } }); await flush();
    assert.equal((await f.flow.restore(1)).code, 'CANCELLED');
    assert.deepEqual(f.calls, []); assert.equal(f.clock.pending, 0);
});

test('late restore is bounded to thirty seconds with one poll per second and no resurrection', async () => {
    const a = player('twitch|a', true, 0.2), f = fixture([a]);
    await f.flow.prepare(1); a.ready = false;
    await f.flow.restore(1);
    assert.equal(f.clock.pending, 2);
    await f.clock.tick(30000);
    assert.equal(f.reports.at(-1).code, 'TIMEOUT'); assert.equal(f.clock.pending, 0);
    a.ready = true; a.state.muted = false; a.state.volume = 1;
    f.flow.notify(); await flush();
    assert.deepEqual(f.calls, []);
});

test('a repeated restore rechecks the same sound snapshot after playback recovery', async () => {
    const a = player('twitch|a', false, 0.24), f = fixture([a]);
    await f.flow.prepare(1);
    await f.flow.restore(1);
    a.state.muted = true; a.state.volume = 1;
    assert.equal((await f.flow.restore(1)).code, 'COMPLETE');
    assert.equal(a.state.muted, false); assert.equal(a.state.volume, 0.24);
    assert.equal(f.calls.length, 2); assert.equal(f.clock.pending, 0);
    await f.flow.restore(1);
    assert.equal(f.calls.length, 2);
});

test('repeated restores do not extend the original thirty-second loading deadline', async () => {
    const a = player('twitch|a', true, 0.2), f = fixture([a]);
    await f.flow.prepare(1); a.ready = false;
    await f.flow.restore(1);
    await f.clock.tick(29000);
    await f.flow.restore(1);
    await f.clock.tick(1000);
    assert.equal(f.reports.at(-1).code, 'TIMEOUT');
    assert.equal(f.clock.pending, 0);
});

test('ready sound can be rechecked after the initial late-loading deadline has elapsed', async () => {
    const a = player('twitch|a', false, 0.2), f = fixture([a]);
    await f.flow.prepare(1); await f.flow.restore(1);
    await f.clock.tick(31000);
    a.state.muted = true; a.state.volume = 1;
    assert.equal((await f.flow.restore(1)).code, 'COMPLETE');
    assert.equal(a.state.muted, false); assert.equal(a.state.volume, 0.2);
    assert.equal(f.clock.pending, 0);
});

test('quick successive prepares carry unfinished desired sound and serialize late old writes', async () => {
    const a = player('native|a', false, 0.2), f = fixture([a]), gate = deferred();
    await f.flow.prepare(1);
    a.state.muted = true; a.state.volume = 1;
    const original = f.settings.write; let entered = 0;
    f.settings.write = async (...args) => { entered++; if (entered === 1) await gate.promise; return original(...args); };
    const first = f.flow.restore(1); await flush();
    assert.equal(entered, 1);
    const second = f.flow.prepare(2); await flush();
    assert.equal((await first).code, 'CANCELLED');
    assert.equal(entered, 1);
    gate.resolve(); await flush(); await second;
    assert.equal((await f.flow.restore(2)).code, 'COMPLETE');
    assert.equal(a.state.volume, 0.2); assert.equal(a.state.muted, false);
    assert.equal(f.calls.filter(item => item.action === 'setVolume').length, 1);
});

test('after a completed restore the next prepare captures newly chosen audio', async () => {
    const a = player('native|a', false, 0.2), f = fixture([a]);
    await f.flow.prepare(1); await f.flow.restore(1);
    a.state.muted = true; a.state.volume = 0.72;
    await f.flow.prepare(2);
    a.state.muted = false; a.state.volume = 1;
    await f.flow.restore(2);
    assert.equal(a.state.muted, true); assert.equal(a.state.volume, 0.72);
});

test('manual cancel clears desired sound and settle waits for actual issued writes', async () => {
    const a = player('native|a', false, 0.2), f = fixture([a]), gate = deferred();
    await f.flow.prepare(1);
    a.state.muted = true; a.state.volume = 1;
    const original = f.settings.write;
    f.settings.write = async (...args) => { await gate.promise; return original(...args); };
    const restoring = f.flow.restore(1); await flush();
    f.flow.cancel();
    assert.equal((await restoring).code, 'CANCELLED');
    let settled = false;
    const settling = f.flow.settle().then(() => { settled = true; }); await flush();
    assert.equal(settled, false);
    gate.resolve(); await settling;
    a.state.muted = true; a.state.volume = 0.81;
    await f.flow.prepare(2);
    a.state.muted = false; a.state.volume = 1;
    await f.flow.restore(2);
    assert.equal(a.state.muted, true); assert.equal(a.state.volume, 0.81);
});

test('failed required mute withholds every new unmute in that round', async () => {
    const a = player('kick|a', false, 0.3), b = player('kick|b', true, 0.4), f = fixture([a, b]);
    await f.flow.prepare(1);
    a.state.muted = true; b.state.muted = false;
    f.settings.write = async (item, command) => {
        f.calls.push({ key: item.key, ...command });
        return { ok: false, state: { ...f.items.find(value => value.key === item.key).state } };
    };
    await f.flow.restore(1); await f.clock.tick(1000);
    assert.equal(a.state.muted, true);
    assert.equal(f.calls.some(item => item.action === 'setMuted' && item.value === false), false);
    assert.equal(f.clock.pending, 0);
});

test('a late required-mute channel blocks new unmute until that channel is confirmed safe', async () => {
    const a = player('kick|a', false, 0.3), b = player('kick|b', true, 0.4), f = fixture([a, b]);
    await f.flow.prepare(1);
    a.state.muted = true; b.state.muted = false; b.ready = false;
    assert.equal((await f.flow.restore(1)).code, 'PENDING');
    assert.equal(a.state.muted, true);
    b.ready = true; f.flow.notify(); await flush();
    assert.equal(b.state.muted, true); assert.equal(a.state.muted, false);
    assert.deepEqual(f.calls.filter(item => item.action === 'setMuted').map(item => [item.key, item.value]), [[b.key, true], [a.key, false]]);
    assert.equal(f.clock.pending, 0);
});

test('read and write notifications do not recursively create an endless restore pass', async () => {
    const a = player('kick|a', false, 0.3), b = player('kick|b', true, 0.4), f = fixture([a, b]);
    let readCount = 0;
    const originalRead = f.settings.read, originalWrite = f.settings.write;
    f.settings.read = async item => { readCount++; f.flow.notify(); return originalRead(item); };
    f.settings.write = async (...args) => { f.flow.notify(); return originalWrite(...args); };
    await f.flow.prepare(1);
    a.state.muted = true; a.state.volume = 1; b.state.muted = false;
    await f.flow.restore(1); await f.clock.tick(5000);
    assert.equal(readCount, 4); assert.equal(f.calls.length, 3); assert.equal(f.clock.pending, 0);
});

test('duplicate ambiguous keys never receive another channel audio', async () => {
    const a = player('native|a', false, 0.3), b = player('native|a', true, 1), f = fixture([a, b]);
    assert.equal((await f.flow.prepare(1)).captured, 0);
    await f.flow.restore(1);
    assert.deepEqual(f.calls, []);
});

test('cancelling a live restore drops queued writes before they can reach a player', async () => {
    const f = fixture([player('native|a', true, 0.2), player('native|b', true, 0.3)]), gate = deferred();
    await f.flow.prepare(1);
    f.items.forEach(item => { item.state.muted = false; item.state.volume = 1; });
    const original = f.settings.write; let entered = 0;
    f.settings.write = async (...args) => { entered++; await gate.promise; return original(...args); };
    const restoring = f.flow.restore(1); await flush();
    f.flow.cancel();
    assert.equal((await restoring).code, 'CANCELLED');
    gate.resolve(); await f.flow.settle(); await flush();
    assert.equal(entered, 1); assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].action, 'setMuted');
});

test('failed mute cannot be followed by a louder volume on the still-audible channel', async () => {
    const a = player('kick|a', true, 0.9), f = fixture([a]);
    await f.flow.prepare(1);
    a.state.muted = false; a.state.volume = 0.1;
    f.settings.write = async (item, command) => {
        f.calls.push({ key: item.key, ...command });
        return { ok: false, state: { ...a.state } };
    };
    assert.equal((await f.flow.restore(1)).code, 'PARTIAL');
    assert.deepEqual(f.calls, [{ key: a.key, action: 'setMuted', value: true }]);
    assert.equal(a.state.volume, 0.1);
});

test('a restore read that never responds reaches its deadline and late replies cannot write', async () => {
    const a = player('kick|a', false, 0.2), f = fixture([a]), gate = deferred();
    await f.flow.prepare(1);
    a.state.muted = true; a.state.volume = 1;
    f.settings.read = () => gate.promise;
    const restoring = f.flow.restore(1); await flush();
    await f.clock.tick(30000);
    assert.equal((await restoring).code, 'TIMEOUT');
    assert.equal(f.clock.pending, 0);
    gate.resolve({ ok: true, state: { ...a.state } }); await flush();
    assert.deepEqual(f.calls, []);
});

test('rechecking an unready target after its original deadline returns timeout without timers', async () => {
    const a = player('kick|a', false, 0.2), f = fixture([a]);
    await f.flow.prepare(1); await f.flow.restore(1);
    await f.clock.tick(31000); a.ready = false;
    assert.equal((await f.flow.restore(1)).code, 'TIMEOUT');
    assert.equal(f.clock.pending, 0);
});

test('write acknowledgements confirm mute without requiring the caller to update its entry cache', async () => {
    const a = player('kick|a', false, 0.2), b = player('kick|b', true, 0.3), f = fixture([a, b]);
    await f.flow.prepare(1);
    a.state.muted = true; b.state.muted = false;
    const actual = new Map(f.items.map(item => [item.key, { ...item.state }]));
    f.settings.write = async (item, command) => {
        f.calls.push({ key: item.key, ...command });
        actual.get(item.key)[command.action === 'setMuted' ? 'muted' : 'volume'] = command.value;
        return { ok: true, state: { ...actual.get(item.key) } };
    };
    assert.equal((await f.flow.restore(1)).code, 'COMPLETE');
    assert.deepEqual(f.calls, [{ key: b.key, action: 'setMuted', value: true }, { key: a.key, action: 'setMuted', value: false }]);
});

test('volume setters that clear mute are repaired before another channel opens sound', async () => {
    const a = player('kick|a', false, 0.2), b = player('kick|b', true, 0.3), f = fixture([a, b]);
    await f.flow.prepare(1);
    a.state.muted = true; b.state.muted = false; b.state.volume = 1;
    const original = f.settings.write;
    f.settings.write = async (item, command) => {
        const result = await original(item, command);
        if (item.key === b.key && command.action === 'setVolume') { b.state.muted = false; result.state.muted = false; }
        return result;
    };
    assert.equal((await f.flow.restore(1)).code, 'COMPLETE');
    assert.equal(b.state.muted, true); assert.equal(a.state.muted, false);
    assert.deepEqual(f.calls.map(item => [item.key, item.action, item.value]), [
        [b.key, 'setMuted', true], [b.key, 'setVolume', 0.3], [b.key, 'setMuted', true], [a.key, 'setMuted', false]
    ]);
});

test('an unmute that resets volume is reported partial rather than claiming exact restoration', async () => {
    const a = player('kick|a', false, 0.2), f = fixture([a]);
    await f.flow.prepare(1);
    a.state.muted = true;
    const original = f.settings.write;
    f.settings.write = async (item, command) => {
        const result = await original(item, command);
        if (command.action === 'setMuted' && command.value === false) { a.state.volume = 1; result.state.volume = 1; }
        return result;
    };
    assert.equal((await f.flow.restore(1)).code, 'PARTIAL');
    assert.equal(f.clock.pending, 0);
    assert.equal(f.calls.length, 1);
    // A second explicit calibration repairs the changed property only.
    assert.equal((await f.flow.restore(1)).code, 'COMPLETE');
    assert.equal(a.state.volume, 0.2);
});

test('focus overlays the snapshot before writes: only the target opens at full volume', async () => {
    const a = player('angel|a', false, 0.21), b = player('kick|b', false, 0.73), f = fixture([a, b]);
    await f.flow.prepare(1);
    a.state.muted = true; a.state.volume = 0.48;
    b.state.volume = 0.95;
    const result = await f.flow.restore(1, focus(a));
    assert.equal(f.flow.focusSupported, true);
    assert.equal(result.code, 'COMPLETE');
    assert.equal(a.state.muted, false); assert.equal(a.state.volume, 1);
    assert.equal(b.state.muted, true); assert.equal(b.state.volume, 0.73);
    assert.equal(b.state.muteGuardActive, true);
    assert.equal(f.calls.some(call => call.key === a.key && call.action === 'setVolume' && call.value === 0.21), false);
    assert.equal(f.calls.some(call => call.key === b.key && call.action === 'setMuted' && call.value === false), false);
    const targetWrites = f.calls.filter(call => call.key === a.key);
    assert.deepEqual(targetWrites, [
        { key: a.key, action: 'setVolume', value: 1, focus: true }, { key: a.key, action: 'setMuted', value: false, focus: true }
    ]);
    assert.equal(f.clock.pending, 0);
});

test('a held peer mute ACK prevents both target volume increase and target unmute', async () => {
    const a = player('twitch|a', true, 0.2), b = player('kick|b', false, 0.7), f = fixture([a, b]), gate = deferred();
    await f.flow.prepare(1);
    const original = f.settings.write; let peerMuteStarted = false;
    f.settings.write = async (item, command) => {
        if (item.key === b.key && command.action === 'setMuted' && command.value === true) {
            peerMuteStarted = true; await gate.promise;
        }
        return original(item, command);
    };
    const restoring = f.flow.restore(1, focus(a)); await flush();
    assert.equal(peerMuteStarted, true);
    assert.equal(f.calls.some(call => call.key === a.key), false);
    gate.resolve();
    assert.equal((await restoring).code, 'COMPLETE');
    assert.equal(a.state.volume, 1); assert.equal(a.state.muted, false); assert.equal(b.state.muted, true);
});

test('an uncaptured peer remains in the safety cohort and withholds target sound', async () => {
    const a = player('twitch|a', false, 0.2), b = player('kick|b', false, 0.7), f = fixture([a, b]);
    b.state = { available: true, muteSupported: false, volumeSupported: false };
    assert.equal((await f.flow.prepare(1)).captured, 1);
    const result = await f.flow.restore(1, focus(a));
    assert.equal(result.code, 'PARTIAL');
    assert.equal(a.state.muted, true);
    assert.equal(f.calls.some(call => call.key === a.key && (call.action === 'setVolume' || call.value === false)), false);
    assert.equal(result.results.some(record => record.key === b.key && record.status === 'failed'), true);
    assert.equal(f.clock.pending, 0);
});

test('late peer readiness and readable busy peers are guarded before opening the target', async () => {
    const a = player('twitch|a', true, 0.2), b = player('kick|b', false, 0.7), f = fixture([a, b]);
    await f.flow.prepare(1); b.ready = false;
    assert.equal((await f.flow.restore(1, focus(a))).code, 'PENDING');
    assert.deepEqual(f.calls, []);
    // The site marks an SDK/iframe readable even while another command keeps
    // its generic UI readiness false. Its mute guard must not wait for that UI.
    b.readable = true;
    f.flow.notify(); await flush();
    assert.equal(f.reports.at(-1).code, 'COMPLETE');
    assert.equal(b.state.muted, true); assert.equal(b.state.muteGuardActive, true);
    assert.equal(a.state.muted, false); assert.equal(a.state.volume, 1);
    assert.equal(f.clock.pending, 0);
});

test('a late target waits for readiness without opening a same-key replacement', async () => {
    const a = player('twitch|a', true, 0.2), b = player('kick|b', true, 0.7), f = fixture([a, b]);
    b.state.muteGuardActive = true;
    await f.flow.prepare(1); a.ready = false;
    assert.equal((await f.flow.restore(1, focus(a))).code, 'PENDING');
    a.ready = true; f.flow.notify(); await flush();
    assert.equal(f.reports.at(-1).code, 'COMPLETE');
    assert.equal(a.state.muted, false); assert.equal(a.state.volume, 1);
    const replacement = player(a.key, false, 0.36);
    f.items = [replacement, b]; f.calls.length = 0;
    assert.equal((await f.flow.restore(1)).code, 'PARTIAL');
    assert.equal(replacement.state.muted, true);
    assert.equal(f.calls.some(call => call.key === a.key && (call.action === 'setVolume' && call.value === 1 || call.value === false)), false);
});

test('focused repair is a no-op when target and guarded peers already match', async () => {
    const a = player('twitch|a', false, 1), b = player('kick|b', true, 0.7), f = fixture([a, b]);
    b.state.muteGuardActive = true;
    await f.flow.prepare(1);
    assert.equal((await f.flow.restore(1, focus(a))).code, 'COMPLETE');
    assert.equal((await f.flow.restore(1)).code, 'COMPLETE');
    assert.deepEqual(f.calls, []); assert.equal(f.clock.pending, 0);
    b.state.muted = false; b.state.muteGuardActive = false;
    await f.flow.restore(1);
    assert.equal(b.state.muted, true); assert.equal(a.state.muted, false);
    assert.equal(a.state.volume, 1); assert.equal(f.clock.pending, 0);
});

test('beforeOpen drains old audio only after peers are muted, then rechecks new peers', async () => {
    const a = player('twitch|a', true, 0.2), b = player('kick|b', false, 0.7), f = fixture([a, b]), gate = deferred();
    await f.flow.prepare(1);
    let entered = false;
    const restoring = f.flow.restore(1, { ...focus(a), beforeOpen: async () => { entered = true; await gate.promise; } });
    await flush();
    assert.equal(entered, true); assert.equal(b.state.muted, true);
    assert.equal(a.state.volume, 0.2); assert.equal(a.state.muted, true);
    const c = player('native|c', false, 0.38); f.items.push(c);
    // An older manual operation also cleared an already-confirmed peer.
    b.state.muted = false; b.state.muteGuardActive = false;
    gate.resolve();
    assert.equal((await restoring).code, 'COMPLETE');
    assert.equal(b.state.muted, true); assert.equal(c.state.muted, true);
    assert.equal(a.state.volume, 1); assert.equal(a.state.muted, false);
    assert.equal(f.calls.findIndex(call => call.key === c.key), f.calls.findIndex(call => call.key === c.key && call.value === true));
    assert.ok(f.calls.findIndex(call => call.key === c.key) < f.calls.findIndex(call => call.key === a.key && call.action === 'setVolume'));
});

test('cancel breaks a beforeOpen wait and never opens the old focused target', async () => {
    const a = player('twitch|a', true, 0.2), b = player('kick|b', false, 0.7), f = fixture([a, b]), gate = deferred();
    await f.flow.prepare(1);
    const restoring = f.flow.restore(1, { ...focus(a), beforeOpen: () => gate.promise });
    await flush(); f.flow.cancel();
    assert.equal((await restoring).code, 'CANCELLED');
    gate.resolve(); await flush();
    assert.equal(a.state.muted, true); assert.equal(a.state.volume, 0.2);
    assert.equal(f.clock.pending, 0);
});

test('focused waiting is bounded to six seconds and a repeated repair does not extend it', async () => {
    const a = player('twitch|a', true, 0.2), b = player('kick|b', false, 0.7), f = fixture([a, b]);
    await f.flow.prepare(1); b.ready = false;
    await f.flow.restore(1, focus(a)); await f.clock.tick(5000);
    await f.flow.restore(1, focus(a)); await f.clock.tick(1000);
    assert.equal(f.reports.at(-1).code, 'TIMEOUT'); assert.equal(f.clock.pending, 0);
    b.ready = true; f.flow.notify(); await flush();
    assert.equal(a.state.muted, true); assert.equal(a.state.volume, 0.2);
});

test('new focus supersedes an issued old write without letting its old unmute follow', async () => {
    const a = player('twitch|a', true, 0.2), b = player('kick|b', false, 0.7), f = fixture([a, b]), gate = deferred();
    await f.flow.prepare(1);
    const original = f.settings.write; let targetVolumeStarted = false;
    f.settings.write = async (item, command) => {
        if (item.key === a.key && command.action === 'setVolume') { targetVolumeStarted = true; await gate.promise; }
        return original(item, command);
    };
    const first = f.flow.restore(1, focus(a)); await flush();
    assert.equal(targetVolumeStarted, true);
    const prepared = f.flow.prepare(2); await flush();
    assert.equal((await first).code, 'CANCELLED');
    gate.resolve(); await prepared;
    assert.equal((await f.flow.restore(2, focus(b))).code, 'COMPLETE');
    assert.equal(a.state.muted, true); assert.equal(b.state.muted, false); assert.equal(b.state.volume, 1);
    assert.equal(f.calls.some(call => call.key === a.key && call.action === 'setMuted' && call.value === false), false);
    assert.equal(f.clock.pending, 0);
});

test('peer reset during a held target unmute ACK is re-muted before focus completes', async () => {
    const a = player('twitch|a', true, 0.2), b = player('kick|b', false, 0.7), f = fixture([a, b]), gate = deferred();
    await f.flow.prepare(1);
    const original = f.settings.write; let unmuteStarted = false;
    f.settings.write = async (item, command) => {
        const result = await original(item, command);
        if (item.key === a.key && command.action === 'setMuted' && command.value === false) {
            unmuteStarted = true; await gate.promise;
        }
        return result;
    };
    const restoring = f.flow.restore(1, focus(a)); await flush();
    assert.equal(unmuteStarted, true);
    b.state.muted = false; b.state.muteGuardActive = false;
    f.flow.notify();
    gate.resolve();
    assert.equal((await restoring).code, 'COMPLETE');
    assert.equal(a.state.muted, false); assert.equal(a.state.volume, 1);
    assert.equal(b.state.muted, true); assert.equal(b.state.muteGuardActive, true);
    const opening = f.calls.findIndex(call => call.key === a.key && call.action === 'setMuted' && call.value === false);
    assert.ok(f.calls.findIndex((call, index) => index > opening && call.key === b.key && call.action === 'setMuted' && call.value === true) > opening);
    assert.equal(f.clock.pending, 0);
});

test('a peer that becomes unreadable during target opening closes target and waits safely', async () => {
    const a = player('twitch|a', true, 0.2), b = player('kick|b', false, 0.7), f = fixture([a, b]), gate = deferred();
    await f.flow.prepare(1);
    const original = f.settings.write; let unmuteStarted = false;
    f.settings.write = async (item, command) => {
        const result = await original(item, command);
        if (item.key === a.key && command.action === 'setMuted' && command.value === false && !unmuteStarted) {
            unmuteStarted = true; await gate.promise;
        }
        return result;
    };
    const restoring = f.flow.restore(1, focus(a)); await flush();
    assert.equal(unmuteStarted, true);
    b.ready = false; b.version++; b.state.muted = false; b.state.muteGuardActive = false;
    gate.resolve();
    assert.equal((await restoring).code, 'PENDING');
    assert.equal(a.state.muted, true);
    b.ready = true; f.flow.notify(); await flush();
    assert.equal(f.reports.at(-1).code, 'COMPLETE');
    assert.equal(a.state.muted, false); assert.equal(b.state.muted, true); assert.equal(f.clock.pending, 0);
});

test('an unknown pane with an empty key blocks focus while known peers are still muted', async () => {
    const a = player('twitch|a', false, 0.2), b = player('kick|b', false, 0.7), f = fixture([a, b]);
    await f.flow.prepare(1);
    f.items.push(player('', false, 0.5, false));
    const result = await f.flow.restore(1, focus(a));
    assert.equal(result.code, 'PARTIAL');
    assert.equal(b.state.muted, true); assert.equal(b.state.muteGuardActive, true);
    assert.equal(a.state.muted, true); assert.equal(a.state.volume, 0.2);
    assert.equal(f.calls.some(call => call.key === a.key && (call.action === 'setVolume' || call.value === false)), false);
    assert.equal(f.calls.some(call => call.key === ''), false);
    assert.equal(f.clock.pending, 0);
});

test('bookmark mutes the entire post-layout cohort before restoring several audible targets at their saved volumes', async () => {
    const a = player('native|a', false, 0.8), b = player('kick|b', false, 0.9), c = player('twitch|c', false, 0.5);
    const f = fixture([a, b, c]); await f.flow.prepare('book');
    f.items.reverse();
    const result = await f.flow.bookmark('book', [{ key: a.key, volume: 0.23 }, { key: b.key, volume: 0.61 }]);
    assert.equal(result.code, 'COMPLETE'); assert.equal(f.flow.bookmarkSupported, true);
    assert.deepEqual(f.calls.slice(0, 3).map(call => ({ key: call.key, value: call.value, guard: call.guard })),
        [c, b, a].map(item => ({ key: item.key, value: true, guard: true })));
    assert.equal(f.calls.slice(0, 3).every(call => call.action === 'setMuted'), true);
    assert.equal(a.state.muted, false); assert.equal(a.state.volume, 0.23);
    assert.equal(b.state.muted, false); assert.equal(b.state.volume, 0.61);
    assert.equal(c.state.muted, true); assert.equal(c.state.volume, 0.5);
    assert.equal(f.calls.filter(call => call.action === 'setVolume').every(call => call.focus === true), true);
    const finalVolume = f.calls.findLastIndex(call => call.action === 'setVolume');
    assert.equal(f.calls.findIndex(call => call.action === 'setMuted' && call.value === false) > finalVolume, true);
    assert.equal(f.clock.pending, 0);
});

test('bookmark applies saved volume to guarded hidden routes even when each primary already matches', async () => {
    const a = player('native|a', false, 0.23), b = player('kick|b', false, 0.61), f = fixture([a, b]);
    const hiddenVolumes = new Map([[a.key, 1], [b.key, 0.9]]), original = f.settings.write;
    f.settings.write = async (item, command) => {
        const result = await original(item, command);
        const target = f.items.find(value => value.key === item.key);
        if (command.action === 'setMuted' && command.guard === true) target.state.focusRestorePending = true;
        if (command.action === 'setVolume' && command.focus === true) hiddenVolumes.set(item.key, command.value);
        if (command.action === 'setMuted' && command.value === false && command.focus === true) target.state.focusRestorePending = false;
        return { ...result, state: { ...target.state } };
    };
    await f.flow.prepare(1);
    assert.equal((await f.flow.bookmark(1, [{ key: a.key, volume: 0.23 }, { key: b.key, volume: 0.61 }])).code, 'COMPLETE');
    assert.equal(hiddenVolumes.get(a.key), 0.23); assert.equal(hiddenVolumes.get(b.key), 0.61);
    assert.deepEqual(f.calls.filter(call => call.action === 'setVolume'), [
        { key: a.key, action: 'setVolume', value: 0.23, focus: true },
        { key: b.key, action: 'setVolume', value: 0.61, focus: true }
    ]);
    assert.equal(f.calls.findIndex(call => call.action === 'setMuted' && call.value === false) >
        f.calls.findLastIndex(call => call.action === 'setVolume'), true);
    assert.equal(a.state.muted, false); assert.equal(b.state.muted, false); assert.equal(f.clock.pending, 0);
});

test('an explicit empty bookmark audio list mutes all current and newly added channels without changing volume', async () => {
    const a = player('native|a', false, 0.31), f = fixture([a]);
    await f.flow.prepare(1); assert.equal((await f.flow.bookmark(1, [])).code, 'COMPLETE');
    assert.equal(a.state.muted, true); assert.equal(a.state.volume, 0.31);
    const b = player('kick|b', false, 0.62); f.items.push(b);
    f.flow.notify(); await flush();
    assert.equal(b.state.muted, true); assert.equal(b.state.muteGuardActive, true);
    assert.equal(b.state.volume, 0.62); assert.equal(f.calls.some(call => call.action === 'setVolume'), false);
    assert.equal(f.reports.at(-1).code, 'COMPLETE'); assert.equal(f.clock.pending, 0);
});

test('bookmark audio rejects zero, out-of-range, non-finite, duplicate and malformed targets without writes', async () => {
    for (const policy of [null, {}, [null], [{ key: 'a', volume: 0 }], [{ key: 'a', volume: -0.1 }],
        [{ key: 'a', volume: 1.1 }], [{ key: 'a', volume: NaN }], [{ key: 'a', volume: Infinity }],
        [{ key: 'a', volume: '0.2' }], [{ key: '', volume: 0.2 }], [{ key: ' a', volume: 0.2 }],
        [{ key: 'a', volume: 0.2 }, { key: 'a', volume: 0.3 }]]) {
        const f = fixture([player('native|a', false, 0.31)]); await f.flow.prepare(1);
        assert.equal((await f.flow.bookmark(1, policy)).code, 'INVALID_BOOKMARK_AUDIO');
        assert.deepEqual(f.calls, []); assert.equal((await f.flow.restore(1)).code, 'CANCELLED');
        assert.equal(f.clock.pending, 0);
    }
});

test('a held bookmark mute ACK prevents every target volume or opening write', async () => {
    const a = player('native|a', false, 0.7), b = player('kick|b', false, 0.8), f = fixture([a, b]), gate = deferred();
    await f.flow.prepare(1); const original = f.settings.write; let held = false;
    f.settings.write = async (item, command) => {
        if (item.key === b.key && command.action === 'setMuted' && command.value === true) { held = true; await gate.promise; }
        return original(item, command);
    };
    const restoring = f.flow.bookmark(1, [{ key: a.key, volume: 0.21 }]); await flush();
    assert.equal(held, true); assert.equal(a.state.muted, true);
    assert.equal(f.calls.some(call => call.action === 'setVolume' || call.value === false), false);
    gate.resolve(); assert.equal((await restoring).code, 'COMPLETE');
    assert.equal(a.state.muted, false); assert.equal(a.state.volume, 0.21); assert.equal(b.state.muted, true);
});

test('a bookmark peer refusing its mute guard keeps every audible saved target closed', async () => {
    const a = player('native|a', false, 0.7), b = player('kick|b', false, 0.8), f = fixture([a, b]);
    await f.flow.prepare(1); const original = f.settings.write;
    f.settings.write = async (item, command) => item.key === b.key ? { ok: false, state: { ...b.state } } : original(item, command);
    const result = await f.flow.bookmark(1, [{ key: a.key, volume: 0.21 }]);
    assert.equal(result.code, 'PARTIAL'); assert.equal(a.state.muted, true); assert.equal(a.state.volume, 0.7);
    assert.equal(f.calls.some(call => call.action === 'setVolume' || call.value === false), false);
    assert.equal(f.clock.pending, 0);
});

test('a late bookmark peer is awaited within thirty seconds while ready targets are muted immediately', async () => {
    const a = player('native|a', false, 0.7), b = player('kick|b', false, 0.8), f = fixture([a, b]);
    await f.flow.prepare(1); b.ready = false;
    assert.equal((await f.flow.bookmark(1, [{ key: a.key, volume: 0.21 }])).code, 'PENDING');
    assert.equal(a.state.muted, true); assert.equal(a.state.volume, 0.7);
    b.ready = true; b.version++; f.flow.notify(); await flush();
    assert.equal(a.state.muted, false); assert.equal(a.state.volume, 0.21); assert.equal(b.state.muted, true);
    assert.equal(f.reports.at(-1).code, 'COMPLETE'); assert.equal(f.clock.pending, 0);
});

test('a saved bookmark target becomes ready in the same controller after initially reporting NO_MEDIA', async () => {
    const a = player('at|cold', true, 1, false), b = player('gosh|peer', false, 0.8), f = fixture([a, b]);
    a.readable = true; a.state.available = false;
    const originalRead = f.settings.read, originalWrite = f.settings.write;
    f.settings.read = async item => item.key === a.key && !a.state.available ?
        { ok: false, code: 'NO_MEDIA', state: { ...a.state } } : originalRead(item);
    f.settings.write = async (item, command) => {
        const result = await originalWrite(item, command);
        return item.key === a.key && !a.state.available ? { ...result, ok: false, code: 'NO_MEDIA' } : result;
    };
    await f.flow.prepare(1);
    assert.equal((await f.flow.bookmark(1, [{ key: a.key, volume: 0.62 }])).code, 'PENDING');
    assert.equal(a.state.muted, true); assert.equal(b.state.muted, true);
    assert.equal(f.calls.some(call => call.action === 'setVolume' || call.value === false), false);
    const identity = a.identity, version = a.version;
    a.ready = true; a.state.available = true; f.flow.notify(); await flush();
    assert.equal(a.identity, identity); assert.equal(a.version, version);
    assert.equal(a.state.muted, false); assert.equal(a.state.volume, 0.62);
    assert.equal(b.state.muted, true); assert.equal(b.state.muteGuardActive, true);
    assert.equal(f.reports.at(-1).code, 'COMPLETE'); assert.equal(f.clock.pending, 0);
});

test('several saved bookmark targets can become readable and ready independently without changing controller versions', async () => {
    const a = player('at|a', true, 1, false), b = player('gosh|b', true, 1, false);
    const peer = player('kick|peer', false, 0.8), f = fixture([a, b, peer]);
    await f.flow.prepare(1);
    assert.equal((await f.flow.bookmark(1, [{ key: a.key, volume: 0.21 }, { key: b.key, volume: 0.43 }])).code, 'PENDING');
    assert.equal(peer.state.muted, true);
    a.ready = true; f.flow.notify(); await flush();
    assert.equal(a.state.muted, true); assert.equal(a.state.volume, 1);
    b.readable = true; b.state.available = false;
    const originalRead = f.settings.read, originalWrite = f.settings.write;
    f.settings.read = async item => item.key === b.key && !b.state.available ?
        { ok: false, code: 'NO_MEDIA', state: { ...b.state } } : originalRead(item);
    f.settings.write = async (item, command) => {
        const result = await originalWrite(item, command);
        return item.key === b.key && !b.state.available ? { ...result, ok: false, code: 'NO_MEDIA' } : result;
    };
    f.flow.notify(); await flush();
    assert.equal(a.state.muted, false); assert.equal(a.state.volume, 0.21);
    assert.equal(b.state.muted, true); assert.equal(b.state.muteGuardActive, true);
    assert.equal(f.reports.at(-1).code, 'PENDING');
    b.ready = true; b.state.available = true; f.flow.notify(); await flush();
    assert.equal(a.version, 1); assert.equal(b.version, 1);
    assert.equal(a.state.muted, false); assert.equal(a.state.volume, 0.21);
    assert.equal(b.state.muted, false); assert.equal(b.state.volume, 0.43);
    assert.equal(peer.state.muted, true); assert.equal(peer.state.muteGuardActive, true);
    assert.equal(f.reports.at(-1).code, 'COMPLETE'); assert.equal(f.clock.pending, 0);
});

test('a saved bookmark target becoming ready after its timeout cannot reopen through refreshed metadata', async () => {
    const a = player('at|late', true, 1, false), b = player('gosh|peer', false, 0.8), f = fixture([a, b]);
    a.readable = true; a.state.available = false;
    const originalRead = f.settings.read, originalWrite = f.settings.write;
    f.settings.read = async item => item.key === a.key && !a.state.available ?
        { ok: false, code: 'NO_MEDIA', state: { ...a.state } } : originalRead(item);
    f.settings.write = async (item, command) => {
        const result = await originalWrite(item, command);
        return item.key === a.key && !a.state.available ? { ...result, ok: false, code: 'NO_MEDIA' } : result;
    };
    await f.flow.prepare(1);
    assert.equal((await f.flow.bookmark(1, [{ key: a.key, volume: 0.62 }])).code, 'PENDING');
    await f.clock.tick(30000);
    assert.equal(f.reports.at(-1).code, 'TIMEOUT'); assert.equal(f.clock.pending, 0);
    const writes = f.calls.length;
    a.ready = true; a.state.available = true; f.flow.notify(); await flush();
    assert.equal(a.state.muted, true); assert.equal(a.state.volume, 1);
    assert.equal(b.state.muted, true); assert.equal(f.calls.length, writes); assert.equal(f.clock.pending, 0);
});

test('readable hidden bookmark media are muted with persistent guards before any target opens', async () => {
    const a = player('native|a', false, 0.7), b = player('kick|b', false, 0.8, false), f = fixture([a, b]);
    b.readable = true; b.state.available = false; await f.flow.prepare(1);
    const originalRead = f.settings.read, originalWrite = f.settings.write;
    f.settings.read = async item => item.key === b.key ? { ok: false, code: 'NO_MEDIA', state: { ...b.state } } : originalRead(item);
    f.settings.write = async (item, command) => {
        const result = await originalWrite(item, command);
        return item.key === b.key ? { ...result, ok: false, code: 'NO_MEDIA' } : result;
    };
    assert.equal((await f.flow.bookmark(1, [{ key: a.key, volume: 0.24 }])).code, 'COMPLETE');
    assert.equal(b.state.muted, true); assert.equal(b.state.muteGuardActive, true);
    assert.equal(a.state.muted, false); assert.equal(a.state.volume, 0.24);
});

test('a bookmarked volume setter that unmutes is repaired before the intended final opening', async () => {
    const a = player('native|a', false, 0.7), b = player('kick|b', false, 0.8), f = fixture([a, b]);
    await f.flow.prepare(1); const original = f.settings.write;
    f.settings.write = async (item, command) => {
        const result = await original(item, command);
        if (command.action === 'setVolume') { a.state.muted = false; a.state.muteGuardActive = false; result.state = { ...a.state }; }
        return result;
    };
    assert.equal((await f.flow.bookmark(1, [{ key: a.key, volume: 0.24 }])).code, 'COMPLETE');
    const volume = f.calls.findIndex(call => call.action === 'setVolume');
    assert.deepEqual(f.calls.slice(volume + 1, volume + 3), [
        { key: a.key, action: 'setMuted', value: true, guard: true },
        { key: a.key, action: 'setMuted', value: false, focus: true }
    ]);
    assert.equal(a.state.volume, 0.24); assert.equal(a.state.muted, false); assert.equal(b.state.muted, true);
});

test('an unconfirmed saved volume is never followed by an unmute', async () => {
    const a = player('native|a', false, 0.7), f = fixture([a]); await f.flow.prepare(1);
    const original = f.settings.write;
    f.settings.write = async (item, command) => command.action === 'setVolume' ? { ok: true, state: { ...a.state } } : original(item, command);
    assert.equal((await f.flow.bookmark(1, [{ key: a.key, volume: 0.24 }])).code, 'PARTIAL');
    assert.equal(a.state.muted, true); assert.equal(a.state.volume, 0.7);
    assert.equal(f.calls.some(call => call.value === false), false); assert.equal(f.clock.pending, 0);
});

test('removed bookmark targets are skipped and a same-key replacement after binding is only muted', async () => {
    const a = player('native|a', false, 0.7), b = player('kick|b', false, 0.8), f = fixture([a, b]);
    await f.flow.prepare(1); f.items = [b];
    const result = await f.flow.bookmark(1, [{ key: a.key, volume: 0.24 }]);
    assert.equal(result.code, 'COMPLETE'); assert.equal(result.skipped, 1); assert.equal(b.state.muted, true);
    f.items.push(a); f.flow.notify(); await flush();
    assert.equal(a.state.muted, true); assert.equal(a.state.volume, 0.7);
    assert.equal(f.calls.some(call => call.key === a.key && (call.action === 'setVolume' || call.value === false)), false);
    f.flow.cancel();
    const g = fixture([a, b]); await g.flow.prepare(2);
    await g.flow.bookmark(2, [{ key: a.key, volume: 0.24 }]);
    const replacement = player(a.key, false, 0.94); g.items = [replacement, b]; g.calls.length = 0;
    g.flow.notify(); await flush();
    assert.equal(replacement.state.muted, true); assert.equal(replacement.state.volume, 0.94);
    assert.equal(g.calls.some(call => call.key === a.key && (call.action === 'setVolume' || call.value === false)), false);
});

test('bookmark recovery rechecks its saved subset rather than the pre-apply audio snapshot', async () => {
    const a = player('native|a', false, 0.7), b = player('kick|b', false, 0.8), f = fixture([a, b]);
    await f.flow.prepare(1); await f.flow.bookmark(1, [{ key: b.key, volume: 0.24 }]);
    a.state.muted = false; b.state.muted = true; b.state.volume = 1; f.calls.length = 0;
    assert.equal((await f.flow.restore(1)).code, 'COMPLETE');
    assert.equal(a.state.muted, true); assert.equal(b.state.muted, false); assert.equal(b.state.volume, 0.24);
    assert.equal(f.calls.findIndex(call => call.action === 'setVolume') > f.calls.findIndex(call => call.key === a.key && call.value === true), true);
    f.flow.cancel(); b.state.volume = 0.37; b.state.muted = true;
    assert.equal((await f.flow.restore(1)).code, 'CANCELLED'); assert.equal(b.state.volume, 0.37); assert.equal(b.state.muted, true);
});

test('bookmark cancellation drains an issued volume write but drops its queued opening', async () => {
    const a = player('native|a', false, 0.7), f = fixture([a]), gate = deferred(); await f.flow.prepare(1);
    const original = f.settings.write; let held = false;
    f.settings.write = async (item, command) => {
        if (command.action === 'setVolume') { held = true; await gate.promise; }
        return original(item, command);
    };
    const restoring = f.flow.bookmark(1, [{ key: a.key, volume: 0.24 }]); await flush();
    assert.equal(held, true); f.flow.cancel(); assert.equal((await restoring).code, 'CANCELLED');
    let settled = false; const drain = f.flow.settle().then(() => { settled = true; }); await flush(); assert.equal(settled, false);
    gate.resolve(); await drain; await flush();
    assert.equal(a.state.muted, true); assert.equal(f.calls.some(call => call.value === false), false); assert.equal(f.clock.pending, 0);
});

test('explicit focus replaces bookmark audio policy, while a later layout captures the newly chosen audio', async () => {
    const a = player('native|a', false, 0.7), b = player('kick|b', false, 0.8), f = fixture([a, b]);
    await f.flow.prepare(1); await f.flow.bookmark(1, [{ key: b.key, volume: 0.24 }]);
    assert.equal((await f.flow.restore(1, focus(a))).code, 'COMPLETE');
    assert.equal(a.state.muted, false); assert.equal(a.state.volume, 1); assert.equal(b.state.muted, true);
    await f.flow.prepare(2); a.state.muted = true; a.state.volume = 0.5;
    assert.equal((await f.flow.restore(2)).code, 'COMPLETE'); assert.equal(a.state.muted, false); assert.equal(a.state.volume, 1);
    assert.equal(b.state.muted, true); assert.equal(f.clock.pending, 0);
});

test('bookmark late readiness has the original thirty-second deadline and cannot resurrect after timeout', async () => {
    const a = player('native|a', false, 0.7), b = player('kick|b', false, 0.8), f = fixture([a, b]);
    await f.flow.prepare(1); b.ready = false;
    await f.flow.bookmark(1, [{ key: a.key, volume: 0.24 }]); await f.clock.tick(29000); await f.flow.restore(1);
    await f.clock.tick(1000); assert.equal(f.reports.at(-1).code, 'TIMEOUT'); assert.equal(f.clock.pending, 0);
    b.ready = true; f.flow.notify(); await flush(); assert.equal(a.state.muted, true); assert.equal(a.state.volume, 0.7);
});

test('a new unknown peer during a held bookmark opening closes the target before waiting for readiness', async () => {
    const a = player('native|a', false, 0.7), b = player('kick|b', false, 0.8), f = fixture([a, b]), gate = deferred();
    await f.flow.prepare(1); const original = f.settings.write; let held = false;
    f.settings.write = async (item, command) => {
        const result = await original(item, command);
        if (item.key === a.key && command.action === 'setMuted' && command.value === false && !held) { held = true; await gate.promise; }
        return result;
    };
    const restoring = f.flow.bookmark(1, [{ key: a.key, volume: 0.24 }]); await flush(); assert.equal(held, true);
    const c = player('twitch|c', false, 0.5, false); f.items.push(c); gate.resolve();
    assert.equal((await restoring).code, 'PENDING'); assert.equal(a.state.muted, true); assert.equal(b.state.muted, true);
    c.ready = true; f.flow.notify(); await flush();
    assert.equal(f.reports.at(-1).code, 'COMPLETE'); assert.equal(a.state.muted, false); assert.equal(c.state.muted, true);
    assert.equal(c.state.muteGuardActive, true); assert.equal(f.clock.pending, 0);
});

test('target media disappearing between readiness and read remains closed until its media is available', async () => {
    const a = player('native|a', false, 0.7), f = fixture([a]); await f.flow.prepare(1);
    a.readable = true; a.state.available = false;
    const originalRead = f.settings.read, originalWrite = f.settings.write;
    f.settings.read = async item => a.state.available ? originalRead(item) : { ok: false, code: 'NO_MEDIA', state: { ...a.state } };
    f.settings.write = async (item, command) => {
        const result = await originalWrite(item, command);
        return a.state.available ? result : { ...result, ok: false, code: 'NO_MEDIA' };
    };
    assert.equal((await f.flow.bookmark(1, [{ key: a.key, volume: 0.24 }])).code, 'PENDING');
    assert.equal(a.state.muted, true); assert.equal(a.state.volume, 0.7);
    assert.equal(f.calls.some(call => call.action === 'setVolume' || call.value === false), false);
    a.state.available = true; f.flow.notify(); await flush();
    assert.equal(a.state.muted, false); assert.equal(a.state.volume, 0.24); assert.equal(f.clock.pending, 0);
});

test('a saved target removed after completion stays retired even if its exact old element returns', async () => {
    const a = player('native|a', false, 0.7), b = player('kick|b', false, 0.8), f = fixture([a, b]);
    await f.flow.prepare(1); await f.flow.bookmark(1, [{ key: a.key, volume: 0.24 }]);
    f.items = [b]; f.flow.notify(); await flush();
    assert.equal(f.reports.at(-1).results.find(item => item.key === a.key).status, 'removed');
    f.items.push(a); f.calls.length = 0; f.flow.notify(); await flush();
    assert.equal(a.state.muted, true); assert.equal(a.state.volume, 0.24);
    assert.equal(f.calls.some(call => call.key === a.key && (call.action === 'setVolume' || call.value === false)), false);
    assert.equal(f.clock.pending, 0);
});

test('same-key source replacement during a bookmarked volume ACK cannot receive its old target opening', async () => {
    const a = player('native|a', false, 0.7), f = fixture([a]), gate = deferred(); await f.flow.prepare(1);
    const original = f.settings.write; let held = false;
    f.settings.write = async (item, command) => {
        const result = await original(item, command);
        if (command.action === 'setVolume' && !held) { held = true; await gate.promise; }
        return result;
    };
    const restoring = f.flow.bookmark(1, [{ key: a.key, volume: 0.24 }]); await flush(); assert.equal(held, true);
    const replacement = player(a.key, false, 0.91); f.items = [replacement]; gate.resolve();
    assert.equal((await restoring).code, 'PARTIAL'); assert.equal(replacement.state.muted, true);
    assert.equal(replacement.state.volume, 0.91); assert.equal(f.calls.some(call => call.value === false), false);
    assert.equal(f.clock.pending, 0);
});

test('a source renewing during the final bookmark read retains a safe mute-only pending pass', async () => {
    const a = player('native|a', false, 0.7), b = player('kick|b', false, 0.8), f = fixture([a, b]), gate = deferred();
    await f.flow.prepare(1); const originalRead = f.settings.read; let targetOpened = false, held = false;
    const originalWrite = f.settings.write;
    f.settings.write = async (item, command) => {
        const result = await originalWrite(item, command);
        if (item.key === a.key && command.action === 'setMuted' && command.value === false) targetOpened = true;
        return result;
    };
    f.settings.read = async item => {
        const result = await originalRead(item);
        if (item.key === b.key && targetOpened && !held) { held = true; await gate.promise; }
        return result;
    };
    const restoring = f.flow.bookmark(1, [{ key: a.key, volume: 0.24 }]); await flush(); assert.equal(held, true);
    const replacement = player(a.key, false, 0.91); f.items = [replacement, b]; gate.resolve();
    assert.equal((await restoring).code, 'PENDING');
    f.flow.notify(); await flush();
    assert.equal(replacement.state.muted, true); assert.equal(replacement.state.volume, 0.91);
    assert.equal(f.reports.at(-1).code, 'PARTIAL'); assert.equal(f.clock.pending, 0);
    assert.equal(f.calls.filter(call => call.key === a.key && call.value === false).length, 1);
});
