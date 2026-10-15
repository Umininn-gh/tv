const test = require('node:test');
const assert = require('node:assert/strict');
const ChannelSync = require('../channel-sync.js');
const config = require('../channel-sync-config.js');

const initial = '美1,meidingdang,gosh\n大波,dindinxd19,twitch\n';
const channel = (name, id, platform = 'gosh') => ({ name, id, platform });
const response = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: name => headers[name.toLowerCase()] || null }, json: async () => body });
const file = (raw, sha = 'sha-1') => response(200, { type: 'file', encoding: 'base64', content: Buffer.from(raw).toString('base64'), sha });
const stored = (sha = 'sha-saved') => response(200, { content: { sha }, commit: { sha: 'commit-sha', html_url: 'https://github.com/Umininn-gh/tv/commit/commit-sha' } });
function server(steps) {
    const requests = [];
    return {
        requests,
        fetch: async (url, options) => {
            requests.push({ url, ...options, ...(options.body ? { payload: JSON.parse(options.body) } : {}) });
            assert.ok(steps.length, 'Unexpected request');
            const next = steps.shift();
            return typeof next === 'function' ? next(url, options) : next;
        }
    };
}

test('reads UTF-8 channels and canonical IDs from fixed GitHub Contents endpoint', async () => {
    const remote = server([file('哥二,Godzilla_2027,gosh\r\n')]);
    const result = await ChannelSync.createClient(config, remote.fetch).read();
    assert.deepEqual(result.channels, [channel('哥二', 'godzilla_2027')]);
    assert.equal(result.raw, '哥二,Godzilla_2027,gosh\r\n');
    assert.equal(result.sha, 'sha-1');
    assert.equal(remote.requests[0].url, 'https://api.github.com/repos/Umininn-gh/tv/contents/ch1.txt?ref=main');
    assert.equal(remote.requests[0].credentials, 'omit');
    assert.equal(remote.requests[0].redirect, 'error');
    assert.equal(remote.requests[0].headers.Authorization, undefined);
});

test('serializes public fields only and preserves Unicode', () => {
    assert.equal(ChannelSync.serializeChannels([{ ...channel('美台 📺', 'MeidingDang'), password: 'private', _fromTxt: true, secret: 'private' }]), '美台 📺,meidingdang,gosh\n');
    assert.equal(ChannelSync.serializeChannels([channel('完整網址', 'https://www.twitch.tv/Some_User', 'twitch')]), '完整網址,some_user,twitch\n');
});

test('rejects CSV injection, invalid channels, and invalid GoodGame public usernames', () => {
    for (const name of ['台,二', '台\n二', '\n台', '台\r', '台\u0000二', '台\t二', '台\u2028二']) {
        assert.throws(() => ChannelSync.serializeChannels([channel(name, 'valid')]), error => error.code === 'validation');
    }
    assert.throws(() => ChannelSync.serializeChannels([channel('台', 'id', 'unknown')]), error => error.code === 'validation');
    assert.throws(() => ChannelSync.serializeChannels([{ ...channel('台', '123', 'goodgame'), ggUsername: 'bad name' }]), error => error.code === 'validation');
});

test('URL-bearing platforms accept only absolute HTTP(S) sources', async () => {
    for (const platform of ['bs', 'm3u8']) {
        for (const id of ['javascript:alert(1)', 'data:text/html,hello', 'file:///stream.m3u8', '/relative/stream.m3u8', '//example.com/stream', 'http:example.com', 'not-a-url']) {
            assert.throws(() => ChannelSync.serializeChannels([channel('來源', id, platform)]), error => error.code === 'validation');
        }
        for (const id of ['https://example.com/live.m3u8', 'http://example.com/player']) {
            assert.equal(ChannelSync.serializeChannels([channel('來源', id, platform)]), `來源,${id},${platform}\n`);
        }
        await assert.rejects(ChannelSync.createClient(config, server([file(`來源,javascript:alert(1),${platform}\n`)]).fetch).read(), error => error.code === 'invalid_data');
    }
});

test('URL credentials cannot be promoted from legacy entries into the public shared file', async () => {
    for (const platform of ['bs', 'm3u8']) {
        for (const id of ['https://private-user:private-password@example.com/stream', 'https://private-user@example.com/player', 'https://:private-password@example.com/live']) {
            assert.throws(() => ChannelSync.serializeChannels([channel('私人來源', id, platform)]), error => error.code === 'validation' && /私人登入/.test(error.message) && !error.message.includes('private-password'));
        }
        const remote = server([file(initial)]);
        const client = ChannelSync.createClient(config, remote.fetch);
        const snapshot = await client.read();
        await assert.rejects(client.save(snapshot, { action: 'add', channel: channel('私人來源', 'https://private-user:private-password@example.com/player', platform) }, 'test-token'), error => error.code === 'validation');
        assert.equal(remote.requests.length, 1);
    }
});

test('unknown, malformed, private and duplicate remote rows fail rather than being dropped', async () => {
    for (const raw of ['未知台,id,newplatform\n', '台,id\n', '台,id,gosh,password\n', '台,id,gosh\n台二,ID,gosh\n', '台,id,gosh\nbad row\n']) {
        const remote = server([file(raw)]);
        await assert.rejects(ChannelSync.createClient(config, remote.fetch).read(), error => error.code === 'invalid_data' && /保留/.test(error.message));
    }
});

test('empty and comment-only files are valid empty lists; the last channel can be deleted', async () => {
    const remote = server([file(''), file('# 清單\n'), file('台,id,gosh\n'), stored()]);
    const client = ChannelSync.createClient(config, remote.fetch);
    assert.deepEqual((await client.read()).channels, []);
    assert.deepEqual((await client.read()).channels, []);
    const snapshot = { channels: [channel('台', 'id')], raw: '台,id,gosh\n', sha: 'old-sha' };
    const saved = await client.save(snapshot, { action: 'delete', previous: snapshot.channels[0] }, 'test-token');
    assert.equal(saved.raw, '');
    assert.deepEqual(saved.channels, []);
    assert.equal(Buffer.from(remote.requests[3].payload.content, 'base64').toString('utf8'), '');
});

test('adding retains remote additions and uses latest SHA, never mutates caller snapshot', async () => {
    const remote = server([file(initial), file(initial + '遠端新增,remote,kick\n', 'sha-2'), stored()]);
    const client = ChannelSync.createClient(config, remote.fetch);
    const snapshot = await client.read();
    const before = structuredClone(snapshot);
    const result = await client.save(snapshot, { action: 'add', channel: { ...channel('本地新增', 'LOCAL'), password: 'private', _fromAPI: true } }, 'test-token');
    assert.deepEqual(snapshot, before);
    assert.equal(result.channels.length, 4);
    assert.equal(result.channels[2].name, '遠端新增');
    assert.deepEqual(result.channels[3], channel('本地新增', 'local'));
    assert.equal(remote.requests[2].payload.sha, 'sha-2');
    assert.equal(remote.requests[2].headers.Authorization, 'Bearer test-token');
    assert.equal(Buffer.from(remote.requests[2].payload.content, 'base64').toString('utf8'), result.raw);
    assert.equal(result.sha, 'sha-saved');
    assert.equal(result.baseRaw, initial + '遠端新增,remote,kick\n');
    assert.equal(result.commit.sha, 'commit-sha');
    assert.ok(!JSON.stringify(result).includes('test-token'));
    assert.ok(!JSON.stringify(result).includes('private'));
});

test('edits may change platform and canonical ID while preserving list order', async () => {
    const remote = server([file(initial), file(initial, 'sha-2'), stored()]);
    const client = ChannelSync.createClient(config, remote.fetch);
    const snapshot = await client.read();
    const saved = await client.save(snapshot, { action: 'edit', previous: snapshot.channels[0], channel: channel('新台', 'https://www.twitch.tv/NEW_Channel', 'twitch') }, 'test-token');
    assert.deepEqual(saved.channels[0], channel('新台', 'new_channel', 'twitch'));
    assert.deepEqual(saved.channels[1], snapshot.channels[1]);
});

test('add and edit reject duplicate canonical platform + ID; another platform is distinct', async () => {
    for (const mutation of [
        { action: 'add', channel: channel('撞名', 'MEIDINGDANG') },
        { action: 'edit', previous: channel('美1', 'meidingdang'), channel: channel('撞名', 'https://twitch.tv/DINDINXD19', 'twitch') }
    ]) {
        const remote = server([file(initial), file(initial)]);
        const client = ChannelSync.createClient(config, remote.fetch);
        const snapshot = await client.read();
        await assert.rejects(client.save(snapshot, mutation, 'test-token'), error => error.code === 'duplicate');
        assert.equal(remote.requests.length, 2);
    }
    const remote = server([file(initial), file(initial), stored()]);
    const client = ChannelSync.createClient(config, remote.fetch);
    const snapshot = await client.read();
    const saved = await client.save(snapshot, { action: 'add', channel: channel('另一平台', 'meidingdang', 'vaughn') }, 'test-token');
    assert.equal(saved.channels.length, 3);
});

test('an edit or deletion of the same target by another writer blocks the PUT', async () => {
    for (const raw of ['改名,meidingdang,gosh\n大波,dindinxd19,twitch\n', '大波,dindinxd19,twitch\n']) {
        for (const action of ['edit', 'delete']) {
            const remote = server([file(initial), file(raw, 'sha-2')]);
            const client = ChannelSync.createClient(config, remote.fetch);
            const snapshot = await client.read();
            await assert.rejects(client.save(snapshot, { action, previous: snapshot.channels[0], channel: channel('新名', 'meidingdang') }, 'test-token'), error => error.code === 'conflict');
            assert.equal(remote.requests.filter(request => request.method === 'PUT').length, 0);
        }
    }
});

test('a SHA conflict retries once and retains unrelated concurrent changes', async () => {
    const remote = server([file(initial), file(initial), response(409, {}), file(initial + '其他人,other,kick\n', 'sha-3'), stored('sha-4')]);
    const client = ChannelSync.createClient(config, remote.fetch);
    const snapshot = await client.read();
    const saved = await client.save(snapshot, { action: 'edit', previous: snapshot.channels[0], channel: channel('改名', 'meidingdang') }, 'test-token');
    assert.equal(saved.channels.length, 3);
    assert.equal(saved.channels[2].name, '其他人');
    assert.equal(remote.requests[4].payload.sha, 'sha-3');
    assert.equal(saved.sha, 'sha-4');
    assert.equal(saved.baseRaw, initial + '其他人,other,kick\n');
});

test('a SHA conflict followed by a target change prevents a second PUT', async () => {
    const remote = server([file(initial), file(initial), response(409, {}), file('別人改名,meidingdang,gosh\n', 'sha-3')]);
    const client = ChannelSync.createClient(config, remote.fetch);
    const snapshot = await client.read();
    const before = structuredClone(snapshot);
    await assert.rejects(client.save(snapshot, { action: 'delete', previous: snapshot.channels[0] }, 'test-token'), error => error.code === 'conflict');
    assert.deepEqual(snapshot, before);
    assert.equal(remote.requests.filter(request => request.method === 'PUT').length, 1);
});

test('repeated SHA conflicts stop after two PUTs', async () => {
    const remote = server([file(initial), file(initial), response(409, {}), file(initial, 'sha-2'), response(409, {})]);
    const client = ChannelSync.createClient(config, remote.fetch);
    const snapshot = await client.read();
    await assert.rejects(client.save(snapshot, { action: 'add', channel: channel('新增', 'new') }, 'test-token'), error => error.code === 'conflict');
    assert.equal(remote.requests.filter(request => request.method === 'PUT').length, 2);
});

test('failed PUT and unconfirmed success never mutate the snapshot or report success', async () => {
    for (const result of [response(500, {}), response(401, {}), response(200, {})]) {
        const remote = server([file(initial), file(initial), result]);
        const client = ChannelSync.createClient(config, remote.fetch);
        const snapshot = await client.read();
        const before = structuredClone(snapshot);
        await assert.rejects(client.save(snapshot, { action: 'delete', previous: snapshot.channels[0] }, 'test-token'));
        assert.deepEqual(snapshot, before);
    }
});

test('auth, rate limits and network failures have actionable Traditional Chinese errors', async () => {
    for (const [result, code] of [[response(401, {}), 'auth'], [response(403, {}), 'permission'], [response(403, {}, { 'x-ratelimit-remaining': '0' }), 'rate_limit'], [response(429, {}), 'rate_limit'], [response(404, {}), 'not_found']]) {
        await assert.rejects(ChannelSync.createClient(config, server([result]).fetch).read('test-token'), error => error.code === code && /GitHub|共享清單/.test(error.message));
    }
    await assert.rejects(ChannelSync.createClient(config, async () => { const error = new Error('native failure'); error.code = 'ECONNRESET'; throw error; }).read(), error => error.code === 'network' && !error.message.includes('native'));
});

test('timeout aborts the request and reports uncertain save outcome', async () => {
    const client = ChannelSync.createClient({ ...config, requestTimeoutMs: 5 }, (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    await assert.rejects(client.read(), error => error.code === 'timeout' && /確認結果/.test(error.message));
});

test('timeout also bounds a stalled transport or response body that ignores abort', async () => {
    const stalled = () => new Promise(() => {});
    for (const fetcher of [stalled, async () => ({ ok: true, json: stalled })]) {
        const client = ChannelSync.createClient({ ...config, requestTimeoutMs: 5 }, fetcher);
        await assert.rejects(client.read(), error => error.code === 'timeout');
    }
});

test('invalid token, stale snapshot and invalid configuration fail before any request', async () => {
    const remote = server([]);
    const client = ChannelSync.createClient(config, remote.fetch);
    const snapshot = { channels: [channel('台', 'id')], raw: '台,id,gosh\n', sha: 'sha-1' };
    await assert.rejects(client.save(snapshot, { action: 'add', channel: channel('新', 'new') }, ''), error => error.code === 'auth');
    await assert.rejects(client.save(snapshot, { action: 'delete', previous: channel('舊名', 'id') }, 'test-token'), error => error.code === 'conflict');
    assert.equal(remote.requests.length, 0);
    for (const changed of [{ owner: 'bad/owner' }, { repo: 'bad/repo' }, { path: '../secret' }, { branch: 'main\r\nX: invalid' }]) {
        assert.throws(() => ChannelSync.createClient({ ...config, ...changed }, remote.fetch), error => error.code === 'configuration');
    }
});
