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

test('concurrent creates preserve both additions through a CAS retry', async () => {
    const server = backend(), a = client(server, { makeId: () => 'from-a' }), b = client(server, { makeId: () => 'from-b' });
    await Promise.all([a.reload(), b.reload()]);
    const ready = deferred(), both = deferred(); let readers = 0;
    server.readHook = async value => { if (++readers === 2) { server.readHook = null; both.resolve(); } ready.resolve(); await both.promise; return value; };
    await Promise.all([a.add('A', snapshot()), b.add('B', snapshot())]);
    assert.deepEqual(server.current().document.bookmarks.map(item => item.id).sort(), ['from-a', 'from-b']);
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
    assert.deepEqual(ids(a), ['a', 'b', 'c', 'new']);
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
    local.move(c.id, 'up');
    assert.deepEqual(ids(local), [a.id, c.id, b.id]);
    local.move(a.id, 'up'); local.move(b.id, 'down');
    assert.deepEqual(ids(createLocalStore(localStorage)), [a.id, c.id, b.id]);
    local.importLocal([entry('imported', 'Import')]);
    local.importLocal([entry('imported', 'Import')]);
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
