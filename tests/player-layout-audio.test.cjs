const test = require('node:test');
const assert = require('node:assert/strict');
const { createLayoutAudioFlow } = require('../browser-extension/shared/layout-audio.js');

function deferred() {
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
async function flush() { for (let index = 0; index < 60; index++) await Promise.resolve(); }
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
            return { ok: true, state: { ...target.state } };
        },
        onStatus: status => reports.push(status)
    };
    const flow = createLayoutAudioFlow(settings);
    return { flow, clock, calls, reports, settings, get items() { return items; }, set items(value) { items = value; } };
}

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
