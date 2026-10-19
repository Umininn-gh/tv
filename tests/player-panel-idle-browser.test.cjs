'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { renderUserscript } = require('../tools/build-player-userscript.cjs');

// Exercise the real bundled panel with trusted browser input. No userscript
// manager, remote player, media or live website is contacted by this fixture.
const enabled = process.env.UMININN_BROWSER_TESTS === '1';
const engine = process.env.UMININN_BROWSER_ENGINE || 'chromium';
const url = 'https://umininn-gh.github.io/tv/';
const toolbar = '#umininn-player-control-host';
const panelHost = '#umininn-player-panel-host';
const panel = panelHost + ' #panel';
const toggle = toolbar + ' #toggle';
const browserCase = { skip: !enabled, timeout: 20000 };
let browser, script;

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
    for (const options of candidates) {
        try { browser = await playwright[engine].launch(options); break; }
        catch (_) { /* Try installed Edge when bundled Chromium is absent. */ }
    }
    assert.ok(browser, `Could not launch ${engine}; check browser installation and process permissions.`);
    script = renderUserscript();
    console.log(`Panel inactivity fixture: ${engine} ${browser.version()} (rendered bundle; no manager or live platform).`);
});
test.after(async () => { await browser?.close(); });

async function fixture(t) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, serviceWorkers: 'block' });
    t.after(() => context.close());
    const requests = [];
    await context.route('**/*', route => {
        const request = route.request();
        if (request.url() === url && request.isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: `<!doctype html>
            <html><body><div id="input-container"></div><div id="multi-stream-container"></div>
            <input id="outside" aria-label="Outside panel" style="position:fixed;left:20px;bottom:20px;width:150px"></body></html>` });
        requests.push(request.url());
        return route.abort();
    });
    await context.addInitScript({ content: `addEventListener('DOMContentLoaded', () => {\n${script}\n}, { once: true });` });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator(toggle).waitFor({ state: 'attached' });
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
    // A harmless button and scrollable area let real input exercise the panel
    // without changing playback or starting recovery operations.
    await page.evaluate(() => {
        const target = document.getElementById('umininn-player-panel-host').shadowRoot.getElementById('panel');
        target.style.maxHeight = '240px';
        const action = document.createElement('button');
        action.id = 'idle-fixture-action'; action.textContent = 'Fixture action';
        target.prepend(action);
        const space = document.createElement('div');
        space.style.height = '1000px'; target.append(space);
    });
    t.after(() => {
        assert.deepEqual(errors, [], 'no page errors during timer or disposal handling');
        assert.deepEqual(requests, [], 'the fixture never requests external content');
    });
    return { page, errors };
}

async function open(page) {
    await page.locator(toggle).click({ force: true });
    assert.equal(await page.locator(panel).isVisible(), true);
    assert.equal(await page.locator(toggle).getAttribute('aria-expanded'), 'true');
}
async function assertClosed(page) {
    assert.equal(await page.locator(panel).isVisible(), false);
    assert.equal(await page.locator(toggle).getAttribute('aria-expanded'), 'false');
}

test('userscript panel closes at exactly 30 seconds idle and restores its own focus', browserCase, async t => {
    const f = await fixture(t); if (!f) return;
    const { page } = f;
    await open(page);
    await page.clock.fastForward(29999);
    assert.equal(await page.locator(panel).isVisible(), true);
    await page.clock.fastForward(1);
    await assertClosed(page);
    assert.equal(await page.evaluate(() => document.getElementById('umininn-player-control-host').shadowRoot.activeElement?.id), 'toggle');
});

for (const activity of ['pointer movement', 'click', 'wheel', 'keyboard']) {
    test(`trusted ${activity} restarts the panel's full 30-second inactivity period`, browserCase, async t => {
        const f = await fixture(t); if (!f) return;
        const { page } = f;
        await open(page);
        await page.clock.fastForward(25000);
        const action = page.locator(panelHost + ' #idle-fixture-action');
        // wheel() can return before the browser delivers its event. Wait for
        // the actual trusted operation before advancing the paused clock.
        const eventType = { 'pointer movement': 'pointermove', click: 'click', wheel: 'wheel', keyboard: 'keydown' }[activity];
        const delivered = page.evaluate(type => new Promise(resolve => {
            const target = document.getElementById('umininn-player-panel-host').shadowRoot.getElementById('panel');
            target.addEventListener(type, event => resolve(event.isTrusted), { capture: true, once: true });
        }), eventType);
        if (activity === 'pointer movement' || activity === 'wheel') {
            const box = await action.boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            if (activity === 'wheel') await page.mouse.wheel(0, 100);
        } else if (activity === 'click') {
            await action.click({ force: true });
        } else {
            await action.focus();
            await page.keyboard.press('ArrowRight');
        }
        assert.equal(await delivered, true, 'the timer reset is caused by browser user input');
        await page.clock.fastForward(5000);
        assert.equal(await page.locator(panel).isVisible(), true, 'the original open-time deadline has been replaced');
        await page.clock.fastForward(24999);
        assert.equal(await page.locator(panel).isVisible(), true);
        await page.clock.fastForward(1);
        await assertClosed(page);
    });
}

test('scripted clicks, focus, scrolling and background list/status updates do not postpone closing', browserCase, async t => {
    const f = await fixture(t); if (!f) return;
    const { page } = f;
    await open(page);
    await page.clock.fastForward(25000);
    await page.evaluate(() => {
        const root = document.getElementById('umininn-player-panel-host').shadowRoot;
        root.getElementById('idle-fixture-action').click();
        root.getElementById('idle-fixture-action').focus();
        root.getElementById('panel').scrollTop = 120;
        root.getElementById('panel').dispatchEvent(new Event('scroll'));
        root.getElementById('summary').textContent = 'Background status update';
        root.getElementById('recovery-status').textContent = 'Background recovery update';
        // The real observer schedules scan() when the player list changes.
        document.getElementById('multi-stream-container').append(document.createElement('div'));
    });
    await page.clock.fastForward(4999);
    assert.equal(await page.locator(panel).isVisible(), true);
    await page.clock.fastForward(1);
    await assertClosed(page);
});

test('activity and focus elsewhere do not keep the panel open or have focus stolen', browserCase, async t => {
    const f = await fixture(t); if (!f) return;
    const { page } = f;
    await open(page);
    await page.clock.fastForward(25000);
    await page.locator('#outside').click({ force: true });
    await page.keyboard.type('still chatting');
    await page.clock.fastForward(5000);
    await assertClosed(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'outside');
});

test('manual close clears the old timer and reopening starts a fresh 30-second period', browserCase, async t => {
    const f = await fixture(t); if (!f) return;
    const { page } = f;
    await open(page);
    await page.clock.fastForward(25000);
    await page.locator(panelHost).getByRole('button', { name: '關閉', exact: true }).click({ force: true });
    await assertClosed(page);
    await page.clock.fastForward(1000);
    await open(page);
    await page.clock.fastForward(4000);
    assert.equal(await page.locator(panel).isVisible(), true, 'the cancelled first timer cannot close the reopened panel');
    await page.clock.fastForward(25999);
    assert.equal(await page.locator(panel).isVisible(), true);
    await page.clock.fastForward(1);
    await assertClosed(page);
});

test('pagehide closes a cached panel, and final navigation disposes it without stale timer errors', browserCase, async t => {
    const f = await fixture(t); if (!f) return;
    const { page } = f;
    await open(page);
    await page.clock.fastForward(25000);
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await assertClosed(page);
    await page.clock.fastForward(60000);
    await assertClosed(page);
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await open(page);
    await page.clock.fastForward(29999);
    assert.equal(await page.locator(panel).isVisible(), true);
    await page.clock.fastForward(1);
    await assertClosed(page);
    await open(page);
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    assert.equal(await page.locator(panelHost).count(), 0);
    assert.equal(await page.locator(toolbar).count(), 0);
    await page.clock.fastForward(60000);
});
