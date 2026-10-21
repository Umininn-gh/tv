const { test } = require('node:test');
const assert = require('node:assert/strict');
const { aggregateAudio, validResult, canControl, isWatchStartTarget, isRecoveryReady, createAudioFocusFlow } = require('../browser-extension/site-ui.js');

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
