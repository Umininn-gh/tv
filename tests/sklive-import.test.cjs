const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ChannelList = require('../channel-list.js');
const ChannelSync = require('../channel-sync.js');
const SKLiveImport = require('../sklive-import.js');

const channel = (name, id, platform = 'gosh') => ({ name, id, platform });
const row = (displayname, details, platform = 'm3u8', url = '') => ({ displayname, details, platform, url });
// Public channel fields from the 2026-10-16 API response; no basic/account settings.
const fixture = { channels: [
    row(':hide:友寶', 'yaubotai', 'vl', 'https://player.kick.com/yaubotai'),
    row(':hide:友寶2', 'yaubotaibackup', 'vl', 'https://player.kick.com/yaubotaibackup'),
    row('友寶G', 'yaubotai01'),
    row('哥普', 'zero_cobra', 'twitch', 'https://player.twitch.tv/?channel=zero_cobra&parent=skgamer.com'),
    row('哥2', 'Godzilla_2027'), row('雀', 'jeukpo', 'vl', 'https://player.kick.com/jeukpo'),
    row('西野', 'nanase-maru525', 'vl', 'https://player.kick.com/nanase-maru525'), row('WC', 'no25no2501'),
    row('ATV', 'collartv', 'vl', 'https://player.kick.com/collartv'), row('汁仔', 'whw9457', 'vl', 'https://player.kick.com/whw9457'),
    row(':hide:白汁', '10268974521971', 'okru', 'https://ok.ru/videoembed/10268974521971?nochat=1&autoplay=1'),
    row('然', 'yinlove', 'vl', 'https://player.kick.com/yinlove'), row('羅拔', 'baggio1967', 'vl', 'https://player.kick.com/baggio1967'),
    row('火', 'falconjurer', 'vl', 'https://player.kick.com/falconjurer'), row('金剛', 'KingKong_TV'),
    row('美1', 'meidingdang'), row('美2', 'meidingdang0'), row('有片', 'fish3345678'), row('KA', 'kinganime')
] };
const response = (payload, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: name => headers[name.toLowerCase()] ?? null }, text: async () => JSON.stringify(payload) });
const currentFixture = { id: 'ctvhiki49713', sources: fixture.channels.filter(item => !/:hide:/i.test(item.displayname)).map(item => ({
    name: item.displayname, details: item.details, platform: item.platform, embed: item.url,
    play: { url: item.platform === 'm3u8' ? '/api/userlive/gosh?cid=' + item.details : item.url }
})) };
const requestedApi = url => new URL(url).searchParams.get('quest');
const sourceResponse = url => response(requestedApi(url) === SKLiveImport.currentApiUrl ? currentFixture : fixture);

test('current 19-row fixture includes all three hidden channels with stable canonical identities', () => {
    const before = structuredClone(fixture);
    const report = SKLiveImport.parse(fixture);
    assert.equal(report.received, 19); assert.equal(report.hidden, 3); assert.equal(report.channels.length, 19);
    assert.deepEqual(report.skipped, []); assert.deepEqual(report.duplicates, []);
    assert.equal(report.sourceUrl, 'https://skknower.com/user/ctvhiki49713');
    assert.ok(Number.isFinite(Date.parse(report.checkedAt)));
    assert.deepEqual(report.channels.slice(0, 5), [channel('友寶', 'yaubotai', 'kick'), channel('友寶2', 'yaubotaibackup', 'kick'), channel('友寶G', 'yaubotai01'), channel('哥普', 'zero_cobra', 'twitch'), channel('哥2', 'godzilla_2027')]);
    assert.deepEqual(report.channels[10], channel('白汁', '10268974521971', 'ok'));
    assert.deepEqual(fixture, before);
    assert.equal(new Set(report.channels.map(ChannelList.channelKey)).size, 19);
});

test('hide markers are stripped case-insensitively anywhere; duplicate first source entry wins across canonical URL forms', () => {
    const report = SKLiveImport.parse({ channels: [
        row('前:HiDe:後:hide:', 'https://www.twitch.tv/SomeUser', 'twitch'), row('另一名', 'someuser', 'twitch'),
        row('不同平台', 'someuser', 'kick'), row('第一影片', 'https://youtu.be/UL8iGQiTrlA', 'youtube'), row('另一影片名', 'https://www.youtube.com/watch?v=UL8iGQiTrlA', 'youtube')
    ] });
    assert.equal(report.hidden, 1); assert.equal(report.received, 5); assert.equal(report.duplicates.length, 2);
    assert.deepEqual(report.channels, [channel('前後', 'someuser', 'twitch'), channel('不同平台', 'someuser', 'kick'), channel('第一影片', 'UL8iGQiTrlA', 'youtube')]);
    assert.equal(report.duplicates[0].duplicateOf, 1); assert.equal(report.duplicates[1].duplicateOf, 4);
});

test('Gosh slug wins over an expired signed URL and genuine HLS URL case/query remain unchanged', () => {
    const publicHls = 'https://cdn.example.com/Live/Program.M3U8?Quality=Original&token=public-playback';
    const report = SKLiveImport.parse({ channels: [
        { ...row('Gosh', 'SomeUser'), url: 'https://pull.gosh6.app/temp/live.m3u8?expires=1&signature=old-private-fixture', authorization: 'do-not-copy' },
        row('Direct', publicHls), row('Vaughn alias', 'streamer', 'vl', 'https://vaughn.live/streamer')
    ], basic: [{ password: 'do-not-copy-basic' }] });
    assert.deepEqual(report.channels, [channel('Gosh', 'someuser'), channel('Direct', publicHls, 'm3u8'), channel('Vaughn alias', 'streamer', 'vaughn')]);
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes('old-private-fixture')); assert.ok(!serialized.includes('do-not-copy'));
});

test('known platforms map exact official URLs and reject conflicting case-sensitive video identities', () => {
    const report = SKLiveImport.parse({ channels: [
        row('Twitch embed', '', 'twitch', 'https://player.twitch.tv/?channel=Name_1&parent=skknower.com'),
        row('AngelThump', 'https://angelthump.com/Underwear', 'at'),
        row('Gosh', 'https://gosh.com/Meidingdang', 'gosh'),
        row('OK', 'https://ok.ru/live/10268974521971', 'okru'),
        row('GoodGame', 'https://goodgame.ru/player?219534', 'goodgame'),
        row('Conflict', 'UL8iGQiTrlA', 'youtube', 'https://youtu.be/ul8igqitrla')
    ] });
    assert.deepEqual(report.channels, [channel('Twitch embed', 'name_1', 'twitch'), channel('AngelThump', 'underwear', 'at'), channel('Gosh', 'meidingdang'), channel('OK', '10268974521971', 'ok'), channel('GoodGame', '219534', 'goodgame')]);
    assert.equal(report.skipped[0].reason, 'conflicting_identity');
});

test('unknown or unsafe input is reported without copying private fields or guessing identities', () => {
    const report = SKLiveImport.parse({ channels: [
        { ...row('Unknown', 'private-fixture', 'unknown'), secret: 'never-copy-secret' },
        row('Spoof Twitch', 'https://twitch.tv.evil.example/SomeUser', 'twitch'),
        row('Private HLS', 'https://private-user:private-pass@cdn.example.com/live.m3u8'),
        row('Local HLS', 'http://127.0.0.1/live.m3u8'), row('Private network', 'http://192.168.1.1/live.m3u8'),
        row('Ambiguous VL', 'someuser', 'vl'), row('Comma,name', 'safeuser'), null,
        row('Valid', 'safeuser')
    ] });
    assert.deepEqual(report.channels, [channel('Valid', 'safeuser')]); assert.equal(report.skipped.length, 8);
    const serialized = JSON.stringify(report);
    for (const secret of ['private-fixture', 'never-copy-secret', 'private-user', 'private-pass', '127.0.0.1', '192.168.1.1']) assert.ok(!serialized.includes(secret));
    assert.equal(report.skipped[0].reason, 'unsupported_platform');
});

test('malformed or empty payloads fail instead of reporting that everything is synchronized', () => {
    for (const payload of [null, [], {}, { channels: null }, { channels: [] }, { channels: {} }]) {
        assert.throws(() => SKLiveImport.parse(payload), error => error.code === 'invalid_data');
    }
    const unmappable = SKLiveImport.parse({ channels: [row('Unknown', 'details', 'new-platform')] });
    assert.equal(unmappable.received, 1); assert.equal(unmappable.channels.length, 0); assert.equal(unmappable.skipped.length, 1);
});

test('comparison is pure and add-only: offline, historically unavailable and absent upstream entries survive', () => {
    const existing = [channel('My own name', 'meidingdang'), { ...channel('Still saved', 'wing36747', 'kick'), live: false, customMetadata: { keep: true } }, { ...channel('GG', '219534', 'goodgame'), ggUsername: 'publicuser' }, channel('An absent upstream entry', 'manual-user', 'twitch')];
    const incoming = [channel('Upstream different name', 'MEIDINGDANG'), channel('New source channel', 'new-user', 'kick')];
    const before = structuredClone(existing), beforeIncoming = structuredClone(incoming);
    const compared = SKLiveImport.compare(existing, incoming);
    assert.deepEqual(compared.channels.slice(0, existing.length), before);
    assert.deepEqual(compared.added, [channel('New source channel', 'new-user', 'kick')]);
    assert.equal(compared.alreadyPresent, 1); assert.equal(compared.existingCount, 4);
    assert.deepEqual(existing, before); assert.deepEqual(incoming, beforeIncoming);
    assert.deepEqual(SKLiveImport.compare(existing, []).channels, existing);
    assert.deepEqual(SKLiveImport.compare(existing, { channels: incoming }).channels, compared.channels);
});

test('current API sources map names, embeds and Gosh identities without storing temporary playback links', () => {
    const before = structuredClone(currentFixture);
    const report = SKLiveImport.parse(currentFixture);
    assert.equal(report.received, 16); assert.equal(report.hidden, 0); assert.equal(report.channels.length, 16);
    assert.deepEqual(report.channels[0], channel('友寶G', 'yaubotai01'));
    assert.deepEqual(report.channels[1], channel('哥普', 'zero_cobra', 'twitch'));
    assert.deepEqual(report.channels[3], channel('雀', 'jeukpo', 'kick'));
    assert.deepEqual(currentFixture, before);
    const signed = SKLiveImport.parse({ id: 'ctvhiki49713', sources: [
        { name: 'Gosh', platform: 'm3u8', details: 'SomeUser', play: { url: 'https://pull.gosh6.app/live.m3u8?token=do-not-store' } },
        { name: 'No account', platform: 'm3u8', details: '', play: { url: 'https://pull.gosh6.app/live.m3u8?token=do-not-store' } }
    ], basic: { password: 'private-basic' } });
    assert.deepEqual(signed.channels, [channel('Gosh', 'someuser')]);
    assert.equal(signed.skipped.length, 1);
    assert.ok(!JSON.stringify(signed).includes('do-not-store')); assert.ok(!JSON.stringify(signed).includes('private-basic'));
    for (const value of [null, 'another-user', 42]) assert.throws(() => SKLiveImport.parse({ id: value, sources: currentFixture.sources }), error => error.code === 'invalid_data');
});

test('load combines current visible sources with explicitly hidden legacy sources', async () => {
    const report = await SKLiveImport.load(sourceResponse);
    assert.equal(report.received, 19); assert.equal(report.hidden, 3); assert.equal(report.channels.length, 19);
    assert.deepEqual(report.channels.slice(0, 16), SKLiveImport.parse(currentFixture).channels);
    assert.deepEqual(report.channels.slice(-3), [channel('友寶', 'yaubotai', 'kick'), channel('友寶2', 'yaubotaibackup', 'kick'), channel('白汁', '10268974521971', 'ok')]);
    assert.deepEqual(report.sourceWarnings, []);
    assert.deepEqual(report.sourceApis, [SKLiveImport.currentApiUrl, SKLiveImport.legacyApiUrl]);
});

test('new current-only entries are imported while legacy-only visible entries are not resurrected', async () => {
    const current = { id: 'ctvhiki49713', sources: [
        { name: '目前名稱', details: 'SomeUser', platform: 'twitch', play: { url: 'https://player.twitch.tv/?channel=SomeUser' } },
        { name: '新台', details: 'new-channel', platform: 'vl', embed: 'https://player.kick.com/new-channel' }
    ] };
    const legacy = { channels: [row('舊名稱', 'someuser', 'twitch'), row('來源已移走', 'stale-visible'), row(':hide:隱藏台', 'hidden-account')] };
    const report = await SKLiveImport.load(url => response(requestedApi(url) === SKLiveImport.currentApiUrl ? current : legacy));
    assert.deepEqual(report.channels, [channel('目前名稱', 'someuser', 'twitch'), channel('新台', 'new-channel', 'kick'), channel('隱藏台', 'hidden-account')]);
    const existing = [channel('我的自訂名稱', 'someuser', 'twitch'), channel('本地舊台仍保留', 'stale-visible')];
    const before = structuredClone(existing);
    const diff = SKLiveImport.compare(existing, report);
    assert.deepEqual(diff.added, report.channels.slice(1)); assert.deepEqual(existing, before);
    assert.deepEqual(diff.channels.slice(0, 2), before);
});

test('hidden overlap is deduplicated against current identity and diagnostic indexes remain correct', async () => {
    const current = { id: 'ctvhiki49713', sources: [{ name: '現在名', details: 'sameuser', platform: 'twitch' }] };
    const legacy = { channels: [row(':hide:重覆', 'sameuser', 'twitch'), row(':hide:未知', 'unknown', 'new-platform'), row(':hide:新隱藏', 'hidden'), row(':hide:重覆隱藏', 'hidden')] };
    const report = await SKLiveImport.load(url => response(requestedApi(url) === SKLiveImport.currentApiUrl ? current : legacy));
    assert.equal(report.received, 5); assert.equal(report.hidden, 4);
    assert.deepEqual(report.channels, [channel('現在名', 'sameuser', 'twitch'), channel('新隱藏', 'hidden')]);
    assert.deepEqual(report.duplicates.map(item => [item.index, item.duplicateOf]), [[2, 1], [5, 4]]);
    assert.equal(report.skipped[0].index, 3);
});

test('current failure retains legacy coverage with an explicit partial-source warning', async () => {
    const requests = [];
    const report = await SKLiveImport.load(url => { requests.push(url); return requestedApi(url) === SKLiveImport.currentApiUrl ? response({}, 503) : response(fixture); });
    assert.equal(report.channels.length, 19); assert.equal(report.sourceWarnings.length, 1);
    assert.match(report.sourceWarnings[0], /目前版.*失敗.*舊版/);
    assert.deepEqual(report.sourceApis, [SKLiveImport.legacyApiUrl]);
    assert.equal(requests.filter(url => requestedApi(url) === SKLiveImport.currentApiUrl).length, 2);
});

test('legacy failure retains current coverage with an explicit hidden-source warning', async () => {
    const report = await SKLiveImport.load(url => requestedApi(url) === SKLiveImport.currentApiUrl ? response(currentFixture) : response({}, 503));
    assert.equal(report.channels.length, 16); assert.equal(report.hidden, 0); assert.equal(report.sourceWarnings.length, 1);
    assert.match(report.sourceWarnings[0], /隱藏入口.*失敗.*可見入口/);
    assert.deepEqual(report.sourceApis, [SKLiveImport.currentApiUrl]);
});

test('empty, malformed or wrong-user current data cannot masquerade as a complete current crosscheck', async () => {
    for (const invalid of [{ id: 'ctvhiki49713', sources: [] }, { id: 'other-user', sources: currentFixture.sources }, fixture]) {
        const report = await SKLiveImport.load(url => response(requestedApi(url) === SKLiveImport.currentApiUrl ? invalid : fixture));
        assert.equal(report.channels.length, 19); assert.equal(report.sourceWarnings.length, 1);
        assert.deepEqual(report.sourceApis, [SKLiveImport.legacyApiUrl]);
    }
});

test('unrecognized legacy metadata does not silently claim a complete hidden-source check', async () => {
    const report = await SKLiveImport.load(url => response(requestedApi(url) === SKLiveImport.currentApiUrl ? currentFixture : { channels: [null, row('未知舊格式', 'private-old', 'future-platform')] }));
    assert.equal(report.channels.length, 16);
    assert.equal(report.sourceWarnings.length, 1);
    assert.match(report.sourceWarnings[0], /未能識別.*隱藏入口/);
    assert.ok(!JSON.stringify(report).includes('private-old'));
});

test('load uses only two fixed public APIs through fixed proxies without caller tokens or cookies', async () => {
    const requests = [];
    const report = await SKLiveImport.load(async (url, options) => { requests.push({ url, options }); return sourceResponse(url); }, { token: 'never-send-this-token', headers: { Authorization: 'never-send-auth' }, sourceUrl: 'https://elsewhere.example' });
    assert.equal(report.channels.length, 19); assert.equal(requests.length, 2);
    assert.deepEqual(new Set(requests.map(item => requestedApi(item.url))), new Set([SKLiveImport.currentApiUrl, SKLiveImport.legacyApiUrl]));
    for (const request of requests) {
        assert.equal(new URL(request.url).origin, 'https://young-cloud-e59f.chicktv001.workers.dev');
        assert.deepEqual(request.options.headers, { Accept: 'application/json' });
        assert.equal(request.options.credentials, 'omit'); assert.equal(request.options.cache, 'no-store');
        assert.equal(request.options.redirect, 'error'); assert.equal(request.options.referrerPolicy, 'no-referrer');
    }
    assert.ok(!JSON.stringify(requests).includes('never-send'));
});

test('each source falls back once to the second fixed proxy after a failed primary', async () => {
    const requests = [];
    const report = await SKLiveImport.load(async (url, options) => { requests.push({ url, signal: options.signal }); return new URL(url).hostname.startsWith('young-') ? response({}, 503) : sourceResponse(url); });
    assert.equal(report.channels.length, 19); assert.equal(requests.length, 4);
    for (const request of requests) assert.equal(request.signal.aborted, new URL(request.url).hostname.startsWith('young-'));
    assert.equal(requests.filter(item => new URL(item.url).hostname.startsWith('wispy-')).length, 2);
});

test('streamed UTF-8 response decodes Chinese names split across byte chunks', async () => {
    let released = 0, cancelled = 0;
    const report = await SKLiveImport.load(async url => {
        const bytes = new TextEncoder().encode(JSON.stringify(requestedApi(url) === SKLiveImport.currentApiUrl ? currentFixture : fixture));
        let offset = 0;
        return { ok: true, headers: { get: () => null }, body: { getReader: () => ({
            async read() { if (offset >= bytes.length) return { done: true }; const value = bytes.slice(offset, offset + 5); offset += value.length; return { done: false, value }; },
            async cancel() { cancelled++; }, releaseLock() { released++; }
        }) } };
    });
    assert.equal(report.channels.length, 19);
    assert.deepEqual(new Set(report.channels.map(ChannelList.channelKey)), new Set(SKLiveImport.parse(fixture).channels.map(ChannelList.channelKey)));
    assert.equal(released, 2); assert.equal(cancelled, 0);
});

test('the deadline covers a hung response body and allows fallback without mutating existing data', async () => {
    const requests = []; const existing = [channel('Original', 'original')];
    const report = await SKLiveImport.load(async (url, options) => {
        requests.push({ url, signal: options.signal });
        return requestedApi(url) === SKLiveImport.currentApiUrl && new URL(url).hostname.startsWith('young-')
            ? { ok: true, headers: { get: () => null }, text: () => new Promise(() => {}) }
            : requestedApi(url) === SKLiveImport.currentApiUrl ? response({ id: 'ctvhiki49713', sources: [{ name: 'New', details: 'newuser', platform: 'm3u8' }] }) : response({ channels: [row('Old visible', 'not-resurrected')] });
    }, { timeoutMs: 8 });
    assert.equal(requests.length, 3); assert.equal(requests[0].signal.aborted, true);
    assert.deepEqual(SKLiveImport.compare(existing, report).channels, [...existing, channel('New', 'newuser')]);
    assert.deepEqual(existing, [channel('Original', 'original')]);
});

test('both sources time out at both fixed proxies and never produce an empty successful report', async () => {
    const signals = [];
    await assert.rejects(SKLiveImport.load(async (_url, options) => { signals.push(options.signal); return new Promise(() => {}); }, { timeoutMs: 5 }), error => error.code === 'timeout');
    assert.equal(signals.length, 4); assert.ok(signals.every(signal => signal.aborted));
});

test('streamed body size cap cancels oversized response and does not accept malformed fallback data', async () => {
    let calls = 0, cancelled = 0;
    const signals = [];
    await assert.rejects(SKLiveImport.load(async (url, options) => {
        calls++; signals.push(options.signal);
        if (new URL(url).hostname.startsWith('wispy-')) return response(requestedApi(url) === SKLiveImport.currentApiUrl ? { id: 'ctvhiki49713', sources: [] } : { channels: [] });
        return { ok: true, headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(80) }), cancel: async () => { cancelled++; }, releaseLock() {} }) } };
    }, { maxBytes: 64 }), error => error.code === 'invalid_data');
    assert.equal(calls, 4); assert.equal(cancelled, 2); assert.ok(signals.every(signal => signal.aborted));
});

test('declared oversized body is rejected before reading; configured max cannot exceed one MiB', async () => {
    let reads = 0, calls = 0;
    await assert.rejects(SKLiveImport.load(async () => {
        calls++;
        return { ok: true, headers: { get: name => name === 'content-length' ? String(1024 * 1024 + 1) : null }, text: async () => { reads++; return JSON.stringify(fixture); } };
    }, { maxBytes: 50 * 1024 * 1024 }), error => error.code === 'too_large');
    assert.equal(calls, 4); assert.equal(reads, 0);
});

test('invalid JSON and unsafe existing snapshots fail without any write capability', async () => {
    let calls = 0;
    await assert.rejects(SKLiveImport.load(async () => { calls++; return { ok: true, headers: { get: () => null }, text: async () => '<html>service failure</html>' }; }), error => error.code === 'invalid_data');
    assert.equal(calls, 4);
    assert.throws(() => SKLiveImport.compare([channel('Bad,name', 'unsafe')], []), error => error.code === 'validation');
    assert.throws(() => SKLiveImport.compare([], [channel('Bad,name', 'unsafe')]), error => error.code === 'validation');
    assert.equal(SKLiveImport.save, undefined); assert.equal(SKLiveImport.delete, undefined);
});

test('browser global exposes the same public parser without CommonJS or embedded authentication', () => {
    const context = vm.createContext({ ChannelList, ChannelSync, URL, Date, console });
    vm.runInContext(fs.readFileSync(require.resolve('../sklive-import.js'), 'utf8'), context);
    assert.equal(typeof context.SKLiveImport.load, 'function');
    assert.equal(context.SKLiveImport.parse(fixture).channels.length, 19);
    assert.equal(context.SKLiveImport.sourceUrl, SKLiveImport.sourceUrl);
    assert.equal(context.SKLiveImport.parse(currentFixture).channels.length, 16);
    assert.equal(context.SKLiveImport.currentApiUrl, 'https://skknower.com/api/userlive/ctvhiki49713');
});
