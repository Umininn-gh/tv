'use strict';
// Controlled real-time playback comparison. No live platform or user account is
// contacted. Each HTML video independently decodes a fixed encoded WebM asset.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
let pw;try{pw=require('playwright')}catch(_){pw=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))}
const args={};for(let i=2;i<process.argv.length;i++){const key=process.argv[i];if(!key.startsWith('--'))throw Error('Expected --option, got '+key);args[key.slice(2)]=process.argv[i+1]&&!process.argv[i+1].startsWith('--')?process.argv[++i]:'true';}
const project=path.resolve(__dirname,'..'),siteRoot=path.resolve(args.root||project),scriptRoot=path.resolve(args['script-root']||siteRoot);
const output=path.resolve(args.out||args.report||path.join(project,'work/perf-results.json')),asset=path.resolve(args.asset||path.join(project,'work/perf-video-640x360.webm'));
const executable=args.executable||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const number=(name,fallback)=>args[name]===undefined?fallback:Number(args[name]);
const modes=(args.modes||args.mode||'off,on').split(','),counts=(args.counts||args.count||'5,10,20').split(',').map(Number);
const duration=number('duration',60),warmup=number('warmup',15),sampleEvery=number('sample',5),mutationHz=number('mutation-hz',4),chatHz=number('chat-hz',2),decorative=number('decorative-nodes',250);
const churnEvery=number('churn-every',0),controlEvery=number('controls-every',0),phaseLabel=args.label||'controlled-playback';
const instrument=args.instrument==='true',headless=args.headless!=='false',cpuProfile=args['cpu-profile']==='true';
const stopFile=args['stop-file']?path.resolve(args['stop-file']):null;
const checkStop=()=>{if(stopFile&&fs.existsSync(stopFile)){const error=new Error('Benchmark interrupted by its explicit stop file');error.code='BENCHMARK_INTERRUPTED';throw error}};
for(const value of [duration,warmup,sampleEvery,mutationHz,chatHz,decorative,churnEvery,controlEvery])assert.ok(Number.isFinite(value)&&value>=0);
assert.ok(duration>0&&sampleEvery>0);for(const count of counts)assert.ok(Number.isInteger(count)&&count>=1&&count<=64);
for(const mode of modes)assert.ok(['off','on','baseline','optimized'].includes(mode));
const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const find=(root,name)=>{const options=[path.join(root,'site/assets/js',name),path.join(root,'site',name),path.join(root,name)];return options.find(fs.existsSync)||options.at(-1)};
const read=name=>fs.readFileSync(find(siteRoot,name),'utf8');
const userFile=args.script?path.resolve(args.script):[path.join(scriptRoot,'site/userscript/umininn-tv-player.user.js'),path.join(scriptRoot,'userscript/umininn-tv-player.user.js')].find(fs.existsSync);
const userSource=userFile?fs.readFileSync(userFile,'utf8'):null;
if(modes.some(mode=>mode!=='off'))assert.ok(userSource,'A built full userscript is required');
const userVersion=userSource?.match(/^\/\/ @version\s+(\S+)/m)?.[1]||null;
if(args.version)assert.equal(userVersion,args.version,'Unexpected userscript version');
const siteUrl='https://umininn-gh.github.io/tv/',childOrigin='https://player.kick.com';
const source=read('tv-app.js'),coreEnd=source.indexOf('/* =============== 頻道儲存 / 載入'),statusStart=source.indexOf('function applyStatusClass('),statusEnd=source.indexOf('\nfunction updateButtonStatus(',statusStart),summaryStart=source.indexOf('function updateChannelSelectionSummary()'),editorEnd=source.indexOf('\nfunction toggleChannelMenu()',source.indexOf('(function initPlayerPositionEditor()'));
assert.ok(coreEnd>0&&statusStart>coreEnd&&statusEnd>statusStart&&summaryStart>statusEnd&&editorEnd>summaryStart,'Production app seams changed');
const css=[...fs.readFileSync(find(siteRoot,'index.html'),'utf8').matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match=>match[1]).join('\n');
const files=['channel-list.js','stream-performance.js','player-geometry.js','player-layout.js','player-lifecycle.js','player-audio-bridge.js','menu-dismiss.js','layout-bookmarks.js'];
const scripts=Object.fromEntries(files.map(file=>['/'+file,read(file)]));
const provenance=Object.fromEntries(['tv-app.js','index.html',...files].map(file=>[file,hash(fs.readFileSync(find(siteRoot,file)))]));
const modelInfo={scope:'Production app core/status/selection/editor, CSS, lifecycle, layout and full built userscript; controlled native/foreign media renderer; no live provider SDK, network, account, Tampermonkey extension or background browser load.',media:'Independent HTML video playback from one immutable VP8/Opus WebM file; silent audio track; not shared captureStream playback.',time:'Actual wall-clock time; no browser clock acceleration.',cpu:'SystemInfo browser process CPU deltas, 100 percent = one logical CPU core. Host-capacity percent divides by logical CPU count. Process disappearance between samples can slightly undercount exited-process tail CPU.',memory:'Windows process PrivateMemorySize64 / WorkingSet64 sums for this isolated browser only. Working sets can double-count shared pages. JS heap/DOM counters deduplicated by V8 isolate ID and include main plus player renderer isolates.',gpu:'GPU process CPU/private memory are included; GPU engine utilization and dedicated VRAM are not measured.',instrumentation:'Optional lightweight query/style-read counters and optional V8 CPU profiles are diagnostic only. All conditions use identical requestVideoFrameCallback counting. Normal samples do not force GC; forced-GC endpoints are separate.'};
const report={schema:'umininn-userscript-performance/2',benchmark:{version:'2.1',sha256:hash(fs.readFileSync(__filename)),nodeVersion:process.version,argv:process.argv.slice(2)},createdAt:new Date().toISOString(),label:phaseLabel,options:{siteRoot,scriptRoot,modes,counts,durationSeconds:duration,warmupSeconds:warmup,sampleSeconds:sampleEvery,mutationHz,chatHz,decorativeNodes:decorative,churnEverySeconds:churnEvery,controlsEverySeconds:controlEvery,instrument,cpuProfile,headless,stopFile,logicalCpuCount:os.availableParallelism?.()||os.cpus().length},model:modelInfo,provenance,userScript:{file:userFile,version:userVersion,sha256:userSource&&hash(userSource)},runs:[]};
const save=()=>{fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n')};
const launch=()=>pw.chromium.launch({headless,executablePath:executable,args:['--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});

async function ensureAsset(){
 if(fs.existsSync(asset)){assert.ok(fs.statSync(asset).size>10000);return;}
 const browser=await launch();try{
  const page=await browser.newPage();await page.goto('about:blank');
  const result=await page.evaluate(async()=>{
   const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;document.body.appendChild(canvas);const ctx=canvas.getContext('2d');
   const audio=new AudioContext(),destination=audio.createMediaStreamDestination(),gain=audio.createGain(),osc=audio.createOscillator();gain.gain.value=0;osc.connect(gain).connect(destination);osc.start();await audio.resume();
   const video=canvas.captureStream(24),combined=new MediaStream([...video.getVideoTracks(),...destination.stream.getAudioTracks()]);
   const preferred='video/webm;codecs=vp8,opus';
   if(!MediaRecorder.isTypeSupported(preferred))throw Error('VP8/Opus MediaRecorder unsupported');
   const chunks=[],recorder=new MediaRecorder(combined,{mimeType:preferred,videoBitsPerSecond:700000,audioBitsPerSecond:16000});
   recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data)};const stopped=new Promise(resolve=>recorder.onstop=resolve);
   let frame=0;const paint=()=>{ctx.fillStyle='#17304b';ctx.fillRect(0,0,640,360);for(let j=0;j<28;j++){ctx.fillStyle=`hsl(${(j*37+frame*3)%360} 65% 52%)`;ctx.fillRect((j*53+frame*(j%5+1))%700-60,(j*31+frame*(j%3+1))%410-35,58+(j%3)*20,24+(j%4)*9)}ctx.fillStyle='white';ctx.font='20px sans-serif';ctx.fillText('Umininn controlled playback '+frame,18,28);frame++};
   paint();const timer=setInterval(paint,1000/24);recorder.start();await new Promise(resolve=>setTimeout(resolve,6000));recorder.stop();await stopped;clearInterval(timer);combined.getTracks().forEach(track=>track.stop());osc.stop();await audio.close();
   const blob=new Blob(chunks,{type:preferred}),bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));return {data:btoa(binary),mime:preferred,frames:frame};
  });
  fs.mkdirSync(path.dirname(asset),{recursive:true});fs.writeFileSync(asset,Buffer.from(result.data,'base64'));
  fs.writeFileSync(asset+'.json',JSON.stringify({createdAt:new Date().toISOString(),mime:result.mime,width:640,height:360,fps:24,durationSeconds:6,recordedFrames:result.frames,bytes:fs.statSync(asset).size,sha256:hash(fs.readFileSync(asset))},null,2)+'\n');
 }finally{await browser.close();}
}

function instrumentation(){
 window.perfCounters={allQueries:0,allNodes:0,frameQueries:0,bounds:0,styles:0,mutationsDelivered:0,chatDelivered:0,videoCallbacks:0};
 window.perfDocument=crypto.randomUUID();window.perfVideoSequence=0;window.perfErrors=0;
 window.perfRegisterVideo=video=>{video.__perfId=perfDocument+':video-'+(++perfVideoSequence);video.__perfPresented=0;
  if(video.requestVideoFrameCallback){const present=(_,meta)=>{video.__perfPresented=meta.presentedFrames;perfCounters.videoCallbacks++;if(video.isConnected)video.requestVideoFrameCallback(present)};video.requestVideoFrameCallback(present)}
  video.addEventListener('error',()=>perfErrors++);
 };
 if(!window.__PERF_INSTRUMENT__)return;
 for(const proto of [Document.prototype,Element.prototype,ShadowRoot.prototype]){const original=proto.querySelectorAll;proto.querySelectorAll=function(selector){const result=original.call(this,selector);if(selector==='*'){perfCounters.allQueries++;perfCounters.allNodes+=result.length}if(selector==='iframe')perfCounters.frameQueries++;return result};const one=proto.querySelector;proto.querySelector=function(selector){if(selector==='iframe')perfCounters.frameQueries++;return one.call(this,selector)}}
 const bounds=Element.prototype.getBoundingClientRect;Element.prototype.getBoundingClientRect=function(){perfCounters.bounds++;return bounds.call(this)};
 const style=window.getComputedStyle;window.getComputedStyle=function(...values){perfCounters.styles++;return style.apply(this,values)};
}
function workloadStart(){
 const count=window.__PERF_DECORATIVE__,hz=window.__PERF_MUTATION_HZ__,area=document.createElement('div');area.id='perf-provider-ui';area.style.cssText='position:absolute;inset:0;pointer-events:none;overflow:hidden';
 const fragment=document.createDocumentFragment(),nodes=[];for(let i=0;i<count;i++){const node=document.createElement('span');node.textContent='UI '+i;node.style.cssText='display:inline-block;font:8px sans-serif;color:#789;opacity:.03';fragment.appendChild(node);nodes.push(node)}area.appendChild(fragment);document.body.appendChild(area);
 if(hz>0&&nodes.length){let step=0;setInterval(()=>{const node=nodes[step++%nodes.length];node.style.opacity=String(.02+(step%4)/100);node.textContent='UI '+step;perfCounters.mutationsDelivered++},1000/hz)}
}
const sampleFunction=()=>({documentId:window.perfDocument,urlHost:location.hostname,counters:{...window.perfCounters},errors:window.perfErrors,media:[...document.querySelectorAll('video')].map(video=>{const q=video.getVideoPlaybackQuality?.();return {id:video.__perfId,slot:Number(video.dataset.perfSlot),readyState:video.readyState,paused:video.paused,muted:video.muted,volume:video.volume,time:video.currentTime,totalFrames:q?.totalVideoFrames||video.webkitDecodedFrameCount||0,droppedFrames:q?.droppedVideoFrames||video.webkitDroppedFrameCount||0,presentedFrames:video.__perfPresented||0,errorCode:video.error?.code||null}})});
const perfFixture=`
function fetchAllStatuses(){return Promise.resolve([])}
window.perfFixture={count:Number(document.body.dataset.perfCount),generation:new Map(),selected:0,churned:0};
perfFixture.slot=function(channel){return channel.platform==='kick'?Number(String(channel.id).replace('perf-','')):Number(new URL(channel.id,location.href).searchParams.get('channel'))};
RENDERERS.hls=function(channel,p,muted,wrapperClass){const slot=perfFixture.slot(channel),v=document.createElement('video');v.className='hls-video-element '+wrapperClass;v.loop=true;v.autoplay=true;v.playsInline=true;v.muted=true;v.dataset.perfSlot=slot;v.src='/perf-media.webm?slot='+slot+'&generation='+(perfFixture.generation.get(slot)||0);perfRegisterVideo(v);const r={video:v,element:v,disposed:false,failed:false,hls:null,flv:null};playerResources.set(v,r);return v};
const originalScaled=RENDERERS.scaledIframe;
RENDERERS.scaledIframe=function(channel,p,muted,wrapperClass){const slot=perfFixture.slot(channel);return originalScaled(channel,{...p,buildUrl:()=> '${childOrigin}/perf-player?slot='+slot+'&generation='+(perfFixture.generation.get(slot)||0)+'&muted=true&autoplay=true'},muted,wrapperClass)};
channels=Array.from({length:perfFixture.count},(_,index)=>({platform:index%2?'kick':'m3u8',id:index%2?'perf-'+index:'${siteUrl}perf-media.webm?channel='+index,name:'Perf '+index,perfSlot:index}));
globalMutedPreference=true;
perfFixture.ready=Promise.resolve(syncActivePlayers(channels)).then(()=>{for(const entry of activePlayers.values()){const v=entry.resource?.video;if(v)v.play().catch(()=>perfErrors++)}});
perfFixture.keys=()=>channels.map(ChannelList.channelKey);
perfFixture.churn=async function(index){const channel=channels[index],key=ChannelList.channelKey(channel),entry=activePlayers.get(key);if(!entry)throw Error('Missing churn owner');perfFixture.generation.set(index,(perfFixture.generation.get(index)||0)+1);playerRegistry.remove(key,entry);await syncActivePlayers(channels);const v=activePlayers.get(key)?.resource?.video;if(v)await v.play();perfFixture.churned++};
perfFixture.focus=function(index){perfFixture.selected=index;const element=getPlayerElement(activePlayers.get(ChannelList.channelKey(channels[index])));element.dispatchEvent(new CustomEvent('umininn-player-audio-focus',{bubbles:true}));return element.getAttribute('data-channel-key')};
const chat=document.getElementById('perf-chat'),chatNodes=[];for(let i=0;i<100;i++){const row=document.createElement('div');row.textContent='Controlled message '+i;chat.appendChild(row);chatNodes.push(row)}
if(window.__PERF_CHAT_HZ__>0){let tick=0;setInterval(()=>{chatNodes[tick++%chatNodes.length].textContent='Controlled message '+tick;perfCounters.chatDelivered++},1000/window.__PERF_CHAT_HZ__)}
`;

function mediaSummary(documents){let playing=0,total=0,frames=0,dropped=0,presented=0,errors=0;const counters={allQueries:0,allNodes:0,frameQueries:0,bounds:0,styles:0,mutationsDelivered:0,chatDelivered:0,videoCallbacks:0};for(const doc of documents){errors+=doc.errors||0;for(const key in counters)counters[key]+=doc.counters?.[key]||0;for(const media of doc.media){total++;if(!media.paused&&media.readyState>=2)playing++;frames+=media.totalFrames;dropped+=media.droppedFrames;presented+=media.presentedFrames;if(media.errorCode)errors++}}return {playing,total,frames,dropped,presented,errors,counters};}
async function processMemory(pids){
 if(process.platform!=='win32')return {unavailable:'Windows Get-Process counters are not available on this host'};
 const ids=[...new Set(pids)].filter(id=>Number.isSafeInteger(id)&&id>0);if(!ids.length)return {privateBytes:0,workingSetBytes:0,processes:[]};
 const command='$ErrorActionPreference=\'SilentlyContinue\'; @(Get-Process -Id '+ids.join(',')+' | Select-Object Id,WorkingSet64,PrivateMemorySize64) | ConvertTo-Json -Compress';
 const data=await new Promise((resolve,reject)=>cp.execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,encoding:'utf8',timeout:15000},(error,stdout)=>error?reject(error):resolve(stdout)));
 const raw=JSON.parse(data||'[]'),processes=Array.isArray(raw)?raw:[raw];return {privateBytes:processes.reduce((sum,p)=>sum+(p.PrivateMemorySize64||0),0),workingSetBytes:processes.reduce((sum,p)=>sum+(p.WorkingSet64||0),0),processes};
}
function profileSummary(profile){
 const nodes=new Map(profile.nodes.map(node=>[node.id,node])),direct=new Map(),inclusive=new Map(),parent=new Map();for(const node of profile.nodes)for(const child of node.children||[])parent.set(child,node.id);
 const samples=profile.samples||[];for(const id of samples){direct.set(id,(direct.get(id)||0)+1);for(let at=id;at!==undefined;at=parent.get(at))inclusive.set(at,(inclusive.get(at)||0)+1)}
 return {sampleCount:samples.length,durationMicroseconds:profile.endTime-profile.startTime,top:profile.nodes.map(node=>({name:node.callFrame.functionName||'(anonymous)',url:node.callFrame.url,line:node.callFrame.lineNumber+1,hits:direct.get(node.id)||0,inclusiveHits:inclusive.get(node.id)||0,shareAllSamples:samples.length?(direct.get(node.id)||0)/samples.length:0})).sort((a,b)=>b.hits-a.hits).slice(0,35)};
}
async function run(mode,count){
 checkStop();
 const browser=await launch(),browserCdp=await browser.newBrowserCDPSession();let context;const isolates=new Map(),cpuSeen=new Map(),life=new Map();
 const entry={mode,count,label:phaseLabel,startedAt:new Date().toISOString(),samples:[],actions:[],browserVersion:browser.version(),status:'running'};report.runs.push(entry);save();
 try{
  context=await browser.newContext({viewport:{width:1800,height:1080},deviceScaleFactor:1,serviceWorkers:'block'});
  const enabled=mode!=='off',appScript=source.slice(0,coreEnd)+'\n'+source.slice(statusStart,statusEnd)+'\n'+source.slice(summaryStart,editorEnd)+'\n'+perfFixture;
  const main='<!doctype html><html><head><meta charset="utf-8"><style>'+css+'\nhtml,body{overflow:hidden}#multi-stream-container-wrapper{position:absolute;left:0;top:40px;width:1500px!important;height:1000px!important;padding:0!important;flex:none!important}#perf-chat{position:absolute;right:0;top:45px;width:280px;height:980px;overflow:hidden;color:#aaa;font:11px sans-serif}</style></head><body data-perf-count="'+count+'"><div id="input-container" style="height:40px;width:100%;padding:0;margin:0"><button id="more-channels-btn" onclick="toggleChannelSelection()">看更台</button><button id="adjust-player-positions">調整位置</button><button id="enlarge-player">放大模式</button><button id="reset-player-positions">重設</button><button id="toggle-all-audio">聲音</button></div><div id="channel-selection" style="display:none"><div id="channel-options"></div><button onclick="watchSelectedChannels()">開始觀看</button></div><div id="multi-stream-container-wrapper"><div id="multi-stream-container" class="video-wrapper"></div></div><div id="perf-chat"></div>'+files.map(file=>'<script src="/'+file+'"></script>').join('')+'<script src="/perf-app.js"></script></body></html>';
  const child='<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111}video{display:block;width:100%;height:100%;object-fit:contain}</style></head><body><video id="perf-video" loop autoplay muted playsinline src="/perf-media.webm"></video><script>const v=document.getElementById("perf-video");v.dataset.perfSlot=new URL(location.href).searchParams.get("slot");perfRegisterVideo(v);v.play().catch(()=>perfErrors++);('+workloadStart.toString()+')();</script></body></html>';
  const assetBytes=fs.readFileSync(asset),errors=[],blocked=[];
  await context.route('**/*',route=>{const request=route.request(),url=new URL(request.url());
   if(request.isNavigationRequest()&&request.url()===siteUrl)return route.fulfill({contentType:'text/html; charset=utf-8',body:main});
   if(request.isNavigationRequest()&&url.origin===childOrigin&&url.pathname==='/perf-player')return route.fulfill({contentType:'text/html; charset=utf-8',body:child});
   if(url.pathname==='/perf-media.webm'&&[new URL(siteUrl).origin,childOrigin].includes(url.origin)){const match=/^bytes=(\d+)-(\d*)$/.exec(request.headers().range||''),start=match?Number(match[1]):0,end=match?.[2]?Math.min(Number(match[2]),assetBytes.length-1):assetBytes.length-1;return route.fulfill({status:match?206:200,contentType:'video/webm',body:assetBytes.subarray(start,end+1),headers:{'accept-ranges':'bytes',...(match?{'content-range':`bytes ${start}-${end}/${assetBytes.length}`}:{})}})}
   if(url.origin===new URL(siteUrl).origin&&url.pathname==='/perf-app.js')return route.fulfill({contentType:'application/javascript; charset=utf-8',body:appScript});
   if(url.origin===new URL(siteUrl).origin&&scripts[url.pathname])return route.fulfill({contentType:'application/javascript; charset=utf-8',body:scripts[url.pathname]});
   blocked.push(url.origin+url.pathname);return route.abort();
  });
  await context.addInitScript({content:'window.__PERF_INSTRUMENT__='+instrument+';window.__PERF_DECORATIVE__='+decorative+';window.__PERF_MUTATION_HZ__='+mutationHz+';window.__PERF_CHAT_HZ__='+chatHz+';('+instrumentation.toString()+')();'+(enabled?'addEventListener("DOMContentLoaded",()=>{\n'+userSource+'\n},{once:true});':'')});
  const page=await context.newPage();let pageCrashed=false;page.on('crash',()=>{pageCrashed=true});page.on('pageerror',error=>errors.push(error.message));await page.goto(siteUrl,{waitUntil:'load'});await page.evaluate(()=>perfFixture.ready);
  await page.waitForFunction(count=>document.querySelectorAll('#multi-stream-container > *').length===count,count,{timeout:20000});
  const assertPageLive=()=>{if(pageCrashed||page.isClosed()||!browser.isConnected())throw Error('Benchmark page/browser crashed or closed during cohort readiness')};
  const topology=()=>({native:[...document.querySelectorAll('#multi-stream-container video')].map(video=>video.__perfId),frames:[...document.querySelectorAll('#multi-stream-container iframe')].map(frame=>frame.src)});
  const currentFrames=async()=>{const deadline=performance.now()+20000;
   while(performance.now()<deadline){checkStop();assertPageLive();let handles=[];
    try{handles=await page.$$('#multi-stream-container iframe');const frames=[page.mainFrame()];let pending=handles.length!==Math.floor(count/2);
     for(const handle of handles){if(!await handle.evaluate(element=>element.isConnected)){pending=true;break}const frame=await handle.contentFrame();if(!frame||frame.isDetached()||!frame.url().startsWith(childOrigin)){pending=true;break}frames.push(frame)}
     const connected=await Promise.all(handles.map(handle=>handle.evaluate(element=>element.isConnected)));
     if(!pending&&connected.every(Boolean)&&frames.every(frame=>!frame.isDetached())&&new Set(frames).size===frames.length)return frames;
    }finally{await Promise.all(handles.map(handle=>handle.dispose().catch(()=>{})))}
    await sleep(50);
   }assertPageLive();throw Error('Connected DOM frame cohort did not settle');
  };
  // A just-removed OOPIF can remain in page.frames() until Playwright receives its
  // detach event. Resolve the current DOM iframe elements on each poll instead.
  // A readiness pass must observe the complete, stable, currently connected
  // cohort; an empty or stale document cannot satisfy Array.every by accident.
  const ready=async()=>{const deadline=performance.now()+20000;let last='waiting for current cohort';
   while(performance.now()<deadline){checkStop();assertPageLive();let handles=[];
    try{const before=await page.evaluate(topology);handles=await page.$$('#multi-stream-container iframe');
     if(before.native.length!==Math.ceil(count/2)||before.frames.length!==Math.floor(count/2)||handles.length!==before.frames.length){last='DOM cohort count changed';}
     else{const docs=[await page.mainFrame().evaluate(sampleFunction)];let pending=false;
      for(const handle of handles){if(!await handle.evaluate(element=>element.isConnected)){pending=true;break}const frame=await handle.contentFrame();
       if(!frame||frame.isDetached()||!frame.url().startsWith(childOrigin)){pending=true;break}
       try{docs.push(await frame.evaluate(sampleFunction))}catch(error){assertPageLive();const connected=await handle.evaluate(element=>element.isConnected);if(frame.isDetached()||!connected){pending=true;break}throw error}
       if(frame.isDetached()||!await handle.evaluate(element=>element.isConnected)){pending=true;break}
      }
      const after=await page.evaluate(topology),media=docs.flatMap(doc=>doc.media),slots=new Set(media.map(video=>video.slot));
      if(!pending&&JSON.stringify(before)===JSON.stringify(after)&&media.length===count&&slots.size===count&&media.every(video=>Number.isInteger(video.slot)&&video.slot>=0&&video.slot<count&&video.readyState>=2&&!video.paused&&!video.errorCode))return;
      last=JSON.stringify({pending,media:media.length,playing:media.filter(video=>video.readyState>=2&&!video.paused).length,uniqueSlots:slots.size,stable:JSON.stringify(before)===JSON.stringify(after)});
     }
    }finally{await Promise.all(handles.map(handle=>handle.dispose().catch(()=>{})))}
    await sleep(50);
   }assertPageLive();throw Error('Current '+count+'-video cohort did not become ready: '+last);
  };
  await ready();
  if(enabled)await page.waitForFunction(count=>document.getElementById('umininn-player-panel-host')?.shadowRoot.querySelectorAll('.player').length===count,count,{timeout:15000});
  const pruneIsolates=async()=>{let changed=false;for(const [id,record]of isolates)if(record.frame.isDetached()){try{await record.session.detach()}catch(_){}isolates.delete(id);changed=true}return changed};
  const attach=async()=>{await pruneIsolates();for(const frame of await currentFrames()){let session;try{session=await context.newCDPSession(frame);const identity=await session.send('Runtime.getIsolateId');if(isolates.has(identity.id)){await session.detach();continue;}await session.send('Performance.enable');isolates.set(identity.id,{session,frame,profileStarted:false});}catch(error){try{await session?.detach()}catch(_){}assertPageLive();if(!frame.isDetached())throw error}}};
  await attach();
  let selected=0;
  const verifySelected=async(index)=>{for(let tries=0;tries<70;tries++){checkStop();const docs=await Promise.all((await currentFrames()).map(f=>f.evaluate(sampleFunction)));const all=docs.flatMap(doc=>doc.media);if(all.length===count&&all.every(media=>media.muted===(media.slot!==index)))return;await sleep(100)}throw Error('Focus did not converge to slot '+index)};
  const select=async(index)=>{const begun=performance.now();if(enabled){await page.evaluate(index=>perfFixture.focus(index),index)}else{for(const frame of await currentFrames()){await frame.evaluate(index=>{for(const v of document.querySelectorAll('video')){v.muted=Number(v.dataset.perfSlot)!==index;if(!v.muted)v.volume=1}},index)}}
   await verifySelected(index);selected=index;entry.actions.push({type:'focus',slot:index,elapsedMs:performance.now()-begun,wallAt:new Date().toISOString(),trigger:enabled?'Production audio-focus DOM event':'Equivalent direct media setters'})};
  await select(0);
  await sleep(warmup*1000);
  const collect=async(forceGc=false)=>{
   checkStop();if(await pruneIsolates()||!isolates.size)await attach();
   const processInfo=await browserCdp.send('SystemInfo.getProcessInfo'),cpuMonotonicMs=performance.now();for(const p of processInfo.processInfo){const previous=cpuSeen.get(p.id);if(!previous||p.cpuTime>=previous.cpuTime)cpuSeen.set(p.id,{type:p.type,cpuTime:p.cpuTime})}
   const cpuByType={};for(const p of cpuSeen.values())cpuByType[p.type]=(cpuByType[p.type]||0)+p.cpuTime;
   const memory=await processMemory(processInfo.processInfo.map(p=>p.id));const metrics=[];for(const [id,record]of [...isolates]){try{if(forceGc)await record.session.send('HeapProfiler.collectGarbage');const [m,dom]=await Promise.all([record.session.send('Performance.getMetrics'),record.session.send('Memory.getDOMCounters')]);const values=Object.fromEntries(m.metrics.map(v=>[v.name,v.value]));metrics.push({isolate:id,frameHost:new URL(record.frame.url()).hostname,taskSeconds:values.TaskDuration,scriptSeconds:values.ScriptDuration,layoutSeconds:values.LayoutDuration,recalcSeconds:values.RecalcStyleDuration,heapUsed:values.JSHeapUsedSize,heapTotal:values.JSHeapTotalSize,documents:dom.documents,nodes:dom.nodes,listeners:dom.jsEventListeners});}catch(_){isolates.delete(id)}}
   const docs=await Promise.all((await currentFrames()).map(f=>f.evaluate(sampleFunction)));
   for(const doc of docs){life.set(doc.documentId,{counters:doc.counters,errors:doc.errors});for(const media of doc.media)life.set(media.id,{frames:media.totalFrames,dropped:media.droppedFrames,presented:media.presentedFrames})}
   const cumulative={frames:0,dropped:0,presented:0,errors:0,counters:{allQueries:0,allNodes:0,frameQueries:0,bounds:0,styles:0,mutationsDelivered:0,chatDelivered:0,videoCallbacks:0}};
   for(const item of life.values()){for(const key of ['frames','dropped','presented','errors'])cumulative[key]+=item[key]||0;for(const key in cumulative.counters)cumulative.counters[key]+=item.counters?.[key]||0;}
   return {wallAt:new Date().toISOString(),monotonicMs:performance.now(),cpuMonotonicMs,browserCpuSeconds:cpuByType,processMemory:memory,rendererMetrics:metrics,current:mediaSummary(docs),cumulative,forceGc};
  };
  await collect(true); // Discard warm-up garbage before the timed phase only.
  if(cpuProfile)for(const record of isolates.values()){await record.session.send('Profiler.enable');await record.session.send('Profiler.setSamplingInterval',{interval:1000});await record.session.send('Profiler.start');record.profileStarted=true;}
  const first=await collect();entry.samples.push(first);save();const started=performance.now(),end=started+duration*1000;let nextSample=started+sampleEvery*1000,nextChurn=churnEvery?started+churnEvery*1000:Infinity,nextControl=controlEvery?started+controlEvery*1000:Infinity,cycle=0;
  while(performance.now()<end){await sleep(Math.max(0,Math.min(nextSample,nextChurn,nextControl,end)-performance.now()));checkStop();const now=performance.now();
   if(now>=nextChurn&&now<end){const candidates=Array.from({length:count},(_,index)=>index).filter(i=>i!==1&&i!==selected);if(candidates.length){const slot=candidates[cycle%candidates.length];await page.evaluate(slot=>perfFixture.churn(slot),slot);await ready();await attach();await verifySelected(selected);entry.actions.push({type:'churn',slot,wallAt:new Date().toISOString()});cycle++;}nextChurn+=churnEvery*1000;}
   if(now>=nextControl&&now<end){await select(cycle%count);cycle++;nextControl+=controlEvery*1000;}
   if(performance.now()>=nextSample){entry.samples.push(await collect());save();nextSample+=sampleEvery*1000;}
  }
  entry.samples.push(await collect());
  if(cpuProfile){entry.cpuProfiles=[];for(const [id,record]of isolates)if(record.profileStarted){const {profile}=await record.session.send('Profiler.stop'),name=output.replace(/\.json$/,'')+'-'+mode+'-'+count+'-'+id+'.cpuprofile';fs.writeFileSync(name,JSON.stringify(profile));entry.cpuProfiles.push({file:name,sha256:hash(fs.readFileSync(name)),isolate:id,summary:profileSummary(profile)})}}
  entry.retentionAfterGc=await collect(true);const last=entry.samples.at(-1),elapsed=(last.monotonicMs-first.monotonicMs)/1000,cpuElapsed=(last.cpuMonotonicMs-first.cpuMonotonicMs)/1000,delta=(name)=>Object.fromEntries(Object.keys(last[name]).map(key=>[key,last[name][key]-(first[name][key]||0)]));
  const cpuSeconds=delta('browserCpuSeconds'),cpuTotal=Object.values(cpuSeconds).reduce((a,b)=>a+b,0),logical=report.options.logicalCpuCount;
  entry.summary={actualElapsedSeconds:elapsed,cpuElapsedSeconds:cpuElapsed,cpuSecondsByProcessType:cpuSeconds,cpuCorePercent:100*cpuTotal/cpuElapsed,cpuHostCapacityPercent:100*cpuTotal/cpuElapsed/logical,firstPrivateBytes:first.processMemory.privateBytes,lastPrivateBytes:last.processMemory.privateBytes,privateBytesGrowth:last.processMemory.privateBytes-first.processMemory.privateBytes,peakPrivateBytes:Math.max(...entry.samples.map(s=>s.processMemory.privateBytes||0)),firstWorkingSet:first.processMemory.workingSetBytes,lastWorkingSet:last.processMemory.workingSetBytes,jsHeapFirst:first.rendererMetrics.reduce((sum,m)=>sum+(m.heapUsed||0),0),jsHeapLast:last.rendererMetrics.reduce((sum,m)=>sum+(m.heapUsed||0),0),jsHeapAfterGc:entry.retentionAfterGc.rendererMetrics.reduce((sum,m)=>sum+(m.heapUsed||0),0),countersDelta:Object.fromEntries(Object.keys(last.cumulative.counters).map(key=>[key,last.cumulative.counters[key]-first.cumulative.counters[key]])),decodedFrames:last.cumulative.frames-first.cumulative.frames,presentedFrames:last.cumulative.presented-first.cumulative.presented,droppedFrames:last.cumulative.dropped-first.cumulative.dropped,minPlaying:Math.min(...entry.samples.map(s=>s.current.playing)),errors:[...new Set(errors)],blocked:[...new Set(blocked)],actions:entry.actions.length};
  assert.deepEqual(entry.summary.errors,[]);assert.deepEqual(entry.summary.blocked,[]);assert.equal(last.current.total,count);assert.ok(entry.summary.decodedFrames>count*duration*2,'Video decode workload must really advance');assert.ok(entry.summary.presentedFrames>0);entry.status='complete';entry.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({mode,count,summary:entry.summary}));
 }catch(error){entry.status=error.code==='BENCHMARK_INTERRUPTED'?'interrupted':'failed';entry.error=error.stack;entry.actualElapsedSeconds=entry.samples.length?(performance.now()-entry.samples[0].monotonicMs)/1000:0;entry.lastMeasuredSeconds=entry.samples.length>1?(entry.samples.at(-1).monotonicMs-entry.samples[0].monotonicMs)/1000:0;entry.completedRequestedDuration=false;save();throw error}
 finally{for(const record of isolates.values())try{await record.session.detach()}catch(_){}await context?.close();await browser.close();}
}

(async()=>{checkStop();await ensureAsset();report.videoAsset={file:asset,bytes:fs.statSync(asset).size,sha256:hash(fs.readFileSync(asset)),metadata:fs.existsSync(asset+'.json')?JSON.parse(fs.readFileSync(asset+'.json','utf8')):null};save();for(const count of counts)for(const mode of modes)await run(mode,count);report.finishedAt=new Date().toISOString();save();})().catch(error=>{if(error.code==='BENCHMARK_INTERRUPTED'){report.interrupted=true;report.interruptedAt=new Date().toISOString();save()}console.error(error.stack);process.exitCode=error.code==='BENCHMARK_INTERRUPTED'?2:1});
