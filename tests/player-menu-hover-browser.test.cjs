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
    const { withoutWrapper = false, ...browserOptions } = extra;
    const context = await browser.newContext({ viewport: { width: 1200, height: 820 }, serviceWorkers: 'block', ...browserOptions });
    t.after(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
        if (route.request().url() === siteUrl) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><style>
            body{margin:0;background:#111;color:white;font:14px sans-serif}#input-container{height:30px}
            #multi-stream-container-wrapper{position:relative;width:674px}
            #multi-stream-container{display:flex;flex-wrap:wrap;width:650px;gap:12px;padding:12px}
            #multi-stream-container > *{width:300px;height:190px;display:block;background:#283441;border:0}
            #multi-stream-container > div video,#multi-stream-container > div iframe{width:100%;height:100%;border:0;display:block}
            #outside{position:fixed;bottom:5px;left:5px}
            </style></head><body><div id="input-container"></div>${withoutWrapper ? '' : '<div id="multi-stream-container-wrapper">'}<div id="multi-stream-container">
            <div id="native" data-channel-key="native-key" data-channel-name="同名台"><video controls muted></video></div>
            <div id="nested" data-channel-key="nested-key" data-channel-name="同名台"><iframe src="${frameUrl}"></iframe></div>
            <video id="direct" data-channel-key="direct-key" data-channel-name="原生" controls muted></video>
            <iframe id="frame" data-channel-key="frame-key" data-channel-name="外站" src="${frameUrl}"></iframe>
            </div>${withoutWrapper ? '' : '</div>'}<button id="outside">Outside</button></body></html>` });
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
    await assertVisiblePlayerEdges(page, '#native');
    assert.equal(await page.locator('#native').evaluate(element => getComputedStyle(element).outlineStyle), 'none', 'the media element no longer paints its own ring');
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

async function compactPanel(page) {
    await page.evaluate(() => {
        const root = document.getElementById('umininn-player-panel-host').shadowRoot;
        root.getElementById('panel').style.maxHeight = '260px';
        const style = document.createElement('style'); style.textContent = '.player{min-height:110px}'; root.append(style);
    });
}
async function panelPosition(page) {
    return page.locator(panel).evaluate(element => ({ top: element.scrollTop, pageX: scrollX, pageY: scrollY }));
}
async function rowVisible(page, index) {
    return page.locator(rows).nth(index).evaluate(element => {
        const panel = element.closest('#panel'), rect = panel.getBoundingClientRect(), row = element.getBoundingClientRect();
        const top = rect.top + panel.clientTop, bottom = top + panel.clientHeight;
        return row.top >= top - 1 && row.bottom <= bottom + 1;
    });
}
async function assertVisiblePlayerEdges(page, selector) {
    const clip = await page.locator(selector).boundingBox();
    const screenshot = (await page.screenshot({ clip })).toString('base64');
    const pixels = await page.evaluate(async png => {
        const image = new Image(); image.src = 'data:image/png;base64,' + png; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        return [[image.width / 2, 1], [image.width / 2, image.height - 2], [1, image.height / 2], [image.width - 2, image.height / 2]]
            .map(([x, y]) => [...context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data]);
    }, screenshot);
    assert.deepEqual(pixels, Array.from({ length: 4 }, () => [88, 200, 255, 255]), 'all four player edges are painted above the positioned scaled iframe');
}

test('actual player hover reveals an offscreen matching control row by scrolling only the panel, minimally in either direction', options, async t => {
    const page = await fixture(t);
    await open(page); await compactPanel(page);
    const before = await panelPosition(page);
    assert.equal(await rowVisible(page, 2), false);
    await hoverCenter(page, '#direct');
    await expectHighlights(page, ['direct'], ['3. 原生']);
    await page.waitForFunction(() => document.getElementById('umininn-player-panel-host').shadowRoot.getElementById('panel').scrollTop > 0);
    assert.equal(await rowVisible(page, 2), true);
    const down = await panelPosition(page);
    assert.equal(down.pageX, before.pageX); assert.equal(down.pageY, before.pageY);
    const gap = await page.locator(rows).nth(2).evaluate(element => {
        const panel = element.closest('#panel'), rect = panel.getBoundingClientRect();
        return rect.top + panel.clientTop + panel.clientHeight - element.getBoundingClientRect().bottom;
    });
    assert.ok(Math.abs(gap) < 2, 'downward reveal aligns only the clipped bottom edge');
    await hoverCenter(page, '#native');
    await expectHighlights(page, ['native'], ['1. 同名台']);
    assert.equal(await rowVisible(page, 0), true);
    const up = await panelPosition(page);
    assert.ok(up.top < down.top); assert.equal(up.pageX, before.pageX); assert.equal(up.pageY, before.pageY);
});

test('visible rows and menu-row hover do not jump; manual panel scrolling is respected until the player hover changes', options, async t => {
    const page = await fixture(t);
    await open(page); await compactPanel(page);
    await hoverCenter(page, '#direct');
    await expectHighlights(page, ['direct'], ['3. 原生']);
    const revealed = await panelPosition(page);
    await outside(page); await hoverCenter(page, '#direct');
    await expectHighlights(page, ['direct'], ['3. 原生']);
    assert.deepEqual(await panelPosition(page), revealed, 'an already visible row needs no extra movement');
    await page.locator(panel).evaluate(element => element.scrollTop = 0);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal((await panelPosition(page)).top, 0, 'the same player does not fight a manual menu scroll');
    await page.locator(rows).nth(0).hover();
    const afterHover = await panelPosition(page);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.deepEqual(await panelPosition(page), afterHover, 'hovering controls themselves never schedules another reveal');
});

test('rapid player changes, removal and closing discard stale auto-reveal targets', options, async t => {
    const page = await fixture(t);
    await open(page); await compactPanel(page);
    await hoverCenter(page, '#direct'); await hoverCenter(page, '#native');
    await expectHighlights(page, ['native'], ['1. 同名台']);
    assert.equal(await rowVisible(page, 0), true);
    await page.evaluate(() => { document.getElementById('native').remove(); hoverController.scan(); });
    await outside(page); await expectHighlights(page, [], []);
    await page.locator(panelHost).getByRole('button', { name: '關閉', exact: true }).click();
    const closed = await panelPosition(page);
    await hoverCenter(page, '#direct');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.deepEqual(await panelPosition(page), closed, 'closed menus cannot receive queued or new hover scrolling');
});

test('window controls can reveal their row, while a foreign menu marker and touch taps never scroll the panel', options, async t => {
    const page = await fixture(t);
    await open(page); await compactPanel(page); await outside(page);
    const before = await panelPosition(page);
    await page.locator('#direct').evaluate(element => element.setAttribute('data-umininn-selection-highlight', ''));
    await expectHighlights(page, [], ['3. 原生']);
    assert.deepEqual(await panelPosition(page), before, 'another menu must not pull this one away from its current position');
    await page.locator('#direct').evaluate(element => element.removeAttribute('data-umininn-selection-highlight'));
    await page.evaluate(() => {
        const rect = document.getElementById('direct').getBoundingClientRect(), cell = document.createElement('div');
        cell.className = 'player-window-cell'; cell.dataset.playerKey = 'direct-key';
        cell.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:160px;height:25px;z-index:50;`;
        const button = document.createElement('button'); button.id = 'scroll-window-control'; button.textContent = 'Window';
        cell.append(button); document.body.append(cell);
    });
    await page.locator('#scroll-window-control').hover();
    await expectHighlights(page, ['direct'], ['3. 原生']);
    assert.equal(await rowVisible(page, 2), true);
    assert.equal(await page.locator('#direct').evaluate(element => element.matches(':hover')), false);
    const touchPage = await fixture(t, { hasTouch: true });
    await touchPage.locator(toggle).tap(); await compactPanel(touchPage);
    const untouched = await panelPosition(touchPage);
    await touchPage.locator('#direct').tap();
    await expectHighlights(touchPage, [], []);
    assert.deepEqual(await panelPosition(touchPage), untouched, 'touching a player never starts hover scrolling');
});

test('a real control-row order change resamples a stationary player, while unchanged scans do not fight manual menu scrolling', options, async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
        const pane = document.getElementById('multi-stream-container'), paneRect = pane.getBoundingClientRect();
        const positions = [...pane.children].map(tile => ({ tile, rect: tile.getBoundingClientRect() }));
        for (const { tile, rect } of positions) {
            tile.style.position = 'absolute'; tile.style.left = `${rect.left - paneRect.left}px`; tile.style.top = `${rect.top - paneRect.top}px`;
        }
        pane.style.position = 'relative'; pane.style.height = '500px';
    });
    await open(page); await compactPanel(page);
    await hoverCenter(page, '#native');
    await expectHighlights(page, ['native'], ['1. 同名台']);
    await page.evaluate(() => { document.getElementById('native').style.order = '8'; hoverController.scan(); });
    await expectHighlights(page, ['native'], ['4. 同名台']);
    await page.waitForFunction(() => document.getElementById('umininn-player-panel-host').shadowRoot.getElementById('panel').scrollTop > 250);
    assert.equal(await rowVisible(page, 0), true, 'the original native row is still DOM row zero, now last in CSS order');
    await page.locator(panel).evaluate(element => element.scrollTop = 0);
    await page.evaluate(() => { document.getElementById('native').dataset.channelName = '背景改名'; hoverController.scan(); });
    await expectHighlights(page, ['native'], ['4. 背景改名']);
    assert.equal((await panelPosition(page)).top, 0, 'rename and background scans preserve a deliberate menu position');
});

test('a resized panel reveals the stationary hovered player again after a deliberate prior scroll', options, async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
        const pane = document.getElementById('multi-stream-container');
        for (let index = 0; index < 10; index++) {
            const tile = document.createElement('video'); tile.dataset.channelName = `額外台${index}`;
            tile.style.cssText = `position:fixed;left:-1000px;top:-1000px;order:${index - 10};`;
            pane.append(tile);
        }
        hoverController.scan();
    });
    await open(page); await compactPanel(page);
    await hoverCenter(page, '#native');
    await expectHighlights(page, ['native'], ['11. 同名台']);
    assert.equal(await rowVisible(page, 0), true);
    await page.locator(panel).evaluate(element => element.scrollTop = 0);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal((await panelPosition(page)).top, 0);
    await page.setViewportSize({ width: 1200, height: 700 });
    await page.waitForFunction(() => document.getElementById('umininn-player-panel-host').shadowRoot.getElementById('panel').scrollTop > 100);
    assert.equal(await rowVisible(page, 0), true);
    assert.equal(await page.evaluate(() => scrollY), 0);
});

test('scaled Kick iframe with production 220 percent scaling, containment and clipping keeps outer player hover and reveals its row', { ...options, skip: !enabled || engine !== 'firefox' }, async t => {
    const page = await fixture(t);
    await page.evaluate(() => {
        document.getElementById('multi-stream-container').style.borderRadius = '14px';
        const wrapper = document.getElementById('nested'), iframe = wrapper.querySelector('iframe');
        wrapper.className = 'video1 kick-wrapper';
        wrapper.style.cssText += ';position:relative;overflow:hidden;contain:layout paint';
        iframe.className = 'kick-iframe';
        iframe.style.cssText = 'position:absolute;top:0;left:0;width:220%;height:220%;transform:scale(.454545);transform-origin:top left;border:0;contain:layout paint';
        const productionRadius = document.createElement('style'); productionRadius.textContent = '.kick-wrapper,.kick-iframe{border-radius:inherit}'; document.head.append(productionRadius);
    });
    await open(page); await compactPanel(page);
    await hoverCenter(page, '#nested');
    await expectHighlights(page, ['nested'], ['2. 同名台']);
    assert.equal(await page.locator('#nested').evaluate(element => element.matches(':hover')), true);
    assert.equal(await rowVisible(page, 1), true);
    await assertVisiblePlayerEdges(page, '#nested');
    assert.deepEqual(await page.locator('#nested').evaluate(element => [getComputedStyle(element).borderRadius, getComputedStyle(element.querySelector('iframe')).borderRadius]), ['0px', '0px']);
    const box = await page.locator('#nested').boundingBox();
    await page.mouse.move(box.x + 20, box.y + 20);
    await expectHighlights(page, ['nested'], ['2. 同名台']);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const inner = await (await page.locator('#nested iframe').elementHandle()).contentFrame();
    assert.equal(await inner.evaluate(() => clicks), 1);
    await expectHighlights(page, ['nested'], ['2. 同名台']);
    await outside(page); await expectHighlights(page, [], []);
    await page.locator('#nested').evaluate(element => element.setAttribute('data-umininn-selection-highlight', ''));
    await expectHighlights(page, [], ['2. 同名台']);
    assert.equal(await page.locator('#umininn-player-hover-layer [data-player-ring]').count(), 0, 'the independent controls layer does not paint the other menu owner');
    assert.deepEqual(await page.evaluate(() => hoverCommands), [], 'paint and hover changes never issue audio commands');
});

for (const kind of ['native video', 'direct video', 'direct iframe', 'Twitch SDK wrapper', 'YouTube wrapper', 'scaled Kick']) {
    test(`independent sibling ring paints four visible edges above ${kind} without touching live media`, options, async t => {
        const page = await fixture(t);
        const selector = await page.evaluate(kind => {
            const nested = document.getElementById('nested'), iframe = nested.querySelector('iframe');
            if (kind === 'Twitch SDK wrapper' || kind === 'YouTube wrapper' || kind === 'scaled Kick') {
                nested.style.cssText += ';position:relative;contain:layout paint;overflow:hidden';
                iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;contain:layout paint;z-index:2147483647';
            }
            if (kind === 'Twitch SDK wrapper') {
                nested.className = 'twitch-wrapper';
                iframe.style.height = 'calc(100% - 30px)';
                const recover = document.createElement('button'); recover.id = 'sdk-recover'; recover.textContent = '恢復播放';
                recover.style.cssText = 'position:absolute;bottom:0;right:6px;height:26px';
                recover.addEventListener('click', () => { window.sdkRecoverClicks = (window.sdkRecoverClicks || 0) + 1; });
                nested.append(recover);
            }
            if (kind === 'YouTube wrapper') {
                nested.className = 'youtube-wrapper';
                const holder = document.createElement('div'); holder.style.cssText = 'position:absolute;inset:0';
                holder.append(iframe); nested.append(holder);
            }
            if (kind === 'scaled Kick') {
                nested.className = 'kick-wrapper'; iframe.className = 'kick-iframe';
                iframe.style.cssText += ';width:220%;height:220%;transform:scale(.454545);transform-origin:top left';
            }
            hoverController.scan();
            window.paintMedia = [...document.querySelectorAll('#multi-stream-container video,#multi-stream-container iframe')];
            window.paintSources = paintMedia.map(element => element.getAttribute('src'));
            return kind === 'native video' ? '#native' : kind === 'direct video' ? '#direct' : kind === 'direct iframe' ? '#frame' : '#nested';
        }, kind);
        await open(page);
        const index = selector === '#native' ? 0 : selector === '#direct' ? 2 : selector === '#frame' ? 3 : 1;
        await page.locator(rows).nth(index).locator('strong').hover();
        await assertVisiblePlayerEdges(page, selector);
        assert.equal(await page.locator('#umininn-player-hover-layer [data-player-ring]').count(), 1);
        assert.equal(await page.locator('#umininn-player-hover-layer').getAttribute('aria-hidden'), 'true');
        assert.equal(await page.locator('#umininn-player-hover-layer').evaluate(element => getComputedStyle(element).pointerEvents), 'none');
        assert.equal(await page.locator('#umininn-player-hover-layer').evaluate(element => getComputedStyle(element).zIndex), '12');
        if (kind === 'Twitch SDK wrapper') {
            await page.locator('#sdk-recover').click();
            assert.equal(await page.evaluate(() => sdkRecoverClicks), 1, 'the sibling ring never blocks the recovery button');
        }
        assert.equal(await page.evaluate(() => paintMedia.every((element, index) => element.isConnected && element === document.querySelectorAll('#multi-stream-container video,#multi-stream-container iframe')[index] && element.getAttribute('src') === paintSources[index])), true);
        assert.deepEqual(await page.evaluate(() => hoverCommands), []);
    });
}

test('sibling rings follow resize and scroll, clip to the pane, and disappear while the pane is hidden', options, async t => {
    const page = await fixture(t);
    await open(page); await page.locator(rows).nth(0).hover();
    await expectHighlights(page, ['native'], ['1. 同名台']);
    const ring = page.locator('#umininn-player-hover-layer [data-player-ring]');
    await page.locator('#native').evaluate(element => { element.style.width = '240px'; element.style.height = '160px'; });
    await page.waitForFunction(() => {
        const ring = document.querySelector('#umininn-player-hover-layer [data-player-ring]'), tile = document.getElementById('native');
        return ring && Math.abs(ring.getBoundingClientRect().width - tile.getBoundingClientRect().width) < 0.5;
    });
    assert.deepEqual(await ring.boundingBox(), await page.locator('#native').boundingBox());
    await page.locator('#native').evaluate(element => element.style.transform = 'translateX(24px)');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await ring.boundingBox(), await page.locator('#native').boundingBox(), 'position-only transforms repaint without waiting for the delayed media scan');
    await page.locator('#multi-stream-container').evaluate(element => { element.style.height = '220px'; element.style.overflow = 'hidden'; element.scrollTop = 70; });
    await page.waitForFunction(() => {
        const ring = document.querySelector('#umininn-player-hover-layer [data-player-ring]');
        return ring && Math.abs(ring.getBoundingClientRect().top - document.getElementById('native').getBoundingClientRect().top) < 0.5;
    });
    assert.deepEqual(await ring.boundingBox(), await page.locator('#native').boundingBox());
    assert.deepEqual(await page.locator('.umininn-player-ring-viewport').boundingBox(), await page.locator('#multi-stream-container').boundingBox());
    assert.equal(await page.locator('.umininn-player-ring-viewport').evaluate(element => getComputedStyle(element).overflow), 'hidden');
    await page.locator('#multi-stream-container').evaluate(element => element.style.display = 'none');
    await page.locator('#umininn-player-hover-layer').waitFor({ state: 'hidden' });
    await page.locator('#multi-stream-container').evaluate(element => element.style.display = 'flex');
    await page.locator('#umininn-player-hover-layer').waitFor({ state: 'visible' });
    await page.locator('#multi-stream-container').evaluate(element => element.scrollTop = 0);
    await page.waitForFunction(() => {
        const ring = document.querySelector('#umininn-player-hover-layer [data-player-ring]');
        return ring && Math.abs(ring.getBoundingClientRect().top - document.getElementById('native').getBoundingClientRect().top) < 0.5;
    });
    await assertVisiblePlayerEdges(page, '#native');
    for (const visibility of ['hidden', 'collapse']) {
        await page.locator('#native').evaluate((element, visibility) => element.style.visibility = visibility, visibility);
        await page.locator('#umininn-player-hover-layer').waitFor({ state: 'hidden' });
        await page.locator('#native').evaluate(element => element.style.visibility = 'visible');
        await page.locator('#umininn-player-hover-layer').waitFor({ state: 'visible' });
        await assertVisiblePlayerEdges(page, '#native');
    }
    await page.locator('#native').evaluate(element => element.hidden = true);
    await page.locator('#umininn-player-hover-layer').waitFor({ state: 'hidden' });
    await page.locator('#native').evaluate(element => element.hidden = false);
    await page.locator('#umininn-player-hover-layer').waitFor({ state: 'visible' });
    await assertVisiblePlayerEdges(page, '#native');
});

test('the standalone fallback ring uses viewport coordinates when no website wrapper exists', options, async t => {
    const page = await fixture(t, { withoutWrapper: true });
    await open(page); await page.locator(rows).nth(2).hover();
    await expectHighlights(page, ['direct'], ['3. 原生']);
    assert.equal(await page.locator('#umininn-player-hover-layer').evaluate(element => getComputedStyle(element).position), 'fixed');
    await assertVisiblePlayerEdges(page, '#direct');
});

test('fullscreen suspends all owned ring paint and markers, then exit restores the live pointer state', options, async t => {
    const page = await fixture(t);
    await open(page); await page.locator(rows).nth(0).hover();
    await expectHighlights(page, ['native'], ['1. 同名台']);
    await page.evaluate(() => document.addEventListener('keydown', event => {
        if (event.key === 'f') void document.getElementById('multi-stream-container').requestFullscreen();
    }, { once: true }));
    await page.keyboard.press('f');
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    await page.waitForFunction(() => !document.getElementById('native').hasAttribute('data-umininn-controls-highlight') && !document.querySelector('#umininn-player-hover-layer [data-player-ring]'));
    assert.equal(await page.locator('#native').getAttribute('data-umininn-controls-highlight'), null);
    assert.equal(await page.locator('#umininn-player-hover-layer [data-player-ring]').count(), 0);
    await page.evaluate(() => document.exitFullscreen());
    await page.locator(rows).nth(0).hover();
    await expectHighlights(page, ['native'], ['1. 同名台']);
    await assertVisiblePlayerEdges(page, '#native');
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
        assert.equal(await page.locator('#umininn-player-hover-layer [data-player-ring]').count(), 0);
        await hoverCenter(page, '#native');
        assert.equal(await page.locator('#native').getAttribute('data-umininn-controls-highlight'), null);
        if (close === 'dispose') {
            assert.equal(await page.locator('#umininn-player-highlight-style').count(), 0);
            assert.equal(await page.locator('#umininn-player-hover-layer').count(), 0);
        }
    });
}
