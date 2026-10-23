'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Share the established production-app/real-media harness without registering
// its unrelated layout cases a second time. Its normal setup and teardown still
// run under node:test. No production source is modified to expose internals.
const harnessFile = path.join(__dirname, 'player-layout-browser.test.cjs');
const harnessSource = fs.readFileSync(harnessFile, 'utf8');
const harnessRequire = createRequire(harnessFile);
const harnessTest = Object.assign(() => {}, { before: test.before, after: test.after });
const harnessModule = { exports: {} };
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + harnessSource + '\n' +
    'module.exports={fixture,snapshot,primeAudio,waitOnlyAudible,waitFocusStatus,actualMouseWindowAction,assertAudioContinuity,waitAudio,optional};\n})',
    { filename: harnessFile })(name => name === 'node:test' ? harnessTest : harnessRequire(name),
    harnessModule, harnessModule.exports, __dirname, harnessFile);
const { fixture, snapshot, primeAudio, waitOnlyAudible, waitFocusStatus,
    actualMouseWindowAction, assertAudioContinuity, waitAudio, optional } = harnessModule.exports;
const enabled = process.env.UMININN_BROWSER_TESTS === '1';

async function setup(t, options = {}) {
    if (!optional(t)) return null;
    const f = await fixture(t, { width: 1400, height: 850, audioUserscript: true, ...options });
    f.keys = await f.page.evaluate(() => fixture.keys);
    await f.page.evaluate(() => {
        window.fixtureSoundClicks = [];
        document.addEventListener('click', event => {
            const button = event.target.closest?.('button[data-player-action="audio-focus"]');
            if (button) fixtureSoundClicks.push({ trusted: event.isTrusted, key: button.closest('[data-player-key]').dataset.playerKey });
        }, true);
    });
    await primeAudio(f);
    return f;
}
async function clickSound(f, keyIndex, mediaIndex = keyIndex) {
    await actualMouseWindowAction(f, f.keys[keyIndex], 'audio-focus');
    return waitOnlyAudible(f, mediaIndex, { timeout: 15000 });
}
async function suspendAndRestoreChild(frame) {
    // Recycle the real authenticated frame client in the same Window, matching
    // a restored embedded document whose parent did not itself enter BFCache.
    // This is deterministic lifecycle fault injection, not a claimed hours-long
    // live-platform run. A fresh probe is required to obtain its new identity.
    await frame.evaluate(() => {
        dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
}
async function wireCommands(f) {
    const read = () => fixtureAudioMessages.filter(value => value.type === 'userscript:command').length;
    const counts = await Promise.all([f.page.evaluate(read), ...f.frames.map(frame => frame.evaluate(read))]);
    return counts.reduce((total, value) => total + value, 0);
}

test('long-lived audio: 12-hour clock age preserves explicit native, wrapped and foreign sound selection',
    { skip: !enabled, timeout: 90000 }, async t => {
        const f = await setup(t); if (!f) return;
        const before = await snapshot(f);
        await f.page.clock.install();
        await f.page.clock.setSystemTime(new Date(Date.now() + 12 * 60 * 60 * 1000));
        for (const [key, media] of [[0, 0], [2, 3], [3, 4], [4, 2], [0, 0]]) {
            await clickSound(f, key, media);
            await waitFocusStatus(f, '只開啟');
        }
        await assertAudioContinuity(f, before);
    });

for (const productionTwitch of [false, true]) test(`long-lived audio: a restored ${productionTwitch ? 'Twitch' : 'Kick'} target endpoint is rediscovered by one original sound-button click`,
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t, { productionTwitch }); if (!f) return;
        await clickSound(f, 0, 0);
        const before = await snapshot(f);
        await suspendAndRestoreChild(f.frames[0]);
        await clickSound(f, 2, 3);
        await waitFocusStatus(f, '只開啟');
        await assertAudioContinuity(f, before);
        assert.deepEqual(await f.page.evaluate(() => fixtureSoundClicks.map(value => value.trusted)), [true, true],
            'recovery uses two real original sound clicks, without an extra detection click');
    });

test('long-lived audio: a restored peer endpoint cannot leave the newly selected native player silent',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        await clickSound(f, 2, 3);
        const before = await snapshot(f);
        await suspendAndRestoreChild(f.frames[0]);
        await clickSound(f, 4, 2);
        await waitFocusStatus(f, '只開啟');
        await assertAudioContinuity(f, before);
    });

test('long-lived audio: repeated solo commands rearm peer guards and always open the final current target at 100 percent',
    { skip: !enabled, timeout: 120000 }, async t => {
        const f = await setup(t); if (!f) return;
        const before = await snapshot(f);
        const sequence = [[0, 0], [2, 3], [4, 2], [3, 4], [1, 1]];
        for (let cycle = 0; cycle < 5; cycle++) {
            for (const [key, media] of sequence) await clickSound(f, key, media);
        }
        await assertAudioContinuity(f, before);
        const counts = await f.page.evaluate(() => ({
            hosts: document.querySelectorAll('#umininn-player-control-host').length,
            panels: document.querySelectorAll('#umininn-player-panel-host').length,
            windowCells: document.querySelectorAll('.player-window-cell').length
        }));
        assert.deepEqual({ hosts: counts.hosts, panels: counts.panels, windowCells: counts.windowCells },
            { hosts: 1, panels: 1, windowCells: 5 }, 'long-lived controls must not accumulate duplicate owners');
        const settledCount = await wireCommands(f);
        assert.ok(settledCount > 25, 'real authenticated commands must have crossed the foreign-frame boundary');
        await f.page.waitForTimeout(1000);
        assert.ok(await wireCommands(f) - settledCount <= 4,
            'a settled solo policy must become idle instead of continually sending commands');
    });

test('long-lived audio: foreign media replacement followed by the original sound button releases its old mute guard',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        await clickSound(f, 0, 0);
        await f.frames[0].evaluate(async () => {
            const old = fixtureMedia[0].video;
            const replacement = document.createElement('video');
            replacement.id = old.id; replacement.loop = true; replacement.playsInline = true;
            replacement.style.cssText = old.style.cssText; replacement.muted = false; replacement.volume = .07;
            replacement.src = old.currentSrc;
            old.replaceWith(replacement);
            instrumentMedia(replacement);
            window.fixtureReplacedMedia = fixtureMedia.pop(); fixtureMedia[0] = fixtureReplacedMedia;
            await new Promise(resolve => replacement.addEventListener('canplay', resolve, { once: true }));
            await replacement.play();
        });
        await waitAudio(f, media => media[3].muted === true);
        const before = await snapshot(f);
        await clickSound(f, 2, 3);
        await waitFocusStatus(f, '只開啟');
        await assertAudioContinuity(f, before);
        await f.page.waitForTimeout(750);
        await waitOnlyAudible(f, 3);
    });

test('long-lived audio: selecting a guarded foreign tile restores its separate audio route and keeps muted preload silent',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        await f.frames[0].evaluate(async () => {
            const audio = document.createElement('audio');
            audio.id = 'fixture-audio-route'; audio.loop = true; audio.muted = false; audio.volume = .42; audio.src = '/silent.wav?route=separate';
            const preload = document.createElement('video');
            preload.id = 'fixture-preload'; preload.muted = true; preload.volume = .17; preload.src = '/silent.wav?route=preload';
            preload.style.display = 'none';
            document.body.append(audio, preload);
            window.fixtureSeparateAudio = instrumentMedia(audio); window.fixturePreload = instrumentMedia(preload);
            await new Promise(resolve => audio.addEventListener('canplay', resolve, { once: true }));
            await audio.play();
        });
        await clickSound(f, 0, 0);
        await f.frames[0].waitForFunction(() => fixtureSeparateAudio.video.muted === true);
        const before = await f.frames[0].evaluate(() => ({ audio: readMedia(fixtureSeparateAudio), preload: readMedia(fixturePreload) }));
        await actualMouseWindowAction(f, f.keys[2], 'audio-focus');
        await f.frames[0].waitForFunction(() => fixtureSeparateAudio.video.muted === false && fixtureSeparateAudio.video.volume === 1 &&
            fixtureMedia[0].video.muted === false && fixtureMedia[0].video.volume === 1);
        const selected = await snapshot(f);
        assert.ok(selected.main.every(value => value.muted) && selected.frames[1].media.every(value => value.muted),
            'all other tiles stay muted while the selected tile\'s actual audio route opens');
        const after = await f.frames[0].evaluate(() => ({ audio: readMedia(fixtureSeparateAudio), preload: readMedia(fixturePreload) }));
        assert.equal(after.preload.muted, true, 'the platform\'s originally muted preload must stay muted');
        assert.equal(after.preload.volume, before.preload.volume);
        assert.deepEqual(after.audio.actions, before.audio.actions, 'switching a split audio route must not replay or reload media');
        assert.deepEqual(after.preload.actions, before.preload.actions);
        await clickSound(f, 4, 2);
        await f.frames[0].waitForFunction(() => fixtureSeparateAudio.video.muted === true && fixturePreload.video.muted === true);
        await actualMouseWindowAction(f, f.keys[2], 'audio-focus');
        await f.frames[0].waitForFunction(() => fixtureSeparateAudio.video.muted === false && fixtureSeparateAudio.video.volume === 1);
        assert.equal(await f.frames[0].evaluate(() => fixturePreload.video.muted), true,
            'repeated handovers must not gradually include an originally muted preload');
        assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
    });

test('long-lived audio: a burst of original sound clicks after prior use gives the final current tile sole sound ownership',
    { skip: !enabled, timeout: 90000 }, async t => {
        const f = await setup(t); if (!f) return;
        await clickSound(f, 2, 3);
        const before = await snapshot(f);
        for (let cycle = 0; cycle < 4; cycle++) {
            for (const key of [0, 3, 2, 4, 1]) await actualMouseWindowAction(f, f.keys[key], 'audio-focus');
        }
        await waitOnlyAudible(f, 1, { timeout: 15000 });
        await f.page.waitForTimeout(1200);
        await waitOnlyAudible(f, 1);
        await assertAudioContinuity(f, before);
        assert.ok(await f.page.evaluate(() => fixtureSoundClicks.length === 21 && fixtureSoundClicks.every(value => value.trusted)));
    });

test('long-lived audio: repeated same-URL iframe reloads retain one tile control and the next explicit click controls the new media',
    { skip: !enabled, timeout: 90000 }, async t => {
        const f = await setup(t); if (!f) return;
        await clickSound(f, 2, 3);
        for (let cycle = 0; cycle < 3; cycle++) {
            const oldDocument = await f.frames[0].evaluate(() => fixtureId);
            const before = await snapshot(f);
            await f.frames[0].goto(f.frames[0].url(), { waitUntil: 'load' });
            await f.frames[0].waitForFunction(() => fixtureMedia[0]?.video.readyState >= 2);
            assert.notEqual(await f.frames[0].evaluate(() => fixtureId), oldDocument,
                'the test really replaced the document while keeping the same iframe and URL');
            const after = await clickSound(f, 2, 3);
            assert.equal(after.frames[0].media[0].paused, true, 'the sound shortcut must respect the new player\'s paused state');
            assert.deepEqual(after.frames[0].media[0].actions, { play: 0, pause: 0, load: 0, seek: 0, source: 0 });
            assert.deepEqual(after.main.map(value => value.actions), before.main.map(value => value.actions));
            assert.deepEqual(after.frames[1], before.frames[1], 'the other paused frame is completely untouched');
            assert.equal(await f.page.locator('#umininn-player-panel-host .player').count(), 5);
        }
        await clickSound(f, 0, 0);
        assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
    });

test('long-lived audio: a previously missed foreign gesture report cannot cancel the newer explicit sound selection',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        await f.page.evaluate(() => { fixtureAudioGate.blockUpdates = true; });
        await f.frames[0].locator('#frame-video').click();
        await f.page.waitForTimeout(250); // Let the authenticated, old report be dropped by the fixture gate.
        await f.page.evaluate(() => { fixtureAudioGate.blockUpdates = false; });
        const before = await snapshot(f);
        await clickSound(f, 4, 2);
        await waitFocusStatus(f, '只開啟');
        await f.page.waitForTimeout(750);
        await waitOnlyAudible(f, 2);
        await assertAudioContinuity(f, before);
    });

test('long-lived audio: removing a target while its fresh handshake is withheld clears the preparing state without opening another tile',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        await f.page.evaluate(() => { fixtureAudioGate.blockUpdates = true; });
        await actualMouseWindowAction(f, f.keys[0], 'audio-focus');
        await waitFocusStatus(f, '正在將');
        await actualMouseWindowAction(f, f.keys[0], 'close');
        await f.page.waitForFunction(() => !fixtureMedia[0].video.isConnected);
        await f.page.waitForFunction(() => {
            const status = document.getElementById('umininn-player-panel-host').shadowRoot.getElementById('audio-focus-status');
            return status.hidden || !status.textContent.includes('正在將');
        });
        await f.page.waitForTimeout(1750);
        assert.ok((await snapshot(f)).main.every(value => value.muted), 'removed or surviving native media must never open from the abandoned request');
        assert.ok((await snapshot(f)).frames.every(frame => frame.media.every(value => value.muted)));
        await f.page.evaluate(() => { fixtureAudioGate.blockUpdates = false; });
        await clickSound(f, 4, 2);
        await waitFocusStatus(f, '只開啟');
        assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
    });

test('long-lived audio: trusted player pointer and keyboard mute during the fresh handshake both supersede pending solo sound',
    { skip: !enabled, timeout: 90000 }, async t => {
        for (const input of ['pointer', 'keyboard']) {
            const f = await setup(t); if (!f) return;
            await clickSound(f, 2, 3);
            await f.frames[0].evaluate(() => {
                const button = document.createElement('button'); button.id = 'fixture-manual-mute'; button.textContent = 'Mute';
                button.style.cssText = 'position:fixed;left:50%;top:50%;z-index:1000';
                const mute = event => { window.fixtureManualMuteTrusted = event.isTrusted; fixtureMedia[0].video.muted = true; };
                button.addEventListener('click', mute);
                button.addEventListener('keydown', event => { if (event.key === 'm') mute(event); });
                document.body.appendChild(button);
            });
            await f.page.evaluate(() => { fixtureAudioGate.blockUpdates = true; });
            await actualMouseWindowAction(f, f.keys[0], 'audio-focus');
            await waitFocusStatus(f, '正在將');
            const control = f.frames[0].locator('#fixture-manual-mute');
            if (input === 'pointer') await control.click();
            else { await control.focus(); await control.press('m'); }
            assert.equal(await f.frames[0].evaluate(() => fixtureManualMuteTrusted), true, input + ' control uses real trusted input');
            await f.page.waitForTimeout(1800);
            await waitAudio(f, media => media.every(value => value.muted));
            const status = await f.page.locator('#umininn-player-panel-host #audio-focus-status').textContent();
            assert.ok(!status.includes('正在將') && !status.includes('只開啟'), input + ' manual mute must cancel the pending solo request');
            await f.page.evaluate(() => { fixtureAudioGate.blockUpdates = false; });
            await clickSound(f, 4, 2);
            assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
        }
    });
