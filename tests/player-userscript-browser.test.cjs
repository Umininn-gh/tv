'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// These tests inject the built file as a userscript manager would, including in
// cross-origin frames. They do not install Tampermonkey or Violentmonkey.
const enabled = process.env.UMININN_BROWSER_TESTS === '1';
const root = path.resolve(__dirname, '..');
const siteOrigin = 'https://umininn-gh.github.io';
const siteUrl = siteOrigin + '/tv/';
const playerUrl = 'https://player.kick.com/qa-player';
const unknownUrl = 'https://unapproved.invalid/player';
const channel = 'umininn-tv-userscript';
const panel = '#umininn-player-panel-host';
let browser, unavailable, script;

test.before(async () => {
    if (!enabled) return;
    let playwright;
    try { playwright = require('playwright'); }
    catch (_) {
        try { playwright = require(path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright')); }
        catch (_) { unavailable = 'Playwright is unavailable; install it to run the optional browser tests.'; return; }
    }
    for (const options of [{ headless: true }, { channel: 'msedge', headless: true }]) {
        try {
            browser = await playwright.chromium.launch({ ...options, args: ['--autoplay-policy=no-user-gesture-required'] });
            break;
        } catch (_) { /* Try the installed Edge if bundled Chromium is absent. */ }
    }
    if (!browser) { unavailable = 'Could not launch Chromium/Edge; check the browser installation and local process permissions.'; return; }
    const filename = path.join(root, 'userscript', 'umininn-tv-player.user.js');
    assert.ok(fs.existsSync(filename), 'Build the userscript with node tools/build-player-userscript.cjs first.');
    script = fs.readFileSync(filename, 'utf8');
});

test.after(async () => { await browser?.close(); });

// Valid PCM/WAV content is generated locally. Real HTMLMediaElement properties,
// events and play() are exercised without fetching any external media.
function silentWav() {
    const rate = 8000, samples = rate * 2;
    const bytes = Buffer.alloc(44 + samples * 2);
    bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
    bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
    return bytes;
}

const wav = silentWav();
const playerHtml = '<!doctype html><html><body style="margin:0"><video id="fixture-video" muted loop preload="auto" src="/silent.wav" style="display:block;width:280px;height:160px"></video></body></html>';
const siteHtml = '<!doctype html><html><body><div id="input-container"><button id="toggle-all-audio">全部靜音</button></div><div id="multi-stream-container"></div></body></html>';
const mainHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

function optional(t) {
    if (unavailable) { t.skip(unavailable); return false; }
    return true;
}

async function fixture(html = siteHtml, initialUrl = siteUrl) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const navigationRequests = new Map();
    const blocked = [];
    await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (request.isNavigationRequest()) {
            navigationRequests.set(request.url(), (navigationRequests.get(request.url()) || 0) + 1);
            if (request.url() === initialUrl) return route.fulfill({ contentType: 'text/html', body: html });
            if (request.url() === playerUrl || request.url() === unknownUrl) return route.fulfill({ contentType: 'text/html', body: playerHtml });
        }
        if (url.pathname === '/silent.wav' && [siteOrigin, new URL(playerUrl).origin, new URL(unknownUrl).origin].includes(url.origin)) {
            return route.fulfill({ contentType: 'audio/wav', body: wav, headers: { 'Accept-Ranges': 'bytes' } });
        }
        blocked.push(request.url());
        return route.abort();
    });
    // Inject on every frame, then let the production runtime perform its own
    // origin/role checks. Running at DOMContentLoaded models document-idle.
    await context.addInitScript({ content: `
        window.fixtureMessages = [];
        addEventListener('message', event => {
            if (event.data && event.data.channel === ${JSON.stringify(channel)})
                fixtureMessages.push({ origin: event.origin, ...event.data });
        });
        addEventListener('DOMContentLoaded', () => {\n${script}\n}, { once: true });
    ` });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(initialUrl, { waitUntil: 'domcontentloaded' });
    return { context, page, navigationRequests, blocked };
}

async function addPlayers(page, includeUnknown = false) {
    await page.evaluate(({ playerUrl, unknownUrl, includeUnknown }) => {
        const container = document.getElementById('multi-stream-container');
        const native = document.createElement('video');
        native.id = 'native-video'; native.muted = true; native.loop = true;
        native.src = '/silent.wav'; native.style.cssText = 'display:block;width:280px;height:160px';
        const frame = document.createElement('iframe');
        frame.id = 'cross-origin-player'; frame.src = playerUrl;
        frame.allow = 'autoplay'; frame.style.cssText = 'display:block;width:300px;height:180px';
        container.replaceChildren(native, frame);
        if (includeUnknown) {
            const unknown = frame.cloneNode();
            unknown.id = 'unknown-player'; unknown.src = unknownUrl;
            container.appendChild(unknown);
        }
    }, { playerUrl, unknownUrl, includeUnknown });
    await page.waitForSelector('#umininn-player-control-host');
    await page.waitForFunction(() => document.getElementById('native-video').readyState >= 2);
    await page.waitForFunction(() => {
        const rows = document.getElementById('umininn-player-panel-host')?.shadowRoot.querySelectorAll('.player');
        return rows?.length >= 2 && [...rows].slice(0, 2).every(row => !row.querySelector('input').disabled);
    });
    await page.locator('#umininn-player-control-host #toggle').click();
    return page.frames().find(frame => frame.url() === playerUrl);
}

async function setVolume(locator, value) {
    await locator.page().waitForFunction(input => !input.disabled, await locator.elementHandle());
    await locator.evaluate((input, value) => {
        input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
}

async function frameAt(page, url) {
    return page.frames().find(frame => frame.url() === url) ||
        page.waitForEvent('framenavigated', { predicate: frame => frame.url() === url });
}

async function mediaState(frame, id) {
    return frame.locator(id).evaluate(video => ({ volume: video.volume, muted: video.muted, paused: video.paused, source: video.currentSrc }));
}

async function untilMedia(frame, selector, expected) {
    await frame.waitForFunction(({ selector, expected }) => {
        const video = document.querySelector(selector);
        return video && Object.entries(expected).every(([key, value]) => typeof value === 'number'
            ? Math.abs(video[key] - value) < 0.001 : video[key] === value);
    }, { selector, expected });
}

test('standalone userscript controls native and cross-origin media, restores playback, and never reloads players', { skip: !enabled, timeout: 45000 }, async t => {
    if (!optional(t)) return;
    const { context, page, navigationRequests } = await fixture();
    try {
        const frame = await addPlayers(page);
        assert.ok(frame, 'The cross-origin frame was loaded.');
        const rows = page.locator(panel + ' .player');
        assert.equal(await rows.count(), 2);
        const initialNavigations = new Map(navigationRequests);
        const nativeSource = (await mediaState(page, '#native-video')).source;
        const frameSource = (await mediaState(frame, 'video')).source;

        await setVolume(rows.nth(0).locator('input'), 24);
        await untilMedia(page, '#native-video', { volume: 0.24 });
        await untilMedia(frame, 'video', { volume: 1 });
        await setVolume(rows.nth(1).locator('input'), 37);
        await untilMedia(frame, 'video', { volume: 0.37 });
        await untilMedia(page, '#native-video', { volume: 0.24 });

        await rows.nth(1).getByRole('button', { name: '開聲', exact: true }).click();
        await untilMedia(frame, 'video', { muted: false });
        await untilMedia(page, '#native-video', { muted: true });
        await setVolume(page.locator(panel).getByLabel('全部播放器音量'), 61);
        await untilMedia(page, '#native-video', { volume: 0.61 });
        await untilMedia(frame, 'video', { volume: 0.61 });

        await page.locator(panel).getByRole('button', { name: '全部開聲', exact: true }).click();
        await untilMedia(page, '#native-video', { muted: false });
        await untilMedia(frame, 'video', { muted: false });
        // Exercise the real website audio button interception too.
        await page.locator('#toggle-all-audio').click();
        await untilMedia(page, '#native-video', { muted: true });
        await untilMedia(frame, 'video', { muted: true });

        await rows.nth(0).getByRole('button', { name: '恢復播放', exact: true }).click();
        await untilMedia(page, '#native-video', { paused: false });
        await rows.nth(1).getByRole('button', { name: '恢復播放', exact: true }).click();
        await untilMedia(frame, 'video', { paused: false });
        assert.equal((await mediaState(page, '#native-video')).source, nativeSource);
        assert.equal((await mediaState(frame, 'video')).source, frameSource);
        assert.deepEqual(navigationRequests, initialNavigations, 'Sound and recovery controls do not navigate the site or iframe.');
        assert.ok(await page.evaluate(() => fixtureMessages.some(message => message.type === 'frame:ready' && message.origin === 'https://player.kick.com')), 'Discovery used a genuine cross-origin postMessage.');

        await page.addScriptTag({ content: script });
        assert.equal(await page.locator('#umininn-player-control-host').count(), 1, 'Reinjecting the script keeps one toolbar.');
        assert.equal(await page.locator('#umininn-player-panel-host').count(), 1, 'Reinjecting the script keeps one panel.');
    } finally { await context.close(); }
});

test('removing and recreating a cross-origin player establishes a fresh connection', { skip: !enabled, timeout: 30000 }, async t => {
    if (!optional(t)) return;
    const { context, page } = await fixture();
    try {
        await addPlayers(page);
        const oldToken = await page.evaluate(() => fixtureMessages.filter(message => message.type === 'frame:ready').at(-1).token);
        await page.locator('#cross-origin-player').evaluate(frame => frame.remove());
        await page.waitForFunction(() => document.getElementById('umininn-player-panel-host').shadowRoot.querySelectorAll('.player').length === 1);
        await page.evaluate(playerUrl => {
            const frame = document.createElement('iframe');
            frame.id = 'cross-origin-player'; frame.src = playerUrl; frame.allow = 'autoplay';
            frame.style.cssText = 'display:block;width:300px;height:180px';
            document.getElementById('multi-stream-container').appendChild(frame);
        }, playerUrl);
        await page.waitForFunction(oldToken => fixtureMessages.some(message => message.type === 'frame:ready' && message.token !== oldToken), oldToken);
        const row = page.locator(panel + ' .player').nth(1);
        await row.locator('input:enabled').waitFor();
        await setVolume(row.locator('input'), 43);
        const frame = page.frames().find(frame => frame.url() === playerUrl);
        await untilMedia(frame, 'video', { volume: 0.43 });
        await untilMedia(page, '#native-video', { volume: 1 });
    } finally { await context.close(); }
});

test('unknown frames, unrelated top pages, and an unapproved parent do not gain controls', { skip: !enabled, timeout: 30000 }, async t => {
    if (!optional(t)) return;
    const first = await fixture();
    try {
        await addPlayers(first.page, true);
        const row = first.page.locator(panel + ' .player').nth(2);
        assert.equal(await row.locator('input').isDisabled(), true);
        const unknown = await frameAt(first.page, unknownUrl);
        await unknown.waitForSelector('video');
        assert.equal((await mediaState(unknown, 'video')).volume, 1);
        assert.equal(await first.page.evaluate(() => fixtureMessages.some(message => message.origin === 'https://unapproved.invalid')), false);
        // A sibling frame knows the announced identity but is still not the
        // approved direct parent. It cannot take over the command session.
        const identity = await first.page.evaluate(() => {
            const message = fixtureMessages.find(message => message.type === 'frame:ready');
            return { frameId: message.frameId, token: message.token, documentId: message.documentId };
        });
        await unknown.evaluate(({ identity, channel }) => {
            parent.frames[0].postMessage({ ...identity, channel, version: 1, type: 'userscript:command',
                requestId: 'a'.repeat(48) + '_1', sessionId: 'b'.repeat(48), sequence: 1,
                command: { action: 'setVolume', value: 0.02 } }, 'https://player.kick.com');
        }, { identity, channel });
        await new Promise(resolve => setTimeout(resolve, 150));
        const approved = first.page.frames().find(frame => frame.url() === playerUrl);
        assert.equal((await mediaState(approved, 'video')).volume, 1, 'A captured identity does not authorize a sibling origin.');
        await setVolume(first.page.locator(panel + ' .player').nth(1).locator('input'), 48);
        await untilMedia(approved, 'video', { volume: 0.48 });
    } finally { await first.context.close(); }

    const topPlayer = await fixture(playerHtml, playerUrl);
    try {
        assert.equal(await topPlayer.page.locator('#umininn-player-control-host').count(), 0);
        assert.equal(await topPlayer.page.evaluate(() => fixtureMessages.length), 0);
        assert.equal((await mediaState(topPlayer.page, 'video')).volume, 1);
    } finally { await topPlayer.context.close(); }

    const attacker = await fixture(siteHtml + `<iframe id="target" src="${playerUrl}" style="width:300px;height:180px"></iframe>`, 'https://attacker.invalid/');
    try {
        await attacker.page.waitForLoadState('load');
        const target = attacker.page.frames().find(frame => frame.url() === playerUrl);
        await target.waitForSelector('video');
        await attacker.page.evaluate(channel => {
            document.getElementById('target').contentWindow.postMessage({ channel, version: 1, type: 'frame:probe' }, 'https://player.kick.com');
        }, channel);
        // Allow the genuine message task and the normal reporting debounce to run.
        await new Promise(resolve => setTimeout(resolve, 250));
        assert.equal(await attacker.page.locator('#umininn-player-control-host').count(), 0);
        assert.equal(await attacker.page.evaluate(() => fixtureMessages.filter(message => message.type === 'frame:ready').length), 0);
        assert.equal((await mediaState(target, 'video')).volume, 1);
    } finally { await attacker.context.close(); }
});

test('standalone userscript waits for the production login template and mounts only once', { skip: !enabled, timeout: 30000 }, async t => {
    if (!optional(t)) return;
    const { context, page } = await fixture(mainHtml);
    try {
        assert.equal(await page.locator('#umininn-player-control-host').count(), 0);
        await page.evaluate(() => {
            const template = document.getElementById('tv-app-template');
            document.body.appendChild(template.content.cloneNode(true));
            document.getElementById('login-screen')?.remove();
            document.body.classList.remove('login-locked');
        });
        await page.waitForSelector('#umininn-player-control-host');
        assert.equal(await page.locator('#input-container > #umininn-player-control-host').count(), 1);
        assert.equal(await page.locator('body > #umininn-player-panel-host').count(), 1);
        await page.addScriptTag({ content: script });
        assert.equal(await page.locator('#umininn-player-control-host').count(), 1);
    } finally { await context.close(); }
});
