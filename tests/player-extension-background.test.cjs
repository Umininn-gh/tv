const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const config = require('../browser-extension/shared/config.js');
const { createBroker } = require('../browser-extension/background.js');
const SITE = 'https://umininn-gh.github.io/tv/';
const TOKEN = '0123456789abcdef'.repeat(3);
const EXTENSION_ID = 'umininn-test-extension';
const envelope = (type, extra = {}) => ({ channel: config.CHANNEL, version: config.VERSION, type, ...extra });
const siteSender = (extra = {}) => ({ id: EXTENSION_ID, tab: { id: 4, url: SITE }, frameId: 0, url: SITE, documentId: 'site-document', ...extra });
const frameSender = (extra = {}) => ({ id: EXTENSION_ID, tab: { id: 4, url: SITE }, frameId: 6, url: 'https://player.twitch.tv/?channel=example', documentId: 'frame-document', ...extra });
const command = (action = 'getState', value, extra = {}) => envelope('site:command', { target: { frameId: 6, token: TOKEN, documentId: 'frame-document' }, command: { action, ...(value === undefined ? {} : { value }) }, ...extra });
const state = { available: true, mediaId: 1, mediaType: 'video', volume: 0.4, muted: false, paused: true, ended: false, readyState: 4, playbackStatus: 'paused', errorCode: null, recovering: false, recoverSupported: true, volumeSupported: true, muteSupported: true, disposed: false };
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function fixture({ promiseApi = false, maxPending = 32 } = {}) {
    const listeners = new Set(), calls = { get: [], send: [] }, timers = new Map(); let now = 0, timerId = 0;
    const behavior = { get: id => ({ id, url: SITE }), send: () => ({ ok: true, code: 'OK', message: '', state }) };
    const api = { runtime: { id: EXTENSION_ID, onMessage: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) } }, tabs: {} };
    function call(method, args, callback) {
        const response = behavior[method](...args);
        if (promiseApi) return Promise.resolve(response);
        Promise.resolve(response).then(value => callback(value), error => {
            api.runtime.lastError = { message: error.message }; callback(); delete api.runtime.lastError;
        });
    }
    api.tabs.get = (id, callback) => { calls.get.push(id); return call('get', [id], callback); };
    api.tabs.sendMessage = (id, message, options, callback) => { calls.send.push({ id, message, options }); return call('send', [id, message, options], callback); };
    const options = {
        config, promiseApi, maxPending,
        setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, due: now + delay }); return id; },
        clearTimeout(id) { timers.delete(id); }
    };
    function advance(ms) {
        const end = now + ms;
        for (;;) {
            const first = [...timers.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
            if (!first) break;
            now = first[1].due; timers.delete(first[0]); first[1].callback();
        }
        now = end;
    }
    const broker = createBroker(api, options);
    return { api, broker, behavior, calls, timers, listeners, advance, options };
}

for (const promiseApi of [false, true]) {
    const engine = promiseApi ? 'Firefox promise API' : 'Chrome/Edge callback API';
    test(`${engine}: approved iframe identity comes from sender metadata and current tab`, async () => {
        const f = fixture({ promiseApi });
        const response = await f.broker.handle(envelope('frame:identify', { frameId: 999, documentId: 'forged' }), frameSender());
        assert.deepEqual(response, { ok: true, frameId: 6, documentId: 'frame-document' });
        assert.deepEqual(f.calls.get, [4]); assert.deepEqual(f.calls.send, []); assert.equal(f.timers.size, 0);
        const missing = await f.broker.handle(envelope('frame:identify'), frameSender({ documentId: undefined }));
        assert.equal(missing.documentId, null); f.broker.dispose(); assert.equal(f.listeners.size, 0);
    });
    test(`${engine}: typed commands route to the sender's tab and exact frame, preserving the per-document token`, async () => {
        const f = fixture({ promiseApi });
        for (const [action, value] of [['getState'], ['setVolume', 0], ['setVolume', 1], ['setMuted', false], ['setMuted', true], ['recover']]) {
            const response = await f.broker.handle(command(action, value, { tabId: 888 }), siteSender());
            assert.equal(response.ok, true); assert.deepEqual(response.state, state);
            const request = f.calls.send.at(-1);
            assert.equal(request.id, 4);
            assert.deepEqual(request.options, promiseApi ? { frameId: 6 } : { frameId: 6, documentId: 'frame-document' });
            assert.deepEqual(request.message, envelope('frame:command', { token: TOKEN, command: { action, ...(value === undefined ? {} : { value }) } }));
        }
        assert.ok(f.calls.get.every(id => id === 4)); assert.equal(f.timers.size, 0);
    });
    test(`${engine}: API failures are bounded, readable errors and do not disclose raw private URLs`, async () => {
        const f = fixture({ promiseApi });
        f.behavior.get = () => Promise.reject(new Error('Denied https://private.example/token'));
        const noTab = await f.broker.handle(command(), siteSender());
        assert.equal(noTab.code, 'TAB_UNAVAILABLE'); assert.doesNotMatch(noTab.message, /private|token/);
        f.behavior.get = id => ({ id, url: SITE });
        f.behavior.send = () => Promise.reject(new Error('No receiver at https://private.example/token'));
        const noFrame = await f.broker.handle(command(), siteSender());
        assert.equal(noFrame.code, 'FRAME_UNAVAILABLE'); assert.doesNotMatch(noFrame.message, /private|token/);
        assert.equal(f.timers.size, 0);
    });
}

test('untrusted source extension, missing tab, nested site UI, player top level and inactive documents are rejected before tabs APIs', async () => {
    const f = fixture();
    const attempts = [
        [command(), siteSender({ id: 'other-extension' })],
        [command(), siteSender({ tab: undefined })],
        [command(), siteSender({ tab: { id: -1 } })],
        [command(), siteSender({ frameId: 3 })],
        [command(), siteSender({ url: 'https://evil.example/tv/' })],
        [command(), siteSender({ url: 'https://umininn-gh.github.io/tv/other.html' })],
        [command(), siteSender({ documentLifecycle: 'cached' })],
        [envelope('frame:identify'), frameSender({ frameId: 0 })],
        [envelope('frame:identify'), frameSender({ frameId: 1.5 })],
        [envelope('frame:identify'), frameSender({ url: 'https://player.twitch.tv.evil.example/' })],
        [envelope('frame:identify'), frameSender({ url: 'http://player.twitch.tv/' })],
        [envelope('frame:identify'), frameSender({ url: 'https://arbitrary-bs.example/embed' })]
    ];
    for (const [message, sender] of attempts) assert.equal((await f.broker.handle(message, sender)).code, 'UNAUTHORIZED');
    assert.deepEqual(f.calls, { get: [], send: [] });
});

test('invalid envelopes, commands, target tokens and values cannot trigger tab lookup or arbitrary operations', async () => {
    const f = fixture();
    const bad = [
        { ...command(), channel: 'another-channel' }, { ...command(), version: 2 }, envelope('reload'),
        ...['eval', 'fetch', 'capture', 'reload', 'seek'].map(action => command(action)),
        ...[-0.01, 1.01, NaN, Infinity, '0.5', null].map(value => command('setVolume', value)),
        ...[0, 1, 'true', null].map(value => command('setMuted', value)),
        command('recover', false), command('getState', null),
        ...['short', 'a'.repeat(129), '/'.repeat(48)].map(token => command('getState', undefined, { target: { frameId: 6, token } })),
        command('getState', undefined, { target: { frameId: 0, token: TOKEN } }),
        command('getState', undefined, { target: { frameId: 6, token: TOKEN, documentId: {} } })
    ];
    for (const message of bad) assert.equal((await f.broker.handle(message, siteSender())).ok, false);
    assert.deepEqual(f.calls, { get: [], send: [] });
});

test('current top-level tab must still be an approved site and stale site documents cannot send commands', async () => {
    const f = fixture();
    f.behavior.get = id => ({ id, url: 'https://evil.example/' });
    assert.equal((await f.broker.handle(command(), siteSender())).code, 'UNAUTHORIZED');
    assert.equal((await f.broker.handle(envelope('frame:identify'), frameSender())).code, 'UNAUTHORIZED');
    f.behavior.get = id => ({ id, url: 'https://umininn-gh.github.io/tv/admin.html' });
    assert.equal((await f.broker.handle(command(), siteSender())).code, 'STALE_DOCUMENT');
    f.behavior.get = id => ({ id: id + 1, url: SITE });
    assert.equal((await f.broker.handle(command(), siteSender())).code, 'UNAUTHORIZED');
    assert.equal(f.calls.send.length, 0);
    f.behavior.get = id => ({ id, url: SITE + '#same-document' });
    assert.equal((await f.broker.handle(command(), siteSender())).ok, true);
});

test('result states retain capabilities but drop URLs, tokens, arbitrary metadata and invalid scalar values', async () => {
    const f = fixture();
    f.behavior.send = () => ({ ok: false, code: 'NO_MEDIA', message: '暫時沒有影片', state: {
        ...state, available: false, volume: Infinity, mediaId: 'secret-id', url: 'https://private.example/signed', token: TOKEN,
        cookies: 'never-forward', nested: { url: 'https://private.example' }
    }, url: 'https://private.example' });
    const response = await f.broker.handle(command(), siteSender());
    assert.equal(response.code, 'NO_MEDIA'); assert.equal(response.state.available, false);
    assert.equal(response.state.recoverSupported, true); assert.equal(response.state.volumeSupported, true); assert.equal(response.state.muteSupported, true);
    for (const key of ['url', 'token', 'cookies', 'nested', 'volume', 'mediaId']) assert.equal(Object.hasOwn(response.state, key), false);
    assert.doesNotMatch(JSON.stringify(response), /private|signed|never-forward/);
    f.behavior.send = () => undefined;
    assert.equal((await f.broker.handle(command(), siteSender())).code, 'INVALID_RESPONSE');
});

test('platform recovery capability survives routing only as a boolean', async () => {
    const f = fixture();
    f.behavior.send = () => ({ ok: false, code: 'NO_MEDIA', message: '', state: {
        available: false, playbackStatus: 'no-media', recoverSupported: true, platformRecoverSupported: true
    } });
    const response = await f.broker.handle(command('recover'), siteSender());
    assert.equal(response.state.platformRecoverSupported, true);
    assert.equal(response.state.available, false);
    assert.equal(response.state.playbackStatus, 'no-media');
    f.behavior.send = () => ({ ok: true, code: 'OK', state: { platformRecoverSupported: 'true' } });
    assert.equal(Object.hasOwn((await f.broker.handle(command(), siteSender())).state, 'platformRecoverSupported'), false);
    f.broker.dispose();
});

test('tokens and frame responses do not create a registry; a new broker handles probes after worker restart', async () => {
    const f = fixture();
    assert.equal((await f.broker.handle(command(), siteSender())).state.volume, 0.4);
    f.broker.dispose();
    const restarted = createBroker(f.api, f.options);
    f.behavior.send = () => ({ ok: true, code: 'OK', message: '', state: { ...state, volume: 0.8 } });
    assert.equal((await restarted.handle(command(), siteSender())).state.volume, 0.8);
    assert.equal(f.listeners.size, 1); assert.equal(f.calls.send.length, 2); restarted.dispose();
});

test('hung tab validation times out at six seconds, frees the bound and cannot send a delayed command', async () => {
    const f = fixture({ maxPending: 1 }), waiting = deferred();
    f.behavior.get = () => waiting.promise;
    const first = f.broker.handle(command(), siteSender());
    assert.equal((await f.broker.handle(command(), siteSender())).code, 'BUSY');
    assert.equal(f.calls.get.length, 1);
    f.advance(5999); await flush(); assert.equal(f.timers.size, 1);
    f.advance(1); assert.equal((await first).code, 'TIMEOUT');
    waiting.resolve({ id: 4, url: SITE }); await flush();
    assert.equal(f.calls.send.length, 0, 'no command may be sent after validation has timed out');
    f.behavior.get = id => ({ id, url: SITE });
    assert.equal((await f.broker.handle(command(), siteSender())).ok, true);
    assert.equal(f.timers.size, 0);
});

test('callback runtime listener replies once on a stalled frame and ignores unrelated messages', async () => {
    const f = fixture(), waiting = deferred(), replies = [];
    f.behavior.send = () => waiting.promise;
    const listener = [...f.listeners][0];
    assert.equal(listener(envelope('frame:command'), siteSender(), () => { throw new Error('unrelated'); }), false);
    assert.equal(listener({ channel: 'other', type: 'site:command' }, siteSender(), () => {}), false);
    assert.equal(listener(command('recover'), siteSender(), result => replies.push(result)), true);
    await flush(); assert.equal(f.calls.send.length, 1);
    f.advance(6000); await flush();
    assert.equal(replies.length, 1); assert.equal(replies[0].code, 'TIMEOUT');
    waiting.resolve({ ok: true, code: 'OK', message: '', state }); await flush();
    assert.equal(replies.length, 1); assert.equal(f.calls.send.length, 1); assert.equal(f.timers.size, 0);
});

test('popup only reads the installed version and works without a runtime namespace', () => {
    const source = fs.readFileSync(require.resolve('../browser-extension/popup.js'), 'utf8');
    for (const namespace of ['browser', 'chrome', null]) {
        const label = { textContent: '測試版 0.1.0' }; let reads = 0;
        const context = { document: { getElementById: () => label } };
        if (namespace) context[namespace] = { runtime: { getManifest() { reads++; return { version: '0.2.3' }; }, sendMessage() { throw new Error('Popup cannot issue commands'); } }, tabs: new Proxy({}, { get() { throw new Error('Popup cannot read tabs'); } }) };
        vm.runInNewContext(source, context);
        assert.equal(reads, namespace ? 1 : 0); assert.equal(label.textContent, namespace ? '測試版 0.2.3' : '測試版 0.1.0');
    }
});
