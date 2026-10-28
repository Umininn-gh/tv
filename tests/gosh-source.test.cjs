const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const migratedApp = path.resolve(__dirname, '../site/assets/js/tv-app.js');
const appFile = fs.existsSync(migratedApp) ? migratedApp : path.resolve(__dirname, '../tv-app.js');
const StreamPerformance = require(path.join(path.dirname(appFile), 'stream-performance.js'));
const source = fs.readFileSync(appFile, 'utf8').replace(/\r\n/g, '\n');
const metadataFunction = source.match(/^function getGoshMetadata\(channel\) \{[\s\S]*?^\}/m)?.[0];
const statusFunction = source.match(/^async function fetchStatus\(channel,[\s\S]*?^\}/m)?.[0];
const platformBlock = source.slice(source.indexOf('\tgosh: {'), source.indexOf('\n    goodgame:'));
assert.ok(metadataFunction && statusFunction && platformBlock);
const playlist = 'https://pull.gosh6.app/live/example.m3u8?expires=123&signature=fake-private-query';
const response = (data, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status,
    headers: { get: key => headers[key.toLowerCase()] ?? null }, text: async () => typeof data === 'string' ? data : JSON.stringify(data) });

function fixture(fetcher, { attemptTimeoutMs } = {}) {
    const calls = [], logs = [], updates = [];
    const workers = ['https://gosh.chicktv02.workers.dev', 'https://dry-wildflower-371d.forgosh.workers.dev'];
    const proxies = ['https://young-cloud-e59f.chicktv001.workers.dev', 'https://wispy-sound-ef1a.for-api.workers.dev'];
    const performance = { ...StreamPerformance, withRequestTimeout: (task, options) => StreamPerformance.withRequestTimeout(task,
        attemptTimeoutMs ? { timeoutMs: Math.min(options?.timeoutMs || 20000, attemptTimeoutMs) } : options) };
    let workerIndex = 0;
    const context = vm.createContext({ URL, AbortController, TextDecoder, TextEncoder, setTimeout, clearTimeout,
        GOSH_PROXY_LIST: workers, PROXY_LIST: proxies, getNextGoshProxy: () => workers[workerIndex++ % workers.length],
        StreamPerformance: performance, goshMetadataRequests: StreamPerformance.createInFlightCoalescer(),
        fetch: async (url, options) => { calls.push({ url, options }); return fetcher(url, options, calls.length); },
        channelStatuses: {}, statusScheduler: StreamPerformance.createStatusScheduler({ maxConcurrent: 2, cacheMs: 0 }),
        updateUIForChannel: channel => updates.push(channel), console: { warn: (...args) => logs.push(args.map(String).join(' ')) } });
    vm.runInContext(metadataFunction + '\nconst PLATFORMS = {' + platformBlock + '\n};\n' +
        'function getPlatform(platform) { return PLATFORMS[platform]; }\n' + statusFunction + '\n' +
        'this.goshPlatform = PLATFORMS.gosh;', context);
    return { context, calls, logs, updates, check: id => context.getGoshMetadata({ id, platform: 'gosh' }) };
}

test('current public metadata is preferred; only fixed public channel URLs reach proxies', async () => {
    const f = fixture(async () => response({ isLive: true, m3u8Url: playlist, unexpected: 'discard' }));
    const result = await f.check('KingKong_TV');
    assert.equal(result.isLive, true); assert.equal(result.m3u8Url, playlist);
    assert.deepEqual(Object.keys(result).sort(), ['isLive', 'm3u8Url']);
    assert.equal(f.calls.length, 1);
    const call = f.calls[0], request = new URL(call.url);
    assert.equal(request.origin, 'https://young-cloud-e59f.chicktv001.workers.dev');
    assert.equal(request.searchParams.get('quest'), 'https://skknower.com/api/userlive/gosh?cid=kingkong_tv');
    assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.referrerPolicy, 'no-referrer');
    assert.equal(call.options.redirect, 'error');
    assert.equal(Object.keys(call.options.headers).join(','), 'Accept');
    assert.equal(JSON.stringify(f.calls).includes('fake-private-query'), false);
});

test('primary network failure falls back to the second public metadata proxy', async () => {
    const f = fixture(async (_url, _options, count) => { if (count === 1) throw new Error('transport detail'); return response({ isLive: true, m3u8Url: playlist }); });
    assert.equal((await f.check('meidingdang')).isLive, true);
    assert.equal(f.calls.length, 2);
    assert.equal(new URL(f.calls[1].url).hostname, 'wispy-sound-ef1a.for-api.workers.dev');
});

test('HTTP200 provider status401 with false is an error, never an offline answer', async () => {
    const f = fixture(async (_url, _options, count) => count <= 3 ? response({ isLive: false, status: 401, message: 'API error' }) : response({ isLive: true, m3u8Url: playlist }));
    assert.equal((await f.check('meidingdang')).isLive, true);
    assert.equal(f.calls.length, 4);
    assert.equal(f.calls[2].url.startsWith('https://gosh.chicktv02.workers.dev/'), true);
});

test('an explicit valid false remains offline and does not need a playback URL', async () => {
    for (const payload of [{ isLive: false }, { isLive: false, m3u8Url: '' }, { isLive: false, status: 200 }]) {
        const f = fixture(async () => response(payload));
        assert.equal((await f.check('no25no2501')).isLive, false);
        assert.equal(await f.context.goshPlatform.status({ id: 'no25no2501' }), 'not-live');
        await assert.rejects(f.context.goshPlatform.getStreamUrl({ id: 'no25no2501' }), /未開播/);
    }
});

test('malformed JSON, missing booleans and provider errors never hide a channel as offline', async () => {
    const invalid = ['<html>error</html>', null, {}, [], { isLive: 'false' }, { isLive: false, status: 'error' },
        { isLive: false, statusCode: 403 }, { isLive: false, code: 429 }, { isLive: false, error: 'failed' },
        { isLive: false, errors: ['failed'] }, { isLive: false, success: false }, { isLive: true, m3u8Url: playlist, channelId: 'different' }];
    for (const payload of invalid) {
        const f = fixture(async () => response(payload));
        assert.equal(await f.context.fetchStatus({ id: 'meidingdang', platform: 'gosh' }), 'unknown');
        assert.equal(f.context.channelStatuses.gosh_meidingdang, 'unknown');
        assert.equal(f.calls.length, 4);
    }
});

test('unsafe, non-playlist and absent playback URLs cannot validate live metadata', async () => {
    const invalid = [undefined, '', 'http://pull.gosh6.app/live/a.m3u8', 'https://user:pass@pull.gosh6.app/live/a.m3u8',
        'https://pull.gosh6.app:8443/live/a.m3u8', 'https://127.0.0.1/live/a.m3u8', 'https://192.168.1.1/live/a.m3u8',
        'https://metadata.internal/live/a.m3u8', 'https://[::1]/live/a.m3u8', 'https://pull.gosh6.app/api/error'];
    for (const url of invalid) {
        const f = fixture(async () => response({ isLive: true, m3u8Url: url }));
        await assert.rejects(f.check('meidingdang'), /暫時未能取得/);
        assert.equal(f.calls.length, 4);
    }
});

test('all transport failures become unknown and cannot echo raw provider messages or signed URLs', async () => {
    const f = fixture(async () => { throw new Error('Sensitive transport ' + playlist); });
    assert.equal(await f.context.fetchStatus({ id: 'meidingdang', platform: 'gosh' }), 'unknown');
    assert.equal(f.calls.length, 4);
    assert.equal(f.logs.join('').includes('fake-private-query'), false);
    assert.equal(f.logs.join('').includes('Sensitive transport'), false);
});

test('simultaneous status/playback lookups coalesce without caching an expired playback URL', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const f = fixture(async (_url, _options, count) => { if (count === 1) await pending; return response({ isLive: true, m3u8Url: playlist + '&version=' + count }); });
    const first = f.context.goshPlatform.status({ id: 'MEIDINGDANG' });
    const second = f.context.goshPlatform.getStreamUrl({ id: 'meidingdang' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 1);
    release();
    assert.equal(await first, 'live');
    assert.match(await second, /version=1$/);
    assert.match(await f.context.goshPlatform.getStreamUrl({ id: 'meidingdang' }), /version=2$/);
    assert.equal(f.calls.length, 2);
});

test('a stalled metadata body is aborted by its deadline and does not block a working fallback', async () => {
    const f = fixture(async (_url, _options, count) => count === 1 ? { ok: true, headers: { get: () => null }, text: () => new Promise(() => {}) } : response({ isLive: true, m3u8Url: playlist }), { attemptTimeoutMs: 12 });
    assert.equal((await f.check('meidingdang')).isLive, true);
    assert.equal(f.calls.length, 2); assert.equal(f.calls[0].options.signal.aborted, true);
});

test('declared oversized metadata is rejected before reading and bounded streamed data is cancelled', async () => {
    let read = false, cancelled = false;
    const tooLarge = { ok: true, headers: { get: () => '1000000' }, text: async () => { read = true; return '{}'; } };
    const f = fixture(async (_url, _options, count) => count === 1 ? tooLarge : response({ isLive: false }));
    assert.equal((await f.check('meidingdang')).isLive, false); assert.equal(read, false);
    const streamed = { ok: true, headers: { get: () => null }, body: { getReader: () => ({
        read: async () => ({ done: false, value: new Uint8Array(65537) }), cancel: async () => { cancelled = true; }, releaseLock() {} }) } };
    const other = fixture(async (_url, _options, count) => count === 1 ? streamed : response({ isLive: false }));
    assert.equal((await other.check('meidingdang')).isLive, false); assert.equal(cancelled, true);
});

test('invalid channel identifiers cannot create requests or enter fixed proxy URLs', async () => {
    const f = fixture(async () => response({ isLive: false }));
    for (const id of ['', '../x', 'https://example.com/', 'bad?token=secret', 'x'.repeat(81)]) await assert.rejects(f.check(id));
    assert.equal(f.calls.length, 0);
});
