'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { renderUserscript } = require('../tools/build-player-userscript.cjs');

// Actual userscript, real cross-origin postMessage and real HTML media. The
// platform model maps mouseout/mousemove to controls as AT's React handlers do.
// All requests are fulfilled or blocked; no platform, stream or manager is used.
// Synthetic page transition events exercise cleanup, not BFCache eligibility.
const enabled = process.env.UMININN_BROWSER_TESTS === '1';
const engine = process.env.UMININN_BROWSER_ENGINE || 'chromium';
const executablePath = process.env.UMININN_BROWSER_EXECUTABLE;
const channel = process.env.UMININN_BROWSER_CHANNEL;
const siteUrl = 'https://umininn-gh.github.io/tv/';
const playerUrl = 'https://player.angelthump.com/?channel=controls-fixture';
const styleId = 'umininn-angelthump-logo-style';
const reactFixturePath = process.env.UMININN_AT_REACT_FIXTURE || path.resolve(__dirname, '../work/angelthump-live-main.js');
let browser, bundle, unavailable;

test.before(async () => {
    if (!enabled) return;
    let playwright;
    try { playwright = require('playwright'); }
    catch (_) {
        try { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
        catch (_) { unavailable = 'Optional Playwright browser model unavailable.'; return; }
    }
    assert.ok(['chromium', 'firefox'].includes(engine));
    assert.ok(!channel || engine === 'chromium');
    try { browser = await playwright[engine].launch({ headless: true, ...(executablePath ? { executablePath } : {}), ...(channel ? { channel } : {}) }); }
    catch (error) {
        if (executablePath || channel) throw error;
        unavailable = 'Optional browser executable unavailable.'; return;
    }
    bundle = renderUserscript();
    console.log(`AngelThump controls model: ${engine}${channel ? '/' + channel : ''} ${browser.version()} (actual bundle; all network intercepted; no live platform or manager).`);
});
test.after(async () => { await browser?.close(); });
function optional(t) { if (unavailable) { t.skip(unavailable); return false; } return true; }

const rate = 8000, samples = rate * 20;
const wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);

const playerHtml = `<!doctype html><html><head><style>
body{margin:0}#player{position:absolute;left:20px;top:20px;width:400px;height:300px;background:#111}
video{width:400px;height:300px}#controls{position:absolute;bottom:0;left:0;background:#ddd;width:100%;height:40px}
#settings{height:35px}#menu{position:absolute;bottom:40px;background:white}#outside{position:absolute;top:350px}
</style></head><body><div id="mount"></div><input id="outside"><script>
window.fixtureActions={play:0,pause:0,load:0,source:0,seek:0};
window.fixtureEvents={out:0,move:0,targets:[],badRelated:0};
window.fixtureMount=function(){
 document.getElementById('mount').innerHTML='<div id="player" tabindex="-1"><video id="video" loop playsinline preload="auto"></video><div id="controls" data-visible="true"><button id="settings">Settings</button></div></div>';
 const surface=document.getElementById('player'),video=document.getElementById('video'),controls=document.getElementById('controls');
 window.fixtureVideo=video;window.fixtureControls=controls;window.fixtureSurface=surface;
 video.volume=.37;video.muted=true;
 for(const method of ['play','pause','load']){const original=video[method].bind(video);video[method]=function(...args){fixtureActions[method]++;return original(...args)}}
 const descriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');
 Object.defineProperty(video,'currentTime',{get(){return descriptor.get.call(this)},set(value){fixtureActions.seek++;return descriptor.set.call(this,value)}});
 new MutationObserver(records=>{fixtureActions.source+=records.length}).observe(video,{attributes:true,attributeFilter:['src']});
 function show(){controls.dataset.visible='true';controls.style.visibility='visible'}
 surface.addEventListener('mousemove',event=>{if(!event.isTrusted){fixtureEvents.move++;fixtureEvents.targets.push(event.target.id)}show()});
 surface.addEventListener('mouseout',event=>{if(!event.isTrusted){fixtureEvents.out++;fixtureEvents.targets.push(event.target.id);if(event.relatedTarget!==null)fixtureEvents.badRelated++}if(event.relatedTarget&&surface.contains(event.relatedTarget))return;controls.dataset.visible='false';controls.style.visibility='hidden'});
 document.getElementById('settings').addEventListener('click',()=>{const menu=document.createElement('div');menu.id='menu';menu.role='menu';menu.textContent='Quality';controls.appendChild(menu)});
 video.src='/silent.wav';surface.focus();
};
if(!new URLSearchParams(location.search).has('late'))fixtureMount();
<\/script></body></html>`;

async function fixture(t, { late = false, parent = siteUrl, standalone = false } = {}) {
    const frameUrl = playerUrl + (late ? '&late=1' : '');
    const context = await browser.newContext({ serviceWorkers: 'block' });
    t.after(() => context.close());
    const blocked = [], navigations = new Map();
    await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (request.isNavigationRequest()) {
            navigations.set(request.url(), (navigations.get(request.url()) || 0) + 1);
            if (request.url() === frameUrl) return route.fulfill({ contentType: 'text/html', body: playerHtml });
            if (request.url() === parent) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="input-container"></div><div id="multi-stream-container"></div><iframe id="target" src="${frameUrl}" allow="autoplay" style="position:absolute;left:60px;top:60px;width:460px;height:400px"></iframe></body></html>` });
        }
        if (url.origin === 'https://player.angelthump.com' && url.pathname === '/silent.wav') {
            const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range || '');
            const start = range ? Number(range[1]) : 0;
            const end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
            return route.fulfill({ status: range ? 206 : 200, contentType: 'audio/wav', body: wav.subarray(start, end + 1),
                headers: { 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${wav.length}` } : {}) } });
        }
        blocked.push(request.url()); return route.abort();
    });
    await context.addInitScript({ content: `addEventListener('DOMContentLoaded',()=>{\n${bundle}\n},{once:true});` });
    const page = await context.newPage(); page.setDefaultTimeout(7000);
    await page.goto(standalone ? frameUrl : parent, { waitUntil: 'load' });
    const frame = standalone ? page.mainFrame() : page.frames().find(frame => frame.url() === frameUrl);
    assert.ok(frame);
    const f = { page, frame, blocked, navigations, frameUrl };
    if (!late) await ready(f);
    return f;
}
async function ready(f) {
    await f.frame.waitForFunction(() => window.fixtureVideo?.readyState >= 2);
    await f.frame.evaluate(() => { fixtureVideo.currentTime = .375; });
    await f.frame.waitForFunction(() => fixtureVideo.readyState >= 2 && Math.abs(fixtureVideo.currentTime - .375) < .05);
}
async function probe(f) {
    await f.page.evaluate(() => document.getElementById('target').contentWindow.postMessage({ channel:'umininn-tv-userscript',version:1,type:'frame:probe' },'https://player.angelthump.com'));
}
async function approve(f) { await probe(f); await f.frame.waitForFunction(id => !!document.getElementById(id), styleId); }
async function play(f) { await f.frame.evaluate(async () => { await fixtureVideo.play(); }); }
async function state(f) {
    return f.frame.evaluate(() => ({ visible:fixtureControls.dataset.visible, out:fixtureEvents.out, move:fixtureEvents.move,
        targets:[...fixtureEvents.targets], badRelated:fixtureEvents.badRelated, sameVideo:fixtureVideo===document.getElementById('video'),
        sameControls:fixtureControls===document.getElementById('controls'), focus:document.activeElement.id,
        volume:fixtureVideo.volume,muted:fixtureVideo.muted,controls:fixtureVideo.controls,paused:fixtureVideo.paused,
        source:fixtureVideo.currentSrc,time:fixtureVideo.currentTime,actions:{...fixtureActions} }));
}
function stable(value) { const { visible,out,move,targets,badRelated,time,...rest } = value; return rest; }
async function waitOut(f, count) { await f.frame.waitForFunction(count => fixtureEvents.out===count, count); }

test('late loading and paused AT retain controls; first actual playback settles once without changing media or focus', {skip:!enabled,timeout:30000}, async t => {
    if (!optional(t)) return;
    const f=await fixture(t,{late:true}); await approve(f);
    await f.frame.evaluate(()=>fixtureMount()); await ready(f);
    const paused=await state(f); assert.equal(paused.visible,'true'); assert.equal(paused.out,0);
    await f.frame.evaluate(()=>fixtureVideo.dispatchEvent(new Event('playing')));
    assert.equal((await state(f)).out,0,'a misleading playing event on paused media is ignored');
    await play(f); await waitOut(f,1);
    const playing=await state(f);
    assert.equal(playing.visible,'false'); assert.equal(playing.focus,'player'); assert.deepEqual(playing.targets,['player']); assert.equal(playing.badRelated,0);
    assert.deepEqual(stable(playing),{...stable(paused),paused:false,actions:{...paused.actions,play:paused.actions.play+1}});
    for(let i=0;i<3;i++){await probe(f);await f.frame.evaluate(()=>fixtureVideo.dispatchEvent(new Event('playing')))}
    assert.equal((await state(f)).out,1,'repeat playing and parent probes cannot resettle');
    await f.frame.locator('#player').hover(); await f.frame.waitForFunction(()=>fixtureControls.dataset.visible==='true');
    await f.page.mouse.move(5,5);
    await f.frame.locator('#player').focus(); await f.page.keyboard.press('ArrowDown');
    const keyboard=await state(f); assert.equal(keyboard.visible,'true'); assert.equal(keyboard.move,1);
    assert.deepEqual(stable(keyboard),stable(playing)); assert.deepEqual(f.blocked,[]);
    assert.equal(f.navigations.get(f.frameUrl),1);
});

test('already playing AT is settled by the initial scan and body Tab restores keyboard access', {skip:!enabled,timeout:30000}, async t => {
    if(!optional(t))return;
    const f=await fixture(t); await play(f); const before=await state(f); await approve(f); await waitOut(f,1);
    assert.deepEqual(stable(await state(f)),stable(before));
    await f.frame.evaluate(()=>fixtureSurface.blur());
    assert.equal(await f.frame.evaluate(()=>document.activeElement===document.body),true);
    await f.page.keyboard.press('Tab');
    assert.equal(await f.frame.evaluate(()=>document.activeElement===document.body),true,'first Tab only reveals without moving focus');
    await f.page.keyboard.press('Tab');
    // Firefox also includes the <video> itself in its native Tab sequence.
    if((await state(f)).focus==='video')await f.page.keyboard.press('Tab');
    const after=await state(f); assert.equal(after.visible,'true'); assert.ok(after.move>=1);
    assert.equal(after.focus,'settings','capture keydown reveals controls before the native Tab default');
    assert.deepEqual(after.actions,before.actions);
});

test('hover, focused controls, settings and earlier keyboard preserve first-play controls without later retry', {skip:!enabled,timeout:30000}, async t => {
    if(!optional(t))return;
    for(const guard of ['hover','focus','menu','keyboard']){
        const f=await fixture(t); await approve(f);
        if(guard==='hover'){
            await f.page.bringToFront();
            await f.page.mouse.move(1,1);
            await f.frame.locator('#player').hover();
            await f.frame.waitForFunction(()=>fixtureSurface.matches(':hover'));
        }
        if(guard==='focus')await f.frame.locator('#settings').focus();
        if(guard==='menu')await f.frame.evaluate(()=>{const menu=document.createElement('div');menu.role='menu';fixtureControls.appendChild(menu)});
        if(guard==='keyboard')await f.page.keyboard.press('ArrowDown');
        await play(f); assert.equal((await state(f)).out,0,guard);
        await f.page.mouse.move(5,5);
        await f.frame.evaluate(()=>{document.querySelector('[role="menu"]')?.remove();fixtureSurface.focus();fixtureVideo.dispatchEvent(new Event('playing'))});
        assert.equal((await state(f)).out,0,guard+' consumes the initial check instead of retrying later');
        if(guard!=='hover')assert.equal((await state(f)).visible,'true');
    }
});

test('keyboard reveal preserves paused media and ignores modified, composing and unrelated input', {skip:!enabled,timeout:30000}, async t => {
    if(!optional(t))return;
    const f=await fixture(t);await approve(f);const before=await state(f);
    await f.page.keyboard.press('ArrowDown');assert.equal((await state(f)).move,1);
    await f.frame.evaluate(()=>{
        fixtureSurface.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,ctrlKey:true}));
        fixtureSurface.dispatchEvent(new KeyboardEvent('keydown',{key:'x',bubbles:true,isComposing:true}));
        document.getElementById('outside').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
    });
    const after=await state(f);assert.equal(after.move,1);assert.deepEqual(stable(after),stable(before));assert.equal(after.time,before.time);
});

test('BFCache suspension and disposal remove both control listeners until a fresh approved restore', {skip:!enabled,timeout:30000}, async t => {
    if(!optional(t))return;
    const f=await fixture(t);await approve(f);
    await f.frame.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
    await play(f);await f.page.keyboard.press('ArrowDown');assert.equal((await state(f)).out,0);assert.equal((await state(f)).move,0);
    await f.frame.evaluate(()=>dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
    await f.page.keyboard.press('ArrowDown');assert.equal((await state(f)).move,0);
    await approve(f);await waitOut(f,1);const before=await state(f);
    await f.frame.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide',{persisted:false})));
    await probe(f);await f.page.keyboard.press('ArrowDown');
    await f.frame.evaluate(()=>fixtureVideo.dispatchEvent(new Event('playing')));
    const after=await state(f);assert.equal(after.out,1);assert.equal(after.move,0);assert.deepEqual(stable(after),stable(before));
    assert.equal(await f.frame.locator('#'+styleId).count(),0);
});

test('unapproved parent and standalone AT never settle controls or install keyboard behavior', {skip:!enabled,timeout:30000}, async t => {
    if(!optional(t))return;
    for(const options of [{parent:'https://attacker.invalid/'},{standalone:true}]){
        const f=await fixture(t,options);if(!options.standalone)await probe(f);
        await play(f);await f.page.keyboard.press('ArrowDown');const after=await state(f);
        assert.equal(after.visible,'true');assert.equal(after.out,0);assert.equal(after.move,0);assert.equal(after.focus,'player');
        assert.equal(await f.frame.locator('#'+styleId).count(),0);
    }
});

test('cached AT React runtime: keyboard reveal commits without letting Tab skip hidden controls', {
    skip:!enabled || !fs.existsSync(reactFixturePath),timeout:30000
}, async t => {
    if(!optional(t))return;
    // Optional read-only proof uses the already cached platform runtime. Only
    // its final render entry changes in memory; no third-party bundle is shipped
    // or fetched by this test and no platform application/network effects run.
    const platform=fs.readFileSync(reactFixturePath,'utf8');
    const entry='(0,r.createRoot)(qw).render((0,jt.jsx)(Kw,{})),Yw()';
    assert.equal(platform.split(entry).length,2,'cached platform entry must match the reviewed fixture');
    const model=`function ControlsFixture(){
      const [visible,setVisible]=e.useState(true);
      return e.createElement('div',{id:'player',tabIndex:-1,
        ref:node=>{if(node&&!window.fixtureSurface){window.fixtureSurface=node;node.focus()}},
        onMouseMove:event=>{if(!event.isTrusted){fixtureEvents.move++;fixtureEvents.targets.push(event.target.id)}setVisible(true)},
        onMouseLeave:event=>{if(!event.isTrusted){fixtureEvents.out++;fixtureEvents.targets.push(event.target.id);if(event.relatedTarget!==null)fixtureEvents.badRelated++}setVisible(false)}},
        e.createElement('video',{id:'video',src:'/silent.wav',loop:true,playsInline:true,
          ref:node=>{if(!node||window.fixtureVideo)return;window.fixtureVideo=node;node.volume=.37;node.muted=true;
            for(const method of ['play','pause','load']){const original=node[method].bind(node);node[method]=function(...args){fixtureActions[method]++;return original(...args)}}
            const descriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');
            Object.defineProperty(node,'currentTime',{get(){return descriptor.get.call(this)},set(value){fixtureActions.seek++;return descriptor.set.call(this,value)}});
            new MutationObserver(records=>{fixtureActions.source+=records.length}).observe(node,{attributes:true,attributeFilter:['src']})}}),
        e.createElement('div',{id:'controls','data-visible':String(visible),style:{visibility:visible?'visible':'hidden'},ref:node=>{if(node)window.fixtureControls=node}},
          e.createElement('button',{id:'settings'},'Settings')))
      };(0,r.createRoot)(qw).render(e.createElement(ControlsFixture))`;
    const f=await fixture(t,{late:true});
    await f.frame.evaluate(()=>{document.getElementById('mount').id='root'});
    await f.frame.addScriptTag({content:platform.replace(entry,model)});
    await f.frame.waitForSelector('#video');await ready(f);await play(f);
    const before=await state(f);await approve(f);await waitOut(f,1);
    await f.frame.waitForFunction(()=>fixtureControls.dataset.visible==='false');
    assert.equal((await state(f)).focus,'player','initial wrapper autofocus is preserved');
    await f.page.keyboard.press('Tab');
    await f.frame.waitForFunction(()=>fixtureControls.dataset.visible==='true');
    let after=await state(f);
    assert.equal(after.focus,'player','first Tab only reveals and preserves wrapper focus');
    for(let i=0;i<2&&after.focus!=='settings';i++){await f.page.keyboard.press('Tab');after=await state(f)}
    assert.equal(after.focus,'settings','native Tab can reach the revealed control');
    assert.deepEqual(after.actions,before.actions);assert.equal(after.volume,before.volume);assert.equal(after.muted,before.muted);
    assert.equal(after.paused,false);assert.equal(after.source,before.source);assert.equal(after.sameVideo,true);assert.equal(after.out,1);
    assert.deepEqual(f.blocked,[]);
});
