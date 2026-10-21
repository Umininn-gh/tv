'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const enabled = process.env.UMININN_BROWSER_TESTS === '1';
const root = path.resolve(__dirname, '..');
let browser;

test.before(async () => {
    if (!enabled) return;
    let playwright;
    try { playwright = require('playwright'); }
    catch (_) { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
    browser = await playwright.chromium.launch({ headless: true,
        ...(process.env.UMININN_BROWSER_EXECUTABLE ? { executablePath: process.env.UMININN_BROWSER_EXECUTABLE } : { channel: 'msedge' }) });
});
test.after(async () => { await browser?.close(); });

const sdk = `
window.fixtureSDK ||= { hls: [], flv: [] };
window.Hls = class {
    static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
    static isSupported() { return true; }
    constructor() { this.events = new Map(); this.state = { destroyed: 0 }; fixtureSDK.hls.push(this.state); }
    on(event, fn) { this.events.set(event, fn); }
    loadSource(src) { this.state.src = src; }
    attachMedia(video) { this.state.connected = video.isConnected; this.state.muted = video.muted; }
    destroy() { this.state.destroyed++; }
};
window.flvjs = { isSupported: () => true, Events: { ERROR: 'error' }, createPlayer(options) {
    const state = { url: options.url, destroyed: 0 }; fixtureSDK.flv.push(state);
    return { on() {}, attachMediaElement(video) { state.connected = video.isConnected; state.muted = video.muted; },
        load() {}, play() { return Promise.resolve(); }, pause() {}, unload() {}, detachMediaElement() {}, destroy() { state.destroyed++; } };
} };
`;

async function fixture(mount) {
    const page = await browser.newPage();
    const origin = 'https://loading-fixture.invalid', base = origin + mount;
    const requests = [], pending = { announcements: [], hls: [], flv: [] }, errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
        if (window !== top || location.hostname !== 'loading-fixture.invalid') return;
        sessionStorage.setItem('fixture-login', '0'.repeat(64));
        // Force the non-native path consistently across Chromium releases.
        const canPlayType = HTMLMediaElement.prototype.canPlayType;
        HTMLMediaElement.prototype.canPlayType = function (type) {
            return type === 'application/vnd.apple.mpegurl' ? '' : canPlayType.call(this, type);
        };
    });
    await page.route('**/*', async route => {
        const url = new URL(route.request().url()); requests.push(url.href);
        if (url.href === 'https://cdn.jsdelivr.net/npm/hls.js@latest') { pending.hls.push(route); return; }
        if (url.origin !== origin) return route.abort();
        const relative = url.pathname.slice(mount.length);
        if (relative === 'jquery-3.6.0.min.js') { pending.announcements.push(route); return; }
        if (relative === 'flv.min.js') { pending.flv.push(route); return; }
        if (relative === 'login-config.js') return route.fulfill({ contentType: 'application/javascript',
            body: `window.TV_LOGIN_CONFIG={passwordHash:'${'0'.repeat(64)}',passwordSalt:'fixture',storageKey:'fixture-login'};` });
        if (relative === 'ch1.txt') return route.fulfill({ contentType: 'text/plain', body: '本地頻道,fixture,at\n' });
        if (relative === 'token.txt') return route.fulfill({ contentType: 'text/plain', body: '' });
        if (relative === 'chat/' || relative === 'test3.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="auth-area"></div>' });
        if (relative.startsWith('data/')) return route.abort();
        const file = path.resolve(root, relative || 'index.html');
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.abort();
        const contentType = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream';
        return route.fulfill({ contentType, body: fs.readFileSync(file) });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-screen', { state: 'detached' });
    await page.waitForFunction(() => Boolean(window.tvAppReady));
    await page.evaluate(() => window.tvAppReady);
    async function waitForPending(kind, count = 1) {
        for (let i = 0; i < 100 && pending[kind].length < count; i++) await page.waitForTimeout(20);
        assert.ok(pending[kind].length >= count, `${kind} request ${count} must arrive`);
    }
    return { page, requests, pending, errors, waitForPending,
        async finish(kind, index = 0, body = sdk) { await pending[kind][index].fulfill({ contentType: 'application/javascript', body }); },
        async close() { await page.close(); }
    };
}

for (const mount of ['/', '/tv/']) {
    test(`${mount}: stalled/failed announcements cannot block login or ordinary viewing`, { skip: !enabled }, async () => {
        const f = await fixture(mount);
        try {
            await f.waitForPending('announcements');
            assert.equal(await f.page.locator('#channel-strip .status-button').count(), 1);
            await f.page.locator('#channel-strip .status-button').click();
            await f.page.waitForFunction(() => document.querySelector('#multi-stream-container iframe')?.src.includes('angelthump.com'));
            assert.equal(f.pending.hls.length, 0); assert.equal(f.pending.flv.length, 0);
            assert.equal(f.requests.some(url => /jquery/i.test(url) && !url.includes("/jquery-3.6.0.min.js")), false);
            await f.pending.announcements[0].abort();
            await f.page.waitForTimeout(50);
            assert.equal(await f.page.locator('body.login-locked').count(), 0);
            assert.equal(await f.page.locator('#login-screen').count(), 0);
            assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
    });
}

test('browser: async HLS/FLV downloads deduplicate, retry, retain audio and ignore closed players', { skip: !enabled }, async () => {
    const f = await fixture('/tv/');
    try {
        await f.page.evaluate(() => {
            window.fixtureChannels = ['a', 'b'].map(id => ({ id: 'https://media.invalid/' + id + '.m3u8', name: 'HLS ' + id, platform: 'm3u8' }))
                .concat(['a', 'b'].map(id => ({ id, name: 'FLV ' + id, platform: 'vaughn' })));
            syncActivePlayers(fixtureChannels); toggleAllAudio();
        });
        await f.waitForPending('hls'); await f.waitForPending('flv');
        assert.equal(f.pending.hls.length, 1); assert.equal(f.pending.flv.length, 1);
        await f.page.evaluate(() => {
            closePlayer(ChannelList.channelKey(fixtureChannels[0]));
            closePlayer(ChannelList.channelKey(fixtureChannels[2]));
        });
        await f.pending.hls[0].abort();
        await f.page.waitForFunction(() => activePlayers.get(ChannelList.channelKey(fixtureChannels[1])).resource.failed);
        await f.page.evaluate(() => syncActivePlayers([fixtureChannels[1], fixtureChannels[3]]));
        await f.waitForPending('hls', 2); assert.equal(f.pending.flv.length, 1);
        await f.finish('hls', 1); await f.finish('flv');
        await f.page.waitForFunction(() => fixtureSDK.hls.length === 1 && fixtureSDK.flv.length === 1);
        assert.deepEqual(await f.page.evaluate(() => ({
            hls: fixtureSDK.hls.map(state => ({ connected: state.connected, muted: state.muted, destroyed: state.destroyed })),
            flv: fixtureSDK.flv.map(state => ({ connected: state.connected, muted: state.muted, destroyed: state.destroyed }))
        })), { hls: [{ connected: true, muted: false, destroyed: 0 }], flv: [{ connected: true, muted: false, destroyed: 0 }] });
        await f.page.evaluate(() => syncActivePlayers([]));
        assert.deepEqual(await f.page.evaluate(() => [fixtureSDK.hls[0].destroyed, fixtureSDK.flv[0].destroyed, currentHLSInstances.length, currentFLVInstances.length]), [1, 1, 0, 0]);
        await f.waitForPending('announcements');
        await f.finish('announcements', 0, 'window.fixtureAnnouncementRuns=(window.fixtureAnnouncementRuns||0)+1; document.addEventListener("fixture:notice",()=>{window.fixtureNotices=(window.fixtureNotices||0)+1});');
        await f.page.waitForFunction(() => window.fixtureAnnouncementRuns === 1);
        await f.page.evaluate(async () => {
            await Promise.all([TVScriptLoader.load('./jquery-3.6.0.min.js', 'module'), TVScriptLoader.load('./jquery-3.6.0.min.js', 'module')]);
            document.dispatchEvent(new Event('fixture:notice'));
        });
        assert.deepEqual(await f.page.evaluate(() => [fixtureAnnouncementRuns, fixtureNotices]), [1, 1]);
        assert.equal(f.pending.announcements.length, 1); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});
