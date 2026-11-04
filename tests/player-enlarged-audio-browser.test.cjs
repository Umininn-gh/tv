'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');

// Exercise the real app, bridge and built userscript, including two foreign
// player documents. The fixture replaces media hosts, never sound ownership.
const harnessFile = path.join(__dirname, 'player-layout-browser.test.cjs');
const harnessRequire = createRequire(harnessFile), harnessModule = { exports: {} };
const harnessTest = Object.assign(() => {}, { before: test.before, after: test.after });
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + fs.readFileSync(harnessFile, 'utf8') + '\n' +
    'module.exports={fixture,optional,snapshot,assertContinuity,assertAudioContinuity,fixedDirectionGrid,waitWindowGeometry,' +
    'seedLayoutSound,waitOnlyAudible,waitAudio,exactSound,waitExactSound,startCornerDrag,moveCornerDrag,assertPreviewOnly,' +
    'waitSpan,assertEditorUiClosed,activeMediaSnapshot,assertActiveContinuity,holdAudioReply,waitHeldAudioReply,releaseAudioReply};\n})',
    { filename: harnessFile })(name => name === 'node:test' ? harnessTest : harnessRequire(name),
    harnessModule, harnessModule.exports, __dirname, harnessFile);
const { fixture, optional, snapshot, assertContinuity, assertAudioContinuity, fixedDirectionGrid, waitWindowGeometry,
    seedLayoutSound, waitOnlyAudible, waitAudio, exactSound, waitExactSound, startCornerDrag, moveCornerDrag, assertPreviewOnly,
    waitSpan, assertEditorUiClosed, activeMediaSnapshot, assertActiveContinuity, holdAudioReply, waitHeldAudioReply, releaseAudioReply } = harnessModule.exports;
const browserCase = { skip: process.env.UMININN_BROWSER_TESTS !== '1', timeout: 90000 };
const editorTile = (f, key) => f.page.locator(`.player-position-cell[data-player-key=${JSON.stringify(key)}]`);
const mediaIndex = [0, 1, 3, 4, 2];

async function settled(f) {
    await f.page.waitForFunction(() => playerAudioBridge.batch === null && playerAudioBridge.queueLength === 0);
    await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function setup(t, options = {}) {
    if (!optional(t)) return null;
    const f = await fixture(t, { width: 1200, height: 900, audioUserscript: true, ...options });
    await f.page.route(/\/assets\/(?:images\/)?mother-head-32\.png(?:\?|$)/, route => route.fulfill({ status: 204, body: '' }));
    if (options.clock) await f.page.clock.resume();
    await seedLayoutSound(f); await settled(f);
    const keys = await f.page.evaluate(() => fixture.keys);
    return { f, keys };
}
async function openEnlarge(f) {
    await f.page.locator('#enlarge-player').click();
    await f.page.waitForFunction(() => fixture.geometry().opened && fixture.geometry().mode === 'enlarge');
}
async function onlyLargeAudible(f, index) {
    const after = await waitOnlyAudible(f, mediaIndex[index]); await settled(f); return after;
}

test('committed editor growth solos native, paused, foreign and wrapped players at full volume without changing playback', browserCase, async t => {
    const result = await setup(t); if (!result) return; const { f, keys } = result;
    const before = await snapshot(f); await openEnlarge(f);
    for (const index of [0, 1, 2, 4]) {
        await editorTile(f, keys[index]).click(); await waitSpan(f, keys[index], 2);
        await onlyLargeAudible(f, index); await assertAudioContinuity(f, before);
        const geometry = await f.page.evaluate(() => getCurrentPlayerGeometry());
        assert.deepEqual(geometry.items.filter(item => item.span > 1).map(item => item.key), [keys[index]]);
    }
});

test('drag previews and cancellation leave sound alone; releasing real growth solos the committed player', browserCase, async t => {
    const result = await setup(t); if (!result) return; const { f, keys } = result;
    const before = await snapshot(f), sound = exactSound(before); await openEnlarge(f);
    const cancelled = await startCornerDrag(f, keys[2], 'se'); await moveCornerDrag(f, cancelled, .8);
    await assertPreviewOnly(f, cancelled); await waitExactSound(f, sound);
    await f.page.keyboard.press('Escape'); await f.page.mouse.up(); await waitExactSound(f, sound);
    assert.equal(await f.page.evaluate(() => fixture.geometry().opened), true, 'first Escape cancels only the preview');
    const committed = await startCornerDrag(f, keys[2], 'se'); await moveCornerDrag(f, committed, .8);
    await assertPreviewOnly(f, committed); await f.page.mouse.up(); await waitSpan(f, keys[2], 2);
    await onlyLargeAudible(f, 2); await assertAudioContinuity(f, before);
});

test('Finish Enlarge uses the currently displayed large player, while shrinking to 1x1 and finishing preserve sound', browserCase, async t => {
    const result = await setup(t); if (!result) return; const { f, keys } = result;
    await f.page.evaluate(key => enlargePlayer(key), keys[3]); await waitSpan(f, keys[3], 2); await settled(f);
    await openEnlarge(f); const before = await seedLayoutSound(f);
    await f.page.locator('.player-position-done').click(); await assertEditorUiClosed(f);
    await onlyLargeAudible(f, 3); await assertAudioContinuity(f, before);

    await openEnlarge(f);
    // A real manual audio command ends the earlier exclusive-focus intent;
    // merely assigning media fields would be repaired by that live owner.
    await f.page.locator('#umininn-player-control-host #quick-mute').click();
    await waitAudio(f, media => media.every(value => value.muted));
    const custom = await seedLayoutSound(f), sound = exactSound(custom);
    await f.page.locator('.player-position-shrink').click();
    await f.page.waitForFunction(() => getCurrentPlayerGeometry().items.every(item => item.span === 1)); await settled(f);
    await waitExactSound(f, sound); await f.page.locator('.player-position-done').click();
    await assertEditorUiClosed(f); await settled(f); await waitExactSound(f, sound); await assertAudioContinuity(f, custom);
});

test('the 30-second and 10-second enlarge deadlines solo the existing large tile without another size change', browserCase, async t => {
    for (const [entry, seconds] of [['toolbar', 30], ['corner', 10]]) await t.test(entry, { timeout: 45000 }, async st => {
        const result = await setup(st, { clock: true }); if (!result) return; const { f, keys } = result;
        await f.page.evaluate(key => enlargePlayer(key), keys[2]); await waitSpan(f, keys[2], 2); await settled(f);
        if (entry === 'corner') {
            await waitWindowGeometry(f);
            const button = f.page.locator('.player-window-enlarge-corner:not([hidden])').first();
            const box = await button.boundingBox(); assert.ok(box);
            const corner = await button.getAttribute('data-enlarge-corner');
            await f.page.mouse.click(corner.endsWith('w') ? box.x + 1.5 : box.x + box.width - 1.5,
                corner.startsWith('n') ? box.y + 1.5 : box.y + box.height - 1.5);
        } else await openEnlarge(f);
        assert.equal(await f.page.evaluate(() => fixture.geometry().opened), true);
        assert.match(await f.page.locator('.player-position-instructions').innerText(), new RegExp('閒置\\s*' + seconds + '\\s*秒'));
        await f.page.clock.pauseAt(await f.page.evaluate(() => Date.now() + 100));
        const before = await snapshot(f), geometry = await f.page.evaluate(() => JSON.stringify(getCurrentPlayerGeometry()));
        await f.page.clock.runFor(seconds * 1000 - 250);
        assert.equal(await f.page.evaluate(() => fixture.geometry().opened), true, 'the deadline must not finish early');
        await f.page.clock.runFor(300); await assertEditorUiClosed(f); await f.page.clock.resume();
        await onlyLargeAudible(f, 2); await assertAudioContinuity(f, before);
        assert.equal(await f.page.evaluate(() => JSON.stringify(getCurrentPlayerGeometry())), geometry, 'completion only changes sound');
    });
});

test('move completion, silent internal close and an empty enlarge completion do not replace manual sound', browserCase, async t => {
    const result = await setup(t); if (!result) return; const { f, keys } = result;
    await f.page.evaluate(key => enlargePlayer(key), keys[0]); await waitSpan(f, keys[0], 2); await settled(f);
    for (const close of ['move-done', 'internal', 'pagehide']) {
        await f.page.locator(close === 'move-done' ? '#adjust-player-positions' : '#enlarge-player').click();
        const before = await seedLayoutSound(f), sound = exactSound(before);
        if (close === 'move-done') await f.page.locator('.player-position-done').click();
        else if (close === 'internal') await f.page.evaluate(() => playerPositionEditor.close(false));
        else await f.page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
        await assertEditorUiClosed(f); await settled(f); await waitExactSound(f, sound); await assertAudioContinuity(f, before);
        if (close === 'pagehide') break;
    }
});

test('Finish Enlarge preserves an already accepted growth while sound capture is delayed', browserCase, async t => {
    const result = await setup(t); if (!result) return; const { f, keys } = result;
    const before = await snapshot(f); await openEnlarge(f);
    await holdAudioReply(f, { action: 'getState', blockUpdates: true });
    await editorTile(f, keys[2]).click(); await waitHeldAudioReply(f);
    await f.page.locator('.player-position-done').click(); await assertEditorUiClosed(f);
    await releaseAudioReply(f); await f.page.evaluate(() => { fixtureAudioGate.blockUpdates = false; });
    await waitSpan(f, keys[2], 2); await onlyLargeAudible(f, 2); await assertAudioContinuity(f, before);
});

test('Finish Enlarge preserves an accepted shrink to 1x1 and never solos the old large player', browserCase, async t => {
    const result = await setup(t); if (!result) return; const { f, keys } = result;
    await f.page.evaluate(key => enlargePlayer(key), keys[2]); await waitSpan(f, keys[2], 2); await settled(f);
    const before = await snapshot(f), sound = exactSound(before); await openEnlarge(f);
    await holdAudioReply(f, { action: 'getState', blockUpdates: true });
    await f.page.locator('.player-position-shrink').click(); await waitHeldAudioReply(f);
    await f.page.locator('.player-position-done').click(); await assertEditorUiClosed(f);
    await releaseAudioReply(f); await f.page.evaluate(() => { fixtureAudioGate.blockUpdates = false; }); await settled(f);
    assert.equal(await f.page.evaluate(() => getCurrentPlayerGeometry().items.every(item => item.span === 1)), true,
        'finishing cannot discard an accepted shrink or use the earlier 2x2 geometry');
    await waitExactSound(f, sound); await assertAudioContinuity(f, before);
});

test('a real manual mute newer than pending growth keeps priority over automatic enlargement sound', browserCase, async t => {
    const result = await setup(t); if (!result) return; const { f, keys } = result;
    const before = await snapshot(f); await openEnlarge(f);
    await holdAudioReply(f, { action: 'getState', blockUpdates: true });
    await editorTile(f, keys[2]).click(); await waitHeldAudioReply(f);
    await f.page.locator('#umininn-player-control-host #quick-mute').click();
    await waitAudio(f, media => media.every(value => value.muted));
    await releaseAudioReply(f); await f.page.evaluate(() => { fixtureAudioGate.blockUpdates = false; });
    await waitSpan(f, keys[2], 2); await settled(f);
    await waitAudio(f, media => media.every(value => value.muted)); await assertAudioContinuity(f, before);
});

test('internally closing an editor invalidates its delayed growth without touching the next session', browserCase, async t => {
    const result = await setup(t); if (!result) return; const { f, keys } = result;
    const before = await snapshot(f), sound = exactSound(before); await openEnlarge(f);
    await holdAudioReply(f, { action: 'getState', blockUpdates: true });
    await editorTile(f, keys[2]).click(); await waitHeldAudioReply(f);
    await f.page.evaluate(() => playerPositionEditor.close(false)); await openEnlarge(f);
    await releaseAudioReply(f); await f.page.evaluate(() => { fixtureAudioGate.blockUpdates = false; }); await settled(f);
    assert.equal(await f.page.evaluate(() => getCurrentPlayerGeometry().items.every(item => item.span === 1)), true);
    await waitExactSound(f, sound); await assertAudioContinuity(f, before);
    await editorTile(f, keys[0]).click(); await waitSpan(f, keys[0], 2); await onlyLargeAudible(f, 0);
});

test('an old remembered focus absent from displayed geometry never solos a different small player on completion', browserCase, async t => {
    const result = await setup(t); if (!result) return; const { f, keys } = result;
    await f.page.evaluate(key => enlargePlayer(key), keys[0]); await waitSpan(f, keys[0], 2); await settled(f);
    const retained = await activeMediaSnapshot(f, keys.slice(1), { remember: true });
    await f.page.evaluate(() => syncActivePlayers(channels.slice(1))); await settled(f);
    assert.equal(await f.page.evaluate(() => getCurrentPlayerGeometry().items.every(item => item.span === 1)), true);
    await openEnlarge(f); const before = exactSound(await snapshot(f));
    await f.page.locator('.player-position-done').click(); await assertEditorUiClosed(f); await settled(f);
    await waitExactSound(f, before); await assertActiveContinuity(f, retained);
});

test('without a sound controller, enlargement and completion still work without errors or media replacement', browserCase, async t => {
    if (!optional(t)) return;
    const f = await fixture(t, { width: 1200, height: 900 }), before = await snapshot(f);
    const key = await f.page.evaluate(() => fixture.keys[2]); await openEnlarge(f);
    await editorTile(f, key).click(); await waitSpan(f, key, 2);
    await f.page.locator('.player-position-done').click(); await assertEditorUiClosed(f); await assertContinuity(f, before);
});
