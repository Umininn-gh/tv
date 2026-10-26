const test = require('node:test');
const assert = require('node:assert/strict');
const originalConfig = require('../browser-extension/shared/config.js');
const { createSiteTransport, createFrameClient } = require('../userscript/transport.js');
const config = { ...originalConfig, CHANNEL: 'umininn-tv-userscript' };
const SITE = 'https://umininn-gh.github.io/tv/';
const SITE_ORIGIN = new URL(SITE).origin;
const PLAYER = 'https://player.twitch.tv/?channel=sample';
const PLAYER_ORIGIN = new URL(PLAYER).origin;
const TOKEN = 'a'.repeat(48), DOCUMENT = 'b'.repeat(48), SESSION = 'c'.repeat(48);
const envelope = (type, fields = {}) => ({ channel: config.CHANNEL, version: config.VERSION, type, ...fields });
const snapshot = () => ({ ok: true, code: 'OK', message: '', state: { available: true, volume: 0.4, muted: false, paused: true, readyState: 4, playbackStatus: 'paused', recoverSupported: true, volumeSupported: true, muteSupported: true } });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('site transport preserves only a typed empty-guard proof without inventing player mute state', async () => {
    const f = siteFixture(); f.ready();
    for (const proof of [true, false, 'true', 1, null]) {
        const pending = f.command();
        f.result(undefined, { result: { ok: false, code: 'NO_MEDIA', state: { available: false,
            muted: null, volume: null, muteSupported: false, volumeSupported: false, muteGuardActive: true, emptyGuardConfirmed: proof } } });
        const result = await pending;
        assert.equal(result.state.muted, null); assert.equal(result.state.volume, null);
        if (typeof proof === 'boolean') assert.equal(result.state.emptyGuardConfirmed, proof);
        else assert.notEqual(result.state.emptyGuardConfirmed, true);
    }
    f.transport.dispose();
});
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function eventTarget() {
    const listeners = new Map(), listenerOptions = new Map();
    const target = { listeners, listenerOptions,
        addEventListener(type, callback, options) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); listenerOptions.set(callback, options); },
        removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
        emit(type, event) { for (const callback of [...(listeners.get(type) || [])]) callback(event); },
        dispatchEvent(event) { event.target = this; this.emit(event.type, event); return !event.defaultPrevented; }
    };
    return target;
}
let randomSeed = 0;
function fakeWindow(href) {
    let now = 0, nextTimer = 0;
    const timers = new Map(), sent = [], win = { ...eventTarget(), location: { href }, sent, timers,
        CustomEvent: class { constructor(type, options = {}) { this.type = type; this.bubbles = options.bubbles === true; this.detail = options.detail ?? null; this.isTrusted = false; } },
        crypto: { getRandomValues(values) { const seed = ++randomSeed; for (let i = 0; i < values.length; i++) values[i] = (seed * 17 + i) % (values.BYTES_PER_ELEMENT === 1 ? 256 : 4294967296); return values; } },
        setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { due: now + delay, callback }); return id; },
        clearTimeout(id) { timers.delete(id); },
        postMessage(message, origin) { sent.push({ message, origin }); },
        advance(ms) {
            const end = now + ms;
            for (;;) {
                const next = [...timers].filter(([, value]) => value.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
                if (!next) break;
                now = next[1].due; timers.delete(next[0]); next[1].callback();
            }
            now = end;
        }
    };
    win.document = { defaultView: win, documentElement: {} };
    win.top = win; win.parent = win;
    return win;
}
function siteFixture() {
    const win = fakeWindow(SITE), frameWindow = fakeWindow(PLAYER);
    const frame = { ...eventTarget(), tagName: 'IFRAME', src: PLAYER, contentWindow: frameWindow, isConnected: true };
    const container = { isConnected: true, children: [frame] };
    let mutation;
    win.MutationObserver = class { constructor(callback) { mutation = callback; } observe() {} disconnect() {} };
    win.document.getElementById = id => id === 'multi-stream-container' ? container : null;
    const transport = createSiteTransport({ window: win, config });
    function ready(fields = {}, origin = PLAYER_ORIGIN, source = frameWindow) {
        win.emit('message', { source, origin, data: envelope('frame:ready', { frameId: 7, token: TOKEN, documentId: DOCUMENT, result: snapshot(), ...fields }) });
    }
    function command(action = 'getState', value, target = {}) {
        return transport.sendMessage(envelope('site:command', { target: { frameId: 7, token: TOKEN, documentId: DOCUMENT, ...target }, command: { action, ...(value === undefined ? {} : { value }) } }));
    }
    function result(request = frameWindow.sent.at(-1).message, fields = {}, origin = PLAYER_ORIGIN, source = frameWindow) {
        win.emit('message', { source, origin, data: envelope('userscript:result', { requestId: request.requestId, sessionId: request.sessionId, sequence: request.sequence, frameId: request.frameId, token: request.token, documentId: request.documentId, result: snapshot(), ...fields }) });
    }
    return { win, frameWindow, frame, container, transport, ready, command, result, mutate: () => mutation() };
}
function frameFixture(href = PLAYER, embedded = true) {
    const win = fakeWindow(href), parent = fakeWindow(SITE);
    if (embedded) { win.parent = parent; win.top = parent; }
    const calls = [], reports = new Set();
    let created = 0, twitchCreated = 0, disposed = 0, state = snapshot();
    const behavior = { execute: () => state };
    const controller = {
        getState: () => state,
        execute(command) { calls.push(command); return behavior.execute(command); },
        subscribe(callback) { reports.add(callback); callback(state); return () => reports.delete(callback); },
        dispose() { disposed++; }
    };
    const media = { createMediaController({ document }) { assert.equal(document, win.document); created++; return controller; } };
    const twitch = { createTwitchController(options) { assert.equal(options.mediaController, controller); assert.equal(options.location, win.location); twitchCreated++; return controller; } };
    const client = createFrameClient({ window: win, config, media, twitch });
    function probe(origin = SITE_ORIGIN, source = parent, fields = {}) { win.emit('message', { source, origin, data: envelope('frame:probe', fields) }); }
    function command(sequence = 1, command = { action: 'getState' }, fields = {}, origin = SITE_ORIGIN, source = parent) {
        const ready = parent.sent.findLast(value => value.message.type === 'frame:ready')?.message || {};
        const message = envelope('userscript:command', { frameId: ready.frameId, token: ready.token, documentId: ready.documentId, requestId: `${'d'.repeat(48)}_${sequence.toString(36)}`, sessionId: SESSION, sequence, command, ...fields });
        win.emit('message', { source, origin, data: message });
        return message;
    }
    function report(value) { state = value; for (const callback of reports) callback(value); }
    return { win, parent, client, controller, behavior, calls, reports, probe, command, report,
        get created() { return created; }, get twitchCreated() { return twitchCreated; }, get disposed() { return disposed; } };
}

test('site transport routes all four controls through the configured channel and exact iframe origin', async () => {
    const f = siteFixture(); f.ready();
    for (const [action, value] of [['getState'], ['recover'], ['setMuted', true], ['setVolume', 0], ['setVolume', 1]]) {
        const response = f.command(action, value), sent = f.frameWindow.sent.at(-1);
        assert.equal(sent.origin, PLAYER_ORIGIN);
        assert.equal(sent.message.type, 'userscript:command'); assert.equal(sent.message.channel, config.CHANNEL);
        assert.match(sent.message.requestId, /^[0-9a-f]{48}_[0-9a-z]+$/); assert.equal(sent.message.frameId, 7);
        assert.equal(sent.message.token, TOKEN); assert.equal(sent.message.documentId, DOCUMENT);
        assert.deepEqual(sent.message.command, { action, ...(value === undefined ? {} : { value }) });
        f.result(); assert.deepEqual(await response, snapshot());
    }
    assert.equal(f.win.timers.size, 0); f.transport.dispose();
});

test('site relays authenticated player interactions as a bubbling signal without issuing controls', () => {
    const f = siteFixture(), received = [];
    f.frame.addEventListener('umininn-player-interaction', event => received.push(event));
    const interaction = (fields = {}, origin = PLAYER_ORIGIN, source = f.frameWindow) =>
        f.win.emit('message', { source, origin, data: envelope('frame:interaction', { frameId: 7, token: TOKEN, documentId: DOCUMENT, ...fields }) });
    interaction(); assert.equal(received.length, 0, 'unregistered frame cannot relay input');
    f.ready(); interaction(); interaction();
    assert.equal(received.length, 2, 'repeated clicks in the same focused player are independently relayed');
    for (const event of received) {
        assert.ok(event instanceof f.win.CustomEvent); assert.equal(event.bubbles, true);
        assert.equal(event.target, f.frame); assert.equal(event.isTrusted, false); assert.equal(event.detail, null);
    }
    assert.equal(f.frameWindow.sent.length, 0, 'interaction notifications issue no playback or sound commands');
    assert.equal(f.win.timers.size, 0); f.transport.dispose();
});

test('site rejects forged player interaction origins, sources, capabilities, malformed identities and channels', () => {
    const f = siteFixture(); f.ready(); let received = 0;
    f.frame.addEventListener('umininn-player-interaction', () => received++);
    const interaction = (fields = {}, origin = PLAYER_ORIGIN, source = f.frameWindow) =>
        f.win.emit('message', { source, origin, data: envelope('frame:interaction', { frameId: 7, token: TOKEN, documentId: DOCUMENT, ...fields }) });
    for (const [fields, origin, source] of [
        [{}, 'https://evil.example'], [{}, PLAYER_ORIGIN, {}],
        [{ frameId: 8 }], [{ frameId: 0 }], [{ frameId: 7.5 }], [{ frameId: '7' }],
        [{ token: 'x'.repeat(48) }], [{ token: null }], [{ token: 'short' }],
        [{ documentId: 'x'.repeat(48) }], [{ documentId: null }],
        [{ channel: originalConfig.CHANNEL }], [{ version: 999 }], [{ type: 'frame:click' }]
    ]) { interaction(fields, origin, source); assert.equal(received, 0); }
    interaction(); assert.equal(received, 1); assert.equal(f.frameWindow.sent.length, 0); f.transport.dispose();
});

test('site refuses stale player interactions after navigation, replacement, load, removal or fresh identity', () => {
    for (const change of [
        f => { f.frame.src = 'https://player.kick.com/sample'; },
        f => { f.frame.contentWindow = fakeWindow(PLAYER); },
        f => { f.container.children = []; }, f => { f.frame.isConnected = false; },
        f => { f.frame.emit('load', {}); },
        f => { f.ready({ token: 'e'.repeat(48), documentId: 'f'.repeat(48) }); }
    ]) {
        const f = siteFixture(); f.ready(); let received = 0;
        f.frame.addEventListener('umininn-player-interaction', () => received++);
        change(f);
        f.win.emit('message', { source: f.frameWindow, origin: PLAYER_ORIGIN, data: envelope('frame:interaction', { frameId: 7, token: TOKEN, documentId: DOCUMENT }) });
        assert.equal(received, 0); assert.equal(f.frameWindow.sent.length, 0); f.transport.dispose();
    }
});

test('site interaction relay suspends in bfcache, requires a fresh handshake and stops on disposal', () => {
    const f = siteFixture(); f.ready(); let received = 0;
    f.frame.addEventListener('umininn-player-interaction', () => received++);
    const interaction = () => f.win.emit('message', { source: f.frameWindow, origin: PLAYER_ORIGIN, data: envelope('frame:interaction', { frameId: 7, token: TOKEN, documentId: DOCUMENT }) });
    f.win.emit('pagehide', { persisted: true }); interaction(); assert.equal(received, 0);
    f.win.emit('pageshow', { persisted: true }); interaction(); assert.equal(received, 0);
    f.ready(); interaction(); assert.equal(received, 1);
    f.transport.dispose(); interaction(); assert.equal(received, 1);
    assert.equal(f.win.listeners.get('message').size, 0); assert.equal(f.win.timers.size, 0);
});

test('focus mute guard is narrowly typed and reaches the approved frame unchanged', async () => {
    const f = siteFixture(); f.ready();
    const guarded = { action: 'setMuted', value: true, guard: true };
    const message = command => envelope('site:command', { target: { frameId: 7, token: TOKEN, documentId: DOCUMENT }, command });
    const response = f.transport.sendMessage(message(guarded));
    assert.deepEqual(f.frameWindow.sent.at(-1).message.command, guarded);
    f.result(undefined, { result: { ...snapshot(), state: { ...snapshot().state, muteGuardActive: true } } });
    assert.equal((await response).state.muteGuardActive, true);
    for (const command of [
        { action: 'setMuted', value: false, guard: true }, { action: 'setMuted', value: true, guard: false },
        { action: 'setMuted', value: true, guard: 'true' }, { action: 'setVolume', value: 1, guard: true },
        { action: 'recover', guard: true }, { action: 'getState', guard: true }
    ]) assert.equal((await f.transport.sendMessage(message(command))).code, 'INVALID_COMMAND');
    f.transport.dispose();
    const frame = frameFixture(); frame.probe();
    frame.command(1, guarded); await flush();
    assert.deepEqual(frame.calls, [guarded]);
    frame.client.dispose();
});

test('bookmark focus volumes pass unchanged through site and frame bridges while malformed opt-ins never reach media', async () => {
    const f = siteFixture(); f.ready();
    const message = command => envelope('site:command', { target: { frameId: 7, token: TOKEN, documentId: DOCUMENT }, command });
    const frame = frameFixture(); frame.probe();
    const allowed = [0, .37, 1].map(value => ({ action: 'setVolume', value, focus: true }));
    allowed.push({ action: 'setMuted', value: false, focus: true });
    for (const [index, command] of allowed.entries()) {
        const pending = f.transport.sendMessage(message(command));
        assert.deepEqual(f.frameWindow.sent.at(-1).message.command, command);
        f.result(); assert.equal((await pending).ok, true);
        frame.command(index + 1, command); await flush();
        assert.deepEqual(frame.calls.at(-1), command);
    }
    const sent = f.frameWindow.sent.length, called = frame.calls.length;
    const invalid = [
        ...[NaN, Infinity, -.01, 1.01, '.37', null].map(value => ({ action: 'setVolume', value, focus: true })),
        { action: 'setVolume', value: .37, focus: false }, { action: 'setVolume', value: .37, focus: true, guard: true },
        { action: 'setMuted', value: false, focus: true, guard: false }, { action: 'setMuted', value: true, focus: true },
        { action: 'recover', focus: true }, { action: 'getState', focus: true }
    ];
    for (const [index, command] of invalid.entries()) {
        assert.equal((await f.transport.sendMessage(message(command))).code, 'INVALID_COMMAND');
        frame.command(index + allowed.length + 1, command);
        assert.equal(frame.parent.sent.at(-1).message.result.code, 'INVALID_COMMAND');
    }
    await flush();
    assert.equal(f.frameWindow.sent.length, sent, 'invalid commands cannot send any cross-origin message');
    assert.equal(frame.calls.length, called, 'the receiving frame independently rejects invalid focus commands');
    assert.equal(f.win.timers.size, 0);
    f.transport.dispose(); frame.client.dispose();
});

test('site accepts only an approved connected iframe in the UI player cohort', async () => {
    const f = siteFixture();
    for (const ready of [() => f.ready({}, 'https://evil.example'), () => f.ready({}, PLAYER_ORIGIN, {}), () => f.ready({ token: 'short' }), () => f.ready({ documentId: null }), () => f.ready({ frameId: 0 }), () => f.ready({ frameId: 1.1 }), () => f.ready({ channel: originalConfig.CHANNEL })]) {
        ready(); assert.equal((await f.command()).code, 'FRAME_UNAVAILABLE');
    }
    f.container.children = []; f.ready(); assert.equal((await f.command()).code, 'FRAME_UNAVAILABLE');
    f.container.children = [f.frame]; f.frame.isConnected = false; f.ready(); assert.equal((await f.command()).code, 'FRAME_UNAVAILABLE');
    f.frame.isConnected = true; f.frame.src = 'https://evil.example/player'; f.ready({}, 'https://evil.example'); assert.equal((await f.command()).code, 'FRAME_UNAVAILABLE');
    f.frame.src = 'http://localhost/work/extension-media-test.html'; f.ready({}, 'http://localhost'); assert.equal((await f.command()).code, 'FRAME_UNAVAILABLE');
    assert.equal(f.frameWindow.sent.length, 0); f.transport.dispose();
});

test('site recognizes the first iframe nested in a direct player wrapper, excludes outside placeholders', async () => {
    const f = siteFixture();
    f.container.children = [{ tagName: 'DIV', querySelector: selector => { assert.equal(selector, 'iframe'); return f.frame; } }];
    f.ready(); const response = f.command(); f.result(); assert.equal((await response).ok, true);
    f.container.children = []; f.ready(); assert.equal((await f.command()).code, 'FRAME_UNAVAILABLE'); f.transport.dispose();
});

test('site rejects malformed commands and unavailable or forged target capabilities before messaging', async () => {
    const f = siteFixture(); f.ready();
    for (const [action, value] of [['fetch'], ['setMuted', 1], ['setMuted', null], ['setVolume', NaN], ['setVolume', Infinity], ['setVolume', -0.01], ['setVolume', 1.01], ['getState', true], ['recover', 0]]) assert.equal((await f.command(action, value)).code, 'INVALID_COMMAND');
    for (const target of [{ frameId: 8 }, { token: 'x'.repeat(48) }, { documentId: 'x'.repeat(48) }]) assert.equal((await f.command('getState', undefined, target)).code, 'FRAME_UNAVAILABLE');
    assert.equal((await f.transport.sendMessage(envelope('site:command', { target: { frameId: 7, token: TOKEN, documentId: DOCUMENT }, command: { action: 'getState', url: 'https://evil.example' } }))).code, 'INVALID_COMMAND');
    assert.equal(f.frameWindow.sent.length, 0); f.transport.dispose();
});

test('site ignores forged results, identities and other channels until the exact reply arrives', async () => {
    const f = siteFixture(); f.ready(); const response = f.command(); let settled = false; response.then(() => { settled = true; });
    for (const [fields, origin, source] of [[{}, 'https://evil.example'], [{}, PLAYER_ORIGIN, {}], [{ token: 'x'.repeat(48) }], [{ documentId: 'x'.repeat(48) }], [{ frameId: 8 }], [{ requestId: 'x'.repeat(48) }], [{ sessionId: 'x'.repeat(48) }], [{ sequence: 999 }], [{ channel: originalConfig.CHANNEL }]]) f.result(undefined, fields, origin, source);
    await flush(); assert.equal(settled, false); f.result(); assert.equal((await response).ok, true); f.transport.dispose();
});

test('site sanitizes and bounds player results before returning them to the UI', async () => {
    const f = siteFixture(); f.ready(); const response = f.command();
    f.result(undefined, { result: { ok: false, code: 'bad code or URL', message: 'x'.repeat(1000), secret: 'leak', state: { ...snapshot().state, volume: 99, readyState: 9, errorCode: 'secret', url: 'private', extra: { anything: true } } } });
    const result = await response; assert.equal(result.code, 'CONTROL_FAILED'); assert.equal(result.message.length, 240); assert.equal(result.secret, undefined);
    assert.equal(result.state.volume, undefined); assert.equal(result.state.readyState, undefined); assert.equal(result.state.errorCode, undefined); assert.equal(result.state.url, undefined); assert.equal(result.state.extra, undefined); assert.equal(result.state.muted, false);
    const invalid = f.command(); f.result(undefined, { result: { ok: 'yes' } }); assert.equal((await invalid).code, 'INVALID_RESPONSE'); f.transport.dispose();
});

test('src navigation, iframe replacement, removal and load invalidate pending routes and old identities', async () => {
    for (const change of [f => { f.frame.src = 'https://player.kick.com/sample'; }, f => { f.container.children = []; }, f => { f.frame.isConnected = false; }, f => { f.frame.contentWindow = fakeWindow(PLAYER); }, f => { f.frame.emit('load', {}); }]) {
        const f = siteFixture(); f.ready(); const response = f.command(); change(f); f.mutate(); f.result();
        assert.equal((await response).code, 'STALE_FRAME'); assert.equal((await f.command()).code, 'FRAME_UNAVAILABLE'); assert.equal(f.win.timers.size, 0); f.transport.dispose();
    }
});

test('a fresh frame document invalidates prior pending work, and frame ID collisions cannot steal another route', async () => {
    const f = siteFixture(); f.ready(); const old = f.command(); const token = 'e'.repeat(48), documentId = 'f'.repeat(48);
    f.ready({ token, documentId }); assert.equal((await old).code, 'STALE_FRAME'); assert.equal((await f.command()).code, 'FRAME_UNAVAILABLE');
    const response = f.command('getState', undefined, { token, documentId }); f.result(); assert.equal((await response).ok, true);
    const otherWindow = fakeWindow(PLAYER); f.container.children.push({ ...eventTarget(), tagName: 'IFRAME', src: PLAYER, isConnected: true, contentWindow: otherWindow });
    f.ready({ token: '1'.repeat(48) }, PLAYER_ORIGIN, otherWindow);
    const original = f.command('getState', undefined, { token, documentId }); assert.equal(otherWindow.sent.length, 0); f.result(); assert.equal((await original).ok, true); f.transport.dispose();
});

test('site request concurrency, timeouts and disposal settle every pending promise', async () => {
    const f = siteFixture(); f.ready(); const requests = Array.from({ length: 32 }, () => f.command());
    assert.equal((await f.command()).code, 'BUSY'); assert.equal(f.frameWindow.sent.length, 32);
    f.win.advance(4500); assert.ok((await Promise.all(requests)).every(value => value.code === 'TIMEOUT')); assert.equal(f.win.timers.size, 0);
    const pending = f.command(); f.transport.dispose(); assert.equal((await pending).ok, false); assert.equal(f.win.timers.size, 0); assert.equal((await f.command()).code, 'DISPOSED');
    assert.equal(f.win.listeners.get('message').size, 0);
});

test('bfcache handshake retries are bounded, skip reconnected frames, and stop on dispose', () => {
    const f = siteFixture(); f.win.emit('pagehide', { persisted: true }); f.win.emit('pageshow', { persisted: true });
    f.win.advance(10000); assert.equal(f.frameWindow.sent.length, 3); assert.ok(f.frameWindow.sent.every(value => value.message.type === 'frame:probe')); assert.equal(f.win.timers.size, 0);
    f.win.emit('pagehide', { persisted: true }); f.win.emit('pageshow', { persisted: true }); f.ready();
    f.win.advance(10000); assert.equal(f.frameWindow.sent.length, 3);
    f.win.emit('pagehide', { persisted: true }); f.win.emit('pageshow', { persisted: true }); f.transport.dispose();
    assert.equal(f.win.timers.size, 0); f.win.advance(10000); assert.equal(f.frameWindow.sent.length, 3);
});

test('site transport is top-site only, does not continue after navigation, and safely suspends in bfcache', async () => {
    const bad = fakeWindow('https://evil.example'); assert.throws(() => createSiteTransport({ window: bad, config }), TypeError);
    const nested = fakeWindow(SITE); nested.top = {}; assert.throws(() => createSiteTransport({ window: nested, config }), TypeError);
    const f = siteFixture(); f.ready(); const pending = f.command(); f.win.emit('pagehide', { persisted: true }); assert.equal((await pending).ok, false);
    assert.equal((await f.command()).code, 'DISPOSED'); f.win.emit('pageshow', { persisted: true }); assert.equal((await f.command()).code, 'FRAME_UNAVAILABLE');
    f.win.advance(0); assert.equal(f.frameWindow.sent.at(-1).message.type, 'frame:probe');
    f.ready(); const resumed = f.command(); f.result(); assert.equal((await resumed).ok, true);
    f.win.location.href = 'https://evil.example'; assert.equal((await f.command()).code, 'UNAUTHORIZED'); f.win.emit('pagehide', { persisted: false }); assert.equal((await f.command()).code, 'DISPOSED');
});

test('frame creates no controller and sends no state until an approved direct parent probes it', () => {
    const f = frameFixture(); assert.equal(f.created, 0); assert.equal(f.parent.sent.length, 0);
    f.probe('https://evil.example'); f.probe(SITE_ORIGIN, {}); f.probe(SITE_ORIGIN, f.parent, { channel: originalConfig.CHANNEL });
    assert.equal(f.created, 0); assert.equal(f.parent.sent.length, 0);
    f.probe(); assert.equal(f.created, 1); assert.equal(f.twitchCreated, 1);
    const ready = f.parent.sent.at(-1); assert.equal(ready.origin, SITE_ORIGIN); assert.equal(ready.message.type, 'frame:ready');
    assert.ok(Number.isInteger(ready.message.frameId) && ready.message.frameId > 0); assert.match(ready.message.token, /^[0-9a-f]{48}$/); assert.match(ready.message.documentId, /^[0-9a-f]{48}$/); assert.notEqual(ready.message.token, ready.message.documentId);
    assert.deepEqual(ready.message.result, snapshot()); f.client.dispose(); assert.equal(f.disposed, 1);
});

test('frame relays trusted pointer input only after approval and preserves prevented input without playback commands', () => {
    const f = frameFixture();
    const interactions = () => f.parent.sent.filter(item => item.message.type === 'frame:interaction');
    const trusted = { isTrusted: true, defaultPrevented: true,
        preventDefault() { assert.fail('relay must not cancel input'); },
        stopPropagation() { assert.fail('relay must not stop input propagation'); } };
    const callback = [...f.win.listeners.get('pointerdown')][0];
    assert.deepEqual(f.win.listenerOptions.get(callback), { capture: true, passive: true });
    f.win.emit('pointerdown', trusted); f.probe('https://evil.example'); f.win.emit('pointerdown', trusted);
    assert.equal(interactions().length, 0); assert.equal(f.created, 0);
    f.probe(); const ready = f.parent.sent.at(-1).message;
    for (const event of [{ isTrusted: false }, {}, { isTrusted: 1 }]) f.win.emit('pointerdown', event);
    assert.equal(interactions().length, 0, 'scripted pointer dispatches cannot relay input');
    f.win.emit('pointerdown', trusted); f.win.emit('pointerdown', trusted);
    assert.equal(interactions().length, 2);
    for (const item of interactions()) {
        assert.equal(item.origin, SITE_ORIGIN);
        assert.deepEqual(item.message, envelope('frame:interaction', { frameId: ready.frameId, token: ready.token, documentId: ready.documentId }));
    }
    assert.deepEqual(f.calls, [], 'pointer relay does not execute recovery, sound or state commands');
    const originalParent = f.win.parent; f.win.parent = {};
    f.win.emit('pointerdown', trusted); assert.equal(interactions().length, 2);
    f.win.parent = originalParent; f.client.dispose();
    assert.equal(f.win.listeners.get('pointerdown').size, 0);
    f.win.emit('pointerdown', trusted); assert.equal(interactions().length, 2);
});

test('frame pointer relay suspends across bfcache and resumes only after a fresh approved handshake', () => {
    const f = frameFixture(); f.probe();
    const first = f.parent.sent.at(-1).message;
    const interactions = () => f.parent.sent.filter(item => item.message.type === 'frame:interaction');
    const pointer = () => f.win.emit('pointerdown', { isTrusted: true });
    pointer(); assert.equal(interactions().length, 1);
    f.win.emit('pagehide', { persisted: true }); pointer(); assert.equal(interactions().length, 1);
    f.win.emit('pageshow', { persisted: true }); pointer(); assert.equal(interactions().length, 1);
    f.probe(); const fresh = f.parent.sent.at(-1).message;
    assert.notEqual(fresh.token, first.token); assert.notEqual(fresh.documentId, first.documentId);
    pointer(); assert.equal(interactions().length, 2); assert.equal(interactions()[1].message.token, fresh.token);
    f.win.emit('pagehide', { persisted: false }); pointer(); assert.equal(interactions().length, 2);
    assert.equal(f.win.listeners.get('pointerdown').size, 0); assert.deepEqual(f.calls, []);
});

test('top-level, unapproved and non-HTTPS player documents stay inert', () => {
    for (const [href, embedded] of [[PLAYER, false], ['https://evil.example/embed', true], ['http://player.twitch.tv/', true], ['http://localhost/work/extension-media-test.html', true]]) {
        const f = frameFixture(href, embedded); f.probe(); assert.equal(f.created, 0); assert.equal(f.parent.sent.length, 0); assert.equal(f.win.listeners.get('message'), undefined); f.client.dispose();
    }
});

test('frame preserves media and Twitch controls with sanitized responses and bounded coalesced state reports', async () => {
    const f = frameFixture(); f.probe(); f.win.advance(100);
    for (const [index, command] of [{ action: 'getState' }, { action: 'setVolume', value: 0.8 }, { action: 'setMuted', value: true }, { action: 'recover' }].entries()) {
        f.command(index + 1, command); await flush(); assert.deepEqual(f.calls.at(-1), command);
        const result = f.parent.sent.at(-1).message; assert.equal(result.type, 'userscript:result'); assert.equal(result.result.ok, true); assert.equal(result.sequence, index + 1);
    }
    const readyCount = f.parent.sent.filter(value => value.message.type === 'frame:ready').length;
    for (let i = 0; i < 10; i++) f.report({ ...snapshot(), message: String(i), state: { ...snapshot().state, volume: i / 10, secret: 'private' } });
    assert.equal(f.win.timers.size, 1); f.win.advance(99); assert.equal(f.parent.sent.filter(value => value.message.type === 'frame:ready').length, readyCount);
    f.win.advance(1); const latest = f.parent.sent.at(-1).message; assert.equal(latest.type, 'frame:ready'); assert.equal(latest.result.state.volume, 0.9); assert.equal(latest.result.state.secret, undefined); assert.equal(f.win.timers.size, 0);
    f.client.dispose();
});

test('frame rejects forged sources, origins, capabilities and malformed commands', async () => {
    const f = frameFixture(); f.probe();
    f.command(1, { action: 'getState' }, {}, 'https://evil.example'); f.command(1, { action: 'getState' }, {}, SITE_ORIGIN, {});
    for (const fields of [{ token: 'x'.repeat(48) }, { documentId: 'x'.repeat(48) }, { frameId: 99999 }, { channel: originalConfig.CHANNEL }, { sessionId: 'short' }, { requestId: 'bad' }, { sequence: 99 }]) f.command(1, { action: 'getState' }, fields);
    await flush(); assert.equal(f.calls.length, 0);
    for (const [index, command] of [{ action: 'reload' }, { action: 'setVolume', value: 5 }, { action: 'setMuted', value: 'true' }, { action: 'getState', extra: 'private' }].entries()) {
        f.command(index + 1, command); assert.equal(f.parent.sent.at(-1).message.result.code, 'INVALID_COMMAND');
    }
    await flush(); assert.equal(f.calls.length, 0); f.command(5); await flush(); assert.equal(f.calls.length, 1); f.client.dispose();
});

test('request replay, reordered sequences and a changed session never execute again, including after completion', async () => {
    const f = frameFixture(); f.probe(); const message = f.command();
    f.win.emit('message', { source: f.parent, origin: SITE_ORIGIN, data: message }); await flush(); assert.equal(f.calls.length, 1);
    f.win.emit('message', { source: f.parent, origin: SITE_ORIGIN, data: message });
    f.command(2, { action: 'getState' }, { requestId: message.requestId }); // Altering sequence cannot reuse an ID.
    f.command(3, { action: 'getState' }, { sessionId: 'e'.repeat(48) });
    await flush(); assert.equal(f.calls.length, 1);
    f.command(5); f.command(4); await flush(); assert.equal(f.calls.length, 2); f.client.dispose();
});

test('a late command reply cannot announce an obsolete mute guard setting', async () => {
    const f = frameFixture(), delayed = deferred(); f.probe();
    f.behavior.execute = () => delayed.promise;
    f.command(1, { action: 'setMuted', value: false }); await flush();
    const guarded = { ...snapshot(), state: { ...snapshot().state, muted: true, muteGuardActive: true } };
    f.report(guarded); f.win.advance(100);
    delayed.resolve(snapshot()); await flush(); f.win.advance(100);
    const latest = f.parent.sent.findLast(item => item.message.type === 'frame:ready').message.result;
    assert.equal(latest.state.muted, true);
    assert.equal(latest.state.muteGuardActive, true);
    f.client.dispose();
});

test('frame permits at most four pending operations and does not retry completed or rejected requests', async () => {
    const f = frameFixture(), pending = deferred(); f.behavior.execute = () => pending.promise; f.probe();
    for (let sequence = 1; sequence <= 5; sequence++) f.command(sequence);
    assert.equal(f.parent.sent.at(-1).message.result.code, 'BUSY'); await flush(); assert.equal(f.calls.length, 4);
    pending.resolve(snapshot()); await flush(); assert.equal(f.parent.sent.filter(value => value.message.type === 'userscript:result').length, 5);
    f.command(5); await flush(); assert.equal(f.calls.length, 4); f.win.advance(10000); await flush(); assert.equal(f.calls.length, 4); f.client.dispose();
});

test('frame disposal cancels queued work, unsubscribes, drops late promises and removes listeners', async () => {
    const f = frameFixture(), pending = deferred(); f.behavior.execute = () => pending.promise; f.probe(); f.command(); await flush();
    f.client.dispose(); assert.equal(f.disposed, 1); assert.equal(f.reports.size, 0); assert.equal(f.win.timers.size, 0); assert.equal(f.win.listeners.get('message').size, 0);
    const sent = f.parent.sent.length; pending.resolve(snapshot()); await flush(); f.report(snapshot()); f.win.advance(1000); assert.equal(f.parent.sent.length, sent);
    const queued = frameFixture(); queued.probe(); queued.command(); queued.client.dispose(); await flush(); assert.equal(queued.calls.length, 0);
});

test('frame errors return bounded public failures and a changed parent cannot probe, execute or receive reports', async () => {
    const f = frameFixture(); f.probe(); f.behavior.execute = () => { throw new Error('Private URL https://private.example/secret'); };
    f.command(); await flush(); const result = f.parent.sent.at(-1).message.result;
    assert.equal(result.code, 'CONTROL_FAILED'); assert.doesNotMatch(result.message, /private|secret/);
    const sent = f.parent.sent.length; f.win.parent = fakeWindow(SITE); f.probe(); f.command(2); f.report(snapshot()); f.win.advance(100); await flush();
    assert.equal(f.calls.length, 1); assert.equal(f.parent.sent.length, sent); f.client.dispose();
});

test('site transport and frame client exchange real factory envelopes before and after a cached restore', async () => {
    const f = siteFixture(); f.frameWindow.parent = f.win; f.frameWindow.top = f.win;
    let created = 0, executed = 0;
    const media = { createMediaController() { created++; return { getState: snapshot, execute() { executed++; return snapshot(); }, subscribe: () => () => {}, dispose() {} }; } };
    const client = createFrameClient({ window: f.frameWindow, config, media });
    function pumpFrame() {
        for (const { message } of f.frameWindow.sent.splice(0)) f.frameWindow.emit('message', { source: f.win, origin: SITE_ORIGIN, data: message });
    }
    function pumpSite() {
        for (const { message } of f.win.sent.splice(0)) f.win.emit('message', { source: f.frameWindow, origin: PLAYER_ORIGIN, data: message });
    }
    f.frameWindow.emit('message', { source: f.win, origin: SITE_ORIGIN, data: envelope('frame:probe') }); pumpSite();
    let target = f.win.sent.at(-1); // The capabilities are available to the site's UI through frame:ready.
    // Ask the frame for its identity again, as a UI detector does.
    f.frameWindow.emit('message', { source: f.win, origin: SITE_ORIGIN, data: envelope('frame:probe') });
    target = f.win.sent.at(-1).message; pumpSite();
    function send() { return f.transport.sendMessage(envelope('site:command', { target: { frameId: target.frameId, token: target.token, documentId: target.documentId }, command: { action: 'setMuted', value: true } })); }
    let request = send(); pumpFrame(); await flush(); pumpSite(); assert.equal((await request).ok, true);
    const oldToken = target.token;
    f.win.emit('pagehide', { persisted: true }); f.frameWindow.emit('pagehide', { persisted: true });
    f.win.emit('pageshow', { persisted: true }); f.frameWindow.emit('pageshow', { persisted: true }); f.win.advance(0); pumpFrame();
    target = f.win.sent.at(-1).message; assert.notEqual(target.token, oldToken); pumpSite();
    request = send(); pumpFrame(); await flush(); pumpSite(); assert.equal((await request).ok, true); assert.equal(created, 2); assert.equal(executed, 2);
    client.dispose(); f.transport.dispose();
});

test('bfcache drops prior frame identity and pending results, then lazily reauthorizes a new controller', async () => {
    const f = frameFixture(), pending = deferred(); f.behavior.execute = () => pending.promise; f.probe(); const old = f.parent.sent.at(-1).message; f.command(); await flush();
    f.win.emit('pagehide', { persisted: true }); assert.equal(f.disposed, 1); const before = f.parent.sent.length;
    pending.resolve(snapshot()); await flush(); assert.equal(f.parent.sent.length, before); f.probe(); assert.equal(f.created, 1);
    f.win.emit('pageshow', { persisted: true }); assert.equal(f.created, 1); f.probe(); assert.equal(f.created, 2);
    const ready = f.parent.sent.at(-1).message; assert.notEqual(ready.token, old.token); assert.notEqual(ready.documentId, old.documentId);
    f.command(2, { action: 'getState' }, { token: old.token, documentId: old.documentId, frameId: old.frameId }); await flush(); assert.equal(f.calls.length, 1);
    f.win.emit('pagehide', { persisted: false }); assert.equal(f.disposed, 2); f.probe(); assert.equal(f.created, 2);
});
