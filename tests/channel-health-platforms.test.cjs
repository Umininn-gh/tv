const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const platforms = require('../channel-health-platforms.js');

const TWITCH = 'https://api.twitch.tv/helix/';
const KICK = 'https://kick.com/api/';
const ANGEL = 'https://api.angelthump.com/v2/streams/';
const VAUGHN = 'https://api.vaughnsoft.net/v1/stream/vl/';
const GOSH_WORKER = 'https://gosh.chicktv02.workers.dev/?channelId=';
const YT_VIDEO = 'UL8iGQiTrlA';
const YT_CONTROL = 'jNQXAC9IVRw';
const OK_CONTROL = '10268974521971';
const YT_CHANNEL = 'UCabcdefghijklmnopqrstuv';

function response(body, status = 200) {
    return { status, ok: status >= 200 && status < 300, text: typeof body === 'string' ? body : JSON.stringify(body) };
}
function fixture(routes, extra = {}) {
    const calls = [], controls = new Map();
    const ctx = Object.assign({
        request: async (url, options) => {
            calls.push({ url, options });
            const value = typeof routes === 'function' ? routes(url, options) : routes[url];
            if (value instanceof Error) throw value;
            return await (typeof value === 'function' ? value(url, options) : value || response('unconfigured fixture', 503));
        },
        twitch: async () => ({ token: 'fixture-token', clientId: 'fixture-client' }),
        previous: () => null,
        control: (platform, fn) => {
            if (!controls.has(platform)) controls.set(platform, Promise.resolve().then(fn));
            return controls.get(platform);
        }
    }, extra);
    return { ctx, calls, controls, check: channel => platforms.check(channel, ctx) };
}
function twitchUser(login = 'rachelw', id = '139172683') { return { id, login, display_name: login }; }
function kickUser(slug = 'jeukpo', id = 36857078, extra = {}) { return Object.assign({ id, slug, is_banned: false, livestream: null }, extra); }
function angelUser(username = 'ppkkkp', type = 'offline') { return { type, user: { id: 'f16e159c-7c0d-400c-a5da-ad627e077d6f', username, banned: false } }; }
function vaughnUser(extra = {}) { return Object.assign({ live: false, followers: '261', pageviews: '53054', lastlive: 1790000000, lastoffair: 1790000100 }, extra); }
function emptyVaughn() { return { live: false, followers: null, pageviews: null, lastlive: null, lastoffair: null, profile_url: 'https://vaughn.live/no_such_fixture' }; }
function profile(slug, extra = {}) {
    return '<script type="application/ld+json">' + JSON.stringify({ '@graph': [
        { '@type': 'ProfilePage', url: 'https://gosh.com/' + slug },
        Object.assign({ '@type': 'Person', url: 'https://gosh.com/' + slug, name: slug }, extra)
    ] }) + '</script>';
}
function okEmbed(id, status = 'OFFLINE') {
    const nested = { provider: 'LIVE_TV_ODKL', movie: { id, status, isLive: true }, hlsMasterPlaylistUrl: 'https://private.invalid/signed/secret?token=never-record' };
    const options = { flashvars: { metadata: JSON.stringify(nested) } };
    return '<div data-options="' + JSON.stringify(options).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"></div>';
}
function oembedUrl(id) { return 'https://www.youtube.com/oembed?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id) + '&format=json'; }
function oembed(id) { return { type: 'video', provider_name: 'YouTube', title: 'Fixture video', html: '<iframe src="https://www.youtube.com/embed/' + id + '"></iframe>' }; }
function watch(id, live) {
    return '<script>var ytInitialPlayerResponse=' + JSON.stringify({ videoDetails: { videoId: id, title: 'Fixture' }, microformat: { playerMicroformatRenderer: { liveBroadcastDetails: live } } }) + ';</script>';
}
function controlEvidence(result, url, expectedStatus = 200) {
    const item = result.evidence.find(item => item.url === url && item.label === '官方正常對照');
    assert.ok(item, 'negative finding includes the known-good control URL');
    assert.equal(item.httpStatus, expectedStatus);
    assert.ok(item.summary);
    assert.ok(Number.isFinite(Date.parse(item.checkedAt)));
}

test('loads as a browser global without DOM or Node dependencies', () => {
    const sandbox = { URL };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../channel-health-platforms.js'), 'utf8'), sandbox);
    assert.equal(typeof sandbox.ChannelHealthPlatforms.check, 'function');
    assert.equal(sandbox.ChannelHealthPlatforms.run, sandbox.ChannelHealthPlatforms.check);
});

test('Twitch existing offline channel uses official authenticated direct requests', async () => {
    const app = fixture({
        [TWITCH + 'users?login=rachelw']: response({ data: [twitchUser()] }),
        [TWITCH + 'streams?user_id=139172683']: response({ data: [] })
    });
    const result = await app.check({ platform: 'twitch', id: 'RachelW' });
    assert.equal(result.status, 'offline');
    assert.equal(result.accountId, '139172683');
    assert.equal(app.calls.length, 2);
    for (const call of app.calls) {
        assert.equal(call.options.direct, true);
        assert.equal(call.options.headers.Authorization, 'Bearer fixture-token');
        assert.equal(call.options.headers['Client-Id'], 'fixture-client');
    }
    assert.doesNotMatch(JSON.stringify(result), /fixture-token|fixture-client/);
});

test('Twitch stream errors preserve the confirmed account identity', async () => {
    const app = fixture({
        [TWITCH + 'users?login=rachelw']: response({ data: [twitchUser()] }),
        [TWITCH + 'streams?user_id=139172683']: response({ error: 'Unauthorized' }, 401)
    });
    const result = await app.check({ platform: 'twitch', id: 'rachelw' });
    assert.equal(result.status, 'exists');
    assert.equal(result.accountId, '139172683');
});

test('Twitch stable account ID detects a renamed account instead of deleting it', async () => {
    const app = fixture({
        [TWITCH + 'users?login=oldname']: response({ data: [] }),
        [TWITCH + 'users?id=123']: response({ data: [twitchUser('newname', '123')] })
    }, { previous: () => ({ accountId: '123' }) });
    const result = await app.check({ platform: 'twitch', id: 'oldname' });
    assert.equal(result.status, 'repair');
    assert.equal(result.accountId, '123');
    assert.deepEqual(result.suggestion, { id: 'newname', platform: 'twitch' });
});

test('Twitch reused login does not replace the previous stable account identity', async () => {
    const app = fixture({
        [TWITCH + 'users?login=oldname']: response({ data: [twitchUser('oldname', '999')] }),
        [TWITCH + 'users?id=123']: response({ data: [twitchUser('newname', '123')] })
    }, { previous: () => ({ accountId: '123' }) });
    const result = await app.check({ platform: 'twitch', id: 'oldname' });
    assert.equal(result.status, 'repair');
    assert.equal(result.accountId, '123');
    assert.equal(result.suggestion.id, 'newname');
});

test('Twitch failed stable ID query is unknown, never a rename or unavailable finding', async () => {
    const app = fixture({
        [TWITCH + 'users?login=oldname']: response({ data: [] }),
        [TWITCH + 'users?id=123']: response('rate limited', 429)
    }, { previous: () => ({ accountId: '123' }) });
    assert.equal((await app.check({ platform: 'twitch', id: 'oldname' })).status, 'unknown');
    assert.equal(app.controls.size, 0);
});

test('Twitch unavailable needs a working control and exposes cached control evidence on every entry', async () => {
    const controlUrl = TWITCH + 'users?login=twitch';
    const app = fixture(url => response({ data: url === controlUrl ? [twitchUser('twitch', '12826')] : [] }));
    for (const id of ['missingone', 'missingtwo']) {
        const result = await app.check({ platform: 'twitch', id });
        assert.equal(result.status, 'suspect');
        controlEvidence(result, controlUrl);
    }
    assert.equal(app.calls.filter(call => call.url === controlUrl).length, 1);
});

test('Twitch auth errors and malformed empty controls do not imply account removal', async () => {
    const blocked = fixture(() => response({ error: 'Unauthorized' }, 401));
    assert.equal((await blocked.check({ platform: 'twitch', id: 'rachelw' })).status, 'unknown');
    const empty = fixture(() => response({ data: [] }));
    assert.equal((await empty.check({ platform: 'twitch', id: 'missing' })).status, 'unknown');
});

test('Twitch malformed nonempty or wrong-account responses are unknown even with a healthy control', async () => {
    for (const data of [[{ login: 'target' }], [twitchUser('unrelated', '999')], [twitchUser('target', '123'), { login: 'malformed' }]]) {
        const app = fixture({ [TWITCH + 'users?login=target']: response({ data }), [TWITCH + 'users?login=twitch']: response({ data: [twitchUser('twitch', '12826')] }) });
        const result = await app.check({ platform: 'twitch', id: 'target' });
        assert.equal(result.status, 'unknown');
        assert.equal(app.controls.size, 0);
    }
});

test('Twitch wrong-account stable ID responses are unknown instead of a disappearance', async () => {
    const app = fixture({ [TWITCH + 'users?login=target']: response({ data: [] }), [TWITCH + 'users?id=123']: response({ data: [twitchUser('unrelated', '999')] }), [TWITCH + 'users?login=twitch']: response({ data: [twitchUser('twitch', '12826')] }) }, { previous: () => ({ accountId: '123' }) });
    assert.equal((await app.check({ platform: 'twitch', id: 'target' })).status, 'unknown');
    assert.equal(app.controls.size, 0);
});

test('Twitch full official URL is repairable without changing the account identity', async () => {
    const app = fixture({ [TWITCH + 'users?login=rachelw']: response({ data: [twitchUser()] }) });
    const result = await app.check({ platform: 'twitch', id: 'https://www.twitch.tv/RachelW' });
    assert.equal(result.status, 'repair');
    assert.equal(result.suggestion.id, 'rachelw');
});

test('Kick live and offline identities are valid and the legacy vl alias is supported', async () => {
    for (const live of [false, true]) {
        const app = fixture({ [KICK + 'v2/channels/jeukpo']: response(kickUser('jeukpo', 36857078, { livestream: live ? { is_live: true } : null })) });
        const result = await app.check({ platform: 'vl', id: 'JEUKPO' });
        assert.equal(result.status, live ? 'live' : 'offline');
        assert.equal(result.accountId, '36857078');
        assert.equal(app.calls[0].options.headers, undefined);
    }
});

test('Kick needs explicit official absence from both APIs plus the known-good control', async () => {
    const controlUrl = KICK + 'v2/channels/jeukpo';
    const app = fixture({
        [KICK + 'v2/channels/missing']: response({ error: 'Not Found', message: 'Channel not found.', status: 404 }, 404),
        [KICK + 'v1/channels/missing']: response({ message: 'No query results for model [App\\Models\\Channel].' }, 404),
        [controlUrl]: response(kickUser())
    });
    const result = await app.check({ platform: 'kick', id: 'missing' });
    assert.equal(result.status, 'suspect');
    controlEvidence(result, controlUrl);
});

test('Kick generic routes, protection pages, failed corroboration, and wrong controls stay unknown', async () => {
    const cases = [
        { [KICK + 'v2/channels/missing']: response('<html>Not found</html>', 404) },
        { [KICK + 'v2/channels/missing']: response({ message: 'The route api/v2/channels/missing could not be found.' }, 404) },
        { [KICK + 'v2/channels/missing']: response('Forbidden', 403) },
        { [KICK + 'v2/channels/missing']: response({ message: 'Channel not found.' }, 404), [KICK + 'v1/channels/missing']: response('', 500) },
        { [KICK + 'v2/channels/missing']: response({ message: 'Channel not found.' }, 404), [KICK + 'v1/channels/missing']: response({ message: 'Channel not found.' }, 404), [KICK + 'v2/channels/jeukpo']: response(kickUser('wrongaccount')) }
    ];
    for (const routes of cases) assert.equal((await fixture(routes).check({ platform: 'kick', id: 'missing' })).status, 'unknown');
});

test('Kick secondary positive identity wins over a stale v2 missing response', async () => {
    const app = fixture({
        [KICK + 'v2/channels/jeukpo']: response({ message: 'Channel not found.' }, 404),
        [KICK + 'v1/channels/jeukpo']: response(kickUser())
    });
    assert.equal((await app.check({ platform: 'kick', id: 'jeukpo' })).status, 'offline');
});

test('Gosh validates ProfilePage and Person case-insensitively before using live metadata', async () => {
    const app = fixture({
        'https://gosh.com/godzilla_2027': response(profile('Godzilla_2027')),
        [GOSH_WORKER + 'godzilla_2027']: response({ isLive: true, channelId: 'Godzilla_2027', m3u8Url: 'https://secret.invalid/signed?token=never-record' })
    });
    const result = await app.check({ platform: 'gosh', id: 'Godzilla_2027' });
    assert.equal(result.status, 'live');
    assert.equal(result.accountId, undefined, 'a slug URL is not a stable account ID');
    assert.doesNotMatch(JSON.stringify(result), /secret.invalid|never-record|m3u8Url/);
    assert.equal(app.calls[1].options.direct, true);
});

test('Gosh false metadata alone cannot prove identity or absence', async () => {
    const app = fixture({ 'https://gosh.com/missing': response('<html>App shell</html>'), [GOSH_WORKER + 'missing']: response({ isLive: false }) });
    assert.equal((await app.check({ platform: 'gosh', id: 'missing' })).status, 'unknown');
    assert.equal(app.calls.length, 1, 'no helper request when official identity is missing');
});

test('Gosh valid identity plus metadata errors or mismatched IDs preserves exists', async () => {
    for (const payload of [{ isLive: false, error: 'upstream unavailable' }, { isLive: false, channelId: 'other' }, {}]) {
        const app = fixture({ 'https://gosh.com/kingkong_tv': response(profile('KingKong_TV')), [GOSH_WORKER + 'kingkong_tv']: response(payload) });
        assert.equal((await app.check({ platform: 'gosh', id: 'KingKong_TV' })).status, 'exists');
    }
});

test('Gosh valid offline profile is not a failed channel', async () => {
    const app = fixture({ 'https://gosh.com/kingkong_tv': response(profile('KingKong_TV', { identifier: { value: 'stable-profile-123' } })), [GOSH_WORKER + 'kingkong_tv']: response({ isLive: false, channelId: 'kingkong_tv' }) });
    const result = await app.check({ platform: 'gosh', id: 'KingKong_TV' });
    assert.equal(result.status, 'offline');
    assert.equal(result.accountId, 'stable-profile-123');
});

test('AngelThump user identity validates an offline account', async () => {
    const app = fixture({ [ANGEL + 'ppkkkp']: response(angelUser()) });
    const result = await app.check({ platform: 'angelthump', id: 'ppkkkp' });
    assert.equal(result.status, 'offline');
    assert.equal(result.accountId, angelUser().user.id);
});

test('AngelThump 500 and stream-not-found do not imply a deleted user', async () => {
    for (const result of [response({ error: 'Internal Server Error', msg: 'Stream not found' }, 500), response({ message: 'Stream not found' }, 404), response({})]) {
        const app = fixture({ [ANGEL + 'oldppkkkpp']: result });
        assert.equal((await app.check({ platform: 'at', id: 'oldppkkkpp' })).status, 'unknown');
        assert.equal(app.controls.size, 0);
    }
});

test('AngelThump explicit missing user needs and records a valid control', async () => {
    const app = fixture({ [ANGEL + 'missing']: response({ message: 'User not found' }, 404), [ANGEL + 'ppkkkp']: response(angelUser('ppkkkp', 'live')) });
    const result = await app.check({ platform: 'at', id: 'missing' });
    assert.equal(result.status, 'suspect');
    controlEvidence(result, ANGEL + 'ppkkkp');
});

test('AngelThump a banned control cannot corroborate a missing user', async () => {
    const known = angelUser('ppkkkp', 'offline');
    known.user.banned = true;
    const app = fixture({ [ANGEL + 'missing']: response({ message: 'User not found' }, 404), [ANGEL + 'ppkkkp']: response(known) });
    assert.equal((await app.check({ platform: 'at', id: 'missing' })).status, 'unknown');
});

test('Vaughn populated or zero-valued stats validate offline accounts', async () => {
    for (const payload of [vaughnUser(), { live: false, followers: '0', pageviews: 0 }]) {
        const app = fixture({ [VAUGHN + 'kingkong_tv']: response(payload) });
        assert.equal((await app.check({ platform: 'vaughn', id: 'kingkong_tv' })).status, 'offline');
    }
});

test('Vaughn generated URLs alone are not identity; all-null payload needs a healthy control', async () => {
    const routes = { [VAUGHN + 'missing']: response(emptyVaughn()), [VAUGHN + 'kingkong_tv']: response(vaughnUser()) };
    const result = await fixture(routes).check({ platform: 'vaughn', id: 'missing' });
    assert.equal(result.status, 'suspect');
    controlEvidence(result, VAUGHN + 'kingkong_tv');
    routes[VAUGHN + 'kingkong_tv'] = response(emptyVaughn());
    assert.equal((await fixture(routes).check({ platform: 'vaughn', id: 'missing' })).status, 'unknown');
});

test('OK parses nested metadata; isLive means broadcast type, not currently online', async () => {
    const app = fixture({ ['https://ok.ru/videoembed/' + OK_CONTROL]: response(okEmbed(OK_CONTROL)) });
    const result = await app.check({ platform: 'okru', id: OK_CONTROL });
    assert.equal(result.status, 'offline');
    assert.equal(result.accountId, OK_CONTROL);
    assert.doesNotMatch(JSON.stringify(result), /private.invalid|never-record|hlsMaster/);
});

test('OK shell scripts containing LIVE_TV_ODKL cannot validate a video', async () => {
    const app = fixture(() => response('<html><script>const providers=["LIVE_TV_ODKL"];const movie={id:"123",status:"ONLINE"};</script></html>'));
    assert.equal((await app.check({ platform: 'ok', id: '123' })).status, 'unknown');
});

test('OK explicit author restriction needs a healthy known video control', async () => {
    const routes = { 'https://ok.ru/videoembed/123': response('<html>Автор заблокирован</html>'), ['https://ok.ru/videoembed/' + OK_CONTROL]: response(okEmbed(OK_CONTROL)) };
    const result = await fixture(routes).check({ platform: 'ok', id: '123' });
    assert.equal(result.status, 'suspect');
    controlEvidence(result, 'https://ok.ru/videoembed/' + OK_CONTROL);
    routes['https://ok.ru/videoembed/123'] = response('<html>Video not found</html>', 403);
    assert.equal((await fixture(routes).check({ platform: 'ok', id: '123' })).status, 'unknown');
});

test('GoodGame numeric ID is inspected as its exact player, never as a username', async () => {
    const app = fixture({ 'https://goodgame.ru/player?219534': response('<script>var config={"stream":{"id":219534,"name":"Fixture"}};</script>') });
    const result = await app.check({ platform: 'goodgame', id: '219534' });
    assert.equal(result.status, 'exists');
    assert.deepEqual(app.calls.map(call => call.url), ['https://goodgame.ru/player?219534']);
});

test('GoodGame official username mapping can repair an old numeric player ID', async () => {
    const app = fixture({ 'https://goodgame.ru/api/4/users/known_name/stream': response({ id: 219535, status: false }) });
    const result = await app.check({ platform: 'goodgame', id: '219534', ggUsername: 'known_name' });
    assert.equal(result.status, 'repair');
    assert.deepEqual(result.suggestion, { id: '219535', platform: 'goodgame' });
});

test('GoodGame offline and timeout are distinct outcomes', async () => {
    const valid = fixture({ 'https://goodgame.ru/api/4/users/known_name/stream': response({ id: 219534, status: false }) });
    assert.equal((await valid.check({ platform: 'goodgame', id: '219534', ggUsername: 'known_name' })).status, 'offline');
    const failed = fixture(() => new Error('timeout secret-untrusted-message'));
    const result = await failed.check({ platform: 'goodgame', id: '219534' });
    assert.equal(result.status, 'unknown');
    assert.doesNotMatch(JSON.stringify(result), /secret-untrusted-message/);
});

test('YouTube preserves case and identifies an ended live archive', async () => {
    const app = fixture({ [oembedUrl(YT_VIDEO)]: response(oembed(YT_VIDEO)), ['https://www.youtube.com/watch?v=' + YT_VIDEO]: response(watch(YT_VIDEO, { isLiveNow: false, endTimestamp: '2020-01-01T00:00:00Z' })) });
    const result = await app.check({ platform: 'youtube', id: YT_VIDEO });
    assert.equal(result.status, 'ended');
    assert.equal(result.accountId, YT_VIDEO);
    assert.ok(app.calls.every(call => call.url.includes(YT_VIDEO)));
});

test('YouTube oEmbed confirms identity even when watch page is blocked', async () => {
    const app = fixture({ [oembedUrl(YT_VIDEO)]: response(oembed(YT_VIDEO)), ['https://www.youtube.com/watch?v=' + YT_VIDEO]: response('Forbidden', 403) });
    assert.equal((await app.check({ platform: 'youtube', id: YT_VIDEO })).status, 'exists');
});

test('YouTube ignores unrelated watch video live metadata', async () => {
    const app = fixture({ [oembedUrl(YT_VIDEO)]: response(oembed(YT_VIDEO)), ['https://www.youtube.com/watch?v=' + YT_VIDEO]: response(watch(YT_CONTROL, { isLiveNow: true })) });
    assert.equal((await app.check({ platform: 'youtube', id: YT_VIDEO })).status, 'exists');
});

test('YouTube verified full URL repair preserves exact video ID', async () => {
    const app = fixture({ [oembedUrl(YT_VIDEO)]: response(oembed(YT_VIDEO)) });
    const result = await app.check({ platform: 'youtube', id: 'https://youtu.be/' + YT_VIDEO });
    assert.equal(result.status, 'repair');
    assert.equal(result.suggestion.id, YT_VIDEO);
});

test('YouTube explicit unavailable requires a functioning public control', async () => {
    const routes = { [oembedUrl(YT_VIDEO)]: response('Not found', 404), ['https://www.youtube.com/watch?v=' + YT_VIDEO]: response('<script>var ytInitialPlayerResponse={"playabilityStatus":{"status":"ERROR","reason":"Video unavailable"}};</script>'), [oembedUrl(YT_CONTROL)]: response(oembed(YT_CONTROL)) };
    const result = await fixture(routes).check({ platform: 'youtube', id: YT_VIDEO });
    assert.equal(result.status, 'suspect');
    controlEvidence(result, oembedUrl(YT_CONTROL));
    routes[oembedUrl(YT_CONTROL)] = response('Too many requests', 429);
    assert.equal((await fixture(routes).check({ platform: 'youtube', id: YT_VIDEO })).status, 'unknown');
});

test('YouTube login restrictions and malformed 200 payloads are inconclusive', async () => {
    for (const content of ['<html>App shell</html>', '<script>var x={"playabilityStatus":{"status":"LOGIN_REQUIRED","reason":"Sign in to confirm your age"}};</script>']) {
        const app = fixture(() => response(content));
        assert.equal((await app.check({ platform: 'youtube', id: YT_VIDEO })).status, 'unknown');
        assert.equal(app.controls.size, 0);
    }
});

test('YouTube channel and handle identities do not depend on a currently playing video', async () => {
    const metadata = '<script>var ytInitialData={"metadata":{"channelMetadataRenderer":' + JSON.stringify({ externalId: YT_CHANNEL, vanityChannelUrl: 'https://www.youtube.com/@FixtureHandle' }) + '}};</script>';
    for (const id of [YT_CHANNEL, '@FixtureHandle']) {
        const url = 'https://www.youtube.com/' + (id[0] === '@' ? id : 'channel/' + id);
        const app = fixture({ [url]: response(metadata) });
        const result = await app.check({ platform: 'youtube', id });
        assert.equal(result.status, 'exists');
        assert.equal(result.accountId, YT_CHANNEL);
        assert.equal(app.calls[0].url, url);
    }
});

test('YouTube a similarly prefixed handle is not the requested channel identity', async () => {
    const app = fixture({ 'https://www.youtube.com/@Fixture': response('<script>var ytInitialData={"metadata":{"channelMetadataRenderer":' + JSON.stringify({ externalId: YT_CHANNEL, vanityChannelUrl: 'https://www.youtube.com/@FixtureOther' }) + '}};</script>') });
    assert.equal((await app.check({ platform: 'youtube', id: '@Fixture' })).status, 'unknown');
});

test('generic signed stream URLs are direct only and never persist path or parameters', async () => {
    const raw = 'https://media.example.invalid/private-signature/path.m3u8?token=private-query#private-fragment';
    const app = fixture({ [raw]: response('#EXTM3U\n#EXT-X-TARGETDURATION:6\nsegment.ts') });
    const result = await app.check({ platform: 'm3u8', id: raw });
    assert.equal(result.status, 'exists');
    assert.equal(app.calls.length, 1);
    assert.equal(app.calls[0].url, raw);
    assert.equal(app.calls[0].options.direct, true);
    assert.equal(result.evidence[0].url, 'https://media.example.invalid/');
    assert.doesNotMatch(JSON.stringify(result), /private-signature|private-query|private-fragment/);
});

test('generic ended playlists are distinct from unavailable entries', async () => {
    const raw = 'https://media.example.invalid/archive.m3u8';
    const app = fixture({ [raw]: response('#EXTM3U\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n') });
    assert.equal((await app.check({ platform: 'm3u8', id: raw })).status, 'ended');
});

test('generic network/CORS, authentication, rate limits, server errors and malformed 200 are unknown', async () => {
    const raw = 'https://media.example.invalid/live.m3u8';
    for (const body of [new Error('CORS'), response('Forbidden', 403), response('Unauthorized', 401), response('', 429), response('', 500), response(''), response({ error: 'Not found' })]) {
        const app = fixture({ [raw]: body });
        assert.equal((await app.check({ platform: 'm3u8', id: raw })).status, 'unknown');
        assert.equal(app.calls.length, 1);
        assert.equal(app.calls[0].options.direct, true);
    }
});

test('generic real 404 concerns only the entry and never claims the account is dead', async () => {
    const app = fixture(() => response('Not found', 404));
    const result = await app.check({ platform: 'm3u8', id: 'https://media.example.invalid/expired.m3u8' });
    assert.equal(result.status, 'suspect');
    assert.match(result.reason, /入口/);
    assert.match(result.reason, /不能推斷帳戶已刪除/);
    assert.equal(result.accountId, undefined);
});

test('BS checks a public embed directly and recognizes an explicit offline page', async () => {
    const raw = 'https://embed.example.invalid/player';
    const app = fixture({ [raw]: response('<html><body>Channel is offline</body></html>') });
    assert.equal((await app.check({ platform: 'bs', id: raw })).status, 'offline');
    assert.equal(app.calls[0].options.direct, true);
});

test('BS requires a real player and rejects successful protection/login/error HTML', async () => {
    const raw = 'https://embed.example.invalid/player';
    for (const html of ['<html><title>Just a moment...</title><body>Checking your browser...Cloudflare</body></html>', '<html><body>Sign in to continue</body><iframe src="login"></iframe></html>', '<html><body>Application error</body></html>', '<html><body>App shell</body></html>']) {
        const app = fixture({ [raw]: response(html) });
        assert.equal((await app.check({ platform: 'bs', id: raw })).status, 'unknown');
    }
    const player = fixture({ [raw]: response('<html><iframe src="https://player.example.invalid/channel"></iframe></html>') });
    assert.equal((await player.check({ platform: 'bs', id: raw })).status, 'exists');
});

test('generic credentials, unsupported protocols, unsupported platforms and aborted scans do not issue requests', async () => {
    const app = fixture(() => { throw new Error('must not request'); });
    for (const channel of [{ platform: 'm3u8', id: 'https://user:password@example.invalid/live' }, { platform: 'bs', id: 'file:///private' }, { platform: 'unknown', id: 'fixture' }]) {
        assert.equal((await app.check(channel)).status, 'unknown');
    }
    assert.equal(app.calls.length, 0);
    const aborted = fixture({}, { signal: { aborted: true } });
    assert.equal((await aborted.check({ platform: 'm3u8', id: 'https://media.example.invalid/live.m3u8' })).status, 'unknown');
    assert.equal(aborted.calls.length, 0);
});
