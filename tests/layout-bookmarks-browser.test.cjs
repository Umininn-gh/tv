'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Closed browser model: real bookmark UI and app capture/apply/layout functions,
// actual local media and cross-origin iframe documents. Player SDKs, credentials,
// channel status providers and external streams are outside this model.
const enabled = process.env.UMININN_BROWSER_TESTS === '1';
const engine = process.env.UMININN_BROWSER_ENGINE || 'chromium';
const root = path.resolve(__dirname, '..');
const origin = 'https://umininn-gh.github.io';
const siteUrl = origin + '/tv/';
const frameOrigin = 'https://bookmark-player.invalid';
const browserCase = { skip: !enabled, timeout: 30000 };
let browser, css, bookmarkCss, appScript, modules;
const read = filename => fs.readFileSync(path.join(root, filename), 'utf8');

function productionFunction(source, name) {
    const match = source.match(new RegExp('^function ' + name + '\\([^]*?\\n}', 'm'));
    assert.ok(match, 'reviewed production function seam exists: ' + name);
    return match[0];
}
function productionIife(source, name) {
    const start = source.indexOf('(function ' + name + '()');
    const end = source.indexOf('\n})();', start);
    assert.ok(start >= 0 && end > start, 'reviewed production initializer exists: ' + name);
    return source.slice(start, end + '\n})();'.length);
}

function loadProduction() {
    const html = read('index.html'), source = read('tv-app.js');
    css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]).join('\n');
    bookmarkCss = read('layout-bookmarks.css');
    modules = Object.fromEntries(['channel-list', 'stream-performance', 'player-layout', 'player-geometry', 'layout-bookmarks']
        .map(name => ['/tv/' + name + '.js', read('' + name + '.js')]));
    const names = ['getGlobalMuted', 'updateGlobalAudioButton', 'getPlayerElement', 'disposePlayer', 'updatePlayerLayout',
        'playerGridArea', 'getCurrentPlayerGeometry', 'savePlayerEnlargement', 'getPlayerPositionKeys', 'syncActivePlayers',
        'capturePlayerBookmark', 'showLayoutBookmarkFeedback', 'applyPlayerBookmark', 'setChannelSelectionVisible'];
    appScript = names.map(name => productionFunction(source, name)).join('\n') + '\n' + productionIife(source, 'initLayoutBookmarks');
}

test.before(async () => {
    if (!enabled) return;
    let playwright;
    try { playwright = require('playwright'); }
    catch (_) { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
    assert.ok(['chromium', 'firefox'].includes(engine));
    const executablePath = process.env.UMININN_BROWSER_EXECUTABLE;
    const launch = executablePath ? { executablePath } : engine === 'chromium' ? { channel: 'chrome' } : {};
    browser = await playwright[engine].launch({ headless: true, ...launch });
    loadProduction();
    console.log(`Layout bookmark model: ${engine} ${browser.version()} (production UI/app/layout; local native and cross-origin media; all network intercepted).`);
});
test.after(async () => { await browser?.close(); });

const rate = 8000, samples = rate * 30, wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);

const instrument = `
function instrument(video){
 const actions={play:0,pause:0,load:0,source:0};
 for(const method of ['play','pause','load']){const original=video[method].bind(video);video[method]=function(...args){actions[method]++;return original(...args)}}
 new MutationObserver(records=>actions.source+=records.length).observe(video,{attributes:true,attributeFilter:['src']});
 video.fixtureActions=actions;
}
function readVideo(video){return {connected:video.isConnected,paused:video.paused,muted:video.muted,volume:video.volume,time:video.currentTime,src:video.currentSrc,actions:{...video.fixtureActions}}}
`;

function fixtureDocument({ width = 1100, height = 600, framePlatform = 'at' } = {}) {
    assert.ok(['at', 'kick', 'ok'].includes(framePlatform));
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${bookmarkCss}</style></head><body>
    <div id="top-bar"><div class="top-container"><div id="input-container">
      <button id="more-channels-btn" onclick="setChannelSelectionVisible(document.getElementById('channel-selection').style.display==='none')">📺 看更台</button>
      <button id="layout-bookmarks-btn" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="layout-bookmarks">🔖 書籤</button>
      <button id="outside" type="button">其他操作</button><button id="toggle-all-audio">聲音</button>
    </div></div></div>
    <div id="channel-selection" style="display:none"><p>未套用的選台草稿</p><div id="channel-options"></div></div>
    <section id="layout-bookmarks" role="dialog" aria-labelledby="layout-bookmarks-title" tabindex="-1" hidden></section>
    <p id="layout-bookmark-feedback" role="status" aria-live="polite" hidden></p>
    <div id="multi-stream-container-wrapper" style="flex:none;width:${width}px;max-width:100%;height:${height}px;min-height:0"><div id="multi-stream-container" class="video-wrapper"></div></div>
    ${Object.keys(modules).map(src => '<script src="' + src + '"></script>').join('')}
    <script>${instrument}
    let channels=[{id:'one',platform:'m3u8',name:'劇集一台'},{id:'two',platform:'${framePlatform}',name:'劇集二台'},{id:'three',platform:'${framePlatform}',name:'直播三台'},{id:'four',platform:'m3u8',name:'新聞四台'}];
    const activePlayers=new Map(),playerResources=new WeakMap();
    const PLAYER_POSITION_STORAGE_KEY='playerPositionOrder',PLAYER_ENLARGEMENT_STORAGE_KEY='playerEnlargementLayout';
    let preferredPlayerOrder=[],enlargedPlayerFocus=null,playerGeometry=null,pendingPlayerGeometry=null,playerGrid=null;
    let globalMutedPreference=null,currentDisplayChannel=null,currentHLSInstances=[],currentFLVInstances=[];
    let layoutBookmarkMenu=null,layoutBookmarkFeedbackTimer=null;
    const playerWindowControls={refresh(){}},playerNameOverlay={refresh(){},setVisible(){}};
    const playerPositionEditor={refresh(){},layoutChanged(){},close(){fixture.editorCloses++}};
    const channelSelectionIdleTimer={setVisible(){}};
    window.fixture={rendered:0,editorCloses:0,nextId:0,remembered:new Map()};
    function getPlatform(platform){return {type:platform==='m3u8'?'hls':'iframe'}}
    // This fixture has no userscript; its audio transaction branch is inactive.
    function playerLayoutAudioAvailable(){return false}
    function withPlayerAudioLayout(action){return action()}
    function showGlobalAudioFeedback(){}
    function updateChannelSelectionSummary(){}
    function renderChannelElement(channel,muted,wrapperClass){
       fixture.rendered++;
       const element=document.createElement(channel.platform==='m3u8'?'video':'iframe');element.id='fixture-player-'+fixture.nextId++;
       element.className=wrapperClass;
       if(element.tagName==='VIDEO'){
          element.muted=muted;element.loop=true;element.playsInline=true;instrument(element);element.src='/silent.wav?key='+encodeURIComponent(ChannelList.channelKey(channel));
          playerResources.set(element,{element,video:element,disposed:false,failed:false,hls:null,flv:null});
       }else{element.allow='autoplay';element.dataset.loads='0';element.dataset.srcWrites='0';
          element.addEventListener('load',()=>element.dataset.loads=String(Number(element.dataset.loads)+1));
          new MutationObserver(records=>element.dataset.srcWrites=String(Number(element.dataset.srcWrites)+records.length)).observe(element,{attributes:true,attributeFilter:['src']});
          element.src='${frameOrigin}/player?key='+encodeURIComponent(ChannelList.channelKey(channel));}
       return element;
    }
    ${appScript}
    fixture.keys=()=>getPlayerPositionKeys();
    fixture.geometry=()=>({keys:fixture.keys(),geometry:getCurrentPlayerGeometry(),focus:enlargedPlayerFocus,muted:getGlobalMuted(),renders:fixture.rendered});
    fixture.remember=function(keys=fixture.keys()){
      fixture.remembered=new Map(keys.map(key=>{const entry=activePlayers.get(key),element=getPlayerElement(entry);return [key,{entry,element,window:element.tagName==='IFRAME'?element.contentWindow:null}]}));
      return fixture.snapshot();
    };
    fixture.snapshot=()=>Array.from(fixture.remembered,([key,saved])=>{const live=activePlayers.get(key);return {key,sameEntry:live===saved.entry,sameElement:live&&getPlayerElement(live)===saved.element,connected:saved.element.isConnected,
      sameWindow:saved.window?saved.window===saved.element.contentWindow:null,loads:saved.element.dataset.loads,srcWrites:saved.element.dataset.srcWrites,
      media:saved.element.tagName==='VIDEO'?readVideo(saved.element):null}});
    fixture.setFocus=function(key,span=2){const next=PlayerGeometry.build({keys:fixture.keys(),columns:3,focus:{key,span,row:0,column:1}});enlargedPlayerFocus=next.items.find(item=>item.span>1);pendingPlayerGeometry={...next,intent:'drag'};updatePlayerLayout({force:true})};
    fixture.seedSelection=function(){const host=document.getElementById('channel-options');host.replaceChildren();for(const channel of channels){const input=document.createElement('input');input.type='checkbox';input.value=channel.id;input.dataset.platform=channel.platform;input.dataset.name=channel.name;input.checked=activePlayers.has(ChannelList.channelKey(channel));host.append(input)}};
    syncActivePlayers(channels);fixture.seedSelection();
    </script></body></html>`;
}

if (process.argv.includes('--export')) {
    loadProduction();
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'none'; media-src 'self'">`;
    const demo = `<script>
    fixture.setFocus(fixture.keys()[1]);
    const demoFirst=capturePlayerBookmark();
    layoutBookmarkMenu.store.add('夜更・劇集與直播',demoFirst);
    layoutBookmarkMenu.store.add('全部同屏',{...demoFirst,focus:null,columns:2});
    layoutBookmarkMenu.store.add('雙台精選',{channels:demoFirst.channels.slice(0,2),columns:2,focus:null,aspectRatio:16/9});
    layoutBookmarkMenu.open();
    </script>`;
    let html = fixtureDocument().replace('<head>', '<head>' + csp)
        .replace('</head>', '<style>#layout-bookmarks{top:66px;max-height:calc(100dvh - 80px)}</style></head>')
        .replaceAll('/tv/', '/site/assets/js/')
        .replaceAll(frameOrigin + '/player', '/work/layout-bookmarks-player.html')
        .replaceAll('/silent.wav', '/work/layout-bookmarks-silent.wav')
        .replace('button, panel, capture: capturePlayerBookmark', `button, panel, storage: (()=>{const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value))};})(), capture: capturePlayerBookmark`)
        .replace('<body>', '<body><p style="flex:none;margin:0;padding:6px 10px;font:12px sans-serif;background:#242424;color:#ddd">本機隔離測試：使用正式書籤 UI 與佈局程式；播放器為本機替身，沒有連接直播平台。</p>')
        .replace('</body>', demo + '</body>');
    const child = `<!doctype html><html><head>${csp}<meta charset="utf-8"></head><body style="margin:0;background:linear-gradient(135deg,#142c38,#103629);color:#cdd7dc;font:16px sans-serif"><p style="position:absolute;inset:30% 0;text-align:center">本機測試播放器</p><video muted playsinline loop autoplay src="/work/layout-bookmarks-silent.wav" style="width:100%;height:100%"></video></body></html>`;
    fs.writeFileSync(path.join(root, 'work/layout-bookmarks-qa.html'), html);
    fs.writeFileSync(path.join(root, 'work/layout-bookmarks-player.html'), child);
    fs.writeFileSync(path.join(root, 'work/layout-bookmarks-silent.wav'), wav);
    console.log('Exported closed demo: http://127.0.0.1:8767/work/layout-bookmarks-qa.html');
    process.exit(0);
}

async function fixture(t, options = {}) {
    const context = await browser.newContext({ viewport: options.viewport || { width: 1300, height: 900 }, serviceWorkers: 'block' });
    t.after(() => context.close());
    if (options.storage) await context.addInitScript(({ storage, origin }) => { if (location.origin === origin) for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value); }, { storage: options.storage, origin });
    const requests = [], errors = [], navigations = [];
    const child = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><video id="media" muted playsinline loop src="/silent.wav" style="width:100%;height:100%"></video><script>${instrument}window.fixtureDocumentId=crypto.randomUUID();instrument(document.getElementById('media'));</script></body></html>`;
    await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (request.isNavigationRequest()) {
            navigations.push(request.url());
            if (request.url() === siteUrl) return route.fulfill({ contentType: 'text/html', body: fixtureDocument(options) });
            if (url.origin === frameOrigin && url.pathname === '/player') return route.fulfill({ contentType: 'text/html', body: child });
        }
        if (url.origin === origin && modules[url.pathname]) return route.fulfill({ contentType: 'application/javascript', body: modules[url.pathname] });
        if ([origin, frameOrigin].includes(url.origin) && url.pathname === '/silent.wav') {
            const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range || ''), start = range ? Number(range[1]) : 0;
            const end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
            return route.fulfill({ status: range ? 206 : 200, contentType: 'audio/wav', body: wav.subarray(start, end + 1), headers: { 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${wav.length}` } : {}) } });
        }
        requests.push(request.url()); return route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(siteUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => activePlayers.size === 4 && [...activePlayers.values()].every(entry => entry.element.tagName === 'IFRAME' ? Number(entry.element.dataset.loads) === 1 : entry.element.readyState >= 2));
    const frames = page.frames().filter(frame => frame.url().startsWith(frameOrigin));
    assert.equal(frames.length, 2);
    await page.evaluate(async () => {
        for (const [index, entry] of [...activePlayers.values()].entries()) if (entry.resource?.video) {
            const video = entry.resource.video; video.volume = .17 + index * .1; video.currentTime = .2;
            if (index === 3) video.pause(); else await video.play();
        }
    });
    for (const [index, frame] of frames.entries()) await frame.evaluate(async index => {
        const video = document.getElementById('media'); await new Promise(resolve => video.readyState >= 2 ? resolve() : video.addEventListener('loadeddata', resolve, { once: true }));
        video.volume = .31 + index * .1; video.currentTime = .2; if (index) video.pause(); else await video.play();
    }, index);
    t.after(() => { assert.deepEqual(errors, [], 'no browser errors'); assert.deepEqual(requests, [], 'no external platform or asset request'); });
    return { page, frames, errors, requests, navigations };
}

async function remember(f, keys) {
    return { main: await f.page.evaluate(keys => fixture.remember(keys), keys), frames: await Promise.all(f.frames.map(frame => frame.isDetached() ? null : frame.evaluate(() => ({ id: fixtureDocumentId, media: readVideo(document.getElementById('media')) })))) };
}
const withoutTime = value => { const copy = structuredClone(value); if (copy.media) delete copy.media.time; return copy; };
async function assertContinuity(f, before) {
    const after = await f.page.evaluate(() => fixture.snapshot());
    assert.deepEqual(after.map(withoutTime), before.main.map(withoutTime));
    for (let i = 0; i < after.length; i++) if (before.main[i].media?.paused) assert.equal(after[i].media.time, before.main[i].media.time);
    for (const [index, frame] of f.frames.entries()) {
        if (frame.isDetached()) continue;
        const state = await frame.evaluate(() => ({ id: fixtureDocumentId, media: readVideo(document.getElementById('media')) }));
        assert.deepEqual(withoutTime(state), withoutTime(before.frames[index]));
        if (before.frames[index].media.paused) assert.equal(state.media.time, before.frames[index].media.time);
    }
}

test('capture uses actual visible order and enlarged geometry while leaving uncommitted channel selections alone', browserCase, async t => {
    const f = await fixture(t), keys = await f.page.evaluate(() => fixture.keys()), before = await remember(f);
    const snapshot = await f.page.evaluate(keys => {
        document.querySelector('#channel-options input').checked = false;
        getPlayerElement(activePlayers.get(keys[0])).style.order = '9';
        fixture.setFocus(keys[1]);
        return capturePlayerBookmark();
    }, keys);
    assert.deepEqual(snapshot.channels.map(channel => channel.key), [keys[2], keys[1], keys[3], keys[0]], 'the normal player at column zero precedes the reserved enlarged square');
    assert.deepEqual(snapshot.focus, { key: keys[1], span: 2, row: 0, column: 1 });
    assert.equal(snapshot.columns, 3);
    assert.equal(snapshot.aspectRatio, await f.page.locator('#multi-stream-container').evaluate(pane => pane.clientWidth / pane.clientHeight));
    assert.equal(await f.page.locator('#channel-options input').first().isChecked(), false);
    await assertContinuity(f, before);
});

test('applying a saved layout restores exact grid and order without reloading retained player documents or changing sound/pause', browserCase, async t => {
    const f = await fixture(t), keys = await f.page.evaluate(() => fixture.keys());
    const saved = await f.page.evaluate(keys => { fixture.setFocus(keys[1]); return capturePlayerBookmark(); }, keys);
    const before = await remember(f);
    const result = await f.page.evaluate(saved => {
        enlargedPlayerFocus = null; pendingPlayerGeometry = null;
        fixture.keys().reverse().forEach((key, index) => { getPlayerElement(activePlayers.get(key)).style.order = String(index); });
        updatePlayerLayout({ force: true });
        return applyPlayerBookmark(saved);
    }, saved);
    assert.deepEqual(result, { applied: 4, missing: 0 });
    const restored = await f.page.evaluate(() => capturePlayerBookmark());
    assert.deepEqual(restored, saved);
    assert.equal(await f.page.locator('#channel-options input:checked').count(), 4);
    await assertContinuity(f, before);
});

for (const framePlatform of ['kick', 'ok']) test(framePlatform + ': different selections remove only absent players and keep fallback iframe documents and sound stable across one-to-many', browserCase, async t => {
    const f = await fixture(t, { framePlatform }), keys = await f.page.evaluate(() => fixture.keys());
    const before = await remember(f, [keys[1]]);
    const single = { channels: [{ key: keys[1], name: '劇集二台' }], columns: 1, focus: null, aspectRatio: 1.5 };
    assert.deepEqual(await f.page.evaluate(saved => applyPlayerBookmark(saved), single), { applied: 1, missing: 0 });
    assert.deepEqual(await f.page.evaluate(() => fixture.keys()), [keys[1]]);
    assert.equal(await f.page.evaluate(() => getGlobalMuted()), true);
    await assertContinuity(f, before);
    const multiple = { ...single, channels: [{ key: keys[1], name: '劇集二台' }, { key: keys[3], name: '新聞四台' }], columns: 2 };
    assert.deepEqual(await f.page.evaluate(saved => applyPlayerBookmark(saved), multiple), { applied: 2, missing: 0 });
    assert.equal(await f.page.evaluate(() => getGlobalMuted()), true);
    await assertContinuity(f, before);
});

test('applying identical enlarged geometry at a new pane aspect resets its resize anchor before a tiny follow-up resize', browserCase, async t => {
    const f = await fixture(t), keys = await f.page.evaluate(() => fixture.keys());
    const saved = await f.page.evaluate(keys => { fixture.setFocus(keys[1]); return capturePlayerBookmark(); }, keys);
    const before = await remember(f);
    await f.page.evaluate(saved => {
        const host = document.getElementById('multi-stream-container-wrapper');
        host.style.width = '600px'; host.style.height = '850px';
        applyPlayerBookmark(saved);
    }, saved);
    // Observe beyond PlayerLayout's ResizeObserver debounce; the saved tracks
    // should now be anchored to the new pane, even though topology did not change.
    await f.page.waitForTimeout(200);
    assert.equal(await f.page.evaluate(() => getCurrentPlayerGeometry().columns), saved.columns);
    await f.page.evaluate(() => { document.getElementById('multi-stream-container-wrapper').style.width = '601px'; });
    await f.page.waitForTimeout(200);
    assert.equal(await f.page.evaluate(() => getCurrentPlayerGeometry().columns), saved.columns);
    assert.equal(await f.page.evaluate(() => enlargedPlayerFocus.key), saved.focus.key);
    await assertContinuity(f, before);
});

test('missing channels are reported, removed enlarged focus becomes normal, and entirely invalid bookmarks preserve current playback', browserCase, async t => {
    const f = await fixture(t), keys = await f.page.evaluate(() => fixture.keys());
    const saved = await f.page.evaluate(keys => { fixture.setFocus(keys[1]); return capturePlayerBookmark(); }, keys);
    await f.page.evaluate(key => { channels = channels.filter(channel => ChannelList.channelKey(channel) !== key); }, keys[1]);
    const result = await f.page.evaluate(saved => applyPlayerBookmark(saved), saved);
    assert.deepEqual(result, { applied: 3, missing: 1 });
    assert.equal(await f.page.evaluate(() => enlargedPlayerFocus), null);
    assert.match(await f.page.locator('#layout-bookmark-feedback').innerText(), /略過 1/);
    const before = await remember(f);
    for (const invalid of [
        { channels: [], columns: 1, focus: null },
        { channels: [{ key: 'twitch|gone', name: 'Removed' }], columns: 1, focus: null },
        { ...saved, columns: 1 }
    ]) {
        assert.equal(await f.page.evaluate(invalid => { try { applyPlayerBookmark(invalid); return false; } catch (_) { return true; } }, invalid), true);
        await assertContinuity(f, before);
    }
});

test('bookmark menu and channel menu close one another, Escape returns focus, and inactivity closes without changing players', browserCase, async t => {
    const f = await fixture(t), before = await remember(f);
    await f.page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await f.page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
    await f.page.locator('#more-channels-btn').click();
    assert.equal(await f.page.locator('#channel-selection').isVisible(), true);
    await f.page.locator('#layout-bookmarks-btn').click();
    assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), true);
    assert.equal(await f.page.locator('#channel-selection').isVisible(), false);
    await f.page.clock.fastForward(29999);
    assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), true);
    await f.page.clock.fastForward(1);
    assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), false);
    await f.page.locator('#layout-bookmarks-btn').click();
    await f.page.keyboard.press('Escape');
    assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), false);
    assert.equal(await f.page.locator('#layout-bookmarks-btn').evaluate(element => element === document.activeElement), true);
    await f.page.locator('#layout-bookmarks-btn').click();
    await f.page.locator('#more-channels-btn').click();
    assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), false);
    assert.equal(await f.page.locator('#channel-selection').isVisible(), true);
    await assertContinuity(f, before);
});

test('bookmark menu dismisses on repeated foreign player clicks without consuming input or changing playback', browserCase, async t => {
    const f = await fixture(t, { viewport: { width: 1800, height: 1000 } }), before = await remember(f);
    const navigations = [...f.navigations], trigger = f.page.locator('#layout-bookmarks-btn');
    for (const frame of f.frames) await frame.evaluate(() => {
        window.fixturePlayerClicks = [];
        document.addEventListener('pointerdown', event => fixturePlayerClicks.push({ type: event.type, trusted: event.isTrusted }));
        document.addEventListener('click', event => fixturePlayerClicks.push({ type: event.type, trusted: event.isTrusted }));
    });
    for (const index of [0, 0, 1]) {
        await trigger.focus(); await f.page.keyboard.press('Enter');
        assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), true);
        await f.frames[index].locator('#media').click({ position: { x: 24, y: 24 } });
        await f.page.waitForFunction(() => !layoutBookmarkMenu.isOpen());
        assert.equal(await f.page.evaluate(() => document.activeElement?.tagName), 'IFRAME');
        await assertContinuity(f, before);
    }
    assert.deepEqual(await f.frames[0].evaluate(() => fixturePlayerClicks), Array.from({ length: 2 }, () => [
        { type: 'pointerdown', trusted: true }, { type: 'click', trusted: true }
    ]).flat());
    assert.deepEqual(await f.frames[1].evaluate(() => fixturePlayerClicks), [
        { type: 'pointerdown', trusted: true }, { type: 'click', trusted: true }
    ]);
    await trigger.focus(); await f.page.keyboard.press('Enter');
    await f.page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await f.page.waitForTimeout(40);
    assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), true, 'blur without a focused player must not close the menu');
    await f.page.locator('#outside').click();
    assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), false);
    await f.page.evaluate(() => {
        const hasFocus = document.hasFocus.bind(document); window.fixtureFocusChecks = 0;
        document.hasFocus = () => { fixtureFocusChecks++; return hasFocus(); };
    });
    await trigger.click(); await f.page.waitForTimeout(450);
    const checks = await f.page.evaluate(() => fixtureFocusChecks);
    assert.ok(checks >= 2 && checks < 8, 'only a few whole-document focus checks run while the menu is open');
    await f.page.locator('.layout-bookmarks-close').click(); await f.page.waitForTimeout(30);
    const stopped = await f.page.evaluate(() => fixtureFocusChecks);
    await f.page.waitForTimeout(450);
    assert.equal(await f.page.evaluate(() => fixtureFocusChecks), stopped, 'focus sampling stops when the bookmark menu closes');
    assert.deepEqual(f.navigations, navigations);
    await assertContinuity(f, before);
});

test('save, rename, reopen, delete and undo use real controls with stable colours and safe text-only names', browserCase, async t => {
    const f = await fixture(t), before = await remember(f);
    await f.page.locator('#layout-bookmarks-btn').click();
    await f.page.locator('.layout-bookmarks-save').click();
    assert.equal(await f.page.locator('.layout-bookmark-card').count(), 1);
    assert.equal(await f.page.locator('.layout-bookmark-cell').count(), 4);
    const colours = await f.page.locator('.layout-bookmark-cell').evaluateAll(cells => cells.map(cell => cell.style.getPropertyValue('--bookmark-hue')));
    const name = '<img src=x onerror="window.bookmarkXss=true"> & 夜更';
    await f.page.locator('.layout-bookmark-rename').click();
    await f.page.locator('.layout-bookmark-name-input').fill('  ' + name + '  ');
    await f.page.locator('.layout-bookmark-name-input').press('Enter');
    assert.equal(await f.page.locator('.layout-bookmark-name').innerText(), name);
    assert.equal(await f.page.locator('#layout-bookmarks img,#layout-bookmarks script').count(), 0);
    assert.equal(await f.page.evaluate(() => Boolean(window.bookmarkXss)), false);
    await f.page.locator('.layout-bookmarks-close').click();
    await f.page.locator('#layout-bookmarks-btn').click();
    assert.equal(await f.page.locator('.layout-bookmark-name').innerText(), name);
    assert.deepEqual(await f.page.locator('.layout-bookmark-cell').evaluateAll(cells => cells.map(cell => cell.style.getPropertyValue('--bookmark-hue'))), colours);
    await f.page.locator('.layout-bookmark-delete').click();
    assert.equal(await f.page.locator('.layout-bookmark-card').count(), 0);
    await f.page.getByRole('button', { name: '復原刪除', exact: true }).click();
    assert.equal(await f.page.locator('.layout-bookmark-card').count(), 1);
    assert.equal(await f.page.locator('.layout-bookmark-name').innerText(), name);
    assert.deepEqual(await f.page.locator('.layout-bookmark-cell').evaluateAll(cells => cells.map(cell => cell.style.getPropertyValue('--bookmark-hue'))), colours);
    assert.equal(await f.page.locator('.layout-bookmark-preview').evaluate(element => element === document.activeElement), true, 'undo returns keyboard focus to the restored bookmark');
    await assertContinuity(f, before);
});

test('updating an existing bookmark captures the current enlarged layout while keeping its name, colours and keyboard focus', browserCase, async t => {
    const f = await fixture(t), before = await remember(f), keys = await f.page.evaluate(() => fixture.keys());
    await f.page.locator('#layout-bookmarks-btn').click();
    await f.page.locator('.layout-bookmarks-save').click();
    const original = await f.page.evaluate(() => layoutBookmarkMenu.store.list()[0]);
    await f.page.evaluate(keys => { fixture.setFocus(keys[1]); document.querySelector('#channel-options input').checked = false; }, keys);
    await f.page.locator('.layout-bookmark-update').click();
    const updated = await f.page.evaluate(() => layoutBookmarkMenu.store.list()[0]);
    assert.equal(updated.name, original.name);
    assert.equal(updated.id, original.id);
    assert.deepEqual(updated.snapshot.focus, { key: keys[1], span: 2, row: 0, column: 1 });
    assert.equal(updated.snapshot.channels.length, 4, 'an unrelated unchecked selection draft is not a playback change');
    const oldColours = new Map(original.snapshot.channels.map(channel => [channel.key, channel.color]));
    assert.ok(updated.snapshot.channels.every(channel => channel.color === oldColours.get(channel.key)));
    assert.equal(await f.page.locator('.layout-bookmark-update').evaluate(element => element === document.activeElement), true);
    await assertContinuity(f, before);
});

test('preview is a faithful miniature of the saved enlarged grid and applying it closes the panel', browserCase, async t => {
    const f = await fixture(t), keys = await f.page.evaluate(() => fixture.keys());
    await f.page.evaluate(keys => fixture.setFocus(keys[1]), keys);
    const saved = await f.page.evaluate(() => capturePlayerBookmark()), before = await remember(f);
    await f.page.locator('#layout-bookmarks-btn').click();
    await f.page.locator('.layout-bookmarks-save').click();
    const preview = await f.page.locator('.layout-bookmark-preview').evaluate(element => ({
        columns: element.style.gridTemplateColumns,
        rows: element.style.gridTemplateRows,
        cells: [...element.children].map(cell => ({ name: cell.textContent, area: cell.style.gridArea }))
    }));
    const expected = await f.page.evaluate(saved => PlayerGeometry.build({ keys: saved.channels.map(channel => channel.key), columns: saved.columns, focus: saved.focus }), saved);
    assert.equal(preview.columns, 'repeat(' + expected.columns + ', minmax(0px, 1fr))');
    assert.equal(preview.rows, 'repeat(' + expected.rows + ', minmax(0px, 1fr))');
    for (const channel of saved.channels) {
        const item = expected.items.find(item => item.key === channel.key);
        assert.equal(preview.cells.find(cell => cell.name === channel.name).area, `${item.row + 1} / ${item.column + 1} / span ${item.span} / span ${item.span}`);
    }
    await f.page.evaluate(() => { enlargedPlayerFocus = null; pendingPlayerGeometry = null; updatePlayerLayout({ force: true }); });
    await f.page.locator('.layout-bookmark-preview').click();
    await f.page.waitForFunction(() => document.getElementById('layout-bookmarks').hidden);
    assert.deepEqual(await f.page.evaluate(() => capturePlayerBookmark()), saved);
    await assertContinuity(f, before);
});

test('a trusted edit restarts the complete idle interval while synthetic activity and background storage refresh do not', browserCase, async t => {
    const f = await fixture(t), before = await remember(f);
    await f.page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await f.page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
    await f.page.locator('#layout-bookmarks-btn').click();
    await f.page.locator('.layout-bookmarks-save').click();
    await f.page.clock.fastForward(29000);
    await f.page.locator('.layout-bookmark-rename').click();
    await f.page.locator('.layout-bookmark-name-input').fill('夜更');
    await f.page.clock.fastForward(29999);
    assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), true);
    await f.page.clock.fastForward(1);
    assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), false);
    await f.page.locator('#layout-bookmarks-btn').click();
    await f.page.clock.fastForward(29000);
    await f.page.evaluate(() => {
        document.getElementById('layout-bookmarks').dispatchEvent(new Event('pointermove', { bubbles: true }));
        window.dispatchEvent(new StorageEvent('storage', { key: 'umininn.layoutBookmarks.v1', storageArea: localStorage }));
    });
    await f.page.clock.fastForward(999);
    assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), true);
    await f.page.clock.fastForward(1);
    assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), false);
    await assertContinuity(f, before);
});

test('rename Escape cancels the draft first; blank names and quota errors remain visible without applying or losing playback', browserCase, async t => {
    const f = await fixture(t), before = await remember(f);
    await f.page.locator('#layout-bookmarks-btn').click();
    await f.page.locator('.layout-bookmarks-save').click();
    const originalName = await f.page.locator('.layout-bookmark-name').innerText();
    await f.page.locator('.layout-bookmark-rename').click();
    await f.page.locator('.layout-bookmark-name-input').fill(' ');
    await f.page.locator('.layout-bookmark-name-input').press('Enter');
    assert.equal(await f.page.locator('.layout-bookmark-name-input').isVisible(), true);
    assert.equal(await f.page.locator('.layout-bookmarks-status.is-error').isVisible(), true);
    await f.page.locator('.layout-bookmark-name-input').press('Escape');
    assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), true);
    assert.equal(await f.page.locator('.layout-bookmark-name-input').count(), 0);
    assert.equal(await f.page.locator('.layout-bookmark-name').innerText(), originalName);
    await f.page.evaluate(() => { Storage.prototype.setItem = function() { throw new DOMException('Fixture quota reached', 'QuotaExceededError'); }; });
    await f.page.locator('.layout-bookmarks-save').click();
    assert.equal(await f.page.locator('.layout-bookmarks-status.is-error').isVisible(), true);
    assert.equal(await f.page.locator('.layout-bookmark-card').count(), 1);
    assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), true);
    await assertContinuity(f, before);
});

test('mobile panel and preview stay within the viewport with many long channel names and an enlarged tile', browserCase, async t => {
    const f = await fixture(t, { viewport: { width: 375, height: 667 }, width: 375, height: 330 });
    await f.page.evaluate(() => {
        for (const [index, entry] of [...activePlayers.values()].entries()) entry.channel.name = index + '很長的台名稱'.repeat(30);
        fixture.setFocus(fixture.keys()[1]);
    });
    await f.page.locator('#layout-bookmarks-btn').click();
    await f.page.locator('.layout-bookmarks-save').click();
    const bounds = await f.page.locator('#layout-bookmarks').evaluate(panel => {
        const rect = panel.getBoundingClientRect(), preview = panel.querySelector('.layout-bookmark-preview').getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight,
            overflow: panel.scrollWidth - panel.clientWidth, previewLeft: preview.left, previewRight: preview.right };
    });
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 1, JSON.stringify(bounds));
    assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height + 1, JSON.stringify(bounds));
    assert.ok(bounds.overflow <= 1, JSON.stringify(bounds));
    assert.ok(bounds.previewLeft >= bounds.left && bounds.previewRight <= bounds.right, JSON.stringify(bounds));
    assert.equal(await f.page.locator('.layout-bookmark-cell').count(), 4);
});
