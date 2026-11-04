'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { assertCompact } = require('./helpers/player-layout-compaction.cjs');
const harnessFile = path.join(__dirname, 'player-layout-browser.test.cjs');
const harnessRequire = createRequire(harnessFile), harnessModule = { exports: {} };
const harnessTest = Object.assign(() => {}, { before: test.before, after: test.after });
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + fs.readFileSync(harnessFile, 'utf8') + '\n' +
    'module.exports={fixture,optional,snapshot,assertContinuity,fixedDirectionGrid,waitWindowGeometry,' +
    'startCornerDrag,moveCornerDrag,assertPreviewOnly,activeMediaSnapshot,assertActiveContinuity};\n})', { filename: harnessFile })(
    name => name === 'node:test' ? harnessTest : harnessRequire(name), harnessModule, harnessModule.exports, __dirname, harnessFile);
const { fixture, optional, snapshot, assertContinuity, fixedDirectionGrid, waitWindowGeometry,
    startCornerDrag, moveCornerDrag, assertPreviewOnly, activeMediaSnapshot, assertActiveContinuity } = harnessModule.exports;
const browserCase = { skip: process.env.UMININN_BROWSER_TESTS !== '1', timeout: 90000 };
const cell = (f, key) => f.page.locator(`.player-position-cell[data-player-key=${JSON.stringify(key)}]`);
async function settled(f) {
    await f.page.waitForFunction(() => playerAudioBridge.batch === null && playerAudioBridge.queueLength === 0);
    await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function read(f, key) {
    return f.page.evaluate(key => {
        const pane = document.getElementById('multi-stream-container'), p = pane.getBoundingClientRect(), s = getComputedStyle(pane);
        const rect = getPlayerLayoutRect(getPlayerElement(activePlayers.get(key)));
        const grid = getCurrentPlayerGeometry(), item = grid.items.find(item => item.key === key);
        return { grid: JSON.parse(JSON.stringify(grid)), item, presented: PlayerLayout.presentation(grid).items.find(item => item.key === key),
            pane: { x: p.left + (parseFloat(s.borderLeftWidth) || 0) + (parseFloat(s.paddingLeft) || 0),
                y: p.top + (parseFloat(s.borderTopWidth) || 0) + (parseFloat(s.paddingTop) || 0),
                width: pane.clientWidth - (parseFloat(s.paddingLeft) || 0) - (parseFloat(s.paddingRight) || 0),
                height: pane.clientHeight - (parseFloat(s.paddingTop) || 0) - (parseFloat(s.paddingBottom) || 0) },
            rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom } };
    }, key);
}
async function setup(t, { players = 7, columns = 4, oldLarge = true, oldLargeColumn = 1, oldLargeSpan = 3,
    targetSourceIndex, targetSlot } = {}) {
    if (!optional(t)) return null;
    const f = await fixture(t, { width: 1400, height: 1000, viewport: { width: 4400, height: 3800 }, players });
    if (players < 5) {
        // The shared media fixture initially mounts five probes. Select a real
        // three/four-player subset while retaining both foreign documents.
        await f.page.evaluate(count => {
            const list = [...activePlayers.values()].map(entry => entry.channel);
            syncActivePlayers(count === 3 ? list.slice(1, 4) : list.slice(0, count));
        }, players);
        await settled(f);
    }
    // Outward growth can leave the pane. Keep all real mouse input inside the
    // browser viewport so Firefox cannot treat it as an OS-level cancellation.
    await f.page.locator('#multi-stream-container-wrapper').evaluate(node => { node.style.margin = '1400px'; });
    const keys = await f.page.evaluate(() => getPlayerPositionKeys());
    if (Number.isInteger(targetSourceIndex) && Number.isInteger(targetSlot))
        [keys[targetSourceIndex], keys[targetSlot]] = [keys[targetSlot], keys[targetSourceIndex]];
    await fixedDirectionGrid(f, { columns, order: keys, focus: oldLarge ? { key: keys[0], span: oldLargeSpan, row: 0, column: oldLargeColumn } : null });
    await f.page.locator('#enlarge-player').click(); await settled(f);
    return { f, keys };
}

test('a centered tail tile dragged right grows on the right instead of jumping across the pane after release', browserCase, async t => {
    const result = await setup(t); if (!result) return; const { f, keys } = result, key = keys[6];
    const before = await read(f, key), continuity = await snapshot(f);
    assert.equal(before.grid.columns, 4); assert.equal(before.grid.rows, 4);
    assert.equal(before.presented.column - before.item.column, .5, 'the repro starts with a half-track centered tail');
    const drag = await startCornerDrag(f, key, 'ne');
    await moveCornerDrag(f, drag, .8, .2); await assertPreviewOnly(f, drag);
    const preview = await f.page.locator('.player-resize-preview').boundingBox();
    assert.ok(preview.x > before.pane.x + before.pane.width / 2, 'the physical feedback starts in the right half');
    await f.page.mouse.up();
    await f.page.waitForFunction(key => getCurrentPlayerGeometry().items.find(item => item.key === key)?.span === 2, key);
    await settled(f);
    const after = await read(f, key);
    assert.ok(after.rect.x + after.rect.width / 2 >= after.pane.x + after.pane.width / 2,
        'a rightward gesture must not send the released tile into the left half: ' + JSON.stringify({ before, preview, after }));
    assertCompact(after.grid); assert.equal(after.grid.items.filter(item => item.span > 1).length, 1);
    if (process.env.UMININN_CENTERED_GROWTH_SCREENSHOTS) {
        const directory = path.resolve(process.env.UMININN_CENTERED_GROWTH_SCREENSHOTS); fs.mkdirSync(directory, { recursive: true });
        await f.page.locator('#multi-stream-container-wrapper').screenshot({ path: path.join(directory,
            (process.env.UMININN_BROWSER_ENGINE || 'chromium') + '-centered-growth-after.png') });
    }
    await f.page.keyboard.press('Escape'); await waitWindowGeometry(f); await assertContinuity(f, continuity);
});

function assertFeedbackSide(before, preview, after, label) {
    for (const [origin, size] of [['x', 'width'], ['y', 'height']]) {
        const feedback = (preview[origin] + preview[size] / 2 - before.pane[origin]) / before.pane[size];
        const actual = (after.rect[origin] + after.rect[size] / 2 - after.pane[origin]) / after.pane[size];
        if (Math.abs(feedback - .5) <= .02) continue;
        assert.ok(feedback > .5 ? actual >= .5 - .001 : actual <= .5 + .001,
            label + ': final ' + origin + ' side follows the visible feedback instead of crossing the pane: ' +
            JSON.stringify({ feedback, actual, before, preview, after }));
    }
}
async function committedDrag(f, key, corner, delta, span) {
    const before = await read(f, key), drag = await startCornerDrag(f, key, corner);
    await moveCornerDrag(f, drag, delta, Math.sign(delta) * .2); await assertPreviewOnly(f, drag);
    const preview = await f.page.locator('.player-resize-preview').boundingBox();
    await f.page.mouse.up();
    await f.page.waitForFunction(({ key, span }) => getCurrentPlayerGeometry().items.find(item => item.key === key)?.span === span, { key, span });
    await settled(f);
    const after = await read(f, key);
    assertFeedbackSide(before, preview, after, corner + ' ' + before.item.span + '→' + span);
    assertCompact(after.grid);
    assert.equal(after.grid.items.filter(item => item.span > 1).length, span > 1 ? 1 : 0);
    return after;
}

test('a centered one-third-width singleton grows in the displayed lower half instead of jumping upward', browserCase, async t => {
    const result = await setup(t, { players: 4, columns: 3, oldLarge: false }); if (!result) return;
    const { f, keys } = result, key = keys[3], before = await read(f, key), continuity = await activeMediaSnapshot(f, keys, { remember: true });
    assert.equal(keys.length, 4);
    assert.equal(before.presented.column - before.item.column, 1);
    assert.ok(Math.abs(before.rect.width / before.pane.width - 1 / 3) < .02, 'the source occupies one third of the pane width');
    await committedDrag(f, key, 'se', .8, 2);
    await f.page.keyboard.press('Escape'); await waitWindowGeometry(f); await assertActiveContinuity(f, continuity);
});

test('one-third and half-width centered singletons support all growth corners, shrink-to-one and opposite-corner regrowth', browserCase, async t => {
    for (const config of [{ players: 4, columns: 3 }, { players: 3, columns: 2 }])
        for (const corner of ['nw', 'ne', 'sw', 'se']) await t.test(config.columns + '-columns-' + corner, async st => {
            const result = await setup(st, { ...config, oldLarge: false }); if (!result) return;
            const { f, keys } = result, key = keys.at(-1), continuity = await activeMediaSnapshot(f, keys, { remember: true }), before = await read(f, key);
            assert.equal(keys.length, config.players);
            assert.notEqual(before.presented.column, before.item.column, 'the singleton starts at its real centered position');
            await committedDrag(f, key, corner, .8, 2);
            await committedDrag(f, key, corner, -.8, 1);
            const opposite = { nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' }[corner];
            await committedDrag(f, key, opposite, .8, 2);
            await committedDrag(f, key, opposite, -.8, 1);
            // Shrinking below a single unit is a pure no-op, including storage.
            const stable = await read(f, key), drag = await startCornerDrag(f, key, corner);
            await moveCornerDrag(f, drag, -.8, -.2); await settled(f);
            assert.equal(await f.page.locator('.player-resize-preview').isVisible(), false);
            await f.page.mouse.up(); await settled(f); assert.deepEqual((await read(f, key)).grid, stable.grid);
            await f.page.keyboard.press('Escape'); await waitWindowGeometry(f); await assertActiveContinuity(f, continuity);
        });
});

test('resizing the pane cancels an old centered preview and a fresh gesture uses the reflowed tracks', browserCase, async t => {
    const result = await setup(t, { players: 4, columns: 3, oldLarge: false }); if (!result) return;
    const { f, keys } = result, key = keys[3], continuity = await activeMediaSnapshot(f, keys, { remember: true }), drag = await startCornerDrag(f, key, 'ne');
    await moveCornerDrag(f, drag, .8, .2); await assertPreviewOnly(f, drag);
    await f.page.evaluate(() => fixture.resize(1120, 820));
    await f.page.waitForFunction(() => document.querySelector('.player-resize-preview').hidden);
    await f.page.mouse.up(); await settled(f);
    assert.equal((await read(f, key)).item.span, 1, 'late release cannot commit the old pane measurement');
    await f.page.keyboard.press('Escape'); await f.page.waitForTimeout(260); await waitWindowGeometry(f);
    await fixedDirectionGrid(f, { columns: 3, order: keys }); await settled(f);
    await f.page.locator('#enlarge-player').click(); await settled(f);
    await committedDrag(f, key, 'sw', .8, 2);
    await f.page.keyboard.press('Escape'); await waitWindowGeometry(f); await assertActiveContinuity(f, continuity);
});

test('an already enlarged one-third-width square centered on six tracks grows and shrinks through all four corners', browserCase, async t => {
    for (const corner of ['nw', 'ne', 'sw', 'se']) await t.test(corner, async st => {
        const result = await setup(st, { players: 7, columns: 6, oldLargeColumn: 2, oldLargeSpan: 2 }); if (!result) return;
        const { f, keys } = result, key = keys[0], before = await read(f, key), continuity = await snapshot(f);
        assert.equal(before.item.span, 2); assert.equal(before.grid.columns, 6);
        assert.ok(Math.abs(before.rect.width / before.pane.width - 1 / 3) < .02, 'the existing large square occupies one third of the pane width');
        assert.ok(Math.abs((before.rect.x + before.rect.width / 2 - before.pane.x) / before.pane.width - .5) < .01,
            'this square starts at the visual horizontal center even without a fractional-row shift');
        await committedDrag(f, key, corner, .8, 3);
        await committedDrag(f, key, corner, -.8, 2);
        await f.page.keyboard.press('Escape'); await waitWindowGeometry(f); await assertContinuity(f, continuity);
    });
});

test('odd final rows of three and five realigned players keep left, middle and right growth and shrink intent', browserCase, async t => {
    for (const config of [{ players: 7, columns: 4, tail: 3 }, { players: 11, columns: 6, tail: 5 }])
        for (const [name, index, source] of [['left', 0, 0], ['middle', Math.floor(config.tail / 2), 2], ['right', config.tail - 1, 3]])
            for (const corner of ['nw', 'ne', 'sw', 'se']) await t.test(config.tail + '-tail-' + name + '-' + corner, async st => {
                const slot = config.players - config.tail + index;
                // Put native media and both genuine foreign documents in the
                // tested tail slots instead of resizing inert extra fixtures.
                const result = await setup(st, { ...config, oldLarge: false, targetSourceIndex: source, targetSlot: slot });
                if (!result) return; const { f, keys } = result, key = keys[slot], before = await read(f, key), continuity = await snapshot(f);
                assert.equal(before.grid.items.filter(item => item.row === before.grid.rows - 1).length, config.tail);
                assert.equal(before.presented.column - before.item.column, .5);
                assert.equal(await f.page.evaluate(key => getPlayerElement(activePlayers.get(key)).tagName, key), source === 0 ? 'VIDEO' : 'IFRAME');
                await committedDrag(f, key, corner, .8, 2);
                await committedDrag(f, key, corner, -.8, 1);
                await f.page.keyboard.press('Escape'); await waitWindowGeometry(f); await assertContinuity(f, continuity);
            });
});

test('even final rows of two and four remain stable for opposing native and foreign drag corners', browserCase, async t => {
    for (const config of [{ players: 6, columns: 4, tail: 2 }, { players: 9, columns: 5, tail: 4 }])
        for (const [name, index, source, corner] of [['left', 0, 0, 'sw'], ['right', config.tail - 1, 3, 'ne']])
            await t.test(config.tail + '-tail-' + name, async st => {
                const slot = config.players - config.tail + index;
                const result = await setup(st, { ...config, oldLarge: false, targetSourceIndex: source, targetSlot: slot });
                if (!result) return; const { f, keys } = result, key = keys[slot], before = await read(f, key), continuity = await snapshot(f);
                assert.equal(before.grid.items.filter(item => item.row === before.grid.rows - 1).length, config.tail);
                await committedDrag(f, key, corner, .8, 2);
                await committedDrag(f, key, corner, -.8, 1);
                await f.page.keyboard.press('Escape'); await waitWindowGeometry(f); await assertContinuity(f, continuity);
            });
});

test('all four centered-tail drag corners preserve the preview side through refitting and replacement of an old large tile', browserCase, async t => {
    for (const corner of ['nw', 'ne', 'sw', 'se']) await t.test(corner, async st => {
        const result = await setup(st); if (!result) return; const { f, keys } = result, key = keys[5];
        const continuity = await snapshot(f), before = await read(f, key), drag = await startCornerDrag(f, key, corner);
        await moveCornerDrag(f, drag, .8, .2); await assertPreviewOnly(f, drag);
        const preview = await f.page.locator('.player-resize-preview').boundingBox();
        const requestedRight = preview.x + preview.width / 2 > before.pane.x + before.pane.width / 2;
        assert.equal(requestedRight, corner.endsWith('e'), 'middle-tile feedback follows the chosen horizontal corner');
        await f.page.mouse.up();
        await f.page.waitForFunction(key => getCurrentPlayerGeometry().items.find(item => item.key === key)?.span === 2, key);
        await settled(f);
        const after = await read(f, key), center = after.rect.x + after.rect.width / 2, middle = after.pane.x + after.pane.width / 2;
        assert.ok(requestedRight ? center >= middle - .65 : center <= middle + .65,
            corner + ': released square must stay on its feedback side: ' + JSON.stringify({ before, preview, after }));
        assertCompact(after.grid);
        assert.equal(after.grid.items.find(item => item.key === keys[0]).span, 1, 'the previous large player returns to one unit');
        assert.deepEqual(after.grid.items.filter(item => item.span > 1).map(item => item.key), [key]);
        await f.page.keyboard.press('Escape'); await waitWindowGeometry(f); await assertContinuity(f, continuity);
    });
});

test('normal incomplete rows and mirrored centered tails keep their growth feedback side', browserCase, async t => {
    for (const config of [
        { name: 'normal-right', oldLarge: false, index: 6, corner: 'ne', right: true },
        { name: 'mirrored-left', oldLarge: true, oldLargeColumn: 0, index: 4, corner: 'nw', right: false }
    ]) await t.test(config.name, async st => {
        const result = await setup(st, config); if (!result) return; const { f, keys } = result, key = keys[config.index];
        const continuity = await snapshot(f), before = await read(f, key);
        assert.notEqual(before.presented.column, before.item.column, 'the source row really is centered');
        const drag = await startCornerDrag(f, key, config.corner); await moveCornerDrag(f, drag, .8, .2); await assertPreviewOnly(f, drag);
        const preview = await f.page.locator('.player-resize-preview').boundingBox();
        assert.equal(preview.x + preview.width / 2 > before.pane.x + before.pane.width / 2, config.right);
        await f.page.mouse.up();
        await f.page.waitForFunction(key => getCurrentPlayerGeometry().items.find(item => item.key === key)?.span === 2, key);
        await settled(f);
        const after = await read(f, key), center = after.rect.x + after.rect.width / 2, middle = after.pane.x + after.pane.width / 2;
        assert.ok(config.right ? center >= middle - .65 : center <= middle + .65,
            config.name + ': final side follows the visible gesture: ' + JSON.stringify({ before, preview, after }));
        assertCompact(after.grid); await f.page.keyboard.press('Escape'); await waitWindowGeometry(f); await assertContinuity(f, continuity);
    });
});
