'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Production app, lifecycle/bridge modules and userscript, with real media and
// isolated cross-origin documents. Only stream bytes/platforms are fixtures.
const harnessFile = path.join(__dirname, 'player-layout-browser.test.cjs');
const harnessRequire = createRequire(harnessFile), harnessModule = { exports: {} };
const harnessTest = Object.assign(() => {}, { before: test.before, after: test.after });
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + fs.readFileSync(harnessFile, 'utf8') + '\n' +
    'module.exports={fixture,snapshot,assertContinuity,assertAudioContinuity,optional,settlePane,waitSpan,seedLayoutSound,' +
    'holdAudioReply,waitHeldAudioReply,releaseAudioReply,actualMouseWindowAction,waitOnlyAudible,waitAudio};\n})',
    { filename: harnessFile })(name => name === 'node:test' ? harnessTest : harnessRequire(name),
    harnessModule, harnessModule.exports, __dirname, harnessFile);
const { fixture, snapshot, assertContinuity, assertAudioContinuity, optional, settlePane, waitSpan, seedLayoutSound,
    holdAudioReply, waitHeldAudioReply, releaseAudioReply, actualMouseWindowAction, waitOnlyAudible, waitAudio } = harnessModule.exports;
const browserCase = { skip: process.env.UMININN_BROWSER_TESTS !== '1', timeout: 60000 };

async function settle(f) {
    await f.page.waitForFunction(() => playerAudioBridge.batch === null && playerAudioBridge.queueLength === 0);
    await f.page.waitForTimeout(260);
    await f.page.waitForFunction(() => playerAudioBridge.batch === null && playerAudioBridge.queueLength === 0);
}
async function setup(t) {
    if (!optional(t)) return null;
    const f = await fixture(t, { width: 1200, height: 800, audioUserscript: true });
    await seedLayoutSound(f); await settle(f);
    return f;
}
async function release(f) {
    await releaseAudioReply(f);
    await f.page.evaluate(() => { fixtureAudioGate.blockUpdates = false; });
}

test('player layers: close and re-add the same channel invalidates its old instance and late error callbacks', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f);
    await f.page.evaluate(() => {
        const key = fixture.keys[0];
        window.phase4Old = activePlayers.get(key);
        window.phase4OldLease = playerRegistry.lease(phase4Old);
        window.phase4Retained = [...activePlayers].filter(([candidate]) => candidate !== key);
    });
    assert.equal(await f.page.evaluate(() => closePlayer(fixture.keys[0])), true);
    assert.deepEqual(await f.page.evaluate(() => ({ current: playerRegistry.isCurrent(phase4OldLease),
        connected: phase4OldLease.element.isConnected, disposed: phase4Old.resource.disposed })),
    { current: false, connected: false, disposed: true });
    await f.page.evaluate(async () => {
        const key = fixture.keys[0], original = RENDERERS.hls;
        window.phase4CreateCount = 0;
        // A deterministic local stream replaces only this channel's external
        // HLS boundary; selection/reuse/disposal run through production code.
        RENDERERS.hls = (channel, platform, muted, className) => {
            if (ChannelList.channelKey(channel) !== key) return original(channel, platform, muted, className);
            phase4CreateCount++;
            const video = document.createElement('video');
            video.id = 'phase4-readded-player'; video.className = className;
            video.loop = true; video.playsInline = true; video.muted = muted;
            video.src = '/silent.wav?phase4-readded=1';
            playerResources.set(video, { element: video, video, disposed: false, failed: false, hls: null, flv: null });
            return video;
        };
        try { await syncActivePlayers(channels); } finally { RENDERERS.hls = original; }
        window.phase4New = activePlayers.get(key);
        window.phase4NewLease = playerRegistry.lease(phase4New);
        replacePlayerWithError(phase4Old.resource, 'stale old playback error');
        window.phase4OldRemove = disposePlayer(phase4Old);
    });
    await f.page.waitForFunction(() => phase4New.resource.video.readyState >= 2);
    await settle(f);
    assert.deepEqual(await f.page.evaluate(() => ({ created: phase4CreateCount,
        replaced: phase4New !== phase4Old, oldCurrent: playerRegistry.isCurrent(phase4OldLease),
        newCurrent: playerRegistry.isCurrent(phase4NewLease), oldRemove: phase4OldRemove,
        connected: phase4NewLease.element.isConnected,
        retained: phase4Retained.every(([key, entry]) => activePlayers.get(key) === entry),
        errors: document.getElementById('multi-stream-container').textContent.includes('stale old playback error') })),
    { created: 1, replaced: true, oldCurrent: false, newCurrent: true, oldRemove: false, connected: true, retained: true, errors: false });
    const after = await snapshot(f);
    assert.deepEqual(after.frames.map(frame => frame.id), before.frames.map(frame => frame.id));
    assert.deepEqual(after.main.slice(1).map(({ time, ...state }) => state), before.main.slice(1).map(({ time, ...state }) => state));
    assert.deepEqual(f.blocked, []); assert.deepEqual(f.errors, []);
});

test('player layers: names, order and automatic pane reflow keep the same player entries and leases', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f);
    await f.page.evaluate(async () => {
        window.phase4Leases = [...activePlayers.values()].map(entry => playerRegistry.lease(entry));
        channels = channels.map(channel => ({ ...channel, name: channel.name + ' 新名稱' }));
        await syncActivePlayers(channels);
        await swapPlayerPositions(fixture.keys[0], fixture.keys[4]);
    });
    await settlePane(f, 760, 980); await settle(f);
    assert.equal(await f.page.evaluate(() => phase4Leases.every(value => playerRegistry.isCurrent(value))), true);
    assert.equal(await f.page.evaluate(() => [...activePlayers.values()].every(entry => entry.channel.name.endsWith('新名稱'))), true);
    await assertContinuity(f, before);
});

test('player layers: pagehide cancels held layout work and stale acknowledgements cannot commit after pageshow', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f), initial = await f.page.evaluate(() => fixture.order());
    await holdAudioReply(f, { action: 'getState', blockUpdates: true });
    await f.page.evaluate(() => {
        window.phase4Commits = [];
        window.phase4Pending = [withPlayerAudioLayout(() => { phase4Commits.push('old-first'); return swapPlayerPositions(fixture.keys[0], fixture.keys[1]); })];
    });
    await waitHeldAudioReply(f);
    await f.page.evaluate(() => {
        window.phase4OldTicket = playerAudioBridge.batch.ticket;
        phase4Pending.push(withPlayerAudioLayout(() => { phase4Commits.push('old-second'); return resetPlayerPositions(); }));
        dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        window.phase4WhileHidden = withPlayerAudioLayout(() => { phase4Commits.push('hidden'); return true; });
    });
    assert.deepEqual(await f.page.evaluate(() => Promise.all(phase4Pending)), [false, false]);
    assert.deepEqual(await f.page.evaluate(() => ({ batch: playerAudioBridge.batch, queued: playerAudioBridge.queueLength,
        suspended: playerAudioBridge.suspended, hiddenResult: phase4WhileHidden, commits: phase4Commits })),
    { batch: null, queued: 0, suspended: true, hiddenResult: false, commits: [] });
    await release(f);
    await f.page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await settle(f);
    assert.deepEqual(await f.page.evaluate(() => fixture.order()), initial);
    await holdAudioReply(f, { action: 'getState', blockUpdates: true });
    await f.page.evaluate(() => { window.phase4Fresh = withPlayerAudioLayout(() => { phase4Commits.push('fresh'); return swapPlayerPositions(fixture.keys[0], fixture.keys[1]); }); });
    await waitHeldAudioReply(f);
    assert.equal(await f.page.evaluate(() => playerAudioBridge.batch.ticket !== phase4OldTicket), true);
    await f.page.evaluate(() => {
        const pane = document.getElementById('multi-stream-container');
        pane.setAttribute('data-umininn-layout-audio-ack', phase4OldTicket);
        pane.dispatchEvent(new Event('umininn-player-layout-ready', { bubbles: true }));
        pane.dispatchEvent(new Event('umininn-player-layout-restored', { bubbles: true }));
    });
    assert.deepEqual(await f.page.evaluate(() => ({ commits: phase4Commits, phase: playerAudioBridge.batch?.phase })),
        { commits: [], phase: 'prepare' });
    await release(f);
    assert.equal(await f.page.evaluate(() => phase4Fresh), true);
    await settle(f);
    assert.deepEqual(await f.page.evaluate(() => phase4Commits), ['fresh']);
    assert.notDeepEqual(await f.page.evaluate(() => fixture.order()), initial);
    await assertContinuity(f, before);
});

test('player layers: reentrant pagehide during one queued action stops the remaining actions and settles every caller', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f), initial = await f.page.evaluate(() => fixture.order());
    await holdAudioReply(f, { action: 'getState', blockUpdates: true });
    await f.page.evaluate(() => {
        window.phase4Commits = [];
        window.phase4Pending = [withPlayerAudioLayout(() => {
            phase4Commits.push('first');
            dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
            return true;
        })];
    });
    await waitHeldAudioReply(f);
    await f.page.evaluate(() => { phase4Pending.push(withPlayerAudioLayout(() => { phase4Commits.push('must-not-run'); return swapPlayerPositions(fixture.keys[0], fixture.keys[1]); })); });
    await release(f);
    assert.deepEqual(await f.page.evaluate(() => Promise.all(phase4Pending)), [false, false]);
    assert.deepEqual(await f.page.evaluate(() => ({ commits: phase4Commits, batch: playerAudioBridge.batch,
        queued: playerAudioBridge.queueLength, depth: playerAudioBridge.depth, suspended: playerAudioBridge.suspended })),
    { commits: ['first'], batch: null, queued: 0, depth: 0, suspended: true });
    await f.page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await settle(f);
    assert.deepEqual(await f.page.evaluate(() => fixture.order()), initial);
    await assertContinuity(f, before);
});

test('player layers: trusted global mute during a held layout capture supersedes its older sound snapshot', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f);
    await holdAudioReply(f, { action: 'getState', blockUpdates: true });
    await f.page.evaluate(() => { window.phase4PendingMove = swapPlayerPositions(fixture.keys[0], fixture.keys[1]); });
    await waitHeldAudioReply(f);
    await f.page.locator('#umininn-player-control-host #quick-mute').click();
    await release(f);
    assert.equal(await f.page.evaluate(() => phase4PendingMove), true);
    await waitAudio(f, media => media.every(value => value.muted));
    await settle(f);
    await waitAudio(f, media => media.every(value => value.muted));
    await assertAudioContinuity(f, before);
});

test('player layers: a newer explicit sound button wins over an older enlargement waiting for layout capture', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f), keys = await f.page.evaluate(() => fixture.keys);
    await holdAudioReply(f, { action: 'getState', blockUpdates: true });
    await actualMouseWindowAction(f, keys[0], 'enlarge');
    await waitHeldAudioReply(f);
    await actualMouseWindowAction(f, keys[4], 'audio-focus');
    await release(f);
    await waitSpan(f, keys[0], 2);
    await waitOnlyAudible(f, 2);
    await settle(f); await waitOnlyAudible(f, 2);
    await assertAudioContinuity(f, before);
});
