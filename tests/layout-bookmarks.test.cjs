'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSnapshot, createStore } = require('../layout-bookmarks.js');

const STORAGE_KEY = 'umininn.layoutBookmarks.v1';
const snapshot = (overrides = {}) => ({
    channels: [
        { key: 'twitch|somebody', name: 'WJ', color: 212 },
        { key: 'at|another', name: '絕', color: 24 },
        { key: 'm3u8|https://stream.invalid/live.m3u8?token=a%20b', name: '自訂影片', color: 143 }
    ],
    columns: 3,
    focus: { key: 'twitch|somebody', row: 0, column: 1, span: 2 },
    aspectRatio: 1.5,
    ...overrides
});

function memoryStorage(seed = null) {
    const values = new Map(seed === null ? [] : [[STORAGE_KEY, seed]]);
    return {
        writes: 0,
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { this.writes++; values.set(key, String(value)); },
        removeItem(key) { values.delete(key); }
    };
}

test('layout snapshot keeps visual order, one enlarged square, full URL channel keys and saved thumbnail colours', () => {
    const original = snapshot();
    const normalized = normalizeSnapshot(original);
    assert.deepEqual(normalized, original);
    assert.notEqual(normalized, original);
    assert.notEqual(normalized.channels[0], original.channels[0]);
    assert.notEqual(normalized.focus, original.focus);
    original.channels[0].name = 'Changed externally';
    original.focus.span = 99;
    assert.equal(normalized.channels[0].name, 'WJ');
    assert.equal(normalized.focus.span, 2);
    assert.deepEqual(normalizeSnapshot(normalized), normalized, 'reading an existing bookmark must not pick new random colours');
});

test('normalization accepts a single normal player and gives missing colours valid random hues without exposing HTML', () => {
    const name = ' <img src=x onerror=alert(1)> & " 名稱 ';
    const normal = normalizeSnapshot(snapshot({
        channels: [{ key: 'at|one', name }], columns: 1, focus: null, aspectRatio: undefined
    }));
    assert.equal(normal.channels[0].name, name.trim());
    assert.ok(Number.isInteger(normal.channels[0].color));
    assert.ok(normal.channels[0].color >= 0 && normal.channels[0].color < 360);
    assert.equal(normal.aspectRatio, 16 / 9);
    assert.equal(normal.focus, null);
    assert.deepEqual(normalizeSnapshot(normal), normal);
});

test('snapshot limits reject corrupt geometry and ambiguous channel membership before it can affect live players', () => {
    const bad = [
        null, [], {}, snapshot({ channels: [] }),
        snapshot({ channels: Array.from({ length: 257 }, (_, i) => ({ key: 'at|' + i, name: '' + i })) }),
        snapshot({ channels: [{ key: '', name: 'Missing key' }] }),
        snapshot({ channels: [{ key: ' '.repeat(8), name: 'Blank key' }] }),
        snapshot({ channels: [{ key: 'x'.repeat(4097), name: 'Oversized key' }] }),
        snapshot({ channels: [{ key: 'at|a', name: ' ' }] }),
        snapshot({ channels: [{ key: 'at|a', name: 'A' }, { key: 'at|a', name: 'B' }] }),
        ...[0, -1, 1.5, 769, NaN, Infinity].map(columns => snapshot({ columns })),
        snapshot({ focus: { key: 'at|missing', row: 0, column: 0, span: 2 } }),
        ...[1, 257, 1.5].map(span => snapshot({ focus: { key: 'at|another', row: 0, column: 0, span } })),
        ...[-1, 513, .5].map(row => snapshot({ focus: { key: 'at|another', row, column: 0, span: 2 } })),
        ...[-1, 513, .5].map(column => snapshot({ focus: { key: 'at|another', row: 0, column, span: 2 } })),
        snapshot({ columns: 2, focus: { key: 'at|another', row: 0, column: 1, span: 2 } })
    ];
    for (const value of bad) assert.throws(() => normalizeSnapshot(value), Error);
});

test('snapshot normalization bounds preview aspect ratio and names while preserving intentional colours', () => {
    for (const [input, expected] of [[.01, .35], [20, 4], [1.25, 1.25], [NaN, 16 / 9]]) {
        assert.equal(normalizeSnapshot(snapshot({ aspectRatio: input })).aspectRatio, expected);
    }
    const value = normalizeSnapshot(snapshot({ channels: [{ key: 'at|a', name: '名字'.repeat(200), color: 0 }], focus: null }));
    assert.ok(value.channels[0].name.length <= 200);
    assert.equal(value.channels[0].color, 0, 'zero hue is a real saved colour');
});

test('new bookmarks prepend while rename, update and reload preserve the saved order and preview colours', () => {
    const storage = memoryStorage();
    const store = createStore(storage);
    assert.deepEqual(store.list(), []);
    const first = store.add('  夜更  ', snapshot());
    const second = store.add('夜更', snapshot({ focus: null }));
    assert.deepEqual(store.list().map(value => value.id), [second.id, first.id]);
    assert.equal(first.name, '夜更');
    assert.notEqual(first.id, second.id, 'same visible names still refer to independent bookmarks');
    assert.equal(store.rename(first.id, '  劇集  ').name, '劇集');
    const changed = snapshot({ columns: 2, focus: null, aspectRatio: .7 });
    assert.deepEqual(store.update(first.id, changed).snapshot, changed);
    const saved = store.list();
    assert.deepEqual(saved.map(value => value.id), [second.id, first.id]);
    assert.deepEqual(createStore(storage).list(), saved);
    assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).version, 1);
});

test('returned bookmarks are independent copies so editing a UI draft cannot silently mutate stored layouts', () => {
    const storage = memoryStorage(), store = createStore(storage);
    const original = snapshot(), saved = store.add('安全副本', original);
    original.channels[0].name = 'Mutated capture';
    saved.snapshot.channels[0].name = 'Mutated return';
    const list = store.list();
    list[0].snapshot.focus.span = 50;
    list.splice(0);
    const persisted = createStore(storage).list();
    assert.equal(store.list()[0].snapshot.channels[0].name, 'WJ');
    assert.equal(persisted[0].snapshot.focus.span, 2);
    assert.equal(persisted.length, 1);
});

test('delete has a single undo which restores its original position and survives a complete persistence roundtrip', () => {
    const storage = memoryStorage(), store = createStore(storage);
    const first = store.add('One', snapshot()), middle = store.add('Two', snapshot()), last = store.add('Three', snapshot());
    assert.equal(store.canUndo(), false);
    assert.equal(store.remove(middle.id).id, middle.id);
    assert.deepEqual(store.list().map(value => value.id), [last.id, first.id]);
    assert.equal(store.canUndo(), true);
    assert.equal(store.undo().id, middle.id);
    assert.equal(store.canUndo(), false);
    assert.equal(store.undo(), null);
    assert.deepEqual(createStore(storage).list().map(value => value.id), [last.id, middle.id, first.id]);
});

test('empty names, missing IDs and full capacity leave the existing bookmarks intact', () => {
    const storage = memoryStorage(), store = createStore(storage);
    const first = store.add('A', snapshot());
    assert.throws(() => store.add('   ', snapshot()), Error);
    assert.throws(() => store.rename(first.id, ''), Error);
    assert.throws(() => store.rename('missing', 'B'), Error);
    assert.throws(() => store.update('missing', snapshot()), Error);
    assert.throws(() => store.remove('missing'), Error);
    assert.equal(store.list().length, 1);
    assert.ok(store.rename(first.id, '名字'.repeat(80)).name.length <= 60);
    while (store.list().length < 50) store.add('Layout ' + store.list().length, snapshot());
    const before = store.list(), raw = storage.getItem(STORAGE_KEY);
    assert.throws(() => store.add('Overflow', snapshot()), Error);
    assert.deepEqual(store.list(), before);
    assert.equal(storage.getItem(STORAGE_KEY), raw);
});

test('a failed write cannot claim a save, rename, update, delete or undo succeeded', () => {
    const storage = memoryStorage(), store = createStore(storage);
    const first = store.add('A', snapshot());
    const originalWrite = storage.setItem;
    storage.setItem = () => { throw new Error('QuotaExceededError'); };
    const raw = storage.getItem(STORAGE_KEY), before = store.list();
    for (const action of [
        () => store.add('B', snapshot()), () => store.rename(first.id, 'Renamed'),
        () => store.update(first.id, snapshot({ focus: null })), () => store.remove(first.id)
    ]) {
        assert.throws(action, Error);
        assert.deepEqual(store.list(), before);
        assert.equal(storage.getItem(STORAGE_KEY), raw);
    }
    storage.setItem = originalWrite;
    store.remove(first.id);
    storage.setItem = () => { throw new Error('SecurityError'); };
    assert.throws(() => store.undo(), Error);
    assert.deepEqual(store.list(), []);
    assert.equal(store.canUndo(), true, 'an unsuccessful undo can be tried again');
    storage.setItem = originalWrite;
    assert.equal(store.undo().id, first.id);
});

test('corrupt or unreadable storage is reported and never overwritten by a new save', () => {
    for (const raw of ['{broken', JSON.stringify({ version: 999, bookmarks: [] }), JSON.stringify({ version: 1, bookmarks: {} })]) {
        const storage = memoryStorage(raw), store = createStore(storage);
        assert.deepEqual(store.list(), []);
        assert.ok(store.getError() instanceof Error);
        assert.throws(() => store.add('Must not overwrite', snapshot()), Error);
        assert.equal(storage.getItem(STORAGE_KEY), raw);
        assert.equal(storage.writes, 0);
    }
    let writes = 0;
    const store = createStore({ getItem() { throw new Error('SecurityError'); }, setItem() { writes++; } });
    assert.deepEqual(store.list(), []);
    assert.ok(store.getError() instanceof Error);
    assert.throws(() => store.add('Blocked', snapshot()), Error);
    assert.equal(writes, 0);
});

test('independent open tabs merge each mutation with the latest storage rather than overwriting other tab changes', () => {
    const storage = memoryStorage(), tabA = createStore(storage), tabB = createStore(storage);
    const first = tabA.add('First tab', snapshot());
    const second = tabB.add('Second tab', snapshot());
    assert.equal(tabA.rename(first.id, 'Updated in first tab').name, 'Updated in first tab');
    tabB.reload();
    assert.deepEqual(tabB.list().map(value => value.id), [second.id, first.id]);
    assert.equal(tabB.list().find(value => value.id === first.id).name, 'Updated in first tab');
    tabB.remove(first.id);
    tabA.reload();
    assert.deepEqual(tabA.list().map(value => value.id), [second.id]);
    assert.throws(() => tabA.rename(first.id, 'Deleted elsewhere'), Error);
    assert.deepEqual(createStore(storage).list().map(value => value.id), [second.id]);
});

test('audio snapshots distinguish legacy layout-only from explicit silence and retain only validated per-channel volumes in channel order', () => {
    const legacy = normalizeSnapshot(snapshot());
    assert.equal(Object.hasOwn(legacy, 'audio'), false);
    assert.deepEqual(normalizeSnapshot(snapshot({ audio: { version: 1, audible: [] } })).audio, { version: 1, audible: [] });
    const original = snapshot({ audio: { version: 1, audible: [
        { key: 'at|another', volume: .35 }, { key: 'twitch|somebody', volume: 1 }
    ] } });
    const normalized = normalizeSnapshot(original);
    assert.deepEqual(normalized.audio, { version: 1, audible: [
        { key: 'twitch|somebody', volume: 1 }, { key: 'at|another', volume: .35 }
    ] });
    original.audio.audible[0].volume = .9;
    assert.equal(normalized.audio.audible[1].volume, .35);
    assert.deepEqual(normalizeSnapshot(normalized), normalized);
    const malformed = [undefined, null, {}, { version: 2, audible: [] }, { version: 1, audible: null },
        { version: 1, audible: [{ key: 'at|removed', volume: .2 }] },
        { version: 1, audible: [{ key: 'at|another', volume: .2 }, { key: 'at|another', volume: .4 }] },
        ...[0, -1, 1.1, NaN, Infinity, '0.5', null].map(volume => ({ version: 1, audible: [{ key: 'at|another', volume }] }))];
    for (const audio of malformed) assert.throws(() => normalizeSnapshot(snapshot({ audio })), Error);
});

test('local audio survives CRUD and layout-only updates retain only surviving channels while explicit audio replaces it', () => {
    const storage = memoryStorage(), store = createStore(storage);
    const saved = store.add('With audio', snapshot({ audio: { version: 1, audible: [
        { key: 'twitch|somebody', volume: .2 }, { key: 'at|another', volume: .75 }
    ] } }));
    store.rename(saved.id, 'Renamed');
    const changed = snapshot({ channels: [{ key: 'at|another', name: '絕', color: 24 }, { key: 'at|new', name: '新台', color: 34 }], focus: null });
    assert.deepEqual(store.update(saved.id, changed).snapshot.audio, { version: 1, audible: [{ key: 'at|another', volume: .75 }] });
    store.remove(saved.id); store.undo();
    assert.deepEqual(createStore(storage).list()[0].snapshot.audio, { version: 1, audible: [{ key: 'at|another', volume: .75 }] });
    assert.deepEqual(store.update(saved.id, { ...changed, audio: { version: 1, audible: [] } }).snapshot.audio, { version: 1, audible: [] });
    assert.deepEqual(store.update(saved.id, changed).snapshot.audio, { version: 1, audible: [] }, 'a non-userscript update preserves explicit silence');
    const legacy = store.add('Legacy', snapshot());
    assert.equal(Object.hasOwn(store.update(legacy.id, changed).snapshot, 'audio'), false);
});

test('malformed audio saves and imports cannot overwrite the existing local audio settings', () => {
    const storage = memoryStorage(), store = createStore(storage);
    const saved = store.add('Safe', snapshot({ audio: { version: 1, audible: [{ key: 'at|another', volume: .3 }] } }));
    const before = storage.getItem(STORAGE_KEY), writes = storage.writes;
    assert.throws(() => store.update(saved.id, snapshot({ audio: { version: 1, audible: [{ key: 'at|another', volume: 0 }] } })));
    assert.throws(() => store.importLocal([{ ...saved, id: 'import-invalid', snapshot: snapshot({ audio: { version: 1, audible: [{ key: 'missing', volume: 1 }] } }) }]));
    assert.equal(storage.getItem(STORAGE_KEY), before);
    assert.equal(storage.writes, writes);
    const imported = { ...saved, id: 'import-valid', name: 'Imported' };
    assert.equal(store.importLocal([imported]), 1);
    assert.deepEqual(createStore(storage).list().find(item => item.id === 'import-valid').snapshot.audio, saved.snapshot.audio);
});
