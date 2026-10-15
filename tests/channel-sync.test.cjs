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

test('addMissing appends public fields in one commit and preserves existing rows and metadata verbatim', async () => {
    const raw = '# 手動排序\r\n我的名稱,Godzilla_2027,gosh\r\nGoodGame,123,goodgame,Public_User';
    const candidates = [
        channel('來源名稱', 'GODZILLA_2027'),
        { ...channel('來源 GG', '123', 'goodgame'), ggUsername: 'Other_User' },
        { ...channel('新台 📺', 'NEW'), password: 'private-password', token: 'private-token', _fromAPI: true },
        { ...channel('新 GG', '456', 'goodgame'), ggUsername: 'New_Public', privateId: 'private-id' }
    ];
    const before = structuredClone(candidates);
    const remote = server([file(raw, 'sha-latest'), stored()]);
    const saved = await ChannelSync.createClient(config, remote.fetch).addMissing(candidates, 'test-token');
    assert.deepEqual(candidates, before);
    assert.equal(saved.raw, raw + '\n新台 📺,new,gosh\n新 GG,456,goodgame,New_Public\n');
    assert.deepEqual(saved.channels.slice(0, 2), [channel('我的名稱', 'godzilla_2027'), { ...channel('GoodGame', '123', 'goodgame'), ggUsername: 'Public_User' }]);
    assert.deepEqual(saved.added, [channel('新台 📺', 'new'), { ...channel('新 GG', '456', 'goodgame'), ggUsername: 'New_Public' }]);
    assert.equal(saved.unchanged, false);
    assert.equal(saved.baseRaw, raw);
    assert.equal(saved.sha, 'sha-saved');
    assert.equal(saved.commit.sha, 'commit-sha');
    assert.deepEqual(remote.requests.map(request => request.method), ['GET', 'PUT']);
    assert.equal(remote.requests[1].payload.sha, 'sha-latest');
    assert.equal(remote.requests[1].payload.branch, 'main');
    assert.equal(Buffer.from(remote.requests[1].payload.content, 'base64').toString('utf8'), saved.raw);
    for (const request of remote.requests) {
        assert.ok(request.url.startsWith('https://api.github.com/repos/Umininn-gh/tv/contents/ch1.txt'));
        assert.equal(request.headers.Authorization, 'Bearer test-token');
        assert.equal(request.credentials, 'omit');
        assert.equal(request.redirect, 'error');
    }
    assert.ok(!JSON.stringify(saved).includes('private-'));
    assert.ok(!JSON.stringify(saved).includes('test-token'));
    assert.ok(!JSON.stringify(remote.requests[1].payload).includes('test-token'));
});

test('addMissing returns the exact latest snapshot with no PUT when nothing is missing', async () => {
    const raw = '# 最新清單\r\n自訂名,Godzilla_2027,gosh\r\n自訂 Twitch,DINDINXD19,twitch';
    for (const candidates of [[], [channel('來源名', 'GODZILLA_2027'), channel('來源名二', 'https://www.twitch.tv/DindinXD19', 'twitch')]]) {
        const remote = server([file(raw, 'sha-latest')]);
        const result = await ChannelSync.createClient(config, remote.fetch).addMissing(candidates, 'test-token');
        assert.equal(result.raw, raw);
        assert.equal(result.baseRaw, raw);
        assert.equal(result.sha, 'sha-latest');
        assert.deepEqual(result.added, []);
        assert.equal(result.unchanged, true);
        assert.equal(result.commit, undefined);
        assert.deepEqual(result.channels, ChannelSync.parseChannelText(raw));
        assert.deepEqual(remote.requests.map(request => request.method), ['GET']);
    }
});

test('addMissing deduplicates canonical candidate identities while keeping cross-platform and distinct IDs', async () => {
    const remote = server([file(''), stored()]);
    const saved = await ChannelSync.createClient(config, remote.fetch).addMissing([
        channel('先出現', 'https://www.twitch.tv/Some_User', 'twitch'),
        channel('後出現', 'SOME_USER', 'twitch'),
        channel('同名', 'some_user', 'kick'),
        channel('同名', 'other_user', 'kick'),
        channel('HLS', 'https://example.com/Live.m3u8?Key=AbC', 'm3u8'),
        channel('舊核查不應排除新加入', 'no25no2501', 'twitch')
    ], 'test-token');
    assert.deepEqual(saved.added, [
        channel('先出現', 'some_user', 'twitch'),
        channel('同名', 'some_user', 'kick'),
        channel('同名', 'other_user', 'kick'),
        channel('HLS', 'https://example.com/Live.m3u8?Key=AbC', 'm3u8'),
        channel('舊核查不應排除新加入', 'no25no2501', 'twitch')
    ]);
    assert.deepEqual(ChannelSync.parseChannelText(saved.raw), saved.channels);
    assert.equal(remote.requests.filter(request => request.method === 'PUT').length, 1);
});

test('addMissing recomputes missing rows after a SHA conflict, retaining concurrent edits, additions and unrelated deletions', async () => {
    const beforeRaw = '原名,existing,gosh\n稍後刪除,removed,twitch\n';
    const latestRaw = '別人改名,existing,gosh\n別人先加,new_a,kick\n其他人新增,unrelated,twitch\n';
    const remote = server([file(beforeRaw), response(409, {}), file(latestRaw, 'sha-current'), stored('sha-final')]);
    const candidates = [channel('來源名', 'existing'), channel('來源 A', 'new_a', 'kick'), channel('來源 B', 'new_b', 'kick')];
    const saved = await ChannelSync.createClient(config, remote.fetch).addMissing(candidates, 'test-token');
    assert.equal(saved.raw, latestRaw + '來源 B,new_b,kick\n');
    assert.deepEqual(saved.added, [channel('來源 B', 'new_b', 'kick')]);
    assert.equal(saved.channels[0].name, '別人改名');
    assert.equal(saved.channels[1].name, '別人先加');
    assert.ok(!saved.channels.some(item => item.id === 'removed'));
    assert.equal(saved.baseRaw, latestRaw);
    assert.equal(saved.sha, 'sha-final');
    assert.deepEqual(remote.requests.map(request => request.method), ['GET', 'PUT', 'GET', 'PUT']);
    assert.equal(remote.requests[3].payload.sha, 'sha-current');
});

test('addMissing conflict becomes a no-op when another writer has already added every missing candidate', async () => {
    const latestRaw = initial + '別人取名,new,kick\n';
    const remote = server([file(initial), response(422, {}), file(latestRaw, 'sha-current')]);
    const saved = await ChannelSync.createClient(config, remote.fetch).addMissing([channel('來源名', 'NEW', 'kick')], 'test-token');
    assert.equal(saved.raw, latestRaw);
    assert.equal(saved.baseRaw, latestRaw);
    assert.equal(saved.sha, 'sha-current');
    assert.equal(saved.unchanged, true);
    assert.deepEqual(saved.added, []);
    assert.equal(saved.channels.at(-1).name, '別人取名');
    assert.equal(saved.commit, undefined);
    assert.deepEqual(remote.requests.map(request => request.method), ['GET', 'PUT', 'GET']);
});

test('addMissing repeated conflicts stop after two PUTs without changing candidates', async () => {
    const remote = server([file(initial), response(409, {}), file(initial, 'sha-current'), response(422, {})]);
    const candidates = [channel('新台', 'new')];
    const before = structuredClone(candidates);
    await assert.rejects(ChannelSync.createClient(config, remote.fetch).addMissing(candidates, 'test-token'), error => error.code === 'conflict');
    assert.deepEqual(candidates, before);
    assert.equal(remote.requests.filter(request => request.method === 'PUT').length, 2);
});

test('addMissing validates the entire candidate list and token before any request', async () => {
    const remote = server([]);
    const client = ChannelSync.createClient(config, remote.fetch);
    for (const token of ['', ' token', 'token ', 'to\nken', null]) {
        await assert.rejects(client.addMissing([], token), error => error.code === 'auth');
    }
    for (const candidates of [null, {}, [channel('新台', 'new'), channel('壞,資料', 'bad')], [channel('私人來源', 'https://user:password@example.com/live', 'm3u8')]]) {
        await assert.rejects(client.addMissing(candidates, 'test-token'), error => error.code === 'validation');
    }
    assert.equal(remote.requests.length, 0);
});

test('addMissing never PUTs when the latest remote read fails or is invalid', async () => {
    for (const result of [response(401, {}), response(403, {}), response(429, {}), response(500, {}), file('未知,id,unknown\n'), response(200, {})]) {
        const remote = server([result]);
        await assert.rejects(ChannelSync.createClient(config, remote.fetch).addMissing([channel('新台', 'new')], 'test-token'));
        assert.deepEqual(remote.requests.map(request => request.method), ['GET']);
    }
});

test('addMissing does not report success after a failed or unconfirmed PUT', async () => {
    for (const result of [response(401, {}), response(500, {}), response(200, {})]) {
        const remote = server([file(initial), result]);
        const candidates = [channel('新台', 'new')];
        await assert.rejects(ChannelSync.createClient(config, remote.fetch).addMissing(candidates, 'test-token'));
        assert.deepEqual(candidates, [channel('新台', 'new')]);
        assert.deepEqual(remote.requests.map(request => request.method), ['GET', 'PUT']);
    }
});
