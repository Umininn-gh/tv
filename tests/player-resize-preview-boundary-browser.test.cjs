'use strict';
const { assertCompact, dockScore, maximumDockScore } = require('./helpers/player-layout-compaction.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Production editor + local native/cross-origin media. Never contact a platform.
const harnessFile = path.join(__dirname, 'player-layout-browser.test.cjs');
const harnessRequire = createRequire(harnessFile);
const harnessModule = { exports: {} };
const harnessTest = Object.assign(() => {}, { before: test.before, after: test.after });
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + fs.readFileSync(harnessFile, 'utf8') + '\n' +
    'module.exports={fixture,optional,snapshot,assertContinuity,fixedDirectionGrid,positionCell,startCornerDrag,moveCornerDrag,waitWindowGeometry,actualMouseWindowAction};\n})',
    { filename: harnessFile })(name => name === 'node:test' ? harnessTest : harnessRequire(name),
    harnessModule, harnessModule.exports, __dirname, harnessFile);
const { fixture, optional, snapshot, assertContinuity, fixedDirectionGrid, positionCell,
    startCornerDrag, moveCornerDrag, waitWindowGeometry, actualMouseWindowAction } = harnessModule.exports;
const browserCase = { skip: process.env.UMININN_BROWSER_TESTS !== '1', timeout: 120000 };
const corners = ['nw', 'ne', 'sw', 'se'];
const opposite = (rect, corner) => ({ x: corner.endsWith('w') ? rect.x + rect.width : rect.x,
    y: corner.startsWith('n') ? rect.y + rect.height : rect.y });
const close = (actual, expected, label, tolerance = .85) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, label + ': ' + actual + ' != ' + expected);

async function settle(f) {
    await f.page.waitForFunction(() => playerAudioBridge.batch === null && playerAudioBridge.queueLength === 0);
    await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function scenario(t, options) {
    const f = await fixture(t, options), initial = await contentBounds(f);
    // Firefox's input driver drops held buttons outside the browser viewport.
    // Keep room around the same fixed-size pane so an out-of-pane drag tests
    // clipping, rather than inadvertently testing an OS/window pointer cancel.
    await f.page.setViewportSize({ width: 3600, height: 2800 });
    await f.page.locator('#multi-stream-container-wrapper').evaluate(host => { host.style.margin = '750px'; });
    await settle(f);
    const moved = await contentBounds(f);
    assert.equal(moved.width, initial.width, 'viewport gutter must not change the actual playback width');
    assert.equal(moved.height, initial.height, 'viewport gutter must not change the actual playback height');
    return f;
}
async function moveWithinPage(f, drag, x, y = x) {
    const viewport = f.page.viewportSize();
    const target = { x: drag.point.x + (drag.corner.endsWith('e') ? 1 : -1) * x * drag.pitch.x,
        y: drag.point.y + (drag.corner.startsWith('s') ? 1 : -1) * y * drag.pitch.y };
    assert.ok(target.x > 0 && target.x < viewport.width && target.y > 0 && target.y < viewport.height,
        'the test gesture must leave the player pane without leaving the browser viewport: ' + JSON.stringify({ target, viewport }));
    return moveCornerDrag(f, drag, x, y);
}
async function layout(f) {
    return f.page.evaluate(() => {
        const value = getCurrentPlayerGeometry();
        return { columns: value.columns, rows: value.rows,
            items: [...value.items].sort((a, b) => a.key.localeCompare(b.key)) };
    });
}
async function waitSpan(f, key, span) {
    await f.page.waitForFunction(({ key, span }) =>
        getCurrentPlayerGeometry().items.find(item => item.key === key)?.span === span, { key, span });
    await settle(f);
}
async function prepare(f, { columns = 5, span = 3, row = 1, column = 1 } = {}) {
    const order = await f.page.evaluate(() => getPlayerPositionKeys()), key = order[0];
    await fixedDirectionGrid(f, { columns, focus: { key, span, row, column }, order });
    await f.page.locator('#enlarge-player').click();
    await f.page.waitForFunction(() => !document.getElementById('player-position-editor').hidden);
    await settle(f);
    return key;
}
async function saved(f) {
    return f.page.evaluate(() => ({ order: localStorage.getItem('playerPositionOrder'),
        size: localStorage.getItem('playerEnlargementLayout') }));
}
async function contentBounds(f) {
    return f.page.locator('#multi-stream-container').evaluate(pane => {
        const bounds = pane.getBoundingClientRect();
        return { x: bounds.left + pane.clientLeft, y: bounds.top + pane.clientTop,
            width: pane.clientWidth, height: pane.clientHeight };
    });
}
async function preview(f) {
    const node = f.page.locator('.player-resize-preview');
    await node.waitFor({ state: 'visible' });
    return { rect: await node.boundingBox(), text: await node.innerText() };
}
function expectedGhost(original, corner, span, pitch, bounds, gaps) {
    const anchor = opposite(original, corner), width = span * pitch.x - gaps.x, height = span * pitch.y - gaps.y;
    const x = corner.endsWith('w') ? anchor.x - width : anchor.x;
    const y = corner.startsWith('n') ? anchor.y - height : anchor.y;
    const left = Math.max(bounds.x, x), top = Math.max(bounds.y, y);
    const right = Math.min(bounds.x + bounds.width, x + width), bottom = Math.min(bounds.y + bounds.height, y + height);
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}
async function assertGhost(f, original, corner, span, drag, bounds, gaps) {
    const current = await preview(f), expected = expectedGhost(original, corner, span, drag.pitch, bounds, gaps);
    for (const field of ['x', 'y', 'width', 'height']) close(current.rect[field], expected[field], corner + ' preview ' + field);
    const anchor = opposite(current.rect, corner), fixed = opposite(original, corner);
    close(anchor.x, fixed.x, corner + ' fixed opposite x'); close(anchor.y, fixed.y, corner + ' fixed opposite y');
    assert.ok(current.rect.x >= bounds.x - .6 && current.rect.y >= bounds.y - .6);
    assert.ok(current.rect.x + current.rect.width <= bounds.x + bounds.width + .6);
    assert.ok(current.rect.y + current.rect.height <= bounds.y + bounds.height + .6);
    assert.match(current.text, /放開後自動分格/, 'the drag frame explains that the final grid may refit after release');
    return current;
}
async function gaps(f) {
    return f.page.locator('#multi-stream-container').evaluate(pane => {
        const style = getComputedStyle(pane);
        return { x: parseFloat(style.columnGap) || 0, y: parseFloat(style.rowGap) || 0 };
    });
}
async function leave(f) { await f.page.keyboard.press('Escape'); await waitWindowGeometry(f); }

// Preview feedback keeps a physical corner. The final adaptive layout can refit;
// its rectangle is deliberately not required to match the feedback pixel-for-pixel.
test('resize preview: nine, eleven and seventeen player corner gestures retain their physical opposite anchor while final tracks may refit', browserCase, async t => {
    if (!optional(t)) return;
    for (const config of [
        { players: 9, columns: 3, span: 2, row: 0, column: 1 },
        { players: 11, columns: 5, span: 3, row: 1, column: 2 },
        { players: 17, columns: 5, span: 3, row: 1, column: 1 }
    ]) await t.test(String(config.players), async st => {
        const f = await scenario(st, { width: 1500, height: 1000, players: config.players });
        const continuity = await snapshot(f);
        for (const corner of corners) for (const delta of [-.8, .8]) {
            const key = await prepare(f, config), before = await layout(f), storage = await saved(f);
            const original = await positionCell(f, key).boundingBox(), bounds = await contentBounds(f), gap = await gaps(f);
            const drag = await startCornerDrag(f, key, corner), span = Math.max(1, Math.round(config.span + delta));
            await moveWithinPage(f, drag, delta);
            await assertGhost(f, original, corner, span, drag, bounds, gap);
            assert.deepEqual(await layout(f), before, 'dragging cannot reflow the actual players');
            assert.deepEqual(await saved(f), storage, 'tentative size is never persisted');
            await f.page.mouse.up(); await waitSpan(f, key, span);
            assert.equal(await f.page.locator('.player-resize-preview').isVisible(), false);
            const next = await layout(f), cell = next.items.find(item => item.key === key), old = before.items.find(item => item.key === key);
            const docks = { right: corner.endsWith('w') && old.column + old.span === before.columns,
                bottom: corner.startsWith('n') && old.row + old.span === before.rows,
                left: corner.endsWith('e') && old.column === 0, top: corner.startsWith('s') && old.row === 0 };
            assertCompact(next);
            assert.equal(dockScore(next, key, docks), maximumDockScore({ count: next.items.length, span, docks,
                ...(span === 1 ? { columns: next.columns } : {}) }), 'release only the corner edges that conflict with compact packing');
            await leave(f);
        }
        await assertContinuity(f, continuity);
    });
});

test('resize preview: same-span pointer motion is inert and physical anchors cannot jump at growth thresholds', browserCase, async t => {
    if (!optional(t)) return;
    const f = await scenario(t, { width: 1500, height: 1000, players: 17 }), continuity = await snapshot(f);
    for (const corner of corners) {
        const key = await prepare(f), original = await positionCell(f, key).boundingBox(), bounds = await contentBounds(f), gap = await gaps(f);
        const before = await layout(f), storage = await saved(f), drag = await startCornerDrag(f, key, corner);
        for (const delta of [.08, .49, .51, .95, 1.49, 1.51, .49, .08]) {
            await moveWithinPage(f, drag, delta); await settle(f);
            const span = Math.round(3 + delta);
            if (span === 3) assert.equal(await f.page.locator('.player-resize-preview').isVisible(), false, 'same-span movement cannot invent a different packing');
            else await assertGhost(f, original, corner, span, drag, bounds, gap);
            assert.deepEqual(await layout(f), before); assert.deepEqual(await saved(f), storage);
        }
        await f.page.mouse.up(); await settle(f);
        assert.deepEqual(await layout(f), before, 'returning to the original span cannot commit a different packing');
        assert.deepEqual(await saved(f), storage); assert.equal(await f.page.locator('.player-resize-preview').isVisible(), false);
        await leave(f);
    }
    await assertContinuity(f, continuity);
});

test('resize preview: escaping a held or out-of-pane gesture clears the clipped frame and cannot commit on a late release', browserCase, async t => {
    if (!optional(t)) return;
    const f = await scenario(t, { width: 1500, height: 1000, players: 11 }), continuity = await snapshot(f);
    for (const corner of corners) {
        const key = await prepare(f, { columns: 5, span: 3, row: 1, column: 2 });
        const original = await positionCell(f, key).boundingBox(), bounds = await contentBounds(f), gap = await gaps(f);
        const before = await layout(f), storage = await saved(f), drag = await startCornerDrag(f, key, corner);
        await moveWithinPage(f, drag, 3.1);
        await assertGhost(f, original, corner, 6, drag, bounds, gap);
        await f.page.keyboard.press('Escape'); await f.page.mouse.up(); await settle(f);
        assert.equal(await f.page.locator('.player-resize-preview').isVisible(), false);
        assert.deepEqual(await layout(f), before); assert.deepEqual(await saved(f), storage);
        await leave(f);
    }
    await assertContinuity(f, continuity);
});

test('resize preview: clicking the enlargement editor uses the same final right and bottom docking rules as the window plus button', browserCase, async t => {
    if (!optional(t)) return;
    const f = await fixture(t, { width: 1400, height: 880, players: 9 }), continuity = await snapshot(f);
    const order = await f.page.evaluate(() => getPlayerPositionKeys()), key = order[2];
    for (const seed of [null, { key, span: 2, row: 2, column: 1 }]) {
        await fixedDirectionGrid(f, { columns: 3, focus: seed, order });
        const span = (seed?.span || 1) + 1;
        await actualMouseWindowAction(f, key, 'enlarge'); await waitSpan(f, key, span); await waitWindowGeometry(f);
        const expected = await layout(f);
        await fixedDirectionGrid(f, { columns: 3, focus: seed, order });
        await f.page.locator('#enlarge-player').click(); await positionCell(f, key).click(); await waitSpan(f, key, span);
        assert.deepEqual(await layout(f), expected, 'both explicit plus entries must use the shared final fitting plan');
        await leave(f);
    }
    await assertContinuity(f, continuity);
});
