const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ChannelList = require('../channel-list.js');
const ChannelHealth = require('../channel-health.js');
const channel = (id, platform = 'kick') => ({ name: id, id, platform });
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (body, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status, text: async () => typeof body === 'string' ? body : JSON.stringify(body), headers: { get: name => headers[name] || null } });
function storage(initial = {}) { const values = new Map(Object.entries(initial)); return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; }
const clue = (status = 'offline', reason = 'Account exists') => ({ status, reason, evidence: [{ url: 'https://kick.com/api/v2/channels/test', label: 'Official account', httpStatus: 200, summary: reason }] });

test('scan covers all platforms including offline entries, caps concurrent probes and leaves input immutable', async () => {
    let active = 0, peak = 0;
    const statuses = ['live', 'offline', 'exists', 'repair', 'suspect', 'ended', 'unknown'];
    const input = ['twitch', 'kick', 'gosh', 'at', 'vaughn', 'goodgame', 'youtube', 'ok', 'm3u8', 'bs'].map((platform, index) => ({ ...channel('id' + index, platform), _fromTxt: true, privateFixture: 'not-returned' }));
    const before = structuredClone(input), progress = [];
    const scanner = ChannelHealth.createScanner({ platforms: { async check(c) { active++; peak = Math.max(peak, active); await tick(); active--; return clue(statuses[Number(c.id.slice(2)) % statuses.length]); } } });
    const report = await scanner.scan(input, { onProgress: value => progress.push(value.completed) });
    assert.equal(report.results.length, 10); assert.equal(report.totals.total, 10); assert.equal(report.totals.completed, 10); assert.equal(peak, 4);
    assert.equal(report.cancelled, false); assert.deepEqual(input, before); assert.equal(progress[0], 0); assert.equal(progress.at(-1), 10);
    assert.ok(report.results.every(result => result.history.length === 1 && result.history[0].checkedAt === result.checkedAt));
    assert.ok(!JSON.stringify(report).includes('not-returned'));
});

test('control results are shared transparently per platform per scan and reset for a later scan', async () => {
    let controls = 0; const seen = [];
    const scanner = ChannelHealth.createScanner({ platforms: { async check(c, ctx) { const control = await ctx.control(c.platform, async () => { controls++; await tick(); return { valid: true, evidence: ['control'] }; }); seen.push(control); return clue('suspect'); } } });
    const channels = [channel('a'), channel('b'), channel('c')];
    await scanner.scan(channels); assert.equal(controls, 1); assert.equal(seen[0], seen[1]); assert.equal(seen[0].valid, true);
    await scanner.scan(channels); assert.equal(controls, 2);
});

test('official requests use fixed public proxies and HTTP request concurrency stays bounded', async () => {
    const requests = []; let active = 0, peak = 0;
    const scanner = ChannelHealth.createScanner({ fetcher: async (url, options) => { requests.push({ url, options }); active++; peak = Math.max(peak, active); await tick(); active--; return response({ id: 1 }); }, platforms: { async check(c, ctx) { await Promise.all([ctx.request('https://kick.com/api/v2/channels/' + c.id), ctx.request('https://kick.com/api/v1/channels/' + c.id)]); return clue(); } } });
    await scanner.scan(Array.from({ length: 8 }, (_, i) => channel('u' + i)));
    assert.equal(peak, 4); assert.equal(requests.length, 16);
    for (const request of requests) { assert.equal(new URL(request.url).origin, 'https://young-cloud-e59f.chicktv001.workers.dev'); assert.match(new URL(request.url).searchParams.get('quest'), /^https:\/\/kick.com\/api/); assert.equal(request.options.credentials, 'omit'); assert.equal(request.options.redirect, 'error'); assert.equal(request.options.referrerPolicy, 'no-referrer'); assert.ok(!request.options.headers.Authorization); }
});

test('generic streams are direct-only and evidence/history never persist URL paths, queries or userinfo', async () => {
    const saved = storage(); const requests = [];
    const id = 'https://cdn.example.com/private-signature-in-path/live.m3u8?signature=signed-private-fixture#fragment';
    const scanner = ChannelHealth.createScanner({ storage: saved, fetcher: async (url, options) => { requests.push({ url, options }); return response('#EXTM3U'); }, platforms: { async check(c, ctx) { await ctx.request(c.id, { direct: true }); return { status: 'exists', reason: 'See ' + c.id, evidence: [{ url: 'https://private-user:private-password@cdn.example.com/private-signature-in-path/live.m3u8?signature=signed-private-fixture', label: 'Stream', summary: c.id }] }; } } });
    const result = await scanner.check(channel(id, 'm3u8'));
    assert.equal(requests[0].url, id); assert.equal(requests.length, 1);
    assert.equal(result.evidence[0].url, 'https://cdn.example.com/');
    assert.ok(scanner.recordDecision(channel(id, 'm3u8'), 'keep'));
    for (const text of [result.reason, JSON.stringify(result.evidence), JSON.stringify(result.history), JSON.stringify([...saved.values])]) for (const secret of ['signed-private-fixture', 'private-signature-in-path', 'private-user', 'private-password', 'signature=']) assert.ok(!text.includes(secret));
    const reloaded = ChannelHealth.createScanner({ storage: saved, platforms: { check: async () => clue() } });
    assert.equal(reloaded.history(channel(id, 'm3u8')).length, 1);
});

test('older generic local keys containing private stream paths are discarded and storage is cleaned', async () => {
    const key = 'm3u8|https://cdn.example.com/private-signature-in-path/live.m3u8#1234abcd';
    const saved = storage({
        umininnChannelHealthHistoryV1: JSON.stringify([{ key, observations: [{ status: 'exists', reason: 'See https://cdn.example.com/private-signature-in-path/live.m3u8?signature=private-query', checkedAt: '2026-10-16T00:00:00Z', evidence: [] }] }]),
        umininnChannelHealthDecisionsV1: JSON.stringify([{ key, decision: 'keep', checkedAt: '2026-10-16T00:00:00Z' }])
    });
    const scanner = ChannelHealth.createScanner({ storage: saved });
    assert.deepEqual(scanner.history(channel('https://cdn.example.com/private-signature-in-path/live.m3u8?signature=private-query', 'm3u8')), []);
    assert.deepEqual(JSON.parse(saved.getItem('umininnChannelHealthHistoryV1')), []);
    assert.deepEqual(JSON.parse(saved.getItem('umininnChannelHealthDecisionsV1')), []);
    assert.ok(!JSON.stringify([...saved.values]).includes('private-signature-in-path'));
});

test('fixed allowlist rejects GitHub, lookalikes, local addresses and arbitrary generic proxy requests', async () => {
    for (const [id, platform, target, settings] of [
        ['u', 'kick', 'https://api.github.com/repos/owner/repo', {}], ['u', 'kick', 'https://kick.com.evil.example/api/v2/channels/u', {}],
        ['http://127.0.0.1/live.m3u8', 'm3u8', 'http://127.0.0.1/live.m3u8', { direct: true }],
        ['https://cdn.example.com/live.m3u8', 'm3u8', 'https://cdn.example.com/live.m3u8', {}],
        ['https://cdn.example.com/live.m3u8', 'm3u8', 'https://other.example.com/live.m3u8', { direct: true }]
    ]) {
        let calls = 0;
        const scanner = ChannelHealth.createScanner({ fetcher: async () => { calls++; return response(''); }, platforms: { async check(c, ctx) { await ctx.request(target, settings); return clue('live'); } } });
        assert.equal((await scanner.check(channel(id, platform))).status, 'unknown'); assert.equal(calls, 0);
    }
});

test('Twitch credentials load lazily once, go only to direct official APIs and never enter evidence or storage', async () => {
    const token = 'twitch-secret-token-fixture', clientId = 'twitch-client-id-fixture', saved = storage(), requests = [];
    const scanner = ChannelHealth.createScanner({ storage: saved, fetcher: async (url, options) => { requests.push({ url, options }); return url === './token.txt' ? response(token + '\n' + clientId) : response({ data: [{ id: '42' }] }); }, platforms: { async check(c, ctx) { if (c.platform === 'kick') { await ctx.request('https://kick.com/api/v2/channels/control'); return clue(); } const auth = await ctx.twitch(); await ctx.request('https://api.twitch.tv/helix/users?login=' + c.id, { direct: true, headers: { Authorization: 'Bearer ' + auth.token, 'Client-Id': auth.clientId } }); return { status: 'exists', accountId: '42', reason: 'Bearer ' + auth.token, evidence: [{ url: 'https://api.twitch.tv/helix/users?login=' + c.id + '&token=' + auth.token, label: auth.clientId, summary: auth.token }] }; } } });
    const result = await scanner.scan([channel('one', 'twitch'), channel('two', 'twitch'), channel('other', 'kick')]);
    assert.equal(requests.filter(item => item.url === './token.txt').length, 1);
    for (const request of requests) if (request.options.headers.Authorization) { assert.equal(new URL(request.url).hostname, 'api.twitch.tv'); assert.equal(request.options.headers.Authorization, 'Bearer ' + token); } else assert.ok(!request.options.headers['Client-Id']);
    assert.equal(result.results[0].evidence[0].url, 'https://api.twitch.tv/helix/users?login=one');
    for (const output of [JSON.stringify(result), JSON.stringify([...saved.values])]) { assert.ok(!output.includes(token)); assert.ok(!output.includes(clientId)); }
});

test('caller-supplied authorization cannot be forwarded to workers or replace Twitch credentials', async () => {
    const requests = [];
    for (const platform of ['kick', 'twitch']) {
        const scanner = ChannelHealth.createScanner({ fetcher: async (url, options) => { requests.push({ url, options }); return response('real-twitch-token\nreal-client-id'); }, platforms: { async check(c, ctx) { await ctx.request(platform === 'kick' ? 'https://kick.com/api/v2/channels/u' : 'https://api.twitch.tv/helix/users?login=u', { headers: { Authorization: 'Bearer github-write-secret' } }); return clue(); } } });
        assert.equal((await scanner.check(channel('u', platform))).status, 'unknown');
    }
    assert.equal(requests.length, 1); assert.equal(requests[0].url, './token.txt'); assert.ok(!JSON.stringify(requests).includes('github-write-secret'));
});

test('identity evidence preserves only allowlisted public query selectors across history reloads', async () => {
    const saved = storage();
    const urls = ['https://api.twitch.tv/helix/users?login=old_name&id=42&access_token=secret', 'https://www.youtube.com/watch?v=UL8iGQiTrlA&signature=secret', 'https://goodgame.ru/player?219534&token=secret', 'https://gosh.chicktv02.workers.dev/?channelId=meidingdang&token=secret'];
    const scanner = ChannelHealth.createScanner({ storage: saved, platforms: { check: async () => ({ status: 'exists', reason: 'Official record', evidence: urls.map(url => ({ url, label: 'Official', summary: 'Exists' })) }) } });
    const c = channel('u'); await scanner.check(c); await scanner.check(c);
    const expected = ['https://api.twitch.tv/helix/users?login=old_name&id=42', 'https://www.youtube.com/watch?v=UL8iGQiTrlA', 'https://goodgame.ru/player?219534', 'https://gosh.chicktv02.workers.dev/?channelId=meidingdang'];
    assert.deepEqual(scanner.history(c)[0].evidence.map(value => value.url), expected);
    const reloaded = ChannelHealth.createScanner({ storage: saved });
    assert.deepEqual(reloaded.history(c)[1].evidence.map(value => value.url), expected); assert.ok(!JSON.stringify([...saved.values]).includes('secret'));
});

test('request deadline covers a stuck body, falls back and releases the queue', async () => {
    const signals = []; let requests = 0;
    const scanner = ChannelHealth.createScanner({ timeoutMs: 5, maxConcurrent: 1, fetcher: async (_url, options) => { requests++; signals.push(options.signal); return requests <= 2 ? { ok: true, status: 200, headers: { get: () => null }, text: () => new Promise(() => {}) } : response({ id: 1 }); }, platforms: { async check(c, ctx) { await ctx.request('https://kick.com/api/v2/channels/' + c.id); return clue('exists'); } } });
    const report = await scanner.scan([channel('hung'), channel('next')]);
    assert.equal(report.results[0].status, 'unknown'); assert.equal(report.results[1].status, 'exists'); assert.equal(requests, 3); assert.ok(signals.slice(0, 2).every(signal => signal.aborted));
});

test('cancellation stops queued work and all late callbacks even if an adapter ignores cancellation', async () => {
    const controller = new AbortController(); let release, calls = 0, results = 0, progress = 0;
    const pending = new Promise(resolve => { release = resolve; });
    const scanner = ChannelHealth.createScanner({ maxConcurrent: 1, platforms: { async check() { calls++; await pending; return clue('suspect'); } } });
    const scanning = scanner.scan([channel('a'), channel('b')], { signal: controller.signal, onResult() { results++; }, onProgress() { progress++; } });
    await tick(); controller.abort(); const report = await scanning; const before = progress;
    release(); await tick();
    assert.equal(report.cancelled, true); assert.equal(report.results.length, 0); assert.equal(calls, 1); assert.equal(results, 0); assert.equal(progress, before); assert.deepEqual(scanner.history(channel('a')), []);
    await assert.rejects(scanner.check(channel('a'), { signal: controller.signal }), value => value.name === 'AbortError');
});

test('cancelling a network probe aborts its request and does not start the fallback', async () => {
    const controller = new AbortController(), signals = [];
    const scanner = ChannelHealth.createScanner({ fetcher: async (_url, options) => { signals.push(options.signal); return new Promise(() => {}); }, platforms: { async check(c, ctx) { await ctx.request('https://kick.com/api/v2/channels/a'); return clue(); } } });
    const scanning = scanner.scan([channel('a')], { signal: controller.signal });
    await tick(); controller.abort(); const report = await scanning;
    assert.equal(report.cancelled, true); assert.equal(signals.length, 1); assert.equal(signals[0].aborted, true);
});

test('body cap applies before reading declared oversize and streamed oversize is cancelled', async () => {
    for (const streamed of [false, true]) {
        let reads = 0, cancelled = 0;
        const scanner = ChannelHealth.createScanner({ fetcher: async () => streamed ? { ok: true, status: 200, headers: { get: () => null }, body: { getReader: () => ({ read: async () => { reads++; return { done: false, value: new Uint8Array(1024 * 1024 + 1) }; }, cancel: async () => { cancelled++; }, releaseLock() {} }) } } : { ok: true, status: 200, headers: { get: name => name === 'content-length' ? String(1024 * 1024 + 1) : null }, text: async () => { reads++; return '{}'; } }, platforms: { async check(c, ctx) { await ctx.request('https://kick.com/api/v2/channels/a', { maxBytes: 50000000 }); return clue('suspect'); } } });
        assert.equal((await scanner.check(channel('a'))).status, 'unknown');
        assert.equal(reads, streamed ? 2 : 0); assert.equal(cancelled, streamed ? 2 : 0);
    }
});

test('seeded stable IDs survive unknown results and five-entry history truncation', async () => {
    const saved = storage(); let checks = 0;
    const seed = { entries: [{ ...channel('old_name', 'twitch'), account: { id: '42' } }] };
    const scanner = ChannelHealth.createScanner({ storage: saved, seed, now: () => Date.UTC(2026, 9, 16) + checks++, platforms: { async check(c, ctx) { assert.equal(ctx.previous(c).accountId, '42'); return clue('unknown'); } } });
    for (let i = 0; i < 8; i++) assert.equal((await scanner.check(channel('old_name', 'twitch'))).accountId, '42');
    assert.equal(scanner.history(channel('old_name', 'twitch')).length, 5);
    const reloaded = ChannelHealth.createScanner({ storage: saved, platforms: { async check(c, ctx) { assert.equal(ctx.previous(c).accountId, '42'); return clue('repair'); } } });
    assert.equal((await reloaded.check(channel('old_name', 'twitch'))).accountId, '42');
});

test('local history is capped at 200 channels and never touches private or shared channel lists', async () => {
    const saved = storage({ customChannels1: 'private-original', umininnSharedChannelCache: 'shared-original' });
    const scanner = ChannelHealth.createScanner({ storage: saved, platforms: { check: async () => clue('offline') } });
    await scanner.scan(Array.from({ length: 205 }, (_, i) => channel('u' + i)));
    const raw = JSON.parse(saved.values.get('umininnChannelHealthHistoryV1'));
    assert.equal(raw.length, 200); assert.equal(saved.getItem('customChannels1'), 'private-original'); assert.equal(saved.getItem('umininnSharedChannelCache'), 'shared-original');
});

test('decisions persist separately, reappear on later scans and never mutate existing report snapshots', async () => {
    const saved = storage(); let calls = 0;
    const options = { storage: saved, platforms: { check: async () => { calls++; return clue('suspect'); } } };
    const scanner = ChannelHealth.createScanner(options), c = channel('u'); const original = await scanner.check(c), before = structuredClone(original);
    assert.equal(scanner.recordDecision(c, 'keep').persisted, true); assert.deepEqual(original, before); assert.equal(calls, 1);
    const reloaded = ChannelHealth.createScanner(options), next = await reloaded.check(c);
    assert.equal(next.decision.decision, 'keep'); assert.equal(next.history[0].lastDecision.decision, 'keep');
    assert.equal(reloaded.recordDecision(c, 'deleted').persisted, true); assert.equal(calls, 2);
    assert.throws(() => reloaded.recordDecision(c, 'delete-all')); assert.equal(reloaded.save, undefined);
});

test('storage failure cannot falsely report a persisted keep or deleted decision', async () => {
    const full = { getItem: () => null, setItem() { throw new Error('Quota'); } };
    const scanner = ChannelHealth.createScanner({ storage: full, platforms: { check: async () => clue() } });
    assert.equal(scanner.recordDecision(channel('u'), 'keep'), false); assert.equal(scanner.recordDecision(channel('u'), 'deleted'), false);
    const result = await scanner.check(channel('u')); assert.equal(result.decision, undefined); assert.equal(result.history.length, 1);
});

test('browser global exports without CommonJS and incomplete adapters remain unknown', async () => {
    const context = vm.createContext({ ChannelList, URL, Date, AbortController, TextEncoder, TextDecoder, setTimeout, clearTimeout, console });
    vm.runInContext(fs.readFileSync(require.resolve('../channel-health.js'), 'utf8'), context);
    assert.equal(typeof context.ChannelHealth.createScanner, 'function');
    const scanner = context.ChannelHealth.createScanner({ platforms: {} }); assert.equal((await scanner.check(channel('u'))).status, 'unknown');
});
