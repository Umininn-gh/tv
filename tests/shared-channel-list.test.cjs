const test = require('node:test');
const assert = require('node:assert/strict');
const ChannelList = require('../channel-list.js');

const CACHE = 'umininnSharedChannelCache';
const UPDATE = ChannelList.sharedUpdateKey;
const original = '原台,first,gosh\n另一台,second,twitch\n';
const added = original + '新台,third,kick\n';
const renamed = '新名稱,first,gosh\n另一台,second,twitch\n';
const deleted = '另一台,second,twitch\n';
const response = raw => ({ ok: true, text: async () => raw });
const offline = async () => { throw new Error('Offline'); };
const names = result => result.channels.map(channel => channel.name);

function storage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem: key => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key),
        values
    };
}

test('shared file is authoritative; legacy custom lists, deletion markers and backups remain untouched', async () => {
    const privateValues = {
        customChannels1: JSON.stringify([{ name: '舊私人名稱', id: 'first', platform: 'gosh', password: 'private-fixture' }, { name: '私人台', id: 'private', platform: 'kick' }]),
        customChannels: '{old-malformed-value',
        customChannels1LegacyImported: 'false',
        customChannels1RecoveryBackup: 'original-backup-fixture',
        umininnRemovedChannels: JSON.stringify(['gosh|first', 'twitch|second']),
        umininnChannelListCache: JSON.stringify([{ name: '舊快取', id: 'cached', platform: 'gosh' }])
    };
    const saved = storage(privateValues);
    const calls = [];
    const loaded = await ChannelList.loadSharedChannels(saved, async (url, options) => {
        calls.push({ url, options });
        return response(original);
    });
    assert.deepEqual(names(loaded), ['原台', '另一台']);
    assert.equal(loaded.raw, original);
    assert.equal(loaded.refreshed, true);
    assert.match(calls[0].url, /^\.\/ch1\.txt\?t=\d+$/);
    assert.equal(calls[0].options.cache, 'no-store');
    for (const [key, value] of Object.entries(privateValues)) assert.equal(saved.getItem(key), value, key + ' must be preserved');
    assert.ok(!JSON.stringify(loaded).includes('private-fixture'));
});

test('explicit shared records are not hidden by a historical availability blacklist', async () => {
    const loaded = await ChannelList.loadSharedChannels(storage(), async () => response('重新啟用,wing36747,kick\n'));
    assert.deepEqual(names(loaded), ['重新啟用']);
});

for (const [action, raw, expected] of [
    ['add', added, ['原台', '另一台', '新台']],
    ['edit', renamed, ['新名稱', '另一台']],
    ['delete', deleted, ['另一台']]
]) {
    test(`published ${action} is immediate and survives stale deployed file responses`, async () => {
        const saved = storage();
        await ChannelList.loadSharedChannels(saved, async () => response(original));
        assert.equal(ChannelList.publishSharedSnapshot(saved, raw, original), true);
        const loaded = await ChannelList.loadSharedChannels(saved, async () => response(original));
        assert.deepEqual(names(loaded), expected);
        assert.equal(loaded.raw, raw);
        assert.equal(JSON.parse(saved.getItem(CACHE)).raw, raw);
        const again = await ChannelList.loadSharedChannels(saved, async () => response(original));
        assert.equal(again.raw, raw);
    });
}

test('multiple publications retain the newest save across every known intermediate deployment', async () => {
    const saved = storage();
    await ChannelList.loadSharedChannels(saved, async () => response(original));
    ChannelList.publishSharedSnapshot(saved, added, original);
    ChannelList.publishSharedSnapshot(saved, renamed, added);
    for (const served of [original, added, original]) {
        const loaded = await ChannelList.loadSharedChannels(saved, async () => response(served));
        assert.equal(loaded.raw, renamed);
    }
});

test('actual merged save base is a recognized stale deployment even when absent from original UI snapshot', async () => {
    const saved = storage();
    await ChannelList.loadSharedChannels(saved, async () => response(original));
    const intervening = original + '其他人新增,remote,kick\n';
    const final = intervening + '自己新增,local,gosh\n';
    ChannelList.publishSharedSnapshot(saved, final, original, [intervening]);
    assert.equal((await ChannelList.loadSharedChannels(saved, async () => response(intervening))).raw, final);
});

test('latest deployment supersedes the pending publication and later legitimate reverts remain visible', async () => {
    const saved = storage();
    await ChannelList.loadSharedChannels(saved, async () => response(original));
    ChannelList.publishSharedSnapshot(saved, added, original);
    const newest = added + '後來新增,newest,gosh\n';
    const fresh = await ChannelList.loadSharedChannels(saved, async () => response(newest));
    assert.equal(fresh.raw, newest);
    assert.equal(JSON.parse(saved.getItem(UPDATE)), null);
    const reverted = await ChannelList.loadSharedChannels(saved, async () => response(original));
    assert.equal(reverted.raw, original);
});

test('once deployment catches up, clear pending overlay so a later revert is not masked', async () => {
    const saved = storage();
    await ChannelList.loadSharedChannels(saved, async () => response(original));
    ChannelList.publishSharedSnapshot(saved, added, original);
    const caughtUp = await ChannelList.loadSharedChannels(saved, async () => response(added));
    assert.equal(caughtUp.raw, added);
    assert.equal(JSON.parse(saved.getItem(UPDATE)), null);
    assert.equal((await ChannelList.loadSharedChannels(saved, async () => response(original))).raw, original);
});

test('offline loading retains only the shared cache, including a successful pending publication', async () => {
    const saved = storage({ customChannels1: JSON.stringify([{ name: '私人', id: 'private', platform: 'gosh' }]) });
    await ChannelList.loadSharedChannels(saved, async () => response(original));
    const cached = await ChannelList.loadSharedChannels(saved, offline);
    assert.equal(cached.raw, original);
    assert.equal(cached.refreshed, false);
    ChannelList.publishSharedSnapshot(saved, renamed, original);
    const pending = await ChannelList.loadSharedChannels(saved, offline);
    assert.equal(pending.raw, renamed);
    assert.equal(pending.refreshed, false);
    assert.deepEqual(names(pending), ['新名稱', '另一台']);
});

test('pending publication works before any shared cache exists and while offline', async () => {
    const saved = storage();
    ChannelList.publishSharedSnapshot(saved, added, original);
    const loaded = await ChannelList.loadSharedChannels(saved, offline);
    assert.equal(loaded.raw, added);
    assert.deepEqual(names(loaded), ['原台', '另一台', '新台']);
});

test('invalid network refresh retains shared cache and pending publication', async () => {
    const saved = storage();
    await ChannelList.loadSharedChannels(saved, async () => response(original));
    ChannelList.publishSharedSnapshot(saved, renamed, original);
    const loaded = await ChannelList.loadSharedChannels(saved, async () => response('<html>not a channel file</html>'));
    assert.equal(loaded.raw, renamed);
    assert.equal(loaded.refreshed, false);
});

test('valid empty shared files and published deletion of the last channel stay empty', async () => {
    const saved = storage();
    await ChannelList.loadSharedChannels(saved, async () => response(original));
    const empty = await ChannelList.loadSharedChannels(saved, async () => response(''));
    assert.equal(empty.raw, '');
    assert.deepEqual(empty.channels, []);
    assert.equal((await ChannelList.loadSharedChannels(saved, offline)).raw, '');
    ChannelList.publishSharedSnapshot(saved, '', original);
    assert.deepEqual((await ChannelList.loadSharedChannels(saved, async () => response(original))).channels, []);
});

test('a publication wins over an older file fetch already in flight', async () => {
    const saved = storage();
    let resolve;
    const pendingResponse = new Promise(done => { resolve = done; });
    const loading = ChannelList.loadSharedChannels(saved, () => pendingResponse);
    ChannelList.publishSharedSnapshot(saved, added, original);
    resolve(response(original));
    assert.equal((await loading).raw, added);
});

test('an in-flight response cannot erase a newer publication even if that old version was not cached', async () => {
    const saved = storage();
    let resolve;
    const pendingResponse = new Promise(done => { resolve = done; });
    const loading = ChannelList.loadSharedChannels(saved, () => pendingResponse);
    ChannelList.publishSharedSnapshot(saved, added, original);
    resolve(response('更舊部署,older,gosh\n'));
    const loaded = await loading;
    assert.equal(loaded.raw, added);
    assert.equal(JSON.parse(saved.getItem(UPDATE)).raw, added);
});

test('a stale in-flight response cannot resurrect old channels after another tab confirms deployment', async () => {
    const saved = storage();
    await ChannelList.loadSharedChannels(saved, async () => response(original));
    ChannelList.publishSharedSnapshot(saved, added, original);
    let resolve;
    const pendingResponse = new Promise(done => { resolve = done; });
    const oldLoad = ChannelList.loadSharedChannels(saved, () => pendingResponse);
    await ChannelList.loadSharedChannels(saved, async () => response(added));
    assert.equal(JSON.parse(saved.getItem(UPDATE)), null);
    resolve(response(original));
    assert.equal((await oldLoad).raw, added);
    assert.equal(JSON.parse(saved.getItem(CACHE)).raw, added);
});

test('provided text uses the same overlay logic without making another network request', async () => {
    const saved = storage();
    ChannelList.publishSharedSnapshot(saved, renamed, original);
    const loaded = await ChannelList.loadSharedChannels(saved, () => { throw new Error('Should not fetch'); }, original);
    assert.equal(loaded.raw, renamed);
});

test('unavailable or malformed browser storage cannot corrupt legacy private values', async () => {
    const privateRaw = '[private-unparseable-fixture';
    const saved = storage({ customChannels1: privateRaw, [CACHE]: '{broken', [UPDATE]: '{broken' });
    const loaded = await ChannelList.loadSharedChannels(saved, offline);
    assert.equal(loaded.raw, null);
    assert.deepEqual(loaded.channels, []);
    assert.equal(saved.getItem('customChannels1'), privateRaw);
    const unavailable = { getItem() { throw new Error('Denied'); }, setItem() { throw new Error('Denied'); } };
    assert.equal((await ChannelList.loadSharedChannels(unavailable, async () => response(original))).raw, original);
    assert.equal(ChannelList.publishSharedSnapshot(unavailable, added, original), false);
});
