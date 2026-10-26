'use strict';
const { assertCompact, assertBestDocking } = require('./helpers/player-layout-compaction.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Closed browser model: shipped app/CSS and trusted controls, real native media
// and cross-origin iframe documents. No platform network request is permitted.
const harnessFile = path.join(__dirname, 'player-layout-browser.test.cjs');
const harnessRequire = createRequire(harnessFile);
const harnessTest = Object.assign(() => {}, { before: test.before, after: test.after });
const harnessModule = { exports: {} };
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + fs.readFileSync(harnessFile, 'utf8') + '\n' +
    'module.exports={fixture,optional,snapshot,assertContinuity,assertFits,assertGeometry,fixedDirectionGrid,' +
    'settlePane,positionCell,clickDirection,directionTargets,editorStepGesture,waitWindowGeometry,' +
    'startCornerDrag,moveCornerDrag,waitSpan,activeMediaSnapshot,assertActiveContinuity,actualMouseWindowAction};\n})',
    { filename: harnessFile })(name => name === 'node:test' ? harnessTest : harnessRequire(name),
    harnessModule, harnessModule.exports, __dirname, harnessFile);
const { fixture, optional, snapshot, assertContinuity, assertFits, assertGeometry, fixedDirectionGrid,
    settlePane, positionCell, clickDirection, directionTargets, editorStepGesture, waitWindowGeometry,
    startCornerDrag, moveCornerDrag, waitSpan, activeMediaSnapshot, assertActiveContinuity, actualMouseWindowAction } = harnessModule.exports;
const browserCase = { skip: process.env.UMININN_BROWSER_TESTS !== '1', timeout: 90000 };

async function setup(t, options = {}) {
    if (!optional(t)) return null;
    return fixture(t, { width: 1500, height: 1000, players: 17, ...options });
}
async function read(f) {
    return f.page.evaluate(() => {
        const layout = getCurrentPlayerGeometry();
        return { columns: layout.columns, rows: layout.rows,
            items: [...layout.items].sort((a, b) => a.key.localeCompare(b.key)) };
    });
}
const item = (layout, key) => layout.items.find(value => value.key === key);
async function keys(f) { return f.page.evaluate(() => getPlayerPositionKeys()); }
async function prepare(f, { columns = 5, span = 3, row = 1, column = 1, key, order } = {}) {
    order ||= await keys(f); key ||= order[0];
    await fixedDirectionGrid(f, { columns, focus: { key, span, row, column }, order });
    await assertRendered(f);
    return { key, order, layout: await read(f) };
}
async function assertRendered(f, { editor = false } = {}) {
    await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const state = await f.page.evaluate(() => ({ geometry: fixture.geometry(), grid: fixture.grid(),
        logical: getCurrentPlayerGeometry(), active: [...activePlayers.keys()] }));
    assertFits(state.grid);
    assert.deepEqual(state.logical.items.map(value => value.key).sort(), state.active.sort(), 'every active player appears exactly once');
    assert.equal(new Set(state.logical.items.map(value => value.key)).size, state.active.length);
    assert.ok(state.logical.items.filter(value => value.span > 1).length <= 1);
    const occupied = new Set();
    for (const value of state.logical.items) {
        assert.ok(Number.isInteger(value.row) && Number.isInteger(value.column) && Number.isInteger(value.span));
        assert.ok(value.row >= 0 && value.column >= 0 && value.span >= 1);
        assert.ok(value.row + value.span <= state.logical.rows && value.column + value.span <= state.logical.columns);
        for (let row = value.row; row < value.row + value.span; row++) for (let column = value.column; column < value.column + value.span; column++) {
            const cell = row + ':' + column; assert.equal(occupied.has(cell), false, 'logical cell collision ' + cell); occupied.add(cell);
        }
    }
    const players = state.geometry.players;
    for (let a = 0; a < players.length; a++) for (let b = a + 1; b < players.length; b++) {
        const x = players[a].rect, y = players[b].rect;
        assert.ok(x.right <= y.left + .55 || y.right <= x.left + .55 || x.bottom <= y.top + .55 || y.bottom <= x.top + .55,
            'rendered rectangles overlap: ' + players[a].key + '/' + players[b].key);
    }
    if (state.geometry.layout) assertGeometry(state.geometry, { overlay: editor });
    assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
    return state;
}
async function openEditor(f, mode = 'move') {
    await f.page.locator(mode === 'move' ? '#adjust-player-positions' : '#enlarge-player').click();
    await f.page.waitForFunction(() => !document.getElementById('player-position-editor').hidden);
    await assertRendered(f, { editor: true });
    assert.equal(await f.page.locator('#player-window-controls').isVisible(), false, 'window controls cannot intercept editor gestures');
}
async function closeEditor(f) { await f.page.keyboard.press('Escape'); await waitWindowGeometry(f); }
async function enlargeWithWindowButton(f, key, span) {
    await actualMouseWindowAction(f, key, 'enlarge');
    await waitSpan(f, key, span); await waitWindowGeometry(f);
    await assertRendered(f);
    return read(f);
}

test('BND-001: trusted plus actions keep native and foreign right-docked players on the final right edge through 3x3, 4x4 and 5x5', browserCase, async t => {
    for (const platform of ['native', 'foreign']) await t.test(platform, async st => {
        const f = await setup(st, { players: 9, width: 1400, height: 880 }); if (!f) return;
        const before = await snapshot(f), original = await keys(f);
        const key = original[platform === 'native' ? 0 : 2], order = original.filter(value => value !== key);
        order.splice(2, 0, key);
        await fixedDirectionGrid(f, { columns: 3, focus: null, order });
        assert.deepEqual(item(await read(f), key), { key, row: 0, column: 2, span: 1 });
        const trace = [];
        for (const span of [2, 3, 4, 5]) {
            const next = await enlargeWithWindowButton(f, key, span), cell = item(next, key);
            assert.equal(cell.row, 0, 'a top-docked player retains the top edge');
            assert.equal(cell.column + span, next.columns, 'right docking is calculated from the FINAL column count');
            if (span === 3) assert.ok(cell.column > 0, 'the reported 2x2 to 3x3 transition must not jump across to the left');
            assert.ok(next.items.filter(value => value.key !== key).every(value => value.span === 1));
            trace.push({ columns: next.columns, rows: next.rows, focus: cell });
        }
        t.diagnostic(JSON.stringify({ issue: 'BND-001', platform, resolved: true, trace }));
        await assertContinuity(f, before);
    });
});

test('BND-002: moving native and foreign players down then pressing plus keeps feasible edges without middle gaps', browserCase, async t => {
    for (const platform of ['native', 'foreign']) await t.test(platform, async st => {
        const f = await setup(st, { players: 9, width: 1400, height: 880 }); if (!f) return;
        const before = await snapshot(f), order = await keys(f), key = order[platform === 'native' ? 0 : 2];
        await prepare(f, { columns: 3, span: 2, row: 0, column: 1, key, order });
        for (const row of [1, 2]) {
            const target = (await directionTargets(f, key)).down[0]; assert.ok(target);
            await clickDirection(f, key, 'down', target);
            assert.equal(item(await read(f), key).row, row);
        }
        const bottom = await read(f), start = item(bottom, key);
        assert.equal(start.row + start.span, bottom.rows); assert.equal(start.column + start.span, bottom.columns);
        const trace = [];
        let enlarged, previous = bottom;
        for (const span of [3, 4]) {
            enlarged = await enlargeWithWindowButton(f, key, span);
            const cell = item(enlarged, key);
            assertBestDocking(previous, enlarged, key); assertCompact(enlarged);
            previous = enlarged;
            trace.push({ columns: enlarged.columns, rows: enlarged.rows, focus: cell });
        }
        // Explicit +/- actions share docking against the newly fitted tracks.
        await actualMouseWindowAction(f, key, 'shrink'); await waitSpan(f, key, 3); await waitWindowGeometry(f);
        const smaller = await read(f), cell = item(smaller, key);
        assertBestDocking(enlarged, smaller, key); assertCompact(smaller);
        await assertRendered(f);
        t.diagnostic(JSON.stringify({ issue: 'BND-002', platform, resolved: true, before: start, trace, shrink: cell }));
        await assertContinuity(f, before);
    });
});

test('layout boundaries: a square touching both opposite edges retains left/top priority when plus selects larger tracks', browserCase, async t => {
    const f = await setup(t, { players: 9, width: 1400, height: 880 }); if (!f) return;
    const before = await snapshot(f), order = await keys(f), key = order[0];
    for (const columns of [3, 6]) {
        const { layout } = await prepare(f, { columns, span: 3, row: 0, column: 0, key, order });
        if (columns === 3) assert.equal(item(layout, key).span, layout.columns, 'the square touches both horizontal edges');
        else assert.equal(item(layout, key).span, layout.rows, 'the square touches both vertical edges');
        const next = await enlargeWithWindowButton(f, key, 4);
        assert.equal(item(next, key).column, 0); assert.equal(item(next, key).row, 0);
    }
    await assertContinuity(f, before);
});

test('layout boundaries: rendered corner and edge placements keep a single square inside the pane with aligned editor cells', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f), order = await keys(f);
    for (const span of [2, 3]) {
        const rows = Math.ceil((order.length + span * span - 1) / 5);
        for (const [row, column] of [[0, 0], [0, 5 - span], [rows - span, 0], [rows - span, 5 - span], [1, 1]]) {
            const { key, layout } = await prepare(f, { span, row, column, order });
            assert.deepEqual(item(layout, key), { key, row, column, span });
            await openEditor(f); await closeEditor(f);
            assert.deepEqual(await read(f), layout, 'entering/leaving the editor cannot re-anchor a boundary placement');
        }
    }
    await assertContinuity(f, before);
});

test('layout boundaries: downward and upward triangles move exactly one row even when the entering strip is only partly occupied', browserCase, async t => {
    for (const [players, columns, span] of [[6, 4, 2], [9, 5, 3], [17, 5, 3]]) await t.test(players + '/' + columns + '/' + span, async st => {
        const f = await setup(st, { players }); if (!f) return;
        const before = await snapshot(f), { key, layout } = await prepare(f, { columns, span, row: 0, column: 0 });
        const targets = (await directionTargets(f, key)).down;
        assert.ok(targets.length > 0 && targets.length <= span);
        if (players <= 9) assert.ok(targets.length < span, 'this case crosses a partially occupied last row');
        for (const selected of targets) {
            await prepare(f, { columns, span, row: 0, column: 0, key });
            await clickDirection(f, key, 'down', selected);
            const down = await read(f);
            assert.deepEqual(item(down, key), { key, row: 1, column: 0, span });
            assert.equal(down.columns, layout.columns); assert.ok(down.rows <= layout.rows);
            await assertRendered(f);
            const up = (await directionTargets(f, key)).up; assert.ok(up.length);
            await clickDirection(f, key, 'up', up[0]);
            assert.deepEqual(item(await read(f), key), { key, row: 0, column: 0, span });
            await assertRendered(f);
        }
        await assertContinuity(f, before);
    });
});

test('layout boundaries: bottom/right and top/left edges expose no outward triangles and keyboard movement cannot grow the grid', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f);
    for (const [row, column, blocked] of [[0, 0, ['up', 'left']], [2, 3, ['down', 'right']]]) {
        const { key, layout } = await prepare(f, { span: 3, columns: 6, row, column });
        // The chosen lower anchor reaches row5; the normal area needs five rows.
        for (const direction of blocked) assert.deepEqual((await directionTargets(f, key))[direction], []);
        await openEditor(f);
        for (const direction of blocked) {
            await positionCell(f, key).press('Arrow' + direction[0].toUpperCase() + direction.slice(1));
            assert.deepEqual(await read(f), layout, 'blocked ' + direction + ' cannot wrap, add tracks or move the main tile');
            await assertRendered(f, { editor: true });
        }
        await closeEditor(f);
    }
    await assertContinuity(f, before);
});

test('layout boundaries: remote lower and upper click/drag destinations clamp the whole square without becoming one-row steps', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f), order = await keys(f), key = order[0];
    let expected;
    for (const gesture of ['click', 'drag']) {
        const { layout } = await prepare(f, { columns: 5, span: 2, row: 0, column: 0, key, order });
        const lower = layout.items.find(value => value.row === layout.rows - 1 && value.column === 4);
        assert.ok(lower && lower.span === 1);
        await openEditor(f);
        await editorStepGesture(f, key, lower.key, 'down', gesture);
        const down = await read(f);
        assert.deepEqual(item(down, key), { key, row: layout.rows - 2, column: 3, span: 2 });
        assert.equal(down.columns, layout.columns); assert.ok(down.rows <= layout.rows);
        await assertRendered(f, { editor: true });
        if (expected) assert.deepEqual(down, expected); else expected = down;
        const upper = down.items.find(value => value.row === 0 && value.column === 0); assert.ok(upper);
        await editorStepGesture(f, key, upper.key, 'up', gesture);
        assert.deepEqual(item(await read(f), key), { key, row: 0, column: 0, span: 2 });
        await assertRendered(f, { editor: true }); await closeEditor(f);
    }
    await assertContinuity(f, before);
});

test('layout boundaries: a bottom placement survives slight resize and remains bounded after substantial portrait fitting', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f), { key } = await prepare(f, { columns: 5, span: 3, row: 1, column: 1 });
    await clickDirection(f, key, 'down', (await directionTargets(f, key)).down[0]);
    const bottom = await read(f);
    assert.equal(item(bottom, key).row + 3, bottom.rows);
    for (const [width, height] of [[1492, 992], [1506, 1007], [1500, 1000]]) {
        await settlePane(f, width, height); await waitWindowGeometry(f);
        assert.deepEqual(await read(f), bottom, 'small resize must not reinterpret a committed downward placement');
        await assertRendered(f);
    }
    await settlePane(f, 550, 1000); await waitWindowGeometry(f);
    assert.equal(item(await read(f), key).span, 3); await assertRendered(f);
    await openEditor(f); await closeEditor(f);
    await assertContinuity(f, before);
});

test('layout boundaries: bookmarks and fresh-page storage restore a downward-moved bottom square and its ordinary tile order', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f), { key } = await prepare(f, { columns: 5, span: 3, row: 1, column: 1 });
    await clickDirection(f, key, 'down', (await directionTargets(f, key)).down[0]);
    const bottom = await read(f);
    assert.equal(item(bottom, key).row + 3, bottom.rows);
    const saved = await f.page.evaluate(() => ({ bookmark: capturePlayerBookmark(), storage: {
        playerPositionOrder: localStorage.getItem('playerPositionOrder'),
        playerEnlargementLayout: localStorage.getItem('playerEnlargementLayout') } }));
    assert.deepEqual(saved.bookmark.focus, item(bottom, key));
    await clickDirection(f, key, 'up', (await directionTargets(f, key)).up[0]);
    await f.page.evaluate(value => applyPlayerBookmark(value), saved.bookmark); await waitWindowGeometry(f);
    assert.deepEqual(await read(f), bottom); await assertRendered(f); await assertContinuity(f, before);
    const reopened = await setup(t, { storageSeed: saved.storage }); if (!reopened) return;
    await waitWindowGeometry(reopened); assert.deepEqual(await read(reopened), bottom); await assertRendered(reopened);
});

test('layout boundaries: all four resize handles after downward placement retain the opposite corner and aligned editor geometry', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f), order = await keys(f), key = order[0];
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
        await prepare(f, { columns: 5, span: 2, row: 1, column: 2, key, order });
        await clickDirection(f, key, 'down', (await directionTargets(f, key)).down[0]);
        const moved = await read(f), start = item(moved, key);
        assert.equal(start.row, 2);
        await openEditor(f, 'size');
        const drag = await startCornerDrag(f, key, corner);
        await moveCornerDrag(f, drag, 1.1); await f.page.mouse.up(); await waitSpan(f, key, 3);
        const result = await read(f), resized = item(result, key);
        const fixedBottom = corner[0] === 'n' && start.row + start.span === moved.rows;
        const fixedRight = corner[1] === 'w' && start.column + start.span === moved.columns;
        assert.deepEqual(resized, { key, span: 3,
            row: fixedBottom ? result.rows - 3 : start.row - Number(corner[0] === 'n'),
            column: fixedRight ? result.columns - 3 : start.column - Number(corner[1] === 'w') });
        await assertRendered(f, { editor: true }); await closeEditor(f);
    }
    await assertContinuity(f, before);
});

test('layout boundaries: closing an ordinary or enlarged bottom tile leaves no stale controls and retains surviving media', browserCase, async t => {
    const f = await setup(t, { players: 9 }); if (!f) return;
    const { key, order } = await prepare(f, { columns: 4, span: 2, row: 0, column: 1 });
    await clickDirection(f, key, 'down', (await directionTargets(f, key)).down[0]);
    const removed = order.at(-1), kept = order.filter(value => value !== removed && value !== key);
    const before = await activeMediaSnapshot(f, kept, { remember: true });
    await actualMouseWindowAction(f, removed, 'close'); await waitWindowGeometry(f); await assertRendered(f);
    assert.equal(await f.page.locator(`.player-window-cell[data-player-key=${JSON.stringify(removed)}]`).count(), 0);
    await actualMouseWindowAction(f, key, 'close'); await waitWindowGeometry(f); await assertRendered(f);
    assert.equal((await read(f)).items.some(value => value.span > 1), false);
    assert.equal(await f.page.locator(`.player-window-cell[data-player-key=${JSON.stringify(key)}]`).count(), 0);
    await assertActiveContinuity(f, before);
});

test('BND-003: zero-size projection must neither overwrite the settled anchor nor save it to bookmarks',
    browserCase, async t => {
    const f = await setup(t, { players: 5 }); if (!f) return;
    const initialKeys = await keys(f);
    await f.page.evaluate(values => { for (const key of values.slice(3)) closePlayer(key); }, initialKeys);
    await waitWindowGeometry(f);
    const order = await keys(f), key = order[0];
    const retained = await activeMediaSnapshot(f, order, { remember: true });
    // Keep exercising existing saved sparse layouts, including those made by
    // earlier corner-resize versions. New corner fitting may choose new tracks.
    await prepare(f, { columns: 7, span: 2, row: 4, column: 5, key, order });
    const visible = await read(f);
    assert.deepEqual(item(visible, key), { key, span: 2, row: 4, column: 5 });
    assert.equal(visible.columns, 7);
    await f.page.evaluate(() => {
        // Mount the shipped local bookmark UI outside the pane, as the actual
        // top toolbar does. The fixture normally omits its menu markup only.
        const button = document.createElement('button'); button.id = 'boundary-bookmark-button'; button.textContent = '邊界測試書籤';
        document.body.firstElementChild.appendChild(button);
        const panel = document.createElement('aside'); panel.id = 'boundary-bookmark-panel';
        panel.style.cssText = 'position:fixed;right:20px;top:50px;width:400px;max-height:600px;overflow:auto;background:#222;z-index:10000000';
        document.body.appendChild(panel);
        window.boundaryBookmarkMenu = LayoutBookmarks.mount({ button, panel, storage: localStorage,
            capture: capturePlayerBookmark, apply: applyPlayerBookmark,
            beforeOpen: () => playerPositionEditor.close(false) });
    });
    // Use the actual ResizeObserver/debounce, without assigning layout state.
    // This is a rare temporarily-unmeasurable pane, not an ordinary down move.
    await settlePane(f, 0, 0);
    await f.page.waitForFunction(() => getCurrentPlayerGeometry().deferredFocus === true);
    const hidden = await f.page.evaluate(() => ({ width: document.getElementById('multi-stream-container').clientWidth,
        height: document.getElementById('multi-stream-container').clientHeight,
        geometry: getCurrentPlayerGeometry(), intent: playerLayoutState.focus }));
    assert.equal(hidden.width, 0); assert.equal(hidden.height, 0);
    assert.deepEqual(hidden.intent, item(visible, key), 'the authoritative visible anchor is still available');
    await f.page.locator('#boundary-bookmark-button').click();
    await f.page.locator('#boundary-bookmark-panel .layout-bookmarks-save').click();
    await f.page.waitForFunction(() => boundaryBookmarkMenu.store.list().length === 1);
    const saved = await f.page.evaluate(() => boundaryBookmarkMenu.store.list()[0].snapshot);
    await f.page.evaluate(() => boundaryBookmarkMenu.close(false));
    await settlePane(f, 1500, 1000); await waitWindowGeometry(f);
    const revealed = await read(f);
    await f.page.evaluate(() => boundaryBookmarkMenu.open());
    await f.page.locator('#boundary-bookmark-panel .layout-bookmark-preview').click();
    await waitWindowGeometry(f);
    const restored = await read(f);
    await assertRendered(f); await assertActiveContinuity(f, retained);
    t.diagnostic(JSON.stringify({ trigger: 'trusted save while actual measured pane is 0×0',
        issue: 'BND-003', resolved: true,
        intended: { columns: visible.columns, focus: item(visible, key) },
        temporary: { columns: hidden.geometry.columns, focus: item(hidden.geometry, key) },
        revealed: { columns: revealed.columns, focus: item(revealed, key) },
        saved: { columns: saved.columns, focus: saved.focus },
        restored: { columns: restored.columns, focus: item(restored, key) } }));
    assert.deepEqual({ columns: hidden.geometry.columns, focus: item(hidden.geometry, key) },
        { columns: visible.columns, focus: item(visible, key) },
        'a zero-size projection must retain the confirmed sparse tracks and anchor');
    assert.deepEqual(revealed, visible, 'merely revealing the pane must restore the pre-hidden anchor');
    assert.deepEqual({ columns: saved.columns, focus: saved.focus }, { columns: visible.columns, focus: item(visible, key) },
        'a saved bookmark must use the preserved placement, not a temporary zero-size projection');
    assert.deepEqual(restored, visible, 'applying the saved bookmark must not permanently shift the anchor');
});
