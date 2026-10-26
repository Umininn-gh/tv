'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { dockEdges, dockScore, prefixHoles, assertCompact, assertBestDocking } = require('./helpers/player-layout-compaction.cjs');

// Trusted controls against shipped app/CSS, local media and foreign-frame
// documents. The shared harness intercepts every network request.
const harnessFile = path.join(__dirname, 'player-layout-browser.test.cjs');
const harnessRequire = createRequire(harnessFile), harnessModule = { exports: {} };
const harnessTest = Object.assign(() => {}, { before: test.before, after: test.after });
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + fs.readFileSync(harnessFile, 'utf8') + '\n' +
    'module.exports={fixture,optional,snapshot,assertContinuity,assertFits,fixedDirectionGrid,waitWindowGeometry,actualMouseWindowAction};\n})',
    { filename: harnessFile })(name => name === 'node:test' ? harnessTest : harnessRequire(name),
    harnessModule, harnessModule.exports, __dirname, harnessFile);
const { fixture, optional, snapshot, assertContinuity, assertFits, fixedDirectionGrid,
    waitWindowGeometry, actualMouseWindowAction } = harnessModule.exports;
const browserCase = { skip: process.env.UMININN_BROWSER_TESTS !== '1', timeout: 120000 };
const cell = (layout, key) => layout.items.find(value => value.key === key);

async function settle(f) {
    await f.page.waitForFunction(() => playerAudioBridge.batch === null && playerAudioBridge.queueLength === 0);
    await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function read(f) {
    await settle(f);
    return f.page.evaluate(() => {
        const value = getCurrentPlayerGeometry();
        return { columns: value.columns, rows: value.rows,
            items: [...value.items].sort((a, b) => a.key.localeCompare(b.key)) };
    });
}
async function waitSize(f, key, span) {
    await f.page.waitForFunction(({ key, span }) =>
        getCurrentPlayerGeometry().items.find(value => value.key === key)?.span === span, { key, span });
    return read(f);
}
async function assertValid(f) {
    const layout = await read(f), active = await f.page.evaluate(() => [...activePlayers.keys()]);
    assert.deepEqual(layout.items.map(value => value.key).sort(), active.sort());
    assertCompact(layout);
    assertFits(await f.page.evaluate(() => fixture.grid()));
    assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
    return layout;
}
async function minus(f, key, span) {
    const before = await read(f);
    await actualMouseWindowAction(f, key, 'shrink');
    const after = await waitSize(f, key, span); await waitWindowGeometry(f);
    assertBestDocking(before, after, key); await assertValid(f);
    return after;
}

test('shrink docking: native and foreign minus actions retain the most feasible edges while every 4x4 to 3x3 to 2x2 grid stays compact', browserCase, async t => {
    if (!optional(t)) return;
    for (const platform of ['native', 'foreign']) await t.test(platform, async st => {
        const f = await fixture(st, { width: 1500, height: 1000, players: 29 });
        const continuity = await snapshot(f), order = await f.page.evaluate(() => getPlayerPositionKeys());
        const key = order[platform === 'native' ? 0 : 3];
        // 29 players + a 4x4 square use 7x7 tracks. These placements include
        // all four corners, every isolated edge, and a non-docked origin.
        for (const [row, column] of [[0, 0], [0, 3], [3, 0], [3, 3], [0, 1], [3, 1], [1, 0], [1, 3], [1, 1]]) {
            await fixedDirectionGrid(f, { columns: 7, focus: { key, span: 4, row, column }, order });
            for (const span of [3, 2]) await minus(f, key, span);
        }
        await assertContinuity(f, continuity);
    });
});

test('shrink docking: enlargement-editor minus and window minus use identical final edge fitting', browserCase, async t => {
    if (!optional(t)) return;
    const f = await fixture(t, { width: 1500, height: 1000, players: 17 });
    const continuity = await snapshot(f), order = await f.page.evaluate(() => getPlayerPositionKeys()), key = order[0];
    for (const [row, column] of [[0, 0], [0, 2], [2, 0], [2, 2]]) {
        const seed = { columns: 6, focus: { key, span: 4, row, column }, order };
        await fixedDirectionGrid(f, seed);
        const expected = await minus(f, key, 3);
        await fixedDirectionGrid(f, seed); const before = await read(f);
        await f.page.locator('#enlarge-player').click();
        await f.page.locator('.player-position-shrink').click();
        const actual = await waitSize(f, key, 3);
        assertBestDocking(before, actual, key);
        assert.deepEqual(actual, expected, 'both minus controls submit the same shared sizing intent');
        await f.page.keyboard.press('Escape'); await waitWindowGeometry(f);
        await assertValid(f);
    }
    await assertContinuity(f, continuity);
});

test('shrink docking: sparse placement and repeated shrink-grow operations prioritize compact grids without media or sound resets', browserCase, async t => {
    if (!optional(t)) return;
    const f = await fixture(t, { width: 1400, height: 880, players: 5 });
    const continuity = await snapshot(f), order = await f.page.evaluate(() => getPlayerPositionKeys()), key = order[3];
    await fixedDirectionGrid(f, { columns: 7, focus: { key, span: 5, row: 4, column: 2 }, order });
    let previous = await read(f);
    assert.equal(cell(previous, key).row + 5, previous.rows);
    assert.equal(cell(previous, key).column + 5, previous.columns);
    for (const span of [4, 3, 4, 3, 2, 3, 2]) {
        const action = span < cell(previous, key).span ? 'shrink' : 'enlarge';
        await actualMouseWindowAction(f, key, action);
        const next = await waitSize(f, key, span); await waitWindowGeometry(f);
        assertBestDocking(previous, next, key); await assertValid(f); previous = next;
    }
    await assertContinuity(f, continuity);
});

test('shrink docking: bottom docking is released when it would leave five interior holes despite having enough total slots', browserCase, async t => {
    if (!optional(t)) return;
    const f = await fixture(t, { width: 1400, height: 880, players: 29 });
    const continuity = await snapshot(f), order = await f.page.evaluate(() => getPlayerPositionKeys()), key = order[0];
    await fixedDirectionGrid(f, { columns: 7, focus: { key, span: 4, row: 3, column: 3 }, order });
    const before = await read(f);
    assert.equal(prefixHoles(before), 5, 'the reported bottom-right seed contains unused cells before its final occupied slot');
    const after = await minus(f, key, 3), focus = cell(after, key);
    assert.equal(prefixHoles(after), 0);
    assert.ok(focus.row + focus.span < after.rows, 'the former bottom edge yields to compact packing');
    assert.equal(focus.column + focus.span, after.columns, 'the independently feasible right edge is retained');
    await assertContinuity(f, continuity);
});

test('shrink docking: the final 1x1 step keeps feasible edges and gives up an impossible last-row corner without creating holes', browserCase, async t => {
    if (!optional(t)) return;
    for (const players of [9, 8]) await t.test(String(players), async st => {
        const f = await fixture(st, { width: 1400, height: 880, players });
        const continuity = await snapshot(f), order = await f.page.evaluate(() => getPlayerPositionKeys()), key = order[0];
        await fixedDirectionGrid(f, { columns: 4, focus: { key, span: 2, row: 1, column: 2 }, order });
        const before = await read(f), beforeOthers = [...before.items].sort((a, b) => a.row - b.row || a.column - b.column)
            .filter(value => value.key !== key).map(value => value.key);
        await actualMouseWindowAction(f, key, 'shrink'); await waitSize(f, key, 1); await waitWindowGeometry(f);
        const after = await assertValid(f);
        assertBestDocking(before, after, key);
        assert.ok(after.items.every(value => value.span === 1));
        assert.deepEqual([...after.items].sort((a, b) => a.row - b.row || a.column - b.column)
            .filter(value => value.key !== key).map(value => value.key), beforeOthers, 'other players retain relative order');
        const requested = dockEdges(before, key), score = dockScore(after, key, requested);
        if (players === 9) assert.equal(score, 2, 'a full 3x3 grid permits the original bottom-right corner');
        else {
            assert.equal(after.columns, 3); assert.equal(after.rows, 3);
            assert.equal(score, 1, 'an incomplete final row permits only one of bottom and right without leaving a hole');
        }
        await f.page.locator('#enlarge-player').click();
        assert.equal(await f.page.locator('.player-position-shrink').isDisabled(), true);
        await f.page.keyboard.press('Escape'); await waitWindowGeometry(f);
        await assertContinuity(f, continuity);
    });
});
