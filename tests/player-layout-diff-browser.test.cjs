'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Exercise the shipped application and userscript against real media and real
// cross-origin frames, using the same closed fixture as the broader regressions.
const harnessFile = path.join(__dirname, 'player-layout-browser.test.cjs');
const harnessRequire = createRequire(harnessFile);
const harnessTest = Object.assign(() => {}, { before: test.before, after: test.after });
const harnessModule = { exports: {} };
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + fs.readFileSync(harnessFile, 'utf8') + '\n' +
    'module.exports={fixture,snapshot,assertContinuity,assertAudioContinuity,optional,fixedDirectionGrid,settlePane,positionCell,waitSpan,waitWindowGeometry,' +
    'seedLayoutSound,exactSound,waitExactSound,holdAudioReply,waitHeldAudioReply,releaseAudioReply,actualMouseWindowAction,waitOnlyAudible,waitFocusStatus,' +
    'startCornerDrag,moveCornerDrag,assertResizeIdle,playBookmarkMedia,replaceBookmarkSound};\n})',
    { filename: harnessFile })(name => name === 'node:test' ? harnessTest : harnessRequire(name),
    harnessModule, harnessModule.exports, __dirname, harnessFile);
const { fixture, snapshot, assertContinuity, assertAudioContinuity, optional, fixedDirectionGrid, settlePane, positionCell,
    waitSpan, waitWindowGeometry, seedLayoutSound, exactSound, waitExactSound, holdAudioReply, waitHeldAudioReply,
    releaseAudioReply, actualMouseWindowAction, waitOnlyAudible, waitFocusStatus, startCornerDrag, moveCornerDrag,
    assertResizeIdle, playBookmarkMedia, replaceBookmarkSound } = harnessModule.exports;
const browserCase = { skip: process.env.UMININN_BROWSER_TESTS !== '1', timeout: 60000 };

async function setup(t, options = {}) {
    if (!optional(t)) return null;
    const f = await fixture(t, { width: 1200, height: 800, audioUserscript: true, ...options });
    await seedLayoutSound(f);
    await settle(f);
    return f;
}
async function settle(f) {
    await f.page.waitForFunction(() => playerAudioLayoutBatch === null && playerAudioLayoutQueue.length === 0);
    await f.page.waitForTimeout(260);
    await f.page.waitForFunction(() => playerAudioLayoutBatch === null && playerAudioLayoutQueue.length === 0);
    await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function readGeometry(f) {
    return f.page.evaluate(() => {
        const value = getCurrentPlayerGeometry();
        return { columns: value.columns, rows: value.rows, items: [...value.items].sort((a, b) => a.key.localeCompare(b.key)) };
    });
}
async function trace(f) {
    await settle(f);
    await f.page.evaluate(() => {
        window.phase3Trace?.observer.disconnect();
        const pane = document.getElementById('multi-stream-container');
        const nodes = new Map([...activePlayers].map(([key, entry]) => [getPlayerElement(entry), key]));
        const data = window.phase3Trace = { mutations: [], refresh: {}, audioStart: fixtureLayoutEvents.length };
        data.observer = new MutationObserver(records => {
            for (const record of records) if (record.target === pane || nodes.has(record.target))
                data.mutations.push({ key: record.target === pane ? '$pane' : nodes.get(record.target), attribute: record.attributeName });
        });
        data.observer.observe(pane, { subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
        for (const [name, owner, method] of [['editor', playerPositionEditor, 'refresh'], ['editorLayout', playerPositionEditor, 'layoutChanged'],
            ['names', playerNameOverlay, 'refresh'], ['windows', playerWindowControls, 'refresh']]) {
            if (!owner || owner[method]?.phase3Observed) continue;
            const original = owner[method];
            const wrapped = function (...args) {
                phase3Trace.refresh[name] = (phase3Trace.refresh[name] || 0) + 1;
                return original.apply(this, args);
            };
            wrapped.phase3Observed = true;
            owner[method] = wrapped;
        }
    });
}
async function readTrace(f) {
    return f.page.evaluate(() => ({ mutations: phase3Trace.mutations, refresh: phase3Trace.refresh,
        before: fixtureLayoutEvents.slice(phase3Trace.audioStart).filter(event => event.type === 'umininn-player-layout-before').length }));
}

test('layout diff: repeated identical updates and lifecycle resume perform no layout DOM writes or audio capture', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f), initial = await readGeometry(f);
    await trace(f);
    await f.page.evaluate(async () => {
        for (let index = 0; index < 20; index++) await updatePlayerLayout({ force: index % 2 === 0 });
        dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await settle(f);
    assert.deepEqual(await readGeometry(f), initial);
    assert.deepEqual(await readTrace(f), { mutations: [], refresh: {}, before: 0 },
        'an unchanged refresh must not mutate projection, rebuild overlays or start a userscript capture');
    await assertContinuity(f, before);
});

test('layout diff: invalid and unchanged operations skip audio while preserving reset and selection state', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f), initial = await readGeometry(f), keys = await f.page.evaluate(() => fixture.keys);
    await trace(f);
    const results = await f.page.evaluate(async keys => [
        await swapPlayerPositions(keys[0], keys[0]),
        await movePlayerDirection(keys[0], 'left', keys[1]),
        await shrinkPlayer(keys[0]),
        await closePlayer('missing-player'),
        await enlargePlayer('missing-player')
    ], keys);
    assert.deepEqual(results, [false, false, false, false, false]);
    await f.page.evaluate(async () => { await syncActivePlayers(channels); await resetPlayerPositions(); });
    await settle(f);
    assert.deepEqual(await readGeometry(f), initial);
    assert.deepEqual(await readTrace(f), { mutations: [], refresh: {}, before: 0 },
        'same selection and already-default reset do not need layout projection, overlay rebuilding or audio preservation');
    await assertContinuity(f, before);
});

test('layout diff: a channel-name-only change refreshes labels without treating stable cells as an audio layout change', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f), initial = await readGeometry(f), key = await f.page.evaluate(() => fixture.keys[0]);
    await f.page.locator('#more-channels-btn').click();
    await f.page.waitForFunction(() => document.querySelectorAll('.player-name-label').length === 5);
    await trace(f);
    const name = '改名測試 <b> 保留播放器與聲音';
    await f.page.evaluate(async ({ key, name }) => {
        channels = channels.map(channel => ChannelList.channelKey(channel) === key ? { ...channel, name } : channel);
        await syncActivePlayers(channels);
    }, { key, name });
    await f.page.waitForFunction(({ key, name }) => {
        const label = [...document.querySelectorAll('.player-name-cell')].find(element => element.dataset.playerKey === key)?.firstChild;
        const button = [...document.querySelectorAll('.player-window-cell')].find(element => element.dataset.playerKey === key)?.querySelector('[data-player-action="enlarge"]');
        return label?.textContent === name && button?.title.includes(name);
    }, { key, name });
    await settle(f);
    assert.deepEqual(await readGeometry(f), initial);
    assert.equal((await readTrace(f)).before, 0, 'a metadata-only update still refreshes names without requesting sound capture');
    assert.equal(await f.page.locator('#player-name-overlay b').count(), 0);
    await assertContinuity(f, before);
});

test('layout diff: an ordinary exchange updates only the two changed player projections and preserves every media instance', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f), keys = await f.page.evaluate(() => fixture.keys);
    await trace(f);
    assert.equal(await f.page.evaluate(keys => swapPlayerPositions(keys[0], keys[1]), keys), true);
    await settle(f);
    const result = await readTrace(f);
    assert.deepEqual([...new Set(result.mutations.filter(item => item.key !== '$pane').map(item => item.key))].sort(), keys.slice(0, 2).sort(),
        'unaffected tiles must not receive redundant style/order writes');
    assert.equal(result.before, 1, 'one actual exchange still has one sound-preserving transaction');
    const committed = await readGeometry(f);
    await trace(f);
    await f.page.evaluate(async () => { for (let index = 0; index < 20; index++) await updatePlayerLayout(); });
    await settle(f);
    assert.deepEqual(await readGeometry(f), committed);
    assert.deepEqual(await readTrace(f), { mutations: [], refresh: {}, before: 0 },
        'the exchange must also advance the observer baseline, so later updates do not rediscover the same move');
    await assertContinuity(f, before);
});

test('layout diff: queued opposite directions are re-evaluated after the earlier held move instead of discarded as an old-state no-op', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const keys = await f.page.evaluate(() => fixture.keys), key = keys[0];
    await fixedDirectionGrid(f, { columns: 3, focus: { key, span: 2, row: 0, column: 0 }, order: keys });
    await settle(f);
    const before = await snapshot(f), initial = await readGeometry(f);
    const neighbor = initial.items.find(item => item.row === 0 && item.column === 2).key;
    await holdAudioReply(f, { action: 'getState', blockUpdates: true });
    await f.page.evaluate(({ key, neighbor }) => { window.phase3FirstMove = Promise.resolve(movePlayerDirection(key, 'right', neighbor)); }, { key, neighbor });
    await waitHeldAudioReply(f);
    assert.deepEqual(await readGeometry(f), initial, 'preparing a transaction cannot commit geometry before audio capture');
    await f.page.evaluate(({ key, neighbor }) => { window.phase3SecondMove = Promise.resolve(movePlayerDirection(key, 'left', neighbor)); }, { key, neighbor });
    assert.deepEqual(await readGeometry(f), initial, 'both requests remain uncommitted while capture is held');
    await releaseAudioReply(f);
    await f.page.evaluate(() => { fixtureAudioGate.blockUpdates = false; });
    assert.deepEqual(await f.page.evaluate(() => Promise.all([phase3FirstMove, phase3SecondMove])), [true, true]);
    await settle(f);
    assert.deepEqual(await readGeometry(f), initial, 'the second action becomes a valid left step after the first right step');
    await assertContinuity(f, before);
});

test('layout diff: same geometry does not suppress a bookmark explicit saved audio policy', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const saved = await f.page.evaluate(() => capturePlayerBookmark()), initial = await readGeometry(f);
    await replaceBookmarkSound(f);
    await playBookmarkMedia(f);
    const before = await snapshot(f);
    await trace(f);
    assert.deepEqual(await f.page.evaluate(saved => applyPlayerBookmark(saved), saved), { applied: 5, missing: 0 });
    await waitExactSound(f, [{ muted: true, volume: .91 }, { muted: true, volume: .91 }, { muted: false, volume: .59 },
        { muted: false, volume: .26 }, { muted: true, volume: .91 }]);
    await settle(f);
    assert.deepEqual(await readGeometry(f), initial);
    assert.equal((await readTrace(f)).before, 1, 'saved sound remains an explicit action despite an identical cell layout');
    await assertAudioContinuity(f, before);
    await f.page.waitForTimeout(900);
    const withoutAudio = { ...saved }; delete withoutAudio.audio;
    const beforePlain = await snapshot(f);
    await trace(f);
    assert.deepEqual(await f.page.evaluate(value => applyPlayerBookmark(value), withoutAudio), { applied: 5, missing: 0 });
    await f.page.waitForTimeout(750); await settle(f);
    assert.deepEqual(await readGeometry(f), initial);
    assert.equal((await readTrace(f)).before, 0,
        'an identical bookmark without sound data still completes its UI/recovery action without capturing layout audio');
    assert.deepEqual((await readTrace(f)).mutations, [], 'an identical bookmark does not rewrite the pane or its player cells');
    await assertContinuity(f, beforePlain);
});

test('layout diff: explicit same-player solo and enlargement still open only the target at full volume', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f), key = await f.page.evaluate(() => fixture.keys[0]);
    await actualMouseWindowAction(f, key, 'audio-focus');
    await waitOnlyAudible(f, 0);
    // The user may mute the current target manually without changing any cell.
    await f.page.evaluate(() => { fixtureMedia[0].video.muted = true; fixtureMedia[0].video.volume = .19; });
    await actualMouseWindowAction(f, key, 'audio-focus');
    await waitOnlyAudible(f, 0);
    await actualMouseWindowAction(f, key, 'enlarge');
    await waitSpan(f, key, 2); await waitOnlyAudible(f, 0); await waitFocusStatus(f, '只開啟');
    await assertAudioContinuity(f, before);
});

test('layout diff: small physical resizes update overlay bounds without a sound transaction or a logical grid change', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f), key = await f.page.evaluate(() => fixture.keys[0]);
    await f.page.evaluate(key => enlargePlayer(key), key);
    await settle(f);
    const initial = await readGeometry(f);
    await trace(f);
    await settlePane(f, 1202, 801); await waitWindowGeometry(f); await settle(f);
    assert.deepEqual(await readGeometry(f), initial);
    assert.equal((await readTrace(f)).before, 0, 'pixels changing with unchanged tracks/cells need no saved-sound round trip');
    await assertContinuity(f, before);
});

test('layout diff: a cancelled corner preview never starts audio capture or commits its preview cells', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f), key = await f.page.evaluate(() => fixture.keys[0]);
    await f.page.locator('#enlarge-player').click();
    const initial = await readGeometry(f);
    await trace(f);
    const drag = await startCornerDrag(f, key, 'se');
    await moveCornerDrag(f, drag, .8);
    await f.page.keyboard.press('Escape');
    await f.page.mouse.up(); await assertResizeIdle(f); await settle(f);
    assert.deepEqual(await readGeometry(f), initial);
    assert.equal((await readTrace(f)).before, 0);
    await assertContinuity(f, before);
});
