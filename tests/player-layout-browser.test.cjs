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
let browser, unavailable, playwrightRuntime, appScript, layoutScript, geometryScript, channelScript, performanceScript, bookmarkScript, qualityScript, css;

test.before(async () => {
    if (!enabled) return;
    let playwright;
    try { playwright = require('playwright'); }
    catch (_) {
        try { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
        catch (error) { throw new Error('Browser tests were requested but Playwright is unavailable. Run npm ci.', { cause: error }); }
    }
    playwrightRuntime=playwright;
    assert.ok(['chromium', 'firefox'].includes(engine));
    try { browser = await playwright[engine].launch({headless:true,...(executablePath ? {executablePath} : {}),
        ...(engine==='firefox'?{firefoxUserPrefs:{'media.autoplay.default':0}}:{args:['--autoplay-policy=no-user-gesture-required']})}); }
    catch (error) { throw new Error(`Cannot launch requested ${engine}; run npx playwright install --with-deps ${engine}.`, { cause: error }); }
    const read = file => fs.readFileSync(path.join(root, file), 'utf8');
    const source=read('tv-app.js');
    const coreEnd=source.indexOf('/* =============== 頻道儲存 / 載入');
    const statusClassStart=source.indexOf('function applyStatusClass(');
    const statusClassEnd=source.indexOf('\nfunction updateButtonStatus(',statusClassStart);
    const summaryStart=source.indexOf('function updateChannelSelectionSummary()');
    const selectionStart=source.indexOf('function toggleChannelSelection()');
    const editorStart=source.indexOf('(function initPlayerPositionEditor()');
    const editorEnd=source.indexOf('\nfunction toggleChannelMenu()',editorStart);
    assert.ok(coreEnd>0&&statusClassStart>coreEnd&&statusClassEnd>statusClassStart&&summaryStart>statusClassEnd&&selectionStart>summaryStart&&editorStart>selectionStart&&editorEnd>editorStart,'reviewed production core/status/selection/editor seams must exist');
    appScript=source.slice(0,coreEnd)+'\n'+source.slice(statusClassStart,statusClassEnd)+'\n'+source.slice(summaryStart,editorEnd)+'\n'+fixtureApp;
    layoutScript=read('player-layout.js');geometryScript=read('player-geometry.js');channelScript=read('channel-list.js');performanceScript=read('stream-performance.js');bookmarkScript=read('layout-bookmarks.js');
    qualityScript=read('stream-quality.js');
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
// Keep production card creation, selection, and hover handlers. Live status
// providers are outside this closed model, so no metadata request is needed.
function fetchAllStatuses(){return Promise.resolve([])}
window.fixture={elements:[],entries:[],keys:[],frames:[],removals:0,frameSources:0};
// Keep the production Twitch renderer and StreamQuality mounting paths. Only
// the external SDK boundary is replaced: one nested embed and one constructor
// failure exercise the two real local DOM paths without live Twitch requests.
if(document.body.dataset.fixtureProductionTwitch==='true'){
 window.fixtureTwitchCalls={play:0,pause:0,muted:0,quality:0,destroy:0};
 window.Twitch={Player:class{
  constructor(wrapper,options){
   if(options.channel==='layout-3')throw new Error('closed fixture SDK fallback');
   const host=document.createElement('div');host.dataset.fixtureTwitchSdkHost='true';host.style.cssText='position:relative;width:100%;height:100%';
   const frame=document.createElement('iframe');frame.src='${frameOrigin}/player?index=2';frame.allow='autoplay';frame.style.cssText='position:relative;z-index:1000000';host.appendChild(frame);wrapper.appendChild(host);
  }
  addEventListener(){} removeEventListener(){}
  play(){fixtureTwitchCalls.play++} pause(){fixtureTwitchCalls.pause++} setMuted(){fixtureTwitchCalls.muted++}
  setQuality(){fixtureTwitchCalls.quality++} destroy(){fixtureTwitchCalls.destroy++}
 }};
}
fixture.mount=function(){
 const pane=document.getElementById('multi-stream-container');
 channels=Array.from({length:5},(_,index)=>({id:'layout-'+index,platform:index===2||index===3?document.body.dataset.fixtureFramePlatform||'at':'m3u8',name:'播放器 '+index}));
 channels.forEach((channel,index)=>{
   let element,resource=null;
   if(index===2||index===3){
      let frame;
      const trackFrame=frame=>{
          frame.id='frame-'+index;
          frame.addEventListener('load',()=>{frame.dataset.loads=String(Number(frame.dataset.loads||0)+1)});
          new MutationObserver(records=>{fixture.frameSources+=records.length}).observe(frame,{attributes:true,attributeFilter:['src']});
          fixture.frames.push({element:frame,window:frame.contentWindow,index});fixture.frames.sort((a,b)=>a.index-b.index);
      };
      if(document.body.dataset.fixtureProductionTwitch==='true'){
          element=RENDERERS.twitch(channel,{buildUrl:()=> '${frameOrigin}/player?index='+index},true,'video');resource=playerResources.get(element);
          const mountObserver=new MutationObserver(()=>{const mounted=element.querySelector('iframe');if(mounted){mountObserver.disconnect();trackFrame(mounted)}});
          mountObserver.observe(element,{childList:true,subtree:true});
      }else if(document.body.dataset.fixtureProductionKick==='true'){
          element=RENDERERS.scaledIframe(channel,{buildUrl:()=> '${frameOrigin}/player?index='+index},true,'video');
          frame=element.querySelector('iframe');
      }else{
          element=document.createElement('iframe');element.src='${frameOrigin}/player?index='+index;element.allow='autoplay';frame=element;
      }
      if(frame)trackFrame(frame);
   }else{
      element=document.createElement('video');element.id='native-'+index;element.className='hls-video-element';element.loop=true;element.playsInline=true;
      element.src='/silent.wav?native='+index;element.muted=true;instrumentMedia(element);
      resource={video:element,element,disposed:false,failed:false,hls:null,flv:null};playerResources.set(element,resource);
      if(document.body.dataset.fixtureAudioUserscript==='true'&&index===4){
          const video=element;const wrapper=document.createElement('div');wrapper.id='wrapped-native-4';
          video.style.cssText='display:block;width:100%;height:100%';wrapper.appendChild(video);element=wrapper;resource.element=wrapper;
      }
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
 const catalogCount=Number(document.body.dataset.fixtureCatalogChannels||0);
 if(catalogCount)channels.splice(2,0,...Array.from({length:catalogCount},(_,index)=>({platform:'at',id:'catalog-'+index,name:'未播放目錄 '+index})));
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

async function fixture(t,{width=1800,height=320,viewport={width:2000,height:1300},storageSeed=null,denyStorage=false,players=5,catalogChannels=0,hasTouch=false,framePlatform='at',productionKick=false,productionTwitch=false,clock=false,overlayTimeoutSeconds,audioUserscript=false,fixtureBrowser=browser}={}){
    const context=await fixtureBrowser.newContext({viewport,serviceWorkers:'block',...(hasTouch?{hasTouch:true}:{})});t.after(()=>context.close());
    if(storageSeed||denyStorage)await context.addInitScript(({storageSeed,denyStorage,origin})=>{
        if(location.origin!==origin)return;
        if(storageSeed)for(const [key,value]of Object.entries(storageSeed))localStorage.setItem(key,value);
        if(denyStorage)for(const method of ['getItem','setItem','removeItem'])Object.defineProperty(Storage.prototype,method,{
            configurable:true,value(){throw new DOMException('Storage is disabled by the browser','SecurityError')}
        });
    },{storageSeed,denyStorage,origin:new URL(siteUrl).origin});
    const navigations=new Map(),blocked=[];
    assert.ok(['at','kick','twitch'].includes(framePlatform));
    if(productionKick)framePlatform='kick';
    if(productionTwitch)framePlatform='twitch';
    const modelFrameOrigin=audioUserscript?(productionTwitch?'https://player.twitch.tv':'https://player.kick.com'):frameOrigin;
    let fixtureScript=audioUserscript?appScript.replaceAll(frameOrigin,modelFrameOrigin):appScript;
    if(overlayTimeoutSeconds!==undefined){
        assert.ok(Number.isInteger(overlayTimeoutSeconds)&&overlayTimeoutSeconds>0);
        fixtureScript=fixtureScript.replace(/(const\s+PLAYER_OVERLAY_TIMEOUT_SECONDS\s*=\s*)\d+(\s*;)/,(_,prefix,suffix)=>prefix+overlayTimeoutSeconds+suffix);
        assert.notEqual(fixtureScript,appScript,'the reviewed timeout constant must be configurable in this fixture');
    }
    const main=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body data-fixture-players="${players}" data-fixture-catalog-channels="${catalogChannels}" data-fixture-frame-platform="${framePlatform}" data-fixture-production-kick="${productionKick}" data-fixture-production-twitch="${productionTwitch}" data-fixture-audio-userscript="${audioUserscript}">
    <div ${audioUserscript?'id="input-container"':''} style="height:${audioUserscript?40:30}px;flex:none;${audioUserscript?'margin-left:0;width:100%;padding-left:0':''}"><button id="more-channels-btn" onclick="toggleChannelSelection()">看更台</button><button id="adjust-player-positions">調整位置</button><button id="enlarge-player">放大模式</button><button id="reset-player-positions">重設</button><button id="toggle-all-audio">聲音</button></div>
    <div id="channel-selection" style="display:none"><div id="channel-options"></div><button id="fixture-watch-selected" onclick="watchSelectedChannels()">開始觀看</button></div><div id="multi-stream-container-wrapper" style="flex:none;width:${width}px;height:${height}px;min-height:0"><div id="multi-stream-container" class="video-wrapper"></div></div>
    <script src="/instrument.js"></script><script src="/channel-list.js"></script><script src="/stream-performance.js"></script><script src="/player-geometry.js"></script><script src="/player-layout.js"></script><script src="/layout-bookmarks.js"></script>${productionTwitch?'<script src="/stream-quality.js"></script>':''}<script src="/fixture-app.js"></script></body></html>`;
    const child=`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><video id="frame-video" loop muted playsinline preload="auto" src="/silent.wav" style="width:100%;height:100%"></video><script>${instrument}\ninstrumentMedia(document.getElementById('frame-video'));</script></body></html>`;
    await context.route('**/*',route=>{
        const request=route.request(),url=new URL(request.url());
        if(request.isNavigationRequest()){
            navigations.set(request.url(),(navigations.get(request.url())||0)+1);
            if(request.url()===siteUrl)return route.fulfill({contentType:'text/html',body:main});
            if(url.origin===modelFrameOrigin&&url.pathname==='/player')return route.fulfill({contentType:'text/html',body:child});
        }
        const scripts={'/instrument.js':instrument,'/channel-list.js':channelScript,'/stream-performance.js':performanceScript,'/player-geometry.js':geometryScript,'/player-layout.js':layoutScript,'/layout-bookmarks.js':bookmarkScript,'/stream-quality.js':qualityScript,'/fixture-app.js':fixtureScript};
        if(url.origin===new URL(siteUrl).origin&&scripts[url.pathname])return route.fulfill({contentType:'application/javascript; charset=utf-8',body:scripts[url.pathname]});
        if(url.pathname==='/silent.wav'&&[new URL(siteUrl).origin,modelFrameOrigin].includes(url.origin)){
            const range=/^bytes=(\d+)-(\d*)$/.exec(request.headers().range||'');const start=range?Number(range[1]):0;
            const end=range?.[2]?Math.min(Number(range[2]),wav.length-1):wav.length-1;
            return route.fulfill({status:range?206:200,contentType:'audio/wav',body:wav.subarray(start,end+1),headers:{'accept-ranges':'bytes',...(range?{'content-range':`bytes ${start}-${end}/${wav.length}`}:{})}});
        }
        blocked.push(request.url());return route.abort();
    });
    if(audioUserscript){
        const built=fs.readFileSync(path.join(root,'userscript/umininn-tv-player.user.js'),'utf8');
        assert.equal(built.match(/^\/\/ @version\s+(\S+)/m)?.[1],require('../tools/build-player-userscript.cjs').RELEASE_VERSION,'integrated userscript tests must use the newly built distribution');
        await context.addInitScript({content:`
            window.fixtureAudioMessages=[];window.fixtureAudioGate={hold:false,targetId:'frame-2',muted:null,firstDocumentOnly:false,documentId:null,held:[]};
            addEventListener('message',event=>{
                const data=event.data;if(!data||data.channel!=='umininn-tv-userscript')return;
                fixtureAudioMessages.push({type:data.type,result:data.result,command:data.command});
                if(window.top!==window||data.type!=='userscript:result'||!fixtureAudioGate.hold)return;
                if(typeof fixtureAudioGate.muted==='boolean'&&data.result?.state?.muted!==fixtureAudioGate.muted)return;
                const frame=document.getElementById(fixtureAudioGate.targetId);
                if(frame&&event.source===frame.contentWindow){
                    if(fixtureAudioGate.firstDocumentOnly){
                        if(fixtureAudioGate.documentId&&data.documentId!==fixtureAudioGate.documentId)return;
                        fixtureAudioGate.documentId=data.documentId;
                    }
                    event.stopImmediatePropagation();fixtureAudioGate.held.push({data,origin:event.origin,source:event.source});
                }
            },true);
            window.fixtureAudioRelease=function(){fixtureAudioGate.hold=false;return fixtureAudioGate.held.splice(0).map(message=>message.data)};
            addEventListener('DOMContentLoaded',()=>{\n${built}\n},{once:true});
        `});
    }
    const page=await context.newPage();page.setDefaultTimeout(8000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    if(clock)await page.clock.install({time:new Date('2026-10-20T04:00:00Z')});
    await page.goto(siteUrl,{waitUntil:'load'});
    try{await page.waitForFunction(()=>window.fixture?.keys.length===5&&fixtureMedia.every(saved=>saved.video.readyState>=2))}
    catch(error){console.error('Layout fixture diagnostic:',errors,await page.evaluate(()=>({keys:window.fixture?.keys,media:window.fixtureMedia?.map(saved=>({connected:saved.video.isConnected,state:saved.video.readyState,error:saved.video.error?.message,source:saved.video.currentSrc})),body:document.body.innerText.slice(0,150)})));throw error}
    const frames=page.frames().filter(frame=>frame.url().startsWith(modelFrameOrigin));assert.equal(frames.length,2);
    for(const frame of frames)await frame.waitForFunction(()=>fixtureMedia[0]?.video.readyState>=2);
    await page.evaluate(async()=>{for(const [index,saved]of fixtureMedia.entries()){saved.video.volume=.21+index*.1;saved.video.currentTime=.375;if(index===1){saved.video.muted=false;saved.video.pause()}else await saved.video.play()}});
    for(const [index,frame]of frames.entries())await frame.evaluate(async index=>{const video=fixtureMedia[0].video;video.volume=.33+index*.1;video.currentTime=.375;if(index===1){video.muted=false;video.pause()}else await video.play()},index);
    await page.waitForFunction(()=>fixture.identity().loads.every(count=>count===1));
    if(audioUserscript)await page.waitForFunction(()=>{
        const rows=document.getElementById('umininn-player-panel-host')?.shadowRoot.querySelectorAll('.player');
        return rows?.length===5&&Array.from(rows).every(row=>!row.querySelector('input').disabled);
    });
    if(clock)await page.clock.pauseAt(await page.evaluate(()=>Date.now()+100));
    return {page,frames,navigations,blocked,errors,clockInstalled:clock};
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
async function assertEditorUiClosed(f){
    assert.equal((await geometry(f)).opened,false);
    assert.equal(await f.page.locator('.player-position-toolbar').isVisible(),false);
    assert.equal(await f.page.locator('.player-position-name').first().isVisible(),false);
    assert.equal(await f.page.locator('#player-name-overlay').isVisible(),false);
}

test('both editor modes auto-complete only after a full idle interval following the last trusted click',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;
    for(const mode of ['move','enlarge'])await t.test(mode,async sub=>{
        const f=await fixture(sub,{width:1300,height:1000,clock:true}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys),duration=await editorTimeout(f);
        await f.page.locator(mode==='move'?'#adjust-player-positions':'#enlarge-player').click();
        const hint=await f.page.locator('.player-position-instructions').innerText();assert.match(hint,/30\s*秒/);assert.match(hint,/自動/);
        await f.page.clock.runFor(duration-1000);
        if(mode==='move'){await positionCell(f,keys[0]).click();await positionCell(f,keys[4]).click()}
        else{await positionCell(f,keys[0]).click();await waitSpan(f,keys[0],2)}
        const committed=await readLayout(f),savedOrder=await savedPositionOrder(f);
        await f.page.clock.runFor(duration-1);assert.equal((await geometry(f)).opened,true,'a click just before the original deadline starts a complete new idle interval');
        await f.page.clock.runFor(1);const completed=await readLayout(f);assert.equal(completed.state.opened,false);
        await assertEditorUiClosed(f);
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

test('editor auto-complete ignores hover, app refresh, resize and synthetic input without stealing external focus',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000,clock:true}),before=await snapshot(f),key=await f.page.evaluate(()=>fixture.keys[0]),duration=await editorTimeout(f);
    await f.page.locator('#enlarge-player').click();await positionCell(f,key).click();await waitSpan(f,key,2);
    await f.page.clock.runFor(duration/2);const point=await positionCell(f,key).boundingBox();await f.page.mouse.move(point.x+point.width/2,point.y+point.height/2,{steps:8});
    await f.page.evaluate(()=>{
        playerPositionEditor.refresh();fixture.resize(1200,850);const toolbar=document.querySelector('.player-position-toolbar');
        toolbar.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',bubbles:true}));
        toolbar.dispatchEvent(new PointerEvent('pointerdown',{pointerId:919,isPrimary:true,button:0,buttons:1,bubbles:true}));
        document.dispatchEvent(new PointerEvent('pointerup',{pointerId:919,isPrimary:true,button:0,buttons:0,bubbles:true}));
        document.querySelector('.player-position-toolbar-toggle').click();window.dispatchEvent(new Event('blur'));
    });await f.page.clock.runFor(250);
    const committed=await readLayout(f);await f.page.locator('#toggle-all-audio').focus();
    await f.page.clock.runFor(duration/2-251);assert.equal((await geometry(f)).opened,true);
    await f.page.clock.runFor(1);const completed=await readLayout(f);assert.equal(completed.state.opened,false);
    assert.deepEqual(completed.logical,committed.logical);assert.equal(completed.state.saved,committed.state.saved);
    assert.equal(await f.page.evaluate(()=>document.activeElement.id),'toggle-all-audio');await assertContinuity(f,before);
});

test('editor auto-complete stays open during trusted move and resize holds then starts idle time after release',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;
    for(const mode of ['move','enlarge'])await t.test(mode,async sub=>{
        const f=await fixture(sub,{width:1300,height:1000,clock:true}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys),duration=await editorTimeout(f);
        await f.page.locator(mode==='move'?'#adjust-player-positions':'#enlarge-player').click();
        if(mode==='enlarge'){await positionCell(f,keys[0]).click();await waitSpan(f,keys[0],2)}
        await f.page.clock.runFor(duration-500);const initial=await readLayout(f);
        if(mode==='move'){
            const source=await positionCell(f,keys[0]).boundingBox(),target=await positionCell(f,keys[4]).boundingBox();assert.ok(source&&target);
            await f.page.mouse.move(source.x+source.width/2,source.y+source.height/2);await f.page.mouse.down();
            await f.page.mouse.move(target.x+target.width/2,target.y+target.height/2,{steps:8});
            assert.equal(await f.page.locator('.position-dragging').count(),1);
        }else{
            const drag=await startCornerDrag(f,keys[0],'se');await moveCornerDrag(f,drag,1.1);await f.page.clock.runFor(32);await assertPreviewOnly(f,drag);
        }
        await f.page.clock.runFor(duration+1000);assert.equal((await geometry(f)).opened,true,'an active trusted pointer cannot expire while held');
        assert.deepEqual((await readLayout(f)).logical,initial.logical,'a long hold cannot commit before release');
        await f.page.mouse.up();await assertResizeIdle(f);const committed=await readLayout(f),savedOrder=await savedPositionOrder(f);
        assert.notDeepEqual(committed.logical,initial.logical,'releasing the held gesture commits once');
        if(mode==='enlarge')assert.equal(spans(committed.state)[keys[0]],3,'one pointer release cannot apply a second enlargement click');
        await f.page.clock.runFor(duration-1);assert.equal((await geometry(f)).opened,true);
        await f.page.clock.runFor(1);await assertEditorUiClosed(f);
        const completed=await readLayout(f);assert.deepEqual(completed.logical,committed.logical);assert.equal(completed.state.saved,committed.state.saved);assert.equal(await savedPositionOrder(f),savedOrder);
        await assertContinuity(f,before);
    });
});

test('editor inactivity is restarted by repeated trusted keys and toolbar actions',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;
    await t.test('repeated keyboard activity',async st=>{
        const f=await fixture(st,{width:1300,height:1000,clock:true}),before=await snapshot(f),key=await f.page.evaluate(()=>fixture.keys[0]),duration=await editorTimeout(f);
        await f.page.locator('#adjust-player-positions').click();
        for(let index=0;index<2;index++){
            await f.page.clock.runFor(duration-1000);await positionCell(f,key).press('ArrowRight');assert.equal((await geometry(f)).opened,true);
        }
        const committed=await readLayout(f);await f.page.clock.runFor(duration-1);assert.equal((await geometry(f)).opened,true);
        await f.page.clock.runFor(1);await assertEditorUiClosed(f);assert.deepEqual((await readLayout(f)).logical,committed.logical);await assertContinuity(f,before);
    });
    await t.test('toolbar position, shrink and reset controls',async st=>{
        const f=await fixture(st,{width:1300,height:1000,clock:true}),before=await snapshot(f),key=await f.page.evaluate(()=>fixture.keys[0]),duration=await editorTimeout(f);
        for(const selector of ['.player-position-toolbar-toggle','.player-position-shrink','.player-position-reset']){
            await f.page.locator('#enlarge-player').click();await positionCell(f,key).click();
            await f.page.clock.runFor(duration-1000);await f.page.locator(selector).click();const committed=await readLayout(f);
            await f.page.clock.runFor(duration-1);assert.equal((await geometry(f)).opened,true,selector+' restarts a full idle interval');
            await f.page.clock.runFor(1);await assertEditorUiClosed(f);assert.deepEqual((await readLayout(f)).logical,committed.logical);
        }
        await assertContinuity(f,before);
    });
});

test('editor inactivity recovers held gestures on blur, backgrounding and native pointer cancellation',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;
    for(const reason of ['blur','hidden'])await t.test(reason,async st=>{
        const f=await fixture(st,{width:1300,height:1000,clock:true}),before=await snapshot(f),key=await f.page.evaluate(()=>fixture.keys[0]),duration=await editorTimeout(f);
        await f.page.locator('#adjust-player-positions').click();const initial=await readLayout(f),box=await positionCell(f,key).boundingBox();
        await f.page.mouse.move(box.x+box.width/2,box.y+box.height/2);await f.page.mouse.down();await f.page.mouse.move(box.x+box.width/2+30,box.y+box.height/2+10);
        await f.page.clock.runFor(duration+1000);assert.equal((await geometry(f)).opened,true);
        await f.page.evaluate(reason=>{
            if(reason==='blur')window.dispatchEvent(new Event('blur'));
            else{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));
                delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))}
        },reason);
        await f.page.mouse.up();await assertResizeIdle(f);assert.deepEqual((await readLayout(f)).logical,initial.logical,'lifecycle interruption cancels the uncommitted gesture');
        await f.page.clock.runFor(duration-1);assert.equal((await geometry(f)).opened,true);
        await f.page.clock.runFor(1);await assertEditorUiClosed(f);await assertContinuity(f,before);
    });
    if(engine==='chromium')await t.test('trusted touch cancellation',async st=>{
        const f=await fixture(st,{width:1300,height:1000,clock:true,hasTouch:true}),before=await snapshot(f),key=await f.page.evaluate(()=>fixture.keys[0]),duration=await editorTimeout(f);
        await f.page.locator('#adjust-player-positions').click();const initial=await readLayout(f),box=await positionCell(f,key).boundingBox();
        const x=box.x+box.width/2,y=box.y+box.height/2,cdp=await f.page.context().newCDPSession(f.page);
        await f.page.evaluate(()=>{window.fixtureIdleTouchCancel=[];document.addEventListener('pointercancel',event=>fixtureIdleTouchCancel.push({trusted:event.isTrusted,type:event.pointerType}),true)});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x,y,radiusX:1,radiusY:1,force:1}]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:1,x:x+30,y:y+10,radiusX:1,radiusY:1,force:1}]});
        await f.page.clock.runFor(duration+1000);assert.equal((await geometry(f)).opened,true);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await cdp.detach();
        assert.ok((await f.page.evaluate(()=>fixtureIdleTouchCancel)).some(event=>event.trusted&&event.type==='touch'));
        await assertResizeIdle(f);assert.deepEqual((await readLayout(f)).logical,initial.logical);
        await f.page.clock.runFor(duration-1);assert.equal((await geometry(f)).opened,true);
        await f.page.clock.runFor(1);await assertEditorUiClosed(f);await assertContinuity(f,before);
    });
    if(engine==='chromium')await t.test('trusted no-buttons pointer move recovers a missed mouseup',async st=>{
        const f=await fixture(st,{width:1300,height:1000,clock:true}),before=await snapshot(f),key=await f.page.evaluate(()=>fixture.keys[0]),duration=await editorTimeout(f);
        await f.page.locator('#adjust-player-positions').click();const initial=await readLayout(f),box=await positionCell(f,key).boundingBox();
        const x=box.x+box.width/2,y=box.y+box.height/2;
        await f.page.mouse.move(x,y);await f.page.mouse.down();await f.page.mouse.move(x+30,y+10);
        assert.equal(await f.page.locator('.position-dragging').count(),1);await f.page.clock.runFor(duration+1000);assert.equal((await geometry(f)).opened,true);
        await f.page.evaluate(()=>{window.fixtureIdleMissedRelease=[];document.addEventListener('pointermove',event=>fixtureIdleMissedRelease.push({trusted:event.isTrusted,buttons:event.buttons}),true)});
        const cdp=await f.page.context().newCDPSession(f.page);
        await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+40,y:y+20,button:'none',buttons:0});await cdp.detach();
        assert.ok((await f.page.evaluate(()=>fixtureIdleMissedRelease)).some(event=>event.trusted&&event.buttons===0));
        await assertResizeIdle(f);await f.page.mouse.up();assert.deepEqual((await readLayout(f)).logical,initial.logical,'a missed release must cancel the ghost drag instead of committing later');
        await f.page.clock.runFor(duration-1);assert.equal((await geometry(f)).opened,true);
        await f.page.clock.runFor(1);await assertEditorUiClosed(f);await assertContinuity(f,before);
    });
});

test('editor inactivity cannot rearm after its held session closes when the selection becomes a single player',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000,clock:true}),keys=await f.page.evaluate(()=>fixture.keys),duration=await editorTimeout(f);
    await f.page.locator('#adjust-player-positions').click();const retained=await activeMediaSnapshot(f,[keys[0]],{remember:true}),box=await positionCell(f,keys[0]).boundingBox();
    await f.page.mouse.move(box.x+box.width/2,box.y+box.height/2);await f.page.mouse.down();
    await f.page.evaluate(keys=>{for(const key of keys.slice(1))closePlayer(key)},keys);await assertEditorUiClosed(f);await f.page.mouse.up();
    await f.page.clock.runFor(duration*2);await assertEditorUiClosed(f);
    assert.equal(await f.page.locator('#adjust-player-positions').isDisabled(),true);assert.equal(await f.page.locator('#enlarge-player').isDisabled(),true);await assertActiveContinuity(f,retained);
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

test('editor auto-complete honors the last idle deadline when foregrounding after a throttled timer',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000,clock:true}),before=await snapshot(f),duration=await editorTimeout(f);
    await f.page.locator('#adjust-player-positions').click();await f.page.clock.runFor(duration-1000);await f.page.keyboard.press('ArrowRight');const committed=await readLayout(f);
    await f.page.clock.setSystemTime(await f.page.evaluate(()=>Date.now())+duration-1);
    await f.page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));assert.equal((await geometry(f)).opened,true,'foregrounding before the last interaction deadline cannot use the stale entry deadline');
    await f.page.clock.setSystemTime(await f.page.evaluate(()=>Date.now())+1);
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
    if(f.clockInstalled)await f.page.clock.runFor(50);
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
function assertEditorPlacement(before,after,key,targetKey){
    const focus=before.layout.items.find(item=>item.key===key),target=before.layout.items.find(item=>item.key===targetKey);
    const expected={...focus,row:Math.max(0,Math.min(before.layout.rows-focus.span,target.row)),
        column:Math.max(0,Math.min(before.layout.columns-focus.span,target.column))};
    assert.deepEqual(after.layout.items.find(item=>item.key===key),expected,'a distant pointer target places the enlarged anchor at its bounded grid coordinates');
    assert.equal(after.layout.columns,before.layout.columns);assert.ok(after.layout.rows<=before.layout.rows,'placement cannot add tracks beyond the current grid');
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

async function editorStepGesture(f,source,target,direction,gesture){
    const sourceCell=positionCell(f,source),targetCell=positionCell(f,target);
    if(gesture==='key')await sourceCell.press('Arrow'+direction[0].toUpperCase()+direction.slice(1));
    else if(gesture==='click'){await sourceCell.click();await targetCell.click()}
    else{
        const from=await sourceCell.boundingBox(),to=await targetCell.boundingBox();assert.ok(from&&to);
        await f.page.mouse.move(from.x+from.width/2,from.y+from.height/2);await f.page.mouse.down();
        await f.page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:8});await f.page.mouse.up();
    }
}

test('editor step moves span-two and span-three players one cell with keys, every adjacent click and released drags from either side',{skip:!enabled,timeout:90000},async t=>{
    if(!optional(t))return;const inverse={up:'down',down:'up',left:'right',right:'left'};
    for(const span of [2,3])await t.test('span '+span,async st=>{
        const f=await fixture(st,{width:1500,height:1000,players:26-span*span}),keys=await f.page.evaluate(()=>getPlayerPositionKeys()),before=await snapshot(f);
        const key=keys[4],focus={key,row:1,column:1,span},grid={columns:5,focus,order:keys};
        for(const gesture of ['key','click','drag'])for(const direction of Object.keys(inverse)){
            await fixedDirectionGrid(f,grid);const targets=(await directionTargets(f,key))[direction];assert.equal(targets.length,span);
            const selected=gesture==='click'?targets:[targets[targets.length-1]];
            for(const target of selected){
                await fixedDirectionGrid(f,grid);const start=await geometry(f);await f.page.locator('#adjust-player-positions').click();
                await editorStepGesture(f,key,target,direction,gesture);const stepped=await geometry(f);assertDirectionStep(start,stepped,key,direction);
                assert.equal(stepped.opened,true);assert.equal(stepped.mode,'move');assertGeometry(stepped,{overlay:true});
                await f.page.keyboard.press('Escape');await waitWindowGeometry(f);
            }
            await fixedDirectionGrid(f,grid);const start=await geometry(f),small=targets[targets.length-1];
            await f.page.locator('#adjust-player-positions').click();await editorStepGesture(f,small,key,inverse[direction],gesture);
            const stepped=await geometry(f);assertDirectionStep(start,stepped,key,direction);assertGeometry(stepped,{overlay:true});
            await f.page.keyboard.press('Escape');await waitWindowGeometry(f);
        }
        await assertContinuity(f,before);
    });
});

test('editor step stops at boundaries and empty gaps while ordinary remote exchanges remain available',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800}),keys=await f.page.evaluate(()=>getPlayerPositionKeys()),before=await snapshot(f),key=keys[4];
    await fixedDirectionGrid(f,{columns:3,focus:{key,row:0,column:0,span:2},order:keys});
    await f.page.locator('#adjust-player-positions').click();let state=await readLayout(f);
    for(const arrow of ['ArrowUp','ArrowLeft']){await positionCell(f,key).press(arrow);assert.deepEqual((await readLayout(f)).logical,state.logical)}
    await positionCell(f,key).press('ArrowRight');assertDirectionStep(state.state,await geometry(f),key,'right');state=await readLayout(f);
    await positionCell(f,key).press('ArrowRight');assert.deepEqual((await readLayout(f)).logical,state.logical,'a key at the right edge cannot wrap or grow the grid');
    await f.page.keyboard.press('Escape');await waitWindowGeometry(f);
    await fixedDirectionGrid(f,{columns:6,focus:{key,row:2,column:2,span:2},order:keys});
    await f.page.locator('#adjust-player-positions').click();state=await readLayout(f);
    for(const arrow of ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight']){await positionCell(f,key).press(arrow);assert.deepEqual((await readLayout(f)).logical,state.logical,'a direction key cannot cross empty tracks to a distant tile')}
    await positionCell(f,keys[2]).press('ArrowDown');assert.deepEqual((await readLayout(f)).logical,state.logical,'a small source cannot pull an enlarged player across an empty row');
    await positionCell(f,key).click();await positionCell(f,keys[2]).click();assertEditorPlacement(state.state,await geometry(f),key,keys[2]);
    await f.page.keyboard.press('Escape');await waitWindowGeometry(f);await f.page.locator('#adjust-player-positions').click();
    const beforeOrdinary=await geometry(f);await positionCell(f,keys[0]).click();await positionCell(f,keys[3]).click();const ordinary=await geometry(f);
    assert.deepEqual(ordinary.layout.items.find(item=>item.key===keys[0]),{...beforeOrdinary.layout.items.find(item=>item.key===keys[3]),key:keys[0]});
    assert.deepEqual(ordinary.layout.items.find(item=>item.key===keys[3]),{...beforeOrdinary.layout.items.find(item=>item.key===keys[0]),key:keys[3]});
    assert.deepEqual(ordinary.layout.items.find(item=>item.key===key),beforeOrdinary.layout.items.find(item=>item.key===key));
    assertGeometry(ordinary,{overlay:true});await f.page.keyboard.press('Escape');await assertContinuity(f,before);
});

test('editor placement distinguishes adjacent one-cell moves from remote placement and clamps all four corners',{skip:!enabled,timeout:90000},async t=>{
    if(!optional(t))return;
    for(const [span,columns]of [[3,5],[2,4]])await t.test(`${span} by ${span} in ${columns} columns`,async st=>{
        const f=await fixture(st,{width:1500,height:1000,players:columns*columns-span*span+1}),keys=await f.page.evaluate(()=>getPlayerPositionKeys()),before=await snapshot(f),key=keys[4];
        const corner={columns,focus:{key,row:0,column:0,span},order:keys};
        for(const gesture of ['click','drag'])for(const reversed of [false,true])for(const adjacent of [true,false]){
            await fixedDirectionGrid(f,corner);const start=await geometry(f),column=adjacent?span:columns-1;
            const target=start.layout.items.find(item=>item.span===1&&item.row===0&&item.column===column).key;
            assert.equal((await directionTargets(f,key)).right.includes(target),adjacent);
            await f.page.locator('#adjust-player-positions').click();
            await editorStepGesture(f,reversed?target:key,reversed?key:target,'right',gesture);
            const moved=await geometry(f);
            if(adjacent)assertDirectionStep(start,moved,key,'right');
            else{assertEditorPlacement(start,moved,key,target);assert.equal(moved.layout.items.find(item=>item.key===key).column,2,'the far-right tile can move the anchor across two columns')}
            assertGeometry(moved,{overlay:true});assertFits(await f.page.evaluate(()=>fixture.grid()));
            await f.page.keyboard.press('Escape');await waitWindowGeometry(f);
        }
        const middle={columns,focus:{key,row:1,column:1,span},order:keys};
        for(const gesture of ['click','drag'])for(const reversed of [false,true])for(const [row,column]of [[0,0],[0,columns-1],[columns-1,0],[columns-1,columns-1]]){
            await fixedDirectionGrid(f,middle);const start=await geometry(f),target=start.layout.items.find(item=>item.span===1&&item.row===row&&item.column===column).key;
            const adjacent=Object.values(await directionTargets(f,key)).flat().includes(target);assert.equal(adjacent,false,'the requested corner is a remote destination');
            await f.page.locator('#adjust-player-positions').click();await editorStepGesture(f,reversed?target:key,reversed?key:target,'right',gesture);
            const moved=await geometry(f);assertEditorPlacement(start,moved,key,target);assertGeometry(moved,{overlay:true});assertFits(await f.page.evaluate(()=>fixture.grid()));
            await f.page.keyboard.press('Escape');await waitWindowGeometry(f);
        }
        await assertContinuity(f,before);
    });
});

test('editor step commits remain saved after Escape, the automatic deadline and reopening the page',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1500,height:1000,players:17,clock:true}),keys=await f.page.evaluate(()=>getPlayerPositionKeys()),before=await snapshot(f),key=keys[4];
    await fixedDirectionGrid(f,{columns:5,focus:{key,row:0,column:0,span:3},order:keys});
    let start=await geometry(f);const remote=start.layout.items.find(item=>item.row===0&&item.column===4).key;
    await f.page.locator('#adjust-player-positions').click();await positionCell(f,key).click();await positionCell(f,remote).click();
    const committed=await readLayout(f);assertEditorPlacement(start,committed.state,key,remote);const savedOrder=await savedPositionOrder(f),duration=await editorTimeout(f);
    await f.page.clock.runFor(duration-1);assert.equal((await geometry(f)).opened,true);
    await f.page.clock.runFor(1);assert.equal((await geometry(f)).opened,false);
    assert.deepEqual((await readLayout(f)).logical,committed.logical);assert.equal(await savedPositionOrder(f),savedOrder);
    start=await geometry(f);await f.page.locator('#adjust-player-positions').click();await positionCell(f,key).press('ArrowDown');
    const second=await readLayout(f);assertDirectionStep(start,second.state,key,'down');await f.page.keyboard.press('Escape');
    assert.equal((await geometry(f)).opened,false);assert.deepEqual((await readLayout(f)).logical,second.logical);
    const storage=await f.page.evaluate(()=>({playerPositionOrder:localStorage.getItem('playerPositionOrder'),playerEnlargementLayout:localStorage.getItem('playerEnlargementLayout')}));
    assert.deepEqual(JSON.parse(storage.playerEnlargementLayout).focus,{key,row:1,column:2,span:3});await assertContinuity(f,before);
    const reopened=await fixture(t,{width:1500,height:1000,players:17,storageSeed:storage});await waitWindowGeometry(reopened);
    assert.deepEqual((await readLayout(reopened)).logical,second.logical);assert.deepEqual(reopened.errors,[]);assert.deepEqual(reopened.blocked,[]);
});

// The audio-focus cases combine the actual website action with the built
// userscript. Every media element is real, including two different-origin
// documents; the model serves only local WAV bytes and never contacts a platform.
const audioPanel='#umininn-player-panel-host';
function audibleMedia(state){return [...state.main,...state.frames.flatMap(frame=>frame.media)]}
function audioStable(media){const {time,muted,volume,...rest}=media;return rest}
function assertOtherVolumes(before,after,target){
    const old=audibleMedia(before),now=audibleMedia(after);
    for(let index=0;index<now.length;index++)if(index!==target)assert.equal(now[index].volume,old[index].volume,'other players retain their volume level');
}
async function assertAudioContinuity(f,before,{allowPolicyPause=false}={}){
    const after=await snapshot(f),old=audibleMedia(before),now=audibleMedia(after);
    const comparable=media=>{const value=audioStable(media);if(allowPolicyPause)delete value.paused;return value};
    assert.deepEqual(now.map(comparable),old.map(comparable),'audio focus must not play, recover, pause, seek, load or replace a source');
    assert.deepEqual(after.frames.map(frame=>frame.id),before.frames.map(frame=>frame.id),'foreign documents retain identity');
    for(let index=0;index<now.length;index++)if(old[index].paused)assert.equal(now[index].time,old[index].time,'paused media stays at its manual position');
    assert.deepEqual(await f.page.evaluate(()=>fixture.identity()),{elements:true,entries:true,windows:true,removals:0,frameSources:0,loads:[1,1]});
    assert.ok([...f.navigations.values()].every(count=>count===1));assert.deepEqual(f.blocked,[]);assert.deepEqual(f.errors,[]);
    return after;
}
async function primeAudio(f){
    await f.page.evaluate(()=>{for(const saved of fixtureMedia)saved.video.muted=true});
    for(const frame of f.frames)await frame.evaluate(()=>{fixtureMedia[0].video.muted=true});
    await f.page.waitForFunction(()=>{
        const rows=document.getElementById('umininn-player-panel-host').shadowRoot.querySelectorAll('.player');
        return [...rows].every(row=>row.querySelector('button').getAttribute('aria-pressed')==='true');
    });
}
async function waitAudio(f,expected,{timeout=8000}={}){
    const deadline=Date.now()+timeout;let last;
    do{
        last=await snapshot(f);
        if(expected(audibleMedia(last)))return last;
        await f.page.waitForTimeout(60);
    }while(Date.now()<deadline);
    assert.fail('Audio state did not converge: '+JSON.stringify(last));
}
async function waitOnlyAudible(f,index,{volume=1,timeout=8000}={}){
    return waitAudio(f,media=>media.every((value,i)=>value.muted===(i!==index))&&media[index].volume===volume,{timeout});
}
async function waitFocusStatus(f,text){
    await f.page.waitForFunction(text=>{
        const status=document.getElementById('umininn-player-panel-host')?.shadowRoot.getElementById('audio-focus-status');
        return status&&!status.hidden&&status.textContent.includes(text);
    },text);
}
async function holdAudioReply(f,{muted=null,firstDocumentOnly=false}={}){
    await f.page.evaluate(({muted,firstDocumentOnly})=>{fixtureAudioGate.hold=true;fixtureAudioGate.muted=muted;fixtureAudioGate.firstDocumentOnly=firstDocumentOnly;fixtureAudioGate.documentId=null},{muted,firstDocumentOnly});
}
async function waitHeldAudioReply(f){await f.page.waitForFunction(()=>fixtureAudioGate.held.length>0)}
async function releaseAudioReply(f){
    const messages=await f.page.evaluate(()=>fixtureAudioRelease());assert.ok(messages.length>0,'the controlled real command must have reached its reply');
    // Replay through the original source document, preserving actual browser
    // origin/source validation in Firefox as well as Chromium. No MessageEvent
    // constructor or production transport callback is used to bypass validation.
    await f.frames[0].evaluate(({messages,origin})=>{for(const data of messages)window.top.postMessage(data,origin)},{messages,origin:new URL(siteUrl).origin});
}
async function openAudioPanel(f){
    const toggle=f.page.locator('#umininn-player-control-host #toggle');
    if(!await f.page.locator(audioPanel+' #panel').isVisible())await toggle.click();
}
async function actualMouseWindowAction(f,key,action){
    const button=windowCell(f,key).locator(`button[data-player-action="${action}"]`);
    // Focusing first exposes the parent overlay above an OOPIF. The subsequent
    // down/up are real trusted mouse input and execute the production handler.
    await f.page.keyboard.press('Tab');await button.focus();await button.hover();await button.click();
}

test('audio focus is emitted only by a successful right-top enlarge on its current direct player',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800}),keys=await f.page.evaluate(()=>fixture.keys),before=await snapshot(f);
    await f.page.evaluate(()=>{window.fixtureFocusEvents=[];document.addEventListener('umininn-player-audio-focus',event=>fixtureFocusEvents.push({id:event.target.id,direct:event.target.parentElement.id==='multi-stream-container',bubbles:event.bubbles}))});
    await clickWindowAction(f,keys[0],'enlarge');await waitSpan(f,keys[0],2);
    await clickWindowAction(f,keys[2],'enlarge');await waitSpan(f,keys[2],2);
    assert.deepEqual(await f.page.evaluate(()=>fixtureFocusEvents),[{id:'native-0',direct:true,bubbles:true},{id:'frame-2',direct:true,bubbles:true}]);
    await clickWindowAction(f,keys[2],'shrink');await waitSingleCells(f);
    await f.page.locator('#enlarge-player').click();await positionCell(f,keys[1]).click();await waitSpan(f,keys[1],2);
    const drag=await startCornerDrag(f,keys[1],'se');await moveCornerDrag(f,drag,1.05);await f.page.mouse.up();await f.page.keyboard.press('Escape');
    assert.equal(await f.page.evaluate(()=>fixtureFocusEvents.length),2,'editor click, corner resize and shrink do not request audio focus');
    await assertContinuity(f,before);
    await f.page.evaluate(keys=>{for(const key of keys.slice(1))closePlayer(key)},keys);await waitWindowGeometry(f);
    const disabled=windowCell(f,keys[0]).locator('[data-player-action="enlarge"]');assert.equal(await disabled.isDisabled(),true);
    await disabled.evaluate(button=>button.click());assert.equal(await f.page.evaluate(()=>fixtureFocusEvents.length),2,'a disabled native button cannot emit focus');
});

test('audio focus from real enlarge controls makes only native, foreign and wrapped targets audible without starting paused media',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,audioUserscript:true}),keys=await f.page.evaluate(()=>fixture.keys);
    await primeAudio(f);await f.page.evaluate(()=>{fixtureMedia[0].video.volume=0});
    const before=await snapshot(f);
    await actualMouseWindowAction(f,keys[0],'enlarge');const native=await waitOnlyAudible(f,0);await waitFocusStatus(f,'只開啟');assertOtherVolumes(before,native,0);
    assert.equal((await snapshot(f)).main[0].paused,false);
    await f.page.evaluate(()=>document.querySelector('#wrapped-native-4 video').dispatchEvent(new Event('umininn-player-audio-focus',{bubbles:true})));
    await f.page.waitForTimeout(160);await waitOnlyAudible(f,0);
    await f.frames[1].evaluate(()=>{fixtureMedia[0].video.volume=0});
    const beforeForeign=await snapshot(f);await actualMouseWindowAction(f,keys[3],'enlarge');const changedForeign=await waitOnlyAudible(f,4);await waitFocusStatus(f,'只開啟');assertOtherVolumes(beforeForeign,changedForeign,4);
    const foreign=await snapshot(f);assert.equal(foreign.frames[1].media[0].paused,true,'audio selection does not resume a manually paused foreign player');
    const beforeWrapped=await snapshot(f);await actualMouseWindowAction(f,keys[4],'enlarge');const wrapped=await waitOnlyAudible(f,2);assertOtherVolumes(beforeWrapped,wrapped,2);
    assert.equal((await snapshot(f)).main[2].volume,1,'the enlarged target is set to the requested 100 percent');
    await assertAudioContinuity(f,before);
});

test('audio focus waits for an existing command and the newest enlarged target wins delayed foreign replies',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,audioUserscript:true}),keys=await f.page.evaluate(()=>fixture.keys);
    await primeAudio(f);await openAudioPanel(f);await holdAudioReply(f);
    await f.page.locator(audioPanel+' .player').nth(2).locator('button').first().click();await waitHeldAudioReply(f);
    const before=await snapshot(f);await actualMouseWindowAction(f,keys[0],'enlarge');
    await waitFocusStatus(f,'正在');await f.page.waitForTimeout(160);assert.equal((await snapshot(f)).main[0].muted,true,'busy commands cannot bypass the all-muted barrier');
    await releaseAudioReply(f);await waitOnlyAudible(f,0);
    await holdAudioReply(f);await actualMouseWindowAction(f,keys[0],'enlarge');await waitHeldAudioReply(f);
    await actualMouseWindowAction(f,keys[4],'enlarge');assert.equal((await snapshot(f)).main[2].muted,true);
    await releaseAudioReply(f);await waitOnlyAudible(f,2);await waitFocusStatus(f,'只開啟');await f.page.waitForTimeout(200);
    await waitOnlyAudible(f,2);await assertAudioContinuity(f,before);
});

test('audio focus silences ready audible peers before an unrelated busy frame reply completes',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,audioUserscript:true}),keys=await f.page.evaluate(()=>fixture.keys);
    await primeAudio(f);await openAudioPanel(f);
    await f.page.evaluate(()=>{for(const saved of fixtureMedia)saved.video.muted=false});
    for(const frame of f.frames)await frame.evaluate(()=>{fixtureMedia[0].video.muted=false});
    await waitAudio(f,media=>media.every(value=>!value.muted));
    await f.page.waitForFunction(()=>[...document.getElementById('umininn-player-panel-host').shadowRoot.querySelectorAll('.player')]
        .every(row=>row.querySelector('button').getAttribute('aria-pressed')==='false'));
    await holdAudioReply(f);
    // This user's earlier command has already reached the media, but its real
    // cross-origin reply remains delayed. It must not delay muting ready peers.
    await f.page.locator(audioPanel+' .player').nth(2).locator('button').first().click();await waitHeldAudioReply(f);
    const before=await snapshot(f);await actualMouseWindowAction(f,keys[0],'enlarge');
    await waitAudio(f,media=>media.every(value=>value.muted),{timeout:1500});
    assert.ok(await f.page.evaluate(()=>fixtureAudioGate.hold&&fixtureAudioGate.held.length>0),'ready peers must mute while the unrelated reply is still held');
    await releaseAudioReply(f);await waitOnlyAudible(f,0);await waitFocusStatus(f,'只開啟');
    await assertAudioContinuity(f,before);
});

test('audio focus repairs platform sound resets after acknowledgement and yields to explicit row sound control',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,audioUserscript:true}),keys=await f.page.evaluate(()=>fixture.keys);
    await primeAudio(f);const before=await snapshot(f);
    await actualMouseWindowAction(f,keys[0],'enlarge');await waitOnlyAudible(f,0);await waitFocusStatus(f,'只開啟');
    // A platform may reset mute during an ad/media transition after it has
    // acknowledged our command. These are real native volumechange events.
    await f.frames[0].evaluate(()=>{fixtureMedia[0].video.muted=false});
    await waitOnlyAudible(f,0,{timeout:1500});
    await f.page.evaluate(()=>{fixtureMedia[2].video.muted=false});
    await waitOnlyAudible(f,0,{timeout:1500});
    await openAudioPanel(f);await f.page.locator(audioPanel+' .player').nth(1).locator('button').first().click();
    await waitAudio(f,media=>!media[0].muted&&!media[1].muted&&media.slice(2).every(value=>value.muted));
    await f.page.waitForTimeout(1200);
    assert.equal((await snapshot(f)).main[1].muted,false,'explicit row opening must cancel automatic focus enforcement');
    await assertAudioContinuity(f,before);
});

test('audio focus bounds repeated platform unmute repairs and becomes idle after the platform stops',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,audioUserscript:true}),keys=await f.page.evaluate(()=>fixture.keys);
    await primeAudio(f);const before=await snapshot(f);
    await f.frames[0].evaluate(()=>{
        const video=fixtureMedia[0].video,descriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'muted');
        window.fixtureMuteWrites=0;window.fixturePlatformUnmutes=0;
        Object.defineProperty(video,'muted',{get(){return descriptor.get.call(this)},set(value){if(value)fixtureMuteWrites++;descriptor.set.call(this,value)}});
    });
    await f.page.evaluate(()=>{
        const video=fixtureMedia[0].video,descriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'muted');
        window.fixtureTargetMuteWrites=0;window.fixtureFocusStatusWrites=0;
        Object.defineProperty(video,'muted',{get(){return descriptor.get.call(this)},set(value){fixtureTargetMuteWrites++;descriptor.set.call(this,value)}});
        const status=document.getElementById('umininn-player-panel-host').shadowRoot.getElementById('audio-focus-status');
        new MutationObserver(records=>{fixtureFocusStatusWrites+=records.length}).observe(status,{childList:true,subtree:true,characterData:true});
    });
    await actualMouseWindowAction(f,keys[0],'enlarge');await waitOnlyAudible(f,0);await waitFocusStatus(f,'只開啟');
    await f.frames[0].evaluate(()=>new Promise(resolve=>{
        const timer=setInterval(()=>{
            fixtureMedia[0].video.muted=false;fixturePlatformUnmutes++;
            if(fixturePlatformUnmutes===32){clearInterval(timer);resolve()}
        },80);
    }));
    await f.page.waitForTimeout(400);
    const counts=async()=>({...await f.frames[0].evaluate(()=>({writes:fixtureMuteWrites,attempts:fixturePlatformUnmutes,
        commands:fixtureAudioMessages.filter(message=>message.type==='userscript:command'&&message.command?.action==='setMuted'&&message.command.guard===true).length})),
        ...await f.page.evaluate(()=>({targetWrites:fixtureTargetMuteWrites,statusWrites:fixtureFocusStatusWrites}))});
    const settled=await counts();assert.equal(settled.attempts,32);
    assert.ok(settled.writes<=20,'repeated platform resets must not bypass the media repair budget: '+JSON.stringify(settled));
    assert.ok(settled.commands<=6,'site reconciliation must not repeatedly rearm a refused media guard: '+JSON.stringify(settled));
    await f.page.waitForTimeout(1200);assert.deepEqual(await counts(),settled,'no repair commands or property writes continue after the source becomes idle');
    const after=await snapshot(f);
    if(!after.frames[0].media[0].muted){
        assert.equal(after.main[0].muted,true,'a persistently audible peer must close the enlarged target sound');
        await waitFocusStatus(f,'未開啟');
    }
    await assertAudioContinuity(f,before);
});

test('audio focus mutes secondary hidden audio in the same foreign player document',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,audioUserscript:true}),keys=await f.page.evaluate(()=>fixture.keys);
    await primeAudio(f);
    await f.frames[0].evaluate(async()=>{
        const audio=document.createElement('audio');audio.id='secondary-player-audio';audio.loop=true;audio.muted=false;audio.volume=.62;
        audio.src='/silent.wav?secondary-player-audio=1';audio.style.display='none';instrumentMedia(audio);document.body.appendChild(audio);
        await audio.play();
    });
    const before=await snapshot(f);assert.equal(before.frames[0].media[1].muted,false);assert.equal(before.frames[0].media[1].paused,false);
    await actualMouseWindowAction(f,keys[0],'enlarge');await waitOnlyAudible(f,0);await waitFocusStatus(f,'只開啟');
    await assertAudioContinuity(f,before);
});

test('audio focus carries silence to late hidden audio and an ad video replacement without reloading the frame',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,audioUserscript:true}),keys=await f.page.evaluate(()=>fixture.keys);
    await primeAudio(f);await actualMouseWindowAction(f,keys[0],'enlarge');await waitOnlyAudible(f,0);await waitFocusStatus(f,'只開啟');
    const before=await snapshot(f);
    await f.frames[0].evaluate(async()=>{
        const audio=document.createElement('audio');audio.id='late-ad-audio';audio.loop=true;audio.muted=false;audio.volume=.57;
        audio.src='/silent.wav?late-ad-audio=1';audio.style.display='none';instrumentMedia(audio);document.body.appendChild(audio);await audio.play();
        document.getElementById('frame-video').remove();
    });
    await waitOnlyAudible(f,0,{timeout:1500});
    assert.equal((await snapshot(f)).frames[0].media[1].muted,true,'hidden ad audio must be silenced even while no visible video can be selected');
    await f.frames[0].evaluate(async()=>{
        const replacement=document.createElement('video');replacement.id='replacement-ad-video';
        replacement.loop=true;replacement.playsInline=true;replacement.muted=false;replacement.volume=.68;
        replacement.src='/silent.wav?replacement-ad-video=1';replacement.style.cssText='width:100%;height:100%';instrumentMedia(replacement);
        document.body.appendChild(replacement);await replacement.play();
    });
    await waitOnlyAudible(f,0,{timeout:1500});
    const after=await snapshot(f);
    assert.deepEqual(after.main.map(audioStable),before.main.map(audioStable),'unrelated main players retain playback and identity');
    assert.deepEqual(after.frames[1].media.map(audioStable),before.frames[1].media.map(audioStable));
    assert.deepEqual(after.frames.map(frame=>frame.id),before.frames.map(frame=>frame.id),'an ad node replacement keeps the original iframe documents');
    assert.equal(after.frames[0].media[0].same,false,'the fixture really replaced its original video');
    for(const media of after.frames[0].media.slice(1)){
        assert.equal(media.same,true);assert.equal(media.paused,false);assert.equal(media.muted,true);
        assert.deepEqual(media.actions,{play:1,pause:0,load:0,seek:0,source:0},'only the fixture starts each newly created ad source; focus must only mute it');
    }
    assert.deepEqual(await f.page.evaluate(()=>fixture.identity()),{elements:true,entries:true,windows:true,removals:0,frameSources:0,loads:[1,1]});
    assert.ok([...f.navigations.values()].every(count=>count===1));assert.deepEqual(f.blocked,[]);assert.deepEqual(f.errors,[]);
});

test('audio focus closes the old target during a delayed unmute acknowledgement before switching targets',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,audioUserscript:true}),keys=await f.page.evaluate(()=>fixture.keys);
    await primeAudio(f);const before=await snapshot(f);await holdAudioReply(f,{muted:false});
    await actualMouseWindowAction(f,keys[2],'enlarge');await waitHeldAudioReply(f);
    assert.equal((await snapshot(f)).frames[0].media[0].muted,false,'the previous target has actually opened sound before its acknowledgement is delivered');
    await actualMouseWindowAction(f,keys[4],'enlarge');
    await waitAudio(f,media=>media.every((value,index)=>index===2||value.muted),{timeout:1500});
    assert.ok(await f.page.evaluate(()=>fixtureAudioGate.hold&&fixtureAudioGate.held.length>0),'the old target must close while its earlier unmute acknowledgement remains delayed');
    await releaseAudioReply(f);await waitOnlyAudible(f,2);await waitFocusStatus(f,'只開啟');await f.page.waitForTimeout(300);
    await waitOnlyAudible(f,2);await assertAudioContinuity(f,before);
});

test('audio focus reconnects a peer iframe document while its earlier command acknowledgement is delayed',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,audioUserscript:true}),keys=await f.page.evaluate(()=>fixture.keys);
    await primeAudio(f);const before=await snapshot(f);await holdAudioReply(f,{firstDocumentOnly:true});
    await actualMouseWindowAction(f,keys[0],'enlarge');await waitHeldAudioReply(f);
    await f.frames[0].goto(f.frames[0].url(),{waitUntil:'load'});
    await f.frames[0].waitForFunction(()=>fixtureMedia[0].video.readyState>=2);
    await f.frames[0].evaluate(async()=>{const video=fixtureMedia[0].video;video.muted=false;video.volume=.39;await video.play()});
    await waitOnlyAudible(f,0);await waitFocusStatus(f,'只開啟');
    assert.ok(await f.page.evaluate(()=>fixtureAudioGate.hold&&fixtureAudioGate.held.length>0),'a renewed document must be controllable while the old document acknowledgement remains held');
    await releaseAudioReply(f);await f.page.waitForTimeout(300);await waitOnlyAudible(f,0);
    const after=await snapshot(f);
    assert.notEqual(after.frames[0].id,before.frames[0].id,'the fixture really renewed its foreign document');
    assert.equal(after.frames[1].id,before.frames[1].id);assert.deepEqual(after.main.map(audioStable),before.main.map(audioStable));
    assert.deepEqual(after.frames[1].media.map(audioStable),before.frames[1].media.map(audioStable));
    assert.deepEqual(after.frames[0].media[0].actions,{play:1,pause:0,load:0,seek:0,source:0},'only the new platform fixture starts the replacement document video');
    assert.deepEqual(await f.page.evaluate(()=>fixture.identity()),{elements:true,entries:true,windows:true,removals:0,frameSources:0,loads:[2,1]});
    assert.deepEqual(f.blocked,[]);assert.deepEqual(f.errors,[]);
});

test('audio focus yields after a trusted sound-control click inside a foreign player',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,audioUserscript:true}),keys=await f.page.evaluate(()=>fixture.keys);
    await primeAudio(f);const before=await snapshot(f);
    await actualMouseWindowAction(f,keys[0],'enlarge');await waitOnlyAudible(f,0);await waitFocusStatus(f,'只開啟');
    await f.frames[0].evaluate(()=>{
        window.fixtureManualSoundTrusted=false;window.fixtureManualSoundInputs=[];
        for(const type of ['pointerdown','click'])document.addEventListener(type,event=>fixtureManualSoundInputs.push({type:event.type,trusted:event.isTrusted,target:event.target.id}),true);
        const button=document.createElement('button');button.id='fixture-native-unmute';button.textContent='Fixture player unmute';
        button.style.cssText='position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:150px;height:32px;z-index:100';
        button.addEventListener('pointerdown',event=>{window.fixtureManualSoundTrusted=event.isTrusted});
        button.addEventListener('click',()=>{fixtureMedia[0].video.muted=false});document.body.appendChild(button);
    });
    // Let the newly enlarged layout reach the compositor before targeting an
    // out-of-process iframe; its local hit test alone can still be one frame old.
    await f.page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const nativeUnmute=f.frames[0].locator('#fixture-native-unmute');
    await nativeUnmute.focus();await nativeUnmute.hover();await nativeUnmute.click({delay:40});
    try{await f.frames[0].waitForFunction(()=>fixtureManualSoundTrusted===true,null,{timeout:1500})}
    catch(error){console.error('Foreign trusted-input diagnostic:',await f.frames[0].evaluate(()=>({events:fixtureManualSoundInputs,flag:fixtureManualSoundTrusted,button:document.getElementById('fixture-native-unmute')?.getBoundingClientRect().toJSON(),center:document.elementFromPoint(innerWidth/2,innerHeight/2)?.outerHTML,viewport:{width:innerWidth,height:innerHeight}})));throw error}
    assert.equal(await f.frames[0].evaluate(()=>fixtureManualSoundTrusted),true,'the override is a real browser input inside the foreign document');
    await waitAudio(f,media=>!media[0].muted&&!media[3].muted&&media.filter((_,index)=>![0,3].includes(index)).every(value=>value.muted));
    await f.page.waitForTimeout(1200);assert.equal((await snapshot(f)).frames[0].media[0].muted,false,'an explicit inner-player sound command must remain respected');
    await assertAudioContinuity(f,before);
});

test('audio focus pending work yields to explicit global and per-player sound controls',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;
    for(const kind of ['global','per-player'])await t.test(kind,async st=>{
        const f=await fixture(st,{width:1200,height:800,audioUserscript:true}),keys=await f.page.evaluate(()=>fixture.keys);
        await primeAudio(f);await openAudioPanel(f);const before=await snapshot(f);
        await holdAudioReply(f);await actualMouseWindowAction(f,keys[0],'enlarge');await waitHeldAudioReply(f);
        if(kind==='global')await f.page.locator('#toggle-all-audio').click();
        else await f.page.locator(audioPanel+' .player').nth(1).locator('button').first().click();
        await releaseAudioReply(f);
        if(kind==='global')await waitAudio(f,media=>media.every(value=>!value.muted));else await waitOnlyAudible(f,1,{volume:before.main[1].volume});
        await f.page.waitForTimeout(200);
        assert.equal(await f.page.locator(audioPanel+' #audio-focus-status').isVisible(),false,'explicit audio controls cancel the pending focus status');
        await assertAudioContinuity(f,before);
    });
});

test('audio focus fails closed after a refused mute and never unmutes a removed target or its same-id replacement',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;
    await t.test('foreign mute failure',async st=>{
        const f=await fixture(st,{width:1200,height:800,audioUserscript:true}),keys=await f.page.evaluate(()=>fixture.keys);
        await primeAudio(f);
        await f.frames[0].evaluate(()=>{
            const video=fixtureMedia[0].video,descriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'muted');video.muted=false;
            Object.defineProperty(video,'muted',{get(){return descriptor.get.call(this)},set(value){if(value)throw new DOMException('Fixture refuses mute','NotSupportedError');descriptor.set.call(this,value)}});
        });
        const before=await snapshot(f);await actualMouseWindowAction(f,keys[0],'enlarge');await waitFocusStatus(f,'未開啟');
        const media=audibleMedia(await snapshot(f));assert.equal(media[0].muted,true);assert.equal(media[3].muted,false);
        await assertAudioContinuity(f,before);
    });
    await t.test('refused target volume stays muted',async st=>{
        const f=await fixture(st,{width:1200,height:800,audioUserscript:true}),keys=await f.page.evaluate(()=>fixture.keys);
        await primeAudio(f);const before=await snapshot(f);
        await f.page.evaluate(()=>{
            const video=fixtureMedia[0].video,descriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'volume');
            Object.defineProperty(video,'volume',{get(){return descriptor.get.call(this)},set(){throw new DOMException('Fixture refuses volume','NotSupportedError')}});
        });
        await actualMouseWindowAction(f,keys[0],'enlarge');await waitFocusStatus(f,'未開啟');
        assert.ok(audibleMedia(await snapshot(f)).every(media=>media.muted),'an unconfirmed 100 percent volume cannot proceed to unmute');
        await assertAudioContinuity(f,before);
    });
    await t.test('unknown direct pane blocks opening target',async st=>{
        const f=await fixture(st,{width:1200,height:800,audioUserscript:true}),keys=await f.page.evaluate(()=>fixture.keys);
        await primeAudio(f);const before=await snapshot(f);
        await f.page.evaluate(()=>{const unknown=document.createElement('div');unknown.id='unknown-audio-pane';document.getElementById('multi-stream-container').appendChild(unknown)});
        await actualMouseWindowAction(f,keys[0],'enlarge');await waitFocusStatus(f,'未開啟');
        assert.ok(audibleMedia(await snapshot(f)).every(media=>media.muted),'unknown panes cannot be counted as successfully muted');
        await f.page.evaluate(()=>document.getElementById('unknown-audio-pane').remove());await assertAudioContinuity(f,before);
    });
    await t.test('removed and replaced target',async st=>{
        const f=await fixture(st,{width:1200,height:800,audioUserscript:true}),keys=await f.page.evaluate(()=>fixture.keys);
        await primeAudio(f);await holdAudioReply(f);await actualMouseWindowAction(f,keys[0],'enlarge');await waitHeldAudioReply(f);
        const retained=await activeMediaSnapshot(f,keys.slice(1),{remember:true});
        await f.page.evaluate(key=>{
            closePlayer(key);const replacement=document.createElement('video');replacement.id='native-0';replacement.muted=true;
            replacement.src='/silent.wav?replacement=1';document.getElementById('multi-stream-container').appendChild(replacement);window.fixtureAudioReplacement=replacement;
        },keys[0]);
        await releaseAudioReply(f);await waitFocusStatus(f,'已移除');await f.page.waitForTimeout(200);
        assert.equal(await f.page.evaluate(()=>fixtureAudioReplacement.muted),true,'same DOM id cannot inherit the removed target request');
        const after=await activeMediaSnapshot(f,keys.slice(1)),strip=entry=>{const {muted,...rest}=entry;return {...rest,media:entry.media&&audioStable(entry.media),child:entry.child&&{...entry.child,media:entry.child.media.map(audioStable)}}};
        assert.deepEqual(after.map(strip),retained.map(strip));
        assert.ok(after.every(entry=>entry.media?entry.media.muted:entry.child.media[0].muted),'surviving players remain muted after cancellation');
        assert.deepEqual(f.errors,[]);assert.deepEqual(f.blocked,[]);assert.ok([...f.navigations.values()].every(count=>count===1));
    });
});

test('audio focus waits for a late iframe navigation before opening the enlarged target',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;
    const f=await fixture(t,{width:1200,height:800,audioUserscript:true}),keys=await f.page.evaluate(()=>fixture.keys);
    await primeAudio(f);const before=await snapshot(f);
    const url='https://player.kick.com/player?index=late';
    let release,requested;
    const held=new Promise(resolve=>{release=resolve}),navigation=new Promise(resolve=>{requested=resolve});
    // Hold the actual HTTP navigation, not an ACK or a mocked readiness flag.
    // The normal fixture route still serves the document and real media bytes.
    await f.page.context().route(url,async route=>{requested();await held;await route.fallback()});
    try{
        await f.page.evaluate(url=>{
            const pane=document.getElementById('multi-stream-container'),frame=document.createElement('iframe');
            frame.id='late-player';frame.className='video';frame.src=url;frame.allow='autoplay';pane.appendChild(frame);
            const video=fixtureMedia[0].video,descriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'muted');
            window.fixtureTargetUnmutes=0;
            Object.defineProperty(video,'muted',{get(){return descriptor.get.call(this)},set(value){if(!value)fixtureTargetUnmutes++;descriptor.set.call(this,value)}});
        },url);
        await navigation;
        await actualMouseWindowAction(f,keys[0],'enlarge');await waitFocusStatus(f,'正在');
        await f.page.waitForTimeout(250);
        assert.equal(await f.page.evaluate(()=>fixtureTargetUnmutes),0,'an unconnected peer cannot be counted as confirmed silent');
        assert.ok(audibleMedia(await snapshot(f)).every(media=>media.muted));
        release();
        await f.page.waitForFunction(()=>document.getElementById('umininn-player-panel-host').shadowRoot.querySelectorAll('.player').length===6);
        const late=f.page.frames().find(frame=>frame.url()===url)||await f.page.waitForEvent('framenavigated',{predicate:frame=>frame.url()===url});
        await late.waitForFunction(()=>window.fixtureMedia?.[0]?.video.readyState>=2);
        await waitOnlyAudible(f,0);await waitFocusStatus(f,'只開啟');
        assert.equal(await late.evaluate(()=>fixtureMedia[0].video.muted),true);
        // The newly connected peer must join the guard as well as the barrier.
        await late.evaluate(()=>{fixtureMedia[0].video.muted=false});
        await late.waitForFunction(()=>fixtureMedia[0].video.muted);
        assert.deepEqual(await late.evaluate(()=>fixtureMedia[0].actions),{play:0,pause:0,load:0,seek:0,source:0});
        assert.equal(f.navigations.get(url),1,'the late peer is not reloaded to obtain control');
        await assertAudioContinuity(f,before);
    }finally{release()}
});

test('audio focus supersedes real bookmark recovery queued behind a delayed acknowledgement',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;
    const f=await fixture(t,{width:1200,height:800,audioUserscript:true}),keys=await f.page.evaluate(()=>fixture.keys);
    await primeAudio(f);const before=await snapshot(f),bookmark=await f.page.evaluate(()=>capturePlayerBookmark());
    await holdAudioReply(f,{muted:false});
    await actualMouseWindowAction(f,keys[2],'enlarge');await waitHeldAudioReply(f);
    assert.equal((await snapshot(f)).frames[0].media[0].muted,false,'the old target has opened sound but its real ACK is held');
    await f.page.evaluate(bookmark=>applyPlayerBookmark(bookmark),bookmark);
    await f.page.waitForTimeout(100); // let the production bookmark task start waiting
    for(const frame of f.frames)assert.equal(await frame.evaluate(()=>fixtureAudioMessages.some(message=>message.command?.action==='recover')),false);
    await actualMouseWindowAction(f,keys[4],'enlarge');
    await releaseAudioReply(f);await waitOnlyAudible(f,2);await waitFocusStatus(f,'只開啟');
    await f.page.waitForTimeout(700);
    await waitOnlyAudible(f,2);
    // Real recovery would play the two deliberately paused sources. They must
    // retain identity, pause state and play counters when the newer focus wins.
    await assertAudioContinuity(f,before);
    for(const frame of f.frames)assert.equal(await frame.evaluate(()=>fixtureAudioMessages.some(message=>message.command?.action==='recover')),false);
});

test('audio focus yields to real bookmark recovery without a late unmute',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;
    const f=await fixture(t,{width:1200,height:800,audioUserscript:true}),keys=await f.page.evaluate(()=>fixture.keys);
    await primeAudio(f);const before=await snapshot(f),bookmark=await f.page.evaluate(()=>capturePlayerBookmark());
    await holdAudioReply(f,{muted:true});
    await actualMouseWindowAction(f,keys[0],'enlarge');await waitHeldAudioReply(f);
    await f.page.evaluate(bookmark=>{for(let i=0;i<3;i++)applyPlayerBookmark(bookmark)},bookmark);
    await f.page.waitForTimeout(100);
    assert.deepEqual(audibleMedia(await snapshot(f)).map(media=>media.actions),audibleMedia(before).map(media=>media.actions),'recovery waits for the pending audio command');
    await releaseAudioReply(f);
    await waitAudio(f,media=>media.every(value=>!value.paused&&value.muted));
    await f.page.waitForFunction(()=>document.getElementById('umininn-player-panel-host').shadowRoot.getElementById('recovery-status').textContent.includes('2 台已恢復'));
    await f.page.waitForTimeout(700);
    const after=await snapshot(f),old=audibleMedia(before),now=audibleMedia(after);
    for(let index=0;index<now.length;index++){
        assert.equal(now[index].muted,true,'cancelled focus cannot open sound after recovery');
        assert.equal(now[index].volume,old[index].volume);
        assert.equal(now[index].source,old[index].source);
        assert.deepEqual(now[index].actions,{...old[index].actions,play:old[index].actions.play+(old[index].paused?1:0)},'each paused source resumes once despite three restores');
    }
    assert.deepEqual(after.frames.map(frame=>frame.id),before.frames.map(frame=>frame.id));
    assert.deepEqual(await f.page.evaluate(()=>fixture.identity()),{elements:true,entries:true,windows:true,removals:0,frameSources:0,loads:[1,1]});
    assert.ok([...f.navigations.values()].every(count=>count===1));assert.deepEqual(f.errors,[]);assert.deepEqual(f.blocked,[]);
});

test('audio focus default autoplay policy receives actual mouse enlargement without script play or recovery calls',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;
    const policyBrowser=await playwrightRuntime[engine].launch({headless:true,...(executablePath?{executablePath}:{})});t.after(()=>policyBrowser.close());
    const f=await fixture(t,{width:1200,height:800,audioUserscript:true,fixtureBrowser:policyBrowser}),keys=await f.page.evaluate(()=>fixture.keys);
    await primeAudio(f);const before=await snapshot(f),observations=[];
    for(const [key,index,label]of [[keys[0],0,'native'],[keys[2],3,'foreign']]){
        assert.equal(audibleMedia(await snapshot(f))[index].paused,false,'the default-policy target begins muted and playing');
        await actualMouseWindowAction(f,key,'enlarge');await waitOnlyAudible(f,index);await waitFocusStatus(f,'只開啟');await f.page.waitForTimeout(250);
        const media=audibleMedia(await snapshot(f))[index];observations.push({target:label,muted:media.muted,paused:media.paused,volume:media.volume});
    }
    await assertAudioContinuity(f,before,{allowPolicyPause:true});
    const label=engine==='firefox'?'firefox':/msedge/i.test(executablePath||'')?'edge':'chrome';
    fs.mkdirSync(path.join(root,'work'),{recursive:true});fs.writeFileSync(path.join(root,`work/player-audio-focus-default-policy-${label}.json`),JSON.stringify({engine,version:policyBrowser.version(),observations},null,2)+'\n');
    console.log('Default-policy audio focus: '+JSON.stringify(observations));
});

function selectionCard(f,key){
    const separator=key.indexOf('|'),platform=key.slice(0,separator),id=key.slice(separator+1);
    return f.page.locator('.channel-option-cell').filter({has:f.page.locator(`input[data-platform=${JSON.stringify(platform)}][value=${JSON.stringify(id)}]`)});
}
async function menuHoverState(f){
    return f.page.evaluate(()=>({
        selection:Array.from(activePlayers,([key,entry])=>getPlayerElement(entry).hasAttribute('data-umininn-selection-highlight')?key:null).filter(Boolean).sort(),
        controls:Array.from(activePlayers,([key,entry])=>getPlayerElement(entry).hasAttribute('data-umininn-controls-highlight')?key:null).filter(Boolean).sort(),
        cards:Array.from(channelOptionControls,([key,control])=>control.cell.dataset.playerHighlighted==='true'?key:null).filter(Boolean).sort()
    }));
}
async function waitMenuHover(f,{selection=[],controls=[],cards=selection}={}){
    const expected={selection:[...selection].sort(),controls:[...controls].sort(),cards:[...cards].sort()};
    await f.page.waitForFunction(expected=>{
        const actual={selection:[],controls:[],cards:[]};
        for(const [key,entry]of activePlayers){
            const element=getPlayerElement(entry);
            if(element.hasAttribute('data-umininn-selection-highlight'))actual.selection.push(key);
            if(element.hasAttribute('data-umininn-controls-highlight'))actual.controls.push(key);
        }
        for(const [key,control]of channelOptionControls)if(control.cell.dataset.playerHighlighted==='true')actual.cards.push(key);
        return ['selection','controls','cards'].every(kind=>JSON.stringify(actual[kind].sort())===JSON.stringify(expected[kind]));
    },expected);
    assert.deepEqual(await menuHoverState(f),expected);
}
async function hoverSelectionTile(f,key,{steps=8}={}){
    const point=await f.page.evaluate(key=>{const element=getPlayerElement(activePlayers.get(key)),rect=element.getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2}},key);
    await f.page.mouse.move(point.x,point.y,{steps});return point;
}
async function tileEdgePixels(f,key){
    const clip=await f.page.evaluate(key=>{const r=getPlayerElement(activePlayers.get(key)).getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height}},key);
    const png=(await f.page.screenshot({clip})).toString('base64');
    return f.page.evaluate(async png=>{
        const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();
        const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);
        return [[image.width/2,1],[image.width/2,image.height-2],[1,image.height/2],[image.width-2,image.height/2]].map(([x,y])=>Array.from(context.getImageData(Math.floor(x),Math.floor(y),1,1).data));
    },png);
}
async function assertVisibleTileEdges(f,key){
    const expected=Array.from({length:4},()=>[88,200,255,255]);let pixels;
    // Hover ownership and sibling-layer painting settle on separate animation
    // frames. Observe the rendered result after that normal delivery boundary.
    for(let attempt=0;attempt<5;attempt++){
        pixels=await tileEdgePixels(f,key);
        if(JSON.stringify(pixels)===JSON.stringify(expected))return;
        await f.page.waitForTimeout(20);
    }
    assert.deepEqual(pixels,expected,'all four actual tile edges remain cyan above the embedded media pixels');
}

test('selection hover pairs real menu cards and native or foreign players by channel key without blocking media clicks',{skip:!enabled,timeout:60000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys),initial=await readLayout(f);
    const inactive=await f.page.evaluate(()=>{
        channels[0].name=channels[1].name='重複名稱';const channel={platform:'at',id:'layout-0',name:'重複名稱'};channels.push(channel);
        window.fixtureHoverEvents=[];
        document.addEventListener('pointerenter',event=>{
            const card=event.target.closest?.('.channel-option-cell');
            if(card){const input=card.querySelector('input');fixtureHoverEvents.push({kind:'card',key:ChannelList.channelKey({platform:input.dataset.platform,id:input.value,name:input.dataset.name}),trusted:event.isTrusted})}
            for(const [key,entry]of activePlayers)if(getPlayerElement(entry)===event.target)fixtureHoverEvents.push({kind:'tile',key,trusted:event.isTrusted});
        },true);
        return ChannelList.channelKey(channel);
    });
    await f.page.locator('#more-channels-btn').click();await waitNames(f);
    for(const key of [keys[0],keys[1],keys[2]]){
        await selectionCard(f,key).hover();await waitMenuHover(f,{selection:[key]});await assertVisibleTileEdges(f,key);
    }
    await selectionCard(f,inactive).hover();await waitMenuHover(f);
    await hoverSelectionTile(f,keys[0]);await waitMenuHover(f,{selection:[keys[0]]});
    assert.equal(await f.page.evaluate(key=>fixtureHoverEvents.some(event=>event.kind==='tile'&&event.key===key&&event.trusted),keys[0]),true);
    assert.equal(await f.page.evaluate(key=>fixtureHoverEvents.some(event=>event.kind==='card'&&event.key===key&&event.trusted),keys[1]),true);
    const windowButton=windowCell(f,keys[0]).locator('[data-player-action="enlarge"]');
    await windowButton.evaluate(button=>{window.fixtureHoverButtonTrusted=null;button.addEventListener('pointerenter',event=>{fixtureHoverButtonTrusted=event.isTrusted},{once:true})});
    await windowButton.hover();await waitMenuHover(f,{selection:[keys[0]]});assert.equal(await f.page.evaluate(()=>fixtureHoverButtonTrusted),true,'moving onto a sibling window button retains the same match');
    await t.test('trusted cross-origin iframe entry highlights its matching menu card',{
        skip:engine==='chromium'?'Chromium Playwright OOPIF input does not update the parent hover chain; Firefox exercises actual trusted iframe entry':false
    },async()=>{
        for(const key of [keys[2],keys[3]]){
            await hoverSelectionTile(f,key);await waitMenuHover(f,{selection:[key]});await assertVisibleTileEdges(f,key);
            assert.equal(await f.page.evaluate(key=>fixtureHoverEvents.some(event=>event.kind==='tile'&&event.key===key&&event.trusted),key),true);
            await windowCell(f,key).locator('[data-player-action="close"]').hover();await waitMenuHover(f,{selection:[key]});
        }
    });
    await f.page.evaluate(()=>{window.fixtureHoverNativeClicks=[];document.getElementById('native-0').addEventListener('click',event=>{fixtureHoverNativeClicks.push(event.isTrusted);event.preventDefault()})});
    await f.frames[1].evaluate(()=>{window.fixtureHoverFrameClicks=[];document.addEventListener('click',event=>{fixtureHoverFrameClicks.push(event.isTrusted);event.preventDefault()},true)});
    for(const [key,index]of [[keys[0],0],[keys[3],1]]){
        const point=await hoverSelectionTile(f,key);
        assert.equal(await f.page.evaluate(({key,point})=>document.elementFromPoint(point.x,point.y)===getPlayerElement(activePlayers.get(key)),{key,point}),true,'highlighting cannot place a hit target over the media center');
        await f.page.mouse.click(point.x,point.y);
        assert.deepEqual(index?await f.frames[1].evaluate(()=>fixtureHoverFrameClicks):await f.page.evaluate(()=>fixtureHoverNativeClicks),[true]);
    }
    await f.page.mouse.move(5,5);await waitMenuHover(f);
    await f.page.locator('#more-channels-btn').click();await waitMenuHover(f);assert.equal((await nameGeometry(f)).hidden,true);
    assert.deepEqual((await readLayout(f)).logical,initial.logical);await assertContinuity(f,before);
});

test('selection hover coexists with the playback-controls bridge and never echoes the other menu marker',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys);
    await f.page.evaluate(key=>{document.documentElement.setAttribute('data-umininn-player-controls-open','');getPlayerElement(activePlayers.get(key)).setAttribute('data-umininn-controls-highlight','')},keys[3]);
    await waitMenuHover(f,{controls:[keys[3]],cards:[]});
    await f.page.locator('#more-channels-btn').click();await waitNames(f);await waitMenuHover(f,{controls:[keys[3]],cards:[keys[3]]});
    await selectionCard(f,keys[0]).hover();await waitMenuHover(f,{selection:[keys[0]],controls:[keys[3]],cards:[keys[0],keys[3]]});
    await f.page.mouse.move(5,5);await waitMenuHover(f,{controls:[keys[3]],cards:[keys[3]]});
    await f.page.evaluate(key=>getPlayerElement(activePlayers.get(key)).removeAttribute('data-umininn-controls-highlight'),keys[3]);await waitMenuHover(f);
    await f.page.evaluate(key=>getPlayerElement(activePlayers.get(key)).setAttribute('data-umininn-controls-highlight',''),keys[2]);
    await selectionCard(f,keys[0]).hover();await waitMenuHover(f,{selection:[keys[0]],controls:[keys[2]],cards:[keys[0],keys[2]]});
    await f.page.locator('#more-channels-btn').click();await waitMenuHover(f,{controls:[keys[2]],cards:[]});
    assert.equal((await nameGeometry(f)).hidden,false,'closing the selection menu cannot hide the playback-controls name layer');
    await f.page.locator('#more-channels-btn').click();await waitMenuHover(f,{controls:[keys[2]],cards:[keys[2]]});
    await f.page.evaluate(key=>{document.documentElement.removeAttribute('data-umininn-player-controls-open');getPlayerElement(activePlayers.get(key)).removeAttribute('data-umininn-controls-highlight')},keys[2]);
    await waitMenuHover(f);await waitNames(f);await f.page.locator('#more-channels-btn').click();await waitMenuHover(f);
    assert.equal((await nameGeometry(f)).hidden,true);await assertContinuity(f,before);
});

test('selection hover follows reflow, clears removed tiles, and resumes without stale markers after pagehide',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys);
    const extra=await f.page.evaluate(()=>{const channel={platform:'at',id:'hover-inert',name:'可移除本地格'};channels.push(channel);fixture.addPlaceholder(channel);syncActivePlayers(channels);return ChannelList.channelKey(channel)});
    await f.page.locator('#more-channels-btn').click();await selectionCard(f,extra).hover();await waitMenuHover(f,{selection:[extra]});
    await settlePane(f,900,800);await waitMenuHover(f,{selection:[extra]});await assertVisibleTileEdges(f,extra);assertFits(await f.page.evaluate(()=>fixture.grid()));
    await f.page.evaluate(key=>{window.removedHoverTile=getPlayerElement(activePlayers.get(key));closePlayer(key)},extra);await waitMenuHover(f);
    assert.equal(await f.page.evaluate(()=>removedHoverTile.hasAttribute('data-umininn-selection-highlight')),false);
    assert.equal(await selectionCard(f,extra).locator('input').isChecked(),false);
    await selectionCard(f,keys[0]).hover();await waitMenuHover(f,{selection:[keys[0]]});
    await f.page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))});await waitMenuHover(f);
    await f.page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))});await waitMenuHover(f,{selection:[keys[0]]});
    await f.page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));await waitMenuHover(f);
    await f.page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
    await f.page.locator('#more-channels-btn').click();await selectionCard(f,keys[0]).hover();await waitMenuHover(f,{selection:[keys[0]]});
    await f.page.locator('#more-channels-btn').click();await waitMenuHover(f);await assertContinuity(f,before);
});

test('selection hover transfers to an asynchronous error replacement and clears it when the player closes',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1300,height:1000}),keys=await f.page.evaluate(()=>fixture.keys),before=await activeMediaSnapshot(f,[keys[0],keys[2],keys[3],keys[4]],{remember:true});
    await f.page.locator('#more-channels-btn').click();await selectionCard(f,keys[1]).hover();await waitMenuHover(f,{selection:[keys[1]]});
    await f.page.evaluate(()=>{window.oldHoverVideo=fixture.entries[1].resource.element;setTimeout(()=>replacePlayerWithError(fixture.entries[1].resource,'本地懸停測試錯誤'),20)});
    await f.page.waitForFunction(()=>fixture.entries[1].resource.element!==oldHoverVideo);await waitMenuHover(f,{selection:[keys[1]]});
    assert.equal(await f.page.evaluate(()=>oldHoverVideo.hasAttribute('data-umininn-selection-highlight')),false);await assertVisibleTileEdges(f,keys[1]);
    await f.page.evaluate(key=>{window.removedHoverError=getPlayerElement(activePlayers.get(key));closePlayer(key)},keys[1]);await waitMenuHover(f);
    assert.equal(await f.page.evaluate(()=>removedHoverError.hasAttribute('data-umininn-selection-highlight')),false);
    await assertActiveContinuity(f,before);
});

test('selection hover never leaves a sticky tile or menu marker after trusted touch input',{skip:!enabled||engine!=='chromium',timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:900,height:800,viewport:{width:1600,height:1000},hasTouch:true}),before=await snapshot(f),key=await f.page.evaluate(()=>fixture.keys[0]);
    await f.page.locator('#more-channels-btn').tap();await waitNames(f);
    await selectionCard(f,key).locator('.channel-option-label').tap();await waitMenuHover(f);
    const point=await f.page.evaluate(key=>{const rect=getPlayerElement(activePlayers.get(key)).getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2}},key);
    await f.page.touchscreen.tap(point.x,point.y);await waitMenuHover(f);
    assert.equal(await selectionCard(f,key).locator('input').isChecked(),false,'the touch still operates the real checkbox rather than a highlight overlay');
    await assertContinuity(f,before);
});

test('selection hover integrates both real menus without echoing markers or clearing the other open owner',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,viewport:{width:2200,height:1200},audioUserscript:true,catalogChannels:48}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys);
    const toggle=f.page.locator('#umininn-player-control-host #toggle'),close=f.page.locator(audioPanel).getByRole('button',{name:'關閉',exact:true}),rows=f.page.locator(audioPanel).locator('.player');
    const titles=await rows.locator('strong').allTextContents();assert.equal(titles[0],'1. 播放器 0');assert.equal(titles[4],'5. 播放器 4');
    async function matched(expected,rowIndices=[]){
        await waitMenuHover(f,expected);
        await f.page.waitForFunction(expected=>{
            const rows=document.getElementById('umininn-player-panel-host').shadowRoot.querySelectorAll('.player');
            const actual=Array.from(rows).filter(row=>row.dataset.playerHighlighted==='true').map(row=>row.querySelector('strong').textContent).sort();
            return JSON.stringify(actual)===JSON.stringify([...expected].sort());
        },rowIndices.map(index=>titles[index]));
    }
    await f.page.locator('#more-channels-btn').click();await toggle.click();await waitNames(f);
    // First keep both production panel positions and exercise actual tile input.
    // Either menu's controls must identify that same tile without intercepting it.
    await hoverSelectionTile(f,keys[0]);await matched({selection:[keys[0]],controls:[keys[0]],cards:[keys[0]]},[0]);
    if(engine==='firefox'){
        await hoverSelectionTile(f,keys[2]);await matched({selection:[keys[2]],controls:[keys[2]],cards:[keys[2]]},[2]);
    }
    await f.page.mouse.move(5,5);await matched({});
    // The two existing fixed panels overlap on the real page. Separate only
    // their fixture positions so real pointer input can reach both menus while
    // testing their protocol; no synthetic hover or marker writes are used.
    await f.page.evaluate(()=>{const panel=document.getElementById('channel-selection');panel.style.left='1300px';panel.style.right='auto'});
    await selectionCard(f,keys[0]).hover();await matched({selection:[keys[0]],cards:[keys[0]]},[0]);
    const menuScroll=await f.page.locator('#channel-selection').evaluate(panel=>panel.scrollTop);
    await rows.nth(4).evaluate(row=>{window.fixtureIntegratedRowTrusted=null;row.addEventListener('pointerenter',event=>{fixtureIntegratedRowTrusted=event.isTrusted},{once:true})});
    await rows.nth(4).locator('strong').hover();await matched({controls:[keys[4]],cards:[keys[4]]},[4]);
    assert.equal(await f.page.locator('#channel-selection').evaluate(panel=>panel.scrollTop),menuScroll,'hovering the other menu row may highlight this card but cannot scroll this menu');
    assert.equal(await f.page.evaluate(()=>fixtureIntegratedRowTrusted),true);
    // Keyboard activation leaves the mouse on the still-open owner's row.
    await f.page.locator('#more-channels-btn').focus();await f.page.keyboard.press('Enter');await matched({controls:[keys[4]],cards:[]},[4]);
    assert.equal((await nameGeometry(f)).hidden,false);
    await f.page.keyboard.press('Enter');await matched({controls:[keys[4]],cards:[keys[4]]},[4]);
    await close.focus();await f.page.keyboard.press('Enter');await matched({});await waitNames(f);
    await selectionCard(f,keys[0]).hover();await matched({selection:[keys[0]],cards:[keys[0]]});
    await toggle.focus();await f.page.keyboard.press('Enter');await matched({selection:[keys[0]],cards:[keys[0]]},[0]);
    await close.focus();await f.page.keyboard.press('Enter');await matched({selection:[keys[0]],cards:[keys[0]]});
    await f.page.locator('#more-channels-btn').focus();await f.page.keyboard.press('Enter');await matched({});
    assert.equal((await nameGeometry(f)).hidden,true);await assertContinuity(f,before);
});

test('selection hover reaches real scaled Kick wrappers and keeps their iframe and corner geometry intact',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,viewport:{width:1800,height:1000},productionKick:true}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys);
    await f.page.locator('#more-channels-btn').click();await waitNames(f);
    await f.page.evaluate(()=>{
        window.fixtureKickHover=[];
        for(const [key,entry]of activePlayers){const tile=getPlayerElement(entry);if(tile.matches('.kick-wrapper'))tile.addEventListener('pointerenter',event=>fixtureKickHover.push({key,trusted:event.isTrusted}))}
    });
    for(const [index,key]of [[0,keys[2]],[1,keys[3]]]){
        const model=await f.page.evaluate(key=>{
            const tile=getPlayerElement(activePlayers.get(key)),frame=tile.querySelector('iframe'),bounds=tile.getBoundingClientRect(),rect=frame.getBoundingClientRect(),style=getComputedStyle(frame);
            return {wrapper:tile.matches('.video.kick-wrapper'),nested:frame.matches('.kick-iframe'),scaled:Number.parseFloat(style.width)/bounds.width,
                size:{width:rect.width,height:rect.height},tileSize:{width:bounds.width,height:bounds.height},transform:style.transform,
                frameRadius:style.borderTopLeftRadius,tileRadius:getComputedStyle(tile).borderTopLeftRadius};
        },key);
        assert.equal(model.wrapper,true);assert.equal(model.nested,true);assert.ok(Math.abs(model.scaled-2.2)<.02,JSON.stringify(model));assert.notEqual(model.transform,'none');
        assert.ok(Math.abs(model.size.width-model.tileSize.width)<.1);assert.ok(Math.abs(model.size.height-model.tileSize.height)<.1);
        await selectionCard(f,key).hover();await waitMenuHover(f,{selection:[key]});
        await capture(f,'scaled-kick-card-'+index);
        assert.equal(model.frameRadius,'0px','the oversized scaled iframe must not inherit a different effective corner radius');
        assert.equal(model.tileRadius,'0px','Kick tiles use the same square geometry as other iframe tiles');
        await assertVisibleTileEdges(f,key);
        const point=await hoverSelectionTile(f,key);
        assert.equal(await f.page.evaluate(({key,point})=>document.elementFromPoint(point.x,point.y)===getPlayerElement(activePlayers.get(key)).querySelector('iframe'),{key,point}),true,'the scaled frame receives media input through the wrapper highlight');
        if(engine==='firefox'){
            await waitMenuHover(f,{selection:[key]});
            assert.equal(await f.page.evaluate(key=>fixtureKickHover.some(event=>event.key===key&&event.trusted),key),true,'actual scaled-iframe entry generates a trusted parent wrapper hover');
            await windowCell(f,key).locator('[data-player-action="enlarge"]').hover();await waitMenuHover(f,{selection:[key]});
        }
        await f.frames[index].evaluate(()=>{window.fixtureKickClicks=[];document.addEventListener('click',event=>{fixtureKickClicks.push(event.isTrusted);event.preventDefault()},true)});
        await f.page.mouse.click(point.x,point.y);assert.deepEqual(await f.frames[index].evaluate(()=>fixtureKickClicks),[true]);
    }
    await f.page.mouse.move(5,5);await waitMenuHover(f);await f.page.locator('#more-channels-btn').click();await assertContinuity(f,before);
});

async function selectionScrollState(f,key){
    return f.page.evaluate(key=>{
        const panel=document.getElementById('channel-selection'),cell=channelOptionControls.get(key).cell,panelRect=panel.getBoundingClientRect(),rect=cell.getBoundingClientRect();
        const top=panelRect.top+panel.clientTop,bottom=top+panel.clientHeight;
        return {scroll:panel.scrollTop,maximum:panel.scrollHeight-panel.clientHeight,page:[scrollX,scrollY],top:rect.top,bottom:rect.bottom,
            viewportTop:top,viewportBottom:bottom,visible:rect.height>0&&rect.top>=top-.75&&rect.bottom<=bottom+.75};
    },key);
}
async function waitSelectionCardVisible(f,key){
    await f.page.waitForFunction(key=>{
        const panel=document.getElementById('channel-selection'),cell=channelOptionControls.get(key)?.cell;
        if(!cell)return false;const p=panel.getBoundingClientRect(),r=cell.getBoundingClientRect(),top=p.top+panel.clientTop;
        return r.height>0&&r.top>=top-.75&&r.bottom<=top+panel.clientHeight+.75;
    },key);
    return selectionScrollState(f,key);
}

test('selection auto-scroll reveals the physical player card minimally without moving the document or fighting manual menu scrolling',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,viewport:{width:1800,height:1000},catalogChannels:48}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys);
    await f.page.locator('#more-channels-btn').click();await waitNames(f);
    const first=await selectionScrollState(f,keys[0]),last=await selectionScrollState(f,keys[4]);
    assert.equal(first.visible,true);assert.equal(last.visible,false);assert.ok(last.maximum>500,'the real catalog must overflow the menu');
    await hoverSelectionTile(f,keys[0]);await waitMenuHover(f,{selection:[keys[0]]});assert.equal((await selectionScrollState(f,keys[0])).scroll,first.scroll);
    await hoverSelectionTile(f,keys[4]);await waitMenuHover(f,{selection:[keys[4]]});const revealed=await waitSelectionCardVisible(f,keys[4]);
    assert.ok(Math.abs(revealed.scroll-last.scroll-(last.bottom-last.viewportBottom))<1.5,'scroll only the distance needed to reveal the bottom of a normal card');
    assert.deepEqual(revealed.page,last.page);
    await f.page.mouse.move(5,5);await hoverSelectionTile(f,keys[4]);await f.page.waitForTimeout(80);
    assert.equal((await selectionScrollState(f,keys[4])).scroll,revealed.scroll,'a fully visible target never jumps or centers');
    await selectionCard(f,keys[4]).hover();await f.page.waitForTimeout(80);
    assert.equal((await selectionScrollState(f,keys[4])).scroll,revealed.scroll,'menu-card hover does not trigger player-driven scrolling');
    await hoverSelectionTile(f,keys[4]);await f.page.waitForTimeout(50);await f.page.evaluate(()=>{document.getElementById('channel-selection').scrollTop=0});
    const point=await hoverSelectionTile(f,keys[4]);await f.page.mouse.move(point.x+3,point.y+3);await f.page.waitForTimeout(100);
    assert.equal((await selectionScrollState(f,keys[4])).scroll,0,'the same hovered player must let the user read another part of the menu');
    await settlePane(f,1180,780);await waitSelectionCardVisible(f,keys[4]);
    await f.page.locator('#channel-selection').evaluate(panel=>{panel.style.maxHeight='400px'});await waitSelectionCardVisible(f,keys[4]);
    await f.page.mouse.move(5,5);await hoverSelectionTile(f,keys[4]);await waitSelectionCardVisible(f,keys[4]);
    await hoverSelectionTile(f,keys[0]);const returned=await waitSelectionCardVisible(f,keys[0]);
    assert.ok(Math.abs(returned.scroll-(first.top-first.viewportTop))<1,'returning upward scrolls only as far as the first card, preserving the menu padding');assert.deepEqual(returned.page,first.page);
    await assertContinuity(f,before);
});

test('selection auto-scroll uses the latest physical key after rapid hover and catalog reorder and cancels work when closed',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,viewport:{width:1800,height:1000},catalogChannels:48}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys);
    await f.page.locator('#more-channels-btn').click();await waitNames(f);
    await hoverSelectionTile(f,keys[0]);await hoverSelectionTile(f,keys[4]);await waitMenuHover(f,{selection:[keys[4]]});await waitSelectionCardVisible(f,keys[4]);
    await f.page.evaluate(()=>{channels.reverse();generateChannelOptions({preserveSelection:true})});
    const reordered=await waitSelectionCardVisible(f,keys[4]);assert.ok(Math.abs(reordered.top-reordered.viewportTop)<1,'a real catalog reorder remaps and minimally reveals the same currently hovered key');
    await f.page.evaluate(()=>generateChannelOptions({preserveSelection:true}));
    await f.page.evaluate(()=>{document.getElementById('channel-selection').scrollTop=120});await f.page.waitForTimeout(80);
    assert.equal((await selectionScrollState(f,keys[4])).scroll,120,'unchanged status/card refresh must not fight a manual menu scroll');
    await hoverSelectionTile(f,keys[0]);await waitSelectionCardVisible(f,keys[0]);
    await f.page.locator('#more-channels-btn').focus();await f.page.keyboard.press('Enter');const closed=await selectionScrollState(f,keys[0]);
    await hoverSelectionTile(f,keys[4]);await f.page.waitForTimeout(100);assert.equal((await selectionScrollState(f,keys[0])).scroll,closed.scroll);await waitMenuHover(f);
    await f.page.mouse.move(5,5);await f.page.keyboard.press('Enter');await waitNames(f);
    await hoverSelectionTile(f,keys[0]);await waitSelectionCardVisible(f,keys[0]);
    await f.page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));const hidden=await selectionScrollState(f,keys[0]);
    await hoverSelectionTile(f,keys[4]);await f.page.waitForTimeout(80);assert.equal((await selectionScrollState(f,keys[0])).scroll,hidden.scroll);await waitMenuHover(f);
    await assertContinuity(f,before);
});

test('selection auto-scroll skips hidden cards and keeps an oversized highlighted card stable',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,viewport:{width:1800,height:1000},catalogChannels:48}),before=await snapshot(f),key=await f.page.evaluate(()=>fixture.keys[4]);
    await f.page.locator('#more-channels-btn').click();await waitNames(f);
    await selectionCard(f,key).evaluate(cell=>{cell.style.display='none'});await hoverSelectionTile(f,key,{steps:1});await f.page.waitForTimeout(80);
    assert.equal((await selectionScrollState(f,key)).scroll,0,'an offline/filtered card must not move the menu');
    await selectionCard(f,key).evaluate(cell=>{cell.style.display='';cell.style.height=(document.getElementById('channel-selection').clientHeight+120)+'px'});
    await f.page.waitForFunction(key=>{
        const p=document.getElementById('channel-selection'),r=channelOptionControls.get(key).cell.getBoundingClientRect(),top=p.getBoundingClientRect().top+p.clientTop;
        return p.scrollTop>0&&r.top<=top+.75&&r.bottom>=top+p.clientHeight-.75;
    },key);
    const oversized=await selectionScrollState(f,key);assert.ok(Math.abs(oversized.top-oversized.viewportTop)<1,'an oversized card reveals its leading edge');
    const point=await hoverSelectionTile(f,key);await f.page.mouse.move(point.x+4,point.y+3);await f.page.waitForTimeout(120);
    assert.equal((await selectionScrollState(f,key)).scroll,oversized.scroll,'an oversized card must not oscillate between its two edges');
    assert.deepEqual((await selectionScrollState(f,key)).page,[0,0]);await assertContinuity(f,before);
});

test('selection auto-scroll ignores trusted touch input over a player',{skip:!enabled||engine!=='chromium',timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,viewport:{width:1800,height:1000},catalogChannels:48,hasTouch:true}),before=await snapshot(f),key=await f.page.evaluate(()=>fixture.keys[4]);
    await f.page.locator('#more-channels-btn').tap();await waitNames(f);
    const point=await f.page.evaluate(key=>{const r=getPlayerElement(activePlayers.get(key)).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}},key);
    await f.page.touchscreen.tap(point.x,point.y);await f.page.waitForTimeout(100);await waitMenuHover(f);
    assert.equal((await selectionScrollState(f,key)).scroll,0);assert.deepEqual((await selectionScrollState(f,key)).page,[0,0]);await assertContinuity(f,before);
});

test('selection auto-scroll cancels an unpainted reveal on close and pagehide',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,viewport:{width:1800,height:1000},catalogChannels:48,clock:true}),before=await snapshot(f),key=await f.page.evaluate(()=>fixture.keys[4]);
    await f.page.locator('#more-channels-btn').click();await f.page.clock.runFor(50);await waitNames(f);
    await hoverSelectionTile(f,key,{steps:1});assert.equal((await selectionScrollState(f,key)).scroll,0,'the pointer entry is queued before the next animation frame');
    await f.page.keyboard.press('Enter');await f.page.clock.runFor(100);assert.equal(await f.page.locator('#channel-selection').isVisible(),false);
    assert.equal((await selectionScrollState(f,key)).scroll,0);await waitMenuHover(f);
    await f.page.mouse.move(5,5);await f.page.keyboard.press('Enter');await f.page.clock.runFor(50);await waitNames(f);
    await hoverSelectionTile(f,key,{steps:1});assert.equal((await selectionScrollState(f,key)).scroll,0);
    await f.page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));await f.page.clock.runFor(100);
    assert.equal((await selectionScrollState(f,key)).scroll,0);await waitMenuHover(f);await assertContinuity(f,before);
});

test('selection hover paints all four Twitch SDK and direct fallback edges above their real iframe children',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,viewport:{width:1800,height:1000},productionTwitch:true}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys);
    assert.deepEqual(await f.page.evaluate(()=>fixture.keys.slice(2,4).map(key=>{
        const tile=getPlayerElement(activePlayers.get(key)),frame=tile.querySelector('iframe');
        return {wrapper:tile.matches('.twitch-wrapper'),nested:frame.parentElement!==tile,recovery:tile.querySelectorAll('.twitch-recover-button').length,fallback:tile.dataset.streamQualityMode==='platform-auto'};
    })),[{wrapper:true,nested:true,recovery:1,fallback:false},{wrapper:true,nested:false,recovery:0,fallback:true}]);
    await f.page.evaluate(()=>{window.fixtureTwitchDOM=fixture.elements.flatMap(element=>[element,...element.querySelectorAll('*')])});
    await f.page.locator('#more-channels-btn').click();await waitNames(f);
    for(const [index,key]of [[0,keys[2]],[1,keys[3]]]){
        await selectionCard(f,key).hover();await waitMenuHover(f,{selection:[key]});await capture(f,'twitch-'+(index?'fallback':'sdk')+'-card');
        await assertVisibleTileEdges(f,key);
        const point=await hoverSelectionTile(f,key);
        assert.equal(await f.page.evaluate(({key,point})=>document.elementFromPoint(point.x,point.y)===getPlayerElement(activePlayers.get(key)).querySelector('iframe'),{key,point}),true,'a Twitch highlight cannot intercept actual iframe input');
        if(engine==='firefox')await waitMenuHover(f,{selection:[key]});
        await f.frames[index].evaluate(()=>{window.fixtureTwitchClicks=[];document.addEventListener('click',event=>{fixtureTwitchClicks.push(event.isTrusted);event.preventDefault()},true)});
        await f.page.mouse.click(point.x,point.y);assert.deepEqual(await f.frames[index].evaluate(()=>fixtureTwitchClicks),[true]);
    }
    const recovery=f.page.locator('.twitch-wrapper .twitch-recover-button');
    await recovery.evaluate(button=>{window.fixtureRecoveryTrusted=null;button.addEventListener('click',event=>{fixtureRecoveryTrusted=event.isTrusted},{once:true})});
    await recovery.click();assert.equal(await f.page.evaluate(()=>fixtureRecoveryTrusted),true,'the inset border preserves the real recovery control hit target');
    await f.page.mouse.move(5,5);await f.page.locator('#more-channels-btn').click();await waitMenuHover(f);
    assert.deepEqual(await f.page.evaluate(()=>fixtureTwitchCalls),{play:0,pause:0,muted:0,quality:0,destroy:0});
    assert.equal(await f.page.evaluate(()=>{const actual=fixture.elements.flatMap(element=>[element,...element.querySelectorAll('*')]);return actual.length===fixtureTwitchDOM.length&&actual.every((node,index)=>node===fixtureTwitchDOM[index])}),true,'highlighting cannot add, wrap, detach or replace the playback DOM');
    await assertContinuity(f,before);
});

test('Twitch highlight follows enlargement, swapping and portrait reflow without changing the playback subtree or state',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,viewport:{width:1800,height:1200},productionTwitch:true}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys),focus=keys[2];
    await f.page.evaluate(()=>{window.fixtureTwitchLayoutDOM=fixture.elements.flatMap(element=>[element,...element.querySelectorAll('*')])});
    await f.page.locator('#enlarge-player').click();await positionCell(f,focus).click();await waitSpan(f,focus,2);await f.page.keyboard.press('Escape');
    await f.page.locator('#more-channels-btn').click();await selectionCard(f,focus).hover();await waitMenuHover(f,{selection:[focus]});await assertVisibleTileEdges(f,focus);assertGeometry(await geometry(f));
    await f.page.locator('#more-channels-btn').click();const enlarged=await readLayout(f);
    await f.page.locator('#adjust-player-positions').click();await positionCell(f,focus).click();await positionCell(f,keys[0]).click();await f.page.keyboard.press('Escape');
    const moved=await readLayout(f);assert.notDeepEqual(moved.logical,enlarged.logical,'the real move editor commits a different enlarged layout');
    assert.equal(moved.state.layout.items.find(item=>item.key===focus).span,2);assertGeometry(moved.state);assertFits(moved.grid);
    await f.page.locator('#more-channels-btn').click();await selectionCard(f,focus).hover();await waitMenuHover(f,{selection:[focus]});await assertVisibleTileEdges(f,focus);
    await f.page.evaluate(key=>{getPlayerElement(activePlayers.get(key)).dataset.streamPlaybackState='playing'},focus);
    assert.equal(await f.page.locator('.twitch-recover-button').isVisible(),false,'the actual playing-state CSS hides recovery');await assertVisibleTileEdges(f,focus);
    await settlePane(f,420,1040);await selectionCard(f,focus).hover();await waitMenuHover(f,{selection:[focus]});await assertVisibleTileEdges(f,focus);assertFits(await f.page.evaluate(()=>fixture.grid()));
    await f.page.evaluate(key=>{getPlayerElement(activePlayers.get(key)).hidden=true},focus);
    await f.page.waitForFunction(key=>!Array.from(document.querySelectorAll('#player-name-overlay .player-name-cell')).some(cell=>cell.dataset.playerKey===key),focus);
    await f.page.evaluate(key=>{getPlayerElement(activePlayers.get(key)).hidden=false},focus);await assertVisibleTileEdges(f,focus);
    await f.page.locator('#multi-stream-container-wrapper').evaluate(wrapper=>{wrapper.style.transformOrigin='top left';wrapper.style.transform='scale(.9)'});await assertVisibleTileEdges(f,focus);
    await selectionCard(f,keys[3]).hover();await waitMenuHover(f,{selection:[keys[3]]});await assertVisibleTileEdges(f,keys[3]);
    assert.equal(await f.page.evaluate(()=>{const actual=fixture.elements.flatMap(element=>[element,...element.querySelectorAll('*')]);return actual.length===fixtureTwitchLayoutDOM.length&&actual.every((node,index)=>node===fixtureTwitchLayoutDOM[index])}),true);
    assert.deepEqual(await f.page.evaluate(()=>fixtureTwitchCalls),{play:0,pause:0,muted:0,quality:0,destroy:0});await assertContinuity(f,before);
});

test('Twitch highlights from the real userscript row and both menu owners survive closing either owner',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,viewport:{width:2200,height:1200},productionTwitch:true,audioUserscript:true}),before=await snapshot(f),keys=await f.page.evaluate(()=>fixture.keys);
    const toggle=f.page.locator('#umininn-player-control-host #toggle'),close=f.page.locator(audioPanel).getByRole('button',{name:'關閉',exact:true}),rows=f.page.locator(audioPanel).locator('.player');
    await f.page.locator('#more-channels-btn').click();await toggle.click();await waitNames(f);
    // As in the general two-menu integration, separate only the existing fixed
    // fixture panels so trusted input can reach both actual control surfaces.
    await f.page.locator('#channel-selection').evaluate(panel=>{panel.style.left='1300px';panel.style.right='auto'});
    for(const [index,key]of [[2,keys[2]],[3,keys[3]]]){
        await rows.nth(index).locator('strong').hover();await waitMenuHover(f,{controls:[key],cards:[key]});await assertVisibleTileEdges(f,key);
        await selectionCard(f,key).hover();await waitMenuHover(f,{selection:[key]});await assertVisibleTileEdges(f,key);
    }
    // The real recovery strip is parent-document input even in Chromium's
    // OOPIF model and belongs to the same live Twitch wrapper for both menus.
    await f.page.locator('.twitch-recover-button').hover();await waitMenuHover(f,{selection:[keys[2]],controls:[keys[2]],cards:[keys[2]]});await assertVisibleTileEdges(f,keys[2]);
    await f.page.locator('#more-channels-btn').focus();await f.page.keyboard.press('Enter');await waitMenuHover(f,{controls:[keys[2]],cards:[]});await assertVisibleTileEdges(f,keys[2]);
    await f.page.keyboard.press('Enter');await waitMenuHover(f,{selection:[keys[2]],controls:[keys[2]],cards:[keys[2]]});
    await close.focus();await f.page.keyboard.press('Enter');await waitMenuHover(f,{selection:[keys[2]]});await assertVisibleTileEdges(f,keys[2]);
    await f.page.locator('#more-channels-btn').focus();await f.page.keyboard.press('Enter');await waitMenuHover(f);
    assert.equal((await tileEdgePixels(f,keys[2])).some(pixel=>JSON.stringify(pixel)==='[88,200,255,255]'),false,'closing both owners clears all four painted edges');
    await assertContinuity(f,before);
});

test('selection highlight suspends during actual Twitch fullscreen and resumes after exit',{skip:!enabled,timeout:30000},async t=>{
    if(!optional(t))return;const f=await fixture(t,{width:1200,height:800,viewport:{width:1800,height:1000},productionTwitch:true}),before=await snapshot(f),key=await f.page.evaluate(()=>fixture.keys[2]);
    if(!await f.page.evaluate(()=>document.fullscreenEnabled&&typeof document.documentElement.requestFullscreen==='function')){t.skip('This browser does not expose the actual fullscreen API');return}
    await f.page.locator('#more-channels-btn').click();await selectionCard(f,key).hover();await waitMenuHover(f,{selection:[key]});await assertVisibleTileEdges(f,key);
    await f.page.locator('.twitch-recover-button').evaluate(button=>{
        window.fixtureFullscreenError=null;
        button.addEventListener('click',()=>{
            const request=document.fullscreenElement?document.exitFullscreen():button.closest('.twitch-wrapper').requestFullscreen();
            request.catch(error=>{fixtureFullscreenError=error.name+': '+error.message});
        });
    });
    await f.page.locator('.twitch-recover-button').hover();await waitMenuHover(f,{selection:[key]});await f.page.locator('.twitch-recover-button').click();
    await f.page.waitForFunction(()=>document.fullscreenElement||fixtureFullscreenError);
    const failure=await f.page.evaluate(()=>fixtureFullscreenError);if(failure){t.skip('Headless browser denied trusted fullscreen: '+failure);return}
    assert.equal(await f.page.evaluate(key=>document.fullscreenElement===getPlayerElement(activePlayers.get(key)),key),true);
    await waitMenuHover(f);assert.equal(await f.page.locator('#player-name-overlay').evaluate(layer=>layer.hidden),true,'the sibling name/highlight layer is suspended for actual fullscreen');
    await f.page.locator('.twitch-recover-button').click();await f.page.waitForFunction(()=>!document.fullscreenElement);
    await f.page.mouse.move(5,5);await selectionCard(f,key).hover();
    try{await waitMenuHover(f,{selection:[key]})}catch(error){
        console.error('Fullscreen hover diagnostic:',await f.page.evaluate(key=>({hidden:document.hidden,fullscreen:Boolean(document.fullscreenElement),viewport:[innerWidth,innerHeight],
            panel:getComputedStyle(document.getElementById('channel-selection')).display,cardHovered:channelOptionControls.get(key).cell.matches(':hover'),
            layerHidden:document.getElementById('player-name-overlay').hidden,marked:getPlayerElement(activePlayers.get(key)).hasAttribute('data-umininn-selection-highlight')}),key));throw error;
    }
    await assertVisibleTileEdges(f,key);
    await assertContinuity(f,before);
});
