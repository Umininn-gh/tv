'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const enabled = process.env.UMININN_BROWSER_TESTS === '1';
const engine = process.env.UMININN_BROWSER_ENGINE || 'chromium';
const channel = process.env.UMININN_BROWSER_CHANNEL || 'chrome';
const browserCase = { skip: !enabled, timeout: 30000 };
const root = path.resolve(__dirname, '..');
const origin = 'https://umininn-gh.github.io', siteUrl = origin + '/tv/';
const frameOrigin = 'https://bookmark-player.invalid';
let browser, css, appScript, modules;
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const copy = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function productionFunction(source, name) {
    const match = source.match(new RegExp('^function ' + name + '\\([^]*?\\n}', 'm'));
    assert.ok(match, 'production seam: ' + name); return match[0];
}
test.before(async () => {
    if (!enabled) return;
    let playwright;
    try { playwright = require('playwright'); }
    catch (_) { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
    assert.ok(['chromium', 'firefox'].includes(engine));
    const launch = process.env.UMININN_BROWSER_EXECUTABLE ? { executablePath: process.env.UMININN_BROWSER_EXECUTABLE } : engine === 'chromium' ? { channel } : {};
    browser = await playwright[engine].launch({ headless: true, ...launch });
    const html = read('index.html'), source = read('tv-app.js');
    css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]).join('\n') + '\n' + read('layout-bookmarks.css');
    modules = Object.fromEntries(['channel-list', 'stream-performance', 'player-layout', 'player-geometry', 'player-lifecycle', 'menu-dismiss', 'layout-bookmarks', 'shared-bookmarks']
        .map(name => ['/tv/' + name + '.js', read('' + name + '.js')]));
    appScript = ['getGlobalMuted', 'updateGlobalAudioButton', 'getPlayerElement', 'disposePlayer', 'disposePlayerResource', 'projectPlayerLayout', 'calculatePlayerLayout', 'updatePlayerLayout',
        'playerGridArea', 'getCurrentPlayerGeometry', 'savePlayerEnlargement', 'getPlayerPositionKeys', 'syncActivePlayers',
        'playerLayoutAudioAvailable', 'playerBookmarkAudioAvailable', 'capturePlayerBookmark', 'showLayoutBookmarkFeedback', 'applyPlayerBookmark', 'setChannelSelectionVisible']
        .map(name => productionFunction(source, name)).join('\n');
    console.log(`Shared bookmark model: ${channel}/${engine} ${browser.version()}; independent contexts, production UI/store/capture/apply, local media, fully intercepted network.`);
});
test.after(async () => { await browser?.close(); });

const rate = 8000, samples = rate * 30, wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
const instrument = `function instrument(video){const counts={play:0,pause:0,load:0};for(const method of Object.keys(counts)){const original=video[method].bind(video);video[method]=function(...args){counts[method]++;return original(...args)}}video.qaActions=counts;}`;

function htmlFixture({ width = 1100, height = 600 } = {}) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>
    <div id="top-bar"><div class="top-container"><div id="input-container"><button id="more-channels-btn" onclick="setChannelSelectionVisible(document.getElementById('channel-selection').style.display==='none')">📺 看更台</button><button id="layout-bookmarks-btn">🔖 書籤</button></div></div></div>
    <div id="channel-selection" style="display:none"><div id="channel-options"></div></div><section id="layout-bookmarks" role="dialog" aria-labelledby="layout-bookmarks-title" tabindex="-1" hidden></section><p id="layout-bookmark-feedback" hidden></p>
    <div id="multi-stream-container-wrapper" style="flex:none;width:${width}px;max-width:100%;height:${height}px;min-height:0"><div id="multi-stream-container" class="video-wrapper"></div></div>
    ${Object.keys(modules).map(src => '<script src="' + src + '"></script>').join('')}
    <script>${instrument}
    const channels=[{id:'one',platform:'m3u8',name:'劇集一台'},{id:'two',platform:'at',name:'直播二台'},{id:'three',platform:'at',name:'新聞三台'},{id:'four',platform:'m3u8',name:'劇集四台'}];
    const playerResources=new WeakMap(),PLAYER_POSITION_STORAGE_KEY='playerPositionOrder',PLAYER_ENLARGEMENT_STORAGE_KEY='playerEnlargementLayout';
    const playerRegistry=PlayerLifecycle.create({render:renderChannelElement,getResource:element=>playerResources.get(element),dispose:disposePlayerResource});
    const activePlayers=playerRegistry.entries;
    const playerLayoutState=PlayerLayout.createState({buildGeometry:PlayerGeometry.build});
    const playerLayoutOperations=PlayerLayout.createOperations({geometry:PlayerGeometry});let playerGrid=null;
    let globalMutedPreference=null,currentDisplayChannel=null,currentHLSInstances=[],currentFLVInstances=[],layoutBookmarkMenu=null,layoutBookmarkFeedbackTimer=null;
    const playerWindowControls={refresh(){}},playerNameOverlay={refresh(){},setVisible(){}},playerPositionEditor={refresh(){},layoutChanged(){},close(){}},channelSelectionIdleTimer={setVisible(){}};
    window.fixture={renders:0,nextId:0,remembered:new Map(),captures:0,applies:0};
    function getPlatform(type){return {type:type==='m3u8'?'hls':'iframe'}}
    function withPlayerAudioLayout(action){return action()}
    function showGlobalAudioFeedback(){} function updateChannelSelectionSummary(){}
    function renderChannelElement(channel,muted,wrapperClass){fixture.renders++;const element=document.createElement(channel.platform==='m3u8'?'video':'iframe');element.id='qa-player-'+fixture.nextId++;element.className=wrapperClass;
      if(element.tagName==='VIDEO'){element.muted=muted;element.loop=true;element.playsInline=true;instrument(element);element.src='/silent.wav?key='+encodeURIComponent(ChannelList.channelKey(channel));playerResources.set(element,{element,video:element,disposed:false,failed:false,hls:null,flv:null});}
      else{element.allow='autoplay';element.dataset.loads='0';element.addEventListener('load',()=>element.dataset.loads=String(Number(element.dataset.loads)+1));element.src='${frameOrigin}/player?key='+encodeURIComponent(ChannelList.channelKey(channel));}return element;}
    ${appScript}
    const transport={async read(){const result=await fetch('/qa/library');if(!result.ok)throw Error('network unavailable');return result.json();},async write(document,token){const response=await fetch('/qa/library',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({document,token})});if(response.status===409)throw Object.assign(Error('CAS conflict'),{code:'conflict'});if(!response.ok)throw Error('write failed');return response.json();}};
    const sharedQaStore=SharedBookmarks.createStore({transport,cacheStorage:localStorage});
    layoutBookmarkMenu=LayoutBookmarks.mount({button:document.getElementById('layout-bookmarks-btn'),panel:document.getElementById('layout-bookmarks'),store:sharedQaStore,capture:(...args)=>{fixture.captures++;return capturePlayerBookmark(...args)},apply:(...args)=>{fixture.applies++;return applyPlayerBookmark(...args)},beforeOpen(){setChannelSelectionVisible(false);playerPositionEditor.close(false);}});
    fixture.keys=()=>getPlayerPositionKeys();
    fixture.setFocus=function(){const key=fixture.keys()[1],next=PlayerGeometry.build({keys:fixture.keys(),columns:3,focus:{key,span:2,row:0,column:1}});playerLayoutState.setFocus(next.items.find(item=>item.span>1));playerLayoutState.setPending({...next,intent:'drag'});updatePlayerLayout({force:true});};
    fixture.remember=function(){fixture.remembered=new Map([...activePlayers].map(([key,entry])=>[key,{entry,element:getPlayerElement(entry),window:getPlayerElement(entry).contentWindow}]));return fixture.state();};
    fixture.state=function(){return [...fixture.remembered].map(([key,saved])=>{const current=activePlayers.get(key),element=current&&getPlayerElement(current);return {key,sameEntry:current===saved.entry,sameElement:element===saved.element,connected:saved.element.isConnected,sameWindow:saved.window===saved.element.contentWindow,loads:saved.element.dataset.loads||null,paused:saved.element.tagName==='VIDEO'?saved.element.paused:null,actions:saved.element.qaActions?{...saved.element.qaActions}:null};});};
    syncActivePlayers(channels);for(const channel of channels){const input=document.createElement('input');input.type='checkbox';input.checked=true;input.value=channel.id;input.dataset.platform=channel.platform;document.getElementById('channel-options').append(input);}
    </script></body></html>`;
}

function mockServer() {
    let document = { version: 1, bookmarks: [] }, revision = 1;
    return {
        reads: 0, writes: 0, offline: false, nextReadGate: null, nextWriteGate: null,
        current: () => ({ document: copy(document), token: String(revision) }),
        async route(route) {
            if (this.offline) return route.abort('failed');
            if (route.request().method() === 'PUT') {
                const data = route.request().postDataJSON(); this.writes++;
                const gate = this.nextWriteGate; this.nextWriteGate = null;
                if (gate) { gate.started.resolve(); await gate.release.promise; }
                if (data.token !== String(revision)) return route.fulfill({ status: 409, json: { error: 'conflict' } });
                document = copy(data.document); revision++;
                return route.fulfill({ json: this.current() });
            }
            this.reads++;
            const value = this.current(), gate = this.nextReadGate; this.nextReadGate = null;
            if (gate) { gate.started.resolve(); await gate.release.promise; }
            return route.fulfill({ json: value }).catch(() => {});
        }
    };
}

async function fixture(t, server, options = {}) {
    const context = await browser.newContext({ viewport: options.viewport || { width: 1300, height: 900 }, serviceWorkers: 'block' });
    t.after(() => context.close());
    if (options.local) await context.addInitScript(local => localStorage.setItem('umininn.layoutBookmarks.v1', JSON.stringify(local)), options.local);
    const errors = [], unexpected = [];
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname === '/qa/library') return server.route(route);
        if (route.request().url() === siteUrl) return route.fulfill({ contentType: 'text/html', body: htmlFixture(options) });
        if (url.origin === origin && modules[url.pathname]) return route.fulfill({ contentType: 'application/javascript', body: modules[url.pathname] });
        if (url.origin === frameOrigin && url.pathname === '/player') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body style="margin:0;background:#15322a"><video muted loop playsinline src="/silent.wav"></video><script>${instrument}window.qaDocumentId=crypto.randomUUID();instrument(document.querySelector('video'));</script></body></html>` });
        if ([origin, frameOrigin].includes(url.origin) && url.pathname === '/silent.wav') return route.fulfill({ contentType: 'audio/wav', body: wav });
        unexpected.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(siteUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => activePlayers.size === 4 && [...activePlayers.values()].every(entry => entry.element.tagName === 'IFRAME' ? Number(entry.element.dataset.loads) === 1 : entry.element.readyState >= 2));
    await page.evaluate(async () => { for (const [index,entry] of [...activePlayers.values()].entries()) if(entry.resource?.video){entry.resource.video.volume=.23;if(index===0)await entry.resource.video.play();else entry.resource.video.pause();} });
    t.after(() => { assert.deepEqual(errors, [], 'no browser script errors'); assert.deepEqual(unexpected, [], 'no external network'); });
    return { page, context };
}
const names = page => page.locator('.layout-bookmark-name').allTextContents();
async function open(page) { await page.locator('#layout-bookmarks-btn').click(); await page.waitForFunction(() => sharedQaStore.getSyncState() !== 'syncing'); }
async function settled(page, count) { await page.waitForFunction(count => sharedQaStore.getSyncState() !== 'syncing' && document.querySelectorAll('.layout-bookmark-card').length === count, count); }
async function continuity(page, before) { assert.deepEqual(await page.evaluate(() => fixture.state()), before); }

test('two independent browser contexts share save, rename, enlarged update, reorder, delete and undo while players retain identity', browserCase, async t => {
    const server = mockServer(), a = await fixture(t, server), b = await fixture(t, server);
    const beforeA = await a.page.evaluate(() => fixture.remember()), beforeB = await b.page.evaluate(() => fixture.remember());
    await open(a.page); await a.page.locator('.layout-bookmarks-save').click(); await settled(a.page, 1);
    await a.page.locator('.layout-bookmarks-save').click(); await settled(a.page, 2);
    assert.deepEqual(await names(a.page), ['佈局 2', '佈局 1'], 'each newly saved layout appears above the existing bookmarks');
    await a.page.locator('.layout-bookmark-rename').first().click();
    await a.page.locator('.layout-bookmark-name-input').fill('夜更共用'); await a.page.locator('.layout-bookmark-name-input').press('Enter');
    await a.page.waitForFunction(() => sharedQaStore.list()[0]?.name === '夜更共用');
    await open(b.page); assert.deepEqual(await names(b.page), ['夜更共用', '佈局 1']);
    await b.page.locator('.layout-bookmark-move-up').nth(1).click();
    await b.page.waitForFunction(() => sharedQaStore.list()[0]?.name === '佈局 1');
    assert.deepEqual(await names(b.page), ['佈局 1', '夜更共用']);
    assert.equal(await b.page.locator('.layout-bookmark-move-up').first().isDisabled(), true);
    assert.equal(await b.page.locator('.layout-bookmark-move-down').last().isDisabled(), true);
    assert.equal(await b.page.evaluate(() => document.activeElement?.closest('.layout-bookmark-card')?.querySelector('.layout-bookmark-name')?.textContent), '佈局 1', 'focus follows the moved bookmark when the original direction reaches a boundary');
    await a.page.locator('.layout-bookmarks-close').click(); await open(a.page);
    assert.deepEqual(await names(a.page), ['佈局 1', '夜更共用']);
    await a.page.evaluate(() => fixture.setFocus());
    await a.page.locator('.layout-bookmark-update').first().click(); await settled(a.page, 2);
    await a.page.waitForFunction(() => Boolean(sharedQaStore.list()[0]?.snapshot.focus));
    await a.page.locator('.layout-bookmark-delete').last().click(); await settled(a.page, 1);
    await a.page.getByRole('button', { name: '復原刪除', exact: true }).click(); await settled(a.page, 2);
    await b.page.locator('.layout-bookmarks-close').click(); await open(b.page);
    assert.deepEqual(await names(b.page), ['佈局 1', '夜更共用']);
    assert.ok(await b.page.evaluate(() => sharedQaStore.list()[0].snapshot.focus));
    await continuity(a.page, beforeA); await continuity(b.page, beforeB);
    await b.page.screenshot({ path: path.join(root, 'outputs/shared-bookmarks-' + channel + '-preview.png') });
    await b.page.locator('.layout-bookmark-preview').first().click();
    await b.page.waitForFunction(() => document.getElementById('layout-bookmarks').hidden);
    const applied = server.current().document.bookmarks[0].snapshot;
    assert.deepEqual(await b.page.evaluate(() => capturePlayerBookmark()), { ...applied, channels: applied.channels.map(({ color, ...item }) => item) });
    await continuity(b.page, beforeB);
});

test('local bookmarks require an explicit import and importing again never duplicates entries', browserCase, async t => {
    const server = mockServer(), local = { version: 1, bookmarks: [{ id: 'local-one', name: '舊本機書籤', createdAt: 1, updatedAt: 1, snapshot: { channels: [{ key: 'at|two', name: '直播二台', color: 31 }], columns: 1, focus: null, aspectRatio: 1.5 } }] };
    const f = await fixture(t, server, { local }); await open(f.page);
    assert.equal(server.current().document.bookmarks.length, 0);
    assert.equal(server.writes, 0);
    await f.page.locator('.layout-bookmarks-import').click(); await settled(f.page, 1);
    assert.deepEqual(await names(f.page), ['舊本機書籤']);
    assert.equal(await f.page.evaluate(() => JSON.parse(localStorage.getItem('umininn.layoutBookmarks.v1')).bookmarks.length), 1);
    if (await f.page.locator('.layout-bookmarks-import').isVisible()) { await f.page.locator('.layout-bookmarks-import').click(); await settled(f.page, 1); }
    assert.equal(server.current().document.bookmarks.length, 1);
});

test('background synchronization preserves a dirty name and does not extend the 30-second idle interval', browserCase, async t => {
    const server = mockServer(), a = await fixture(t, server), b = await fixture(t, server);
    await open(a.page); await a.page.locator('.layout-bookmarks-save').click(); await settled(a.page, 1); await open(b.page);
    await a.page.clock.install({ time: new Date('2026-01-01T00:00:00Z') }); await a.page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
    await a.page.locator('.layout-bookmark-rename').click(); await a.page.locator('.layout-bookmark-name-input').fill('未儲存草稿');
    await b.page.locator('.layout-bookmark-rename').click(); await b.page.locator('.layout-bookmark-name-input').fill('遠端名稱'); await b.page.locator('.layout-bookmark-name-input').press('Enter');
    await b.page.waitForFunction(() => sharedQaStore.list()[0]?.name === '遠端名稱');
    await a.page.clock.fastForward(15000);
    await a.page.waitForFunction(() => sharedQaStore.getSyncState() !== 'syncing');
    assert.equal(await a.page.locator('.layout-bookmark-name-input').inputValue(), '未儲存草稿');
    await a.page.clock.fastForward(14999); assert.equal(await a.page.locator('#layout-bookmarks').isVisible(), true);
    await a.page.clock.fastForward(1); assert.equal(await a.page.locator('#layout-bookmarks').isVisible(), false);
});

test('a delayed synchronization finishing after close does not reopen the panel or resume polling', browserCase, async t => {
    const server = mockServer(), f = await fixture(t, server); await open(f.page);
    await f.page.locator('.layout-bookmarks-close').click();
    const gate = { started: deferred(), release: deferred() }; server.nextReadGate = gate;
    await f.page.locator('#layout-bookmarks-btn').click(); await gate.started.promise;
    await f.page.locator('.layout-bookmarks-close').click(); gate.release.resolve();
    await f.page.waitForFunction(() => sharedQaStore.getSyncState() !== 'syncing');
    assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), false);
    const reads = server.reads;
    await f.page.clock.install(); await f.page.clock.fastForward(45000);
    assert.equal(server.reads, reads);
});

test('a remote rename conflict preserves the typed draft and keyboard cancellation restores the refreshed name', browserCase, async t => {
    const server = mockServer(), a = await fixture(t, server), b = await fixture(t, server);
    await open(a.page); await a.page.locator('.layout-bookmarks-save').click(); await settled(a.page, 1); await open(b.page);
    await a.page.locator('.layout-bookmark-rename').click(); await a.page.locator('.layout-bookmark-name-input').fill('我的草稿');
    await b.page.locator('.layout-bookmark-rename').click(); await b.page.locator('.layout-bookmark-name-input').fill('其他人已改名'); await b.page.locator('.layout-bookmark-name-input').press('Enter');
    await b.page.waitForFunction(() => sharedQaStore.list()[0]?.name === '其他人已改名');
    await a.page.evaluate(() => sharedQaStore.reload());
    assert.equal(await a.page.locator('.layout-bookmark-name-input').inputValue(), '我的草稿');
    await a.page.locator('.layout-bookmark-name-input').press('Enter');
    await a.page.waitForFunction(() => sharedQaStore.getSyncState() === 'error');
    assert.equal(await a.page.locator('.layout-bookmarks-status.is-error').isVisible(), true);
    assert.equal(await a.page.locator('.layout-bookmark-name-input').inputValue(), '我的草稿');
    assert.equal(server.current().document.bookmarks[0].name, '其他人已改名');
    await a.page.locator('.layout-bookmark-name-input').press('Escape');
    assert.deepEqual(await names(a.page), ['其他人已改名']);
    assert.equal(await a.page.locator('.layout-bookmark-rename').evaluate(node => node === document.activeElement), true);
});

test('a pending save locks repeated mutations, remains closable, and finishes once without reopening', browserCase, async t => {
    const server = mockServer(), f = await fixture(t, server); await open(f.page);
    await f.page.locator('.layout-bookmarks-save').click(); await settled(f.page, 1);
    const before = await f.page.evaluate(() => fixture.remember()), gate = { started: deferred(), release: deferred() };
    server.nextReadGate = gate;
    await f.page.locator('.layout-bookmarks-save').click(); await gate.started.promise;
    assert.equal(await f.page.locator('.layout-bookmarks-save').isDisabled(), true);
    assert.equal(await f.page.locator('.layout-bookmark-delete').first().isDisabled(), true);
    assert.equal(await f.page.locator('.layout-bookmark-preview').first().isDisabled(), true);
    await f.page.locator('.layout-bookmarks-close').click(); gate.release.resolve();
    await f.page.waitForFunction(() => sharedQaStore.getSyncState() !== 'syncing');
    assert.equal(server.current().document.bookmarks.length, 2);
    assert.equal(server.writes, 2);
    assert.equal(await f.page.locator('#layout-bookmarks').isVisible(), false);
    await continuity(f.page, before);
});

test('offline saves report failure while confirmed layouts remain usable and mobile controls fit the viewport', browserCase, async t => {
    const server = mockServer(), f = await fixture(t, server, { viewport: { width: 375, height: 667 }, width: 375, height: 330 });
    const before = await f.page.evaluate(() => fixture.remember());
    await open(f.page); await f.page.locator('.layout-bookmarks-save').click(); await settled(f.page, 1);
    server.offline = true;
    await f.page.locator('.layout-bookmarks-save').click();
    await f.page.waitForFunction(() => sharedQaStore.getSyncState() !== 'syncing');
    assert.equal(await f.page.locator('.layout-bookmarks-status.is-error').isVisible(), true);
    assert.equal(await f.page.locator('.layout-bookmark-card').count(), 1);
    assert.equal(server.current().document.bookmarks.length, 1);
    const bounds = await f.page.locator('#layout-bookmarks').evaluate(panel => { const rect=panel.getBoundingClientRect();return {left:rect.left,right:rect.right,bottom:rect.bottom,width:innerWidth,height:innerHeight,overflow:panel.scrollWidth-panel.clientWidth}; });
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 1 && bounds.bottom <= bounds.height + 1 && bounds.overflow <= 1, JSON.stringify(bounds));
    await continuity(f.page, before);
});

async function sharedDeleteConfirmation(page,count){
    await page.locator('.layout-bookmarks-delete-all').click();
    const confirmation=page.locator('.layout-bookmarks-delete-confirm');assert.equal(await confirmation.isVisible(),true);
    assert.match(await confirmation.innerText(),new RegExp(String(count)));assert.match(await confirmation.innerText(),/全站共用/);
    assert.equal(await page.locator('.layout-bookmarks-delete-cancel').evaluate(node=>node===document.activeElement),true);
    return confirmation;
}

test('shared delete-all confirms its global scope and batch undo restores every bookmark to independent contexts without media or capture effects',browserCase,async t=>{
    const server=mockServer(),a=await fixture(t,server),b=await fixture(t,server);
    await open(a.page);assert.equal(await a.page.locator('.layout-bookmarks-delete-all').isDisabled(),true);
    await a.page.locator('.layout-bookmarks-save').click();await settled(a.page,1);await a.page.evaluate(()=>fixture.setFocus());
    await a.page.locator('.layout-bookmarks-save').click();await settled(a.page,2);await a.page.locator('.layout-bookmarks-save').click();await settled(a.page,3);
    const library=server.current().document.bookmarks,beforeA=await a.page.evaluate(()=>fixture.remember()),beforeB=await b.page.evaluate(()=>fixture.remember());
    const calls=await a.page.evaluate(()=>({captures:fixture.captures,applies:fixture.applies}));await open(b.page);
    await sharedDeleteConfirmation(a.page,3);await a.page.locator('.layout-bookmarks-delete-confirm-button').click();await settled(a.page,0);
    assert.deepEqual(server.current().document.bookmarks,[]);assert.equal(await a.page.locator('.layout-bookmarks-delete-all').isDisabled(),true);
    await b.page.evaluate(()=>sharedQaStore.reload());await settled(b.page,0);assert.equal(await b.page.locator('.layout-bookmarks-delete-all').isDisabled(),true);
    await a.page.locator('.layout-bookmarks-undo button').click();await settled(a.page,3);
    assert.deepEqual(server.current().document.bookmarks,library,'a single undo restores the complete ordered batch with original contents and identities');
    await b.page.evaluate(()=>sharedQaStore.reload());await settled(b.page,3);assert.deepEqual(await b.page.evaluate(()=>sharedQaStore.list()),library);
    assert.deepEqual(await a.page.evaluate(()=>({captures:fixture.captures,applies:fixture.applies})),calls);
    assert.deepEqual(await b.page.evaluate(()=>({captures:fixture.captures,applies:fixture.applies})),{captures:0,applies:0});
    await continuity(a.page,beforeA);await continuity(b.page,beforeB);
});

test('pending shared delete-all disables mutations, can close, and commits only once without reopening',browserCase,async t=>{
    const server=mockServer(),f=await fixture(t,server);await open(f.page);
    await f.page.locator('.layout-bookmarks-save').click();await settled(f.page,1);await f.page.locator('.layout-bookmarks-save').click();await settled(f.page,2);
    const library=server.current().document.bookmarks,before=await f.page.evaluate(()=>fixture.remember()),writes=server.writes;
    const gate={started:deferred(),release:deferred()};t.after(()=>gate.release.resolve());server.nextWriteGate=gate;
    await sharedDeleteConfirmation(f.page,2);await f.page.locator('.layout-bookmarks-delete-confirm-button').click();await gate.started.promise;
    assert.equal(await f.page.locator('#layout-bookmarks').getAttribute('aria-busy'),'true');
    for(const selector of ['.layout-bookmarks-save','.layout-bookmarks-delete-all','.layout-bookmark-delete','.layout-bookmark-rename'])assert.equal(await f.page.locator(selector).first().isDisabled(),true,selector);
    assert.equal(await f.page.locator('.layout-bookmarks-close').isEnabled(),true);
    await f.page.locator('.layout-bookmarks-close').click();gate.release.resolve();
    await f.page.waitForFunction(()=>sharedQaStore.getSyncState()!=='syncing'&&document.getElementById('layout-bookmarks').getAttribute('aria-busy')==='false');
    assert.deepEqual(server.current().document.bookmarks,[]);assert.equal(server.writes,writes+1);assert.equal(await f.page.locator('#layout-bookmarks').isVisible(),false);
    await open(f.page);await f.page.locator('.layout-bookmarks-undo button').click();await settled(f.page,2);assert.deepEqual(server.current().document.bookmarks,library);await continuity(f.page,before);
});

test('shared delete-all network failure keeps the confirmed library and cannot expose a successful undo',browserCase,async t=>{
    const server=mockServer(),f=await fixture(t,server,{viewport:{width:375,height:667},width:375,height:330});await open(f.page);
    await f.page.locator('.layout-bookmarks-save').click();await settled(f.page,1);const library=server.current().document.bookmarks,before=await f.page.evaluate(()=>fixture.remember());
    await sharedDeleteConfirmation(f.page,1);server.offline=true;await f.page.locator('.layout-bookmarks-delete-confirm-button').click();
    await f.page.waitForFunction(()=>document.querySelector('.layout-bookmarks-status.is-error')?.textContent&&document.getElementById('layout-bookmarks').getAttribute('aria-busy')==='false');
    assert.deepEqual(server.current().document.bookmarks,library);assert.equal(await f.page.locator('.layout-bookmark-card').count(),1);assert.equal(await f.page.locator('.layout-bookmarks-undo').isVisible(),false);
    assert.equal(await f.page.locator('.layout-bookmarks-delete-confirm').isVisible(),false);
    server.offline=false;await sharedDeleteConfirmation(f.page,1);
    const bounds=await f.page.locator('.layout-bookmarks-delete-confirm').evaluate(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,overflow:node.scrollWidth-node.clientWidth}});
    assert.ok(bounds.left>=0&&bounds.right<=bounds.width+1&&bounds.overflow<=1,JSON.stringify(bounds));
    await f.page.locator('.layout-bookmarks-delete-cancel').click();await continuity(f.page,before);
});

test('remote add, rename or reorder requires a new shared delete-all confirmation instead of deleting unseen changes',{...browserCase,timeout:60000},async t=>{
    for(const change of ['add','rename','reorder'])await t.test(change,async st=>{
        const server=mockServer(),a=await fixture(st,server),b=await fixture(st,server);await open(a.page);
        await a.page.locator('.layout-bookmarks-save').click();await settled(a.page,1);await a.page.locator('.layout-bookmarks-save').click();await settled(a.page,2);
        const before=await a.page.evaluate(()=>fixture.remember()),original=server.current().document.bookmarks;await sharedDeleteConfirmation(a.page,2);await open(b.page);
        if(change==='add'){await b.page.locator('.layout-bookmarks-save').click();await settled(b.page,3)}
        else if(change==='rename'){await b.page.locator('.layout-bookmark-rename').first().click();await b.page.locator('.layout-bookmark-name-input').fill('遠端已更新名稱');await b.page.locator('.layout-bookmark-name-input').press('Enter');await b.page.waitForFunction(()=>sharedQaStore.list()[0]?.name==='遠端已更新名稱')}
        else{await b.page.locator('.layout-bookmark-move-down').first().click();await b.page.waitForFunction(id=>sharedQaStore.list()[0]?.id===id,original[1].id)}
        const latest=server.current().document.bookmarks,writes=server.writes;await a.page.evaluate(()=>sharedQaStore.reload());
        assert.equal(await a.page.locator('.layout-bookmarks-delete-confirm').isVisible(),true);assert.match(await a.page.locator('.layout-bookmarks-delete-confirm').innerText(),/2/);
        await a.page.locator('.layout-bookmarks-delete-confirm-button').click();await a.page.waitForFunction(()=>document.querySelector('.layout-bookmarks-status.is-error')?.textContent&&document.getElementById('layout-bookmarks').getAttribute('aria-busy')==='false');
        assert.equal(server.writes,writes,'stale confirmation does not commit a destructive write');assert.deepEqual(server.current().document.bookmarks,latest);
        assert.equal(await a.page.locator('.layout-bookmarks-delete-confirm').isVisible(),false);
        await sharedDeleteConfirmation(a.page,latest.length);await a.page.locator('.layout-bookmarks-delete-cancel').click();await continuity(a.page,before);
    });
});
