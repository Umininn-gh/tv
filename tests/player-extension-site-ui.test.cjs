const { test } = require('node:test');
const assert = require('node:assert/strict');
const { aggregateAudio, validResult, canControl, isWatchStartTarget, isRecoveryReady } = require('../browser-extension/site-ui.js');

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
