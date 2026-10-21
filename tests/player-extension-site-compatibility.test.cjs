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
const migratedPlayerPage = fs.existsSync(path.join(root, 'site/player/index.html'));
const adminPage = migratedPlayerPage ? 'player/index.html' : 'admin.html';
function read(name) {
    // The release checkout keeps the current public root paths while the
    // workspace's separate directory migration lives under site/.
    const legacy = name.startsWith('site/assets/js/') ? name.slice('site/assets/js/'.length)
        : name === 'site/player/index.html' ? 'admin.html'
        : name === 'site/manage/index.html' ? 'channel-manager.html'
        : name.startsWith('site/') ? name.slice('site/'.length) : name;
    const filename = [name, legacy].map(candidate => path.join(root, candidate)).find(candidate => fs.existsSync(candidate));
    assert.ok(filename, 'production source exists: ' + name);
    return fs.readFileSync(filename, 'utf8');
}
const config = require('../browser-extension/shared/config.js');
const engine = process.env.UMININN_BROWSER_ENGINE || 'chromium';
let browser;
test.before(async () => {
    if (!browserTests) return;
    assert.ok(['chromium', 'firefox'].includes(engine));
    const executablePath = process.env.UMININN_BROWSER_EXECUTABLE;
    const launch = executablePath ? { executablePath } : engine === 'chromium' ? { channel: 'msedge' } : {};
    browser = await playwright[engine].launch({ headless: true, ...launch });
});
test.after(async () => { await browser?.close(); });

async function productionPage(name) {
    const page = await browser.newPage();
    // Use production HTML without starting login, remote media, chat or network work.
    const url = 'https://umininn-gh.github.io/tv/' + name;
    const html = read('site/' + name).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    await page.route('**/*', route => route.request().url() === url
        ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: read('browser-extension/shared/config.js') });
    await page.addScriptTag({ content: 'globalThis.module = { exports: {} };\n' + read('browser-extension/site-ui.js') + '\nglobalThis.siteApi = module.exports; delete globalThis.module;' });
    await page.evaluate(() => {
        window.compatibilityEvents = [];
        window.compatibilityCommands = [];
        window.compatibilityCancellations = 0;
        const factory = {
            createMediaController({ scope }) {
                const media = scope.matches('video,audio') ? scope : scope.querySelector('video,audio');
                const state = () => ({ ok: true, code: 'OK', state: { available: true, volume: media.volume, muted: media.muted,
                    paused: true, readyState: 4, playbackStatus: 'paused', volumeSupported: true, muteSupported: true, recoverSupported: true } });
                return { getState: state, subscribe: () => () => {}, dispose() {},
                    async execute(command) {
                        compatibilityCommands.push({ action: command.action, value: command.value });
                        if (command.action === 'setMuted' && window.compatibilityAudioGate) {
                            const gate = window.compatibilityAudioGate;
                            gate.started++;
                            await gate.promise;
                        }
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
            }, cancel() { compatibilityCancellations++; }, dispose() {}
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

for (const name of ['index.html', adminPage]) {
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

async function mountedMainPage() {
    const page = await productionPage('index.html');
    await mountLogin(page);
    return page;
}

async function assertNoScheduledRecovery(page) {
    // Cross a new task boundary: the production layout hook schedules at 0 ms.
    await page.waitForTimeout(40);
    assert.equal(await page.evaluate(() => compatibilityEvents.filter(event => event.type === 'recovery').length), 0);
}

test('bookmark restoration schedules one recovery after the completed layout, with rapid restores using only the latest panes', { skip: !browserTests }, async () => {
    const page = await mountedMainPage();
    try {
        const immediate = await page.evaluate(() => {
            const pane = document.getElementById('multi-stream-container');
            for (const count of [1, 2, 3]) {
                pane.replaceChildren(...Array.from({ length: count }, () => document.createElement('video')));
                pane.dispatchEvent(new Event('umininn-player-bookmark-restored', { bubbles: true }));
            }
            const beforeReturn = compatibilityEvents.length;
            compatibilityEvents.push({ type: 'layout-complete', children: pane.children.length });
            return beforeReturn;
        });
        assert.equal(immediate, 0, 'the restore call finishes before recovery starts');
        await page.waitForFunction(() => compatibilityEvents.some(event => event.type === 'recovery'));
        await page.waitForTimeout(40);
        assert.deepEqual(await page.evaluate(() => compatibilityEvents), [
            { type: 'layout-complete', children: 3 },
            { type: 'recovery', reason: 'bookmark', children: 3 }
        ]);
    } finally {
        await page.evaluate(() => siteController.dispose());
        await page.close();
    }
});

test('bookmark recovery rejects descendant, unrelated and obsolete pane event targets', { skip: !browserTests }, async () => {
    const page = await mountedMainPage();
    try {
        await page.evaluate(() => {
            const pane = document.getElementById('multi-stream-container');
            const child = document.createElement('video');
            pane.replaceChildren(child);
            child.dispatchEvent(new Event('umininn-player-bookmark-restored', { bubbles: true }));
            document.body.dispatchEvent(new Event('umininn-player-bookmark-restored', { bubbles: true }));
            document.dispatchEvent(new Event('umininn-player-bookmark-restored', { bubbles: true }));
            pane.id = 'obsolete-player-pane';
            const current = document.createElement('div');
            current.id = 'multi-stream-container';
            pane.after(current);
            pane.dispatchEvent(new Event('umininn-player-bookmark-restored', { bubbles: true }));
        });
        await assertNoScheduledRecovery(page);
        await page.evaluate(() => document.getElementById('multi-stream-container')
            .dispatchEvent(new Event('umininn-player-bookmark-restored', { bubbles: true })));
        await page.waitForFunction(() => compatibilityEvents.some(event => event.type === 'recovery'));
        assert.deepEqual(await page.evaluate(() => compatibilityEvents), [{ type: 'recovery', reason: 'bookmark', children: 0 }]);
    } finally {
        await page.evaluate(() => siteController.dispose());
        await page.close();
    }
});

test('a manual detection supersedes a scheduled bookmark recovery without running both', { skip: !browserTests }, async () => {
    const page = await mountedMainPage();
    try {
        await page.evaluate(() => {
            const pane = document.getElementById('multi-stream-container');
            pane.replaceChildren();
            pane.dispatchEvent(new Event('umininn-player-bookmark-restored', { bubbles: true }));
            document.getElementById('umininn-player-control-host').shadowRoot.getElementById('quick-recover').click();
        });
        await page.waitForFunction(() => compatibilityEvents.some(event => event.type === 'recovery'));
        await page.waitForTimeout(40);
        assert.deepEqual(await page.evaluate(() => compatibilityEvents), [{ type: 'recovery', reason: 'manual', children: 0 }]);
    } finally {
        await page.evaluate(() => siteController.dispose());
        await page.close();
    }
});

test('a newer audio focus cancels bookmark recovery even after its task is waiting for an earlier audio command', { skip: !browserTests, timeout: 30000 }, async () => {
    const page = await mountedMainPage();
    try {
        await page.evaluate(() => {
            const pane = document.getElementById('multi-stream-container');
            const video = document.createElement('video');
            pane.replaceChildren(video);
            siteController.scan();
            const gate = { started: 0 };
            gate.promise = new Promise(resolve => {
                window.releaseCompatibilityAudio = () => { window.compatibilityAudioGate = null; resolve(); };
            });
            window.compatibilityAudioGate = gate;
            video.dispatchEvent(new Event('umininn-player-audio-focus', { bubbles: true }));
        });
        await page.waitForFunction(() => compatibilityAudioGate.started > 0);
        await page.evaluate(() => document.getElementById('multi-stream-container')
            .dispatchEvent(new Event('umininn-player-bookmark-restored', { bubbles: true })));
        await assertNoScheduledRecovery(page);
        await page.evaluate(() => {
            document.querySelector('#multi-stream-container video')
                .dispatchEvent(new Event('umininn-player-audio-focus', { bubbles: true }));
            releaseCompatibilityAudio();
        });
        await page.waitForFunction(() => compatibilityCommands.filter(command => command.action === 'setMuted').length >= 2);
        await assertNoScheduledRecovery(page);
    } finally {
        await page.evaluate(() => { window.releaseCompatibilityAudio?.(); siteController.dispose(); });
        await page.close();
    }
});

for (const lifecycle of ['pagehide', 'dispose']) {
    test(`${lifecycle} cancels pending bookmark recovery and leaves no stale scheduled work`, { skip: !browserTests }, async () => {
        const page = await mountedMainPage();
        try {
            await page.evaluate(lifecycle => {
                const pane = document.getElementById('multi-stream-container');
                pane.dispatchEvent(new Event('umininn-player-bookmark-restored', { bubbles: true }));
                if (lifecycle === 'pagehide') window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
                else siteController.dispose();
            }, lifecycle);
            await assertNoScheduledRecovery(page);
            if (lifecycle === 'dispose') {
                await page.evaluate(() => document.getElementById('multi-stream-container')
                    .dispatchEvent(new Event('umininn-player-bookmark-restored', { bubbles: true })));
                await assertNoScheduledRecovery(page);
            }
        } finally {
            await page.evaluate(() => siteController.dispose());
            await page.close();
        }
    });
}

for (const admin of [false, true]) {
    test(`${admin ? 'admin' : 'main'}: actual postMessage preference reaches the page from both global audio controls`, { skip: !browserTests }, async () => {
        const page = await productionPage(admin ? adminPage : 'index.html');
        try {
            await mountLogin(page);
            await page.addScriptTag({ content: read('site/assets/js/channel-list.js') });
            await page.addScriptTag({ content: read('site/assets/js/stream-performance.js') });
            await page.addScriptTag({ content: read('site/assets/js/player-layout.js') });
            await page.addScriptTag({ content: `window.Hls = class {
                static Events = {MANIFEST_PARSED: 'manifest', ERROR: 'error'};
                static isSupported() { return true; }
                on() {} loadSource() {} attachMedia() {} destroy() {}
            };` });
            let source = read(admin ? 'site/player/index.html' : 'site/assets/js/tv-app.js');
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
    for (const playerPath of ['/tv/player/', '/tv/player/index.html']) {
        assert.equal(config.isSiteUrl('https://umininn-gh.github.io' + playerPath), migratedPlayerPage);
        assert.equal(config.isSiteUrl('https://umininn-gh.github.io' + playerPath + '?test=1#view'), migratedPlayerPage);
    }
    assert.equal(config.isSiteUrl('https://umininn-gh.github.io/tv/channel-manager.html'), false);
    assert.equal(config.isSiteUrl('https://umininn-gh.github.io/tv/manage/'), false);
    assert.equal(config.isSiteUrl('https://umininn-gh.github.io/tv/chat/'), false);
    assert.doesNotMatch(read('site/manage/index.html'), /<(?:iframe|video|audio)\b/i);
});
