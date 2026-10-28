'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Reuse the closed native/foreign browser model and its complete userscript.
// Capture real controller references at construction so passive guard repairs
// can be checked without an explicit getState accidentally repairing the bug.
const harnessFile = path.join(__dirname, 'player-layout-browser.test.cjs');
let harnessSource = fs.readFileSync(harnessFile, 'utf8');
function seam(before, after) {
    assert.equal(harnessSource.split(before).length, 2, 'unique performance fixture seam: ' + before.slice(0, 90));
    harnessSource = harnessSource.replace(before, after);
}
seam("const root = path.resolve(__dirname, '..');",
    "const root = process.env.UMININN_PERFORMANCE_ASSET_ROOT || path.resolve(__dirname, '..');");
seam("require('../tools/build-player-userscript.cjs').RELEASE_VERSION",
    "(process.env.UMININN_PERFORMANCE_VERSION || require('../tools/build-player-userscript.cjs').RELEASE_VERSION)");
seam("const built=fs.readFileSync(path.join(root,siteFile('site/userscript/umininn-tv-player.user.js')),'utf8');", `
        const bundled=fs.readFileSync(path.join(root,siteFile('site/userscript/umininn-tv-player.user.js')),'utf8');
        const marker='    // Source: userscript/bootstrap.js';
        assert.equal(bundled.split(marker).length,2,'the complete distribution has one bootstrap boundary');
        const capture=
            'window.fixturePerformanceControllers=[];\\n'+
            'const performanceOriginalMediaFactory=scope.UmininnMedia.createMediaController;\\n'+
            'scope.UmininnMedia.createMediaController=function(options){\\n'+
            ' const controller=performanceOriginalMediaFactory.apply(this,arguments);\\n'+
            ' const record={controller,scope:options.scope||options.document,latest:null};\\n'+
            ' controller.subscribe(value=>{record.latest=value});\\n'+
            ' window.fixturePerformanceControllers.push(record);return controller;\\n'+
            '};\\n';
        const built=bundled.replace(marker,capture+marker);`);
const harnessRequire = createRequire(harnessFile), harnessModule = { exports: {} };
const harnessTest = Object.assign(() => {}, { before: test.before, after: test.after });
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + harnessSource + '\n' +
    'module.exports={fixture,optional,primeAudio,waitOnlyAudible,waitFocusStatus,actualMouseWindowAction,holdAudioReply,waitHeldAudioReply,releaseAudioReply,snapshot};\n})',
    { filename: harnessFile })(name => name === 'node:test' ? harnessTest : harnessRequire(name),
    harnessModule, harnessModule.exports, __dirname, harnessFile);
const { fixture, optional, primeAudio, waitOnlyAudible, waitFocusStatus, actualMouseWindowAction,
    holdAudioReply, waitHeldAudioReply, releaseAudioReply, snapshot } = harnessModule.exports;
const enabled = process.env.UMININN_BROWSER_TESTS === '1';

async function setup(t) {
    if (!optional(t)) return null;
    const f = await fixture(t, { width: 1400, height: 850, audioUserscript: true });
    f.keys = await f.page.evaluate(() => fixture.keys);
    await primeAudio(f);
    return f;
}

async function preparePassiveGuard(f, location) {
    const surface = location === 'native' ? f.page : f.frames[0];
    const state = await surface.evaluate(async location => {
        const scope = location === 'native' ? document.getElementById('wrapped-native-4') : document;
        const record = fixturePerformanceControllers.find(item => item.scope === scope);
        if (!record) throw new Error('Missing real production controller for ' + location);
        window.fixturePerformanceRecord = record;
        window.fixturePerformanceVideo = location === 'native' ? scope.querySelector('video') : document.getElementById('frame-video');
        window.fixturePerformanceHost = document.createElement('div');
        (location === 'native' ? scope : document.body).appendChild(fixturePerformanceHost);
        return (await record.controller.execute({ action: 'setMuted', value: true, guard: true })).state;
    }, location);
    assert.equal(state.muteGuardActive, true); assert.equal(state.muted, true);
    return surface;
}

async function addLateShadowAudio(surface, { metadataFirst = false } = {}) {
    const initial = await surface.evaluate(async metadataFirst => {
        const root = fixturePerformanceHost.attachShadow({ mode: 'open' });
        const audio = document.createElement('audio');
        audio.id = 'performance-late-shadow-audio'; audio.hidden = true; audio.loop = true;
        audio.src = '/silent.wav?late-shadow'; audio.volume = .67; audio.muted = false;
        window.fixturePerformanceAudio = audio;
        window.fixturePerformanceAudioActions = instrumentMedia(audio).actions;
        root.appendChild(audio);
        await audio.play();
        const before = audio.muted;
        // loadedmetadata reaches the primary listener before its guard listener:
        // the already scheduled layout scan can run before the guard timer.
        if (metadataFirst) fixturePerformanceVideo.dispatchEvent(new Event('loadedmetadata'));
        fixturePerformanceVideo.muted = false; // Real HTMLMediaElement event.
        return { before, connected: audio.isConnected, playing: !audio.paused };
    }, metadataFirst);
    assert.deepEqual(initial, { before: false, connected: true, playing: true });
    // Read actual media properties only. Calling the controller's getState here
    // would force discovery and conceal a broken passive inventory cache.
    await surface.waitForFunction(() => fixturePerformanceAudio.muted === true && fixturePerformanceVideo.muted === true,
        null, { timeout: 3000 });
    const after = await surface.evaluate(() => ({
        hidden: fixturePerformanceAudio.hidden, connected: fixturePerformanceAudio.isConnected,
        paused: fixturePerformanceAudio.paused, volume: fixturePerformanceAudio.volume,
        actions: { ...fixturePerformanceAudioActions }, latest: fixturePerformanceRecord.latest.state
    }));
    assert.equal(after.hidden, true); assert.equal(after.connected, true); assert.equal(after.paused, false);
    assert.equal(after.volume, .67); assert.equal(after.latest.muteGuardActive, true); assert.equal(after.latest.muted, true);
    assert.deepEqual(after.actions, { play: 1, pause: 0, load: 0, seek: 0, source: 0 },
        'the passive guard may mute late media without starting, pausing, seeking or reloading it');
}

test('performance cache: native and foreign guard volumechange discovers late open-shadow hidden audio',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        for (const location of ['native', 'foreign']) await t.test(location, async () => {
            const surface = await preparePassiveGuard(f, location);
            await addLateShadowAudio(surface);
        });
        assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
    });

test('performance cache: an earlier metadata layout scan cannot cancel fresh late-shadow guard discovery',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        for (const location of ['native', 'foreign']) await t.test(location, async () => {
            const surface = await preparePassiveGuard(f, location);
            await addLateShadowAudio(surface, { metadataFirst: true });
        });
        assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
    });

test('performance cache: removing newly guarded media cannot reopen its retired soundtrack on native or foreign focus',
    { skip: !enabled, timeout: 60000 }, async t => {
        if (!optional(t)) return;
        for (const location of ['native', 'foreign']) await t.test(location, async sub => {
            const f = await setup(sub); if (!f) return;
            const surface = await preparePassiveGuard(f, location);
            await addLateShadowAudio(surface);
            await surface.evaluate(() => { fixturePerformanceAudio.remove(); });
            const keyIndex = location === 'native' ? 4 : 2, mediaIndex = location === 'native' ? 2 : 3;
            await actualMouseWindowAction(f, f.keys[keyIndex], 'audio-focus');
            await waitOnlyAudible(f, mediaIndex); await waitFocusStatus(f, '只開啟');
            assert.deepEqual(await surface.evaluate(() => ({
                connected: fixturePerformanceAudio.isConnected, muted: fixturePerformanceAudio.muted,
                volume: fixturePerformanceAudio.volume, actions: { ...fixturePerformanceAudioActions }
            })), { connected: false, muted: true, volume: .67,
                actions: { play: 1, pause: 0, load: 0, seek: 0, source: 0 } },
            'an explicit fresh control must forget the removed route instead of unmuting its detached audio');
            assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
        });
    });

test('performance discovery: a visible primary retains its ordinary controls while newly inserted hidden media is fully guarded',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        for (const location of ['native', 'foreign']) await t.test(location, async () => {
            const surface = await preparePassiveGuard(f, location);
            if (location === 'foreign') await f.page.evaluate(() => {
                window.fixturePerformancePendingPeerReports = [];
                addEventListener('message', event => {
                    if (event.source === document.getElementById('frame-2')?.contentWindow &&
                        event.data?.channel === 'umininn-tv-userscript' && event.data.type === 'frame:ready')
                        fixturePerformancePendingPeerReports.push(event.data.result?.state);
                });
            });
            const pending = await surface.evaluate(async () => {
                const audio = document.createElement('audio'); audio.hidden = true; audio.muted = false;
                window.fixturePerformancePendingAudio = audio;
                fixturePerformanceHost.appendChild(audio);
                // Deliver the native MutationObserver checkpoint, without a
                // timer or explicit controller read that would repair media.
                await Promise.resolve();
                return { primaryMuted: fixturePerformanceVideo.muted, newMuted: audio.muted,
                    available: fixturePerformanceRecord.latest.state.available,
                    reportedMuted: fixturePerformanceRecord.latest.state.muted,
                    muteSupported: fixturePerformanceRecord.latest.state.muteSupported };
            });
            assert.deepEqual(pending, { primaryMuted: true, newMuted: false, available: true,
                reportedMuted: true, muteSupported: true },
                'a visible primary keeps the baseline ordinary-control contract during the coalesced discovery interval');
            await surface.waitForFunction(() => fixturePerformancePendingAudio.muted === true &&
                fixturePerformanceRecord.latest.state.muted === true &&
                fixturePerformanceRecord.latest.state.focusRestorePending === true &&
                fixturePerformanceRecord.latest.state.emptyGuardConfirmed === false);
            if (location === 'foreign') await f.page.waitForFunction(() => fixturePerformancePendingPeerReports.some(state =>
                state?.available === true && state.muted === true && state.muteSupported === true &&
                state.focusRestorePending === true && state.emptyGuardConfirmed === false));
        });
        assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
    });

test('performance cache: iframe src renewal rejects its old delayed reply before preserving the requested single audible tile',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        const before = await snapshot(f);
        await holdAudioReply(f, { firstDocumentOnly: true, action: 'getState' });
        await actualMouseWindowAction(f, f.keys[0], 'audio-focus'); await waitHeldAudioReply(f);
        const next = await f.page.evaluate(() => {
            const frame = document.getElementById('frame-2'), url = new URL(frame.src);
            url.searchParams.set('performance-generation', 'renewed'); frame.src = url.href;
            return url.href;
        });
        await f.frames[0].waitForURL(next, { waitUntil: 'load' });
        await f.frames[0].waitForFunction(() => fixtureMedia[0].video.readyState >= 2);
        await f.frames[0].evaluate(async () => {
            const video = fixtureMedia[0].video; video.muted = false; video.volume = .39; await video.play();
        });
        await waitOnlyAudible(f, 0); await waitFocusStatus(f, '只開啟');
        assert.equal(await f.page.evaluate(() => fixtureAudioGate.held.length > 0), true,
            'fresh iframe routing must work while the previous document reply is still delayed');
        await releaseAudioReply(f);
        await f.page.waitForTimeout(250); await waitOnlyAudible(f, 0);
        const after = await snapshot(f);
        assert.notEqual(after.frames[0].id, before.frames[0].id, 'the iframe really has a new document');
        assert.equal(after.frames[1].id, before.frames[1].id, 'the other foreign route keeps its identity');
        assert.equal(after.frames[0].media[0].muted, true);
        assert.equal(after.frames[0].media[0].volume, .39, 'peer muting preserves its newly supplied volume');
        assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
    });

test('performance cache: healthy waiting to playing and canplay with a pending frame announcement never remutes the audible target',
    { skip: !enabled, timeout: 90000 }, async t => {
        if (!optional(t)) return;
        for (const location of ['native', 'foreign']) await t.test(location, async sub => {
            const f = await setup(sub); if (!f) return;
            await actualMouseWindowAction(f, f.keys[0], 'audio-focus');
            await waitOnlyAudible(f, 0); await waitFocusStatus(f, '只開啟');
            await f.page.evaluate(() => {
                window.fixturePerformanceTargetMutes = [];
                window.fixturePerformancePeerAnnouncements = [];
                const target = document.getElementById('native-0');
                target.addEventListener('volumechange', () => {
                    if (target.muted) fixturePerformanceTargetMutes.push({ at: performance.now(), volume: target.volume });
                });
                addEventListener('message', event => {
                    if (event.source === document.getElementById('frame-2')?.contentWindow &&
                        event.data?.channel === 'umininn-tv-userscript' && event.data.type === 'frame:ready')
                        fixturePerformancePeerAnnouncements.push({ at: performance.now(), state: event.data.result?.state });
                });
            });
            let pendingAnnouncements = 0;
            for (let cycle = 0; cycle < 8; cycle++) {
                const before = await f.page.evaluate(() => fixturePerformancePeerAnnouncements.length);
                // The foreign peer queues a real coalesced frame announcement.
                // In the native subtest its guarded native sibling changes too,
                // covering both local UI and foreign transport notifications.
                await f.frames[0].evaluate(() => fixtureMedia[0].video.dispatchEvent(new Event('waiting')));
                if (location === 'native') await f.page.evaluate(() =>
                    document.getElementById('wrapped-native-4').querySelector('video').dispatchEvent(new Event('waiting')));
                await f.page.waitForTimeout(70);
                if (await f.page.evaluate(() => fixturePerformancePeerAnnouncements.length) === before) pendingAnnouncements++;
                if (location === 'native') await f.page.evaluate(() => {
                    const video = document.getElementById('wrapped-native-4').querySelector('video');
                    video.dispatchEvent(new Event('playing')); video.dispatchEvent(new Event('canplay'));
                });
                await f.frames[0].evaluate(() => {
                    const video = fixtureMedia[0].video;
                    video.dispatchEvent(new Event('playing')); video.dispatchEvent(new Event('canplay'));
                });
                await f.page.waitForTimeout(400);
                assert.deepEqual(await f.page.evaluate(() => fixturePerformanceTargetMutes), [],
                    'healthy peer events must not briefly remute the audible target in cycle ' + cycle);
                // This helper only reads native media properties; it never
                // invokes a controller getState that could repair stale proof.
                await waitOnlyAudible(f, 0);
            }
            assert.ok(pendingAnnouncements > 0,
                'at least one healthy event burst must overlap a not-yet-delivered foreign announcement');
            assert.deepEqual(await f.page.evaluate(() => fixturePerformanceTargetMutes), []);
            assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
        });
    });

test('performance discovery: an unrelated decorative mutation discovers late shadow audio in empty and visible native or foreign players',
    { skip: !enabled, timeout: 90000 }, async t => {
        if (!optional(t)) return;
        for (const location of ['native', 'foreign']) for (const empty of [true, false])
            await t.test(location + (empty ? ' empty' : ' visible'), async sub => {
                const f = await setup(sub); if (!f) return;
                const surface = location === 'native' ? f.page : f.frames[0];
                const initial = await surface.evaluate(async ({ location, empty }) => {
                    const scope = location === 'native' ? document.getElementById('wrapped-native-4') : document;
                    const record = fixturePerformanceControllers.find(item => item.scope === scope);
                    if (!record) throw new Error('Missing real controller for decorative mutation test');
                    const parent = location === 'native' ? scope : document.body;
                    const video = location === 'native' ? scope.querySelector('video') : document.getElementById('frame-video');
                    if (empty) { video.muted = true; video.pause(); video.remove(); }
                    const host = document.createElement('div'), decoration = document.createElement('span');
                    parent.append(host, decoration);
                    window.fixtureDecorativeRecord = record;
                    window.fixtureDecorativeHost = host;
                    window.fixtureDecorativeSibling = decoration;
                    return (await record.controller.execute({ action: 'setMuted', value: true, guard: true })).state;
                }, { location, empty });
                assert.equal(initial.available, !empty); assert.equal(initial.muteGuardActive, true);
                assert.equal(initial.emptyGuardConfirmed, empty);
                // Drain the guard command's pre-existing frame announcement.
                // A later fresh announcement must not hide a broken MO path.
                await f.page.waitForTimeout(250);
                const before = await surface.evaluate(() => {
                    const root = fixtureDecorativeHost.attachShadow({ mode: 'open' });
                    const audio = document.createElement('audio'); audio.hidden = true; audio.volume = .58; audio.muted = false;
                    window.fixtureDecorativeAudio = audio; root.appendChild(audio);
                    // No source, playback or known-media event is produced. The
                    // only observed change is on a sibling outside this host.
                    fixtureDecorativeSibling.style.color = 'rgb(17, 23, 31)';
                    return { muted: audio.muted, connected: audio.isConnected };
                });
                assert.deepEqual(before, { muted: false, connected: true });
                await surface.waitForFunction(() => fixtureDecorativeAudio.muted === true &&
                    fixtureDecorativeRecord.latest.state.emptyGuardConfirmed === false &&
                    fixtureDecorativeRecord.latest.state.muted === true, null, { timeout: 3000 });
                assert.deepEqual(await surface.evaluate(() => ({
                    muted: fixtureDecorativeAudio.muted, volume: fixtureDecorativeAudio.volume,
                    paused: fixtureDecorativeAudio.paused, available: fixtureDecorativeRecord.latest.state.available,
                    emptyProof: fixtureDecorativeRecord.latest.state.emptyGuardConfirmed,
                    guard: fixtureDecorativeRecord.latest.state.muteGuardActive
                })), { muted: true, volume: .58, paused: true, available: !empty, emptyProof: false, guard: true });
                assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
            });
    });

// The separate player-empty-peer-browser suite covers the opposite contract:
// an empty/hidden-only scope with an opaque iframe or a closed custom route
// cannot prove silence and must withhold another tile's opening. This case
// preserves baseline32's intentionally different ordinary visible-primary API.
test('performance compatibility: native and foreign visible players with opaque ad routes still guard known audio and permit another tile to open sound',
    { skip: !enabled, timeout: 90000 }, async t => {
        if (!optional(t)) return;
        for (const location of ['native', 'foreign']) await t.test(location, async sub => {
            const f = await setup(sub); if (!f) return;
            const surface = location === 'native' ? f.page : f.frames[0];
            const adUrl = 'https://performance-ad.invalid/ordinary-' + location;
            await f.page.context().route(adUrl, route => route.fulfill({ contentType: 'text/html',
                body: '<!doctype html><html><head><meta charset="utf-8"></head><body><p>Isolated ad placeholder</p></body></html>' }));
            const guarded = await surface.evaluate(async ({ location, adUrl }) => {
                const scope = location === 'native' ? document.getElementById('wrapped-native-4') : document;
                const record = fixturePerformanceControllers.find(item => item.scope === scope);
                if (!record) throw new Error('Missing real ordinary-primary controller');
                const host = document.createElement('div');
                (location === 'native' ? scope : document.body).appendChild(host);
                // Keep the parent's ordinary native-slot classifier intact;
                // its real media controller discovers this open shadow tree.
                const root = host.attachShadow({ mode: 'open' });
                const audio = document.createElement('audio'); audio.hidden = true; audio.loop = true;
                audio.src = '/silent.wav?ordinary-known-hidden'; audio.volume = .62; audio.muted = false;
                root.appendChild(audio); await audio.play();
                const frame = document.createElement('iframe'); frame.hidden = true;
                // SOP supplies real opacity. Avoid an origin-less sandbox:
                // Playwright's serviceWorkers:block init script reads a getter
                // that the browser intentionally forbids in sandboxed frames.
                frame.src = adUrl;
                const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
                root.appendChild(frame); await loaded;
                const ad = document.createElement('performance-ad-component'); ad.hidden = true;
                ad.attachShadow({ mode: 'closed' }).appendChild(document.createElement('span'));
                root.appendChild(ad);
                window.fixtureOrdinaryKnownAudio = audio;
                window.fixtureOrdinaryOpaqueFrame = frame;
                window.fixtureOrdinaryClosedAd = ad;
                window.fixtureOrdinaryRecord = record;
                const result = await record.controller.execute({ action: 'setMuted', value: true, guard: true });
                return { ok: result.ok, code: result.code, state: result.state,
                    knownMuted: audio.muted, knownPlaying: !audio.paused, opaqueFrame: frame.contentDocument === null,
                    closedAd: ad.shadowRoot === null };
            }, { location, adUrl });
            assert.equal(guarded.opaqueFrame, true, 'the cross-origin HTTPS iframe must really be inaccessible');
            assert.equal(guarded.closedAd, true, 'the custom ad route must really have a closed root');
            assert.equal(guarded.ok, true); assert.equal(guarded.code, 'OK');
            assert.equal(guarded.state.available, true); assert.equal(guarded.state.muted, true);
            assert.equal(guarded.state.muteSupported, true); assert.equal(guarded.state.muteGuardActive, true);
            assert.equal(guarded.state.emptyGuardConfirmed, false, 'ordinary controls cannot invent an empty-route proof');
            assert.equal(guarded.knownMuted, true); assert.equal(guarded.knownPlaying, true);
            await actualMouseWindowAction(f, f.keys[0], 'audio-focus');
            await waitOnlyAudible(f, 0); await waitFocusStatus(f, '只開啟');
            assert.deepEqual(await surface.evaluate(() => ({
                muted: fixtureOrdinaryKnownAudio.muted, volume: fixtureOrdinaryKnownAudio.volume,
                paused: fixtureOrdinaryKnownAudio.paused, available: fixtureOrdinaryRecord.latest.state.available,
                primaryMuted: fixtureOrdinaryRecord.latest.state.muted,
                emptyProof: fixtureOrdinaryRecord.latest.state.emptyGuardConfirmed
            })), { muted: true, volume: .62, paused: false, available: true, primaryMuted: true, emptyProof: false },
            'an opaque ad child must not disable the ordinary primary or block another tile, and all known media stay muted');
            assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
        });
    });
