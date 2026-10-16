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
let browser, unavailable, appScript, layoutScript, channelScript, performanceScript, css;

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
    const editorStart=source.indexOf('(function initPlayerPositionEditor()');
    const editorEnd=source.indexOf('\nfunction toggleChannelMenu()',editorStart);
    assert.ok(coreEnd>0&&editorStart>coreEnd&&editorEnd>editorStart,'reviewed production core/editor seams must exist');
    appScript=source.slice(0,coreEnd)+'\n'+source.slice(editorStart,editorEnd)+'\n'+fixtureApp;
    layoutScript=read('player-layout.js');channelScript=read('channel-list.js');performanceScript=read('stream-performance.js');
    css=[...read('index.html').matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match=>match[1]).join('\n');
    console.log(`Player layout model: ${engine} ${browser.version()} (production CSS/app sections; all network intercepted; no live platform).`);
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
window.fixture={elements:[],entries:[],keys:[],frames:[],removals:0,frameSources:0};
fixture.mount=function(){
 const pane=document.getElementById('multi-stream-container');
 channels=Array.from({length:5},(_,index)=>({id:'layout-'+index,platform:index===2||index===3?'at':'m3u8',name:'播放器 '+index}));
 channels.forEach((channel,index)=>{
   let element,resource=null;
   if(channel.platform==='at'){
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
 new MutationObserver(records=>{for(const record of records)for(const node of record.removedNodes)if(fixture.elements.includes(node))fixture.removals++}).observe(pane,{childList:true});
 fixture.frames.forEach(frame=>frame.window=frame.element.contentWindow);
 syncActivePlayers(channels);
};
fixture.resize=function(width,height){const host=document.getElementById('multi-stream-container-wrapper');host.style.width=width+'px';host.style.height=height+'px'};
fixture.order=()=>getPlayerPositionKeys();
fixture.identity=()=>({elements:fixture.elements.every((element,index)=>paneChildren()[index]===element),
 entries:fixture.keys.every((key,index)=>activePlayers.get(key)===fixture.entries[index]),
 windows:fixture.frames.every(frame=>frame.element.contentWindow===frame.window),removals:fixture.removals,frameSources:fixture.frameSources,
 loads:fixture.frames.map(frame=>Number(frame.element.dataset.loads||0))});
function paneChildren(){return Array.from(document.getElementById('multi-stream-container').children)}
fixture.snapshot=()=>fixtureMedia.map(readMedia);
fixture.grid=function(){const pane=document.getElementById('multi-stream-container'),style=getComputedStyle(pane),bounds=pane.getBoundingClientRect(),
 overlay=document.querySelector('.player-position-cells'),tracks=style.gridTemplateColumns.split(' ').filter(Boolean);
 return {columns:tracks.length,rows:style.gridTemplateRows.split(' ').filter(Boolean).length,width:pane.clientWidth,height:pane.clientHeight,
 overflowX:pane.scrollWidth-pane.clientWidth,overflowY:pane.scrollHeight-pane.clientHeight,
 overlayColumns:overlay&&!document.getElementById('player-position-editor').hidden?getComputedStyle(overlay).gridTemplateColumns.split(' ').length:null,
 fits:fixture.elements.every(element=>{const r=element.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=bounds.left-.5&&r.top>=bounds.top-.5&&r.right<=bounds.right+.5&&r.bottom<=bounds.bottom+.5})};
};
fixture.mount();`;

async function fixture(t,{width=1800,height=320,viewport={width:2000,height:1300}}={}){
    const context=await browser.newContext({viewport,serviceWorkers:'block'});t.after(()=>context.close());
    const navigations=new Map(),blocked=[];
    const main=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>
    <div style="height:30px;flex:none"><button id="more-channels-btn">看更台</button><button id="adjust-player-positions">調整位置</button><button id="reset-player-positions">重設</button><button id="toggle-all-audio">聲音</button></div>
    <div id="channel-selection" style="display:none"></div><div id="multi-stream-container-wrapper" style="flex:none;width:${width}px;height:${height}px;min-height:0"><div id="multi-stream-container" class="video-wrapper"></div></div>
    <script src="/instrument.js"></script><script src="/channel-list.js"></script><script src="/stream-performance.js"></script><script src="/player-layout.js"></script><script src="/fixture-app.js"></script></body></html>`;
    const child=`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><video id="frame-video" loop muted playsinline preload="auto" src="/silent.wav" style="width:100%;height:100%"></video><script>${instrument}\ninstrumentMedia(document.getElementById('frame-video'));</script></body></html>`;
    await context.route('**/*',route=>{
        const request=route.request(),url=new URL(request.url());
        if(request.isNavigationRequest()){
            navigations.set(request.url(),(navigations.get(request.url())||0)+1);
            if(request.url()===siteUrl)return route.fulfill({contentType:'text/html',body:main});
            if(url.origin===frameOrigin&&url.pathname==='/player')return route.fulfill({contentType:'text/html',body:child});
        }
        const scripts={'/instrument.js':instrument,'/channel-list.js':channelScript,'/stream-performance.js':performanceScript,'/player-layout.js':layoutScript,'/fixture-app.js':appScript};
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
    await page.goto(siteUrl,{waitUntil:'load'});
    try{await page.waitForFunction(()=>window.fixture?.keys.length===5&&fixtureMedia.every(saved=>saved.video.readyState>=2))}
    catch(error){console.error('Layout fixture diagnostic:',errors,await page.evaluate(()=>({keys:window.fixture?.keys,media:window.fixtureMedia?.map(saved=>({connected:saved.video.isConnected,state:saved.video.readyState,error:saved.video.error?.message,source:saved.video.currentSrc})),body:document.body.innerText.slice(0,150)})));throw error}
    const frames=page.frames().filter(frame=>frame.url().startsWith(frameOrigin));assert.equal(frames.length,2);
    for(const frame of frames)await frame.waitForFunction(()=>fixtureMedia[0]?.video.readyState>=2);
    await page.evaluate(async()=>{for(const [index,saved]of fixtureMedia.entries()){saved.video.volume=.21+index*.1;saved.video.currentTime=.375;if(index===1){saved.video.muted=false;saved.video.pause()}else await saved.video.play()}});
    for(const [index,frame]of frames.entries())await frame.evaluate(async index=>{const video=fixtureMedia[0].video;video.volume=.33+index*.1;video.currentTime=.375;if(index===1){video.muted=false;video.pause()}else await video.play()},index);
    await page.waitForFunction(()=>fixture.identity().loads.every(count=>count===1));
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
