'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Local closed browser model: production CSS, layout module, sync/swap/reset and
// complete position editor; real native/cross-origin HTML media, no platform SDK.
const enabled = process.env.UMININN_BROWSER_TESTS === '1';
const engine = process.env.UMININN_BROWSER_ENGINE || 'chromium';
const executablePath = process.env.UMININN_BROWSER_EXECUTABLE;
const root = path.resolve(__dirname, '..');
const siteUrl = 'https://umininn-gh.github.io/tv/';
const frameOrigin = 'https://layout-player.invalid';
let browser, unavailable, appScript, layoutScript, geometryScript, channelScript, performanceScript, bookmarkScript, css;

test.before(async () => {
    if (!enabled) return;
    let playwright;
    try { playwright = require('playwright'); }
    catch (_) {
        try { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
        catch (_) { unavailable = 'Optional Playwright browser model unavailable.'; return; }
    }
    assert.ok(['chromium', 'firefox'].includes(engine));
    try { browser = await playwright[engine].launch({headless:true,...(executablePath ? {executablePath} : {})}); }
    catch (error) { if(executablePath)throw error; unavailable='Optional browser executable unavailable.'; return; }
    const read = file => fs.readFileSync(path.join(root, file), 'utf8');
    const source=read('tv-app.js');
    const coreEnd=source.indexOf('/* =============== 頻道儲存 / 載入');
    const summaryStart=source.indexOf('function updateChannelSelectionSummary()');
    const summaryEnd=source.indexOf('\nfunction createChannelOptionControl()',summaryStart);
    const selectionStart=source.indexOf('function toggleChannelSelection()');
    const editorStart=source.indexOf('(function initPlayerPositionEditor()');
    const editorEnd=source.indexOf('\nfunction toggleChannelMenu()',editorStart);
    assert.ok(coreEnd>0&&summaryStart>coreEnd&&summaryEnd>summaryStart&&selectionStart>summaryEnd&&editorStart>selectionStart&&editorEnd>editorStart,'reviewed production core/summary/selection/editor seams must exist');
    appScript=source.slice(0,coreEnd)+'\n'+source.slice(summaryStart,summaryEnd)+'\n'+source.slice(selectionStart,editorEnd)+'\n'+fixtureApp;
    layoutScript=read('player-layout.js');geometryScript=read('player-geometry.js');channelScript=read('channel-list.js');performanceScript=read('stream-performance.js');bookmarkScript=read('layout-bookmarks.js');
    css=[...read('index.html').matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match=>match[1]).join('\n');
    console.log(`Player layout model: ${engine} ${browser.version()} (headless; production CSS/app sections; all network intercepted; no live platform).`);
});
test.after(async()=>{await browser?.close()});
function optional(t){if(unavailable){t.skip(unavailable);return false}return true}

const rate=8000,samples=rate*20,wav=Buffer.alloc(44+samples*2);
wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);
wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40);

const instrument=`
window.fixtureId=crypto.randomUUID();window.fixtureMedia=[];
window.instrumentMedia=function(video){
 const actions={play:0,pause:0,load:0,seek:0,source:0};
 for(const method of ['play','pause','load']){const original=video[method].bind(video);video[method]=function(...args){actions[method]++;return original(...args)}}
 const descriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');
 Object.defineProperty(video,'currentTime',{get(){return descriptor.get.call(this)},set(value){actions.seek++;return descriptor.set.call(this,value)}});
 new MutationObserver(records=>{actions.source+=records.length}).observe(video,{attributes:true,attributeFilter:['src']});
 const saved={video,actions};fixtureMedia.push(saved);return saved;
};
window.readMedia=function(saved){const video=saved.video;return {same:video.isConnected,paused:video.paused,muted:video.muted,volume:video.volume,
 source:video.currentSrc,time:video.currentTime,actions:{...saved.actions}}};`;

const fixtureApp=`
// Keep the production selection toggle and watch command, but fill only local
// checkboxes; status providers/metadata/network are outside this closed model.
function generateChannelOptions(){
 const options=document.getElementById('channel-options');options.replaceChildren();
 for(const channel of channels){const input=document.createElement('input');input.type='checkbox';input.hidden=true;
 input.value=channel.id;input.dataset.platform=channel.platform;input.dataset.name=channel.name;
 input.checked=activePlayers.has(ChannelList.channelKey(channel));options.appendChild(input)}
}
window.fixture={elements:[],entries:[],keys:[],frames:[],removals:0,frameSources:0};
fixture.mount=function(){
 const pane=document.getElementById('multi-stream-container');
 channels=Array.from({length:5},(_,index)=>({id:'layout-'+index,platform:index===2||index===3?document.body.dataset.fixtureFramePlatform||'at':'m3u8',name:'播放器 '+index}));
 channels.forEach((channel,index)=>{
   let element,resource=null;
   if(index===2||index===3){
      element=document.createElement('iframe');element.id='frame-'+index;element.src='${frameOrigin}/player?index='+index;element.allow='autoplay';
      element.addEventListener('load',()=>{element.dataset.loads=String(Number(element.dataset.loads||0)+1)});
      new MutationObserver(records=>{fixture.frameSources+=records.length}).observe(element,{attributes:true,attributeFilter:['src']});
      fixture.frames.push({element,window:null});
   }else{
      element=document.createElement('video');element.id='native-'+index;element.className='hls-video-element';element.loop=true;element.playsInline=true;
      element.src='/silent.wav?native='+index;element.muted=true;instrumentMedia(element);
      resource={video:element,element,disposed:false,failed:false,hls:null,flv:null};playerResources.set(element,resource);
   }
   element.classList.add('video');element.style.order=String(index);pane.appendChild(element);
   const entry={channel,element,resource,muted:true,failed:false};const key=ChannelList.channelKey(channel);activePlayers.set(key,entry);
   fixture.elements.push(element);fixture.entries.push(entry);fixture.keys.push(key);
 });
 for(let index=5;index<Number(document.body.dataset.fixturePlayers||5);index++){
   const channel={id:'layout-'+index,platform:'at',name:'本地佔位 '+index};channels.push(channel);fixture.addPlaceholder(channel);
 }
 new MutationObserver(records=>{for(const record of records)for(const node of record.removedNodes)if(fixture.elements.includes(node))fixture.removals++}).observe(pane,{childList:true});
 fixture.frames.forEach(frame=>frame.window=frame.element.contentWindow);
 syncActivePlayers(channels);
};
fixture.resize=function(width,height){const host=document.getElementById('multi-stream-container-wrapper');host.style.width=width+'px';host.style.height=height+'px'};
fixture.addPlaceholder=function(channel){
 const element=document.createElement('div');element.className='video';
 document.getElementById('multi-stream-container').appendChild(element);
 const key=ChannelList.channelKey(channel);activePlayers.set(key,{channel,element,resource:null,muted:true,failed:false});return key;
};
fixture.order=()=>getPlayerPositionKeys();
fixture.identity=()=>({elements:fixture.elements.every((element,index)=>paneChildren()[index]===element),
 entries:fixture.keys.every((key,index)=>activePlayers.get(key)===fixture.entries[index]),
 windows:fixture.frames.every(frame=>frame.element.contentWindow===frame.window),removals:fixture.removals,frameSources:fixture.frameSources,
 loads:fixture.frames.map(frame=>Number(frame.element.dataset.loads||0))});
function paneChildren(){return Array.from(document.getElementById('multi-stream-container').children)}
fixture.snapshot=()=>fixtureMedia.map(readMedia);
fixture.geometry=function(){
 const rect=element=>{const r=element.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
 const editor=document.getElementById('player-position-editor');
 let saved=null;try{saved=localStorage.getItem('playerEnlargementLayout')}catch(_){}
 return {layout:playerGeometry,order:fixture.order(),mode:editor.dataset.mode,opened:!editor.hidden,saved,
  players:Array.from(activePlayers,([key,entry])=>({key,area:getPlayerElement(entry).style.gridArea,rect:rect(getPlayerElement(entry))})),
  cells:Array.from(editor.querySelectorAll('.player-position-cell'),cell=>({key:cell.dataset.playerKey,area:cell.style.gridArea,rect:rect(cell)}))};
};
fixture.grid=function(){const pane=document.getElementById('multi-stream-container'),style=getComputedStyle(pane),bounds=pane.getBoundingClientRect(),
 overlay=document.querySelector('.player-position-cells'),tracks=style.gridTemplateColumns.split(' ').filter(Boolean);
 return {columns:tracks.length,rows:style.gridTemplateRows.split(' ').filter(Boolean).length,width:pane.clientWidth,height:pane.clientHeight,
 overflowX:pane.scrollWidth-pane.clientWidth,overflowY:pane.scrollHeight-pane.clientHeight,
 overlayColumns:overlay&&!document.getElementById('player-position-editor').hidden?getComputedStyle(overlay).gridTemplateColumns.split(' ').length:null,
 fits:Array.from(activePlayers.values(),getPlayerElement).every(element=>{const r=element.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=bounds.left-.5&&r.top>=bounds.top-.5&&r.right<=bounds.right+.5&&r.bottom<=bounds.bottom+.5})};
};
fixture.mount();fixture.initialGrid=fixture.grid();fixture.initialGeometry=fixture.geometry();`;

async function fixture(t,{width=1800,height=320,viewport={width:2000,height:1300},storageSeed=null,denyStorage=false,players=5,hasTouch=false,framePlatform='at',clock=false,overlayTimeoutSeconds}={}){
    const context=await browser.newContext({viewport,serviceWorkers:'block',...(hasTouch?{hasTouch:true}:{})});t.after(()=>context.close());
    if(storageSeed||denyStorage)await context.addInitScript(({storageSeed,denyStorage,origin})=>{
        if(location.origin!==origin)return;
        if(storageSeed)for(const [key,value]of Object.entries(storageSeed))localStorage.setItem(key,value);
        if(denyStorage)for(const method of ['getItem','setItem','removeItem'])Object.defineProperty(Storage.prototype,method,{
            configurable:true,value(){throw new DOMException('Storage is disabled by the browser','SecurityError')}
        });
    },{storageSeed,denyStorage,origin:new URL(siteUrl).origin});
    const navigations=new Map(),blocked=[];
    assert.ok(['at','kick'].includes(framePlatform));
    let fixtureScript=appScript;
    if(overlayTimeoutSeconds!==undefined){
        assert.ok(Number.isInteger(overlayTimeoutSeconds)&&overlayTimeoutSeconds>0);
        fixtureScript=appScript.replace(/(const\s+PLAYER_OVERLAY_TIMEOUT_SECONDS\s*=\s*)\d+(\s*;)/,(_,prefix,suffix)=>prefix+overlayTimeoutSeconds+suffix);
        assert.notEqual(fixtureScript,appScript,'the reviewed timeout constant must be configurable in this fixture');
    }
    const main=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body data-fixture-players="${players}" data-fixture-frame-platform="${framePlatform}">
    <div style="height:30px;flex:none"><button id="more-channels-btn" onclick="toggleChannelSelection()">看更台</button><button id="adjust-player-positions">調整位置</button><button id="enlarge-player">放大模式</button><button id="reset-player-positions">重設</button><button id="toggle-all-audio">聲音</button></div>
    <div id="channel-selection" style="display:none"><div id="channel-options"></div><button id="fixture-watch-selected" onclick="watchSelectedChannels()">開始觀看</button></div><div id="multi-stream-container-wrapper" style="flex:none;width:${width}px;height:${height}px;min-height:0"><div id="multi-stream-container" class="video-wrapper"></div></div>
    <script src="/instrument.js"></script><script src="/channel-list.js"></script><script src="/stream-performance.js"></script><script src="/player-geometry.js"></script><script src="/player-layout.js"></script><script src="/layout-bookmarks.js"></script><script src="/fixture-app.js"></script></body></html>`;
    const child=`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><video id="frame-video" loop muted playsinline preload="auto" src="/silent.wav" style="width:100%;height:100%"></video><script>${instrument}\ninstrumentMedia(document.getElementById('frame-video'));</script></body></html>`;
    await context.route('**/*',route=>{
        const request=route.request(),url=new URL(request.url());
        if(request.isNavigationRequest()){
            navigations.set(request.url(),(navigations.get(request.url())||0)+1);
            if(request.url()===siteUrl)return route.fulfill({contentType:'text/html',body:main});
            if(url.origin===frameOrigin&&url.pathname==='/player')return route.fulfill({contentType:'text/html',body:child});
        }
        const scripts={'/instrument.js':instrument,'/channel-list.js':channelScript,'/stream-performance.js':performanceScript,'/player-geometry.js':geometryScript,'/player-layout.js':layoutScript,'/layout-bookmarks.js':bookmarkScript,'/fixture-app.js':fixtureScript};
        if(url.origin===new URL(siteUrl).origin&&scripts[url.pathname])return route.fulfill({contentType:'application/javascript; charset=utf-8',body:scripts[url.pathname]});
        if(url.pathname==='/silent.wav'&&[new URL(siteUrl).origin,frameOrigin].includes(url.origin)){
            const range=/^bytes=(\d+)-(\d*)$/.exec(request.headers().range||'');const start=range?Number(range[1]):0;
            const end=range?.[2]?Math.min(Number(range[2]),wav.length-1):wav.length-1;
            return route.fulfill({status:range?206:200,contentType:'audio/wav',body:wav.subarray(start,end+1),headers:{'accept-ranges':'bytes',...(range?{'content-range':`bytes ${start}-${end}/${wav.length}`}:{})}});
        }
        blocked.push(request.url());return route.abort();
    });
    const page=await context.newPage();page.setDefaultTimeout(8000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    if(clock)await page.clock.install({time:new Date('2026-10-20T04:00:00Z')});
    await page.goto(siteUrl,{waitUntil:'load'});
    try{await page.waitForFunction(()=>window.fixture?.keys.length===5&&fixtureMedia.every(saved=>saved.video.readyState>=2))}
    catch(error){console.error('Layout fixture diagnostic:',errors,await page.evaluate(()=>({keys:window.fixture?.keys,media:window.fixtureMedia?.map(saved=>({connected:saved.video.isConnected,state:saved.video.readyState,error:saved.video.error?.message,source:saved.video.currentSrc})),body:document.body.innerText.slice(0,150)})));throw error}
    const frames=page.frames().filter(frame=>frame.url().startsWith(frameOrigin));assert.equal(frames.length,2);
    for(const frame of frames)await frame.waitForFunction(()=>fixtureMedia[0]?.video.readyState>=2);
    await page.evaluate(async()=>{for(const [index,saved]of fixtureMedia.entries()){saved.video.volume=.21+index*.1;saved.video.currentTime=.375;if(index===1){saved.video.muted=false;saved.video.pause()}else await saved.video.play()}});
    for(const [index,frame]of frames.entries())await frame.evaluate(async index=>{const video=fixtureMedia[0].video;video.volume=.33+index*.1;video.currentTime=.375;if(index===1){video.muted=false;video.pause()}else await video.play()},index);
    await page.waitForFunction(()=>fixture.identity().loads.every(count=>count===1));
    if(clock)await page.clock.pauseAt(await page.evaluate(()=>Date.now()+100));
    return {page,frames,navigations,blocked,errors};
}
async function snapshot(f){return {main:await f.page.evaluate(()=>fixture.snapshot()),frames:await Promise.all(f.frames.map(frame=>frame.evaluate(()=>({id:fixtureId,media:fixtureMedia.map(readMedia)}))))}}
function stable(media){const {time,...rest}=media;return rest}
async function assertContinuity(f,before){
    const after=await snapshot(f);assert.deepEqual(after.main.map(stable),before.main.map(stable));
    for(let i=0;i<after.main.length;i++)if(before.main[i].paused)assert.equal(after.main[i].time,before.main[i].time);
    for(let i=0;i<after.frames.length;i++){
        assert.equal(after.frames[i].id,before.frames[i].id,'cross-origin document identity is retained');
        assert.deepEqual(after.frames[i].media.map(stable),before.frames[i].media.map(stable));
        if(before.frames[i].media[0].paused)assert.equal(after.frames[i].media[0].time,before.frames[i].media[0].time);
    }
    assert.deepEqual(await f.page.evaluate(()=>fixture.identity()),{elements:true,entries:true,windows:true,removals:0,frameSources:0,loads:[1,1]});
    assert.ok([...f.navigations.values()].every(count=>count===1));assert.deepEqual(f.blocked,[]);assert.deepEqual(f.errors,[]);
}
async function waitColumns(f,count){await f.page.waitForFunction(count=>fixture.grid().columns===count,count);return f.page.evaluate(()=>fixture.grid())}
function assertFits(grid){assert.equal(grid.fits,true);assert.ok(grid.overflowX<=1,JSON.stringify(grid));assert.ok(grid.overflowY<=1,JSON.stringify(grid))}

function positionCell(f,key){return f.page.locator(`.player-position-cell[data-player-key=${JSON.stringify(key)}]`)}
async function geometry(f){return f.page.evaluate(()=>fixture.geometry())}
async function waitSpan(f,key,span){
    await f.page.waitForFunction(({key,span})=>playerGeometry?.items.find(item=>item.key===key)?.span===span,{key,span});
    return geometry(f);
}
function assertGeometry(state,{overlay=false}={}){
    const items=state.layout?.items;assert.ok(Array.isArray(items),'enlarged layout exposes all player rectangles');
    assert.equal(items.length,state.players.length);assert.equal(new Set(items.map(item=>item.key)).size,items.length);
    assert.equal(items.filter(item=>item.span>1).length,1,'exactly one player stays enlarged');
    for(let i=0;i<state.players.length;i++)for(let j=i+1;j<state.players.length;j++){
        const a=state.players[i].rect,b=state.players[j].rect;
        assert.ok(a.right<=b.left+.5||b.right<=a.left+.5||a.bottom<=b.top+.5||b.bottom<=a.top+.5,`players ${i} and ${j} overlap`);
    }
    if(overlay){
        assert.equal(state.cells.length,state.players.length);
        for(const player of state.players){
            const cell=state.cells.find(cell=>cell.key===player.key);assert.ok(cell,player.key);
            assert.equal(cell.area,player.area,'editor uses the live player grid area');
            for(const side of ['left','top','right','bottom'])assert.ok(Math.abs(cell.rect[side]-player.rect[side])<.55,`${player.key} ${side}: editor ${cell.rect[side]}, player ${player.rect[side]}`);
        }
    }
}
function spans(state){return Object.fromEntries(state.layout.items.map(({key,span})=>[key,span]))}
function allSpans(state){return Object.fromEntries(state.players.map(({key})=>[key,state.layout?.items.find(item=>item.key===key)?.span||1]))}
function withoutFocus(order,key){return order.filter(item=>item!==key)}
async function waitSingleCells(f){
    await f.page.waitForFunction(()=>!playerGeometry?.items.some(item=>item.span>1));return geometry(f);
}
function logicalLayout(state,grid){
    return {columns:state.layout?.columns||grid.columns,rows:state.layout?.rows||grid.rows,order:state.order,
        items:state.layout?.items.map(({key,row,column,span})=>({key,row,column,span})).sort((a,b)=>a.key.localeCompare(b.key))||null,
        areas:state.players.map(({key,area})=>({key,area})).sort((a,b)=>a.key.localeCompare(b.key))};
}
async function readLayout(f){const state=await geometry(f),grid=await f.page.evaluate(()=>fixture.grid());return {state,grid,logical:logicalLayout(state,grid)}}
async function settlePane(f,width,height){
    await f.page.evaluate(({width,height})=>fixture.resize(width,height),{width,height});
    // Exercise the real 180 ms ResizeObserver debounce, including an animation
    // frame before its delivery; direct update() calls would miss timer races.
    await f.page.waitForTimeout(240);
}
async function seventeenPlayers(f){
    await f.page.evaluate(()=>{
        const pane=document.getElementById('multi-stream-container');document.getElementById('multi-stream-container-wrapper').style.padding='0';pane.style.border='0';
        for(let index=5;index<17;index++){
            const channel={id:'layout-'+index,platform:'at',name:'本地佔位 '+index};channels.push(channel);fixture.addPlaceholder(channel);
        }
        fixture.resize(1508,948);syncActivePlayers(channels);
    });
    await f.page.waitForFunction(()=>activePlayers.size===17&&fixture.grid().width===1508&&fixture.grid().height===948);
    await f.page.locator('#enlarge-player').click();return f.page.evaluate(()=>fixture.keys[0]);
}
async function capture(f,name){
    if(!process.env.UMININN_BROWSER_SCREENSHOTS)return;
    const directory=path.resolve(process.env.UMININN_BROWSER_SCREENSHOTS);fs.mkdirSync(directory,{recursive:true});
    await f.page.locator('#multi-stream-container-wrapper').screenshot({path:path.join(directory,`${engine}-${name}.png`)});
}

test('pane-only resize fits five players in wide, portrait and square panes while retaining media and iframe documents',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t);const before=await snapshot(f);
    assertFits(await waitColumns(f,5));const viewport=await f.page.evaluate(()=>[innerWidth,innerHeight]);
    await f.page.evaluate(()=>fixture.resize(320,1100));assertFits(await waitColumns(f,1));
    assert.deepEqual(await f.page.evaluate(()=>[innerWidth,innerHeight]),viewport,'pane resize does not depend on window resize');
    await f.page.evaluate(()=>fixture.resize(800,800));assertFits(await waitColumns(f,2));
    await assertContinuity(f,before);
});

test('position overlay and ArrowDown use the actual columns after a debounced resize; reset preserves every player',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:800,height:800});const before=await snapshot(f);
    await waitColumns(f,2);await f.page.locator('#adjust-player-positions').click();
    await f.page.waitForFunction(()=>fixture.grid().overlayColumns===2);
    const keys=await f.page.evaluate(()=>fixture.order());
    await f.page.locator('.player-position-cell').first().press('ArrowDown');
    const expected=[...keys];[expected[0],expected[2]]=[expected[2],expected[0]];
    assert.deepEqual(await f.page.evaluate(()=>fixture.order()),expected,'move down follows two actual columns, not sqrt(5)');
    await f.page.evaluate(()=>fixture.resize(320,1100));await waitColumns(f,1);
    await f.page.waitForFunction(()=>fixture.grid().overlayColumns===1);
    await f.page.locator('.player-position-cell').first().press('ArrowDown');
    [expected[0],expected[1]]=[expected[1],expected[0]];assert.deepEqual(await f.page.evaluate(()=>fixture.order()),expected);
    await f.page.locator('.player-position-reset').click();assert.deepEqual(await f.page.evaluate(()=>fixture.order()),keys);
    assert.equal(await f.page.evaluate(()=>localStorage.getItem('playerPositionOrder')),null);
    assertFits(await f.page.evaluate(()=>fixture.grid()));await assertContinuity(f,before);
});

test('mobile and desktop viewport changes retain all players on screen without resetting manual pause or sound',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:350,height:780,viewport:{width:375,height:900}});const before=await snapshot(f);
    assertFits(await waitColumns(f,1));
    await f.page.setViewportSize({width:1600,height:1000});await f.page.evaluate(()=>fixture.resize(1500,350));assertFits(await waitColumns(f,5));
    await f.page.setViewportSize({width:375,height:900});await f.page.evaluate(()=>fixture.resize(350,780));assertFits(await waitColumns(f,1));
    await assertContinuity(f,before);
});

test('real ResizeObserver coalesces rapid pane changes and destroy cancels pending layout work',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t);
    await f.page.evaluate(()=>{
        const pane=document.createElement('div');pane.id='observer-test';pane.style.cssText='position:absolute;left:0;top:0;width:300px;height:1000px;display:grid;gap:10px';document.body.appendChild(pane);
        window.layoutChanges=[];window.layoutObserver=PlayerLayout.observe(pane,{getCount:()=>5,onChange:value=>layoutChanges.push({columns:value.columns,time:performance.now()})});layoutObserver.update();
    });
    await f.page.waitForTimeout(230);
    const result=await f.page.evaluate(async()=>{
        const start=layoutChanges.length,pane=document.getElementById('observer-test');
        for(const width of [450,700,1100,1800]){pane.style.width=width+'px';pane.style.height='300px';await new Promise(resolve=>requestAnimationFrame(resolve))}
        window.lastResize=performance.now();return {start,during:layoutChanges.length};
    });assert.equal(result.during,result.start,'a resize burst cannot synchronously reflow the grid repeatedly');
    await f.page.waitForFunction(start=>layoutChanges.length>start,result.start);
    const changed=await f.page.evaluate(()=>({changes:layoutChanges.slice(-1),all:layoutChanges.length,last:lastResize,columns:layoutObserver.getColumns()}));
    assert.equal(changed.all,result.start+1);assert.equal(changed.columns,5);assert.ok(changed.changes[0].time-changed.last>=150,'resize waits for the 180 ms debounce (with frame timing tolerance)');
    await f.page.evaluate(()=>{const pane=document.getElementById('observer-test');pane.style.width='300px';pane.style.height='1000px';layoutObserver.destroy()});
    await f.page.waitForTimeout(240);assert.equal(await f.page.evaluate(()=>layoutChanges.length),changed.all);
});

test('32 players fit a 260 by 8 pane and a mobile 2 percent pane; gap-only changes reach the editor and normal gaps recover',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t);const before=await snapshot(f);
    await f.page.evaluate(()=>{
        const pane=document.getElementById('multi-stream-container');
        for(let index=5;index<32;index++){
            const channel={id:'layout-'+index,platform:'at',name:'本地佔位 '+index};channels.push(channel);
            const element=document.createElement('div');element.className='video';pane.appendChild(element);
            activePlayers.set(ChannelList.channelKey(channel),{channel,element,resource:null,muted:true,failed:false});
        }
        syncActivePlayers(channels);
        // Remove only the fixture host's decorative padding/border so its exact
        // usable playback area can be 260x8; grid rules remain production CSS.
        document.getElementById('multi-stream-container-wrapper').style.padding='0';pane.style.border='0';
        fixture.resize(260,8);
        window.thinGrid=function(){
            const pane=document.getElementById('multi-stream-container'),bounds=pane.getBoundingClientRect(),style=getComputedStyle(pane),
                cells=document.querySelector('.player-position-cells'),overlay=getComputedStyle(cells);
            const rects=Array.from(pane.children,element=>{const r=element.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}});
            return {count:rects.length,width:pane.clientWidth,height:pane.clientHeight,columns:style.gridTemplateColumns.split(' ').length,
                rowGap:parseFloat(style.rowGap),columnGap:parseFloat(style.columnGap),overlayRowGap:parseFloat(overlay.rowGap),overlayColumnGap:parseFloat(overlay.columnGap),
                overlayColumns:overlay.gridTemplateColumns.split(' ').length,overflowX:pane.scrollWidth-pane.clientWidth,overflowY:pane.scrollHeight-pane.clientHeight,
                fits:rects.every(r=>r.width>0&&r.height>0&&r.left>=bounds.left-.05&&r.top>=bounds.top-.05&&r.right<=bounds.right+.05&&r.bottom<=bounds.bottom+.05)};
        };
    });
    await f.page.waitForFunction(()=>thinGrid().height===8&&thinGrid().rowGap<.2&&thinGrid().fits);
    await f.page.locator('#adjust-player-positions').click();
    await f.page.waitForFunction(()=>{const g=thinGrid();return g.overlayColumns===g.columns&&g.overlayRowGap===g.rowGap&&g.overlayColumnGap===g.columnGap});
    const thin=await f.page.evaluate(()=>thinGrid());
    assert.equal(thin.count,32);assert.equal(thin.width,260);assert.equal(thin.height,8);assertFits(thin);
    await f.page.evaluate(()=>fixture.resize(260,10));
    await f.page.waitForFunction(previous=>{const g=thinGrid();return g.rowGap>previous.rowGap&&g.overlayRowGap===g.rowGap&&g.overlayColumnGap===g.columnGap},thin);
    const slightlyTaller=await f.page.evaluate(()=>thinGrid());assert.equal(slightlyTaller.columns,thin.columns,'the editor must update even when only gap values changed');assertFits(slightlyTaller);
    await f.page.setViewportSize({width:375,height:900});
    await f.page.evaluate(()=>{
        const pane=document.getElementById('multi-stream-container'),host=document.getElementById('multi-stream-container-wrapper');
        fixture.resize(350,780);pane.style.setProperty('flex','.02 1 0','important');
        const chat=document.createElement('div');chat.id='layout-fixture-chat';chat.className='chat';chat.style.cssText='flex:.98 1 0;min-height:0';host.appendChild(chat);
    });
    await f.page.waitForFunction(()=>{const g=thinGrid();return g.height>0&&g.height<20&&g.fits&&g.overlayRowGap===g.rowGap&&g.overlayColumnGap===g.columnGap});
    assertFits(await f.page.evaluate(()=>thinGrid()));
    await f.page.setViewportSize({width:2000,height:1300});
    await f.page.evaluate(()=>{document.getElementById('layout-fixture-chat').remove();document.getElementById('multi-stream-container').style.removeProperty('flex');fixture.resize(1800,1000)});
    await f.page.waitForFunction(()=>{const g=thinGrid(),normal=parseFloat(getComputedStyle(document.getElementById('multi-stream-container')).fontSize)*.625;return Math.abs(g.rowGap-normal)<.01&&Math.abs(g.columnGap-normal)<.01&&g.overlayRowGap===g.rowGap&&g.overlayColumnGap===g.columnGap&&g.fits});
    assertFits(await f.page.evaluate(()=>thinGrid()));await assertContinuity(f,before);
});

test('enlarge mode grows one player repeatedly, changes focus, and Esc keeps a persisted collision-free layout without restarting playback',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000});const before=await snapshot(f);
    const keys=await f.page.evaluate(()=>fixture.order()),target=keys[3];
    await f.page.locator('#enlarge-player').click();
    await f.page.waitForFunction(()=>fixture.geometry().opened&&fixture.geometry().mode==='enlarge');
    for(const span of [2,3,4]){
        await positionCell(f,target).click();
        const state=await waitSpan(f,target,span);assertGeometry(state,{overlay:true});
        assert.equal(state.layout.items.reduce((total,item)=>total+item.span*item.span,0),keys.length+span*span-1,'each click adds one row and one column to the enlarged square');
        assertFits(await f.page.evaluate(()=>fixture.grid()));
        if(span===3)await capture(f,'enlarge-desktop');
    }
    await positionCell(f,keys[0]).click();
    const changed=await waitSpan(f,keys[0],2);assert.equal(spans(changed)[target],1,'selecting a different player restores the previous player to one cell');
    assertGeometry(changed,{overlay:true});assert.ok(changed.saved,'enlargement is saved independently of editor visibility');
    await f.page.keyboard.press('Escape');
    await f.page.waitForFunction(()=>!fixture.geometry().opened);
    const closed=await geometry(f);assert.deepEqual(closed.layout,changed.layout);assert.equal(closed.saved,changed.saved);
    assertFits(await f.page.evaluate(()=>fixture.grid()));await assertContinuity(f,before);

    // Reload tests persistence separately: a navigation necessarily creates fresh media.
    await f.page.reload({waitUntil:'load'});
    await f.page.waitForFunction(({key})=>fixture.geometry().layout?.items.some(item=>item.key===key&&item.span===2),{key:keys[0]});
    const restored=await geometry(f);assert.equal(restored.opened,false);assert.equal(spans(restored)[target],1);
    assertGeometry(restored);assertFits(await f.page.evaluate(()=>fixture.grid()));
});

test('an enlarged layout supports click, drag and spatial arrow moves, follows portrait resize, and reset clears both saved layouts',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000});const before=await snapshot(f);
    const keys=await f.page.evaluate(()=>fixture.order()),target=keys[4];
    await f.page.locator('#enlarge-player').click();
    await positionCell(f,target).click();await waitSpan(f,target,2);
    await positionCell(f,target).click();const enlarged=await waitSpan(f,target,3),expectedSpans=spans(enlarged);
    await f.page.keyboard.press('Escape');await f.page.locator('#adjust-player-positions').click();
    await f.page.waitForFunction(()=>fixture.geometry().mode==='move');
    assertGeometry(await geometry(f),{overlay:true});

    await positionCell(f,target).click();await positionCell(f,keys[0]).click();
    const clicked=await geometry(f);assert.notDeepEqual(clicked.order,enlarged.order,'clicking two cells moves the enlarged player');
    assert.deepEqual(spans(clicked),expectedSpans);assertGeometry(clicked,{overlay:true});

    const source=await positionCell(f,keys[1]).boundingBox(),destination=await positionCell(f,keys[3]).boundingBox();assert.ok(source&&destination);
    await f.page.mouse.move(source.x+source.width/2,source.y+source.height/2);await f.page.mouse.down();
    await f.page.mouse.move(destination.x+destination.width/2,destination.y+destination.height/2,{steps:8});await f.page.mouse.up();
    const dragged=await geometry(f);assert.notDeepEqual(dragged.order,clicked.order,'dragging moves a player in the enlarged layout');
    assert.deepEqual(spans(dragged),expectedSpans);assertGeometry(dragged,{overlay:true});

    // Pick a guaranteed spatial neighbor from actual occupied rectangles. The
    // enlarged cell invalidates row-major index offsets used by a uniform grid.
    const neighbor=await f.page.evaluate(()=>{
        const items=playerGeometry.items;
        for(const source of items)for(const target of items){
            if(source===target)continue;
            const vertical=Math.min(source.row+source.span,target.row+target.span)>Math.max(source.row,target.row);
            const horizontal=Math.min(source.column+source.span,target.column+target.span)>Math.max(source.column,target.column);
            if(vertical&&target.column>=source.column+source.span)return {source:source.key,key:'ArrowRight'};
            if(horizontal&&target.row>=source.row+source.span)return {source:source.key,key:'ArrowDown'};
        }
        return null;
    });assert.ok(neighbor,'there is an occupied cell in an arrow direction');
    await positionCell(f,neighbor.source).press(neighbor.key);
    const arrow=await geometry(f);assert.notDeepEqual(arrow.order,dragged.order,'an arrow finds an actual spatial neighbor');
    assert.deepEqual(spans(arrow),expectedSpans);assertGeometry(arrow,{overlay:true});

    await f.page.setViewportSize({width:375,height:900});await f.page.evaluate(()=>fixture.resize(320,780));
    await f.page.waitForFunction(()=>{const g=fixture.grid();return g.width<350&&g.fits&&g.overlayColumns===g.columns});
    // Overlay positioning is scheduled separately from the debounced layout.
    await f.page.waitForFunction(()=>{
        const g=fixture.geometry();return g.cells.every(cell=>{const player=g.players.find(player=>player.key===cell.key);return ['left','top','right','bottom'].every(side=>Math.abs(cell.rect[side]-player.rect[side])<.55)});
    });
    const portrait=await geometry(f);assert.deepEqual(spans(portrait),expectedSpans);assertGeometry(portrait,{overlay:true});assertFits(await f.page.evaluate(()=>fixture.grid()));
    await capture(f,'enlarge-mobile-move');
    await f.page.locator('.player-position-reset').click();
    await f.page.waitForFunction(()=>!localStorage.getItem('playerEnlargementLayout')&&!localStorage.getItem('playerPositionOrder'));
    assert.deepEqual(await f.page.evaluate(()=>fixture.order()),keys);
    assert.ok(!(await geometry(f)).layout?.items.some(item=>item.span>1),'reset restores every player to a single cell');
    assertFits(await waitColumns(f,1));await assertContinuity(f,before);
});

test('enlargement survives selection changes, stays saved while its channel is hidden, and can still be reset',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000});const before=await snapshot(f);
    const key=await f.page.evaluate(()=>fixture.keys[0]);await f.page.locator('#enlarge-player').click();await positionCell(f,key).click();
    const enlarged=await waitSpan(f,key,2);
    await f.page.evaluate(()=>syncActivePlayers(channels));assert.deepEqual(spans(await geometry(f)),spans(enlarged));
    await f.page.evaluate(()=>{
        const channel={id:'extra-inert',platform:'at',name:'新增本地佔位'},element=document.createElement('div');
        element.className='video';document.getElementById('multi-stream-container').appendChild(element);channels.push(channel);
        activePlayers.set(ChannelList.channelKey(channel),{channel,element,resource:null,muted:true,failed:false});syncActivePlayers(channels);
    });
    const added=await waitSpan(f,key,2);assert.equal(added.layout.items.length,6);assertGeometry(added,{overlay:true});assertFits(await f.page.evaluate(()=>fixture.grid()));
    await f.page.evaluate(()=>{channels=channels.filter(channel=>channel.id!=='extra-inert');syncActivePlayers(channels)});
    const removed=await waitSpan(f,key,2);assert.equal(removed.layout.items.length,5);assertGeometry(removed,{overlay:true});await assertContinuity(f,before);
    await f.page.evaluate(key=>{channels=channels.filter(channel=>ChannelList.channelKey(channel)!==key);syncActivePlayers(channels)},key);
    assert.ok(!(await geometry(f)).layout?.items.some(item=>item.span>1));
    const hiddenSaved=await f.page.evaluate(()=>localStorage.getItem('playerEnlargementLayout'));
    assert.equal(JSON.parse(hiddenSaved).focus.key,key,'hidden channel preferences remain saved like the preferred position order');
    assert.equal(await f.page.locator('.player-position-shrink').isDisabled(),true);
    assert.equal(await f.page.evaluate(key=>shrinkPlayer(key),key),false);
    assert.equal(await f.page.evaluate(()=>localStorage.getItem('playerEnlargementLayout')),hiddenSaved,'an unavailable shrink cannot discard the hidden size preference');
    assertFits(await f.page.evaluate(()=>fixture.grid()));
    await f.page.locator('.player-position-reset').click();
    assert.equal(await f.page.evaluate(()=>localStorage.getItem('playerEnlargementLayout')),null);
    assert.equal(await f.page.evaluate(()=>localStorage.getItem('playerPositionOrder')),null);
});

test('a failed native player keeps its enlarged grid area and matching move overlay after replacement',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000});
    const key=await f.page.evaluate(()=>fixture.keys[0]);await f.page.locator('#enlarge-player').click();await positionCell(f,key).click();
    const enlarged=await waitSpan(f,key,2),area=enlarged.players.find(player=>player.key===key).area;
    await f.page.evaluate(()=>replacePlayerWithError(fixture.entries[0].resource,'本地模擬播放失敗'));
    assert.equal(await f.page.evaluate(()=>fixture.entries[0].resource.element.textContent),'本地模擬播放失敗');
    assert.equal((await geometry(f)).players.find(player=>player.key===key).area,area);
    await f.page.keyboard.press('Escape');await f.page.locator('#adjust-player-positions').click();
    const state=await geometry(f);assert.deepEqual(state.layout,enlarged.layout);assertGeometry(state,{overlay:true});assertFits(await f.page.evaluate(()=>fixture.grid()));
    await f.page.locator('#enlarge-player').click();await f.page.locator('.player-position-shrink').click();
    const shrunk=await waitSingleCells(f);assert.equal(shrunk.saved,null);assert.equal(shrunk.players.find(player=>player.key===key).area,'');
    assert.equal(await f.page.evaluate(()=>fixture.entries[0].resource.element.textContent),'本地模擬播放失敗');assertFits(await f.page.evaluate(()=>fixture.grid()));
    assert.deepEqual(f.errors,[]);assert.deepEqual(f.blocked,[]);
});

test('a tall saved enlargement anchor still fits after selection shrinks to two players in an eight-pixel pane',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000});
    await f.page.evaluate(()=>{
        enlargedPlayerFocus={key:fixture.keys[0],span:2,row:98,column:0};pendingPlayerGeometry={columns:2};updatePlayerLayout();
        syncActivePlayers(channels.slice(0,2));
        const pane=document.getElementById('multi-stream-container');
        document.getElementById('multi-stream-container-wrapper').style.padding='0';pane.style.border='0';fixture.resize(260,8);
    });
    await f.page.waitForFunction(()=>{const g=fixture.grid();return g.height===8&&g.fits&&playerGeometry?.rows===100});
    const grid=await f.page.evaluate(()=>fixture.grid());assertFits(grid);assert.equal((await geometry(f)).layout.items.length,2);
    assert.ok(await f.page.evaluate(()=>parseFloat(getComputedStyle(document.getElementById('multi-stream-container')).rowGap)<.1),'gap limit accounts for the saved row anchor rather than only the active channel count');
    await f.page.locator('#adjust-player-positions').click();assertGeometry(await geometry(f),{overlay:true});
    assert.deepEqual(f.errors,[]);assert.deepEqual(f.blocked,[]);
});

test('malformed preferences and denied browser storage never prevent enlarging, moving or resetting live players',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;
    const cases=[
        {name:'malformed JSON',storageSeed:{playerPositionOrder:'{',playerEnlargementLayout:'['}},
        {name:'invalid saved focus',storageSeed:{playerPositionOrder:'null',playerEnlargementLayout:JSON.stringify({version:1,columns:2,focus:{key:'m3u8|layout-0',span:2,row:-1,column:0}})}},
        {name:'mixed and duplicate order entries',storageSeed:{playerPositionOrder:JSON.stringify([null,7,{},'m3u8|layout-4','m3u8|layout-4']),playerEnlargementLayout:JSON.stringify({version:1,columns:1000,focus:{key:'m3u8|layout-0',span:257,row:900,column:0}})}},
        {name:'storage reads and writes denied',denyStorage:true}
    ];
    for(const scenario of cases)await t.test(scenario.name,async sub=>{
        const f=await fixture(sub,{width:1300,height:1000,...scenario}),before=await snapshot(f);
        const keys=await f.page.evaluate(()=>fixture.keys);assert.equal(new Set(await f.page.evaluate(()=>fixture.order())).size,5);
        assert.equal((await geometry(f)).layout,null,'invalid focus data is ignored at initialization');
        assert.equal(await f.page.locator('#enlarge-player').isEnabled(),true);assert.equal(await f.page.locator('#adjust-player-positions').isEnabled(),true);
        await f.page.locator('#enlarge-player').click();await positionCell(f,keys[0]).click();assertGeometry(await waitSpan(f,keys[0],2),{overlay:true});
        await f.page.keyboard.press('Escape');await f.page.locator('#adjust-player-positions').click();
        const oldOrder=await f.page.evaluate(()=>fixture.order());await positionCell(f,keys[1]).click();await positionCell(f,keys[3]).click();
        assert.notDeepEqual(await f.page.evaluate(()=>fixture.order()),oldOrder,'position editing works even if preference persistence fails');
        assertGeometry(await geometry(f),{overlay:true});
        await f.page.locator('.player-position-reset').click();assert.deepEqual(await f.page.evaluate(()=>fixture.order()),keys);
        assert.equal((await geometry(f)).layout,null);assertFits(await f.page.evaluate(()=>fixture.grid()));await assertContinuity(f,before);
    });
});

test('a valid but excessively wide saved grid is fitted before the first rendered enlarged layout',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const key='m3u8|layout-0';
    const f=await fixture(t,{width:1300,height:1000,storageSeed:{playerEnlargementLayout:JSON.stringify({
        version:1,columns:768,focus:{key,span:2,row:0,column:512}
    })}}),before=await snapshot(f);
    const initial=await f.page.evaluate(()=>({grid:fixture.initialGrid,state:fixture.initialGeometry}));
    assertFits(initial.grid);assert.ok(initial.state.layout.columns<=6,'the first layout must fit without waiting for ResizeObserver to correct persisted columns');
    const state=await waitSpan(f,key,2);assert.ok(state.layout.columns<=6,'saved columns cannot exceed the enlarged span plus the ordinary player count');
    assertGeometry(state);assertFits(await f.page.evaluate(()=>fixture.grid()));
    await f.page.locator('#adjust-player-positions').click();assertGeometry(await geometry(f),{overlay:true});
    await f.page.evaluate(()=>fixture.resize(320,780));
    await f.page.waitForFunction(()=>fixture.grid().width<350&&fixture.grid().fits);
    assertFits(await f.page.evaluate(()=>fixture.grid()));assert.equal(spans(await geometry(f))[key],2);await assertContinuity(f,before);
});

test('small base cells in a large enlargement keep editor hit targets aligned to their live player rectangles',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const key='m3u8|layout-0';
    const f=await fixture(t,{width:375,height:500,viewport:{width:400,height:600},storageSeed:{playerEnlargementLayout:JSON.stringify({
        version:1,columns:30,focus:{key,span:30,row:0,column:0}
    })}}),before=await snapshot(f);
    await waitSpan(f,key,30);assertFits(await f.page.evaluate(()=>fixture.grid()));
    for(const mode of ['#enlarge-player','#adjust-player-positions']){
        await f.page.locator(mode).click();
        assertGeometry(await geometry(f),{overlay:true});
    }
    await assertContinuity(f,before);
});

test('zero and one selected player close both editors, then reselecting the saved focus restores one enlargement and reenables controls',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000}),key=await f.page.evaluate(()=>fixture.keys[0]);
    await f.page.locator('#enlarge-player').click();await positionCell(f,key).click();await waitSpan(f,key,2);
    await positionCell(f,key).click();const enlarged=await waitSpan(f,key,3);
    await f.page.evaluate(()=>{window.savedFixtureChannels=[...channels];syncActivePlayers([])});
    assert.equal((await geometry(f)).opened,false);assert.equal((await geometry(f)).layout,null);
    assert.equal(await f.page.locator('#enlarge-player').isDisabled(),true);assert.equal(await f.page.locator('#adjust-player-positions').isDisabled(),true);
    assert.equal(JSON.parse((await geometry(f)).saved).focus.key,key);
    assert.equal(await f.page.locator('#enlarge-player').getAttribute('aria-expanded'),'false');assert.equal(await f.page.locator('#adjust-player-positions').getAttribute('aria-expanded'),'false');
    await f.page.evaluate(()=>{fixture.addPlaceholder(savedFixtureChannels[1]);syncActivePlayers([savedFixtureChannels[1]])});
    assert.equal((await geometry(f)).opened,false);assert.equal((await geometry(f)).layout,null);assertFits(await f.page.evaluate(()=>fixture.grid()));
    assert.equal(await f.page.locator('#enlarge-player').isDisabled(),true);assert.equal(await f.page.locator('#adjust-player-positions').isDisabled(),true);
    await f.page.evaluate(()=>{fixture.addPlaceholder(savedFixtureChannels[0]);syncActivePlayers(savedFixtureChannels.slice(0,2))});
    const restored=await waitSpan(f,key,3);assert.equal(restored.opened,false);assert.equal(restored.layout.items.length,2);assert.equal(spans(restored)[key],spans(enlarged)[key]);
    assert.equal(await f.page.locator('#enlarge-player').isEnabled(),true);assert.equal(await f.page.locator('#adjust-player-positions').isEnabled(),true);
    await f.page.locator('#adjust-player-positions').click();assertGeometry(await geometry(f),{overlay:true});
    await f.page.evaluate(()=>syncActivePlayers([savedFixtureChannels[0]]));
    assert.equal((await geometry(f)).opened,false);assert.equal((await geometry(f)).layout,null);assertFits(await f.page.evaluate(()=>fixture.grid()));
    assert.equal(await f.page.locator('#adjust-player-positions').isDisabled(),true);assert.equal(await f.page.locator('.player-position-shrink').isDisabled(),true);
    assert.equal(await f.page.evaluate(key=>shrinkPlayer(key),key),false);assert.deepEqual(f.errors,[]);assert.deepEqual(f.blocked,[]);
});

test('replacing a selected channel at unchanged player count refreshes enlarged geometry and editor targets',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000}),keys=await f.page.evaluate(()=>fixture.keys);
    await f.page.locator('#enlarge-player').click();await positionCell(f,keys[0]).click();await waitSpan(f,keys[0],2);
    await f.page.locator('#adjust-player-positions').click();
    const replacement=await f.page.evaluate(()=>{
        const channel={id:'same-count-replacement',platform:'at',name:'替換本地佔位'},key=fixture.addPlaceholder(channel);
        syncActivePlayers([...channels.slice(0,4),channel]);return key;
    });
    const state=await geometry(f);assert.equal(state.layout.items.length,5);assert.equal(state.opened,true);assert.equal(state.mode,'move');
    assert.equal(state.layout.items.some(item=>item.key===keys[4]),false);assert.equal(spans(state)[replacement],1);assert.equal(spans(state)[keys[0]],2);
    assert.equal(await positionCell(f,keys[4]).count(),0);assertGeometry(state,{overlay:true});
    await positionCell(f,replacement).click();await positionCell(f,keys[1]).click();
    assert.notDeepEqual((await geometry(f)).order,state.order);assertGeometry(await geometry(f),{overlay:true});assertFits(await f.page.evaluate(()=>fixture.grid()));
    assert.deepEqual(f.errors,[]);assert.deepEqual(f.blocked,[]);
});

test('canceled or interrupted drags cannot swap players or leak an enlargement into a newly selected mode',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys);
    await f.page.evaluate(()=>document.addEventListener('pointerdown',event=>{window.lastFixturePointer=event.pointerId},true));
    await f.page.locator('#adjust-player-positions').click();
    async function startDrag(){
        const source=await positionCell(f,keys[1]).boundingBox(),target=await positionCell(f,keys[4]).boundingBox();assert.ok(source&&target);
        await f.page.mouse.move(source.x+source.width/2,source.y+source.height/2);await f.page.mouse.down();
        await f.page.mouse.move(target.x+target.width/2,target.y+target.height/2,{steps:8});
        await f.page.waitForFunction(()=>document.querySelector('.position-dragging'));
        return f.page.evaluate(()=>lastFixturePointer);
    }
    for(const eventName of ['pointercancel','lostpointercapture']){
        const order=await f.page.evaluate(()=>fixture.order()),id=await startDrag();
        await positionCell(f,keys[1]).dispatchEvent(eventName,{pointerId:id,pointerType:'mouse',isPrimary:true,bubbles:true});
        await f.page.mouse.up();assert.deepEqual(await f.page.evaluate(()=>fixture.order()),order,eventName+' must cancel a pending swap');
        assert.equal(await f.page.locator('.position-dragging,.position-target').count(),0);assert.equal((await geometry(f)).layout,null);
        await positionCell(f,keys[2]).click();assert.deepEqual(await f.page.evaluate(()=>fixture.order()),order,'the first new click only selects a player');
        await positionCell(f,keys[3]).click();assert.notDeepEqual(await f.page.evaluate(()=>fixture.order()),order,'a fresh interaction still works after cancellation');
    }
    const order=await f.page.evaluate(()=>fixture.order());await startDrag();
    await f.page.evaluate(()=>document.getElementById('enlarge-player').click());await f.page.mouse.up();
    const switched=await geometry(f);assert.equal(switched.mode,'enlarge');assert.equal(switched.layout,null);assert.deepEqual(switched.order,order);
    assert.equal(await f.page.locator('.position-dragging,.position-target,.position-picked').count(),0);
    await positionCell(f,keys[0]).click();const enlarged=await waitSpan(f,keys[0],2);assertGeometry(enlarged,{overlay:true});
    await positionCell(f,keys[0]).press('ArrowDown');
    assert.deepEqual((await geometry(f)).layout,enlarged.layout,'arrow navigation in enlarge mode cannot grow or move a player');
    await f.page.locator('#adjust-player-positions').click();assert.deepEqual(spans(await geometry(f)),spans(enlarged));
    await assertContinuity(f,before);
});

test('shrinking steps from three cells to two to one without resetting moved order, and regrowing starts at two',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys);
    await f.page.locator('#adjust-player-positions').click();assert.equal(await f.page.locator('.player-position-shrink').isHidden(),true);
    await positionCell(f,keys[0]).click();await positionCell(f,keys[1]).click();
    await f.page.locator('#enlarge-player').click();const shrink=f.page.locator('.player-position-shrink');
    assert.equal(await shrink.isVisible(),true);assert.equal(await shrink.isDisabled(),true,'there is no enlarged focus yet');
    await positionCell(f,keys[4]).click();await waitSpan(f,keys[4],2);
    await positionCell(f,keys[4]).click();const grown=await waitSpan(f,keys[4],3),order=grown.order;
    assert.notDeepEqual(order,keys,'the shrink operation starts from a manually changed layout');
    assert.deepEqual(await f.page.evaluate(keys=>[shrinkPlayer(keys[2]),shrinkPlayer('at|missing-player')],keys),[false,false],'only the active enlarged focus can shrink');
    assert.deepEqual((await geometry(f)).layout,grown.layout);
    assert.equal(await shrink.isEnabled(),true);
    await shrink.click();const partial=await waitSpan(f,keys[4],2);
    assert.deepEqual(withoutFocus(partial.order,keys[4]),withoutFocus(order,keys[4]));assertGeometry(partial,{overlay:true});
    assert.deepEqual(allSpans(partial),Object.fromEntries(keys.map(key=>[key,key===keys[4]?2:1])),'only the current focus changes size');
    assert.equal(JSON.parse(partial.saved).focus.span,2);assertFits(await f.page.evaluate(()=>fixture.grid()));
    await capture(f,'shrink-desktop');
    await shrink.click();const normal=await waitSingleCells(f);
    assert.deepEqual(normal.order,partial.order,'returning to one cell retains the current manual order');assert.equal(normal.saved,null);
    assert.deepEqual(allSpans(normal),Object.fromEntries(keys.map(key=>[key,1])));assert.equal(await shrink.isDisabled(),true);
    const savedOrder=await f.page.evaluate(()=>localStorage.getItem('playerPositionOrder'));assert.ok(savedOrder,'shrinking cannot clear the saved player order');
    assert.deepEqual(JSON.parse(savedOrder).slice(0,5),partial.order);
    const result=await f.page.evaluate(key=>{document.querySelector('.player-position-shrink').click();return shrinkPlayer(key)},keys[4]);
    assert.equal(result,false,'the public action also rejects a shrink below one cell');assert.deepEqual((await geometry(f)).order,partial.order);
    await positionCell(f,keys[4]).click();const regrown=await waitSpan(f,keys[4],2);assertGeometry(regrown,{overlay:true});
    assert.equal(await shrink.isEnabled(),true);assertFits(await f.page.evaluate(()=>fixture.grid()));await assertContinuity(f,before);
});

test('a partial shrink survives Esc and reload, while the shrink control stays exclusive to enlarge mode',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000}),before=await snapshot(f),key=await f.page.evaluate(()=>fixture.keys[0]);
    await f.page.locator('#enlarge-player').click();await positionCell(f,key).click();await waitSpan(f,key,2);
    await positionCell(f,key).click();await waitSpan(f,key,3);
    await f.page.locator('.player-position-shrink').press('Enter');const partial=await waitSpan(f,key,2);
    await f.page.keyboard.press('Escape');const closed=await geometry(f);assert.equal(closed.opened,false);assert.deepEqual(closed.layout,partial.layout);assert.equal(closed.saved,partial.saved);
    await assertContinuity(f,before);
    await f.page.reload({waitUntil:'load'});const restored=await waitSpan(f,key,2);assert.equal(restored.opened,false);
    assert.equal(JSON.parse(restored.saved).focus.span,2);assertGeometry(restored);assertFits(await f.page.evaluate(()=>fixture.grid()));
    await f.page.locator('#adjust-player-positions').click();assert.equal(await f.page.locator('.player-position-shrink').isHidden(),true);
    await f.page.locator('#enlarge-player').click();assert.equal(await f.page.locator('.player-position-shrink').isVisible(),true);assert.equal(await f.page.locator('.player-position-shrink').isEnabled(),true);
    assertGeometry(await geometry(f),{overlay:true});
});

test('a moved enlarged focus can shrink in a portrait pane without changing manual order or playback',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys),key=keys[0];
    await f.page.locator('#enlarge-player').click();await positionCell(f,key).click();await waitSpan(f,key,2);
    await positionCell(f,key).click();const grown=await waitSpan(f,key,3);
    await f.page.locator('#adjust-player-positions').click();await positionCell(f,key).click();await positionCell(f,keys[4]).click();
    const moved=await geometry(f);assert.notDeepEqual(moved.order,grown.order);assert.equal(spans(moved)[key],3);
    await f.page.setViewportSize({width:375,height:900});await f.page.evaluate(()=>fixture.resize(320,780));
    await f.page.waitForFunction(()=>fixture.grid().width<350&&fixture.grid().fits);
    await f.page.locator('#enlarge-player').click();const order=(await geometry(f)).order;
    await f.page.locator('.player-position-shrink').click();const partial=await waitSpan(f,key,2);
    assert.deepEqual(withoutFocus(partial.order,key),withoutFocus(order,key));assertGeometry(partial,{overlay:true});assertFits(await f.page.evaluate(()=>fixture.grid()));
    // The four-button mobile toolbar now wraps. Its edge switch exposes the
    // first row without forcing the controls into a single overflowing row.
    if(await f.page.locator('#player-position-editor').getAttribute('data-toolbar-position')!=='bottom')await f.page.locator('.player-position-toolbar-toggle').click();
    const toolbar=await f.page.evaluate(()=>{
        const bar=document.querySelector('.player-position-toolbar'),bounds=bar.getBoundingClientRect();
        const buttons=Array.from(bar.querySelectorAll('button'),button=>button.getBoundingClientRect());
        const cells=Array.from(document.querySelectorAll('.player-position-cell'));
        const top=Math.min(...cells.map(cell=>cell.getBoundingClientRect().top));
        const firstRow=cells.filter(cell=>Math.abs(cell.getBoundingClientRect().top-top)<.5);
        return {fits:buttons.every(rect=>rect.left>=bounds.left&&rect.right<=bounds.right),
            targetsExposed:firstRow.every(cell=>{const rect=cell.getBoundingClientRect();return cell.contains(document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2))})};
    });
    assert.equal(toolbar.fits,true);assert.equal(toolbar.targetsExposed,true,'moving the wrapped mobile toolbar to the bottom exposes first-row player targets');
    await capture(f,'shrink-mobile');
    await f.page.locator('.player-position-shrink').click();const normal=await waitSingleCells(f);assert.deepEqual(normal.order,partial.order);assert.equal(normal.saved,null);
    const topCell=f.page.locator('.player-position-cell').first(),topKey=await topCell.getAttribute('data-player-key');
    await topCell.click();assertGeometry(await waitSpan(f,topKey,2),{overlay:true});
    await f.page.locator('.player-position-shrink').click();await waitSingleCells(f);
    assertFits(await f.page.evaluate(()=>fixture.grid()));await assertContinuity(f,before);
});

test('shrink handles high spans and very thin panes while preserving precise editor targets',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const key='m3u8|layout-0';
    const f=await fixture(t,{width:375,height:500,viewport:{width:400,height:600},storageSeed:{playerEnlargementLayout:JSON.stringify({
        version:1,columns:30,focus:{key,span:30,row:0,column:0}
    })}}),before=await snapshot(f);
    await waitSpan(f,key,30);await f.page.locator('#enlarge-player').click();const order=(await geometry(f)).order;
    await f.page.locator('.player-position-shrink').click();const partial=await waitSpan(f,key,29);
    assert.deepEqual(withoutFocus(partial.order,key),withoutFocus(order,key));assertGeometry(partial,{overlay:true});assertFits(await f.page.evaluate(()=>fixture.grid()));
    await f.page.evaluate(()=>{
        const pane=document.getElementById('multi-stream-container');document.getElementById('multi-stream-container-wrapper').style.padding='0';pane.style.border='0';fixture.resize(260,8);
    });
    await f.page.waitForFunction(()=>fixture.grid().height===8&&fixture.grid().fits);
    // A programmatic click represents keyboard activation when the visible
    // toolbar is taller than this deliberately pathological playback pane.
    await f.page.evaluate(()=>document.querySelector('.player-position-shrink').click());const thin=await waitSpan(f,key,28);
    assert.deepEqual(withoutFocus(thin.order,key),withoutFocus(order,key));assertGeometry(thin,{overlay:true});assertFits(await f.page.evaluate(()=>fixture.grid()));await assertContinuity(f,before);
});

test('shrink works without browser storage and is disabled for hidden, single or absent enlarged players',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000,denyStorage:true}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys),key=keys[0];
    await f.page.locator('#enlarge-player').click();await positionCell(f,key).click();await waitSpan(f,key,2);
    await positionCell(f,key).click();await waitSpan(f,key,3);await f.page.locator('.player-position-shrink').click();
    assertGeometry(await waitSpan(f,key,2),{overlay:true});await f.page.locator('.player-position-shrink').click();
    await waitSingleCells(f);assert.equal(await f.page.locator('.player-position-shrink').isDisabled(),true);await assertContinuity(f,before);
    await positionCell(f,key).click();await waitSpan(f,key,2);
    await f.page.evaluate(key=>syncActivePlayers(channels.filter(channel=>ChannelList.channelKey(channel)!==key)),key);
    assert.equal((await geometry(f)).opened,true);assert.equal(await f.page.locator('.player-position-shrink').isDisabled(),true,'a saved but hidden focus cannot be shrunk');
    assert.equal(await f.page.evaluate(key=>shrinkPlayer(key),key),false);
    await f.page.evaluate(()=>syncActivePlayers([channels[1]]));assert.equal((await geometry(f)).opened,false);
    assert.equal(await f.page.locator('.player-position-shrink').isDisabled(),true);
    await f.page.evaluate(()=>syncActivePlayers([]));assert.equal((await geometry(f)).opened,false);assert.equal(await f.page.locator('.player-position-shrink').isDisabled(),true);
    assert.deepEqual(f.errors,[]);assert.deepEqual(f.blocked,[]);
});

test('switching the enlarged focus after a column change preserves the current visual order of all other players',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys);
    await waitColumns(f,2);await f.page.locator('#enlarge-player').click();await positionCell(f,keys[4]).click();
    const first=await waitSpan(f,keys[4],2);assert.equal(first.layout.columns,2);
    await f.page.evaluate(()=>fixture.resize(1800,320));
    await f.page.waitForFunction(()=>playerGeometry?.columns===3&&fixture.grid().overlayColumns===3);
    const resized=await geometry(f);assert.notDeepEqual(resized.order,first.order,'the changed columns move the pinned square relative to ordinary players');
    await positionCell(f,keys[0]).click();const changed=await waitSpan(f,keys[0],2);
    assert.deepEqual(withoutFocus(changed.order,keys[0]),withoutFocus(resized.order,keys[0]),'changing focus cannot restore an old internal order after a resize');
    assert.equal(spans(changed)[keys[4]],1);assertGeometry(changed,{overlay:true});assertFits(await f.page.evaluate(()=>fixture.grid()));
    await assertContinuity(f,before);
});

test('size actions optimize seventeen players immediately and small pane changes preserve the resulting geometry',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1508,height:948}),before=await snapshot(f),key=await seventeenPlayers(f);
    assert.equal((await f.page.evaluate(()=>fixture.grid())).columns,4);
    const immediate=await f.page.evaluate(key=>{
        enlargePlayer(key);enlargePlayer(key);return {state:fixture.geometry(),grid:fixture.grid()};
    },key);
    assert.equal(immediate.state.layout.items.find(item=>item.key===key).span,3);
    assert.equal(immediate.grid.columns,5,'the grow action chooses the five-column grid before a resize callback');assert.equal(immediate.grid.rows,5);
    assertGeometry(immediate.state,{overlay:true});assertFits(immediate.grid);
    const grown=logicalLayout(immediate.state,immediate.grid);
    for(const [width,height]of [[1509,949],[1507,947],[1528,968],[1488,928],[1508,948]]){
        await settlePane(f,width,height);const value=await readLayout(f);
        assert.deepEqual(value.logical,grown,`a small ${width}x${height} pane change cannot repack the grown grid`);assertGeometry(value.state,{overlay:true});assertFits(value.grid);
    }
    await capture(f,'stable-resize17');
    const partial=await f.page.evaluate(key=>{shrinkPlayer(key);return {state:fixture.geometry(),grid:fixture.grid()}},key);
    assert.equal(partial.grid.columns,4,'the shrink action immediately reclaims the fifth column');assert.equal(partial.grid.rows,5);
    assert.equal(spans(partial.state)[key],2);assertGeometry(partial.state,{overlay:true});
    const shrunk=logicalLayout(partial.state,partial.grid);
    for(const [width,height]of [[1509,947],[1528,928],[1488,968],[1508,948]]){
        await settlePane(f,width,height);const value=await readLayout(f);assert.deepEqual(value.logical,shrunk);assertGeometry(value.state,{overlay:true});assertFits(value.grid);
    }
    await f.page.locator('.player-position-shrink').click();const normal=await readLayout(f);
    assert.equal(normal.state.layout,null);assert.equal(normal.state.saved,null);assert.deepEqual(normal.state.order,partial.state.order);
    for(const [width,height]of [[1509,949],[1528,968],[1488,928],[1508,948]]){
        await settlePane(f,width,height);const value=await readLayout(f);assert.deepEqual(value.logical,normal.logical,'the final shrink also establishes a stable uniform grid');assertFits(value.grid);
    }
    await assertContinuity(f,before);
});

test('tiny resize increments eventually adapt after a meaningful cumulative pane change instead of moving the stability reference forever',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1508,height:948,viewport:{width:3000,height:1300}}),before=await snapshot(f),key=await seventeenPlayers(f);
    await f.page.evaluate(key=>{enlargePlayer(key);enlargePlayer(key)},key);const initial=await readLayout(f);assert.equal(initial.grid.columns,5);
    // Each 30 px step is small. The enlarged-layout aspect reference must stay
    // anchored to its last adopted topology. At 2498px the seven-column gain
    // is still below the new 18% threshold; 2588px is large enough to adapt.
    for(let step=1;step<=36;step++){
        await settlePane(f,1508+step*30,948);
        if(step===33)assert.equal((await readLayout(f)).grid.columns,5,'a gain below 18 percent retains the enlarged layout');
    }
    const wide=await readLayout(f);assert.equal(wide.grid.columns,7);assert.equal(wide.grid.rows,4);
    assert.deepEqual(withoutFocus(wide.state.order,key),withoutFocus(initial.state.order,key));assertGeometry(wide.state,{overlay:true});assertFits(wide.grid);
    await settlePane(f,1508,948);const returned=await readLayout(f);assert.equal(returned.grid.columns,5);assert.equal(returned.grid.rows,5);
    assertGeometry(returned.state,{overlay:true});assertFits(returned.grid);await assertContinuity(f,before);
});

test('size actions bypass the small resize band and pending resize work, then hidden and portrait panes recover with the same live players',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1508,height:948}),before=await snapshot(f),key=await seventeenPlayers(f);
    await f.page.evaluate(key=>enlargePlayer(key),key);assert.equal((await f.page.evaluate(()=>fixture.grid())).columns,4);
    await settlePane(f,1528,968);
    const forced=await f.page.evaluate(key=>{enlargePlayer(key);return {state:fixture.geometry(),grid:fixture.grid()}},key);
    assert.equal(forced.grid.columns,5,'an explicit size action optimizes even inside the resize stability band');assert.equal(forced.grid.rows,5);
    const rapid=await f.page.evaluate(key=>{
        fixture.resize(1510,950);enlargePlayer(key);shrinkPlayer(key);return {state:fixture.geometry(),grid:fixture.grid()};
    },key);
    assert.equal(spans(rapid.state)[key],3);assert.equal(rapid.grid.columns,5);assert.equal(rapid.grid.rows,5);
    await f.page.waitForTimeout(300);const settled=await readLayout(f);
    assert.deepEqual(settled.logical,logicalLayout(rapid.state,rapid.grid),'a pending resize cannot undo a newer grow/shrink action');assertGeometry(settled.state,{overlay:true});assertFits(settled.grid);
    await settlePane(f,0,0);
    const hidden=await f.page.evaluate(key=>{enlargePlayer(key);return fixture.geometry()},key);
    assert.equal(spans(hidden)[key],4);assert.ok(Number.isInteger(hidden.layout.columns)&&hidden.layout.columns>=4);
    assert.ok(Number.isInteger(hidden.layout.rows)&&hidden.layout.rows>=4);
    await settlePane(f,1528,968);const revealed=await readLayout(f);assert.equal(revealed.grid.columns,6);assert.equal(revealed.grid.rows,6);
    assertGeometry(revealed.state,{overlay:true});assertFits(revealed.grid);
    await settlePane(f,320,1100);const portrait=await readLayout(f);assert.equal(portrait.grid.columns,4);assert.equal(portrait.grid.rows,8);
    assert.equal(spans(portrait.state)[key],4);assertGeometry(portrait.state,{overlay:true});assertFits(portrait.grid);
    await settlePane(f,1528,968);const restored=await readLayout(f);assert.equal(restored.grid.columns,6);assert.equal(restored.grid.rows,6);
    assertGeometry(restored.state,{overlay:true});assertFits(restored.grid);await assertContinuity(f,before);
});

test('restoring an enlargement before the pane has a usable size preserves its anchor until the visible layout can optimize it',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const key='m3u8|layout-0',storageSeed={playerEnlargementLayout:JSON.stringify({
        version:1,columns:13,focus:{key,span:3,row:0,column:10}
    })};
    const direct=await fixture(t,{width:3000,height:500,viewport:{width:3200,height:900},players:17,storageSeed});
    const expected=await readLayout(direct),expectedFocus=expected.state.layout.items.find(item=>item.key===key);
    assert.equal(expectedFocus.column,6);assert.equal(expected.grid.columns,9);assertGeometry(expected.state);assertFits(expected.grid);
    const hidden=await fixture(t,{width:0,height:0,viewport:{width:3200,height:900},players:17,storageSeed}),before=await snapshot(hidden);
    assert.equal((await hidden.page.evaluate(()=>fixture.grid())).width,0);assert.equal((await hidden.page.evaluate(()=>fixture.grid())).height,0);
    assert.equal(JSON.parse((await geometry(hidden)).saved).focus.column,10,'an unmeasured pane cannot overwrite the saved horizontal anchor');
    await settlePane(hidden,3000,500);const revealed=await readLayout(hidden);
    assert.deepEqual(revealed.logical,expected.logical,'initially hidden and directly visible restores must produce the same key positions');
    await hidden.page.locator('#enlarge-player').click();assertGeometry(await geometry(hidden),{overlay:true});assertFits(revealed.grid);
    await assertContinuity(hidden,before);
    // Removing this player intentionally disposes its native media. A fresh
    // local placeholder lets us test restoring the same channel preference,
    // without asking a platform renderer to establish a real connection.
    await hidden.page.evaluate(key=>syncActivePlayers(channels.filter(channel=>ChannelList.channelKey(channel)!==key)),key);
    await settlePane(hidden,0,0);
    await hidden.page.evaluate(()=>{fixture.addPlaceholder(channels[0]);syncActivePlayers(channels)});
    assert.equal(JSON.parse((await geometry(hidden)).saved).focus.column,6,'reselecting a dormant focus while hidden cannot clamp its saved anchor to the previous normal grid');
    await settlePane(hidden,3000,500);const reselected=await readLayout(hidden);
    assert.deepEqual(reselected.logical,expected.logical);assertGeometry(reselected.state,{overlay:true});assertFits(reselected.grid);
    assert.equal(await hidden.page.evaluate(()=>Boolean(playerGeometry.deferredFocus)),false,'the first visible layout finishes the deferred anchor commit');
    assert.deepEqual(hidden.errors,[]);assert.deepEqual(hidden.blocked,[]);
});

async function nameGeometry(f){
    return f.page.evaluate(()=>{
        const layer=document.getElementById('player-name-overlay');
        const rect=element=>{const r=element.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
        return {hidden:layer.hidden,sibling:layer.parentElement===document.getElementById('multi-stream-container-wrapper'),
            pointerEvents:getComputedStyle(layer).pointerEvents,
            cells:Array.from(layer.querySelectorAll('.player-name-cell'),cell=>{
                const key=cell.dataset.playerKey,entry=activePlayers.get(key),label=cell.querySelector('.player-name-label');
                return {key,name:entry?.channel.name,text:label.textContent,cell:rect(cell),label:rect(label),player:entry?rect(getPlayerElement(entry)):null,
                    background:getComputedStyle(label).backgroundColor,pointerEvents:getComputedStyle(label).pointerEvents};
            })};
    });
}
async function waitNames(f,count=5){
    await f.page.waitForFunction(count=>{
        const layer=document.getElementById('player-name-overlay');if(!layer||layer.hidden)return false;
        const cells=Array.from(layer.querySelectorAll('.player-name-cell'));if(cells.length!==count)return false;
        return cells.every(cell=>{
            const entry=activePlayers.get(cell.dataset.playerKey),label=cell.querySelector('.player-name-label');if(!entry||label.textContent!==entry.channel.name)return false;
            const actual=getPlayerElement(entry).getBoundingClientRect(),overlay=cell.getBoundingClientRect(),badge=label.getBoundingClientRect();
            return ['left','top','right','bottom'].every(side=>Math.abs(actual[side]-overlay[side])<.65)&&
                Math.abs((badge.left+badge.right-actual.left-actual.right)/2)<.65&&Math.abs((badge.top+badge.bottom-actual.top-actual.bottom)/2)<.65;
        });
    },count);
    return nameGeometry(f);
}
function assertNameGeometry(value){
    assert.equal(value.hidden,false);assert.equal(value.sibling,true);assert.equal(value.pointerEvents,'none');
    for(const item of value.cells){
        assert.equal(item.text,item.name);assert.equal(item.pointerEvents,'none');
        for(const side of ['left','top','right','bottom'])assert.ok(Math.abs(item.cell[side]-item.player[side])<.65,`${item.key}: ${side}`);
        assert.ok(Math.abs((item.label.left+item.label.right-item.player.left-item.player.right)/2)<.65);
        assert.ok(Math.abs((item.label.top+item.label.bottom-item.player.top-item.player.bottom)/2)<.65);
        assert.ok(item.label.left>=item.cell.left-.65&&item.label.right<=item.cell.right+.65,'long labels stay inside their player');
    }
}

test('channel-name overlays follow the real menu lifecycle and native/iframe center clicks pass through without changing media',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000}),before=await snapshot(f);
    assert.equal((await nameGeometry(f)).hidden,true);
    await f.page.locator('#more-channels-btn').click();assertNameGeometry(await waitNames(f));
    const nativePoint=await f.page.evaluate(()=>{
        const video=document.getElementById('native-4');window.nameNativeClicks=0;
        video.addEventListener('click',event=>{nameNativeClicks++;event.preventDefault()});
        const r=video.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,hit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===video};
    });assert.equal(nativePoint.hit,true,'the label center must hit the native player');
    await f.page.mouse.click(nativePoint.x,nativePoint.y);assert.equal(await f.page.evaluate(()=>nameNativeClicks),1);
    await f.frames[1].evaluate(()=>{window.nameFrameClicks=0;document.addEventListener('click',event=>{nameFrameClicks++;event.preventDefault()},true)});
    const framePoint=await f.page.locator('#frame-3').evaluate(frame=>{const r=frame.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,hit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===frame}});
    assert.equal(framePoint.hit,true,'the label center must hit the iframe');await f.page.mouse.click(framePoint.x,framePoint.y);
    assert.equal(await f.frames[1].evaluate(()=>nameFrameClicks),1,'the actual click reaches the cross-origin document');
    await f.page.locator('#more-channels-btn').click();assert.equal((await nameGeometry(f)).hidden,true);
    await f.page.locator('#more-channels-btn').click();await waitNames(f);
    await f.page.locator('#fixture-watch-selected').click();assert.equal((await nameGeometry(f)).hidden,true,'start watching closes names immediately');
    await f.page.locator('#more-channels-btn').click();await waitNames(f);
    await f.page.locator('#adjust-player-positions').click();assert.equal((await nameGeometry(f)).hidden,true,'move mode closes the selection names');
    await f.page.keyboard.press('Escape');await f.page.locator('#more-channels-btn').click();await waitNames(f);
    await f.page.locator('#enlarge-player').click();assert.equal((await nameGeometry(f)).hidden,true,'enlarge mode closes the selection names');
    await f.page.keyboard.press('Escape');await assertContinuity(f,before);
});

test('channel-name centers track enlarged sizes, same-pane swaps, reset and mobile resize using the actual player bounds',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys);
    await f.page.evaluate(key=>{enlargePlayer(key);enlargePlayer(key)},keys[0]);await waitSpan(f,keys[0],3);
    await f.page.locator('#more-channels-btn').click();const initial=await waitNames(f);assertNameGeometry(initial);
    const pane=await f.page.evaluate(()=>{const r=document.getElementById('multi-stream-container').getBoundingClientRect();return [r.width,r.height]});
    await f.page.evaluate(keys=>swapPlayerPositions(keys[3],keys[4]),keys);const swapped=await waitNames(f);assertNameGeometry(swapped);
    assert.deepEqual(await f.page.evaluate(()=>{const r=document.getElementById('multi-stream-container').getBoundingClientRect();return [r.width,r.height]}),pane);
    const oldCell=initial.cells.find(cell=>cell.key===keys[3]).cell,newCell=swapped.cells.find(cell=>cell.key===keys[3]).cell;
    assert.ok(Math.abs(oldCell.left-newCell.left)>1||Math.abs(oldCell.top-newCell.top)>1,'same-size swapping must move the corresponding name');
    await f.page.evaluate(()=>resetPlayerPositions());assertNameGeometry(await waitNames(f));assert.equal((await geometry(f)).layout,null);
    await f.page.setViewportSize({width:375,height:900});await settlePane(f,350,780);assertNameGeometry(await waitNames(f));
    await f.page.setViewportSize({width:1600,height:1200});await settlePane(f,1300,1000);assertNameGeometry(await waitNames(f));
    await assertContinuity(f,before);
});

test('channel-name text is safely renamed without rebuilding players and follows asynchronous error-node replacement',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000}),before=await snapshot(f);
    await f.page.locator('#more-channels-btn').click();await waitNames(f);
    const longName='<img src="x" onerror="window.nameFixtureXss=1"> & 「台名」 '+ '繁體 🎮 '.repeat(180);
    await f.page.evaluate(name=>{channels[0]={...channels[0],name};pruneActivePlayers()},longName);
    const renamed=await waitNames(f);assertNameGeometry(renamed);
    assert.equal(renamed.cells.find(cell=>cell.key==='m3u8|layout-0').text,longName);
    assert.equal(await f.page.locator('#player-name-overlay img, #player-name-overlay script').count(),0);
    assert.equal(await f.page.evaluate(()=>window.nameFixtureXss),undefined);await assertContinuity(f,before);
    // Real async failure replacement changes resource.element; a later width
    // change proves the replacement, rather than its disconnected old video,
    // was added to the overlay's ResizeObserver subscription.
    await f.page.evaluate(()=>setTimeout(()=>replacePlayerWithError(fixture.entries[1].resource,'本地非同步播放失敗'),20));
    await f.page.waitForFunction(()=>fixture.entries[1].resource.element.tagName==='DIV');assertNameGeometry(await waitNames(f));
    await f.page.evaluate(()=>{fixture.entries[1].resource.element.style.width='72%'});const replaced=await waitNames(f);assertNameGeometry(replaced);
    const after=await snapshot(f);
    assert.deepEqual(after.main.map(stable),before.main.map((media,index)=>({...stable(media),...(index===1?{same:false}:{})})));
    assert.deepEqual(after.frames.map(frame=>({id:frame.id,media:frame.media.map(stable)})),before.frames.map(frame=>({id:frame.id,media:frame.media.map(stable)})));
    assert.deepEqual(await f.page.evaluate(()=>fixture.identity()),{elements:false,entries:true,windows:true,removals:1,frameSources:0,loads:[1,1]});
    assert.ok([...f.navigations.values()].every(count=>count===1));assert.deepEqual(f.errors,[]);assert.deepEqual(f.blocked,[]);
    await f.page.locator('#more-channels-btn').click();assert.equal((await nameGeometry(f)).hidden,true);
    await f.page.evaluate(()=>{fixture.entries[1].resource.element.style.width='60%'});
    await f.page.locator('#more-channels-btn').click();assertNameGeometry(await waitNames(f));
});

function cornerHandle(f,key,corner){return positionCell(f,key).locator(`.player-resize-handle[data-resize-corner="${corner}"]`)}
async function trackPitch(f){
    return f.page.evaluate(()=>{
        const style=getComputedStyle(document.getElementById('multi-stream-container'));
        return {x:parseFloat(style.gridTemplateColumns)+(parseFloat(style.columnGap)||0),
            y:parseFloat(style.gridTemplateRows)+(parseFloat(style.rowGap)||0)};
    });
}
async function startCornerDrag(f,key,corner){
    await f.page.evaluate(()=>{
        if(window.resizeFixturePointerHook)return;window.resizeFixturePointerHook=true;
        document.addEventListener('pointerdown',event=>{window.lastResizeFixturePointer=event.pointerId},true);
    });
    const handle=cornerHandle(f,key,corner),bounds=await handle.boundingBox();assert.ok(bounds&&bounds.width>0&&bounds.height>0,'corner handle has a real hit target');
    const point={x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2};
    const hitTest=()=>f.page.evaluate(({x,y})=>{const hit=document.elementFromPoint(x,y);return {
        corner:hit?.closest('.player-resize-handle')?.dataset.resizeCorner,toolbarButton:Boolean(hit?.closest('.player-position-toolbar button'))};
    },point);
    let hit=await hitTest();
    // Toolbar buttons intentionally win pointer hits. Exercise the user-facing
    // edge switch when one covers a corner, rather than clicking through it or
    // bypassing the production pointer handlers with a synthetic event.
    if(hit.corner!==corner&&hit.toolbarButton&&await f.page.locator('.player-position-toolbar-toggle').count()){
        await f.page.locator('.player-position-toolbar-toggle').click();hit=await hitTest();
    }
    assert.equal(hit.corner,corner,'moving an overlapping toolbar must expose the real resize handle');
    const before=await readLayout(f),pitch=await trackPitch(f);
    await f.page.mouse.move(point.x,point.y);await f.page.mouse.down();
    return {key,corner,point,pitch,before,pointerId:await f.page.evaluate(()=>lastResizeFixturePointer)};
}
async function moveCornerDrag(f,drag,x,y=x,{steps=8}={}){
    const east=drag.corner.endsWith('e')?1:-1,south=drag.corner.startsWith('s')?1:-1;
    await f.page.mouse.move(drag.point.x+east*x*drag.pitch.x,drag.point.y+south*y*drag.pitch.y,{steps});
}
async function assertPreviewOnly(f,drag){
    await f.page.waitForFunction(()=>{const preview=document.querySelector('.player-resize-preview');return preview&&!preview.hidden&&getComputedStyle(preview).display!=='none'});
    const current=await readLayout(f);assert.deepEqual(current.logical,drag.before.logical,'pointermove can preview but cannot commit geometry');
    assert.equal(current.state.saved,drag.before.state.saved,'pointermove cannot persist a tentative size');
    assert.equal(await f.page.locator('.player-resize-preview').evaluate(element=>getComputedStyle(element).pointerEvents),'none');
}
async function assertResizeIdle(f){
    assert.equal(await f.page.locator('.player-resize-preview').isVisible(),false);
    assert.equal(await f.page.locator('.position-dragging,.position-target,.position-resizing').count(),0);
}
async function captureCornerPreview(f){
    if(!process.env.UMININN_CORNER_SCREENSHOT_DIR)return;
    const directory=path.resolve(process.env.UMININN_CORNER_SCREENSHOT_DIR);fs.mkdirSync(directory,{recursive:true});
    const label=engine==='firefox'?'firefox':/msedge/i.test(executablePath||'')?'edge':'chrome';
    await f.page.locator('#multi-stream-container-wrapper').screenshot({path:path.join(directory,`corner-resize-${label}-preview.png`)});
}
const cornerSeed={playerEnlargementLayout:JSON.stringify({version:1,columns:5,focus:{key:'m3u8|layout-0',span:3,row:1,column:1}})};

test('corner resize previews four outward/inward directions and commits only once on release without interrupting media',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1508,height:948,players:17,storageSeed:cornerSeed}),before=await snapshot(f),key='m3u8|layout-0';
    await f.page.locator('#enlarge-player').click();await waitSpan(f,key,3);
    for(const corner of ['nw','ne','sw','se']){
        const outward=await startCornerDrag(f,key,corner);await moveCornerDrag(f,outward,.8);await assertPreviewOnly(f,outward);
        await f.page.mouse.up();const grown=await waitSpan(f,key,4);assertGeometry(grown,{overlay:true});assertFits(await f.page.evaluate(()=>fixture.grid()));await assertResizeIdle(f);
        // A new gesture snapshots the reflowed pitch, instead of continuing to
        // use measurements from before the previous grow action.
        const inward=await startCornerDrag(f,key,corner);await moveCornerDrag(f,inward,-.8);await assertPreviewOnly(f,inward);
        await f.page.mouse.up();const shrunk=await waitSpan(f,key,3);assertGeometry(shrunk,{overlay:true});assertFits(await f.page.evaluate(()=>fixture.grid()));
        await f.page.waitForTimeout(220);assert.equal(spans(await geometry(f))[key],3,'mouseup/click and an old resize timer cannot add a second size change');
    }
    await assertContinuity(f,before);
});

test('corner resize uses the dominant normalized start pitch across multiple cells, including release outside the pane',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1508,height:948,players:17,storageSeed:cornerSeed}),before=await snapshot(f),key='m3u8|layout-0';
    await f.page.locator('#enlarge-player').click();const drag=await startCornerDrag(f,key,'se');
    await moveCornerDrag(f,drag,1.2,-.2);await assertPreviewOnly(f,drag);
    await moveCornerDrag(f,drag,2.2,-.3,{steps:14});await assertPreviewOnly(f,drag);
    // Horizontal outward movement dominates the smaller vertical inward move;
    // the one release jumps from span 3 to span 5, rather than growing per move.
    await f.page.mouse.up();const grown=await waitSpan(f,key,5);assertGeometry(grown,{overlay:true});assertFits(await f.page.evaluate(()=>fixture.grid()));
    await f.page.waitForTimeout(260);assert.equal(spans(await geometry(f))[key],5);
    const shrink=await startCornerDrag(f,key,'sw');await moveCornerDrag(f,shrink,-.8,.2);await assertPreviewOnly(f,shrink);await captureCornerPreview(f);
    await f.page.mouse.up();assertGeometry(await waitSpan(f,key,4),{overlay:true});await assertResizeIdle(f);await assertContinuity(f,before);
});

test('handle clicks and subthreshold drags do not grow a player, while center and keyboard activation remain usable',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000}),before=await snapshot(f),key=await f.page.evaluate(()=>fixture.keys[0]);
    await f.page.locator('#adjust-player-positions').click();assert.equal(await cornerHandle(f,key,'se').isVisible(),false);
    await f.page.locator('#enlarge-player').click();
    assert.equal(await positionCell(f,key).locator('span.player-resize-handle[aria-hidden="true"]').count(),4);
    for(const corner of ['nw','ne','sw','se'])await cornerHandle(f,key,corner).click();
    assert.equal((await geometry(f)).layout,null,'a corner click cannot bubble into the center enlarge action');
    const tap=await startCornerDrag(f,key,'se');await f.page.mouse.move(tap.point.x+2,tap.point.y+2);await f.page.mouse.up();
    assert.equal((await geometry(f)).layout,null);await assertResizeIdle(f);
    await positionCell(f,key).press('Enter');await waitSpan(f,key,2);
    const below=await startCornerDrag(f,key,'se');await moveCornerDrag(f,below,.49,0);await f.page.mouse.up();assert.equal(spans(await geometry(f))[key],2,'less than half a start track rounds to no size change');
    const above=await startCornerDrag(f,key,'se');await moveCornerDrag(f,above,.65,0);await f.page.mouse.up();await waitSpan(f,key,3);
    // Shrink can reach the normal single cell. It cannot create a zero span or
    // allow a later center click to be swallowed by stale drag suppression.
    const minimum=await startCornerDrag(f,key,'se');await moveCornerDrag(f,minimum,-2.2,0);await f.page.mouse.up();await waitSingleCells(f);
    await positionCell(f,key).click();await waitSpan(f,key,2);await assertContinuity(f,before);
});

test('corner resize cancellation clears its preview and cannot leak a commit into the next mode or selection',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1508,height:948,players:17,storageSeed:cornerSeed}),before=await snapshot(f),key='m3u8|layout-0';
    await f.page.locator('#enlarge-player').click();
    for(const reason of ['pointercancel','lostcapture','blur','resize','mode','selection','escape']){
        if((await geometry(f)).mode!=='enlarge')await f.page.locator('#enlarge-player').click();
        const drag=await startCornerDrag(f,key,'se');await moveCornerDrag(f,drag,.8);await assertPreviewOnly(f,drag);
        if(reason==='pointercancel')await f.page.evaluate(id=>document.dispatchEvent(new PointerEvent('pointercancel',{pointerId:id,pointerType:'mouse',isPrimary:true,bubbles:true})),drag.pointerId);
        if(reason==='lostcapture'){
            assert.equal(await f.page.evaluate(id=>{const owner=Array.from(document.querySelectorAll('*')).find(element=>element.hasPointerCapture?.(id));if(!owner)return false;owner.releasePointerCapture(id);return true},drag.pointerId),true);
            await f.page.mouse.move(drag.point.x+1,drag.point.y+1);
        }
        if(reason==='blur')await f.page.evaluate(()=>dispatchEvent(new Event('blur')));
        if(reason==='resize')await settlePane(f,1510,950);
        if(reason==='mode')await f.page.evaluate(()=>document.getElementById('adjust-player-positions').click());
        if(reason==='selection')await f.page.evaluate(()=>{const channel={id:'resize-cancel-extra',platform:'at',name:'本地取消測試'};fixture.addPlaceholder(channel);syncActivePlayers([...channels,channel])});
        if(reason==='escape')await f.page.keyboard.press('Escape');
        const canceled=await readLayout(f);await f.page.mouse.up();await assertResizeIdle(f);
        assert.deepEqual((await readLayout(f)).logical,canceled.logical,reason+' must not commit on a late pointerup/click');
        assert.equal(spans(await geometry(f))[key],3,reason+' preserves the active span');
        if(reason==='escape'){
            assert.equal((await geometry(f)).opened,true,'first Escape cancels only the resize');
            await f.page.keyboard.press('Escape');assert.equal((await geometry(f)).opened,false);await f.page.locator('#enlarge-player').click();
        }
        if(reason==='selection')await f.page.evaluate(()=>syncActivePlayers(channels));
    }
    const fresh=await startCornerDrag(f,key,'se');await moveCornerDrag(f,fresh,.8);await f.page.mouse.up();await waitSpan(f,key,4);
    await assertContinuity(f,before);
});

test('a second pointer cannot steal or finish a corner resize and changing focus keeps exactly one enlarged player',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1508,height:948,players:17,storageSeed:cornerSeed}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys),key=keys[0];
    await f.page.locator('#enlarge-player').click();const drag=await startCornerDrag(f,key,'se');await moveCornerDrag(f,drag,.8);await assertPreviewOnly(f,drag);
    await f.page.evaluate(({id,x,y,key})=>{
        const other=Array.from(document.querySelectorAll('.player-position-cell')).find(cell=>cell.dataset.playerKey===key).querySelector('[data-resize-corner="se"]');
        other.dispatchEvent(new PointerEvent('pointerdown',{pointerId:id+100,pointerType:'touch',isPrimary:false,button:0,bubbles:true,clientX:x,clientY:y}));
        for(const type of ['pointermove','pointerup'])document.dispatchEvent(new PointerEvent(type,{pointerId:id+100,pointerType:'touch',isPrimary:false,button:0,bubbles:true,clientX:x,clientY:y}));
    },{id:drag.pointerId,x:drag.point.x,y:drag.point.y,key:keys[1]});
    await assertPreviewOnly(f,drag);await f.page.mouse.up();await waitSpan(f,key,4);
    const next=await startCornerDrag(f,keys[1],'se');await moveCornerDrag(f,next,.8);await f.page.mouse.up();
    const changed=await waitSpan(f,keys[1],2);assert.equal(spans(changed)[key],1);assert.equal(changed.layout.items.filter(item=>item.span>1).length,1);
    assertGeometry(changed,{overlay:true});assertFits(await f.page.evaluate(()=>fixture.grid()));await assertResizeIdle(f);await assertContinuity(f,before);
});

test('real viewport jitter preserves an enlarged layout while a large portrait resize can still adapt',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1508,height:948}),before=await snapshot(f),key=await seventeenPlayers(f);
    await f.page.setViewportSize({width:1548,height:1018});
    await f.page.evaluate(()=>{const host=document.getElementById('multi-stream-container-wrapper');host.style.width='calc(100vw - 40px)';host.style.height='calc(100vh - 70px)'});
    await f.page.waitForTimeout(240);await f.page.evaluate(key=>{enlargePlayer(key);enlargePlayer(key)},key);
    const initial=await readLayout(f);assert.equal(spans(initial.state)[key],3);
    for(const viewport of [{width:1549,height:1019},{width:1488,height:1048},{width:1618,height:988},{width:1528,height:1058},{width:1548,height:1018}]){
        await f.page.setViewportSize(viewport);await f.page.waitForTimeout(240);const current=await readLayout(f);
        assert.deepEqual(current.logical,initial.logical,`small actual viewport ${viewport.width}x${viewport.height} must not jump cells`);
        assertGeometry(current.state,{overlay:true});assertFits(current.grid);
    }
    await f.page.setViewportSize({width:400,height:1100});await f.page.waitForTimeout(280);const portrait=await readLayout(f);
    assert.notEqual(portrait.grid.columns,initial.grid.columns,'a major orientation change cannot permanently lock unsuitable columns');
    assert.equal(spans(portrait.state)[key],3);assert.deepEqual(withoutFocus(portrait.state.order,key),withoutFocus(initial.state.order,key));
    assertGeometry(portrait.state,{overlay:true});assertFits(portrait.grid);await assertContinuity(f,before);
});

test('a mouse button chord cannot commit a corner resize after the primary button has been released',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1508,height:948,players:17,storageSeed:cornerSeed}),before=await snapshot(f),key='m3u8|layout-0';
    await f.page.locator('#enlarge-player').click();const drag=await startCornerDrag(f,key,'se');await moveCornerDrag(f,drag,.8);await assertPreviewOnly(f,drag);
    await f.page.evaluate(({id,x,y})=>{
        // Left is no longer held, while right is still pressed. The subsequent
        // right-button release must not finish the old primary-button gesture.
        document.dispatchEvent(new PointerEvent('pointermove',{pointerId:id,pointerType:'mouse',isPrimary:true,button:-1,buttons:2,bubbles:true,cancelable:true,clientX:x,clientY:y}));
        document.dispatchEvent(new PointerEvent('pointerup',{pointerId:id,pointerType:'mouse',isPrimary:true,button:2,buttons:0,bubbles:true,clientX:x,clientY:y}));
    },{id:drag.pointerId,x:drag.point.x+drag.pitch.x*.8,y:drag.point.y+drag.pitch.y*.8});
    await assertResizeIdle(f);assert.deepEqual((await readLayout(f)).logical,drag.before.logical);
    await f.page.mouse.up();assert.equal(spans(await geometry(f))[key],3);
    const fresh=await startCornerDrag(f,key,'se');await moveCornerDrag(f,fresh,.8);await f.page.mouse.up();assertGeometry(await waitSpan(f,key,4),{overlay:true});
    await assertContinuity(f,before);
});

test('a pane change and pointerup in the same task cannot commit a resize using stale start geometry',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1508,height:948,players:17,storageSeed:cornerSeed}),before=await snapshot(f),key='m3u8|layout-0';
    await f.page.locator('#enlarge-player').click();const drag=await startCornerDrag(f,key,'se');await moveCornerDrag(f,drag,.8);await assertPreviewOnly(f,drag);
    const immediate=await f.page.evaluate(({id,x,y,key})=>{
        const host=document.getElementById('multi-stream-container-wrapper');host.style.height=(host.getBoundingClientRect().height+100)+'px';
        // There is deliberately no await/rAF/RO opportunity between changing the
        // box and releasing the pointer. The release must validate current bounds.
        document.dispatchEvent(new PointerEvent('pointerup',{pointerId:id,pointerType:'mouse',isPrimary:true,button:0,buttons:0,bubbles:true,clientX:x,clientY:y}));
        return {span:playerGeometry.items.find(item=>item.key===key).span,saved:localStorage.getItem('playerEnlargementLayout')};
    },{id:drag.pointerId,x:drag.point.x+drag.pitch.x*.8,y:drag.point.y+drag.pitch.y*.8,key});
    assert.equal(immediate.span,3);assert.equal(immediate.saved,drag.before.state.saved);
    await f.page.mouse.up();await f.page.waitForTimeout(260);await assertResizeIdle(f);assert.equal(spans(await geometry(f))[key],3);
    assertGeometry(await geometry(f),{overlay:true});assertFits(await f.page.evaluate(()=>fixture.grid()));await assertContinuity(f,before);
});

test('Chromium trusted touch input can drag a corner through native pointer capture without restarting media',{
    skip:!enabled||engine!=='chromium',timeout:30000
},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1508,height:948,players:17,storageSeed:cornerSeed,hasTouch:true}),before=await snapshot(f),key='m3u8|layout-0';
    await f.page.locator('#enlarge-player').click();const start=await readLayout(f),pitch=await trackPitch(f),bounds=await cornerHandle(f,key,'se').boundingBox();
    assert.ok(bounds);const x=bounds.x+bounds.width/2,y=bounds.y+bounds.height/2;
    await f.page.evaluate(()=>{window.cornerTrustedTouch=[];for(const type of ['pointerdown','pointerup'])document.addEventListener(type,event=>{
        if(event.pointerType==='touch')cornerTrustedTouch.push({type,trusted:event.isTrusted,primary:event.isPrimary});
    },true)});
    const cdp=await f.page.context().newCDPSession(f.page);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x,y,radiusX:1,radiusY:1,force:1}]});
    for(let step=1;step<=8;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:1,x:x+pitch.x*.8*step/8,y:y+pitch.y*.8*step/8,radiusX:1,radiusY:1,force:1}]});
    await assertPreviewOnly(f,{before:start});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    const grown=await waitSpan(f,key,4);assertGeometry(grown,{overlay:true});await assertResizeIdle(f);
    const events=await f.page.evaluate(()=>cornerTrustedTouch);assert.ok(events.some(event=>event.type==='pointerdown'&&event.trusted&&event.primary));
    assert.ok(events.some(event=>event.type==='pointerup'&&event.trusted&&event.primary));
    await cdp.detach();
    await assertContinuity(f,before);
});

async function assertToolbarPosition(f,position){
    await f.page.waitForFunction(position=>document.getElementById('player-position-editor').dataset.toolbarPosition===position,position);
    const value=await f.page.evaluate(()=>{
        const editor=document.getElementById('player-position-editor'),toolbar=editor.querySelector('.player-position-toolbar'),toggle=toolbar.querySelector('.player-position-toolbar-toggle');
        const rect=element=>{const value=element.getBoundingClientRect();return {left:value.left,top:value.top,right:value.right,bottom:value.bottom,width:value.width,height:value.height}};
        return {editor:rect(editor),toolbar:rect(toolbar),label:toggle.textContent.trim(),focused:document.activeElement===toggle,
            same:!window.fixtureToolbarToggle||window.fixtureToolbarToggle===toggle,viewport:{width:innerWidth,height:innerHeight},
            buttons:Array.from(toolbar.querySelectorAll('button')).filter(button=>!button.hidden&&getComputedStyle(button).display!=='none').map(button=>{
                const bounds=rect(button),hit=document.elementFromPoint(bounds.left+bounds.width/2,bounds.top+bounds.height/2);
                return {label:button.textContent.trim(),rect:bounds,hit:hit?.closest('button')===button,
                    target:hit?{tag:hit.tagName,className:hit.className,corner:hit.dataset.resizeCorner}:null};
            })};
    });
    assert.match(value.label,position==='top'?/↓\s*移到底部/:/↑\s*移到頂部/);
    assert.equal(value.same,true,'moving the toolbar preserves its actual toggle button');
    const middle=value.toolbar.top+value.toolbar.height/2;
    assert.ok(position==='top'?middle<value.editor.top+value.editor.height/2:middle>value.editor.top+value.editor.height/2,'the toolbar physically moves to the selected edge');
    return value;
}

test('editor toolbar switches edges with pointer and keyboard, shares its choice across modes and preserves player geometry and playback',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1508,height:948,players:17,storageSeed:cornerSeed}),before=await snapshot(f),initial=await readLayout(f);
    const toggle=f.page.locator('.player-position-toolbar-toggle');
    await f.page.locator('#adjust-player-positions').click();await assertToolbarPosition(f,'top');
    await f.page.evaluate(()=>{window.fixtureToolbarToggle=document.querySelector('.player-position-toolbar-toggle')});
    await toggle.click();await assertToolbarPosition(f,'bottom');
    assert.deepEqual((await readLayout(f)).logical,initial.logical,'moving the toolbar cannot move, enlarge or reset a player');
    await f.page.locator('.player-position-done').click();assert.equal((await geometry(f)).opened,false);
    await f.page.locator('#enlarge-player').click();await assertToolbarPosition(f,'bottom');
    await toggle.focus();await toggle.press('Enter');assert.equal((await assertToolbarPosition(f,'top')).focused,true);
    assert.deepEqual((await readLayout(f)).logical,initial.logical,'keyboard toolbar activation cannot bubble into a size action');
    await f.page.keyboard.press('Escape');assert.equal((await geometry(f)).opened,false);
    await f.page.locator('#adjust-player-positions').click();await assertToolbarPosition(f,'top');
    await toggle.focus();await toggle.press('Space');assert.equal((await assertToolbarPosition(f,'bottom')).focused,true);
    await f.page.locator('.player-position-done').click();await f.page.locator('#enlarge-player').click();await assertToolbarPosition(f,'bottom');
    const after=await readLayout(f);assert.deepEqual(after.logical,initial.logical);assert.equal(after.state.saved,initial.state.saved);
    assertGeometry(after.state,{overlay:true});await assertContinuity(f,before);
});

test('editor toolbar buttons fit narrow mobile panes at either edge in both modes without changing players',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:300,height:480,viewport:{width:320,height:720},storageSeed:cornerSeed}),before=await snapshot(f);
    const toggle=f.page.locator('.player-position-toolbar-toggle');
    for(const width of [320,375,414]){
        await f.page.setViewportSize({width,height:720});await settlePane(f,width-20,480);
        for(const mode of ['move','enlarge']){
            await f.page.locator(mode==='move'?'#adjust-player-positions':'#enlarge-player').click();
            const initial=await readLayout(f);
            for(const position of ['top','bottom']){
                if(await f.page.locator('#player-position-editor').getAttribute('data-toolbar-position')!==position)await toggle.click();
                const value=await assertToolbarPosition(f,position),box=value.toolbar;
                for(const side of ['left','top'])assert.ok(box[side]>=value.editor[side]-.6,`${width}/${mode}/${position} toolbar ${side} stays in the pane`);
                for(const side of ['right','bottom'])assert.ok(box[side]<=value.editor[side]+.6,`${width}/${mode}/${position} toolbar ${side} stays in the pane`);
                assert.ok(box.left>=-.6&&box.right<=value.viewport.width+.6,'toolbar cannot cause horizontal viewport overflow');
                assert.equal(value.buttons.length,mode==='move'?3:4);
                for(const button of value.buttons){
                    assert.ok(button.rect.width>0&&button.rect.height>0,button.label+' has a visible control');
                    assert.ok(button.rect.left>=box.left-.6&&button.rect.right<=box.right+.6,button.label+' fits inside its wrapped toolbar');
                    assert.ok(button.rect.top>=box.top-.6&&button.rect.bottom<=box.bottom+.6,button.label+' fits vertically inside its toolbar');
                    if(!button.hit&&process.env.UMININN_CORNER_SCREENSHOT_DIR){
                        const directory=path.resolve(process.env.UMININN_CORNER_SCREENSHOT_DIR);fs.mkdirSync(directory,{recursive:true});
                        const label=engine==='firefox'?'firefox':/msedge/i.test(executablePath||'')?'edge':'chrome';
                        await f.page.screenshot({path:path.join(directory,`player-toolbar-${label}-mobile-overlap.png`)});
                    }
                    assert.equal(button.hit,true,`${width}/${mode}/${position}: ${button.label} is not covered: ${JSON.stringify(button)}`);
                }
                const current=await readLayout(f);assert.deepEqual(current.logical,initial.logical);assertGeometry(current.state,{overlay:true});
                if(width===320&&mode==='enlarge'&&position==='bottom'&&process.env.UMININN_CORNER_SCREENSHOT_DIR){
                    const directory=path.resolve(process.env.UMININN_CORNER_SCREENSHOT_DIR);fs.mkdirSync(directory,{recursive:true});
                    const label=engine==='firefox'?'firefox':/msedge/i.test(executablePath||'')?'edge':'chrome';
                    await f.page.screenshot({path:path.join(directory,`player-toolbar-${label}-mobile-bottom.png`)});
                }
            }
            await f.page.locator('.player-position-done').click();assert.equal((await geometry(f)).opened,false);
        }
    }
    await assertContinuity(f,before);
});

function windowCell(f,key){return f.page.locator(`.player-window-cell[data-player-key=${JSON.stringify(key)}]`)}
async function hoverWindow(f,key){
    const point=await f.page.evaluate(key=>{const rect=getPlayerElement(activePlayers.get(key)).getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2}},key);
    await f.page.mouse.move(point.x,point.y,{steps:8});
    try{await f.page.waitForFunction(key=>{
        const layer=document.getElementById('player-window-controls'),cell=Array.from(layer.querySelectorAll('.player-window-cell')).find(cell=>cell.dataset.playerKey===key);
        return !layer.hidden&&cell?.dataset.hovered==='true'&&Number(getComputedStyle(cell.querySelector('.player-window-buttons')).opacity)>.5;
    },key)}catch(error){
        console.error('Window hover diagnostic:',{key,point},await f.page.evaluate(({key,point})=>({
            hidden:document.getElementById('player-window-controls').hidden,actualHover:getPlayerElement(activePlayers.get(key)).matches(':hover'),
            target:document.elementFromPoint(point.x,point.y)?.id,scroll:[scrollX,scrollY],
            rectangles:Array.from(activePlayers,([key,entry])=>({key,rect:JSON.stringify(getPlayerElement(entry).getBoundingClientRect().toJSON())})),
            pointerLog:window.fixtureWindowPointerLog,
            hovered:Array.from(document.querySelectorAll(':hover'),element=>element.id||element.className||element.tagName),
            cells:Array.from(document.querySelectorAll('.player-window-cell'),cell=>({key:cell.dataset.playerKey,hovered:cell.dataset.hovered,opacity:getComputedStyle(cell.querySelector('.player-window-buttons')).opacity}))
        }),{key,point}));throw error;
    }
    return point;
}
async function clickWindowAction(f,key,action){
    const button=windowCell(f,key).locator(`button[data-player-action="${action}"]`);
    const foreignFrame=await f.page.evaluate(key=>getPlayerElement(activePlayers.get(key)).tagName==='IFRAME',key);
    if(engine==='chromium'&&foreignFrame){
        // Chromium's Playwright input route does not reliably update the parent
        // hover chain for an OOPIF. Exercise real keyboard activation instead;
        // the separate Firefox subcase retains the complete pure-hover path.
        await f.page.keyboard.press('Tab');await button.focus();
        await button.evaluate(button=>{if(!button.matches(':focus-visible')||Number(getComputedStyle(button.parentElement).opacity)<=.5)throw Error('keyboard focus must reveal the real window controls')});
        await button.press('Enter');
    }else{await hoverWindow(f,key);await button.click()}
}
async function waitWindowGeometry(f){
    await f.page.waitForFunction(()=>{
        const layer=document.getElementById('player-window-controls');
        if(!layer||layer.hidden||layer.children.length!==activePlayers.size)return false;
        return Array.from(activePlayers,([key,entry])=>{
            const cell=Array.from(layer.children).find(cell=>cell.dataset.playerKey===key);if(!cell)return false;
            const a=cell.getBoundingClientRect(),b=getPlayerElement(entry).getBoundingClientRect();
            return ['left','top','right','bottom'].every(side=>Math.abs(a[side]-b[side])<.6);
        }).every(Boolean);
    });
}
async function activeMediaSnapshot(f,keys,{remember=false}={}){
    const state=await f.page.evaluate(({keys,remember})=>{
        if(remember)window.fixtureRetainedPlayers=new Map();
        return keys.map(key=>{
            const entry=activePlayers.get(key),element=getPlayerElement(entry),frameIndex=fixture.frames.findIndex(frame=>frame.element===element);
            if(remember)fixtureRetainedPlayers.set(key,{entry,element,resource:entry.resource,window:frameIndex<0?null:element.contentWindow});
            const old=fixtureRetainedPlayers.get(key),saved=entry.resource?.video&&fixtureMedia.find(saved=>saved.video===entry.resource.video);
            return {key,frameIndex,connected:element.isConnected,muted:entry.muted,failed:entry.failed,
                sameElement:old.element===element,sameEntry:old.entry===entry,sameResource:old.resource===entry.resource,
                sameWindow:frameIndex<0||element.contentWindow===old.window,loads:frameIndex<0?null:Number(element.dataset.loads),
                media:saved?readMedia(saved):null};
        });
    },{keys,remember});
    return Promise.all(state.map(async entry=>({...entry,child:entry.frameIndex<0?null:await f.frames[entry.frameIndex].evaluate(()=>({id:fixtureId,media:fixtureMedia.map(readMedia)}))})));
}
async function assertActiveContinuity(f,before){
    const after=await activeMediaSnapshot(f,before.map(entry=>entry.key));
    const stableEntry=entry=>({...entry,media:entry.media&&stable(entry.media),child:entry.child&&{...entry.child,media:entry.child.media.map(stable)}});
    assert.deepEqual(after.map(stableEntry),before.map(stableEntry),'retained entries, native media and foreign iframe documents keep their identity and manual settings');
    for(let index=0;index<after.length;index++){
        if(before[index].media?.paused)assert.equal(after[index].media.time,before[index].media.time);
        if(before[index].child?.media[0].paused)assert.equal(after[index].child.media[0].time,before[index].child.media[0].time);
    }
    assert.ok([...f.navigations.values()].every(count=>count===1));assert.deepEqual(f.errors,[]);assert.deepEqual(f.blocked,[]);
}

test('window controls track native hover, preserve iframe center click-through and stay aligned through resize and editor modes',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys);
    await waitWindowGeometry(f);await f.page.mouse.move(1990,1290);
    assert.equal(await f.page.locator('.player-window-cell[data-hovered="true"]').count(),0);
    await f.page.evaluate(()=>{
        window.fixtureWindowPointerLog=[];
        for(const entry of activePlayers.values())for(const type of ['pointerenter','pointerleave'])getPlayerElement(entry).addEventListener(type,event=>fixtureWindowPointerLog.push({type,target:event.target.id,hover:event.target.matches(':hover'),trusted:event.isTrusted}));
        for(const saved of fixtureMedia)saved.video.addEventListener('click',()=>{saved.video.dataset.fixtureClicks=String(Number(saved.video.dataset.fixtureClicks||0)+1)});
    });
    for(const frame of f.frames)await frame.evaluate(()=>fixtureMedia[0].video.addEventListener('click',()=>{window.fixtureClicks=(window.fixtureClicks||0)+1}));
    await hoverWindow(f,keys[0]);
    assert.deepEqual(await f.page.locator('.player-window-cell[data-hovered="true"]').evaluateAll(cells=>cells.map(cell=>cell.dataset.playerKey)),[keys[0]]);
    if(engine==='chromium')t.diagnostic('Only the pure OOPIF hover subcase is skipped for Chromium Playwright input. Separate CUA native-input evidence: outputs/player-window-controls-cross-origin-native.json and outputs/player-window-controls-twitch-native.png. This model still tests native hover, iframe-center click-through, geometry and keyboard iframe actions.');
    await t.test('pure cross-origin iframe hover and pointer handoff to its window buttons',{
        skip:engine==='chromium'?'Chromium Playwright OOPIF input does not update parent hover; separately verified with CUA native input':false
    },async()=>{
        for(const index of [2,3]){
            await hoverWindow(f,keys[index]);
            assert.deepEqual(await f.page.locator('.player-window-cell[data-hovered="true"]').evaluateAll(cells=>cells.map(cell=>cell.dataset.playerKey)),[keys[index]]);
            await windowCell(f,keys[index]).locator('[data-player-action="close"]').hover();
            assert.equal(await windowCell(f,keys[index]).getAttribute('data-hovered'),'true','moving from the foreign frame onto its own buttons keeps the controls revealed');
        }
    });
    for(const index of [0,2,3]){
        const point=await f.page.evaluate(key=>{const bounds=getPlayerElement(activePlayers.get(key)).getBoundingClientRect();return {x:bounds.left+bounds.width/2,y:bounds.top+bounds.height/2}},keys[index]);
        assert.deepEqual(await windowCell(f,keys[index]).locator('.player-window-buttons button').evaluateAll(buttons=>buttons.map(button=>button.dataset.playerAction)),['shrink','enlarge','close']);
        assert.equal(await windowCell(f,keys[index]).locator('[data-player-action="shrink"]').isVisible(),false);
        assert.equal(await windowCell(f,keys[index]).locator('[data-player-action="enlarge"]').isEnabled(),true);
        const tag=await f.page.evaluate(({x,y})=>document.elementFromPoint(x,y).tagName,point);assert.equal(tag,index===0?'VIDEO':'IFRAME','a transparent control cell cannot intercept media-center input');
        await f.page.mouse.click(point.x,point.y);
        if(index===0)assert.equal(await f.page.locator('#native-0').getAttribute('data-fixture-clicks'),'1');
        else assert.equal(await f.frames[index-2].evaluate(()=>fixtureClicks),1);
    }
    for(const mode of ['#adjust-player-positions','#enlarge-player']){
        await f.page.locator(mode).click();await f.page.waitForFunction(()=>document.getElementById('player-window-controls').hidden);
        assert.equal(await f.page.locator('#player-window-controls').isVisible(),false);
        if(mode==='#adjust-player-positions'){
            await positionCell(f,keys[0]).click();await positionCell(f,keys[4]).click();
        }
        await f.page.locator('.player-position-done').click();await waitWindowGeometry(f);await hoverWindow(f,keys[0]);
    }
    await settlePane(f,320,650);await waitWindowGeometry(f);await hoverWindow(f,keys[0]);
    await f.page.evaluate(()=>{document.getElementById('multi-stream-container-wrapper').style.padding='0'});
    await settlePane(f,260,8);await waitWindowGeometry(f);await hoverWindow(f,keys[0]);
    const clipped=await windowCell(f,keys[0]).evaluate(cell=>{
        const button=cell.querySelector('[data-player-action="close"]'),box=button.getBoundingClientRect(),bounds=cell.getBoundingClientRect();
        return {below:box.top+box.height/2>bounds.bottom,hit:document.elementFromPoint(box.left+box.width/2,box.top+box.height/2)?.closest('button[data-player-action]')===button};
    });
    assert.equal(clipped.below,true);assert.equal(clipped.hit,false,'a clipped tiny-player button cannot receive input outside its player');
    await f.page.evaluate(()=>{document.getElementById('multi-stream-container-wrapper').style.padding=''});
    await settlePane(f,1200,800);await waitWindowGeometry(f);await hoverWindow(f,keys[0]);await assertContinuity(f,before);
});

test('window controls enlarge and shrink the one focused player without opening the editor and safely update renamed channel labels',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys);
    const keyboardButton=windowCell(f,keys[0]).locator('[data-player-action="enlarge"]');await keyboardButton.focus();
    await f.page.waitForFunction(key=>{
        const cell=Array.from(document.querySelectorAll('.player-window-cell')).find(cell=>cell.dataset.playerKey===key);
        return cell.querySelector('[data-player-action="enlarge"]').matches(':focus-visible')&&Number(getComputedStyle(cell.querySelector('.player-window-buttons')).opacity)>.5;
    },keys[0]);
    await keyboardButton.press('Enter');await waitSpan(f,keys[0],2);await waitWindowGeometry(f);
    assert.equal((await geometry(f)).opened,false);assert.equal(await windowCell(f,keys[0]).locator('[data-player-action="shrink"]').isVisible(),true);
    await clickWindowAction(f,keys[2],'enlarge');const switched=await waitSpan(f,keys[2],2);assert.equal(spans(switched)[keys[0]],1);
    assert.equal(switched.layout.items.filter(item=>item.span>1).length,1);await waitWindowGeometry(f);
    await clickWindowAction(f,keys[2],'shrink');await waitSingleCells(f);await waitWindowGeometry(f);
    assert.equal(await windowCell(f,keys[2]).locator('[data-player-action="shrink"]').isVisible(),false);
    const name='<img src=x onerror="window.fixtureWindowXss=true"> & \\" 名稱 '.repeat(12);
    await f.page.evaluate(({key,name})=>{const channel=channels.find(channel=>ChannelList.channelKey(channel)===key);channel.name=name;pruneActivePlayers()}, {key:keys[2],name});
    await f.page.waitForFunction(({key,name})=>Array.from(document.querySelectorAll('.player-window-cell')).find(cell=>cell.dataset.playerKey===key)?.querySelector('[role="group"]').getAttribute('aria-label')===name+' 播放器控制',{key:keys[2],name});
    assert.equal(await f.page.locator('#player-window-controls img,#player-window-controls script').count(),0);assert.equal(await f.page.evaluate(()=>Boolean(window.fixtureWindowXss)),false);
    assert.equal(await windowCell(f,keys[2]).locator('[data-player-action="close"]').getAttribute('aria-label'),'關閉：'+name);
    await assertContinuity(f,before);
});

test('window controls close only the chosen native resource, deselect its checkbox and preserve failed siblings without retrying them',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800}),keys=await f.page.evaluate(()=>fixture.keys),remaining=keys.slice(1);
    await f.page.evaluate(()=>{
        generateChannelOptions();document.querySelectorAll('#channel-options input')[3].checked=false;
        window.fixtureChangedKeys=[];document.getElementById('channel-options').addEventListener('change',event=>fixtureChangedKeys.push(ChannelList.channelKey({id:event.target.value,platform:event.target.dataset.platform,name:event.target.dataset.name})));
        window.fixtureHlsDestroyed=0;fixture.entries[0].resource.hls={destroy(){fixtureHlsDestroyed++}};
        setTimeout(()=>{replacePlayerWithError(fixture.entries[1].resource,'本地保留失敗播放器');window.fixtureFailedElement=fixture.entries[1].resource.element},20);
        window.fixtureRenders=0;const original=renderChannelElement;renderChannelElement=function(...args){fixtureRenders++;return original(...args)};
    });
    await f.page.waitForFunction(()=>fixture.entries[1].resource.element===window.fixtureFailedElement&&fixtureFailedElement?.isConnected);await waitWindowGeometry(f);
    const before=await activeMediaSnapshot(f,remaining,{remember:true}),closedBefore=await f.page.evaluate(()=>readMedia(fixtureMedia[0]));
    await hoverWindow(f,keys[0]);await windowCell(f,keys[0]).locator('[data-player-action="close"]').dblclick();
    await f.page.waitForFunction(()=>activePlayers.size===4);await waitWindowGeometry(f);
    const closed=await f.page.evaluate(()=>({disposed:fixture.entries[0].resource.disposed,src:fixture.entries[0].resource.video.getAttribute('src'),media:readMedia(fixtureMedia[0]),destroyed:fixtureHlsDestroyed,
        channelCount:channels.length,changed:fixtureChangedKeys,checked:Array.from(document.querySelectorAll('#channel-options input'),input=>input.checked),renders:fixtureRenders,
        sameFailed:fixture.entries[1].resource.element===fixtureFailedElement&&fixtureFailedElement.isConnected,othersDisposed:fixture.entries.slice(1).some(entry=>entry.resource?.disposed)}));
    assert.equal(closed.disposed,true);assert.equal(closed.destroyed,1);assert.equal(closed.src,null);assert.equal(closed.media.same,false);
    assert.equal(closed.media.actions.pause,closedBefore.actions.pause+1);assert.equal(closed.media.actions.load,closedBefore.actions.load+1);
    assert.equal(closed.channelCount,5);assert.deepEqual(closed.changed,[keys[0]],'a double-click cannot close a sibling that reflows under the first close button');
    assert.deepEqual(closed.checked,[false,true,true,false,true],'closing a player preserves an unrelated pending checkbox edit');
    assert.equal(closed.renders,0);assert.equal(closed.sameFailed,true);assert.equal(closed.othersDisposed,false);await assertActiveContinuity(f,before);
});

test('window controls keep Kick-like fallback iframe documents and audio intact when closing two to one, then show the empty state after the last close',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,framePlatform:'kick'}),keys=await f.page.evaluate(()=>fixture.keys);
    await f.page.evaluate(()=>generateChannelOptions());
    for(const index of [0,1,4])await clickWindowAction(f,keys[index],'close');
    await f.page.waitForFunction(()=>activePlayers.size===2);await waitWindowGeometry(f);
    const before=await activeMediaSnapshot(f,[keys[3]],{remember:true}),audioBefore=await f.page.locator('#toggle-all-audio').getAttribute('aria-pressed');
    await clickWindowAction(f,keys[2],'close');await f.page.waitForFunction(()=>activePlayers.size===1);await waitWindowGeometry(f);
    assert.equal(await f.page.locator('#toggle-all-audio').getAttribute('aria-pressed'),audioBefore);
    assert.equal(await windowCell(f,keys[3]).locator('[data-player-action="enlarge"]').isDisabled(),true);
    assert.equal(await windowCell(f,keys[3]).locator('[data-player-action="shrink"]').isVisible(),false);
    assert.equal(await f.page.evaluate(()=>ChannelList.channelKey(currentDisplayChannel)),keys[3]);await assertActiveContinuity(f,before);
    await clickWindowAction(f,keys[3],'close');await f.page.waitForFunction(()=>activePlayers.size===0&&document.querySelectorAll('.player-window-cell').length===0);
    assert.equal(await f.page.locator('#multi-stream-container').innerText(),'未選擇任何頻道');assert.equal(await f.page.locator('#player-window-controls').isVisible(),false);
    assert.deepEqual(await f.page.evaluate(()=>({channels:channels.length,checked:document.querySelectorAll('#channel-options input:checked').length,display:currentDisplayChannel})),{channels:5,checked:0,display:null});
    assert.ok([...f.navigations.values()].every(count=>count===1));assert.deepEqual(f.blocked,[]);assert.deepEqual(f.errors,[]);
});

async function editorTimeout(f){
    const seconds=await f.page.evaluate(()=>PLAYER_OVERLAY_TIMEOUT_SECONDS);assert.equal(seconds,30);return seconds*1000;
}
async function savedPositionOrder(f){return f.page.evaluate(()=>localStorage.getItem('playerPositionOrder'))}

test('both editor modes auto-complete at the configured entry deadline and retain committed layouts and media',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;
    for(const mode of ['move','enlarge'])await t.test(mode,async sub=>{
        const f=await fixture(sub,{width:1300,height:1000,clock:true}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys),duration=await editorTimeout(f);
        await f.page.locator(mode==='move'?'#adjust-player-positions':'#enlarge-player').click();
        const hint=await f.page.locator('.player-position-instructions').innerText();assert.match(hint,/30\s*秒/);assert.match(hint,/自動/);
        if(mode==='move'){await positionCell(f,keys[0]).click();await positionCell(f,keys[4]).click()}
        else{await positionCell(f,keys[0]).click();await waitSpan(f,keys[0],2)}
        const committed=await readLayout(f),savedOrder=await savedPositionOrder(f);
        await f.page.clock.runFor(duration-1);assert.equal((await geometry(f)).opened,true,'the editor stays open until its full entry interval elapses');
        await f.page.clock.runFor(1);const completed=await readLayout(f);assert.equal(completed.state.opened,false);
        assert.deepEqual(completed.logical,committed.logical);assert.equal(completed.state.saved,committed.state.saved);assert.equal(await savedPositionOrder(f),savedOrder);
        assert.equal(await f.page.locator('#adjust-player-positions').getAttribute('aria-expanded'),'false');assert.equal(await f.page.locator('#enlarge-player').getAttribute('aria-expanded'),'false');
        assert.equal(await f.page.evaluate(()=>document.activeElement.id),'more-channels-btn','expiry restores focus when it remains inside the editor');
        await f.page.clock.runFor(duration);assert.equal((await geometry(f)).opened,false);await assertContinuity(f,before);
    });
});

test('editor auto-complete cancels previous deadlines on manual close, reentry and mode switches',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000,clock:true}),before=await snapshot(f),duration=await editorTimeout(f);
    await f.page.locator('#adjust-player-positions').click();await f.page.clock.runFor(duration-1000);
    await f.page.keyboard.press('Escape');assert.equal((await geometry(f)).opened,false);
    await f.page.locator('#enlarge-player').click();await f.page.clock.runFor(1000);
    assert.equal((await geometry(f)).opened,true,'the timer from the manually closed session cannot close a new session');
    await f.page.locator('#adjust-player-positions').click();await f.page.clock.runFor(duration-1000);
    assert.equal((await geometry(f)).opened,true,'switching modes replaces the previous deadline');assert.equal((await geometry(f)).mode,'move');
    await f.page.clock.runFor(999);assert.equal((await geometry(f)).opened,true);
    await f.page.clock.runFor(1);assert.equal((await geometry(f)).opened,false);await assertContinuity(f,before);
});

test('editor auto-complete is not postponed by editing, refresh or resize and does not steal external focus',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000,clock:true}),before=await snapshot(f),key=await f.page.evaluate(()=>fixture.keys[0]),duration=await editorTimeout(f);
    await f.page.locator('#enlarge-player').click();await f.page.clock.runFor(duration/2);
    await positionCell(f,key).click();await waitSpan(f,key,2);
    await f.page.locator('.player-position-toolbar-toggle').click();
    await f.page.evaluate(()=>{playerPositionEditor.refresh();fixture.resize(1200,850)});await f.page.clock.runFor(250);
    const committed=await readLayout(f);await f.page.locator('#toggle-all-audio').focus();
    await f.page.clock.runFor(duration/2-251);assert.equal((await geometry(f)).opened,true);
    await f.page.clock.runFor(1);const completed=await readLayout(f);assert.equal(completed.state.opened,false);
    assert.deepEqual(completed.logical,committed.logical);assert.equal(completed.state.saved,committed.state.saved);
    assert.equal(await f.page.evaluate(()=>document.activeElement.id),'toggle-all-audio');await assertContinuity(f,before);
});

test('editor auto-complete cancels uncommitted move drags and corner resize previews',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;
    for(const mode of ['move','enlarge'])await t.test(mode,async sub=>{
        const f=await fixture(sub,{width:1300,height:1000,clock:true}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys),duration=await editorTimeout(f);
        await f.page.locator(mode==='move'?'#adjust-player-positions':'#enlarge-player').click();
        if(mode==='enlarge'){await positionCell(f,keys[0]).click();await waitSpan(f,keys[0],2)}
        await f.page.clock.runFor(duration-500);const committed=await readLayout(f),savedOrder=await savedPositionOrder(f);
        if(mode==='move'){
            const source=await positionCell(f,keys[0]).boundingBox(),target=await positionCell(f,keys[4]).boundingBox();assert.ok(source&&target);
            await f.page.mouse.move(source.x+source.width/2,source.y+source.height/2);await f.page.mouse.down();
            await f.page.mouse.move(target.x+target.width/2,target.y+target.height/2,{steps:8});
            assert.equal(await f.page.locator('.position-dragging').count(),1);
        }else{
            const drag=await startCornerDrag(f,keys[0],'se');await moveCornerDrag(f,drag,1.1);await f.page.clock.runFor(32);await assertPreviewOnly(f,drag);
        }
        await f.page.clock.runFor(mode==='enlarge'?468:500);assert.equal((await geometry(f)).opened,false);await f.page.mouse.up();await assertResizeIdle(f);
        const completed=await readLayout(f);assert.deepEqual(completed.logical,committed.logical);assert.equal(completed.state.saved,committed.state.saved);assert.equal(await savedPositionOrder(f),savedOrder);
        await f.page.locator('#enlarge-player').click();await positionCell(f,keys[1]).click();assertGeometry(await waitSpan(f,keys[1],2),{overlay:true});
        await assertContinuity(f,before);
    });
});

test('editor auto-complete timers are cleared on pagehide and a later session gets a fresh deadline',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000,clock:true}),before=await snapshot(f),key=await f.page.evaluate(()=>fixture.keys[0]),duration=await editorTimeout(f);
    await f.page.locator('#enlarge-player').click();await positionCell(f,key).click();await waitSpan(f,key,2);const committed=await readLayout(f);
    await f.page.clock.runFor(duration-1000);await f.page.locator('#toggle-all-audio').focus();
    await f.page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
    assert.equal((await geometry(f)).opened,false);await f.page.clock.runFor(500);
    assert.equal(await f.page.evaluate(()=>document.activeElement.id),'toggle-all-audio','a discarded session must never restore focus later');
    assert.deepEqual((await readLayout(f)).logical,committed.logical);
    await f.page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
    await f.page.locator('#adjust-player-positions').click();await f.page.clock.runFor(500);
    assert.equal((await geometry(f)).opened,true,'the pagehide timer cannot close a restored session at the old deadline');
    await f.page.clock.runFor(duration-501);assert.equal((await geometry(f)).opened,true);
    await f.page.clock.runFor(1);assert.equal((await geometry(f)).opened,false);await assertContinuity(f,before);
});

test('editor auto-complete honors the absolute deadline when foregrounding after a throttled timer',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000,clock:true}),before=await snapshot(f),duration=await editorTimeout(f);
    await f.page.locator('#adjust-player-positions').click();const committed=await readLayout(f);
    await f.page.clock.setSystemTime(await f.page.evaluate(()=>Date.now())+duration+1);
    assert.equal((await geometry(f)).opened,true,'changing wall time alone does not run the suspended timer');
    await f.page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    assert.equal((await geometry(f)).opened,false);assert.deepEqual((await readLayout(f)).logical,committed.logical);await assertContinuity(f,before);
});

test('one configurable timeout value drives channel-menu idle completion, editor completion and its displayed hint',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const seconds=4,f=await fixture(t,{width:1300,height:1000,clock:true,overlayTimeoutSeconds:seconds}),before=await snapshot(f);
    assert.equal(await f.page.evaluate(()=>PLAYER_OVERLAY_TIMEOUT_SECONDS),seconds);
    await f.page.locator('#more-channels-btn').click();await f.page.clock.runFor(seconds*1000-1);
    assert.equal(await f.page.locator('#channel-selection').isVisible(),true);await f.page.clock.runFor(1);assert.equal(await f.page.locator('#channel-selection').isVisible(),false);
    await f.page.locator('#enlarge-player').click();assert.match(await f.page.locator('.player-position-instructions').innerText(),/4\s*秒/);
    await f.page.clock.runFor(seconds*1000-1);assert.equal((await geometry(f)).opened,true);
    await f.page.clock.runFor(1);assert.equal((await geometry(f)).opened,false);await assertContinuity(f,before);
});

function directionButton(f,key,direction,targetKey){return windowCell(f,key).locator(`[data-player-action="swap-${direction}"]${targetKey===undefined?'':`[data-target-key=${JSON.stringify(targetKey)}]`}`)}
async function fixedDirectionGrid(f,{columns=3,focus=null,order=null}={}){
    await f.page.evaluate(({columns,focus,order})=>{
        if(order)order.forEach((key,index)=>{getPlayerElement(activePlayers.get(key)).style.order=String(index)});
        enlargedPlayerFocus=focus;
        pendingPlayerGeometry={...PlayerGeometry.build({keys:getPlayerPositionKeys(),columns,focus}),intent:'bookmark'};
        updatePlayerLayout({force:true});
    },{columns,focus,order});
    await f.page.waitForFunction(columns=>playerGrid.getColumns()===columns,columns);
    await waitWindowGeometry(f);
}
async function clickDirection(f,key,direction,targetKey){
    const button=directionButton(f,key,direction,targetKey);
    const foreignFrame=await f.page.evaluate(key=>getPlayerElement(activePlayers.get(key)).tagName==='IFRAME',key);
    if(engine==='chromium'&&foreignFrame){await f.page.keyboard.press('Tab');await button.focus();await button.press('Enter')}
    else{await hoverWindow(f,key);await button.click()}
    await waitWindowGeometry(f);
}
async function directionVisibility(f,key){return windowCell(f,key).locator('.player-direction-button').evaluateAll(buttons=>{
    const visible={up:false,down:false,left:false,right:false};
    for(const button of buttons)if(!button.hidden)visible[button.dataset.playerAction.replace('swap-','')]=true;
    return visible;
})}
async function directionTargets(f,key){return windowCell(f,key).locator('.player-direction-button').evaluateAll(buttons=>{
    const targets={up:[],down:[],left:[],right:[]};
    for(const button of buttons)if(!button.hidden)targets[button.dataset.playerAction.replace('swap-','')].push(button.dataset.targetKey);
    return targets;
})}
const directionDeltas={up:[-1,0],down:[1,0],left:[0,-1],right:[0,1]};
function assertDirectionStep(before,after,key,direction){
    const start=before.layout.items.find(item=>item.key===key),actual=after.layout.items.find(item=>item.key===key),[row,column]=directionDeltas[direction];
    assert.deepEqual(actual,{...start,row:start.row+row,column:start.column+column},'an enlarged player moves exactly one base cell');
    assert.equal(after.layout.columns,before.layout.columns,'a direction step cannot change the column count');
    assert.equal(after.layout.rows,before.layout.rows,'a direction step cannot expand the existing grid');
    assert.deepEqual(spans(after),spans(before));assertGeometry(after);
}

test('direction controls hide boundary and empty-tail sides, swap the touching cell once and retain native/iframe playback',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800}),keys=await f.page.evaluate(()=>fixture.keys),before=await snapshot(f);
    await fixedDirectionGrid(f);
    assert.deepEqual(await directionVisibility(f,keys[0]),{up:false,down:true,left:false,right:true});
    assert.deepEqual(await directionVisibility(f,keys[2]),{up:false,down:false,left:true,right:false},'empty final slot cannot become a down or wrapped-right neighbor');
    assert.deepEqual(await directionVisibility(f,keys[4]),{up:true,down:false,left:true,right:false},'the last filled cell cannot swap with an empty cell');
    const expected=[...keys];
    for(const [direction,a,b]of [['right',0,1],['down',1,4],['up',4,1],['left',1,0]]){
        if(direction==='right'){
            await hoverWindow(f,keys[0]);const button=directionButton(f,keys[0],direction);await button.hover();
            const start=await button.boundingBox();await f.page.mouse.down();const held=await button.boundingBox();
            for(const side of ['x','y','width','height'])assert.ok(Math.abs(start[side]-held[side])<.1,'the global active-button scale cannot move a tiny directional hit target');
            await f.page.mouse.up();await waitWindowGeometry(f);
        }else await clickDirection(f,keys[0],direction);
        [expected[a],expected[b]]=[expected[b],expected[a]];
        assert.deepEqual(await f.page.evaluate(()=>fixture.order()),expected);assert.equal((await geometry(f)).opened,false);
        assert.equal(await f.page.evaluate(()=>activePlayers.size),5);assert.equal(await f.page.evaluate(()=>enlargedPlayerFocus),null);
    }
    assert.deepEqual(expected,keys);
    await hoverWindow(f,keys[0]);await directionButton(f,keys[0],'right').dblclick();[expected[0],expected[1]]=[expected[1],expected[0]];
    assert.deepEqual(await f.page.evaluate(()=>fixture.order()),expected,'the second click in a double-click cannot swap back or move an adjacent player');
    assert.equal(await f.page.evaluate(()=>activePlayers.size),5);
    for(const key of keys){
        assert.equal(await f.page.evaluate(key=>{const element=getPlayerElement(activePlayers.get(key)),rect=element.getBoundingClientRect();
            return document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)===element},key),true);
    }
    await assertContinuity(f,before);
});

test('direction controls provide one accessible arrow for every touching neighbor and dispatch each chosen enlarged-edge target',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1500,height:1000,players:17}),keys=await f.page.evaluate(()=>getPlayerPositionKeys()),before=await snapshot(f);
    const focus={key:keys[4],row:1,column:1,span:3},grid={columns:5,focus,order:keys};await fixedDirectionGrid(f,grid);
    const targets={up:[keys[1],keys[2],keys[3]],down:[keys[13],keys[14],keys[15]],left:[keys[6],keys[8],keys[10]],right:[keys[7],keys[9],keys[11]]};
    const start=await geometry(f);assertGeometry(start);assert.deepEqual(start.layout.items.find(item=>item.key===keys[4]),focus);
    assert.deepEqual(await directionTargets(f,keys[4]),targets,'all three small neighbors on each side get their own target arrow');
    assert.equal(await directionButton(f,keys[4],'up').count(),3);
    const duplicates=await f.page.locator('.player-window-cell').evaluateAll(cells=>cells.some(cell=>{
        const ids=Array.from(cell.querySelectorAll('.player-direction-button'),button=>button.dataset.playerAction+'|'+button.dataset.targetKey);
        return new Set(ids).size!==ids.length;
    }));assert.equal(duplicates,false);
    const trackGaps=await f.page.locator('#multi-stream-container').evaluate(pane=>{const style=getComputedStyle(pane);return {horizontal:parseFloat(style.columnGap)||0,vertical:parseFloat(style.rowGap)||0}});
    const source=start.players.find(item=>item.key===keys[4]).rect;
    for(const [direction,neighbors]of Object.entries(targets))for(const targetKey of neighbors){
        const button=directionButton(f,keys[4],direction,targetKey),triangle=await button.boundingBox();assert.ok(triangle);
        const target=start.players.find(item=>item.key===targetKey).rect,vertical=direction==='up'||direction==='down';
        const actual=vertical?triangle.x+triangle.width/2:triangle.y+triangle.height/2;
        const expected=vertical?(Math.max(source.left,target.left)+Math.min(source.right,target.right))/2:(Math.max(source.top,target.top)+Math.min(source.bottom,target.bottom))/2;
        assert.ok(Math.abs(actual-expected)<=(vertical?trackGaps.horizontal:trackGaps.vertical)/2+1,'each arrow is placed on its own shared segment');
        const targetName=await f.page.evaluate(key=>activePlayers.get(key).channel.name,targetKey);
        assert.ok((await button.getAttribute('aria-label')).includes(targetName));
        await f.page.keyboard.press('Tab');await button.focus();
        await f.page.waitForFunction(({key,direction,targetKey})=>{
            const cell=Array.from(document.querySelectorAll('.player-window-cell')).find(cell=>cell.dataset.playerKey===key);
            const button=cell.querySelector(`[data-player-action="swap-${direction}"][data-target-key="${targetKey}"]`);
            return button&&button.matches(':focus-visible')&&Number(getComputedStyle(button).opacity)>.5;
        },{key:keys[4],direction,targetKey});
        const access=await button.evaluate(button=>({focused:document.activeElement===button,focusVisible:button.matches(':focus-visible'),opacity:getComputedStyle(button).opacity,pointerEvents:getComputedStyle(button).pointerEvents}));
        assert.equal(access.focused&&access.focusVisible&&Number(access.opacity)>.5&&access.pointerEvents==='auto',true,JSON.stringify({direction,targetKey,access}));
    }
    await f.page.evaluate(()=>{window.fixtureDirectionMoves=[];const original=movePlayerDirection;
        movePlayerDirection=function(source,direction,target){fixtureDirectionMoves.push({source,direction,target});return original(source,direction,target)}});
    const dispatched=[];
    for(const [direction,neighbors]of Object.entries(targets))for(const targetKey of neighbors){
        await fixedDirectionGrid(f,grid);const beforeStep=await geometry(f);await clickDirection(f,keys[4],direction,targetKey);dispatched.push({source:keys[4],direction,target:targetKey});
        assert.deepEqual(await f.page.evaluate(()=>fixtureDirectionMoves),dispatched,'clicking a non-central arrow must validate that particular neighbor');
        const after=await geometry(f);assertDirectionStep(beforeStep,after,keys[4],direction);assert.equal(spans(after)[keys[4]],3);
        assert.equal(after.layout.items.filter(item=>item.span>1).length,1);assertFits(await f.page.evaluate(()=>fixture.grid()));
    }
    await assertContinuity(f,before);
});

test('direction controls reject a stale arrow target after the touching neighbor moves and allow the refreshed target',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1500,height:1000,players:17}),keys=await f.page.evaluate(()=>getPlayerPositionKeys()),before=await snapshot(f);
    const focus={key:keys[4],row:1,column:1,span:3};await fixedDirectionGrid(f,{columns:5,focus,order:keys});
    const stale=await f.page.evaluate(({source,target,replacement})=>{
        const cell=Array.from(document.querySelectorAll('.player-window-cell')).find(cell=>cell.dataset.playerKey===source);
        const button=cell.querySelector(`[data-player-action="swap-up"][data-target-key="${target}"]`);
        swapPlayerPositions(target,replacement);
        const before=getPlayerPositionKeys(),beforeGeometry=JSON.stringify(playerGeometry),connected=button.isConnected;
        // Intentionally stay in one browser task: the old connected button can
        // receive input before the scheduled overlay refresh has run.
        button.click();
        return {connected,before,after:getPlayerPositionKeys(),beforeGeometry,afterGeometry:JSON.stringify(playerGeometry)};
    },{source:keys[4],target:keys[1],replacement:keys[13]});
    assert.equal(stale.connected,true,'the race checks the previous live overlay, rather than an already removed button');
    assert.deepEqual(stale.after,stale.before);assert.equal(stale.afterGeometry,stale.beforeGeometry,'stale input cannot silently step toward a different adjacent player');
    await waitWindowGeometry(f);await f.page.waitForFunction(({source,replacement})=>{
        const cell=Array.from(document.querySelectorAll('.player-window-cell')).find(cell=>cell.dataset.playerKey===source);
        return Boolean(cell.querySelector(`[data-player-action="swap-up"][data-target-key="${replacement}"]`));
    },{source:keys[4],replacement:keys[13]});
    assert.equal(await directionButton(f,keys[4],'up',keys[1]).count(),0);
    const beforeStep=await geometry(f);
    await clickDirection(f,keys[4],'up',keys[13]);
    assertDirectionStep(beforeStep,await geometry(f),keys[4],'up');
    assert.equal(spans(await geometry(f))[keys[4]],3);await assertContinuity(f,before);
});

test('direction controls keep compact enlarged-edge hit targets distinct and dispatch both opposite sides',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:104,height:104,players:17}),keys=await f.page.evaluate(()=>getPlayerPositionKeys()),before=await snapshot(f);
    await f.page.evaluate(()=>{document.getElementById('multi-stream-container-wrapper').style.padding='0';document.getElementById('multi-stream-container').style.border='0'});
    const focus={key:keys[4],row:1,column:1,span:3},grid={columns:5,focus,order:keys};await fixedDirectionGrid(f,grid);
    const cell=windowCell(f,keys[4]),bounds=await cell.boundingBox();assert.ok(bounds.width>55&&bounds.width<65,JSON.stringify(bounds));
    const left=directionButton(f,keys[4],'left',keys[6]);await f.page.keyboard.press('Tab');await left.focus();
    await f.page.waitForFunction(key=>{const cell=Array.from(document.querySelectorAll('.player-window-cell')).find(cell=>cell.dataset.playerKey===key);
        return Array.from(cell.querySelectorAll('.player-direction-button')).every(button=>Number(getComputedStyle(button).opacity)>.5)},keys[4]);
    const hits=await cell.locator('.player-direction-button').evaluateAll(buttons=>buttons.map(button=>{
        const rect=button.getBoundingClientRect(),hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
        return {action:button.dataset.playerAction,target:button.dataset.targetKey,x:rect.left+rect.width/2,y:rect.top+rect.height/2,
            hit:hit?.closest('button')===button,width:rect.width,height:rect.height};
    }));
    assert.equal(hits.length,12);assert.equal(new Set(hits.map(hit=>hit.x.toFixed(2)+'|'+hit.y.toFixed(2))).size,12);
    assert.ok(hits.every(hit=>hit.hit&&hit.width>0&&hit.height>0),JSON.stringify(hits));
    const leftBounds=await left.boundingBox(),rightBounds=await directionButton(f,keys[4],'right',keys[7]).boundingBox();
    assert.ok(leftBounds.x+leftBounds.width<=rightBounds.x,'inward arrows on opposite sides cannot overlap in a roughly 60 px enlarged tile');
    await f.page.evaluate(()=>{window.fixtureCompactDirectionMoves=[];const original=movePlayerDirection;
        movePlayerDirection=function(source,direction,target){fixtureCompactDirectionMoves.push({source,direction,target});return original(source,direction,target)}});
    for(const [direction,target]of [['left',keys[6]],['right',keys[7]]]){
        await fixedDirectionGrid(f,grid);const beforeStep=await geometry(f);await clickDirection(f,keys[4],direction,target);
        assertDirectionStep(beforeStep,await geometry(f),keys[4],direction);
    }
    assert.deepEqual(await f.page.evaluate(()=>fixtureCompactDirectionMoves),[{source:keys[4],direction:'left',target:keys[6]},{source:keys[4],direction:'right',target:keys[7]}]);
    await assertContinuity(f,before);
});

test('direction controls move span-two and span-three players by one base cell from either side of every shared edge',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;
    const inverse={up:'down',down:'up',left:'right',right:'left'};
    for(const span of [2,3])await t.test('span '+span,async st=>{
        const f=await fixture(st,{width:1500,height:1000,players:26-span*span}),keys=await f.page.evaluate(()=>getPlayerPositionKeys()),before=await snapshot(f);
        const focus={key:keys[4],row:1,column:1,span},grid={columns:5,focus,order:keys};
        for(const direction of Object.keys(inverse)){
            await fixedDirectionGrid(f,grid);let start=await geometry(f),targets=(await directionTargets(f,keys[4]))[direction];
            assert.equal(targets.length,span);const small=targets[targets.length-1];
            await clickDirection(f,keys[4],direction,small);assertDirectionStep(start,await geometry(f),keys[4],direction);
            await fixedDirectionGrid(f,grid);start=await geometry(f);
            await clickDirection(f,small,inverse[direction],keys[4]);assertDirectionStep(start,await geometry(f),keys[4],direction);
            assert.equal((await geometry(f)).opened,false);assertFits(await f.page.evaluate(()=>fixture.grid()));
        }
        await assertContinuity(f,before);
    });
});

test('direction controls repeat one-cell moves to each boundary and handle a partially occupied final edge',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;
    await t.test('dense grid boundaries',async st=>{
        const f=await fixture(st,{width:1500,height:1000,players:22}),keys=await f.page.evaluate(()=>getPlayerPositionKeys()),before=await snapshot(f);
        const key=keys[4],focus={key,row:1,column:1,span:2};await fixedDirectionGrid(f,{columns:5,focus,order:keys});
        for(const [direction,expectedMoves]of [['right',2],['up',1],['left',3],['down',3]]){
            let moved=0,lastTarget=null;
            while((await directionTargets(f,key))[direction].length){
                assert.ok(moved<5,'a boundary cannot wrap or create another grid strip');
                const start=await geometry(f),targets=(await directionTargets(f,key))[direction];lastTarget=targets[targets.length-1];
                await clickDirection(f,key,direction,lastTarget);assertDirectionStep(start,await geometry(f),key,direction);moved++;
            }
            assert.equal(moved,expectedMoves);assert.equal(await directionButton(f,key,direction).count(),0);
            const stopped=await f.page.evaluate(({key,direction,target})=>{
                const before=JSON.stringify(playerGeometry),result=movePlayerDirection(key,direction,target);
                return {result,same:before===JSON.stringify(playerGeometry)};
            },{key,direction,target:lastTarget});
            assert.deepEqual(stopped,{result:false,same:true},'a repeated stale boundary action cannot extend or wrap the grid');
        }
        await assertContinuity(f,before);
    });
    await t.test('partial final strip',async st=>{
        const f=await fixture(st,{width:1500,height:1000,players:15}),keys=await f.page.evaluate(()=>getPlayerPositionKeys()),before=await snapshot(f);
        const key=keys[4],focus={key,row:1,column:1,span:3};await fixedDirectionGrid(f,{columns:5,focus,order:keys});
        const targets=(await directionTargets(f,key)).down;assert.equal(targets.length,2,'only the occupied parts of the lower edge have arrows');
        const start=await geometry(f);await clickDirection(f,key,'down',targets[1]);assertDirectionStep(start,await geometry(f),key,'down');
        assert.equal((await geometry(f)).layout.items.length,15);assert.equal(await directionButton(f,key,'down').count(),0);
        assertFits(await f.page.evaluate(()=>fixture.grid()));await assertContinuity(f,before);
    });
    await t.test('sparse strip preserves representable unrelated positions',async st=>{
        const f=await fixture(st,{width:1200,height:800}),keys=await f.page.evaluate(()=>getPlayerPositionKeys());
        await f.page.evaluate(key=>closePlayer(key),keys[4]);
        const key=keys[0],focus={key,row:0,column:0,span:2};await fixedDirectionGrid(f,{columns:3,focus,order:keys.slice(0,4)});
        const before=await activeMediaSnapshot(f,keys.slice(0,4),{remember:true});
        assert.deepEqual((await directionTargets(f,key)).down,[keys[3]]);await clickDirection(f,key,'down',keys[3]);
        const state=await geometry(f);assert.deepEqual(Object.fromEntries(state.layout.items.map(item=>[item.key,{row:item.row,column:item.column,span:item.span}])),{
            [key]:{row:1,column:0,span:2},[keys[1]]:{row:0,column:2,span:1},
            [keys[2]]:{row:0,column:1,span:1},[keys[3]]:{row:0,column:0,span:1}
        },'an unrelated top-right tile stays pinned while the entering tile fills the first released cell');
        assert.equal(state.layout.columns,3);assertGeometry(state);assertFits(await f.page.evaluate(()=>fixture.grid()));await assertActiveContinuity(f,before);
    });
});

test('direction controls persist the stepped layout through small pane changes, bookmark restore and reopening the browser state',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1500,height:1000,players:17}),keys=await f.page.evaluate(()=>getPlayerPositionKeys()),before=await snapshot(f);
    const key=keys[4],focus={key,row:1,column:1,span:3};await fixedDirectionGrid(f,{columns:5,focus,order:keys});
    const target=(await directionTargets(f,key)).right[0],start=await geometry(f);await clickDirection(f,key,'right',target);
    const stepped=await readLayout(f);assertDirectionStep(start,stepped.state,key,'right');
    const saved=await f.page.evaluate(()=>({bookmark:capturePlayerBookmark(),storage:{
        playerPositionOrder:localStorage.getItem('playerPositionOrder'),playerEnlargementLayout:localStorage.getItem('playerEnlargementLayout')
    }}));
    assert.deepEqual(saved.bookmark.focus,{...focus,column:2});assert.equal(saved.bookmark.columns,5);
    assert.deepEqual(JSON.parse(saved.storage.playerEnlargementLayout).focus,{...focus,column:2});
    for(const [width,height]of [[1490,990],[1510,1010],[1500,1000]]){
        await settlePane(f,width,height);assert.deepEqual((await readLayout(f)).logical,stepped.logical,'a small pane change cannot undo a committed direction step');
    }
    await clickDirection(f,key,'left',(await directionTargets(f,key)).left[0]);
    await f.page.evaluate(bookmark=>applyPlayerBookmark(bookmark),saved.bookmark);await waitWindowGeometry(f);
    assert.deepEqual((await readLayout(f)).logical,stepped.logical,'the real bookmark capture/apply path restores the exact one-cell destination');
    await assertContinuity(f,before);
    const reopened=await fixture(t,{width:1500,height:1000,players:17,storageSeed:saved.storage});await waitWindowGeometry(reopened);
    assert.deepEqual((await readLayout(reopened)).logical,stepped.logical,'saved order and enlargement reconstruct the stepped arrangement on a fresh page');
    assert.deepEqual(reopened.errors,[]);assert.deepEqual(reopened.blocked,[]);
});

test('direction controls on foreign-frame players preserve hover handoff, document identity and media click isolation',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800}),keys=await f.page.evaluate(()=>fixture.keys),before=await snapshot(f);
    await fixedDirectionGrid(f);for(const frame of f.frames)await frame.evaluate(()=>{window.fixtureDirectionMediaClicks=0;fixtureMedia[0].video.addEventListener('click',()=>fixtureDirectionMediaClicks++)});
    const expected=[...keys];
    for(const [index,direction,a,b]of [[2,'left',2,1],[3,'up',3,0],[2,'down',1,4],[3,'right',0,1]]){
        await clickDirection(f,keys[index],direction);[expected[a],expected[b]]=[expected[b],expected[a]];
        assert.deepEqual(await f.page.evaluate(()=>fixture.order()),expected);assert.equal((await geometry(f)).opened,false);
    }
    assert.deepEqual(await Promise.all(f.frames.map(frame=>frame.evaluate(()=>fixtureDirectionMediaClicks))),[0,0],'parent control input cannot also click the foreign media');
    if(engine==='chromium')t.diagnostic('Foreign-frame directional actions use keyboard activation because Chromium Playwright OOPIF input does not reliably update parent hover; Firefox exercises native hover and pointer handoff.');
    await assertContinuity(f,before);
});

test('direction controls are keyboard accessible and the top-left move shortcut preselects its player and restores focus on completion',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800}),keys=await f.page.evaluate(()=>fixture.keys),before=await snapshot(f);
    await fixedDirectionGrid(f);const direction=directionButton(f,keys[0],'right');
    await f.page.mouse.move(1990,1290);await f.page.keyboard.press('Tab');await direction.focus();
    await f.page.waitForFunction(key=>{const cell=Array.from(document.querySelectorAll('.player-window-cell')).find(cell=>cell.dataset.playerKey===key),button=cell.querySelector('[data-player-action="swap-right"]');
        return button.matches(':focus-visible')&&Number(getComputedStyle(button).opacity)>.5&&getComputedStyle(button).pointerEvents==='auto'},keys[0]);
    await direction.press('Enter');const expected=[...keys];[expected[0],expected[1]]=[expected[1],expected[0]];
    assert.deepEqual(await f.page.evaluate(()=>fixture.order()),expected);
    const move=windowCell(f,keys[2]).locator('[data-player-action="move"]');await move.focus();await move.press('Space');
    await f.page.waitForFunction(()=>fixture.geometry().opened&&fixture.geometry().mode==='move');
    assert.equal(await positionCell(f,keys[2]).getAttribute('aria-pressed'),'true');assert.equal(await positionCell(f,keys[2]).evaluate(cell=>document.activeElement===cell),true);
    assert.equal(await f.page.locator('#player-window-controls').isVisible(),false);
    await positionCell(f,keys[4]).click();[expected[2],expected[4]]=[expected[4],expected[2]];
    assert.deepEqual(await f.page.evaluate(()=>fixture.order()),expected,'opening via the shortcut needs only the destination click to exchange');
    await f.page.keyboard.press('Escape');await waitWindowGeometry(f);
    assert.equal(await move.evaluate(button=>document.activeElement===button),true,'completion returns focus to the invoking move shortcut');
    assert.equal((await geometry(f)).opened,false);
    await assertContinuity(f,before);
});

test('direction controls hide through fullscreen and editor modes and disable movement for a single remaining player',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800}),keys=await f.page.evaluate(()=>fixture.keys);
    await fixedDirectionGrid(f);const before=await snapshot(f);
    for(const selector of ['#adjust-player-positions','#enlarge-player']){
        await f.page.locator(selector).click();await f.page.waitForFunction(()=>document.getElementById('player-window-controls').hidden);
        assert.equal(await f.page.locator('#player-window-controls').isVisible(),false);
        await f.page.keyboard.press('Escape');await waitWindowGeometry(f);
    }
    await t.test('native fullscreen lifecycle',async st=>{
        await f.page.evaluate(()=>{const button=document.createElement('button');button.id='fixture-direction-fullscreen';button.textContent='全螢幕';
            button.onclick=()=>{window.fixtureDirectionFullscreen=document.getElementById('native-0').requestFullscreen().then(()=>null,error=>error.name+': '+error.message)};
            document.body.prepend(button)});
        await f.page.locator('#fixture-direction-fullscreen').click();const failure=await f.page.evaluate(()=>fixtureDirectionFullscreen);
        if(failure){st.skip('Browser fullscreen is unavailable in this headless model: '+failure);return}
        await f.page.waitForFunction(()=>document.fullscreenElement&&document.getElementById('player-window-controls').hidden);
        assert.equal(await f.page.locator('#player-window-controls').isVisible(),false);
        await f.page.evaluate(()=>document.exitFullscreen());await waitWindowGeometry(f);
    });
    await assertContinuity(f,before);
    const retained=await activeMediaSnapshot(f,[keys[0]],{remember:true});
    await f.page.evaluate(keys=>{for(const key of keys.slice(1))closePlayer(key)},keys);await waitWindowGeometry(f);
    assert.deepEqual(await directionVisibility(f,keys[0]),{up:false,down:false,left:false,right:false});
    assert.equal(await windowCell(f,keys[0]).locator('[data-player-action="move"]').isDisabled(),true);
    assert.equal(await windowCell(f,keys[0]).locator('[data-player-action="enlarge"]').isDisabled(),true);
    await f.page.mouse.move(1990,1290);await f.page.locator('#toggle-all-audio').focus();
    await f.page.waitForFunction(()=>{const button=document.querySelector('.player-window-move');return button&&Number(getComputedStyle(button).opacity)===0});
    await assertActiveContinuity(f,retained);
});
