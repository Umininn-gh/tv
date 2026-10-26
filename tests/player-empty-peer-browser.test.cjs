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
const harnessSource = fs.readFileSync(harnessFile, 'utf8');
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

async function setup(t) {
    if (!optional(t)) return null;
    const f = await fixture(t, { width: 1400, height: 850, audioUserscript: true });
    f.keys = await f.page.evaluate(() => fixture.keys);
    f.peerName = await f.page.evaluate(key => activePlayers.get(key).channel.name, f.keys[2]);
    f.targetName = await f.page.evaluate(key => activePlayers.get(key).channel.name, f.keys[0]);
    await primeAudio(f);
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
async function waitPeerProof(f, expected = true) {
    await f.page.waitForFunction(expected => fixtureEmptyReports.some(report =>
        report.result?.code === 'NO_MEDIA' && report.result.state?.muteGuardActive === true &&
        report.result.state?.emptyGuardConfirmed === expected), expected);
}
async function nativeStates(f) {
    return f.page.evaluate(() => fixtureMedia.map(({ video }) => ({ muted: video.muted, volume: video.volume })));
}
function peerRow(f) { return f.page.locator(panel + ' .player').filter({ hasText: f.peerName }); }

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
        await f.page.waitForFunction(start => fixtureEmptyReports.slice(start).some(report =>
            report.result?.code === 'NO_MEDIA' && report.result.state?.muteGuardActive === true &&
            report.result.state?.emptyGuardConfirmed === false), firstReport);
        await f.page.waitForFunction(() => fixtureMedia[0].video.muted === true);
        await waitFocusStatus(f, '未開啟');
        assert.ok((await nativeStates(f)).every(state => state.muted));
        assert.equal(await f.frames[0].evaluate(() => fixtureClosedAudio.muted), false,
            'closed-shadow audio is genuinely outside the controller and cannot be declared silent');
        assert.equal(await f.frames[0].evaluate(() => document.querySelector('fixture-closed-player').shadowRoot), null);
        await assertAudioContinuity(f, before);
    });
