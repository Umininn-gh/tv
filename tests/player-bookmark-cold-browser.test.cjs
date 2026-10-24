'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const harnessFile = path.join(__dirname, 'player-layout-browser.test.cjs');
const harnessRequire = createRequire(harnessFile), harnessModule = { exports: {} };
const harnessTest = Object.assign(() => {}, { before: test.before, after: test.after });
let harnessSource = fs.readFileSync(harnessFile, 'utf8');
// A genuinely fresh browser context must use its normal autoplay policy.
assert.ok(harnessSource.includes("{args:['--autoplay-policy=no-user-gesture-required']}"));
harnessSource = harnessSource.replace("{args:['--autoplay-policy=no-user-gesture-required']}", '{args:[]}');
assert.ok(harnessSource.includes("firefoxUserPrefs:{'media.autoplay.default':0}"));
harnessSource = harnessSource.replace("firefoxUserPrefs:{'media.autoplay.default':0}", 'firefoxUserPrefs:{}');
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + harnessSource + '\n' +
    'module.exports={optional,assets:()=>({browser,appScript,css,instrument,wav,layoutScript,geometryScript,lifecycleScript,audioBridgeScript,channelScript,performanceScript,bookmarkScript,menuDismissScript})};\n})',
    { filename: harnessFile })(name => name === 'node:test' ? harnessTest : harnessRequire(name), harnessModule, harnessModule.exports, __dirname, harnessFile);
const { optional, assets } = harnessModule.exports;
const root = path.resolve(__dirname, '..'), origin = 'https://umininn-gh.github.io', siteUrl = origin + '/tv/';
const childOrigin = 'https://player.kick.com';
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const browserCase = { skip: process.env.UMININN_BROWSER_TESTS !== '1', timeout: 45000 };

async function coldFixture(t, { readyDelay = 0, mediaDelay = 0, nativeDelay = 0, audible = 'foreign', warm = false } = {}) {
    const a = assets(), context = await a.browser.newContext({ viewport: { width: 1300, height: 850 }, serviceWorkers: 'block' });
    t.after(() => context.close());
    const setup = `
channels=[{id:'cold-native',platform:'m3u8',name:'本地台'},{id:'cold-foreign',platform:'at',name:'外站台'}];
window.coldKeys=channels.map(ChannelList.channelKey);window.coldErrors=[];
RENDERERS.hls=(channel,platform,muted,cls)=>{const video=document.createElement('video');video.className=cls;video.id='cold-native';video.loop=true;video.playsInline=true;video.muted=muted;
 video.addEventListener('loadeddata',()=>video.play().catch(error=>coldErrors.push(error.name)));
 ${nativeDelay ? `setTimeout(()=>{video.src='/silent.wav'},${nativeDelay});` : "video.src='/silent.wav';"}
 playerResources.set(video,{element:video,video,disposed:false,failed:false,hls:null,flv:null});return video;};
RENDERERS.iframe=(channel,platform,muted,cls)=>{const frame=document.createElement('iframe');frame.className=cls;frame.id='cold-foreign';frame.allow='autoplay';frame.src='${childOrigin}/player';return frame;};
window.coldBookmark={channels:channels.map((channel,index)=>({key:coldKeys[index],name:channel.name})),columns:2,focus:null,aspectRatio:1.5,audio:{version:1,audible:[{key:coldKeys[${audible === 'native' ? 0 : 1}],volume:.63}]}};
document.getElementById('apply-cold').onclick=event=>{window.coldTrusted=event.isTrusted;window.coldApplied=Promise.resolve(applyPlayerBookmark(coldBookmark)).then(value=>{window.coldResult=value;return value});};
${warm ? 'syncActivePlayers(channels);' : ''}
window.coldReady=true;`;
    const marker = 'fixture.mount();fixture.initialGrid=fixture.grid();fixture.initialGeometry=fixture.geometry();';
    assert.equal(a.appScript.split(marker).length, 2);
    const app = a.appScript.replace(marker, setup);
    new vm.Script(app, { filename: 'cold-app.js' });
    const scripts = { '/instrument.js': a.instrument, '/channel-list.js': a.channelScript, '/stream-performance.js': a.performanceScript,
        '/player-geometry.js': a.geometryScript, '/player-layout.js': a.layoutScript, '/player-lifecycle.js': a.lifecycleScript,
        '/player-audio-bridge.js': a.audioBridgeScript, '/menu-dismiss.js': a.menuDismissScript, '/layout-bookmarks.js': a.bookmarkScript,
        '/cold-app.js': app };
    const main = `<!doctype html><html><head><meta charset="utf-8"><style>${a.css}</style></head><body>
      <div id="input-container"><button id="apply-cold">套用書籤</button><button id="more-channels-btn">看更台</button><button id="adjust-player-positions">搬位</button><button id="enlarge-player">放大</button><button id="reset-player-positions">重設</button><button id="toggle-all-audio">聲音</button></div>
      <div id="channel-selection" style="display:none"><div id="channel-options"></div></div>
      <div id="multi-stream-container-wrapper" style="width:1100px;height:650px;flex:none"><div id="multi-stream-container" class="video-wrapper"></div></div>
      ${Object.keys(scripts).map(src => '<script src="' + src + '"></script>').join('')}</body></html>`;
    const childMedia = '<video id="cold-video" autoplay loop muted playsinline src="/silent.wav"></video>';
    const child = '<!doctype html><html><head><meta charset="utf-8"></head><body>' + (mediaDelay
        ? `<script>setTimeout(()=>document.body.insertAdjacentHTML('beforeend',${JSON.stringify(childMedia)}),${mediaDelay});</script>`
        : childMedia) + '</body></html>';
    const unexpected = [];
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.href === siteUrl) return route.fulfill({ contentType: 'text/html', body: main });
        if (url.origin === origin && scripts[url.pathname]) return route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: scripts[url.pathname] });
        if (url.origin === childOrigin && url.pathname === '/player') return route.fulfill({ contentType: 'text/html', body: child });
        if ([origin, childOrigin].includes(url.origin) && url.pathname === '/silent.wav') return route.fulfill({ contentType: 'audio/wav', body: a.wav });
        unexpected.push(url.href); return route.abort();
    });
    let built = read('userscript/umininn-tv-player.user.js');
    assert.equal(built.match(/^\/\/ @version\s+(\S+)/m)?.[1], require('../tools/build-player-userscript.cjs').RELEASE_VERSION,
        'cold-start integration must use the current built userscript');
    if (process.env.UMININN_COLD_DEBUG === '1') built = built.replace('onStatus: value => {\n',
        'onStatus: value => {\n(window.coldFlowTrace ||= []).push({value,entries:layoutAudioEntries().map(item=>({key:item.key,version:item.version,ready:item.ready,readable:item.readable}))});\n');
    const init = `window.coldTrace=[];window.coldMessages=[];
      for(const type of ['umininn-player-layout-before','umininn-player-layout-after','umininn-player-layout-restored','umininn-player-layout-abort'])document.addEventListener(type,event=>coldTrace.push({type,ticket:event.target.getAttribute('data-umininn-layout-audio-ticket'),status:event.target.getAttribute('data-umininn-layout-audio-status'),audio:event.target.getAttribute('data-umininn-layout-bookmark-audio'),intent:document.documentElement.getAttribute('data-umininn-player-audio-intent')}),true);
      addEventListener('message',event=>{if(event.data?.channel==='umininn-tv-userscript')coldMessages.push({type:event.data.type,command:event.data.command,result:event.data.result})},true);
      addEventListener('DOMContentLoaded',()=>{const start=()=>{${built}\n};if(top===window)start();else setTimeout(start,${readyDelay});},{once:true});`;
    new vm.Script(init, { filename: 'cold-init.js' });
    await context.addInitScript({ content: init });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.stack));
    page.setDefaultTimeout(20000);
    await page.goto(siteUrl, { waitUntil: 'load' });
    try { await page.waitForFunction(() => window.coldReady && playerBookmarkAudioAvailable()); }
    catch (error) { console.log('Cold setup diagnostics', errors, unexpected); throw error; }
    if (warm) {
        await page.waitForFunction(() => document.getElementById('umininn-player-panel-host')?.shadowRoot.querySelectorAll('.player').length === 2);
        await page.waitForTimeout(readyDelay + mediaDelay + nativeDelay + 800);
    }
    return { page, errors, unexpected };
}

async function sound(f) {
    const native = await f.page.evaluate(() => { const video = document.querySelector('#cold-native'); return video && { muted: video.muted, volume: video.volume, paused: video.paused, ready: video.readyState }; });
    const frame = f.page.frames().find(value => value.url().startsWith(childOrigin));
    const foreign = frame && await frame.evaluate(() => { const video = document.querySelector('video'); return { muted: video.muted, volume: video.volume, paused: video.paused, ready: video.readyState }; });
    return { native, foreign };
}

for (const options of [{ audible: 'native', readyDelay: 0 }, { audible: 'native', readyDelay: 0, nativeDelay: 1500 }, { audible: 'foreign', readyDelay: 0 },
    { audible: 'foreign', readyDelay: 0, mediaDelay: 1500 }, { audible: 'foreign', readyDelay: 12000 },
    { audible: 'foreign', readyDelay: 0, warm: true }]) {
    test(`cold bookmark: ${options.warm ? 'warm control' : 'fresh context'} restores ${options.audible} sound with ${options.readyDelay}ms controller, ${options.mediaDelay || 0}ms foreign media and ${options.nativeDelay || 0}ms native source delay`, browserCase, async t => {
        if (!optional(t)) return;
        const f = await coldFixture(t, options);
        assert.equal(await f.page.evaluate(() => activePlayers.size), options.warm ? 2 : 0, 'cold case has no previous players or playback');
        await f.page.locator('#apply-cold').click();
        assert.equal(await f.page.evaluate(() => coldTrusted), true);
        await f.page.waitForTimeout(options.readyDelay + (options.mediaDelay || 0) + (options.nativeDelay || 0) + 2300);
        const actual = await sound(f);
        const failed = actual[options.audible]?.muted !== false || actual[options.audible]?.volume !== .63 || actual[options.audible]?.paused !== false ||
            actual[options.audible === 'native' ? 'foreign' : 'native']?.muted !== true || f.errors.length || f.unexpected.length;
        if (failed || process.env.UMININN_COLD_DEBUG === '1') console.log(JSON.stringify({ options, actual, flow: await f.page.evaluate(() => window.coldFlowTrace), trace: await f.page.evaluate(() => coldTrace),
            messages: await f.page.evaluate(() => coldMessages.slice(-10).map(value => ({ type: value.type, action: value.command?.action,
                ok: value.result?.ok, code: value.result?.code, state: value.result?.state && { available: value.result.state.available,
                    muted: value.result.state.muted, volume: value.result.state.volume, ready: value.result.state.readyState,
                    revision: value.result.state.audioUserRevision, guard: value.result.state.muteGuardActive } }))), errors: f.errors, unexpected: f.unexpected }));
        assert.equal(actual[options.audible].muted, false);
        assert.equal(actual[options.audible].volume, .63);
        assert.equal(actual[options.audible].paused, false, 'audible restoration must not interrupt the already playing video');
        assert.equal(actual[options.audible === 'native' ? 'foreign' : 'native'].muted, true);
        assert.deepEqual(f.errors, []); assert.deepEqual(f.unexpected, []);
    });
}

test('cold bookmark: a newer trusted all-mute cancels saved sound while the foreign video is still absent', browserCase, async t => {
    if (!optional(t)) return;
    const f = await coldFixture(t, { audible: 'foreign', mediaDelay: 1800 });
    await f.page.locator('#apply-cold').click();
    await f.page.waitForFunction(() => coldMessages.some(value => value.result?.state?.available === false));
    const bookmarkIntent = await f.page.evaluate(() => document.documentElement.getAttribute('data-umininn-player-audio-intent'));
    await f.page.locator('#umininn-player-control-host #quick-mute').click();
    assert.notEqual(await f.page.evaluate(() => document.documentElement.getAttribute('data-umininn-player-audio-intent')), bookmarkIntent);
    await f.page.waitForTimeout(2600);
    const actual = await sound(f);
    assert.equal(actual.native.muted, true);
    assert.equal(actual.foreign.muted, true, 'late media cannot revive the older saved audible policy');
    assert.equal(actual.foreign.paused, false);
    assert.deepEqual(f.errors, []); assert.deepEqual(f.unexpected, []);
});
