'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// The full production bundle runs in real native and foreign media documents.
// Reuse setup without registering the unrelated layout tests a second time.
const harnessFile = path.join(__dirname, 'player-layout-browser.test.cjs');
let harnessSource = fs.readFileSync(harnessFile, 'utf8');
// Adapt only the in-memory fixture: an initially offline Kick document cannot
// satisfy the shared model's normal video-readiness bootstrap. Keep the large
// shared harness unchanged and fail loudly if any reviewed seam moves.
function fixtureSeam(before, after) {
    assert.equal(harnessSource.split(before).length, 2, 'unique offline fixture seam: ' + before.slice(0, 85));
    harnessSource = harnessSource.replace(before, after);
}
fixtureSeam("const root = path.resolve(__dirname, '..');",
    "const root = process.env.UMININN_EMPTY_PEER_ASSET_ROOT || path.resolve(__dirname, '..');");
fixtureSeam("require('../tools/build-player-userscript.cjs').RELEASE_VERSION",
    "(process.env.UMININN_EMPTY_PEER_VERSION || require('../tools/build-player-userscript.cjs').RELEASE_VERSION)");
fixtureSeam('audioUserscript=false,lateAudioFrame=null,fixtureBrowser=browser}={})',
    'audioUserscript=false,lateAudioFrame=null,offlinePeer=false,fixtureBrowser=browser}={})');
fixtureSeam('data-fixture-audio-userscript="${audioUserscript}">',
    'data-fixture-audio-userscript="${audioUserscript}" data-fixture-offline-peer="${offlinePeer}">');
fixtureSeam("element.src='${frameOrigin}/player?index='+index;",
    "element.src=document.body.dataset.fixtureOfflinePeer==='true'&&index===2?'${frameOrigin}/yinlove/offline':'${frameOrigin}/player?index='+index;");
fixtureSeam("    await context.route('**/*',route=>{",
    "    const offlineChild=fs.readFileSync(path.join(__dirname,'fixtures/kick-offline.html'),'utf8').replace('<!-- FIXTURE_INSTRUMENT -->','<script>'+instrument+'</script>');\n" +
    "    await context.route('**/*',route=>{");
fixtureSeam("            if(url.origin===modelFrameOrigin&&['/player','/layout-added'].includes(url.pathname))return route.fulfill({contentType:'text/html',body:child});",
    "            if(offlinePeer&&url.origin===modelFrameOrigin&&url.pathname==='/yinlove/offline')return route.fulfill({contentType:'text/html',body:offlineChild});\n" +
    "            if(url.origin===modelFrameOrigin&&['/player','/layout-added'].includes(url.pathname))return route.fulfill({contentType:'text/html',body:child});");
fixtureSeam('    for(const frame of frames)await frame.waitForFunction(()=>fixtureMedia[0]?.video.readyState>=2);',
    '    for(const [index,frame]of frames.entries())if(!offlinePeer||index!==0)await frame.waitForFunction(()=>fixtureMedia[0]?.video.readyState>=2);');
fixtureSeam('    for(const [index,frame]of frames.entries())await frame.evaluate(async index=>{const video=fixtureMedia[0].video;',
    '    for(const [index,frame]of frames.entries())if(!offlinePeer||index!==0)await frame.evaluate(async index=>{const video=fixtureMedia[0].video;');
fixtureSeam("    if(audioUserscript)await page.waitForFunction(lateAudioFrame=>{",
    "    if(audioUserscript)await page.waitForFunction(({lateAudioFrame,offlinePeer})=>{");
fixtureSeam("return rows?.length===5&&Array.from(rows).every((row,index)=>index===lateAudioFrame||!row.querySelector('input').disabled);",
    "return rows?.length===5&&Array.from(rows).every((row,index)=>index===lateAudioFrame||offlinePeer&&index===2||!row.querySelector('input').disabled);");
fixtureSeam('    },lateAudioFrame);', '    },{lateAudioFrame,offlinePeer});');
fixtureSeam("if(window.top!==window&&new URL(location.href).searchParams.get('index')===",
    "if(${lateAudioFrame!==null}&&window.top!==window&&new URL(location.href).searchParams.get('index')===");
const harnessRequire = createRequire(harnessFile);
const harnessTest = Object.assign(() => {}, { before: test.before, after: test.after });
const harnessModule = { exports: {} };
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + harnessSource + '\n' +
    'module.exports={fixture,snapshot,primeAudio,waitOnlyAudible,waitFocusStatus,actualMouseWindowAction,assertAudioContinuity,optional,wav};\n})',
    { filename: harnessFile })(name => name === 'node:test' ? harnessTest : harnessRequire(name),
    harnessModule, harnessModule.exports, __dirname, harnessFile);
const { fixture, snapshot, primeAudio, waitOnlyAudible, waitFocusStatus,
    actualMouseWindowAction, assertAudioContinuity, optional, wav } = harnessModule.exports;
const enabled = process.env.UMININN_BROWSER_TESTS === '1';
const panel = '#umininn-player-panel-host';

async function setup(t, { offlinePeer = false } = {}) {
    if (!optional(t)) return null;
    const f = await fixture(t, { width: 1400, height: 850, audioUserscript: true, offlinePeer });
    if (offlinePeer) for (const frame of f.frames) assert.equal(await frame.evaluate(() => typeof fixtureMedia), 'object',
        'the closed fixture instrumentation must bootstrap at ' + frame.url());
    f.keys = await f.page.evaluate(() => fixture.keys);
    f.peerName = await f.page.evaluate(key => activePlayers.get(key).channel.name, f.keys[2]);
    f.targetName = await f.page.evaluate(key => activePlayers.get(key).channel.name, f.keys[0]);
    if (offlinePeer) {
        await f.page.evaluate(() => { for (const saved of fixtureMedia) saved.video.muted = true; });
        for (const frame of f.frames) await frame.evaluate(() => { for (const saved of fixtureMedia) saved.video.muted = true; });
        await f.page.waitForFunction(() => [...document.getElementById('umininn-player-panel-host').shadowRoot.querySelectorAll('.player')]
            .every((row, index) => index === 2 || row.querySelector('button').getAttribute('aria-pressed') === 'true'));
    } else await primeAudio(f);
    await f.page.evaluate(() => {
        window.fixtureEmptyReports = [];
        addEventListener('message', event => {
            const frame = document.getElementById('frame-2'), data = event.data;
            if (frame && event.source === frame.contentWindow && data?.channel === 'umininn-tv-userscript' &&
                ['frame:ready', 'userscript:result'].includes(data.type)) {
                fixtureEmptyReports.push({ type: data.type, result: data.result });
            }
        });
    });
    return f;
}
async function makePeerEmpty(f) {
    await f.frames[0].evaluate(() => {
        window.fixtureOfflineVideo = fixtureMedia[0].video;
        fixtureOfflineVideo.remove();
    });
    await f.page.waitForFunction(() => fixtureEmptyReports.some(report => report.result?.code === 'NO_MEDIA' &&
        report.result.state?.available === false));
}
async function waitPeerProof(f, expected = true, { after = 0 } = {}) {
    await f.page.waitForFunction(({ expected, after }) => fixtureEmptyReports.slice(after).some(report =>
        (expected ? report.result?.code === 'NO_MEDIA' : ['NO_MEDIA', 'NOT_APPLIED'].includes(report.result?.code)) &&
        report.result.state?.available === false && report.result.state?.muteGuardActive === true &&
        report.result.state?.emptyGuardConfirmed === expected), { expected, after });
}
async function nativeStates(f) {
    return f.page.evaluate(() => fixtureMedia.map(({ video }) => ({ muted: video.muted, volume: video.volume })));
}
function peerRow(f) { return f.page.locator(panel + ' .player').filter({ hasText: f.peerName }); }

const offlineHtml = fs.readFileSync(path.join(__dirname, 'fixtures/kick-offline.html'), 'utf8');
async function offlineMedia(f) {
    const main = await f.page.evaluate(() => fixtureMedia.filter(saved => saved.video.isConnected)
        .map(({ video }) => ({ endpoint: 'main:' + video.id, muted: video.muted, volume: video.volume })));
    const frames = await Promise.all(f.frames.map((frame, index) => frame.evaluate(index => {
        const found = [];
        function visit(doc, path) {
            for (const media of doc.querySelectorAll('video,audio'))
                found.push({ endpoint: path + ':' + media.id, muted: media.muted, volume: media.volume });
            for (const [childIndex, child] of [...doc.querySelectorAll('iframe')].entries()) {
                try { if (child.contentDocument) visit(child.contentDocument, path + '/child-' + childIndex); } catch (_) {}
            }
        }
        visit(document, 'frame-' + index);
        return found;
    }, index)));
    return [...main, ...frames.flat()];
}
async function waitOfflineAudible(f, key, { timeout = 8000 } = {}) {
    const index = f.keys.indexOf(key);
    const endpoint = index === 3 ? 'frame-1:frame-video' : 'main:native-' + index;
    const deadline = Date.now() + timeout;
    let state;
    do {
        state = await offlineMedia(f);
        if (state.some(media => media.endpoint === endpoint && media.muted === false && media.volume === 1) &&
            state.every(media => media.muted === (media.endpoint !== endpoint))) return state;
        await f.page.waitForTimeout(60);
    } while (Date.now() < deadline);
    const reports = await f.page.evaluate(() => fixtureEmptyReports.slice(-4));
    assert.fail('Offline-peer sound did not converge: ' + JSON.stringify({ endpoint, state, reports }));
}
async function showOfflineStructure(f) {
    await f.frames[0].evaluate(html => {
        window.fixtureOfflineVideo ||= fixtureMedia[0].video;
        const offline = new DOMParser().parseFromString(html, 'text/html');
        document.body.replaceChildren(...[...offline.body.children].filter(node => ['MAIN', 'IFRAME'].includes(node.tagName)));
    }, offlineHtml);
    await f.frames[0].waitForFunction(() => {
        const blank = document.getElementById('kick-offline-blank');
        return blank?.contentDocument?.readyState === 'complete';
    });
}
async function addControlledChildAudio(f, suffix) {
    await f.frames[0].evaluate(async suffix => {
        const child = document.getElementById('kick-offline-blank').contentDocument;
        const audio = child.createElement('audio'); audio.id = 'child-audio-' + suffix;
        audio.src = location.origin + '/silent.wav?child=' + suffix;
        audio.loop = true; audio.style.display = 'none'; audio.volume = .72; audio.muted = false;
        instrumentMedia(audio); window.fixtureLatestChildAudio = audio;
        child.body.appendChild(audio);
        await audio.play();
    }, suffix);
    await f.frames[0].waitForFunction(() => fixtureLatestChildAudio.readyState >= 2 &&
        fixtureLatestChildAudio.isConnected && fixtureLatestChildAudio.ownerDocument ===
            document.getElementById('kick-offline-blank').contentDocument &&
        fixtureLatestChildAudio.muted === true && fixtureLatestChildAudio.paused === false);
}

test('offline structure: an initially offline Kick peer with a hidden readable blank child permits every existing native and foreign target',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t, { offlinePeer: true }); if (!f) return;
        assert.equal(new URL(f.frames[0].url()).pathname, '/yinlove/offline');
        assert.deepEqual(await f.frames[0].evaluate(() => {
            const blank = document.getElementById('kick-offline-blank'), child = blank.contentDocument;
            return { media: document.querySelectorAll('video,audio').length,
                custom: [...document.querySelectorAll('*')].filter(node => node.tagName.includes('-')).length,
                hidden: getComputedStyle(blank).visibility === 'hidden', childUrl: child.URL,
                childNodes: [...child.querySelectorAll('*')].map(node => node.tagName),
                childMedia: child.querySelectorAll('video,audio').length, childScripts: child.scripts.length };
        }), { media: 0, custom: 0, hidden: true, childUrl: 'about:blank',
            childNodes: ['HTML', 'HEAD', 'BODY'], childMedia: 0, childScripts: 0 });
        const before = await snapshot(f);
        for (const index of [0, 1, 4, 3]) {
            await actualMouseWindowAction(f, f.keys[index], 'audio-focus');
            await waitOfflineAudible(f, f.keys[index]);
            await waitFocusStatus(f, '只開啟');
            await waitPeerProof(f);
        }
        await assertAudioContinuity(f, before);
    });

test('offline structure: repeated live to offline to live transitions guard late parent video and hidden child audio',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        const frameIdentity = await f.frames[0].evaluate(() => fixtureId);
        for (let cycle = 0; cycle < 2; cycle++) {
            await showOfflineStructure(f);
            const target = f.keys[cycle];
            await actualMouseWindowAction(f, target, 'audio-focus');
            await waitOfflineAudible(f, target); await waitPeerProof(f);
            await addControlledChildAudio(f, 'cycle-' + cycle);
            await waitOfflineAudible(f, target);
            await f.frames[0].evaluate(async () => {
                const video = fixtureOfflineVideo;
                document.getElementById('offline-root').remove();
                video.muted = false; video.volume = .67; document.body.appendChild(video);
                await video.play();
            });
            await f.frames[0].waitForFunction(() => fixtureOfflineVideo.isConnected && fixtureOfflineVideo.muted === true &&
                fixtureLatestChildAudio.isConnected && fixtureLatestChildAudio.ownerDocument ===
                    document.getElementById('kick-offline-blank').contentDocument && fixtureLatestChildAudio.muted === true);
            await waitOfflineAudible(f, target);
            const before = await snapshot(f);
            await actualMouseWindowAction(f, f.keys[3], 'audio-focus');
            await waitOfflineAudible(f, f.keys[3]);
            await assertAudioContinuity(f, before);
        }
        assert.equal(await f.frames[0].evaluate(() => fixtureId), frameIdentity);
        assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
    });

test('offline structure: audio later inserted into the readable blank child is actually muted by the all-media guard',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t, { offlinePeer: true }); if (!f) return;
        await actualMouseWindowAction(f, f.keys[0], 'audio-focus');
        await waitOfflineAudible(f, f.keys[0]); await waitPeerProof(f);
        await addControlledChildAudio(f, 'late');
        await waitOfflineAudible(f, f.keys[0]);
        const saved = await f.frames[0].evaluate(() => readMedia(fixtureMedia.find(saved => saved.video === fixtureLatestChildAudio)));
        assert.equal(saved.muted, true); assert.equal(saved.volume, .72); assert.equal(saved.paused, false);
        assert.deepEqual(saved.actions, { play: 1, pause: 0, load: 0, seek: 0, source: 0 },
            'the platform alone starts its hidden child audio; the controller only mutes it');
        const before = await snapshot(f);
        await actualMouseWindowAction(f, f.keys[4], 'audio-focus');
        await waitOfflineAudible(f, f.keys[4]);
        await assertAudioContinuity(f, before);
    });

test('offline structure: a blank child navigating to an opaque audible player revokes sound until a readable empty document returns',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t, { offlinePeer: true }); if (!f) return;
        const origin = 'https://offline-player-opaque.invalid';
        await f.page.context().route(origin + '/**', route => {
            const url = new URL(route.request().url());
            if (url.pathname === '/silent.wav') return route.fulfill({ contentType: 'audio/wav', body: wav });
            return route.fulfill({ contentType: 'text/html', body: '<!doctype html><audio id="opaque-audio" loop src="/silent.wav"></audio>' });
        });
        await actualMouseWindowAction(f, f.keys[0], 'audio-focus');
        await waitOfflineAudible(f, f.keys[0]); await waitPeerProof(f);
        const fromReport = await f.page.evaluate(() => fixtureEmptyReports.length);
        await f.frames[0].evaluate(origin => {
            const child = document.getElementById('kick-offline-blank');
            child.allow = 'autoplay'; child.src = origin + '/player';
        }, origin);
        const child = f.frames[0].childFrames()[0];
        await child.waitForURL(origin + '/player');
        await child.waitForFunction(() => document.getElementById('opaque-audio')?.readyState >= 2);
        await child.evaluate(async () => { const audio = document.getElementById('opaque-audio'); audio.volume = .64; audio.muted = false; await audio.play(); });
        await f.page.waitForFunction(from => fixtureEmptyReports.slice(from).some(report =>
            report.result?.state?.emptyGuardConfirmed === false), fromReport);
        await f.page.waitForFunction(() => fixtureMedia.every(saved => saved.video.muted));
        await actualMouseWindowAction(f, f.keys[4], 'audio-focus');
        await waitFocusStatus(f, '未開啟');
        assert.ok((await nativeStates(f)).every(state => state.muted));
        assert.equal(await child.evaluate(() => document.getElementById('opaque-audio').muted), false,
            'opaque child audio remains genuinely outside the controller');
        const warning = await f.page.locator(panel + ' #audio-focus-status').textContent();
        assert.ok(warning.includes(f.peerName), warning);
        await f.frames[0].evaluate(() => { document.getElementById('kick-offline-blank').src = 'about:blank'; });
        await child.waitForURL('about:blank');
        await child.waitForFunction(() => document.readyState === 'complete' && document.querySelectorAll('video,audio').length === 0);
        await actualMouseWindowAction(f, f.keys[4], 'audio-focus');
        await waitOfflineAudible(f, f.keys[4]);
        await waitFocusStatus(f, '只開啟');
        assert.deepEqual(await f.page.evaluate(() => fixture.identity()),
            { elements: true, entries: true, windows: true, removals: 0, frameSources: 0, loads: [1, 1] });
        assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
    });

test('offline structure: the initially empty selected Kick target never receives a volume opening or unmute',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t, { offlinePeer: true }); if (!f) return;
        await actualMouseWindowAction(f, f.keys[0], 'audio-focus');
        await waitOfflineAudible(f, f.keys[0]);
        const start = await f.frames[0].evaluate(() => fixtureAudioMessages.length);
        const before = await snapshot(f);
        await actualMouseWindowAction(f, f.keys[2], 'audio-focus');
        await f.page.waitForFunction(() => fixtureMedia.every(saved => saved.video.muted));
        await waitFocusStatus(f, '未開啟');
        assert.ok((await offlineMedia(f)).every(media => media.muted));
        const opening = await f.frames[0].evaluate(start => fixtureAudioMessages.slice(start).filter(message =>
            message.type === 'userscript:command' &&
            (message.command?.action === 'setMuted' && message.command.value === false ||
                message.command?.action === 'setVolume' && message.command.focus === true)), start);
        assert.deepEqual(opening, []);
        await assertAudioContinuity(f, before);
    });

test('offline structure: a slow opaque child returning to an empty readable page safely restores the last target without another sound click',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t, { offlinePeer: true }); if (!f) return;
        const origin = 'https://offline-player-slow-opaque.invalid';
        await f.page.context().route(origin + '/**', route => {
            const url = new URL(route.request().url());
            if (url.pathname === '/silent.wav') return route.fulfill({ contentType: 'audio/wav', body: wav });
            return route.fulfill({ contentType: 'text/html', body: '<!doctype html><audio id="opaque-audio" loop src="/silent.wav"></audio>' });
        });
        const before = await snapshot(f);
        await actualMouseWindowAction(f, f.keys[0], 'audio-focus');
        await waitOfflineAudible(f, f.keys[0]); await waitPeerProof(f);
        await f.frames[0].evaluate(origin => {
            const child = document.getElementById('kick-offline-blank');
            child.allow = 'autoplay'; child.src = origin + '/player';
        }, origin);
        const child = f.frames[0].childFrames()[0];
        await child.waitForURL(origin + '/player');
        await child.waitForFunction(() => document.getElementById('opaque-audio')?.readyState >= 2);
        await child.evaluate(async () => { const audio = document.getElementById('opaque-audio'); audio.volume = .64; audio.muted = false; await audio.play(); });
        await f.page.waitForFunction(() => fixtureMedia.every(saved => saved.video.muted));
        // A real event-driven restoration must survive more than a brief scan
        // or initial retry window. No further sound action is sent below.
        await f.page.waitForTimeout(1500);
        assert.ok((await nativeStates(f)).every(state => state.muted));
        assert.equal(await child.evaluate(() => document.getElementById('opaque-audio').muted), false);
        await f.frames[0].evaluate(() => { document.getElementById('kick-offline-blank').src = 'about:blank'; });
        await child.waitForURL('about:blank');
        await child.waitForFunction(() => document.readyState === 'complete' && document.querySelectorAll('*').length === 3);
        await waitOfflineAudible(f, f.keys[0]);
        await waitFocusStatus(f, '只開啟');
        await assertAudioContinuity(f, before);
    });

test('empty peer: a confirmed offline foreign player does not block the original native sound button',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        await makePeerEmpty(f);
        const before = await snapshot(f);
        await actualMouseWindowAction(f, f.keys[0], 'audio-focus');
        await waitPeerProof(f);
        await waitOnlyAudible(f, 0);
        await waitFocusStatus(f, '只開啟');
        const state = await nativeStates(f);
        assert.equal(state[0].muted, false); assert.equal(state[0].volume, 1);
        assert.ok(state.slice(1).every(value => value.muted));
        const proof = await f.page.evaluate(() => fixtureEmptyReports.filter(report =>
            report.result?.state?.emptyGuardConfirmed === true).at(-1).result);
        assert.equal(proof.state.available, false);
        assert.equal(proof.state.muteSupported, false);
        assert.notEqual(proof.state.muted, false, 'the empty peer cannot be reported as actually open');
        await assertAudioContinuity(f, before);
    });

test('empty peer: newly arriving foreign media inherit the guard while the selected native tile keeps sound',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        await makePeerEmpty(f);
        await actualMouseWindowAction(f, f.keys[0], 'audio-focus');
        await waitPeerProof(f); await waitOnlyAudible(f, 0);
        const before = await snapshot(f);
        const originalPlayCalls = before.frames[0].media[0].actions.play;
        await f.frames[0].evaluate(async () => {
            // A platform resumes its own previously absent player. The test
            // makes this explicit; the controller must never initiate playback.
            const video = fixtureOfflineVideo;
            video.muted = false; video.volume = .67;
            document.body.appendChild(video);
            await video.play();
        });
        await f.frames[0].waitForFunction(() => fixtureOfflineVideo.muted === true);
        await waitOnlyAudible(f, 0);
        await f.page.waitForTimeout(450);
        await waitOnlyAudible(f, 0);
        const after = await snapshot(f);
        assert.equal(after.frames[0].id, before.frames[0].id);
        assert.equal(after.frames[0].media[0].actions.play, originalPlayCalls + 1,
            'only the platform fixture explicitly resumes its late player');
        for (const action of ['pause', 'load', 'seek', 'source'])
            assert.equal(after.frames[0].media[0].actions[action], before.frames[0].media[0].actions[action]);
        for (let index = 0; index < after.main.length; index++) {
            const omitTime = ({ time, ...rest }) => rest;
            assert.deepEqual(omitTime(after.main[index]), omitTime(before.main[index]));
        }
        assert.deepEqual(await f.page.evaluate(() => fixture.identity()),
            { elements: true, entries: true, windows: true, removals: 0, frameSources: 0, loads: [1, 1] });
        assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
    });

test('empty peer: an empty selected target stays silent and never receives an opening volume or unmute',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        await makePeerEmpty(f);
        const before = await snapshot(f);
        await actualMouseWindowAction(f, f.keys[2], 'audio-focus');
        await waitPeerProof(f);
        await f.page.waitForTimeout(650);
        assert.ok((await nativeStates(f)).every(state => state.muted));
        assert.equal(await f.frames[1].evaluate(() => fixtureMedia[0].video.muted), true);
        const opening = await f.frames[0].evaluate(() => fixtureAudioMessages.filter(message =>
            message.type === 'userscript:command' &&
            (message.command?.action === 'setMuted' && message.command.value === false ||
                message.command?.action === 'setVolume' && message.command.focus === true)));
        assert.deepEqual(opening, [], 'an empty target cannot become a guessed opening endpoint');
        await assertAudioContinuity(f, before);
    });

test('empty peer: an inaccessible nested player still blocks opening and identifies the actual peer in the warning',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        await makePeerEmpty(f);
        const opaqueOrigin = 'https://empty-peer-opaque.invalid';
        await f.page.context().route(opaqueOrigin + '/**', route => {
            const url = new URL(route.request().url());
            if (url.pathname === '/silent.wav') return route.fulfill({ contentType: 'audio/wav', body: wav });
            return route.fulfill({ contentType: 'text/html', body: '<!doctype html><audio id="opaque-audio" loop src="/silent.wav"></audio>' });
        });
        await f.frames[0].evaluate(origin => {
            const child = document.createElement('iframe'); child.id = 'opaque-nested-player';
            child.allow = 'autoplay'; child.src = origin + '/player'; document.body.appendChild(child);
        }, opaqueOrigin);
        await f.page.waitForFunction(() => document.getElementById('frame-2') !== null);
        const opaque = f.page.frames().find(frame => frame.url() === opaqueOrigin + '/player') || await f.page.waitForEvent('framenavigated', {
            predicate: frame => frame.url() === opaqueOrigin + '/player', timeout: 8000
        }).catch(() => f.page.frames().find(frame => frame.url() === opaqueOrigin + '/player'));
        assert.ok(opaque);
        await opaque.waitForFunction(() => document.getElementById('opaque-audio').readyState >= 2);
        await opaque.evaluate(async () => { const media = document.getElementById('opaque-audio'); media.volume = .65; media.muted = false; await media.play(); });
        const before = await snapshot(f);
        await actualMouseWindowAction(f, f.keys[0], 'audio-focus');
        await waitPeerProof(f, false);
        await waitFocusStatus(f, '未開啟');
        const warning = await f.page.locator(panel + ' #audio-focus-status').textContent();
        assert.ok(warning.includes(f.peerName), 'the warning must identify the unconfirmed foreign peer: ' + warning);
        assert.equal(warning.includes(f.targetName + '：未確認靜音'), false,
            'the native target must not be blamed for another player lacking control');
        assert.ok((await nativeStates(f)).every(state => state.muted));
        assert.equal(await opaque.evaluate(() => document.getElementById('opaque-audio').muted), false,
            'the outer controller must not pretend it has muted an inaccessible child');
        await assertAudioContinuity(f, before);
    });

test('empty peer: the control row represents unknown mute and volume without displaying a false open state',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        await makePeerEmpty(f);
        const row = peerRow(f);
        await f.page.locator('#umininn-player-control-host #toggle').click();
        await row.locator('input[type="range"]').waitFor();
        await f.page.waitForFunction(name => {
            const host = document.getElementById('umininn-player-panel-host');
            const row = [...host.shadowRoot.querySelectorAll('.player')].find(row => row.querySelector('strong').textContent.includes(name));
            return row && row.querySelector('input').disabled && row.querySelector('button').disabled &&
                row.querySelector('button').getAttribute('aria-pressed') !== 'false';
        }, f.peerName);
        assert.ok([null, 'mixed'].includes(await row.locator('button').first().getAttribute('aria-pressed')));
        assert.match(await row.locator('button').first().textContent(), /未知|未找到|尚未/);
        assert.equal(await row.locator('.level').textContent(), '—');
        assert.match(await row.locator('input[type="range"]').getAttribute('aria-valuetext'), /未知|未找到|尚未/);
        assert.equal(await row.locator('input[type="range"]').isDisabled(), true);
        assert.equal(await row.locator('button').first().isDisabled(), true);
        assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
    });

test('empty peer: a late closed custom player revokes empty proof and closes the previously selected native sound',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        await makePeerEmpty(f);
        const before = await snapshot(f);
        await actualMouseWindowAction(f, f.keys[0], 'audio-focus');
        await waitPeerProof(f); await waitOnlyAudible(f, 0);
        const firstReport = await f.page.evaluate(() => fixtureEmptyReports.length);
        await f.frames[0].evaluate(() => {
            customElements.define('fixture-closed-player', class extends HTMLElement {
                connectedCallback() {
                    const hiddenRoot = this.attachShadow({ mode: 'closed' });
                    const audio = document.createElement('audio');
                    audio.src = '/silent.wav?closed-player=1'; audio.loop = true;
                    audio.volume = .65; audio.muted = false;
                    hiddenRoot.appendChild(audio); window.fixtureClosedAudio = audio;
                }
            });
            document.body.appendChild(document.createElement('fixture-closed-player'));
        });
        await f.frames[0].waitForFunction(() => fixtureClosedAudio.readyState >= 2);
        await f.frames[0].evaluate(async () => { await fixtureClosedAudio.play(); });
        await waitPeerProof(f, false, { after: firstReport });
        await f.page.waitForFunction(() => fixtureMedia[0].video.muted === true);
        await waitFocusStatus(f, '未開啟');
        assert.ok((await nativeStates(f)).every(state => state.muted));
        assert.equal(await f.frames[0].evaluate(() => fixtureClosedAudio.muted), false,
            'closed-shadow audio is genuinely outside the controller and cannot be declared silent');
        assert.equal(await f.frames[0].evaluate(() => document.querySelector('fixture-closed-player').shadowRoot), null);
        await assertAudioContinuity(f, before);
    });
