'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const migrated = path.join(__dirname, '../site/assets/js/player-geometry.js');
const G = require(fs.existsSync(migrated) ? migrated : path.join(__dirname, '../player-geometry.js'));
const pane = { width: 1400, height: 830, columnGap: 10, rowGap: 10 };
const keys = count => Array.from({ length: count }, (_, index) => 'compact-' + index);
const focus = layout => layout.items.find(item => item.span > 1);
const occupied = layout => layout.items.reduce((area, item) => area + item.span * item.span, 0);
const prefixHoles = layout => Math.max(0, ...layout.items.map(item =>
    (item.row + item.span - 1) * layout.columns + item.column + item.span)) - occupied(layout);
const edgeCount = (layout, wanted) => {
    const item = focus(layout);
    return Number(wanted.left && item.column === 0) + Number(wanted.right && item.column + item.span === layout.columns) +
        Number(wanted.top && item.row === 0) + Number(wanted.bottom && item.row + item.span === layout.rows);
};
const hint = (current, wanted) => ({ key: current.key, span: current.span, ...wanted });
function valid(layout, expected) {
    assert.deepEqual(layout.items.map(item => item.key).sort(), [...expected].sort());
    const used = new Set();
    for (const item of layout.items) {
        assert.ok(item.row >= 0 && item.column >= 0 && item.span >= 1);
        assert.ok(item.row + item.span <= layout.rows && item.column + item.span <= layout.columns);
        for (let row = item.row; row < item.row + item.span; row++) for (let column = item.column; column < item.column + item.span; column++) {
            const cell = row + ':' + column;
            assert.equal(used.has(cell), false, 'players cannot overlap'); used.add(cell);
        }
    }
    assert.equal(prefixHoles(layout), 0, 'no empty basic cell may occur before the last occupied cell');
    assert.equal(Object.hasOwn(layout, 'growthAnchor'), false);
    assert.equal(Object.hasOwn(layout, 'edges'), false);
    assert.equal(Object.hasOwn(layout, 'distance'), false);
}

test('compaction preserves feasible docked edges and only releases a conflicting bottom or right edge', () => {
    const list = keys(5), current = { key: list[0], span: 3, row: 1, column: 1 };
    const wanted = { left: false, right: true, top: false, bottom: true };
    const legacy = G.choose({ ...pane, keys: list, focus: current, force: true, growthAnchor: hint(current, wanted) });
    assert.ok(prefixHoles(legacy) > 0, 'the original docked result contains the reported middle gaps');
    const compact = G.choose({ ...pane, keys: list, focus: current, force: true, compact: true, growthAnchor: hint(current, wanted) });
    valid(compact, list);
    assert.equal(edgeCount(compact, wanted), 1, 'both requested edges cannot coexist in a compact grid of thirteen cells');
    assert.equal(focus(compact).column + 3, compact.columns, 'keep the right edge when it provides the better compact video area');
    assert.equal(focus(compact).row, 0, 'release the conflicting bottom placement');

    const enough = keys(9), docked = { ...current, key: enough[0], span: 2 };
    const retained = G.choose({ ...pane, keys: enough, focus: docked, force: true,
        compact: true, growthAnchor: hint(docked, wanted) });
    valid(retained, enough); assert.equal(edgeCount(retained, wanted), 2);
});

test('compaction ignores harmless trailing capacity but removes internal and sparse-origin gaps', () => {
    const list = keys(5), current = { key: list[0], span: 3, row: 0, column: 0 };
    const packed = G.choose({ ...pane, keys: list, focus: current, compact: true, force: true });
    valid(packed, list);
    assert.ok(packed.columns * packed.rows > occupied(packed), 'unused trailing capacity is allowed');
    const sparse = G.choose({ ...pane, keys: list, focus: { ...current, row: 20, column: 12 },
        preserveAnchor: true, compact: true, force: true });
    valid(sparse, list);
    assert.ok(focus(sparse).row < 20 && focus(sparse).column < 12, 'hole removal overrides a sparse anchor');
});

test('compaction uses explicit top-left tie intent and scopes extra hint coordinates to the target and span', () => {
    const list = keys(9), current = { key: list[0], span: 3, row: 0, column: 0 };
    const wanted = { left: true, top: true, right: false, bottom: false };
    const next = G.choose({ ...pane, keys: list, focus: current, compact: true,
        force: true, growthAnchor: hint(current, wanted) });
    valid(next, list); assert.equal(focus(next).row, 0); assert.equal(focus(next).column, 0);
    const plain = G.choose({ ...pane, keys: list, focus: current, compact: true, force: true });
    for (const stale of [{ ...hint(current, { right: true, bottom: true }), key: 'missing', row: 200, column: 200 },
        { ...hint(current, { right: true, bottom: true }), span: 8, row: 200, column: 200 }])
        assert.deepEqual(G.choose({ ...pane, keys: list, focus: current, compact: true, force: true, growthAnchor: stale }), plain);
});

test('compaction anchor and scoring agree with an exhaustive independent small-grid oracle', t => {
    let checked = 0;
    for (const count of [2, 3, 5, 9, 17]) for (const span of [2, 3, 4])
        for (const measure of [pane, { ...pane, width: 420, height: 880 }, { ...pane, width: 1900, height: 520 }])
            for (const wanted of [
                { left: true, top: true, right: false, bottom: false },
                { left: false, top: true, right: true, bottom: false },
                { left: true, top: false, right: false, bottom: true },
                { left: false, top: false, right: true, bottom: true },
                { left: false, top: false, right: false, bottom: false }
            ]) {
                const list = keys(count), current = { key: list[0], span, row: 2, column: 2 };
                const next = G.choose({ ...measure, keys: list, focus: current, compact: true,
                    force: true, growthAnchor: hint(current, wanted) });
                valid(next, list);
                let maximumEdges = -1, maximumArea = -1, minimumDistance = Infinity;
                const area = count + span * span - 1;
                // The oracle enumerates all anchors across the original broad
                // width range, rejecting every layout that has an actual gap.
                for (let columns = span; columns <= span + count - 1; columns++) {
                    const rows = Math.ceil(area / columns);
                    for (let row = 0; row + span <= rows; row++) for (let column = 0; column + span <= columns; column++) {
                        const candidate = G.build({ keys: list, columns, focus: { ...current, row, column } });
                        if (prefixHoles(candidate)) continue;
                        const edges = edgeCount(candidate, wanted);
                        const width = (measure.width - measure.columnGap * (columns - 1)) / columns;
                        const height = (measure.height - measure.rowGap * (rows - 1)) / rows;
                        const videoWidth = Math.min(Math.max(0, width), Math.max(0, height) * 16 / 9);
                        const score = videoWidth * videoWidth / (16 / 9), distance = Math.abs(row - 2) + Math.abs(column - 2);
                        if (edges > maximumEdges || edges === maximumEdges && score > maximumArea + .01) {
                            maximumEdges = edges; maximumArea = score; minimumDistance = distance;
                        } else if (edges === maximumEdges && Math.abs(score - maximumArea) <= .01)
                            minimumDistance = Math.min(minimumDistance, distance);
                    }
                }
                assert.equal(edgeCount(next, wanted), maximumEdges);
                assert.ok(Math.abs(next.area - maximumArea) <= .01, 'choose the largest video area after retaining feasible edges');
                const actual = focus(next), distance = Math.abs(actual.row - 2) + Math.abs(actual.column - 2);
                assert.equal(distance, minimumDistance, 'choose the nearest anchor after edge and area ties');
                checked++;
            }
    assert.equal(checked, 225); t.diagnostic('independent compact-grid oracle coverage ' + checked);
});

test('compaction is opt-in and does not change normal-grid, viewport, bookmark or legacy corner behavior', () => {
    for (const count of [0, 1, 5, 17]) for (const span of [2, 3, 6]) {
        const list = keys(count), current = { key: list[0], span, row: 4, column: 5 };
        const options = { ...pane, keys: list, focus: current, preserveAnchor: true,
            growthAnchor: hint(current, { right: true, bottom: true, left: true, top: true, row: 200, column: 200 }) };
        assert.deepEqual(G.choose({ ...options, compact: false }), G.choose(options));
        assert.deepEqual(G.choose({ ...options, compact: 'true' }), G.choose(options));
        assert.deepEqual(G.choose({ ...pane, keys: list, compact: true }), G.choose({ ...pane, keys: list }));
    }
});

test('compaction handles zero measurements, maximum-size squares and immutable inputs without leaking action intent', () => {
    const list = Object.freeze(keys(256)), current = Object.freeze({ key: list[0], span: 256, row: 512, column: 512 });
    const growthAnchor = Object.freeze(hint(current, { right: true, bottom: true, left: false, top: false }));
    const options = Object.freeze({ ...pane, keys: list, focus: current, compact: true, force: true, growthAnchor });
    for (const measure of [{}, { width: 0 }, { height: 0 }, { width: Infinity, height: NaN }]) {
        const next = G.choose({ ...options, ...measure }); valid(next, list);
        assert.ok(Number.isFinite(next.area) && next.area >= 0);
    }
    assert.deepEqual(current, { key: list[0], span: 256, row: 512, column: 512 });
    assert.equal(list.length, 256); assert.equal(growthAnchor.bottom, true);
});
