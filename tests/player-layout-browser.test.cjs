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
let browser, unavailable, appScript, layoutScript, geometryScript, channelScript, performanceScript, css;

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
    layoutScript=read('player-layout.js');geometryScript=read('player-geometry.js');channelScript=read('channel-list.js');performanceScript=read('stream-performance.js');
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

async function fixture(t,{width=1800,height=320,viewport={width:2000,height:1300},storageSeed=null,denyStorage=false}={}){
    const context=await browser.newContext({viewport,serviceWorkers:'block'});t.after(()=>context.close());
    if(storageSeed||denyStorage)await context.addInitScript(({storageSeed,denyStorage,origin})=>{
        if(location.origin!==origin)return;
        if(storageSeed)for(const [key,value]of Object.entries(storageSeed))localStorage.setItem(key,value);
        if(denyStorage)for(const method of ['getItem','setItem','removeItem'])Object.defineProperty(Storage.prototype,method,{
            configurable:true,value(){throw new DOMException('Storage is disabled by the browser','SecurityError')}
        });
    },{storageSeed,denyStorage,origin:new URL(siteUrl).origin});
    const navigations=new Map(),blocked=[];
    const main=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>
    <div style="height:30px;flex:none"><button id="more-channels-btn">看更台</button><button id="adjust-player-positions">調整位置</button><button id="enlarge-player">放大模式</button><button id="reset-player-positions">重設</button><button id="toggle-all-audio">聲音</button></div>
    <div id="channel-selection" style="display:none"></div><div id="multi-stream-container-wrapper" style="flex:none;width:${width}px;height:${height}px;min-height:0"><div id="multi-stream-container" class="video-wrapper"></div></div>
    <script src="/instrument.js"></script><script src="/channel-list.js"></script><script src="/stream-performance.js"></script><script src="/player-geometry.js"></script><script src="/player-layout.js"></script><script src="/fixture-app.js"></script></body></html>`;
    const child=`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><video id="frame-video" loop muted playsinline preload="auto" src="/silent.wav" style="width:100%;height:100%"></video><script>${instrument}\ninstrumentMedia(document.getElementById('frame-video'));</script></body></html>`;
    await context.route('**/*',route=>{
        const request=route.request(),url=new URL(request.url());
        if(request.isNavigationRequest()){
            navigations.set(request.url(),(navigations.get(request.url())||0)+1);
            if(request.url()===siteUrl)return route.fulfill({contentType:'text/html',body:main});
            if(url.origin===frameOrigin&&url.pathname==='/player')return route.fulfill({contentType:'text/html',body:child});
        }
        const scripts={'/instrument.js':instrument,'/channel-list.js':channelScript,'/stream-performance.js':performanceScript,'/player-geometry.js':geometryScript,'/player-layout.js':layoutScript,'/fixture-app.js':appScript};
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
    assert.equal(JSON.parse(await f.page.evaluate(()=>localStorage.getItem('playerEnlargementLayout'))).focus.key,key,'hidden channel preferences remain saved like the preferred position order');
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
    assert.equal(await f.page.locator('#adjust-player-positions').isDisabled(),true);assert.deepEqual(f.errors,[]);assert.deepEqual(f.blocked,[]);
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
