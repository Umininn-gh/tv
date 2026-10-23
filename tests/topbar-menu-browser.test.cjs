'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Real production toolbar markup/styles, dropdown module and optional built
// userscript. Only login, platform services and the action destinations are
// replaced. Every interaction below uses trusted browser input.
const enabled = process.env.UMININN_BROWSER_TESTS === '1';
const engine = process.env.UMININN_BROWSER_ENGINE || 'chromium';
const root = path.resolve(__dirname, '..');
const siteUrl = 'https://umininn-gh.github.io/tv/';
const frameUrl = 'https://topbar-frame.invalid/player';
const cases = { skip: !enabled, timeout: 30000 };
const trigger = '#topbar-options-btn';
const menu = '#topbar-options-panel';
const taskTrigger = '#topbar-tasks-btn';
const taskPanel = '#topbar-tasks-panel';
const originalIds = ['hideNotLiveToggle', 'channel-actions', 'logout-btn', 'toggle-all-audio',
    'global-audio-feedback', 'more-channels-btn', 'layout-bookmarks-btn'];
let browser;

function readSite(relative, legacy = relative) {
    const migrated = path.join(root, 'site', relative);
    return fs.readFileSync(fs.existsSync(migrated) ? migrated : path.join(root, legacy), 'utf8');
}

function productionTopbar(html) {
    const start = html.indexOf('<div id="top-bar">');
    const end = html.indexOf('<div id="admin-modal"', start);
    assert.ok(start >= 0 && end > start, 'production toolbar HTML seam remains explicit');
    return html.slice(start, end);
}

function silentWav() {
    const rate = 8000, samples = rate * 2;
    const bytes = Buffer.alloc(44 + samples * 2);
    bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
    bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
    bytes.writeUInt32LE(samples * 2, 40);
    return bytes;
}

test.before(async () => {
    if (!enabled) return;
    let playwright;
    try { playwright = require('playwright'); }
    catch (_) { playwright = require(path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright')); }
    const executablePath = process.env.UMININN_BROWSER_EXECUTABLE;
    browser = await playwright[engine].launch({ headless: process.env.UMININN_BROWSER_HEADLESS !== '0',
        ...(executablePath ? { executablePath } : engine === 'chromium' ? { channel: 'msedge' } : {}),
        ...(engine === 'firefox' ? { firefoxUserPrefs: { 'general.smoothScroll': false, 'media.autoplay.default': 0 } }
            : { ignoreDefaultArgs:['--hide-scrollbars'], args: ['--disable-smooth-scrolling', '--autoplay-policy=no-user-gesture-required'] }) });
    console.log(`Responsive toolbar: ${engine} ${browser.version()} (production markup, CSS, module; real browser input).`);
});
test.after(async () => { await browser?.close(); });

async function fixture(t, { width = 495, userscript = false } = {}) {
    const html = readSite('index.html');
    const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]).join('\n');
    const pageBodyPanel = html.match(/<[^>]+id="topbar-options-panel"[^>]*>[\s\S]*?<\/(?:div|section|nav)>/)?.[0] || '';
    const context = await browser.newContext({ viewport: { width, height: 820 }, serviceWorkers: 'block' });
    t.after(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const errors = [], navigations = [], blocked = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
        const request = route.request(), url = request.url();
        if (request.isNavigationRequest()) {
            navigations.push(url);
            if (url === siteUrl) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>
                ${productionTopbar(html)}${productionTopbar(html).includes('id="topbar-options-panel"') ? '' : pageBodyPanel}
                <main id="fixture-main" style="position:relative;height:600px;margin-top:20px;flex-shrink:0">
                  <div id="multi-stream-container-wrapper" style="width:min(640px,90vw);height:180px;position:relative">
                    <div id="multi-stream-container" style="display:flex;width:100%;height:100%">
                      <div id="fixture-player" data-channel-key="native" data-channel-name="原生測試台" style="width:50%;height:180px"><video id="fixture-video" controls muted loop src="/silent.wav" style="width:100%;height:100%"></video></div>
                      <iframe id="fixture-frame" data-channel-key="foreign" src="${frameUrl}" style="position:absolute;left:5px;top:320px;width:45%;height:180px;border:0"></iframe>
                    </div>
                  </div>
                  <button id="outside" type="button" style="margin-top:30px">聊天室範圍</button>
                  <div id="chat-scroll" tabindex="0" style="position:fixed;right:0;top:400px;width:90px;height:220px;overflow:auto;background:#242424"><div style="height:1200px">聊天室</div></div>
                </main>
                <script>
                window.fixture = { clicks:{}, changes:[], removedMedia:0, mediaCalls:[], original:new Map(), frameLoads:0 };
                function toggleChannelMenu(){fixture.clicks.channels=(fixture.clicks.channels||0)+1}
                function toggleAllAudio(){const b=document.getElementById('toggle-all-audio');fixture.clicks.audio=(fixture.clicks.audio||0)+1;b.textContent=b.textContent.includes('靜音')?'🔊 全部開聲':'🔇 全部靜音';b.setAttribute('aria-pressed',String(b.textContent.includes('開聲')))}
                function toggleChannelSelection(){fixture.clicks.watch=(fixture.clicks.watch||0)+1}
                for(const [id,name] of [['logout-btn','logout'],['layout-bookmarks-btn','bookmarks']]) document.getElementById(id).addEventListener('click',()=>fixture.clicks[name]=(fixture.clicks[name]||0)+1);
                document.getElementById('toggleNotLive').addEventListener('change',event=>{fixture.clicks.offline=(fixture.clicks.offline||0)+1;localStorage.setItem('fixture-offline',event.target.checked)});
                document.getElementById('channel-actions').addEventListener('change',event=>{fixture.changes.push(event.target.value);event.target.value=''});
                for(const id of ${JSON.stringify(originalIds)}) fixture.original.set(id,document.getElementById(id));
                fixture.media=[...document.querySelectorAll('#multi-stream-container video,#multi-stream-container iframe')];
                for(const element of fixture.media){for(const method of ['load','play','pause']) if(element[method]) {const actual=element[method].bind(element);element[method]=(...args)=>{fixture.mediaCalls.push([element.id,method]);return actual(...args)}}}
                new MutationObserver(records=>{for(const record of records)for(const removed of record.removedNodes)for(const element of fixture.media)if(removed===element||removed.contains?.(element))fixture.removedMedia++}).observe(document.getElementById('multi-stream-container'),{childList:true,subtree:true});
                fixture.identity=()=>({sameControls:${JSON.stringify(originalIds)}.every(id=>fixture.original.get(id)===document.getElementById(id)),uniqueControls:${JSON.stringify(originalIds)}.every(id=>document.querySelectorAll('#'+id).length===1),mediaConnected:fixture.media.every(element=>element.isConnected),removedMedia:fixture.removedMedia,mediaCalls:fixture.mediaCalls.slice()});
                </script></body></html>` });
            if (url === frameUrl) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><button id="frame-button" style="width:100%;height:100px">播放器</button>' });
        }
        if (new URL(url).pathname === '/silent.wav') return route.fulfill({ contentType: 'audio/wav', body: silentWav() });
        if (/\/assets\/(?:images\/)?[^/]+\.png$/.test(new URL(url).pathname)) {
            const imageName=path.basename(new URL(url).pathname);
            const migratedImage=path.join(root,'site','assets','images',imageName);
            const image=fs.existsSync(migratedImage)?migratedImage:path.join(root,'assets',imageName);
            if(fs.existsSync(image)) return route.fulfill({contentType:'image/png',body:fs.readFileSync(image)});
            return route.fulfill({ status: 204, body: '' });
        }
        blocked.push(url); return route.abort();
    });
    await page.goto(siteUrl, { waitUntil: 'load' });
    await page.addScriptTag({ content: readSite('assets/js/menu-dismiss.js', 'menu-dismiss.js') });
    await page.addScriptTag({ content: readSite('assets/js/topbar-menu.js', 'topbar-menu.js') });
    await page.evaluate(() => {
        document.getElementById('lists').innerHTML=Array.from({length:24},(_,i)=>'<button class="status-button live">Ⓐ 台'+i+'</button>').join('');
        window.topbarOptionsMenu=UmininnTopbarMenu.create({window,document});topbarOptionsMenu.start();
    });
    await page.waitForFunction(() => Boolean(window.topbarOptionsMenu));
    await page.evaluate(() => {
        fixture.events=[];
        for(const type of ['pointerdown','mousedown','pointerup','mouseup','click','focusin','focusout']) document.addEventListener(type,event=>fixture.events.push({type,target:event.target.id||event.target.tagName,active:document.activeElement?.id,open:topbarOptionsMenu.opened}),true);
    });
    if (userscript) await addUserscript(page);
    t.after(async () => {
        assert.deepEqual(errors, [], 'no browser runtime errors');
        assert.deepEqual(blocked, [], 'test content stays within routed local fixtures');
        assert.deepEqual(navigations, [siteUrl, frameUrl], 'toolbar changes never navigate or reload the player iframe');
    });
    return page;
}

async function addUserscript(page) {
    const script = readSite('userscript/umininn-tv-player.user.js', 'userscript/umininn-tv-player.user.js');
    await page.addScriptTag({ content: script });
    await page.locator('#umininn-player-control-host').waitFor({ state: 'attached' });
    await page.evaluate(() => {
        fixture.userscriptHost=document.getElementById('umininn-player-control-host');
        fixture.userscriptShadow=fixture.userscriptHost.shadowRoot;
        fixture.userscriptToggle=fixture.userscriptShadow.getElementById('toggle');
    });
}

async function open(page) {
    if (await page.locator(trigger).getAttribute('aria-expanded') !== 'true') await page.locator(trigger).click();
    assert.equal(await page.locator(menu).isVisible(), true, 'options are visible after the genuine click');
}
async function assertIdentity(page) {
    assert.deepEqual(await page.evaluate(() => fixture.identity()), {
        sameControls:true, uniqueControls:true, mediaConnected:true, removedMedia:0, mediaCalls:[]
    }, 'controls retain identity/listeners, existing videos and iframes remain mounted without media calls');
}
async function noClipping(page, selector) {
    const rect = await page.locator(selector).boundingBox();
    const viewport = page.viewportSize();
    assert.ok(rect && rect.x >= -0.5 && rect.x + rect.width <= viewport.width + 0.5, selector + ' fits within the actual viewport: ' + JSON.stringify(rect));
}

for (const width of [320,375,495,768,769,1024,1440]) {
    test(`responsive topbar remains visible and operable at ${width}px`, cases, async t => {
        const page = await fixture(t, {width});
        const compact = await page.evaluate(() => topbarOptionsMenu.compact);
        assert.equal(await page.locator(trigger).isVisible(), compact);
        if (width <= 768) assert.equal(compact, true, 'narrow screens always use the options dropdown');
        if (compact) {
            await noClipping(page, trigger); await open(page); await noClipping(page, menu);
            for (const id of ['hideNotLiveToggle','topbar-tasks-btn','logout-btn','toggle-all-audio','more-channels-btn','layout-bookmarks-btn']) {
                assert.equal(await page.locator('#'+id).isVisible(), true, id + ' is reachable');
                await noClipping(page, '#'+id);
            }
            const order = await page.locator(menu).evaluate(panel => [...panel.querySelectorAll('#hideNotLiveToggle,#topbar-tasks-btn,#logout-btn,#toggle-all-audio,#more-channels-btn,#layout-bookmarks-btn')].map(element=>element.id));
            assert.deepEqual(order,['hideNotLiveToggle','topbar-tasks-btn','logout-btn','toggle-all-audio','more-channels-btn','layout-bookmarks-btn']);
        } else {
            for(const id of ['hideNotLiveToggle','channel-actions','logout-btn','toggle-all-audio','more-channels-btn','layout-bookmarks-btn']) await noClipping(page,'#'+id);
        }
        if(width<=768) {
            assert.equal(await page.locator('#mobile-menu-btn').isVisible(),true,'mobile channel list remains reachable beside the options dropdown');
            await noClipping(page,'#mobile-menu-btn');
        } else assert.ok(await page.locator('#channel-strip').evaluate(element=>element.getBoundingClientRect().width > 0), 'desktop channel strip retains usable width');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true,'toolbar does not widen the document');
        await assertIdentity(page);
    });
}

test('compact menu keeps native checkbox, task destination, mute, watch, bookmark and logout handlers exactly once', cases, async t => {
    const page=await fixture(t);
    await open(page);
    await page.locator('#hideNotLiveToggle').click();
    assert.equal(await page.locator('#toggleNotLive').isChecked(),true,JSON.stringify(await page.evaluate(()=>fixture.events)));
    assert.equal(await page.evaluate(()=>localStorage.getItem('fixture-offline')),'true');
    await page.locator(taskTrigger).click();
    assert.equal(await page.locator(taskPanel).isVisible(),true);
    await page.locator(taskPanel).getByRole('button',{name:'➕ 加台',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>fixture.changes),['new']);
    await open(page);await page.locator('#toggle-all-audio').click();
    await open(page);assert.match(await page.locator('#toggle-all-audio').textContent(),/全部開聲/);
    await page.locator('#more-channels-btn').click();
    await open(page);await page.locator('#layout-bookmarks-btn').click();
    await open(page);await page.locator('#logout-btn').click();
    assert.deepEqual(await page.evaluate(()=>fixture.clicks),{offline:1,audio:1,watch:1,bookmarks:1,logout:1});
    assert.equal(await page.locator(menu).isVisible(),false);
    await assertIdentity(page);
});

test('options close on outside click, foreign player interaction, native chat scrollbar and Escape', cases, async t => {
    const page=await fixture(t);
    await open(page);await page.locator('#outside').click();
    assert.equal(await page.locator(menu).isVisible(),false,'outside chat area closes menu');
    await open(page);await page.frameLocator('#fixture-frame').locator('#frame-button').click();
    await page.waitForFunction(()=>!topbarOptionsMenu.opened);
    await open(page);
    const box=await page.locator('#chat-scroll').boundingBox();
    await page.mouse.click(box.x+box.width-3,box.y+80);
    await page.waitForFunction(()=>!topbarOptionsMenu.opened);
    await open(page);await page.keyboard.press('Escape');
    assert.equal(await page.locator(menu).isVisible(),false);
    assert.equal(await page.locator(trigger).evaluate(element=>element===document.activeElement),true,'Escape returns keyboard focus to its opener');
    await assertIdentity(page);
});

test('keyboard can open options and 台務, run one action, and exit submenu without closing all options', cases, async t => {
    const page=await fixture(t);
    await page.locator(trigger).focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator(menu).isVisible(),true);
    await page.locator(taskTrigger).focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator(taskPanel).isVisible(),true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator(taskPanel).isVisible(),false);
    assert.equal(await page.locator(menu).isVisible(),true,'first Escape closes nested disclosure');
    await page.locator(taskTrigger).focus();await page.keyboard.press('Enter');
    await page.locator(taskPanel).getByRole('button',{name:'🧩 userscript',exact:true}).focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(()=>fixture.changes),['userscript']);
    await assertIdentity(page);
});

test('compact hide-offline switch is keyboard reachable and retains its one original listener through resizes', cases, async t => {
    const page=await fixture(t);
    await page.locator(trigger).focus();await page.keyboard.press('Enter');
    const checkbox=page.locator('#toggleNotLive');
    await checkbox.focus();
    assert.equal(await checkbox.evaluate(element=>element===document.activeElement),true,'visually styled checkbox still accepts keyboard focus');
    await page.keyboard.press('Space');
    assert.equal(await checkbox.isChecked(),true);
    for(const width of [1440,375,1440,495]) {
        await page.setViewportSize({width,height:820});
        await page.evaluate(()=>topbarOptionsMenu.refresh());
        if(width<=768) await open(page);
        assert.equal(await checkbox.isChecked(),true,'the same checkbox value survives every move');
    }
    await checkbox.focus();await page.keyboard.press('Space');
    assert.equal(await checkbox.isChecked(),false);
    assert.equal(await page.evaluate(()=>fixture.clicks.offline),2,'one listener for each of the two real keyboard toggles');
    await assertIdentity(page);
});

test('options use 30 seconds of real inactivity and background label changes do not postpone dismissal', cases, async t => {
    const page=await fixture(t);
    await page.clock.install({time:new Date('2026-01-01T00:00:00Z')});
    await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
    await open(page);await page.clock.fastForward(29000);
    await page.locator(taskTrigger).click();
    await page.clock.fastForward(1000);
    assert.equal(await page.locator(menu).isVisible(),true,'genuine submenu operation starts another complete idle period');
    await page.evaluate(()=>document.getElementById('toggle-all-audio').textContent='🔊 全部開聲');
    await page.clock.fastForward(28999);
    assert.equal(await page.locator(menu).isVisible(),true);
    await page.clock.fastForward(1);
    assert.equal(await page.locator(menu).isVisible(),false,'background state changes cannot keep it open');
    await assertIdentity(page);
});

test('late built userscript remains the same live shadow host across compact/wide resizing', cases, async t => {
    const page=await fixture(t);
    assert.equal(await page.locator('#umininn-player-control-host').count(),0,'userscript row is absent until installed script actually injects');
    await open(page);await addUserscript(page);
    await page.waitForFunction(()=>document.getElementById('topbar-options-panel').contains(document.getElementById('umininn-player-control-host')));
    await noClipping(page,'#umininn-player-control-host');
    await page.locator('#umininn-player-control-host #toggle').click();
    assert.equal(await page.locator('#umininn-player-panel-host #panel').isVisible(),true);
    assert.equal(await page.locator(menu).isVisible(),false,'opening playback controls closes the topbar dropdown');
    await page.locator('#umininn-player-panel-host .heading button').click();
    for(const width of [1440,375,1024,320,1440,495]) {
        await page.setViewportSize({width,height:820});
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        await page.waitForFunction(()=>innerWidth<=768?topbarOptionsMenu.compact:true);
        if(await page.evaluate(()=>topbarOptionsMenu.compact)) await open(page);
        assert.equal(await page.evaluate(()=>fixture.userscriptHost===document.getElementById('umininn-player-control-host')&&fixture.userscriptShadow===fixture.userscriptHost.shadowRoot&&fixture.userscriptToggle===fixture.userscriptShadow.getElementById('toggle')),true,'script host/shadow/buttons are moved, never copied');
        assert.equal(await page.locator('#umininn-player-control-host').count(),1);
    }
    await page.locator('#umininn-player-control-host #toggle').click();
    assert.equal(await page.locator('#umininn-player-panel-host #panel').isVisible(),true,'original script click listener survives all moves');
    await assertIdentity(page);
});

test('real userscript global-audio interception executes once and still closes compact options', cases, async t => {
    const page=await fixture(t,{userscript:true});
    await page.waitForFunction(()=>document.getElementById('fixture-video').readyState>=2);
    await page.waitForFunction(()=>document.getElementById('toggle-all-audio').textContent.includes('全部開聲'));
    await page.evaluate(()=>{
        fixture.muteWrites=[];
        const video=document.getElementById('fixture-video'),property=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'muted');
        Object.defineProperty(video,'muted',{configurable:true,get(){return property.get.call(this)},set(value){fixture.muteWrites.push(Boolean(value));return property.set.call(this,value)}});
    });
    await open(page);await page.locator('#toggle-all-audio').click();
    await page.waitForFunction(()=>!topbarOptionsMenu.opened);
    await page.waitForFunction(()=>!document.getElementById('fixture-video').muted);
    assert.equal(await page.evaluate(()=>fixture.clicks.audio||0),0,'userscript capture keeps the original fallback handler suppressed');
    assert.equal(await page.evaluate(()=>fixture.muteWrites.filter(value=>!value).length),1,'the one click sends exactly one native unmute');
    assert.equal(await page.locator(menu).isVisible(),false,'capture-phase userscript interception cannot leave dropdown stuck open');
    await assertIdentity(page);
});

test('toolbar breakpoint responds to late shadow control width and keeps hysteresis without repeated reparenting', cases, async t => {
    const page=await fixture(t,{width:1440});
    await addUserscript(page);
    await page.evaluate(()=>fixture.compactChanges=0);
    await page.evaluate(()=>new MutationObserver(records=>fixture.compactChanges+=records.filter(r=>r.attributeName==='data-options-compact').length).observe(document.getElementById('top-bar'),{attributes:true}));
    await page.setViewportSize({width:769,height:820});
    await page.waitForFunction(()=>topbarOptionsMenu.compact);
    const before=await page.evaluate(()=>fixture.compactChanges);
    for(const width of [770,769,772,768,771,769]) {
        await page.setViewportSize({width,height:820});
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    }
    assert.equal(await page.evaluate(()=>fixture.compactChanges),before,'small viewport changes do not repeatedly move controls at the breakpoint');
    await open(page);
    await noClipping(page,'#umininn-player-control-host');
    await assertIdentity(page);
});

test('keyboard focus stays on a visible original control through responsive breakpoint changes', cases, async t => {
    const page=await fixture(t,{userscript:true});
    await page.locator(trigger).focus();await page.keyboard.press('Enter');
    await page.locator(taskTrigger).focus();await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator(taskPanel).isVisible(),true);
    await page.setViewportSize({width:1440,height:820});
    await page.waitForFunction(()=>!topbarOptionsMenu.compact);
    assert.equal(await page.locator('#channel-actions').evaluate(element=>element===document.activeElement),true,'submenu item maps back to its actual native select');
    await page.setViewportSize({width:495,height:820});
    await page.waitForFunction(()=>topbarOptionsMenu.compact);
    assert.equal(await page.locator(trigger).evaluate(element=>element===document.activeElement),true,'narrowing returns focus to visible opener');
    await page.keyboard.press('Enter');
    await page.locator('#more-channels-btn').focus();
    await page.setViewportSize({width:1440,height:820});
    await page.waitForFunction(()=>!topbarOptionsMenu.compact);
    assert.equal(await page.locator('#more-channels-btn').evaluate(element=>element===document.activeElement),true,'normal action keeps its exact original focused button');
    await page.setViewportSize({width:495,height:820});
    await page.waitForFunction(()=>topbarOptionsMenu.compact);
    await page.keyboard.press('Enter');
    await page.locator('#umininn-player-control-host #toggle').focus();
    await page.setViewportSize({width:1440,height:820});
    await page.waitForFunction(()=>!topbarOptionsMenu.compact);
    assert.equal(await page.evaluate(()=>fixture.userscriptHost.shadowRoot.activeElement===fixture.userscriptToggle),true,'shadow control retains real keyboard focus');
    await assertIdentity(page);
});

test('late script removal and reinsertion preserve one control host; disposing restores original controls', cases, async t => {
    const page=await fixture(t,{userscript:true});
    await open(page);
    await page.evaluate(()=>fixture.userscriptHost.remove());
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#umininn-player-control-host').count(),0);
    await page.evaluate(()=>document.getElementById('input-container').appendChild(fixture.userscriptHost));
    await page.waitForFunction(()=>document.getElementById('topbar-options-panel').contains(fixture.userscriptHost));
    assert.equal(await page.locator('#umininn-player-control-host').count(),1);
    await page.locator('#umininn-player-control-host #toggle').click();
    assert.equal(await page.locator('#umininn-player-panel-host #panel').isVisible(),true,'existing listener remains live after temporary removal');
    await page.locator('#umininn-player-panel-host .heading button').click();
    await page.setViewportSize({width:1440,height:820});
    await page.waitForFunction(()=>!topbarOptionsMenu.compact);
    await page.evaluate(()=>topbarOptionsMenu.dispose());
    assert.equal(await page.locator(menu).isVisible(),false);
    assert.equal(await page.locator(taskTrigger).count(),0);
    assert.equal(await page.locator(taskPanel).count(),0);
    assert.equal(await page.locator('#input-container > #channel-actions').count(),1);
    assert.equal(await page.locator('#channel-actions').isVisible(),true);
    await page.locator('#more-channels-btn').click();
    assert.equal(await page.evaluate(()=>fixture.clicks.watch),1,'dispose does not remove original action listener');
    await assertIdentity(page);
});

test('unchanged userscript status rewrites do not remeasure or move toolbar controls', cases, async t => {
    const page=await fixture(t,{userscript:true});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));
    await page.evaluate(()=>{
        fixture.measurements=0;fixture.controlMoves=0;
        const bar=document.getElementById('top-bar'),measure=bar.getBoundingClientRect.bind(bar);
        bar.getBoundingClientRect=(...args)=>{fixture.measurements++;return measure(...args)};
        new MutationObserver(records=>fixture.controlMoves+=records.reduce((sum,record)=>sum+record.addedNodes.length+record.removedNodes.length,0)).observe(document.getElementById('topbar-options-panel'),{childList:true});
    });
    for(let index=0;index<8;index++) await page.evaluate(()=>{
        const native=document.getElementById('toggle-all-audio'),shadow=fixture.userscriptHost.shadowRoot.getElementById('quick-mute');
        native.textContent=native.textContent;shadow.textContent=shadow.textContent;
        return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    });
    assert.deepEqual(await page.evaluate(()=>({measurements:fixture.measurements,controlMoves:fixture.controlMoves})),{measurements:0,controlMoves:0},'identical background labels do not force toolbar layout measurement or reparent controls');
    await assertIdentity(page);
});

test('short viewport scrolls options and task submenu without clipping the last command or playback panel', cases, async t => {
    const page=await fixture(t,{width:320,userscript:true});
    await page.setViewportSize({width:320,height:280});
    await open(page);await page.locator(taskTrigger).click();
    const userscriptAction=page.locator(taskPanel).getByRole('button',{name:'🧩 userscript',exact:true});
    await userscriptAction.scrollIntoViewIfNeeded();await userscriptAction.click();
    assert.deepEqual(await page.evaluate(()=>fixture.changes),['userscript']);
    await open(page);
    await page.locator('#umininn-player-control-host #toggle').scrollIntoViewIfNeeded();
    await page.locator('#umininn-player-control-host #toggle').click();
    const playback=await page.locator('#umininn-player-panel-host #panel').boundingBox();
    assert.ok(playback&&playback.x>=0&&playback.y>=0&&playback.x+playback.width<=320.5&&playback.y+playback.height<=280.5,'playback controls opened from dropdown remain inside short viewport: '+JSON.stringify(playback));
    await assertIdentity(page);
});

test('BFcache pagehide closes transient options and pageshow restores usable controls once', cases, async t => {
    const page=await fixture(t);
    await open(page);await page.locator(taskTrigger).click();
    await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
    assert.equal(await page.locator(menu).isVisible(),false);
    await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
    await open(page);await page.locator('#more-channels-btn').click();
    assert.equal(await page.evaluate(()=>fixture.clicks.watch),1,'restore does not duplicate action listeners');
    await assertIdentity(page);
});

test('responsive toolbar screenshots cover narrow and wide production controls', cases, async t => {
    const page=await fixture(t,{userscript:true});
    const output=path.join(root,'outputs');fs.mkdirSync(output,{recursive:true});
    await open(page);await page.locator(taskTrigger).click();
    await page.screenshot({path:path.join(output,`topbar-menu-${engine}-${process.env.UMININN_BROWSER_LABEL||'browser'}-495.png`)});
    await page.setViewportSize({width:1440,height:820});
    await page.waitForFunction(()=>!topbarOptionsMenu.compact);
    await page.screenshot({path:path.join(output,`topbar-menu-${engine}-${process.env.UMININN_BROWSER_LABEL||'browser'}-1440.png`)});
    await assertIdentity(page);
});
