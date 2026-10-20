'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Real browser input and time: use the production panel HTML/CSS, timer,
// selection controls and watch command. Status providers and player rendering
// are closed boundaries, so this test never contacts a streaming service.
const enabled = process.env.UMININN_BROWSER_TESTS === '1';
const engine = process.env.UMININN_BROWSER_ENGINE || 'chromium';
const root = path.resolve(__dirname, '..');
const siteUrl = 'https://umininn-gh.github.io/tv/';
const browserCase = { skip: !enabled, timeout: 20000 };
let browser;

function readPage(migrated, legacy) {
    const target = path.join(root, migrated);
    return fs.readFileSync(fs.existsSync(target) ? target : path.join(root, legacy), 'utf8');
}

function productionFunction(source, name) {
    const expression = new RegExp('^([ \\t]*)function ' + name + '\\([^]*?\\n\\1}', 'm');
    const match = source.match(expression);
    assert.ok(match, 'reviewed production function exists: ' + name);
    return match[0];
}

function productionPanel(html) {
    const start = html.indexOf('<div id="channel-selection"');
    const end = html.indexOf('<div id="multi-stream-container-wrapper"', start);
    assert.ok(start >= 0 && end > start, 'reviewed production panel HTML seam exists');
    return html.slice(start, end);
}

function productionTimer(source) {
    const start = source.indexOf('const channelSelectionIdleTimer =');
    const end = source.indexOf('function setChannelSelectionVisible(', start);
    assert.ok(start >= 0 && end > start, 'reviewed production timer seam exists');
    const timeoutSetting = source.match(/^const PLAYER_OVERLAY_TIMEOUT_SECONDS = \d+;/m)?.[0] || '';
    return timeoutSetting + '\n' + source.slice(start, end) + '\n' + productionFunction(source, 'setChannelSelectionVisible');
}

const pages = [
    {
        name: 'main viewing page', main: true,
        html: readPage('site/index.html', 'index.html'),
        source: readPage('site/assets/js/tv-app.js', 'tv-app.js')
    },
    {
        name: 'alternate viewing page', main: false,
        html: readPage('site/player/index.html', 'admin.html'),
        source: readPage('site/player/index.html', 'admin.html')
    }
];

test.before(async () => {
    if (!enabled) return;
    assert.ok(['chromium', 'firefox'].includes(engine));
    let playwright;
    try { playwright = require('playwright'); }
    catch (_) {
        playwright = require(path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright'));
    }
    const executablePath = process.env.UMININN_BROWSER_EXECUTABLE;
    const candidates = engine === 'firefox' || executablePath
        ? [{ headless: true, ...(executablePath ? { executablePath } : {}) }]
        : [{ headless: true }, { channel: 'msedge', headless: true }];
    const errors = [];
    for (const options of candidates) {
        // Deterministic wheel delivery avoids platform-specific smooth-scroll
        // animations introducing activity after the trusted wheel gesture.
        const scrolling = engine === 'firefox'
            ? { firefoxUserPrefs: { 'general.smoothScroll': false } }
            : { args: ['--disable-smooth-scrolling'] };
        try { browser = await playwright[engine].launch({ ...options, ...scrolling }); break; }
        catch (error) { errors.push(error.message); }
    }
    assert.ok(browser, 'Explicit browser QA must launch a browser, not silently skip: ' + errors.join('\n'));
    console.log(`Channel selection inactivity fixture: ${engine} ${browser.version()} (production selection seams; no live platform).`);
});

test.after(async () => { await browser?.close(); });

async function fixture(t, entry) {
    const css = [...entry.html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]).join('\n');
    const names = entry.main
        ? ['getPlatform', 'platformIcon', 'applyStatusClass', 'updateChannelSelectionSummary', 'createChannelOptionControl',
            'generateChannelOptions', 'updateChannelOptionLabel', 'toggleChannelSelection', 'watchSelectedChannels']
        : ['channelStatusKey', 'channelDomId', 'updateChannelOptionLabel', 'generateChannelOptions', 'toggleChannelSelection', 'watchSelectedChannels'];
    const production = productionTimer(entry.source) + '\n' + names.map(name => productionFunction(entry.source, name)).join('\n');
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, serviceWorkers: 'block' });
    t.after(() => context.close());
    const requests = [];
    await context.route('**/*', route => {
        if (route.request().url() === siteUrl && route.request().isNavigationRequest()) {
            return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>${css}</style></head><body>
                <button id="open-selection" onclick="toggleChannelSelection()" style="position:fixed;top:10px;left:10px;z-index:3000">看更台</button>
                <input id="outside" style="position:fixed;bottom:20px;left:20px;z-index:3000" aria-label="Outside panel">
                ${productionPanel(entry.html)}
                <div id="multi-stream-container"><video id="existing-player" muted></video></div>
                <div id="name-overlay" hidden>Existing player name</div>
                <script>
                const channels = Array.from({length: 36}, (_, index) => ({id:'fixture-'+index,platform:'m3u8',name:'本地頻道 '+index}));
                const ChannelList = {channelKey: channel => channel.platform + '_' + channel.id};
                const activePlayers = new Map([[ChannelList.channelKey(channels[0]), {element:document.getElementById('existing-player')}]]);
                const adminPlayers = activePlayers;
                const channelStatuses = Object.fromEntries(channels.map(channel => [ChannelList.channelKey(channel), 'live']));
                const channelOptionControls = new Map(); let channelOptionSequence = 0;
                const PLATFORMS = {m3u8:{icon:'📺'}};
                const playerNameOverlay = {setVisible(value) {document.getElementById('name-overlay').hidden = !value}};
                const layoutBookmarkMenu = null;
                window.fixture = {applied:0,statusRefreshes:0,playerActions:0,initialPlayer:document.getElementById('existing-player'),initialEntry:activePlayers.values().next().value};
                for (const method of ['play','pause','load']) fixture.initialPlayer[method] = () => {fixture.playerActions++; return Promise.resolve()};
                function syncActivePlayers(){fixture.applied++}
                function renderAdminChannels(){fixture.applied++}
                function fetchAllStatuses(){fixture.statusRefreshes++}
                ${production}
                fixture.backgroundRefresh = () => {
                    for(const channel of channels) {channelStatuses[ChannelList.channelKey(channel)] = 'not-live';updateChannelOptionLabel(channel)}
                    ${entry.main ? 'generateChannelOptions({preserveSelection:true});' : ''}
                };
                fixture.identity = () => ({samePlayer:fixture.initialPlayer === document.getElementById('existing-player'),
                    connected:fixture.initialPlayer.isConnected,sameEntry:activePlayers.values().next().value === fixture.initialEntry,
                    count:activePlayers.size,applied:fixture.applied,playerActions:fixture.playerActions});
                </script></body></html>` });
        }
        requests.push(route.request().url());
        return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(siteUrl, { waitUntil: 'domcontentloaded' });
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
    // Install after the browser clock, which replaces window.setTimeout.
    // Observe its deadline without changing callbacks or scheduling behavior.
    await page.evaluate(() => {
        const clockSetTimeout = window.setTimeout.bind(window);
        window.setTimeout = (callback, delay, ...args) => {
            if (delay === 30000) fixture.idleDeadline = Date.now() + delay;
            return clockSetTimeout(callback, delay, ...args);
        };
    });
    t.after(async () => {
        assert.deepEqual(errors, [], 'no page errors');
        assert.deepEqual(requests, [], 'all content stays inside the local browser fixture');
    });
    return page;
}

async function open(page, main) {
    await page.locator('#open-selection').click({ force: true });
    assert.equal(await page.locator('#channel-selection').isVisible(), true);
    if (main) assert.equal(await page.locator('#name-overlay').isVisible(), true);
}

async function assertClosedAndUnchanged(page, main) {
    assert.equal(await page.locator('#channel-selection').isVisible(), false);
    if (main) assert.equal(await page.locator('#name-overlay').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => fixture.identity()), {
        samePlayer:true,connected:true,sameEntry:true,count:1,applied:0,playerActions:0
    }, 'timeout must not apply a draft, recreate players, or invoke playback methods');
}

for (const entry of pages) {
    test(`${entry.name}: selection stays open through 29,999 ms and closes at 30,000 ms`, browserCase, async t => {
        const page = await fixture(t, entry);
        await open(page, entry.main);
        await page.clock.fastForward(29999);
        assert.equal(await page.locator('#channel-selection').isVisible(), true);
        await page.clock.fastForward(1);
        await assertClosedAndUnchanged(page, entry.main);
    });

    for (const activity of ['pointer movement', 'wheel', 'keyboard', 'checkbox']) {
        test(`${entry.name}: trusted ${activity} at 29 s restarts the complete 30-second idle period`, browserCase, async t => {
            const page = await fixture(t, entry);
            await open(page, entry.main);
            await page.clock.fastForward(29000);
            const target = page.locator('#channel-options label').nth(1);
            const eventType = {'pointer movement':'pointermove',wheel:'wheel',keyboard:'keydown',checkbox:'change'}[activity];
            const delivered = page.evaluate(type => new Promise(resolve => {
                document.getElementById('channel-selection').addEventListener(type, event => resolve(event.isTrusted), {capture:true,once:true});
            }), eventType);
            if (activity === 'pointer movement' || activity === 'wheel') {
                const box = await target.boundingBox();
                await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                if (activity === 'wheel') await page.mouse.wheel(0, 100);
            } else if (activity === 'keyboard') {
                await page.locator('#channel-options input').nth(1).focus();
                await page.keyboard.press('Space');
            } else {
                await target.click({force:true});
            }
            assert.equal(await delivered, true, 'activity comes from actual browser input');
            // Let the browser deliver any native scroll generated by wheel or
            // keyboard before measuring from the last real operation.
            await page.clock.runFor(50);
            await page.clock.fastForward(1000);
            assert.equal(await page.locator('#channel-selection').isVisible(), true, 'original opening deadline was cancelled');
            const remaining = await page.evaluate(() => fixture.idleDeadline - Date.now());
            assert.ok(remaining >= 28950 && remaining <= 29000, 'a complete new 30 seconds was scheduled after the trusted operation');
            await page.clock.fastForward(remaining - 1);
            assert.equal(await page.locator('#channel-selection').isVisible(), true);
            await page.clock.fastForward(1);
            await assertClosedAndUnchanged(page, entry.main);
        });
    }

    test(`${entry.name}: background scrolling immediately after a genuine key does not move its deadline`, browserCase, async t => {
        const page = await fixture(t, entry);
        await open(page, entry.main);
        await page.clock.fastForward(29000);
        await page.locator('#channel-options input').nth(1).focus();
        await page.keyboard.press('Space');
        const deadline = await page.evaluate(() => fixture.idleDeadline);
        await page.clock.fastForward(1000);
        await page.evaluate(() => {
            fixture.backgroundRefresh();
            document.getElementById('channel-selection').scrollTop = 100;
        });
        await page.clock.runFor(50);
        assert.equal(await page.evaluate(() => fixture.idleDeadline), deadline, 'native background scrolling cannot count as another operation');
        const remaining = await page.evaluate(() => fixture.idleDeadline - Date.now());
        await page.clock.fastForward(remaining - 1);
        assert.equal(await page.locator('#channel-selection').isVisible(), true);
        await page.clock.fastForward(1);
        await assertClosedAndUnchanged(page, entry.main);
    });

    test(`${entry.name}: status refresh, synthetic input, focus and background scroll cannot postpone closing`, browserCase, async t => {
        const page = await fixture(t, entry);
        await open(page, entry.main);
        await page.clock.fastForward(29000);
        await page.evaluate(() => {
            fixture.backgroundRefresh();
            const panel = document.getElementById('channel-selection');
            panel.scrollTop = 100;
            for(const type of ['pointermove','click','keydown','input','change','wheel','scroll']) panel.dispatchEvent(new Event(type,{bubbles:true}));
            document.querySelector('#channel-options input').focus();
        });
        await page.clock.fastForward(999);
        assert.equal(await page.locator('#channel-selection').isVisible(), true);
        await page.clock.fastForward(1);
        await assertClosedAndUnchanged(page, entry.main);
    });

    test(`${entry.name}: closing and reopening clears the first deadline and starts a fresh period`, browserCase, async t => {
        const page = await fixture(t, entry);
        await open(page, entry.main);
        await page.clock.fastForward(29000);
        await page.locator('#open-selection').click({force:true});
        await assertClosedAndUnchanged(page, entry.main);
        await page.clock.fastForward(500);
        await open(page, entry.main);
        await page.clock.fastForward(29999);
        assert.equal(await page.locator('#channel-selection').isVisible(), true);
        await page.clock.fastForward(1);
        await assertClosedAndUnchanged(page, entry.main);
    });

    test(`${entry.name}: outside activity does not count and pagehide cancels a stale timer`, browserCase, async t => {
        const page = await fixture(t, entry);
        await open(page, entry.main);
        await page.clock.fastForward(29000);
        await page.locator('#outside').click({force:true});
        await page.keyboard.type('chatting');
        await page.clock.fastForward(1000);
        await assertClosedAndUnchanged(page, entry.main);
        await open(page, entry.main);
        await page.clock.fastForward(29000);
        await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
        await assertClosedAndUnchanged(page, entry.main);
        await page.clock.fastForward(60000);
        await assertClosedAndUnchanged(page, entry.main);
    });
}
