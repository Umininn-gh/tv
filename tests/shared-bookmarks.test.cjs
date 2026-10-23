'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, createTransport, normalizeDocument } = require('../shared-bookmarks.js');
const { createStore: createLocalStore } = require('../layout-bookmarks.js');

// A compare-and-swap backend shared by independent clients. It is deliberately
// separate from the production reducer so these cases exercise lost-update races.
const copy = value => structuredClone(value);
const snapshot = (key = 'at|one') => ({ channels: [{ key, name: key, color: 120 }], columns: 1, focus: null, aspectRatio: 16 / 9 });
const entry = (id, name = id) => ({ id, name, snapshot: snapshot(), createdAt: 1, updatedAt: 1 });
const ids = store => store.list().map(item => item.id);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function backend(entries = []) {
    let document = { version: 1, bookmarks: copy(entries) }, revision = 1;
    const result = () => ({ document: copy(document), token: String(revision) });
    return {
        reads: 0, writes: 0, commits: 0,
        readHook: null, writeHook: null,
        current: () => result(),
        replace(next) { document = copy(next); revision++; },
        async read() { this.reads++; const value = result(); return this.readHook ? this.readHook(value) : value; },
        async write(next, token) {
            this.writes++;
            if (this.writeHook) await this.writeHook(next, token);
            if (token !== String(revision)) throw Object.assign(new Error('CAS mismatch'), { code: 'conflict' });
            document = copy(next); revision++; this.commits++;
            return result();
        }
    };
}
function client(server, options = {}) {
    let clock = 100, serial = 0;
    return createStore({ transport: { read: () => server.read(), write: (next, token) => server.write(next, token) },
        now: () => ++clock, makeId: () => 'added-' + (++serial), ...options });
}
function storage() {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), values };
}

test('independent clients share CRUD, stable colours and order without sharing their cache', async () => {
    const server = backend(), a = client(server), b = client(server);
    await Promise.all([a.reload(), b.reload()]);
    const saved = await a.add('夜更', snapshot('twitch|wj'));
    assert.deepEqual(b.list(), []);
    await b.reload();
    assert.equal(b.list()[0].id, saved.id);
    assert.deepEqual(b.list()[0].snapshot, saved.snapshot);
    await b.rename(saved.id, '共用夜更');
    await a.reload();
    assert.equal(a.list()[0].name, '共用夜更');
    await a.update(saved.id, snapshot('at|other'));
    await b.reload();
    assert.equal(b.list()[0].snapshot.channels[0].key, 'at|other');
    await b.remove(saved.id);
    assert.equal(b.canUndo(), true);
    await a.reload(); assert.deepEqual(a.list(), []);
    await b.undo(); await a.reload();
    assert.equal(a.list()[0].id, saved.id);
    const changed = a.list(); changed[0].name = 'external mutation';
    assert.equal(a.list()[0].name, '共用夜更');
});

test('concurrent creates prepend both additions through a CAS retry and retain the existing manual order', async () => {
    const existing = [entry('old-z'), entry('old-a')];
    const server = backend(existing), a = client(server, { makeId: () => 'from-a' }), b = client(server, { makeId: () => 'from-b' });
    await Promise.all([a.reload(), b.reload()]);
    const ready = deferred(), both = deferred(); let readers = 0;
    server.readHook = async value => { if (++readers === 2) { server.readHook = null; both.resolve(); } ready.resolve(); await both.promise; return value; };
    await Promise.all([a.add('A', snapshot()), b.add('B', snapshot())]);
    const saved = server.current().document.bookmarks;
    assert.deepEqual(saved.slice(0, 2).map(item => item.id).sort(), ['from-a', 'from-b']);
    assert.deepEqual(saved.slice(2), existing);
    await Promise.all([a.reload(), b.reload()]);
    assert.deepEqual(a.list(), saved);
    assert.deepEqual(b.list(), saved);
    assert.equal(server.commits, 2);
    assert.equal(server.writes, 3, 'only the losing CAS is retried');
});

test('stale same-field edits are rejected while different fields and other entries merge', async () => {
    const server = backend([entry('a'), entry('b')]), a = client(server), b = client(server);
    await Promise.all([a.reload(), b.reload()]);
    await a.rename('a', 'New name');
    await assert.rejects(b.rename('a', 'Stale name'), Error);
    assert.equal(server.current().document.bookmarks[0].name, 'New name');
    await b.reload(); await a.reload();
    await a.rename('a', 'Final name');
    await b.update('a', snapshot('at|new'));
    assert.equal(server.current().document.bookmarks[0].name, 'Final name');
    assert.equal(server.current().document.bookmarks[0].snapshot.channels[0].key, 'at|new');
    await assert.rejects(a.remove('a'), Error, 'delete may not silently remove an entry changed since it was displayed');
    await a.rename('b', 'Independent entry');
    assert.equal(server.current().document.bookmarks[1].name, 'Independent entry');
});

test('move follows displayed adjacent IDs and refuses a changed neighbour instead of moving a wrong entry', async () => {
    const server = backend(['a', 'b', 'c', 'd'].map(id => entry(id))), a = client(server), b = client(server);
    await Promise.all([a.reload(), b.reload()]);
    await a.move('b', 'up');
    assert.deepEqual(ids(a), ['b', 'a', 'c', 'd']);
    await assert.rejects(b.move('b', 'down'), Error);
    assert.deepEqual(server.current().document.bookmarks.map(item => item.id), ['b', 'a', 'c', 'd']);
    await b.reload();
    await b.move('d', -1);
    assert.deepEqual(ids(b), ['b', 'a', 'd', 'c']);
    await a.rename('b', 'Name can change outside the moved pair');
    await b.move('c', 'up');
    assert.deepEqual(ids(b), ['b', 'a', 'c', 'd']);
});

test('undo restores a deleted entry among current records and never duplicates an existing ID', async () => {
    const server = backend(['a', 'b', 'c'].map(id => entry(id))), a = client(server), b = client(server, { makeId: () => 'new' });
    await Promise.all([a.reload(), b.reload()]);
    await a.remove('b'); await b.add('Added elsewhere', snapshot());
    await a.undo();
    assert.deepEqual(ids(a), ['new', 'a', 'b', 'c']);
    await a.remove('b');
    const existing = server.current().document;
    existing.bookmarks.push(entry('b', 'Restored elsewhere')); server.replace(existing);
    await a.undo();
    assert.equal(server.current().document.bookmarks.filter(item => item.id === 'b').length, 1);
    assert.equal(server.current().document.bookmarks.find(item => item.id === 'b').name, 'Restored elsewhere');
});

test('unknown write outcome is not retried or announced as successful; a later reload can recover the actual commit', async () => {
    const server = backend(), a = client(server);
    await a.reload();
    server.write = async function(next) {
        this.writes++; this.replace(next);
        throw Object.assign(new Error('connection lost after commit'), { outcomeUnknown: true });
    };
    await assert.rejects(a.add('Maybe saved', snapshot()), Error);
    assert.equal(server.writes, 1);
    assert.notEqual(a.getSyncState(), 'synced');
    assert.ok(a.getError());
    await a.reload();
    assert.equal(a.list().length, 1);
    assert.equal(a.list()[0].name, 'Maybe saved');
});

test('a failing read cannot save to the local cache or claim an offline mutation succeeded', async () => {
    const server = backend([entry('a')]), cache = storage(), a = client(server, { cacheStorage: cache });
    await a.reload();
    const cached = [...cache.values.entries()];
    server.read = async () => { throw new Error('network offline'); };
    await assert.rejects(a.rename('a', 'Must not appear saved'), Error);
    assert.equal(server.writes, 0);
    assert.equal(a.list()[0].name, 'a');
    assert.deepEqual([...cache.values.entries()], cached);
    const offline = client(server, { cacheStorage: cache });
    assert.equal(offline.list()[0].id, 'a');
    await assert.rejects(offline.reload(), Error);
    assert.equal(offline.list()[0].name, 'a');
});

test('denied browser storage never prevents a confirmed remote write', async () => {
    const denied = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };
    const server = backend(), a = client(server, { cacheStorage: denied });
    await a.reload();
    const saved = await a.add('No local storage', snapshot());
    assert.equal(server.current().document.bookmarks[0].id, saved.id);
    assert.equal(a.getSyncState(), 'synced');
});

test('invalid and unsupported remote data are rejected without any repair write', async () => {
    const server = backend([entry('a')]), a = client(server); await a.reload();
    for (const invalid of [{ version: 999, bookmarks: [] }, { version: 1, bookmarks: [entry('a'), entry('a')] }, { version: 1, bookmarks: [{ ...entry('a'), snapshot: {} }] }]) {
        server.replace(invalid);
        await assert.rejects(a.reload(), Error);
        await assert.rejects(a.add('Do not overwrite corruption', snapshot()), Error);
    }
    assert.equal(server.writes, 0);
});

test('oversize data is rejected before a network write and leaves a valid library untouched', async () => {
    const server = backend([entry('a')]), a = client(server); await a.reload();
    const huge = { channels: Array.from({ length: 256 }, (_, index) => ({ key: 'm3u8|' + index + 'x'.repeat(3900), name: '台'.repeat(190), color: 12 })), columns: 16, focus: null, aspectRatio: 1.6 };
    await assert.rejects(a.add('Oversized', huge), Error);
    assert.equal(server.writes, 0);
    assert.deepEqual(ids(a), ['a']);
});

test('a delayed pre-mutation read cannot overwrite a newer successful write', async () => {
    const server = backend([entry('a')]), a = client(server); await a.reload();
    const gate = deferred(), reached = deferred();
    server.readHook = value => { server.readHook = null; reached.resolve(); return gate.promise.then(() => value); };
    const oldRead = a.reload(); await reached.promise;
    const mutation = a.rename('a', 'Fresh server value');
    // Both serialising reloads or allowing them with revision checks is valid.
    gate.resolve(); await Promise.all([oldRead, mutation]);
    assert.equal(a.list()[0].name, 'Fresh server value');
    assert.equal(a.list()[0].name, server.current().document.bookmarks[0].name);
});

test('import is atomic, preserves existing IDs, and is idempotent for previously imported layouts', async () => {
    const server = backend([entry('existing')]), a = client(server); await a.reload();
    const local = [entry('local-a', '本機甲'), entry('local-b', '本機乙')];
    await a.importLocal(local);
    assert.equal(a.list().length, 3);
    assert.equal(a.list()[0].id, 'existing');
    await a.importLocal(local);
    assert.equal(a.list().length, 3);
    const before = server.current().document, writes = server.writes;
    await assert.rejects(a.importLocal([entry('valid-new'), { ...entry('invalid'), snapshot: {} }]), Error);
    assert.deepEqual(server.current().document, before);
    assert.equal(server.writes, writes, 'validation must finish before even the first import write');
});

test('normalization rejects unknown versions, duplicate IDs and malformed snapshots', () => {
    assert.deepEqual(normalizeDocument({ version: 1, bookmarks: [entry('a')] }), { version: 1, bookmarks: [entry('a')] });
    for (const invalid of [null, {}, { version: 2, bookmarks: [] }, { version: 1, bookmarks: [entry('a'), entry('a')] }]) assert.throws(() => normalizeDocument(invalid));
});

function firestoreDocument(document, updateTime = '2026-10-19T10:00:00.000001Z') {
    return { updateTime, fields: { version: { integerValue: '1' }, payload: { stringValue: JSON.stringify(document) } } };
}
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, async json() { return body; } });

test('REST transport creates only an absent document then guards updates with the exact Firestore timestamp', async () => {
    const calls = [], document = { version: 1, bookmarks: [entry('a')] }, token = '2026-10-19T10:00:00.123456789Z';
    const transport = createTransport({ endpoint: 'https://firestore.invalid/doc', fetcher: async (url, options) => {
        calls.push({ url, options });
        return calls.length === 1 ? response(404, { error: { status: 'NOT_FOUND' } }) : response(200, firestoreDocument(document, token));
    } });
    assert.deepEqual(await transport.read(), { document: { version: 1, bookmarks: [] }, token: null });
    assert.deepEqual(await transport.write(document, null), { document, token });
    assert.equal(new URL(calls[1].url).searchParams.get('currentDocument.exists'), 'false');
    assert.equal(calls[1].options.method, 'PATCH');
    assert.deepEqual(JSON.parse(JSON.parse(calls[1].options.body).fields.payload.stringValue), document);
    await transport.write(document, token);
    assert.equal(new URL(calls[2].url).searchParams.get('currentDocument.updateTime'), token);
    assert.ok(calls.every(call => call.options.cache === 'no-store'));
    assert.deepEqual(await transport.read(), { document, token });
});

test('REST conflict and confirmed permission failures are distinguished from unknown server/write failures', async () => {
    const document = { version: 1, bookmarks: [] };
    for (const [status, statusName, code, unknown] of [
        [400, 'FAILED_PRECONDITION', 'conflict', false], [409, 'ALREADY_EXISTS', 'conflict', false],
        [412, 'FAILED_PRECONDITION', 'conflict', false], [403, 'PERMISSION_DENIED', 'permission-denied', false],
        [503, 'UNAVAILABLE', 'unavailable', true]
    ]) {
        const transport = createTransport({ fetcher: async () => response(status, { error: { status: statusName } }) });
        await assert.rejects(transport.write(document, null), error => error.code === code && Boolean(error.outcomeUnknown) === unknown);
    }
    const transport = createTransport({ fetcher: async () => { throw new TypeError('network lost'); } });
    await assert.rejects(transport.write(document, null), error => error.code === 'network' && error.outcomeUnknown === true);
    await assert.rejects(transport.read(), error => error.code === 'network' && !error.outcomeUnknown);
});

test('REST timeout is bounded even when a fetch adapter ignores abort and a broken write response remains unknown', { timeout: 1000 }, async () => {
    const timed = createTransport({ timeoutMs: 10, fetcher: () => new Promise(() => {}) });
    await assert.rejects(timed.write({ version: 1, bookmarks: [] }, null), error => error.code === 'timeout' && error.outcomeUnknown === true);
    const malformed = createTransport({ fetcher: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('broken response'); } }) });
    await assert.rejects(malformed.write({ version: 1, bookmarks: [] }, null), error => error.outcomeUnknown === true);
});

test('REST rejects missing versions, timestamps and payload corruption without sending another request', async () => {
    for (const body of [
        {}, { fields: { version: { integerValue: '2' }, payload: { stringValue: '{}' } }, updateTime: 'stamp' },
        { fields: { version: { integerValue: '1' }, payload: { stringValue: '{broken' } }, updateTime: 'stamp' },
        { ...firestoreDocument({ version: 1, bookmarks: [] }), updateTime: '' }
    ]) {
        let requests = 0;
        const transport = createTransport({ fetcher: async () => { requests++; return response(200, body); } });
        await assert.rejects(transport.read(), Error); assert.equal(requests, 1);
    }
});

test('the local adapter persists up/down order, retains boundaries, and imports atomically without duplicate IDs', () => {
    const localStorage = storage(), local = createLocalStore(localStorage);
    const a = local.add('A', snapshot()), b = local.add('B', snapshot()), c = local.add('C', snapshot());
    assert.deepEqual(ids(local), [c.id, b.id, a.id]);
    local.move(b.id, 'up');
    assert.deepEqual(ids(local), [b.id, c.id, a.id]);
    local.move(c.id, 'down');
    assert.deepEqual(ids(local), [b.id, a.id, c.id]);
    local.move(b.id, 'up'); local.move(c.id, 'down');
    assert.deepEqual(ids(createLocalStore(localStorage)), [b.id, a.id, c.id]);
    local.importLocal([entry('imported', 'Import')]);
    local.importLocal([entry('imported', 'Import')]);
    assert.deepEqual(ids(local), [b.id, a.id, c.id, 'imported']);
    assert.equal(local.list().filter(item => item.id === 'imported').length, 1);
    const before = local.list(), raw = [...localStorage.values];
    assert.throws(() => local.importLocal([entry('first-good'), { ...entry('second-bad'), snapshot: {} }]));
    assert.deepEqual(local.list(), before); assert.deepEqual([...localStorage.values], raw);
    assert.throws(() => local.importLocal([entry('duplicate'), entry('duplicate')]));
    assert.deepEqual(local.list(), before);
});

test('queued saves freeze caller snapshots and imports at click time rather than reading later mutations', async () => {
    const server = backend([entry('a')]), a = client(server); await a.reload();
    const gate = deferred(), reached = deferred();
    server.readHook = async value => { server.readHook = null; reached.resolve(); await gate.promise; return value; };
    const reload = a.reload(); await reached.promise;
    const captured = snapshot('at|captured'), replacement = snapshot('at|replacement'), local = [entry('frozen-local')];
    const add = a.add('Captured', captured), update = a.update('a', replacement), importing = a.importLocal(local);
    captured.channels[0].key = 'at|mutated'; replacement.channels[0].key = 'at|mutated-update'; local[0].name = 'Mutated import';
    gate.resolve(); await Promise.all([reload, add, update, importing]);
    assert.equal(a.list().find(item => item.name === 'Captured').snapshot.channels[0].key, 'at|captured');
    assert.equal(a.list().find(item => item.id === 'a').snapshot.channels[0].key, 'at|replacement');
    assert.equal(a.list().find(item => item.id === 'frozen-local').name, 'frozen-local');
});

test('continuous confirmed CAS conflicts stop after three attempts without changing the cache', async () => {
    const server = backend([entry('a')]), a = client(server); await a.reload();
    server.write = async function() { this.writes++; throw Object.assign(Error('busy CAS'), { code: 'conflict' }); };
    await assert.rejects(a.rename('a', 'Must not be saved'), error => error.code === 'conflict');
    assert.equal(server.writes, 3);
    assert.equal(a.list()[0].name, 'a');
    assert.equal(server.current().document.bookmarks[0].name, 'a');
});

test('shared audio survives persistence, cache, rename, undo and layout-only updates without adding removed or new channel audio', async () => {
    const server = backend(), cache = storage(), a = client(server, { cacheStorage: cache });
    await a.reload();
    const initial = { ...snapshot(), audio: { version: 1, audible: [{ key: 'at|one', volume: .45 }] } };
    const saved = await a.add('Sound', initial);
    initial.audio.audible[0].volume = .9;
    assert.equal(client(server, { cacheStorage: cache }).list()[0].snapshot.audio.audible[0].volume, .45);
    await a.rename(saved.id, 'Sound renamed');
    await a.update(saved.id, { ...snapshot(), channels: [...snapshot().channels, { key: 'at|new', name: 'New', color: 40 }] });
    assert.deepEqual(a.list()[0].snapshot.audio, { version: 1, audible: [{ key: 'at|one', volume: .45 }] });
    await a.remove(saved.id); await a.undo();
    assert.deepEqual(a.list()[0].snapshot.audio, { version: 1, audible: [{ key: 'at|one', volume: .45 }] });
    await a.update(saved.id, snapshot('at|new'));
    assert.deepEqual(a.list()[0].snapshot.audio, { version: 1, audible: [] });
    await a.update(saved.id, { ...snapshot('at|new'), audio: { version: 1, audible: [{ key: 'at|new', volume: 1 }] } });
    assert.deepEqual(a.list()[0].snapshot.audio, { version: 1, audible: [{ key: 'at|new', volume: 1 }] });
    await a.update(saved.id, { ...snapshot('at|new'), audio: { version: 1, audible: [] } });
    assert.deepEqual(server.current().document.bookmarks[0].snapshot.audio, { version: 1, audible: [] });
});

test('concurrent audio-only edits conflict with stale layout updates and deletion while independent renames retain the latest audio', async () => {
    const server = backend([entry('a')]), a = client(server), b = client(server);
    await Promise.all([a.reload(), b.reload()]);
    await a.update('a', { ...snapshot(), audio: { version: 1, audible: [{ key: 'at|one', volume: .25 }] } });
    await assert.rejects(b.update('a', snapshot('at|replacement')), error => error.code === 'conflict');
    await assert.rejects(b.remove('a'), error => error.code === 'conflict');
    await b.rename('a', 'Independent name');
    assert.deepEqual(server.current().document.bookmarks[0].snapshot.audio, { version: 1, audible: [{ key: 'at|one', volume: .25 }] });
    await b.update('a', { ...snapshot(), audio: { version: 1, audible: [] } });
    await assert.rejects(a.update('a', snapshot()), error => error.code === 'conflict');
    assert.deepEqual(server.current().document.bookmarks[0].snapshot.audio, { version: 1, audible: [] });
});

test('shared import identity distinguishes no audio, silence and different volumes but canonical audio ordering deduplicates equivalent layouts', async () => {
    const both = { ...snapshot(), channels: [...snapshot().channels, { key: 'at|two', name: 'Two', color: 30 }], columns: 2 };
    const make = (id, audio) => ({ ...entry(id, 'Same layout'), snapshot: { ...both, ...(audio === undefined ? {} : { audio }) } });
    const audible = [{ key: 'at|one', volume: .3 }, { key: 'at|two', volume: .6 }];
    const server = backend([make('legacy')]), a = client(server); await a.reload();
    const imported = await a.importLocal([
        make('silent', { version: 1, audible: [] }),
        make('sound', { version: 1, audible }),
        make('same-sound', { version: 1, audible: [...audible].reverse() }),
        make('different-volume', { version: 1, audible: [{ key: 'at|one', volume: .8 }] })
    ]);
    assert.equal(imported, 3);
    assert.deepEqual(ids(a), ['legacy', 'silent', 'sound', 'different-volume']);
    assert.deepEqual(a.list().find(item => item.id === 'sound').snapshot.audio.audible, audible);
    const before = server.current().document, writes = server.writes;
    await assert.rejects(a.importLocal([make('invalid-volume', { version: 1, audible: [{ key: 'at|one', volume: -1 }] })]));
    assert.deepEqual(server.current().document, before); assert.equal(server.writes, writes);
});

test('queued shared writes freeze captured audio before awaiting other operations', async () => {
    const server = backend([entry('a')]), a = client(server); await a.reload();
    const gate = deferred(), reached = deferred();
    server.readHook = async value => { server.readHook = null; reached.resolve(); await gate.promise; return value; };
    const reload = a.reload(); await reached.promise;
    const captured = { ...snapshot(), audio: { version: 1, audible: [{ key: 'at|one', volume: .4 }] } };
    const updating = a.update('a', captured);
    captured.audio.audible[0].volume = .9;
    gate.resolve(); await Promise.all([reload, updating]);
    assert.equal(server.current().document.bookmarks[0].snapshot.audio.audible[0].volume, .4);
});

test('removeAll clears the confirmed complete list in one atomic write and bulk undo returns its original ordered entries', async () => {
    const original = [entry('z'), entry('a'), entry('m')], server = backend(original), a = client(server);
    await a.reload();
    const deleted = await a.removeAll();
    assert.deepEqual(deleted, original); assert.deepEqual(a.list(), []);
    assert.deepEqual(server.current().document.bookmarks, []);
    assert.equal(server.writes, 1); assert.equal(server.commits, 1); assert.equal(a.canUndo(), true);
    deleted[0].name = 'Caller mutation';
    const restored = await a.undo();
    assert.deepEqual(restored, original); assert.deepEqual(a.list(), original);
    assert.equal(server.writes, 2); assert.equal(a.canUndo(), false);
    assert.equal(await a.undo(), null); assert.equal(server.writes, 2);
});

test('removeAll compares every canonical field and list order rather than only IDs or a count', async () => {
    const changes = {
        addition: list => list.push(entry('new')), deletion: list => list.pop(), order: list => list.reverse(),
        name: list => list[0].name = 'Changed', createdAt: list => list[0].createdAt++, updatedAt: list => list[0].updatedAt++,
        channelName: list => list[0].snapshot.channels[0].name = 'Changed channel',
        channelColor: list => list[0].snapshot.channels[0].color = 20,
        channelKey: list => list[0].snapshot.channels[0].key = 'at|changed',
        columns: list => list[0].snapshot.columns = 3, aspectRatio: list => list[0].snapshot.aspectRatio = 1,
        focus: list => list[0].snapshot.focus = { key: 'at|one', row: 0, column: 0, span: 2 },
        channelOrder: list => list[0].snapshot.channels.reverse(),
        audio: list => list[0].snapshot.audio = { version: 1, audible: [] },
        audible: list => list[0].snapshot.audio = { version: 1, audible: [{ key: 'at|one', volume: .4 }] }
    };
    for (const [field, change] of Object.entries(changes)) {
        const original = [entry('a'), entry('b')];
        original[0].snapshot = { ...snapshot(), columns: 2, channels: [...snapshot().channels, { key: 'at|two', name: 'Two', color: 30 }] };
        const server = backend(original), a = client(server);
        await a.reload(); const expected = a.list(), latest = copy(original); change(latest);
        server.replace({ version: 1, bookmarks: latest });
        await assert.rejects(a.removeAll({ expected }), error => error.code === 'conflict' && /整份.*清單.*再次確認/.test(error.message), field);
        assert.equal(server.writes, 0, field); assert.deepEqual(a.list(), original, field);
        assert.deepEqual(server.current().document.bookmarks, latest, field);
    }
});

test('removeAll uses canonical formatting and captures its confirmation before queued work or caller mutations', async () => {
    const original = [entry('a'), entry('b')], server = backend(original), a = client(server);
    await a.reload();
    const gate = deferred(), reached = deferred();
    server.readHook = async value => { server.readHook = null; reached.resolve(); await gate.promise; return value; };
    const reload = a.reload(); await reached.promise;
    const expected = a.list(), clearing = a.removeAll({ expected });
    expected.reverse(); expected[0].name = 'Caller changed after confirmation';
    gate.resolve(); await reload;
    assert.deepEqual(await clearing, original);
    await a.undo();
    const renamed = a.rename('a', 'Queued change'), staleClear = a.removeAll();
    await renamed; await assert.rejects(staleClear, error => error.code === 'conflict');
    assert.equal(a.list()[0].name, 'Queued change'); assert.equal(a.list().length, 2);
    const canonical = a.list();
    server.replace({ version: 1, bookmarks: canonical.map(item => ({ ...item, name: ' ' + item.name + ' ' })) });
    assert.deepEqual(await a.removeAll({ expected: canonical }), canonical, 'formatting normalized to the same canonical data is unchanged');
});

test('a removeAll CAS race never deletes a new or modified entry and preserves the previous single undo', async () => {
    for (const change of ['add', 'modify', 'move']) {
        const server = backend(['backup', 'a', 'b'].map(id => entry(id))), a = client(server);
        await a.reload(); await a.remove('backup');
        const cached = a.list(); let raced = false;
        server.writeHook = () => {
            if (raced) return; raced = true;
            const latest = server.current().document;
            if (change === 'add') latest.bookmarks.unshift(entry('new'));
            if (change === 'modify') latest.bookmarks[0].name = 'Concurrent name';
            if (change === 'move') latest.bookmarks.reverse();
            server.replace(latest);
        };
        const writes = server.writes;
        await assert.rejects(a.removeAll(), error => error.code === 'conflict', change);
        assert.equal(server.writes, writes + 1, 'the retry rechecks confirmation before another write');
        assert.deepEqual(a.list(), cached); assert.equal(a.canUndo(), true);
        server.writeHook = null;
        const restored = await a.undo();
        assert.equal(restored.id, 'backup'); assert.equal(Array.isArray(restored), false, 'single undo retains its entry return shape');
        assert.equal(a.list().some(item => item.id === 'backup'), true);
        if (change === 'add') assert.equal(a.list().some(item => item.id === 'new'), true);
    }
});

test('empty removeAll writes nothing and preserves either a single or bulk undo; stale empty confirmation still conflicts', async () => {
    for (const bulk of [false, true]) {
        const server = backend([entry('a')]), a = client(server); await a.reload();
        if (bulk) await a.removeAll(); else await a.remove('a');
        const writes = server.writes;
        assert.deepEqual(await a.removeAll(), []); assert.equal(server.writes, writes); assert.equal(a.canUndo(), true);
        server.replace({ version: 1, bookmarks: [entry('new')] });
        await assert.rejects(a.removeAll({ expected: [] }), error => error.code === 'conflict');
        assert.equal(server.writes, writes); assert.equal(a.canUndo(), true);
        const restored = await a.undo();
        assert.equal(Array.isArray(restored), bulk); assert.deepEqual(ids(a), bulk ? ['new', 'a'] : ['a', 'new']);
    }
});

test('failed reads, invalid confirmations and unknown clear outcomes retain cache and the previous undo', async () => {
    const server = backend([entry('backup'), entry('a')]), cache = storage(), a = client(server, { cacheStorage: cache });
    await a.reload(); await a.remove('backup');
    const cached = a.list(), raw = [...cache.values], writes = server.writes;
    for (const expected of [null, {}, [entry('duplicate'), entry('duplicate')]]) {
        await assert.rejects(a.removeAll({ expected }));
        assert.equal(server.writes, writes); assert.deepEqual(a.list(), cached); assert.equal(a.canUndo(), true);
    }
    const read = server.read;
    server.read = async () => { throw Object.assign(Error('offline'), { code: 'network' }); };
    await assert.rejects(a.removeAll(), error => error.code === 'network');
    assert.deepEqual(a.list(), cached); assert.equal(a.canUndo(), true);
    server.read = read;
    server.write = async function(next) { this.writes++; this.replace(next); throw Object.assign(Error('lost acknowledgement'), { code: 'network', outcomeUnknown: true }); };
    await assert.rejects(a.removeAll(), error => error.outcomeUnknown === true);
    assert.equal(server.writes, writes + 1); assert.deepEqual(server.current().document.bookmarks, []);
    assert.deepEqual(a.list(), cached); assert.deepEqual([...cache.values], raw); assert.equal(a.canUndo(), true);
    assert.notEqual(a.getSyncState(), 'synced');
});

test('a mismatching or malformed bulk acknowledgement is unknown and cannot replace cache or undo', async () => {
    for (const badDocument of [{ version: 1, bookmarks: [entry('unexpected')] }, { version: 999, bookmarks: [] }]) {
        const server = backend([entry('backup'), entry('a')]), a = client(server);
        await a.reload(); await a.remove('backup'); const cached = a.list(), write = server.write.bind(server);
        server.write = async (next, token) => { await write(next, token); return { document: badDocument, token: 'unconfirmed' }; };
        const writes = server.writes;
        await assert.rejects(a.removeAll(), error => error.code === 'invalid-response' && error.outcomeUnknown === true);
        assert.equal(server.writes, writes + 1); assert.deepEqual(a.list(), cached); assert.equal(a.canUndo(), true);
    }
});

test('bulk undo keeps new records in their current order and restores the original batch order without duplicating identical IDs', async () => {
    const original = ['a', 'b', 'c'].map(id => entry(id)), server = backend(original), a = client(server);
    await a.reload(); await a.removeAll();
    server.replace({ version: 1, bookmarks: [entry('new-y'), entry('b'), entry('new-x')] });
    const restored = await a.undo();
    assert.deepEqual(restored, original); assert.deepEqual(ids(a), ['new-y', 'new-x', 'a', 'b', 'c']);
    assert.equal(a.list().filter(item => item.id === 'b').length, 1); assert.equal(a.canUndo(), false);
});

test('bulk undo already restored elsewhere is a verified no-op preserving current order and returns the complete batch', async () => {
    const original = ['a', 'b'].map(id => entry(id)), server = backend(original), a = client(server);
    await a.reload(); await a.removeAll();
    server.replace({ version: 1, bookmarks: [entry('b'), entry('new'), entry('a')] });
    const writes = server.writes;
    assert.deepEqual(await a.undo(), original);
    assert.equal(server.writes, writes); assert.deepEqual(ids(a), ['b', 'new', 'a']); assert.equal(a.canUndo(), false);
});

test('bulk undo rejects any same-ID content change before writing and retains the entire undo batch', async () => {
    for (const field of ['name', 'snapshot', 'createdAt', 'updatedAt']) {
        const server = backend([entry('a'), entry('b')]), a = client(server); await a.reload(); await a.removeAll();
        const collision = entry('b');
        if (field === 'name') collision.name = 'Changed';
        if (field === 'snapshot') collision.snapshot = snapshot('at|other');
        if (field === 'createdAt') collision.createdAt++;
        if (field === 'updatedAt') collision.updatedAt++;
        server.replace({ version: 1, bookmarks: [entry('new'), collision] });
        const before = server.current().document, writes = server.writes;
        await assert.rejects(a.undo(), error => error.code === 'conflict', field);
        assert.equal(server.writes, writes); assert.deepEqual(server.current().document, before); assert.equal(a.canUndo(), true);
    }
});

test('bulk undo checks count and encoded-size quotas before its atomic restore', async () => {
    const original = [entry('a'), entry('b')], server = backend(original), a = client(server);
    await a.reload(); await a.removeAll();
    server.replace({ version: 1, bookmarks: Array.from({ length: 49 }, (_, index) => entry('new-' + index)) });
    const writes = server.writes;
    await assert.rejects(a.undo(), error => error.code === 'invalid');
    assert.equal(server.writes, writes); assert.equal(server.current().document.bookmarks.length, 49); assert.equal(a.canUndo(), true);
    server.replace({ version: 1, bookmarks: Array.from({ length: 48 }, (_, index) => entry('new-' + index)) });
    assert.deepEqual(await a.undo(), original); assert.equal(a.list().length, 50);
    const huge = { ...snapshot(), columns: 16, channels: Array.from({ length: 150 }, (_, index) => ({ key: 'm3u8|' + index + 'x'.repeat(3500), name: '台'.repeat(190), color: 120 })) };
    const largeOld = { ...entry('large-old'), snapshot: huge }, largeNew = { ...entry('large-new'), snapshot: huge };
    const bytesServer = backend([largeOld]), b = client(bytesServer); await b.reload(); await b.removeAll();
    bytesServer.replace({ version: 1, bookmarks: [largeNew] }); const bytesWrites = bytesServer.writes;
    await assert.rejects(b.undo(), error => error.code === 'invalid');
    assert.equal(bytesServer.writes, bytesWrites); assert.equal(b.canUndo(), true);
    assert.deepEqual(bytesServer.current().document.bookmarks, [largeNew]);
});

test('bulk undo retries safely around new arrivals but conflicts with a late same-ID replacement', async () => {
    for (const collision of [false, true]) {
        const original = [entry('a'), entry('b')], server = backend(original), a = client(server);
        await a.reload(); await a.removeAll();
        server.replace({ version: 1, bookmarks: [entry('new-first')] }); let raced = false;
        server.writeHook = () => {
            if (raced) return; raced = true;
            const latest = server.current().document;
            latest.bookmarks.unshift(collision ? entry('b', 'Concurrent replacement') : entry('new-second')); server.replace(latest);
        };
        const writes = server.writes;
        if (collision) {
            await assert.rejects(a.undo(), error => error.code === 'conflict');
            assert.equal(server.writes, writes + 1); assert.equal(a.canUndo(), true);
            assert.deepEqual(server.current().document.bookmarks.map(item => item.id), ['b', 'new-first']);
        } else {
            assert.deepEqual(await a.undo(), original);
            assert.equal(server.writes, writes + 2); assert.deepEqual(ids(a), ['new-second', 'new-first', 'a', 'b']);
        }
    }
});

test('unknown bulk undo outcomes keep the batch for a later verified idempotent retry', async () => {
    const original = [entry('a'), entry('b')], server = backend(original), a = client(server);
    await a.reload(); await a.removeAll();
    const write = server.write.bind(server);
    server.write = async (next, token) => { await write(next, token); throw Object.assign(Error('response lost'), { code: 'network', outcomeUnknown: true }); };
    const writes = server.writes;
    await assert.rejects(a.undo(), error => error.outcomeUnknown === true);
    assert.equal(server.writes, writes + 1); assert.deepEqual(a.list(), []); assert.equal(a.canUndo(), true);
    assert.deepEqual(server.current().document.bookmarks, original);
    server.write = write;
    assert.deepEqual(await a.undo(), original);
    assert.equal(server.writes, writes + 1, 'a verified existing batch requires no second restore write');
    assert.equal(a.canUndo(), false);
});

test('a quota reached during a bulk-undo CAS retry prevents every restoration write', async () => {
    const original = [entry('a'), entry('b')], server = backend(original), a = client(server);
    await a.reload(); await a.removeAll();
    server.replace({ version: 1, bookmarks: Array.from({ length: 48 }, (_, index) => entry('new-' + index)) });
    let raced = false;
    server.writeHook = () => {
        if (raced) return; raced = true;
        const latest = server.current().document; latest.bookmarks.unshift(entry('late-arrival')); server.replace(latest);
    };
    const writes = server.writes;
    await assert.rejects(a.undo(), error => error.code === 'invalid');
    assert.equal(server.writes, writes + 1); assert.equal(server.current().document.bookmarks.length, 49);
    assert.equal(server.current().document.bookmarks.some(item => item.id === 'a' || item.id === 'b'), false);
    assert.equal(a.canUndo(), true);
});

test('a bad bulk-undo acknowledgement remains unknown while canonical equivalent acknowledgements succeed', async () => {
    for (const bad of [false, true]) {
        const original = [entry('a'), entry('b')], server = backend(original), a = client(server);
        await a.reload(); await a.removeAll();
        const write = server.write.bind(server);
        server.write = async (next, token) => {
            const saved = await write(next, token);
            saved.document.bookmarks = bad ? [entry('unexpected')] : saved.document.bookmarks.map(item => ({ ...item, name: ' ' + item.name + ' ' }));
            return saved;
        };
        const writes = server.writes;
        if (bad) {
            await assert.rejects(a.undo(), error => error.code === 'invalid-response' && error.outcomeUnknown);
            assert.deepEqual(a.list(), []); assert.equal(a.canUndo(), true);
            assert.deepEqual(await a.undo(), original, 'the authoritative read can reconcile an already committed restore');
        } else assert.deepEqual(await a.undo(), original);
        assert.equal(server.writes, writes + 1); assert.deepEqual(a.list(), original); assert.equal(a.canUndo(), false);
    }
});

test('exhausted removeAll CAS conflicts require fresh confirmation and unknown conflicts are never retried', async () => {
    for (const unknown of [false, true]) {
        const server = backend([entry('a')]), a = client(server); await a.reload();
        server.write = async function() { this.writes++; throw Object.assign(Error('busy CAS'), { code: 'conflict', outcomeUnknown: unknown }); };
        await assert.rejects(a.removeAll(), error => error.code === 'conflict' && (unknown ? error.outcomeUnknown : /整份.*清單.*再次確認/.test(error.message)));
        assert.equal(server.writes, unknown ? 1 : 3); assert.deepEqual(ids(a), ['a']); assert.equal(a.canUndo(), false);
    }
});

test('an older queued bulk undo cannot erase a newer successful deletion undo record', async () => {
    const server = backend([entry('original')]), a = client(server, { now: () => 2 });
    await a.reload(); await a.removeAll();
    const gate = deferred(), reached = deferred();
    server.readHook = async value => { server.readHook = null; reached.resolve(); await gate.promise; return value; };
    const adding = a.add('New', snapshot()); await reached.promise;
    const next = { ...entry('added-1', 'New'), createdAt: 2, updatedAt: 2 };
    const clearing = a.removeAll({ expected: [next] }), olderUndo = a.undo();
    gate.resolve(); await adding; await clearing;
    assert.deepEqual(await olderUndo, [entry('original')]);
    assert.equal(a.canUndo(), true, 'the newer deleted batch remains available');
    assert.deepEqual(await a.undo(), [next]); assert.deepEqual(ids(a), ['original', 'added-1']);
});
