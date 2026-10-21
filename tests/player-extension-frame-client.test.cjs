const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const config = require('../browser-extension/shared/config.js');
const source = fs.readFileSync('browser-extension/frame-client.js', 'utf8');
const flush = async () => { for (let count = 0; count < 5; count++) await Promise.resolve(); };

function fixture({ chrome = false, url = 'https://player.kick.com/qa', adapterFactory } = {}) {
    const listeners = new Map(), receivers = new Set(), requests = [], announcements = [], commands = [], timers = new Map();
    let next = 0, subscribe, disposeCalls = 0;
    const result = { ok: true, code: 'OK', message: '', state: { available: true, volume: 0.8, muted: false, paused: true } };
    let current = result;
    const controller = { getState: () => structuredClone(current), execute: async command => { commands.push(command); return structuredClone(current); },
        subscribe(fn) { subscribe = fn; fn(structuredClone(result)); return () => { subscribe = null; }; },
        dispose() { disposeCalls++; } };
    const runtime = { id: 'test-extension', onMessage: { addListener: fn => receivers.add(fn), removeListener: fn => receivers.delete(fn) },
        sendMessage(message, callback) {
            requests.push(message); const response = { ok: true, frameId: 7, documentId: 'document-test' };
            if (callback) callback(response); else return Promise.resolve(response);
        } };
    const parent = { postMessage: (message, targetOrigin) => announcements.push({ message, targetOrigin }) };
    const context = { UmininnConfig: config, UmininnMedia: { createMediaController: () => controller }, location: { href: url }, document: {}, parent,
        crypto: { getRandomValues: array => { array.fill(0x5a); return array; } },
        setTimeout(fn) { const id = ++next; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
        addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
        removeEventListener(type, fn) { listeners.get(type)?.delete(fn); } };
    context[chrome ? 'chrome' : 'browser'] = { runtime };
    if (adapterFactory) context.UmininnTwitch = { createTwitchController: adapterFactory };
    vm.runInNewContext(source, context);
    function event(type, data) { for (const fn of listeners.get(type) || []) fn(data); }
    function tick() { const queued = [...timers]; timers.clear(); queued.forEach(([, fn]) => fn()); }
    function receive(message, sender = { id: runtime.id }) {
        const responses = [];
        const accepted = [...receivers].map(fn => fn(message, sender, response => responses.push(response)));
        return { responses, accepted };
    }
    return { context, parent, result, runtime, requests, announcements, commands, receivers, timers, event, tick, receive,
        update(value) { current = value; subscribe?.(value); }, staleReport: value => subscribe?.(value), get disposeCalls() { return disposeCalls; } };
}
const envelope = (type, extra) => ({ channel: config.CHANNEL, version: config.VERSION, type, ...extra });

test('frame identifies through the broker and announces token/state for Promise and callback runtimes', async () => {
    for (const chrome of [false, true]) {
        const f = fixture({ chrome }); await flush();
        assert.equal(f.requests[0].type, 'frame:identify');
        assert.equal(f.announcements[0].message.type, 'frame:ready');
        assert.equal(f.announcements[0].message.frameId, 7);
        assert.equal(f.announcements[0].message.documentId, 'document-test');
        assert.match(f.announcements[0].message.token, /^[a-f0-9]{48}$/);
        assert.equal(f.announcements[0].message.result.state.volume, 0.8);
        assert.equal(f.commands.length, 0, 'startup must not mutate or play media');
    }
});

test('runtime commands require own extension identity, exact token and allowed action', async () => {
    const f = fixture(); await flush();
    const token = f.announcements[0].message.token;
    assert.deepEqual(f.receive(envelope('frame:command', { token: 'wrong', command: { action: 'recover' } })).accepted, [false]);
    assert.deepEqual(f.receive(envelope('frame:command', { token, command: { action: 'recover' } }), { id: 'other-extension' }).accepted, [false]);
    assert.equal(f.commands.length, 0);
    const invalid = f.receive(envelope('frame:command', { token, command: { action: 'reload' } }));
    assert.equal(invalid.responses[0].code, 'INVALID_ACTION'); assert.equal(f.commands.length, 0);
    const valid = f.receive(envelope('frame:command', { token, command: { action: 'setVolume', value: 0.4 } }));
    assert.deepEqual(valid.accepted, [true]); await flush();
    assert.equal(f.commands[0].action, 'setVolume'); assert.equal(f.commands[0].value, 0.4);
    assert.equal(valid.responses[0].ok, true);
});

test('parent probe is accepted only from the actual parent and a configured site origin', async () => {
    const f = fixture(); await flush(); const count = f.requests.length;
    f.event('message', { source: {}, origin: 'https://umininn-gh.github.io', data: envelope('frame:probe') });
    f.event('message', { source: f.parent, origin: 'https://attacker.test', data: envelope('frame:probe') });
    f.event('message', { source: f.parent, origin: 'https://umininn-gh.github.io', data: { type: 'frame:probe' } });
    assert.equal(f.requests.length, count);
    f.event('message', { source: f.parent, origin: 'http://localhost:8767', data: envelope('frame:probe') });
    await flush();
    assert.equal(f.requests.length, count + 1);
    assert.equal(f.announcements.at(-1).targetOrigin, 'http://localhost:8767');
    assert.equal(f.commands.length, 0);
});

test('state reporting is coalesced, and pagehide cancels reporting plus pending controller work', async () => {
    const f = fixture(); await flush(); f.tick(); const count = f.announcements.length;
    f.update({ ...f.result, state: { ...f.result.state, volume: 0.3 } });
    f.update({ ...f.result, state: { ...f.result.state, volume: 0.2 } });
    assert.equal(f.timers.size, 1); f.tick();
    assert.equal(f.announcements.length, count + 1);
    assert.equal(f.announcements.at(-1).message.result.state.volume, 0.2);
    f.update(f.result); f.event('pagehide', { persisted: false }); f.tick();
    assert.equal(f.disposeCalls, 1); assert.equal(f.receivers.size, 0); assert.equal(f.timers.size, 0);
});

test('coalesced announcements read current guard state rather than a stale report', async () => {
    const f = fixture(); await flush();
    f.update({ ...f.result, state: { ...f.result.state, muted: true, muteGuardActive: true } }); f.tick();
    f.staleReport({ ...f.result, state: { ...f.result.state, muted: false, muteGuardActive: false } }); f.tick();
    assert.equal(f.announcements.at(-1).message.result.state.muted, true);
    assert.equal(f.announcements.at(-1).message.result.state.muteGuardActive, true);
});

test('site QA, unknown domains and media QA roles remain separated', () => {
    for (const url of ['https://attacker.test/', 'https://umininn-gh.github.io/tv/', 'http://localhost:8767/work/extension-site-basic.html']) {
        const f = fixture({ url }); assert.equal(f.requests.length, 0); assert.equal(f.receivers.size, 0);
    }
    const media = fixture({ url: 'http://localhost:8768/work/extension-media-basic.html' });
    assert.equal(media.requests[0].type, 'frame:identify');
});

test('Twitch commands and lifecycle use the platform adapter through both extension runtimes', async () => {
    for (const chrome of [false, true]) {
        const wrapped = [], actions = [];
        const f = fixture({ chrome, url: 'https://player.twitch.tv/?channel=example', adapterFactory(options) {
            wrapped.push(options);
            const native = options.mediaController;
            const decorate = result => ({ ...result, state: { ...result.state, platformRecoverSupported: true } });
            return { getState: () => decorate(native.getState()),
                execute(command) { actions.push(command.action); return native.execute(command).then(decorate); },
                subscribe(listener) { return native.subscribe(result => listener(decorate(result))); },
                dispose: () => native.dispose() };
        } });
        await flush();
        assert.equal(wrapped.length, 1);
        assert.equal(wrapped[0].location.href, 'https://player.twitch.tv/?channel=example');
        assert.equal(wrapped[0].document, f.context.document);
        assert.equal(f.announcements[0].message.result.state.platformRecoverSupported, true);
        const token = f.announcements[0].message.token;
        const sent = f.receive(envelope('frame:command', { token, command: { action: 'recover' } }));
        await flush();
        assert.deepEqual(actions, ['recover']);
        assert.equal(sent.responses[0].state.platformRecoverSupported, true);
        f.event('pagehide', { persisted: false });
        assert.equal(f.disposeCalls, 1);
    }
});
