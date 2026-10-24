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
let browser, playwrightRuntime, css, bookmarkCss, appScript, modules;
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
    modules = Object.fromEntries(['channel-list', 'stream-performance', 'player-layout', 'player-geometry', 'menu-dismiss', 'layout-bookmarks']
        .map(name => ['/tv/' + name + '.js', read('' + name + '.js')]));
    const names = ['getGlobalMuted', 'updateGlobalAudioButton', 'getPlayerElement', 'disposePlayer', 'projectPlayerLayout', 'calculatePlayerLayout', 'updatePlayerLayout',
        'playerGridArea', 'getCurrentPlayerGeometry', 'savePlayerEnlargement', 'getPlayerPositionKeys', 'syncActivePlayers',
        'playerBookmarkAudioAvailable', 'capturePlayerBookmark', 'showLayoutBookmarkFeedback', 'applyPlayerBookmark', 'setChannelSelectionVisible'];
    appScript = names.map(name => productionFunction(source, name)).join('\n') + '\n' + productionIife(source, 'initLayoutBookmarks')
        .replace('capture: capturePlayerBookmark', 'capture: (...args)=>{fixture.captures++;return capturePlayerBookmark(...args)}')
        .replace('apply: applyPlayerBookmark', 'apply: (...args)=>{fixture.applies++;return applyPlayerBookmark(...args)}');
}

test.before(async () => {
    if (!enabled) return;
    let playwright;
    try { playwright = require('playwright'); }
    catch (_) { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
    playwrightRuntime = playwright;
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
    const playerLayoutState=PlayerLayout.createState({buildGeometry:PlayerGeometry.build});
    const playerLayoutOperations=PlayerLayout.createOperations({geometry:PlayerGeometry});let playerGrid=null;
    let globalMutedPreference=null,currentDisplayChannel=null,currentHLSInstances=[],currentFLVInstances=[];
    let layoutBookmarkMenu=null,layoutBookmarkFeedbackTimer=null;
    const playerWindowControls={refresh(){}},playerNameOverlay={refresh(){},setVisible(){}};
    const playerPositionEditor={refresh(){},layoutChanged(){},close(){fixture.editorCloses++}};
    const channelSelectionIdleTimer={setVisible(){}};
    window.fixture={rendered:0,editorCloses:0,nextId:0,remembered:new Map(),captures:0,applies:0};
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
    fixture.geometry=()=>({keys:fixture.keys(),geometry:getCurrentPlayerGeometry(),focus:playerLayoutState.focus,muted:getGlobalMuted(),renders:fixture.rendered});
    fixture.remember=function(keys=fixture.keys()){
      fixture.remembered=new Map(keys.map(key=>{const entry=activePlayers.get(key),element=getPlayerElement(entry);return [key,{entry,element,window:element.tagName==='IFRAME'?element.contentWindow:null}]}));
      return fixture.snapshot();
    };
    fixture.snapshot=()=>Array.from(fixture.remembered,([key,saved])=>{const live=activePlayers.get(key);return {key,sameEntry:live===saved.entry,sameElement:live&&getPlayerElement(live)===saved.element,connected:saved.element.isConnected,
      sameWindow:saved.window?saved.window===saved.element.contentWindow:null,loads:saved.element.dataset.loads,srcWrites:saved.element.dataset.srcWrites,
      media:saved.element.tagName==='VIDEO'?readVideo(saved.element):null}});
    fixture.setFocus=function(key,span=2){const next=PlayerGeometry.build({keys:fixture.keys(),columns:3,focus:{key,span,row:0,column:1}});playerLayoutState.setFocus(next.items.find(item=>item.span>1));playerLayoutState.setPending({...next,intent:'drag'});updatePlayerLayout({force:true})};
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
    const context = await (options.fixtureBrowser || browser).newContext({ viewport: options.viewport || { width: 1300, height: 900 }, serviceWorkers: 'block' });
    t.after(() => context.close());
    if (options.storage) await context.addInitScript(({ storage, origin }) => { if (location.origin === origin) for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value); }, { storage: options.storage, origin });
    const requests = [], errors = [], navigations = [];
    const child = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><video id="media" muted playsinline loop src="/silent.wav" style="width:100%;height:100%"></video><script>${instrument}window.fixtureDocumentId=crypto.randomUUID();instrument(document.getElementById('media'));</script></body></html>`;
    const chat = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:8px;font:16px sans-serif"><form id="chat-form"><input id="chat-input" aria-label="聊天訊息" value="保留草稿"><button type="submit">傳送</button></form><p id="chat-message">聊天室訊息，點選時不應攔截原有操作。</p><div style="height:800px"></div><script>window.fixtureChatClicks=0;window.fixtureChatSubmits=0;document.getElementById('chat-message').addEventListener('click',()=>fixtureChatClicks++);document.getElementById('chat-form').addEventListener('submit',event=>{event.preventDefault();fixtureChatSubmits++});</script></body></html>`;
    await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (request.isNavigationRequest()) {
            navigations.push(request.url());
            if (request.url() === siteUrl) return route.fulfill({ contentType: 'text/html', body: fixtureDocument(options) });
            if (url.origin === frameOrigin && url.pathname === '/player') return route.fulfill({ contentType: 'text/html', body: child });
            if ([origin, frameOrigin].includes(url.origin) && url.pathname === '/chat-fixture') return route.fulfill({ contentType: 'text/html', body: chat });
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

test('capture uses authoritative visual order and enlarged geometry while leaving uncommitted channel selections alone', browserCase, async t => {
    const f = await fixture(t), keys = await f.page.evaluate(() => fixture.keys()), before = await remember(f);
    const snapshot = await f.page.evaluate(keys => {
        document.querySelector('#channel-options input').checked = false;
        playerLayoutState.setOrder(keys.slice(1).concat(keys[0]));
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
        playerLayoutState.setFocus(null); playerLayoutState.setPending(null);
        playerLayoutState.setOrder(fixture.keys().reverse());
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
    assert.equal(await f.page.evaluate(() => playerLayoutState.focus.key), saved.focus.key);
    await assertContinuity(f, before);
});

test('missing channels are reported, removed enlarged focus becomes normal, and entirely invalid bookmarks preserve current playback', browserCase, async t => {
    const f = await fixture(t), keys = await f.page.evaluate(() => fixture.keys());
    const saved = await f.page.evaluate(keys => { fixture.setFocus(keys[1]); return capturePlayerBookmark(); }, keys);
    await f.page.evaluate(key => { channels = channels.filter(channel => ChannelList.channelKey(channel) !== key); }, keys[1]);
    const result = await f.page.evaluate(saved => applyPlayerBookmark(saved), saved);
    assert.deepEqual(result, { applied: 3, missing: 1 });
    assert.equal(await f.page.evaluate(() => playerLayoutState.focus), null);
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
        // Browser-native media hit targets can consume DOM pointer events; a
        // separate test below covers those controls. Use a real document button
        // here to measure delivery of an ordinary foreign-player gesture.
        const surface = document.createElement('button'); surface.id = 'fixture-player-surface'; surface.type = 'button';
        surface.textContent = '播放器範圍'; surface.style.cssText = 'position:absolute;left:8px;top:8px;'; document.body.appendChild(surface);
        window.fixturePlayerClicks = [];
        document.addEventListener('pointerdown', event => fixturePlayerClicks.push({ type: event.type, trusted: event.isTrusted }));
        document.addEventListener('click', event => fixturePlayerClicks.push({ type: event.type, trusted: event.isTrusted }));
    });
    for (const index of [0, 0, 1]) {
        await trigger.focus(); await f.page.keyboard.press('Enter');
        assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), true);
        // Let the foreign frame paint the dynamically inserted hit target before
        // sending the click; a warm Chromium compositor can otherwise route it
        // to the old media surface. Preserve real input and exact event counts.
        await f.frames[index].locator('#fixture-player-surface').hover();
        await f.frames[index].evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
        await f.frames[index].locator('#fixture-player-surface').click();
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

for (const chatOrigin of [origin, frameOrigin]) test('bookmark menu dismisses on ' + (chatOrigin === origin ? 'same-origin custom' : 'foreign official') + ' chat input and message clicks without stealing focus or sending a message', browserCase, async t => {
    const f = await fixture(t), before = await remember(f);
    await f.page.evaluate(src => {
        const chat = document.createElement('iframe'); chat.id = 'chat_embed'; chat.title = '聊天室測試';
        chat.style.cssText = 'position:fixed;left:8px;bottom:8px;width:340px;height:170px;z-index:2;background:white;';
        chat.src = src; document.body.appendChild(chat);
    }, chatOrigin + '/chat-fixture');
    const chat = f.page.frameLocator('#chat_embed'), input = chat.locator('#chat-input');
    await input.waitFor({ state: 'visible' });
    const navigations = [...f.navigations], trigger = f.page.locator('#layout-bookmarks-btn');
    // Compare the real driver focus handoff with an unrelated parent button
    // first. Firefox's headless driver can leave the child's body focused on
    // iframe re-entry even with every menu closed; dismissal must preserve the
    // same result. Chromium browsers also require actual input focus/typing.
    await f.page.locator('#outside').click();
    await input.click();
    const baselineFocus = await input.evaluate(element => element.ownerDocument.activeElement === element);
    await f.page.keyboard.press('End'); await f.page.keyboard.type('測');
    const baselineText = await input.inputValue();
    if (engine !== 'firefox') {
        assert.equal(baselineFocus, true, 'driver baseline must focus the chat input');
        assert.equal(baselineText, '保留草稿測', 'keyboard input reaches the chat draft');
    }
    await input.evaluate(element => { element.value = '保留草稿'; });
    for (const target of [input, chat.locator('#chat-message'), input]) {
        await trigger.click();
        assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), true);
        await target.click();
        await f.page.waitForFunction(() => !layoutBookmarkMenu.isOpen());
        assert.equal(await f.page.evaluate(() => document.activeElement?.id), 'chat_embed', 'closing must leave the clicked chat frame focused');
        if (target === input) {
            assert.equal(await input.evaluate(element => element.ownerDocument.activeElement === element), baselineFocus, 'menu dismissal preserves the browser input-focus policy');
            await f.page.keyboard.press('End'); await f.page.keyboard.type('測');
            assert.equal(await input.inputValue(), baselineText, 'typing after dismissal matches ordinary parent-to-chat interaction');
            await input.evaluate(element => { element.value = '保留草稿'; });
        }
        assert.equal(await input.inputValue(), '保留草稿', 'a menu close must not erase or submit a draft');
        await assertContinuity(f, before);
    }
    assert.deepEqual(await chat.locator('body').evaluate(() => ({ clicks: fixtureChatClicks, submits: fixtureChatSubmits })), { clicks: 1, submits: 0 });
    assert.deepEqual(f.navigations, navigations, 'chat interaction and menu dismissal must not navigate or reload any frame');
});

test('bookmark menu handles actual native chat viewport and inner scrollbar gestures while its own scrollbar remains usable', { skip: !enabled, timeout: 90000 }, async t => {
    const native = await playwrightRuntime[engine].launch({ headless: engine !== 'firefox',
        ...(process.env.UMININN_BROWSER_EXECUTABLE ? { executablePath: process.env.UMININN_BROWSER_EXECUTABLE } : engine === 'chromium' ? { channel: 'chrome' } : {}),
        ...(engine === 'firefox' ? { firefoxUserPrefs: { 'widget.windows.overlay-scrollbars.enabled': false, 'ui.useOverlayScrollbars': 0,
            'widget.non-native-theme.scrollbar.style': 4, 'widget.non-native-theme.scrollbar.size.override': 17 } } : { ignoreDefaultArgs: ['--hide-scrollbars'] }) });
    t.after(() => native.close());
    const f = await fixture(t, { fixtureBrowser: native }), before = await remember(f);
    await f.page.evaluate(src => {
        const chat = document.createElement('iframe'); chat.id = 'chat_embed'; chat.title = '原生捲軸測試';
        chat.style.cssText = 'position:fixed;left:8px;bottom:8px;width:420px;height:240px;z-index:2;background:white;border:0';
        chat.src = src; document.body.appendChild(chat);
    }, origin + '/chat-fixture');
    const chat = f.page.frameLocator('#chat_embed'); await chat.locator('#chat-input').waitFor();
    const child = f.page.frames().find(frame => frame.url() === origin + '/chat-fixture'); assert.ok(child);
    await child.evaluate(() => {
        const style = document.createElement('style'); style.textContent = 'html{overflow:scroll;scroll-behavior:auto}body{min-width:850px}#inner-chat-scroll{width:320px;height:100px;overflow:scroll}'; document.head.appendChild(style);
        const pane = document.createElement('div'); pane.id = 'inner-chat-scroll'; pane.innerHTML = '<div style="width:900px;height:700px">內層聊天訊息</div>'; document.getElementById('chat-message').after(pane);
        window.chatNativePointers = [];
        window.addEventListener('pointerdown', event => chatNativePointers.push({ target: event.target.id || event.target.tagName, trusted: event.isTrusted }), true);
    });
    const gutters = await child.evaluate(() => ({ vertical: innerWidth - document.documentElement.clientWidth, horizontal: innerHeight - document.documentElement.clientHeight,
        innerVertical: document.getElementById('inner-chat-scroll').offsetWidth - document.getElementById('inner-chat-scroll').clientWidth }));
    for (const [axis, size] of Object.entries(gutters)) assert.ok(size >= 10, `visible native ${axis} scrollbar required, got ${size}px`);
    t.diagnostic(JSON.stringify({ engine, menu: 'bookmark', gutters, firefoxHeaded: engine === 'firefox' }));
    const trigger = f.page.locator('#layout-bookmarks-btn');
    for (const mode of ['track', 'thumb', 'top-boundary-button', 'horizontal-track', 'inner-track', 'inner-thumb']) {
        await child.evaluate(() => { scrollTo(0, 0); const inner = document.getElementById('inner-chat-scroll'); inner.scrollTop = inner.scrollLeft = 0; chatNativePointers = []; });
        await trigger.click(); assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), true);
        await child.evaluate(() => { scrollTo(0, 5); scrollTo(0, 0); });
        await f.page.waitForTimeout(250); assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), true, 'background chat scrolling does not dismiss');
        const rootBox = await f.page.locator('#chat_embed').boundingBox(), box = mode.startsWith('inner') ? await chat.locator('#inner-chat-scroll').boundingBox() : rootBox;
        let x = box.x + box.width - gutters.vertical / 2, y = box.y + box.height * .72;
        if (mode === 'horizontal-track') { x = box.x + box.width * .72; y = box.y + box.height - gutters.horizontal / 2; }
        if (mode.includes('thumb')) y = box.y + 26;
        if (mode === 'top-boundary-button') y = box.y + 7;
        await f.page.mouse.move(x, y); await f.page.mouse.down();
        if (mode.includes('thumb')) await f.page.mouse.move(x, y + (mode.startsWith('inner') ? 40 : 100), { steps: 6 });
        await f.page.mouse.up(); await f.page.waitForFunction(() => !layoutBookmarkMenu.isOpen()); await f.page.waitForTimeout(250);
        const state = await child.evaluate(() => ({ top: scrollY, left: scrollX, inner: document.getElementById('inner-chat-scroll').scrollTop, pointers: chatNativePointers, submits: fixtureChatSubmits }));
        assert.equal(state.pointers.length, 1, mode + ': trusted native input delivered once'); assert.equal(state.pointers[0].trusted, true);
        if (mode === 'track' || mode === 'thumb') assert.ok(state.top > 0, 'viewport scrollbar actually moves');
        if (mode === 'horizontal-track') assert.ok(state.left > 0, 'horizontal track actually moves');
        if (mode.startsWith('inner')) assert.ok(state.inner > 0, 'inner scrollbar actually moves');
        if (mode === 'top-boundary-button') assert.equal(state.top, 0, 'boundary input closes even without scrolling');
        assert.equal(state.submits, 0); assert.equal(await chat.locator('#chat-input').inputValue(), '保留草稿');
        await assertContinuity(f, before);
    }
    await trigger.click();
    const panel = f.page.locator('#layout-bookmarks');
    await panel.evaluate(panel => { panel.style.cssText += ';height:180px;overflow-y:scroll;scrollbar-width:auto;scroll-behavior:auto'; const spacer = document.createElement('div'); spacer.style.height = '1000px'; panel.appendChild(spacer); });
    const ownWidth = await panel.evaluate(panel => panel.offsetWidth - panel.clientWidth - parseFloat(getComputedStyle(panel).borderLeftWidth) - parseFloat(getComputedStyle(panel).borderRightWidth));
    // The site's themed WebKit scrollbar is deliberately narrower than the
    // operating-system chat bars above. Require a real gutter and actual drag.
    assert.ok(ownWidth > 0, 'the menu has a real visible scrollbar');
    t.diagnostic(JSON.stringify({ ownBookmarkScrollbarWidth: ownWidth }));
    await panel.evaluate(panel => { panel.scrollTop = 0; }); await f.page.waitForTimeout(100);
    const ownBox = await panel.boundingBox(), ownX = ownBox.x + ownBox.width - ownWidth / 2 - 1;
    await f.page.mouse.move(ownX, ownBox.y + 24); await f.page.mouse.down(); await f.page.mouse.move(ownX, ownBox.y + 115, { steps: 8 }); await f.page.mouse.up();
    await f.page.waitForTimeout(250); assert.equal(await panel.isVisible(), true, 'the menu scrollbar is inside the menu');
    assert.ok(await panel.evaluate(panel => panel.scrollTop) > 0, 'the own-menu scrollbar remains functional');
    await assertContinuity(f, before);
});

test('bookmark menu dismisses when native media controls consume pointer events while scripted playback leaves it open', browserCase, async t => {
    const f = await fixture(t, { viewport: { width: 1800, height: 1000 } });
    const keys = await f.page.evaluate(() => fixture.keys()), trigger = f.page.locator('#layout-bookmarks-btn');
    const video = f.page.locator('#fixture-player-0');
    await video.evaluate(video => { video.controls = true; });
    await trigger.click();
    await video.evaluate(video => video.pause());
    await f.page.waitForTimeout(250);
    assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), true, 'background pause is not an outside interaction');
    await video.evaluate(video => video.play());
    await f.page.waitForTimeout(250);
    assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), true, 'recovery or background playback cannot close the menu');
    const before = await remember(f, keys.slice(1));
    const targetBefore = await video.evaluate(video => {
        window.fixtureNativeControlEvents = [];
        window.fixtureNativeControlPointers = [];
        for (const type of ['play', 'pause']) video.addEventListener(type, event => fixtureNativeControlEvents.push({ type, trusted: event.isTrusted }));
        for (const type of ['pointerdown', 'mousedown', 'click']) document.addEventListener(type, event => {
            if (event.target === video) fixtureNativeControlPointers.push({ type, trusted: event.isTrusted });
        }, true);
        return readVideo(video);
    });
    for (const paused of [true, false]) {
        if (!await f.page.locator('#layout-bookmarks').isVisible()) await trigger.click();
        const bounds = await video.boundingBox();
        assert.ok(bounds && bounds.width > 100 && bounds.height > 100);
        // Trusted input reaches the browser's real media-control shadow tree.
        // Chromium consumes its pointer events instead of exposing them to this page.
        await f.page.mouse.click(bounds.x + 25, bounds.y + bounds.height - 25);
        await f.page.waitForFunction(paused => document.getElementById('fixture-player-0').paused === paused, paused);
        await f.page.waitForFunction(() => !layoutBookmarkMenu.isOpen());
        assert.equal(await video.evaluate(video => document.activeElement === video), true, 'the clicked media keeps focus after dismissal');
        await assertContinuity(f, before);
    }
    assert.deepEqual(await f.page.evaluate(() => fixtureNativeControlEvents), [
        { type: 'pause', trusted: true }, { type: 'play', trusted: true }
    ], 'each native control click operates playback exactly once');
    if (engine === 'chromium') assert.deepEqual(await f.page.evaluate(() => fixtureNativeControlPointers), [], 'the regression exercises native controls that hide pointer events from document capture');
    const targetAfter = await video.evaluate(video => readVideo(video));
    for (const key of ['connected', 'paused', 'muted', 'volume', 'src', 'actions']) assert.deepEqual(targetAfter[key], targetBefore[key], 'dismissal neither reloads nor scripts an extra media action: ' + key);
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
    await f.page.evaluate(() => { playerLayoutState.setFocus(null); playerLayoutState.setPending(null); updatePlayerLayout({ force: true }); });
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

async function localDeleteConfirmation(page, count) {
    await page.locator('.layout-bookmarks-delete-all').click();
    const confirmation = page.locator('.layout-bookmarks-delete-confirm');
    assert.equal(await confirmation.isVisible(), true);
    assert.match(await confirmation.innerText(), new RegExp(String(count)));
    assert.match(await confirmation.innerText(), /本機/);
    assert.equal(await page.locator('.layout-bookmarks-delete-cancel').evaluate(node => node === document.activeElement), true, 'cancellation is the safe default focus');
    return confirmation;
}

test('delete all local bookmarks requires inline confirmation and one undo restores the whole ordered library without capturing or applying', browserCase, async t => {
    const f = await fixture(t);await f.page.locator('#layout-bookmarks-btn').click();
    assert.equal(await f.page.locator('.layout-bookmarks-delete-all').isDisabled(), true, 'the empty-library control stays visible but disabled');
    await f.page.locator('.layout-bookmarks-save').click();await f.page.evaluate(() => fixture.setFocus(fixture.keys()[1]));
    await f.page.locator('.layout-bookmarks-save').click();await f.page.locator('.layout-bookmarks-save').click();
    const library = await f.page.evaluate(() => layoutBookmarkMenu.store.list()), before = await remember(f);
    const unchanged = await f.page.evaluate(() => ({ captures:fixture.captures, applies:fixture.applies, layout:fixture.geometry() }));
    await localDeleteConfirmation(f.page, 3);
    assert.equal(await f.page.locator('.layout-bookmarks-save').isDisabled(), true);
    assert.equal(await f.page.locator('.layout-bookmark-rename').first().isDisabled(), true);
    assert.equal(await f.page.locator('.layout-bookmarks-delete-all').isDisabled(), true);
    await f.page.locator('.layout-bookmarks-delete-confirm-button').click();
    await f.page.waitForFunction(() => layoutBookmarkMenu.store.list().length === 0 && document.getElementById('layout-bookmarks').getAttribute('aria-busy') === 'false');
    assert.equal(await f.page.locator('.layout-bookmark-card').count(), 0);assert.equal(await f.page.locator('.layout-bookmarks-delete-all').isDisabled(), true);
    assert.deepEqual(await f.page.evaluate(() => JSON.parse(localStorage.getItem('umininn.layoutBookmarks.v1')).bookmarks), []);
    await f.page.locator('.layout-bookmarks-undo button').click();
    await f.page.waitForFunction(() => layoutBookmarkMenu.store.list().length === 3);
    assert.deepEqual(await f.page.evaluate(() => layoutBookmarkMenu.store.list()), library, 'batch undo preserves IDs, names, timestamps, colours, snapshots and order');
    assert.deepEqual(await f.page.evaluate(() => ({ captures:fixture.captures, applies:fixture.applies, layout:fixture.geometry() })), unchanged);
    await assertContinuity(f, before);
});

test('local delete-all cancellation, two-stage Escape, close and rename locking never delete a bookmark', browserCase, async t => {
    const f = await fixture(t);await f.page.locator('#layout-bookmarks-btn').click();await f.page.locator('.layout-bookmarks-save').click();
    const library = await f.page.evaluate(() => layoutBookmarkMenu.store.list()), before = await remember(f);
    await localDeleteConfirmation(f.page, 1);await f.page.locator('.layout-bookmarks-delete-cancel').click();
    assert.equal(await f.page.locator('.layout-bookmarks-delete-confirm').isVisible(), false);
    await localDeleteConfirmation(f.page, 1);await f.page.keyboard.press('Escape');
    assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), true);assert.equal(await f.page.locator('.layout-bookmarks-delete-confirm').isVisible(), false);
    await f.page.keyboard.press('Escape');assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), false);
    await f.page.locator('#layout-bookmarks-btn').click();await localDeleteConfirmation(f.page, 1);await f.page.locator('.layout-bookmarks-close').click();
    await f.page.locator('#layout-bookmarks-btn').click();assert.equal(await f.page.locator('.layout-bookmarks-delete-confirm').isVisible(), false);
    await f.page.locator('.layout-bookmark-rename').click();await f.page.locator('.layout-bookmark-name-input').fill('保留中的草稿');
    assert.equal(await f.page.locator('.layout-bookmarks-delete-all').isDisabled(), true);
    await f.page.locator('.layout-bookmark-name-input').press('Escape');assert.equal(await f.page.locator('.layout-bookmarks-delete-all').isEnabled(), true);
    assert.deepEqual(await f.page.evaluate(() => layoutBookmarkMenu.store.list()), library);await assertContinuity(f, before);
});

test('local delete-all reports a denied write without clearing the library or pretending success', browserCase, async t => {
    const f = await fixture(t);await f.page.locator('#layout-bookmarks-btn').click();await f.page.locator('.layout-bookmarks-save').click();
    const library = await f.page.evaluate(() => layoutBookmarkMenu.store.list()), before = await remember(f);
    await localDeleteConfirmation(f.page, 1);
    await f.page.evaluate(() => { Storage.prototype.setItem=function(){throw new DOMException('Local deletion denied','QuotaExceededError')}; });
    await f.page.locator('.layout-bookmarks-delete-confirm-button').click();
    await f.page.waitForFunction(() => document.querySelector('.layout-bookmarks-status.is-error')?.textContent);
    assert.deepEqual(await f.page.evaluate(() => layoutBookmarkMenu.store.list()), library);assert.equal(await f.page.locator('.layout-bookmark-card').count(), 1);
    assert.equal(await f.page.locator('.layout-bookmarks-undo').isVisible(), false);assert.equal(await f.page.locator('.layout-bookmarks-delete-confirm').isVisible(), false);
    await assertContinuity(f, before);
});

test('a second real tab changing local bookmarks invalidates the frozen delete-all confirmation', {...browserCase,timeout:60000}, async t => {
    for (const change of ['add','rename','reorder']) await t.test(change, async st => {
        const f = await fixture(st);await f.page.locator('#layout-bookmarks-btn').click();
        await f.page.locator('.layout-bookmarks-save').click();await f.page.locator('.layout-bookmarks-save').click();
        const before = await remember(f), original = await f.page.evaluate(() => layoutBookmarkMenu.store.list());
        await localDeleteConfirmation(f.page, 2);
        const other = await f.page.context().newPage();await other.goto(siteUrl,{waitUntil:'load'});await other.locator('#layout-bookmarks-btn').click();
        if(change==='add'){await other.locator('.layout-bookmarks-save').click();await other.waitForFunction(()=>layoutBookmarkMenu.store.list().length===3)}
        else if(change==='rename'){await other.locator('.layout-bookmark-rename').first().click();await other.locator('.layout-bookmark-name-input').fill('其他分頁的新名稱');await other.locator('.layout-bookmark-name-input').press('Enter');await other.waitForFunction(()=>layoutBookmarkMenu.store.list()[0]?.name==='其他分頁的新名稱')}
        else{await other.locator('.layout-bookmark-move-down').first().click();await other.waitForFunction(id=>layoutBookmarkMenu.store.list()[0]?.id===id,original[1].id)}
        const latest = await other.evaluate(() => layoutBookmarkMenu.store.list());
        await f.page.waitForFunction(expected=>JSON.stringify(layoutBookmarkMenu.store.list())===JSON.stringify(expected),latest);
        assert.equal(await f.page.locator('.layout-bookmarks-delete-confirm').isVisible(), true);assert.match(await f.page.locator('.layout-bookmarks-delete-confirm').innerText(), /2/);
        await f.page.locator('.layout-bookmarks-delete-confirm-button').click();await f.page.waitForFunction(()=>document.querySelector('.layout-bookmarks-status.is-error')?.textContent);
        assert.deepEqual(await f.page.evaluate(()=>JSON.parse(localStorage.getItem('umininn.layoutBookmarks.v1')).bookmarks),latest);
        assert.equal(await f.page.locator('.layout-bookmarks-delete-confirm').isVisible(), false);
        await localDeleteConfirmation(f.page, latest.length);await f.page.locator('.layout-bookmarks-delete-cancel').click();await assertContinuity(f,before);
    });
});

test('delete-all confirmation keeps Cancel and Confirm reachable in narrow and short viewports without scrolling the document',browserCase,async t=>{
    for(const height of [640,320])await t.test('360×'+height,async st=>{
        const f=await fixture(st,{viewport:{width:360,height},width:360,height:200});await f.page.locator('#layout-bookmarks-btn').click();await f.page.locator('.layout-bookmarks-save').click();
        const scroll=await f.page.evaluate(()=>[scrollX,scrollY]);await localDeleteConfirmation(f.page,1);
        for(const currentHeight of height===640?[640,320]:[320]){
            if(currentHeight!==height)await f.page.setViewportSize({width:360,height:currentHeight});
            fs.mkdirSync(path.join(root,'work'),{recursive:true});await f.page.screenshot({path:path.join(root,'work/bookmark-delete-confirm-'+engine+'-360x'+height+(currentHeight!==height?'-resized':'')+'.png')});
            const controls=await f.page.locator('.layout-bookmarks-delete-actions button').evaluateAll(buttons=>{
                const panel=document.getElementById('layout-bookmarks'),p=panel.getBoundingClientRect(),top=p.top+panel.clientTop,bottom=top+panel.clientHeight;
                return buttons.map(button=>{const r=button.getBoundingClientRect();return {text:button.textContent,inside:r.top>=top&&r.bottom<=bottom&&r.left>=p.left&&r.right<=p.right,
                    hit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===button}});
            });
            assert.ok(controls.length===2&&controls.every(control=>control.inside&&control.hit),JSON.stringify(controls));
        }
        assert.deepEqual(await f.page.evaluate(()=>[scrollX,scrollY]),scroll);await f.page.locator('.layout-bookmarks-delete-cancel').click();
    });
});
