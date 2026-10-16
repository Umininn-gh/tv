'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { renderUserscript } = require('../tools/build-player-userscript.cjs');

// Optional, fully intercepted browser models. No userscript manager is installed,
// and no real AngelThump page, stream, token, Patreon URL or media is requested.
// PageTransitionEvent dispatch checks lifecycle handlers, not BFCache eligibility.
const enabled = process.env.UMININN_BROWSER_TESTS === '1';
const engine = process.env.UMININN_BROWSER_ENGINE || 'chromium';
const selectedChannel = process.env.UMININN_BROWSER_CHANNEL;
const executablePath = process.env.UMININN_BROWSER_EXECUTABLE;
const siteUrl = 'https://umininn-gh.github.io/tv/';
const siblingUrl = 'https://umininn-gh.github.io/fixture-sibling';
const playerUrl = 'https://player.angelthump.com/?channel=fixture';
const channel = 'umininn-tv-userscript';
const styleId = 'umininn-angelthump-logo-style';
const exactLinks = ['https://patreon.com/join/angelthump', 'https://patreon.com/join/angelthump/',
    'https://www.patreon.com/join/angelthump', 'https://www.patreon.com/join/angelthump/'];
const otherLinks = ['https://patreon.com/join/angelthump?source=other', 'https://patreon.com/join/angelthump2',
    'http://patreon.com/join/angelthump', 'https://www.patreon.com/angelthump'];
let browser, script, unavailable;

test.before(async () => {
    if (!enabled) return;
    let playwright;
    try { playwright = require('playwright'); }
    catch (_) {
        try { playwright = require(path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright')); }
        catch (_) { unavailable = 'Playwright is unavailable; optional browser model was not run.'; return; }
    }
    assert.ok(['chromium', 'firefox'].includes(engine));
    assert.ok(!selectedChannel || engine === 'chromium', 'Browser channels apply only to Chromium.');
    const candidates = selectedChannel || executablePath || engine === 'firefox'
        ? [{ headless: true, ...(selectedChannel ? { channel: selectedChannel } : {}), ...(executablePath ? { executablePath } : {}) }]
        : [{ headless: true }, { headless: true, channel: 'msedge' }];
    let chosen, launchError;
    for (const options of candidates) {
        try { browser = await playwright[engine].launch(options); chosen = options; break; }
        catch (error) { launchError = error; /* An installed Edge may be available without bundled Chromium. */ }
    }
    if (!browser) {
        if (executablePath || selectedChannel) throw launchError;
        unavailable = `Could not launch ${engine}; no browser model was run.`; return;
    }
    // The actual builder renders all current modules into its private closure;
    // this read-only path does not rewrite distribution files or outputs.
    script = renderUserscript();
    console.log(`AngelThump userscript model: ${engine}${chosen.channel ? '/' + chosen.channel : ''} ${browser.version()} (all network intercepted; no live platform or manager).`);
});
test.after(async () => { await browser?.close(); });
function optional(t) { if (unavailable) { t.skip(unavailable); return false; } return true; }

function silentWav() {
    const rate = 8000, samples = rate * 2, bytes = Buffer.alloc(44 + samples * 2);
    bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
    bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
    return bytes;
}
const wav = silentWav();
const playerHtml = `<!doctype html><html><head><style>a{display:inline-block}body{margin:0}</style></head><body>
<video id="fixture-video" controls preload="auto" src="/silent.wav" style="display:block;width:400px;height:300px"></video>
<button id="fixture-controls" type="button">Volume and playback controls</button><header id="fixture-logo-mount"></header>
<script>
window.fixtureVideo = document.getElementById('fixture-video');
window.fixtureControls = document.getElementById('fixture-controls');
fixtureVideo.volume = 0.37; fixtureVideo.muted = false;
window.fixtureMediaActions = {play:0,pause:0,load:0,sourceChanges:0};
for (const method of ['play','pause','load']) { const original=fixtureVideo[method].bind(fixtureVideo); fixtureVideo[method]=function(...args){fixtureMediaActions[method]++;return original(...args)}; }
new MutationObserver(records => { fixtureMediaActions.sourceChanges += records.length; }).observe(fixtureVideo,{attributes:true,attributeFilter:['src','controls']});
window.fixtureMountLogos = function () {
  const mount = document.createElement('header'); mount.id = 'fixture-logo-mount';
  const urls = ${JSON.stringify([...exactLinks, ...otherLinks])};
  urls.forEach((href,index) => {const a=document.createElement('a');a.href=href;a.id='fixture-link-'+index;a.textContent='Logo '+index;mount.appendChild(a)});
  document.getElementById('fixture-logo-mount').replaceWith(mount);
};
fixtureMountLogos();
<\/script></body></html>`;

async function fixture({ topUrl = siteUrl, frameUrl = playerUrl, standalone = false } = {}) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const navigationRequests = new Map(), blocked = [];
    const html = `<!doctype html><html><body><div id="input-container"></div><div id="multi-stream-container"></div>
<iframe id="target" src="${frameUrl}" style="width:440px;height:440px"></iframe><iframe id="sibling" src="${siblingUrl}"></iframe></body></html>`;
    const initialUrl = standalone ? frameUrl : topUrl;
    await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (request.isNavigationRequest()) {
            navigationRequests.set(request.url(), (navigationRequests.get(request.url()) || 0) + 1);
            if (request.url() === frameUrl) return route.fulfill({ contentType: 'text/html', body: playerHtml });
            if (request.url() === topUrl) return route.fulfill({ contentType: 'text/html', body: html });
            if (request.url() === siblingUrl) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Same-origin sibling</body></html>' });
        }
        if (url.origin === 'https://player.angelthump.com' && url.pathname === '/silent.wav') {
            const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range || '');
            const start = range ? Number(range[1]) : 0;
            const end = range && range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
            return route.fulfill({ status: range ? 206 : 200, contentType: 'audio/wav', body: wav.subarray(start, end + 1),
                headers: { 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${wav.length}` } : {}) } });
        }
        blocked.push(request.url());
        return route.abort();
    });
    await context.addInitScript({ content: `
        window.fixtureIntervals = 0;
        const originalInterval = window.setInterval.bind(window);
        window.setInterval = function(...args) { fixtureIntervals++; return originalInterval(...args); };
        addEventListener('DOMContentLoaded', () => {\n${script}\n}, {once:true});
    ` });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    await page.goto(initialUrl, { waitUntil: 'load' });
    const frame = standalone ? page.mainFrame() : page.frames().find(frame => frame.url() === frameUrl);
    assert.ok(frame);
    try {
        await frame.waitForFunction(() => fixtureVideo.readyState >= 2);
        // Establish a paused, nonzero test baseline after media data is ready.
        await frame.evaluate(() => { fixtureVideo.currentTime = 0.375; });
        await frame.waitForFunction(() => fixtureVideo.readyState >= 2 && Math.abs(fixtureVideo.currentTime - 0.375) < 0.05);
    } catch (error) {
        console.error('Fixture media diagnostic:', await frame.evaluate(() => ({
            readyState: fixtureVideo.readyState, networkState: fixtureVideo.networkState,
            time: fixtureVideo.currentTime, duration: fixtureVideo.duration, seekable: fixtureVideo.seekable.length,
            error: fixtureVideo.error?.message, source: fixtureVideo.currentSrc,
        })), 'blocked:', blocked);
        await context.close();
        throw error;
    }
    return { context, page, frame, navigationRequests, blocked };
}
async function probe(page) {
    await page.evaluate(({ channel }) => document.getElementById('target').contentWindow.postMessage({ channel, version: 1, type: 'frame:probe' }, 'https://player.angelthump.com'), { channel });
}
async function styleCount(frame) { return frame.locator('#' + styleId).count(); }
async function visibleLinks(frame) {
    return frame.locator('#fixture-logo-mount a').evaluateAll(links => links.map(link => getComputedStyle(link).display));
}
async function mediaSnapshot(frame) {
    return frame.evaluate(() => ({ sameVideo: fixtureVideo === document.getElementById('fixture-video'),
        sameControls: fixtureControls === document.getElementById('fixture-controls'), controls: fixtureVideo.controls,
        volume: fixtureVideo.volume, muted: fixtureVideo.muted, time: fixtureVideo.currentTime, paused: fixtureVideo.paused,
        source: fixtureVideo.currentSrc, actions: {...fixtureMediaActions}, intervals: fixtureIntervals,
        controlsVisible: getComputedStyle(fixtureControls).display !== 'none' && fixtureControls.getBoundingClientRect().height > 0 }));
}

test('actual bundle starts AT cosmetic CSS only after an approved direct-parent probe, including late logo remounts', { skip: !enabled, timeout: 30000 }, async t => {
    if (!optional(t)) return;
    const f = await fixture();
    try {
        // The AT iframe deliberately lives outside #multi-stream-container, so
        // production site discovery cannot approve it before this explicit test.
        const before = await mediaSnapshot(f.frame), navigations = new Map(f.navigationRequests);
        assert.equal(await styleCount(f.frame), 0);
        assert.ok((await visibleLinks(f.frame)).every(display => display !== 'none'));
        const sibling = f.page.frames().find(frame => frame.url() === siblingUrl);
        await sibling.evaluate(({ channel }) => parent.document.getElementById('target').contentWindow.postMessage({ channel, version: 1, type: 'frame:probe' }, 'https://player.angelthump.com'), { channel });
        await f.page.waitForTimeout(200);
        assert.equal(await styleCount(f.frame), 0, 'an approved-origin sibling is not the direct parent');
        await probe(f.page);
        await f.frame.waitForFunction(id => Boolean(document.getElementById(id)), styleId);
        assert.deepEqual(await visibleLinks(f.frame), ['none', 'none', 'none', 'none', ...otherLinks.map(() => 'inline-block')]);
        assert.deepEqual(await mediaSnapshot(f.frame), before, 'CSS approval never changes media, controls, time, sound or source');
        for (let i = 0; i < 2; i++) {
            await f.frame.evaluate(() => fixtureMountLogos());
            assert.deepEqual(await visibleLinks(f.frame), ['none', 'none', 'none', 'none', ...otherLinks.map(() => 'inline-block')]);
            await probe(f.page);
            assert.equal(await styleCount(f.frame), 1, 'repeated probes do not duplicate CSS');
        }
        await f.page.waitForTimeout(300);
        assert.deepEqual(await mediaSnapshot(f.frame), before);
        assert.deepEqual(f.navigationRequests, navigations, 'no source/frame reload is needed');
        assert.deepEqual(f.blocked, [], 'all modeled resources are local route fulfillments');
    } finally { await f.context.close(); }
});

test('AT CSS stops for BFCache and disposal; restore needs a fresh approved probe', { skip: !enabled, timeout: 30000 }, async t => {
    if (!optional(t)) return;
    const f = await fixture();
    try {
        await probe(f.page); await f.frame.waitForFunction(id => Boolean(document.getElementById(id)), styleId);
        const before = await mediaSnapshot(f.frame);
        await f.frame.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
        assert.equal(await styleCount(f.frame), 0);
        assert.ok((await visibleLinks(f.frame)).every(display => display !== 'none'));
        await probe(f.page); await f.page.waitForTimeout(150);
        assert.equal(await styleCount(f.frame), 0, 'a suspended document ignores probes');
        await f.frame.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
        assert.equal(await styleCount(f.frame), 0, 'restoration alone cannot reapply cosmetic changes');
        await probe(f.page); await f.frame.waitForFunction(id => Boolean(document.getElementById(id)), styleId);
        assert.equal(await styleCount(f.frame), 1);
        assert.deepEqual(await mediaSnapshot(f.frame), before);
        await f.frame.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
        assert.equal(await styleCount(f.frame), 0);
        await probe(f.page); await f.page.waitForTimeout(150);
        assert.equal(await styleCount(f.frame), 0, 'disposed clients cannot restart from a late probe');
        assert.deepEqual(await mediaSnapshot(f.frame), before);
    } finally { await f.context.close(); }
});

test('unapproved parents, standalone AT pages and AT non-root paths keep the Patreon links visible', { skip: !enabled, timeout: 30000 }, async t => {
    if (!optional(t)) return;
    for (const options of [{ topUrl: 'https://attacker.invalid/' }, { standalone: true }, { frameUrl: 'https://player.angelthump.com/not-player' }]) {
        const f = await fixture(options);
        try {
            if (!options.standalone) { await probe(f.page); await f.page.waitForTimeout(150); }
            assert.equal(await styleCount(f.frame), 0);
            assert.ok((await visibleLinks(f.frame)).every(display => display !== 'none'));
            const value = await mediaSnapshot(f.frame);
            assert.equal(value.sameVideo, true); assert.equal(value.sameControls, true);
            assert.equal(value.volume, 0.37); assert.equal(value.paused, true); assert.equal(value.intervals, 0);
        } finally { await f.context.close(); }
    }
});
