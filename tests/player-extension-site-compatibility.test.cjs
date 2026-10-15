const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let playwright;
const browserTests = process.env.UMININN_BROWSER_TESTS === '1';
if (browserTests) {
    try { playwright = require('playwright'); }
    catch (_) {
        playwright = require(path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright'));
    }
}

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const config = require('../browser-extension/shared/config.js');
let browser;
test.before(async () => { if (browserTests) browser = await playwright.chromium.launch({ channel: 'msedge', headless: true }); });
test.after(async () => { await browser?.close(); });

async function productionPage(name) {
    const page = await browser.newPage();
    // Use production HTML without starting login, remote media, chat or network work.
    const url = 'https://umininn-gh.github.io/tv/' + name;
    const html = read(name).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    await page.route('**/*', route => route.request().url() === url
        ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: read('browser-extension/shared/config.js') });
    await page.addScriptTag({ content: 'globalThis.module = { exports: {} };\n' + read('browser-extension/site-ui.js') + '\nglobalThis.siteApi = module.exports; delete globalThis.module;' });
    await page.evaluate(() => {
        window.compatibilityEvents = [];
        const factory = {
            createMediaController({ scope }) {
                const media = scope.matches('video,audio') ? scope : scope.querySelector('video,audio');
                const state = () => ({ ok: true, code: 'OK', state: { available: true, volume: media.volume, muted: media.muted,
                    paused: true, readyState: 4, playbackStatus: 'paused', volumeSupported: true, muteSupported: true, recoverSupported: true } });
                return { getState: state, subscribe: () => () => {}, dispose() {},
                    async execute(command) {
                        if (command.action === 'setMuted') media.muted = command.value;
                        if (command.action === 'setVolume') media.volume = command.value;
                        return state();
                    } };
            }
        };
        const recovery = { createRecoveryFlow() { return {
            run({ reason }) {
                compatibilityEvents.push({ type: 'recovery', reason, children: document.getElementById('multi-stream-container').children.length });
                return Promise.resolve();
            }, cancel() {}, dispose() {}
        }; } };
        window.siteController = siteApi.createSiteController({ window, document, config: UmininnConfig,
            runtime: { sendMessage: () => Promise.resolve({ ok: false, code: 'NO_MEDIA' }) }, media: factory, recovery });
        siteController.start();
    });
    return page;
}

async function mountLogin(page) {
    await page.evaluate(() => {
        document.getElementById('login-screen')?.remove();
        document.body.classList.remove('login-locked');
        const template = document.getElementById('tv-app-template');
        if (template) document.body.appendChild(template.content.cloneNode(true));
    });
    await page.waitForSelector('#umininn-player-control-host', { state: 'attached' });
}

for (const name of ['index.html', 'admin.html']) {
    test(`${name}: login/template mounting and the actual Start Watching control stay compatible`, { skip: !browserTests }, async () => {
        const page = await productionPage(name);
        try {
            if (name === 'index.html') {
                assert.equal(await page.locator('#umininn-player-control-host').count(), 0, 'the extension waits for login-mounted DOM');
                await mountLogin(page);
            }
            await page.waitForSelector('#umininn-player-control-host', { state: 'attached' });
            assert.deepEqual(await page.evaluate(() => ({
                toolbar: document.getElementById('umininn-player-control-host').parentElement.id,
                panelParent: document.getElementById('umininn-player-panel-host').parentElement.tagName,
                startRecognized: siteApi.isWatchStartTarget(document.querySelector('#channel-selection button[onclick="watchSelectedChannels()"]')),
                audioControlPresent: Boolean(document.getElementById('toggle-all-audio'))
            })), { toolbar: 'input-container', panelParent: 'BODY', startRecognized: true, audioControlPresent: true });

            await page.evaluate(() => {
                window.watchSelectedChannels = () => {
                    const video = document.createElement('video');
                    document.getElementById('multi-stream-container').replaceChildren(video);
                    compatibilityEvents.push({ type: 'selection' });
                };
                document.querySelector('#channel-selection button[onclick="watchSelectedChannels()"] ').click();
            });
            await page.waitForFunction(() => compatibilityEvents.some(event => event.type === 'recovery'));
            assert.deepEqual(await page.evaluate(() => compatibilityEvents), [
                { type: 'selection' }, { type: 'recovery', reason: 'start', children: 1 }
            ], 'recovery runs after the real page selection handler');

            if (name === 'index.html') {
                await page.evaluate(() => {
                    window.selectAllChannelSelection = () => compatibilityEvents.push({ type: 'select-all' });
                    window.clearAllChannelSelection = () => compatibilityEvents.push({ type: 'clear' });
                    document.getElementById('select-all-channels').click();
                    document.getElementById('deselect-all-channels').click();
                });
                await page.waitForTimeout(30);
                assert.deepEqual(await page.evaluate(() => compatibilityEvents.slice(2)), [{ type: 'select-all' }, { type: 'clear' }]);
            }
        } finally {
            await page.evaluate(() => siteController.dispose());
            await page.close();
        }
    });
}

for (const admin of [false, true]) {
    test(`${admin ? 'admin' : 'main'}: actual postMessage preference reaches the page from both global audio controls`, { skip: !browserTests }, async () => {
        const page = await productionPage(admin ? 'admin.html' : 'index.html');
        try {
            await mountLogin(page);
            await page.addScriptTag({ content: read('channel-list.js') });
            await page.addScriptTag({ content: read('stream-performance.js') });
            await page.addScriptTag({ content: `window.Hls = class {
                static Events = {MANIFEST_PARSED: 'manifest', ERROR: 'error'};
                static isSupported() { return true; }
                on() {} loadSource() {} attachMedia() {} destroy() {}
            };` });
            let source = read(admin ? 'admin.html' : 'tv-app.js');
            source = admin
                ? source.slice(source.indexOf('        // ======================== 全域變數'), source.indexOf('        // ======================== 載入 Twitch 憑證'))
                : source.slice(0, source.indexOf('/* =============== 頻道儲存 / 載入'));
            await page.addScriptTag({ content: source });
            await page.evaluate(admin => {
                window.testChannels = ['first', 'second'].map(name => ({ name, platform: 'm3u8', id: `https://example.com/${name}.m3u8` }));
                if (admin) renderAdminChannels(testChannels, 'empty'); else syncActivePlayers(testChannels);
                siteController.scan();
                window.retainedVideo = document.querySelector('#multi-stream-container video');
                retainedVideo.volume = 0.27;
                const panel = document.getElementById('umininn-player-panel-host').shadowRoot;
                [...panel.querySelectorAll('button')].find(button => button.textContent === '全部靜音').click();
            }, admin);
            await page.waitForFunction(admin => admin ? getAdminGlobalMuted() === true : getGlobalMuted() === true, admin);
            assert.equal(await page.evaluate(() => retainedVideo.muted), true);
            await page.evaluate(admin => {
                if (admin) renderAdminChannels(testChannels.slice(0, 1), 'empty'); else syncActivePlayers(testChannels.slice(0, 1));
                siteController.scan();
            }, admin);
            assert.deepEqual(await page.evaluate(() => ({ retained: retainedVideo === document.querySelector('#multi-stream-container video'),
                muted: retainedVideo.muted, volume: retainedVideo.volume, paused: retainedVideo.paused })),
            { retained: true, muted: true, volume: 0.27, paused: true });
            await page.evaluate(() => document.getElementById('toggle-all-audio').click());
            await page.waitForFunction(admin => admin ? getAdminGlobalMuted() === false : getGlobalMuted() === false, admin);
            assert.equal(await page.evaluate(() => retainedVideo.muted), false);
        } finally {
            await page.evaluate(() => siteController.dispose());
            await page.close();
        }
    });
}

test('only current player pages are authorized; the channel manager needs no player injection', () => {
    for (const path of ['/tv/', '/tv/index.html', '/tv/admin.html']) {
        assert.equal(config.isSiteUrl('https://umininn-gh.github.io' + path), true);
        assert.equal(config.isSiteUrl('https://umininn-gh.github.io' + path + '?test=1#view'), true);
    }
    assert.equal(config.isSiteUrl('https://umininn-gh.github.io/tv/channel-manager.html'), false);
    assert.doesNotMatch(read('channel-manager.html'), /<(?:iframe|video|audio)\b/i);
});
