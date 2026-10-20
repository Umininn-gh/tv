'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const enabled = process.env.UMININN_BROWSER_TESTS === '1';
const engine = process.env.UMININN_BROWSER_ENGINE || 'chromium';
const root = path.resolve(__dirname, '..');
const siteUrl = 'https://umininn-gh.github.io/tv/';
const frameUrl = 'https://menu-hover-player.invalid/player';
const panelHost = '#umininn-player-panel-host';
const panel = panelHost + ' #panel';
const toggle = '#umininn-player-control-host #toggle';
const rows = panelHost + ' .player';
const options = { skip: !enabled, timeout: 25000 };
let browser;

test.before(async () => {
    if (!enabled) return;
    let playwright;
    try { playwright = require('playwright'); }
    catch (_) { playwright = require(path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright')); }
    const executablePath = process.env.UMININN_BROWSER_EXECUTABLE;
    browser = await playwright[engine].launch({ headless: true, ...(executablePath ? { executablePath } : engine === 'chromium' ? { channel: 'msedge' } : {}) });
    console.log(`Playback-menu hover fixture: ${engine} ${browser.version()} (source module, trusted pointer input, routed cross-origin iframe).`);
});
test.after(async () => { await browser?.close(); });

async function fixture(t, extra = {}) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 820 }, serviceWorkers: 'block', ...extra });
    t.after(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
        if (route.request().url() === siteUrl) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><style>
            body{margin:0;background:#111;color:white;font:14px sans-serif}#input-container{height:30px}
            #multi-stream-container{display:flex;flex-wrap:wrap;width:650px;gap:12px;padding:12px}
            #multi-stream-container > *{width:300px;height:190px;display:block;background:#283441;border:0}
            #multi-stream-container video,#multi-stream-container iframe{width:100%;height:100%;border:0;display:block}
            #outside{position:fixed;bottom:5px;left:5px}
            </style></head><body><div id="input-container"></div><div id="multi-stream-container">
            <div id="native" data-channel-key="native-key" data-channel-name="同名台"><video controls muted></video></div>
            <div id="nested" data-channel-key="nested-key" data-channel-name="同名台"><iframe src="${frameUrl}"></iframe></div>
            <video id="direct" data-channel-key="direct-key" data-channel-name="原生" controls muted></video>
            <iframe id="frame" data-channel-key="frame-key" data-channel-name="外站" src="${frameUrl}"></iframe>
            </div><button id="outside">Outside</button></body></html>` });
        if (route.request().url() === frameUrl) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="margin:0;background:#263747;color:white"><button id="inner" style="width:100%;height:190px">Cross origin player</button><script>window.clicks=0;document.addEventListener("click",()=>clicks++);</script>' });
        return route.abort();
    });
    await page.goto(siteUrl, { waitUntil: 'load' });
    const source = fs.readFileSync(path.join(root, 'browser-extension/site-ui.js'), 'utf8');
    await page.addScriptTag({ content: 'globalThis.module={exports:{}};\n' + source + '\nglobalThis.hoverApi=module.exports;delete globalThis.module;' });
    await page.evaluate(() => {
        [...document.getElementById('multi-stream-container').children].forEach((element, index) => element.style.order = String(index));
        window.beforeMedia = [...document.querySelectorAll('#multi-stream-container video,#multi-stream-container iframe')];
        window.beforeSources = beforeMedia.map(element => element.getAttribute('src'));
        window.hoverCommands = [];
        window.hoverController = hoverApi.createSiteController({ window, document,
            config: { isPlayerUrl: () => false }, runtime: { sendMessage: () => Promise.resolve({ ok: false, code: 'unsupported' }) },
            media: { createMediaController({ scope }) {
                const element = scope.matches('video,audio') ? scope : scope.querySelector('video,audio');
                const state = () => ({ ok: true, code: 'OK', state: { available: true, volume: element.volume, muted: element.muted, readyState: 4, playbackStatus: 'paused' } });
                return { getState: state, subscribe: () => () => {}, dispose() {}, execute: async command => { hoverCommands.push(command); return state(); } };
            } }
        });
        hoverController.start();
    });
    await page.locator(rows).nth(3).waitFor({ state: 'attached' });
    t.after(() => assert.deepEqual(errors, [], 'hover and cleanup do not throw browser errors'));
    return page;
}
async function open(page) { await page.locator(toggle).click(); assert.equal(await page.locator(panel).isVisible(), true); }
async function outside(page) { await page.locator('#outside').hover(); }
async function hoverCenter(page, selector) {
    await page.locator(selector).scrollIntoViewIfNeeded();
    const box = await page.locator(selector).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}
async function highlights(page) {
    return page.evaluate(() => ({
        tiles: [...document.querySelectorAll('#multi-stream-container > [data-umininn-controls-highlight]')].map(element => element.id),
        rows: [...document.getElementById('umininn-player-panel-host').shadowRoot.querySelectorAll('.player[data-player-highlighted="true"] strong')].map(element => element.textContent)
    }));
}
async function expectHighlights(page, tiles, names) {
    await page.waitForFunction(expected => {
        const actual = {
            tiles: [...document.querySelectorAll('#multi-stream-container > [data-umininn-controls-highlight]')].map(element => element.id),
            rows: [...document.getElementById('umininn-player-panel-host').shadowRoot.querySelectorAll('.player[data-player-highlighted="true"] strong')].map(element => element.textContent)
        };
        return JSON.stringify(actual) === JSON.stringify(expected);
    }, { tiles, rows: names }, { timeout: 2500 }).catch(async error => {
        error.message += '\nActual highlight state: ' + JSON.stringify(await highlights(page)) + '\nHover: ' + JSON.stringify(await page.evaluate(() => ({
            mouse: matchMedia('(any-hover: hover)').matches,
            tiles: [...document.querySelectorAll('#multi-stream-container > *')].filter(element => element.matches(':hover')).map(element => element.id),
            rows: [...document.getElementById('umininn-player-panel-host').shadowRoot.querySelectorAll('.player')].filter(element => element.matches(':hover')).map(element => element.textContent)
        })));
        throw new Error(error.message);
    });
    assert.deepEqual(await highlights(page), { tiles, rows: names });
}

test('row and child control hover identify the exact player despite duplicate names; outlines preserve geometry and media', options, async t => {
    const page = await fixture(t);
    await open(page);
    const before = await page.locator('#native').boundingBox();
    await page.locator(rows).nth(0).locator('strong').hover();
    await expectHighlights(page, ['native'], ['1. 同名台']);
    assert.equal(await page.locator('#native').evaluate(element => getComputedStyle(element).outlineWidth), '3px');
    assert.deepEqual(await page.locator('#native').boundingBox(), before);
    await page.locator(rows).nth(0).locator('input').hover();
    await expectHighlights(page, ['native'], ['1. 同名台']);
    await page.locator(rows).nth(1).locator('button').first().hover();
    await expectHighlights(page, ['nested'], ['2. 同名台']);
    await outside(page);
    await expectHighlights(page, [], []);
    assert.equal(await page.evaluate(() => beforeMedia.every((element, index) => element.isConnected && element === document.querySelectorAll('#multi-stream-container video,#multi-stream-container iframe')[index] && element.getAttribute('src') === beforeSources[index])), true);
    assert.deepEqual(await page.evaluate(() => hoverCommands), [], 'hovering never issues audio or playback commands');
});

test('trusted native wrapper and direct video hover highlight the matching row; hidden panel publishes no marker', options, async t => {
    const page = await fixture(t);
    await hoverCenter(page, '#native');
    await expectHighlights(page, [], []);
    await open(page);
    await hoverCenter(page, '#native');
    await expectHighlights(page, ['native'], ['1. 同名台']);
    await hoverCenter(page, '#direct');
    await expectHighlights(page, ['direct'], ['3. 原生']);
    await outside(page);
    await expectHighlights(page, [], []);
});

test('keyboard opening resamples a stationary pointer already inside a player', options, async t => {
    const page = await fixture(t);
    await hoverCenter(page, '#native');
    await expectHighlights(page, [], []);
    await page.locator(toggle).focus();
    await page.keyboard.press('Enter');
    await expectHighlights(page, ['native'], ['1. 同名台']);
});

test('layout reordering resamples the row beneath a stationary pointer without carrying the old player highlight', options, async t => {
    const page = await fixture(t);
    await open(page);
    await page.locator(rows).nth(0).locator('strong').hover();
    await expectHighlights(page, ['native'], ['1. 同名台']);
    await page.evaluate(() => { document.getElementById('native').style.order = '8'; hoverController.scan(); });
    await expectHighlights(page, ['nested'], ['1. 同名台']);
});

// Playwright's headless Edge OOPIF pointer input leaves the top document's
// :hover chain empty. Firefox delivers real parent-boundary input for this case.
test('trusted cross-origin iframe center hover reaches outer tile, passes clicks through and survives iframe focus', { ...options, skip: !enabled || engine !== 'firefox' }, async t => {
    const page = await fixture(t);
    await open(page);
    for (const [selector, id, name] of [['#nested', 'nested', '2. 同名台'], ['#frame', 'frame', '4. 外站']]) {
        await hoverCenter(page, selector);
        await expectHighlights(page, [id], [name]);
        await page.mouse.click(...await page.locator(selector).boundingBox().then(box => [box.x + box.width / 2, box.y + box.height / 2]));
        await expectHighlights(page, [id], [name]);
        const frame = selector === '#nested' ? page.locator('#nested iframe') : page.locator('#frame');
        assert.equal(await (await frame.elementHandle()).contentFrame().then(inner => inner.evaluate(() => clicks)), 1);
    }
    await outside(page);
    await expectHighlights(page, [], []);
});

test('website menu markers highlight rows without feeding an extension marker back, including two simultaneous menus', options, async t => {
    const page = await fixture(t);
    await open(page);
    await outside(page);
    await page.locator('#nested').evaluate(element => element.setAttribute('data-umininn-selection-highlight', ''));
    await expectHighlights(page, [], ['2. 同名台']);
    await page.locator(rows).nth(0).hover();
    await expectHighlights(page, ['native'], ['1. 同名台', '2. 同名台']);
    await outside(page);
    await expectHighlights(page, [], ['2. 同名台']);
    await page.locator('#nested').evaluate(element => element.removeAttribute('data-umininn-selection-highlight'));
    await expectHighlights(page, [], []);
    await page.locator(panelHost).getByRole('button', { name: '關閉', exact: true }).click();
    await page.locator('#native').evaluate(element => element.setAttribute('data-umininn-selection-highlight', ''));
    await expectHighlights(page, [], []);
});

test('reorder, rename, replacement and removal retain exact element identity and clear detached-player markers', options, async t => {
    const page = await fixture(t);
    await open(page);
    await page.locator(rows).nth(0).hover();
    await expectHighlights(page, ['native'], ['1. 同名台']);
    await page.evaluate(() => { const element = document.getElementById('native'); element.style.order = '8'; element.dataset.channelName = '改名'; hoverController.scan(); });
    await outside(page);
    await page.locator(rows).filter({ hasText: '4. 改名' }).hover();
    await expectHighlights(page, ['native'], ['4. 改名']);
    await page.evaluate(() => {
        window.removedTile = document.getElementById('native');
        const replacement = removedTile.cloneNode(true);
        replacement.removeAttribute('data-umininn-controls-highlight');
        removedTile.replaceWith(replacement); hoverController.scan();
    });
    assert.equal(await page.evaluate(() => removedTile.hasAttribute('data-umininn-controls-highlight')), false);
    await outside(page);
    await expectHighlights(page, [], []);
    await hoverCenter(page, '#native');
    await expectHighlights(page, ['native'], ['4. 改名']);
    await page.evaluate(() => { window.removedTile = document.getElementById('native'); removedTile.remove(); });
    await page.waitForFunction(() => !removedTile.hasAttribute('data-umininn-controls-highlight'));
    await expectHighlights(page, [], []);
});

test('sibling window controls match only canonical channel keys, including controls inserted after scanning', options, async t => {
    const page = await fixture(t);
    await open(page);
    await page.evaluate(() => {
        const tile = document.getElementById('native').getBoundingClientRect();
        const cell = document.createElement('div');
        cell.className = 'player-window-cell'; cell.dataset.playerKey = 'native-key';
        cell.style.cssText = `position:fixed;left:${tile.left}px;top:${tile.top}px;width:${tile.width}px;height:28px;z-index:50;`;
        const button = document.createElement('button'); button.id = 'window-control'; button.textContent = 'Window control';
        button.addEventListener('click', () => { window.windowControlClicks = (window.windowControlClicks || 0) + 1; });
        cell.append(button); document.body.append(cell);
    });
    await page.locator('#window-control').hover();
    await expectHighlights(page, ['native'], ['1. 同名台']);
    assert.equal(await page.locator('#native').evaluate(element => element.matches(':hover')), false, 'the real tile is a sibling of this hit target');
    await page.locator('#window-control').click();
    assert.equal(await page.evaluate(() => windowControlClicks), 1);
    await page.locator('.player-window-cell').evaluate(element => element.dataset.playerKey = 'unknown-key');
    await page.mouse.move(2, 2); await page.locator('#window-control').hover();
    await expectHighlights(page, [], []);
    await page.locator('.player-window-cell').evaluate(element => element.dataset.playerKey = 'nested-key');
    await page.mouse.move(2, 2); await page.locator('#window-control').hover();
    await expectHighlights(page, ['nested'], ['2. 同名台']);
    await outside(page);
    await expectHighlights(page, [], []);
});

test('hiding the document clears published hover and showing it resamples the stationary pointer', options, async t => {
    const page = await fixture(t);
    await open(page);
    await page.locator(rows).nth(0).hover();
    await expectHighlights(page, ['native'], ['1. 同名台']);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await expectHighlights(page, [], []);
    assert.equal(await page.locator(panel).isVisible(), true);
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await expectHighlights(page, ['native'], ['1. 同名台']);
});

test('touch taps do not leave sticky hover markers or prevent controls from receiving the tap', options, async t => {
    const page = await fixture(t, { hasTouch: true });
    await page.locator(toggle).tap();
    const name = page.locator(rows).nth(0).locator('strong');
    await name.tap();
    await expectHighlights(page, [], []);
    await page.locator('#native').tap();
    await expectHighlights(page, [], []);
    assert.equal(await page.locator(panel).isVisible(), true);
});

test('source/frame replacement clears old entry hover handlers and the new row binds the same outer tile', options, async t => {
    const page = await fixture(t);
    await open(page);
    await page.locator(rows).nth(1).hover();
    await expectHighlights(page, ['nested'], ['2. 同名台']);
    await page.evaluate(() => {
        const wrapper = document.getElementById('nested');
        const frame = document.createElement('iframe'); frame.src = 'about:blank';
        wrapper.replaceChildren(frame); hoverController.scan();
    });
    await outside(page);
    await expectHighlights(page, [], []);
    await page.locator(rows).filter({ hasText: '2. 同名台' }).hover();
    await expectHighlights(page, ['nested'], ['2. 同名台']);
    assert.equal(await page.locator(rows).count(), 4, 'replacement does not leave a duplicate row');
});

for (const close of ['manual', 'Escape', 'idle', 'pagehide', 'dispose']) {
    test(`${close} closes highlight state and clears only the controller's own markers`, options, async t => {
        const page = await fixture(t);
        await page.clock.install();
        await open(page);
        await page.locator(rows).nth(0).hover();
        await expectHighlights(page, ['native'], ['1. 同名台']);
        await page.locator('#nested').evaluate(element => element.setAttribute('data-umininn-selection-highlight', ''));
        if (close === 'manual') await page.locator(panelHost).getByRole('button', { name: '關閉', exact: true }).click();
        if (close === 'Escape') { await page.locator(rows).nth(0).locator('input').focus(); await page.keyboard.press('Escape'); }
        if (close === 'idle') await page.clock.fastForward(30000);
        if (close === 'pagehide') await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
        if (close === 'dispose') await page.evaluate(() => hoverController.dispose());
        assert.equal(await page.locator('#native').getAttribute('data-umininn-controls-highlight'), null);
        assert.notEqual(await page.locator('#nested').getAttribute('data-umininn-selection-highlight'), null);
        assert.equal(await page.locator(rows + '[data-player-highlighted]').count(), 0);
        await hoverCenter(page, '#native');
        assert.equal(await page.locator('#native').getAttribute('data-umininn-controls-highlight'), null);
        if (close === 'dispose') assert.equal(await page.locator('#umininn-player-highlight-style').count(), 0);
    });
}
