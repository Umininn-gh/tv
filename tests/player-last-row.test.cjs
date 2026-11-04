'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = name => {
    const migrated = path.join(__dirname, '../site/assets/js', name + '.js');
    return require(fs.existsSync(migrated) ? migrated : path.join(__dirname, '..', name + '.js'));
};
const L = source('player-layout'), G = source('player-geometry');
const operations = L.createOperations({ geometry: G });
const keys = count => Array.from({ length: count }, (_, index) => `player-${index}`);
const byKey = (layout, key) => layout.items.find(item => item.key === key);
const directions = ['up', 'down', 'left', 'right'];
const reverse = { up: 'down', down: 'up', left: 'right', right: 'left' };
const canonicalItems = layout => [...layout.items].sort((a, b) => a.key.localeCompare(b.key));
const freeze = value => {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
};

function assertLogical(layout) {
    const cells = new Set();
    assert.equal(new Set(layout.items.map(item => item.key)).size, layout.items.length);
    for (const item of layout.items) {
        assert.ok(Number.isInteger(item.row) && item.row >= 0);
        assert.ok(Number.isInteger(item.column) && item.column >= 0);
        assert.ok(Number.isInteger(item.span) && item.span > 0);
        assert.ok(item.row + item.span <= layout.rows && item.column + item.span <= layout.columns);
        for (let row = item.row; row < item.row + item.span; row++) {
            for (let column = item.column; column < item.column + item.span; column++) {
                const cell = `${row}:${column}`;
                assert.ok(!cells.has(cell), `overlap at ${cell}`);
                cells.add(cell);
            }
        }
    }
}

function assertProjection(layout) {
    const before = JSON.stringify(layout), projected = L.presentation(layout);
    assert.equal(JSON.stringify(layout), before);
    assert.equal(L.presentation(projected), projected, 'projection is idempotent');
    assert.equal(projected.columns, layout.columns);
    assert.equal(projected.rows, layout.rows);
    assert.equal(projected.items.length, layout.items.length);
    assert.equal(projected.offsets.size, layout.items.length);
    if (!layout.items.length) return projected;
    const lastRow = Math.max(...layout.items.map(item => item.row + item.span - 1));
    assert.equal(projected.lastRow, lastRow);
    const bottom = projected.items.filter(item => item.row <= lastRow && item.row + item.span > lastRow);
    const center = bottom.length < layout.columns && bottom.every(item => item.span === 1);
    if (center) {
        const left = Math.min(...bottom.map(item => item.column));
        const right = Math.max(...bottom.map(item => item.column + item.span));
        assert.equal(left, layout.columns - right, 'equal outer whitespace');
    }
    for (let index = 0; index < layout.items.length; index++) {
        const original = layout.items[index], shown = projected.items[index];
        assert.notEqual(shown, original);
        assert.equal(shown.key, original.key);
        assert.equal(shown.row, original.row);
        assert.equal(shown.span, original.span);
        assert.equal(shown.column - projected.offsets.get(shown.key), original.column);
        assert.ok(shown.column >= 0 && shown.column + shown.span <= layout.columns);
        assert.equal(projected.offsets.get(shown.key), center && original.row === lastRow ? projected.offset : 0);
        if (!center || original.row !== lastRow) assert.deepEqual(shown, original);
    }
    return projected;
}

test('all 2–256 player counts and every normal column count center only the incomplete final row', () => {
    for (let count = 2; count <= 256; count++) {
        for (let columns = 1; columns <= count; columns++) {
            const logical = G.build({ keys: keys(count), columns });
            const projected = assertProjection(logical);
            const remainder = count % columns;
            assert.equal(projected.offset, remainder ? (columns - remainder) / 2 : 0);
            // Projection never creates holes in the authoritative normal grid.
            logical.items.forEach((item, index) => {
                assert.equal(item.row, Math.floor(index / columns));
                assert.equal(item.column, index % columns);
            });
        }
    }
});

test('fitting wide, tall, narrow and hidden panes keeps logical cells and repeat projection stable', () => {
    for (let count = 2; count <= 256; count++) {
        for (const [width, height] of [[1600, 900], [900, 1600], [4000, 100], [100, 4000], [0, 0]]) {
            const fitted = L.choose({ count, width, height, columnGap: 10, rowGap: 10, force: true });
            const logical = G.build({ keys: keys(count), columns: fitted.columns });
            const projected = assertProjection(freeze(logical));
            assert.deepEqual(L.presentation(logical), projected);
        }
    }
});

test('half tracks, interior gaps, negative shifts and already centered rows preserve order and distances', () => {
    for (const [columns, positions, expectedOffset] of [
        [4, [0], 1.5], [8, [1, 3], 1.5], [8, [4, 6], -1.5],
        [6, [2, 3], 0], [6, [0, 5], 0]
    ]) {
        const logical = freeze({ columns, rows: 4, items: positions.map((column, index) =>
            ({ key: `gap-${index}`, row: 2, column, span: 1 })) });
        const projected = assertProjection(logical);
        assert.equal(projected.lastRow, 2, 'last occupied row ignores empty declared tracks');
        assert.equal(projected.offset, expectedOffset);
        for (let index = 1; index < positions.length; index++) {
            assert.equal(projected.items[index].column - projected.items[index - 1].column,
                positions[index] - positions[index - 1]);
        }
    }
});

test('a large tile intersecting the occupied bottom row prevents centering even when its origin is above it', () => {
    const bottomLarge = freeze(G.build({ keys: keys(5), columns: 4,
        focus: { key: 'player-0', row: 0, column: 2, span: 2 } }));
    const blocked = assertProjection(bottomLarge);
    assert.equal(blocked.lastRow, 1);
    assert.equal(blocked.offset, 0);
    assert.deepEqual(blocked.items, bottomLarge.items);
    const upperLarge = freeze(G.build({ keys: keys(11), columns: 5,
        focus: { key: 'player-0', row: 0, column: 0, span: 2 } }));
    const centered = assertProjection(upperLarge);
    assert.equal(centered.lastRow, 2);
    assert.equal(centered.offset, .5);
    assert.deepEqual(byKey(centered, 'player-0'), byKey(upperLarge, 'player-0'));
});

test('empty and invalid layouts do not invent a centering shift or visual adjacency', () => {
    assert.equal(assertProjection(freeze(G.build())).lastRow, null);
    for (const value of [null, {}, { columns: 0, rows: 1, items: [] },
        { columns: 3, rows: 1, items: [{ key: 'a', row: 0, column: .5, span: 1 }] },
        { columns: 3, rows: 1, items: [{ key: 'a', row: 0, column: 3, span: 1 }] },
        { columns: 3, rows: 1, items: [{ key: 'a', row: 0, column: 0, span: 1 }, { key: 'a', row: 0, column: 1, span: 1 }] },
        { columns: 3, rows: 1, items: [{ key: 'a', row: 0, column: 0, span: 1 }, { key: 'b', row: 0, column: 0, span: 1 }] },
        { columns: 3, rows: 2, items: [{ key: 'a', row: 0, column: 0, span: 2 }, { key: 'b', row: 1, column: 1, span: 1 }] }
    ]) {
        freeze(value);
        const before = JSON.stringify(value), projected = L.presentation(value);
        assert.equal(projected.offset, 0);
        assert.deepEqual(projected.items, value?.items || []);
        assert.ok([...projected.offsets.values()].every(offset => offset === 0));
        for (const direction of directions) {
            assert.deepEqual(operations.visualNeighbors(value, 'a', direction), []);
            assert.equal(operations.visualNeighbor(value, 'a', direction), null);
        }
        assert.equal(JSON.stringify(value), before);
    }
});

test('visual neighbors use positive projected shared edges symmetrically without wrapping', () => {
    const logical = freeze(G.build({ keys: keys(5), columns: 4 }));
    assert.deepEqual(operations.visualNeighbors(logical, 'player-4', 'up').map(item => item.key), ['player-1', 'player-2']);
    assert.equal(operations.visualNeighbor(logical, 'player-4', 'up').key, 'player-1');
    assert.deepEqual(operations.visualNeighbors(logical, 'player-0', 'down'), []);
    assert.deepEqual(operations.visualNeighbors(logical, 'player-3', 'right'), []);
    assert.deepEqual(operations.visualNeighbors(logical, 'player-4', 'left'), []);
    for (let count = 2; count <= 40; count++) for (const columns of [2, 3, 4, 7]) {
        const layout = freeze(G.build({ keys: keys(count), columns }));
        const projected = L.presentation(layout);
        for (const source of layout.items) for (const direction of directions) {
            const targets = operations.visualNeighbors(layout, source.key, direction);
            assert.deepEqual(L.visualNeighbors(layout, source.key, direction, G), targets);
            assert.equal(L.visualNeighbor(layout, source.key, direction, G), operations.visualNeighbor(layout, source.key, direction));
            for (const target of targets) {
                assert.equal(target, byKey(layout, target.key), 'return original logical item identity');
                assert.ok(operations.visualNeighbors(layout, target.key, reverse[direction]).some(item => item.key === source.key));
                const a = byKey(projected, source.key), b = byKey(projected, target.key);
                const cross = direction === 'up' || direction === 'down' ? 'column' : 'row';
                assert.ok(Math.min(a[cross] + a.span, b[cross] + b.span) > Math.max(a[cross], b[cross]));
            }
        }
    }
    const corner = freeze({ columns: 4, rows: 2, items: [
        { key: 'a', row: 0, column: 0, span: 1 }, { key: 'b', row: 1, column: 0, span: 1 }
    ] });
    // The bottom tile centers at 1.5, leaving a horizontal gap from the source.
    assert.deepEqual(operations.visualNeighbors(corner, 'a', 'down'), []);
});

test('a visual edge can move a big tile exactly one logical cell when the entering logical strip is empty', () => {
    const layout = freeze(G.build({ keys: keys(9), columns: 5,
        focus: { key: 'player-0', row: 0, column: 3, span: 2 } }));
    const source = byKey(layout, 'player-0');
    assert.deepEqual(G.neighbors(layout, source.key, 'down'), []);
    const targets = operations.visualNeighbors(layout, source.key, 'down');
    assert.equal(targets.length, 1);
    const target = targets[0];
    assert.equal(target.column, 1);
    assert.equal(byKey(L.presentation(layout), target.key).column, 2.5);
    assert.equal(operations.step(layout, source.key, 'down', target.key).kind, 'none', 'legacy routing stays logical');
    const plan = operations.visualStep(layout, source.key, 'down', target.key);
    assert.equal(plan.kind, 'step');
    assert.equal(plan.focusDirection, 'down');
    assert.deepEqual(byKey(plan.next, source.key), { ...source, row: source.row + 1 });
    assertLogical(plan.next);
    assertProjection(plan.next);
    assert.deepEqual(operations.visualStep(layout, target.key, 'up', source.key).next, plan.next);
    assert.deepEqual(operations.visualTarget(layout, source.key, target.key), plan);
    assert.equal(operations.visualTarget(layout, source.key, target.key, { direction: 'right' }).kind, 'none');
    const remote = layout.items.find(item => item.span === 1 && item.row === 0 && item.column === 0);
    assert.equal(operations.visualTarget(layout, source.key, remote.key).kind, 'relocate');
    assert.equal(operations.visualTarget(layout, source.key, remote.key, { direction: 'down' }).kind, 'none');
});

test('every selectable visual big-tile step remains integer, bounded and collision free', () => {
    let steps = 0, shiftedEdges = 0;
    for (let count = 2; count <= 32; count++) for (const columns of [3, 4, 5, 7]) {
        for (const span of [2, 3]) for (const column of [0, columns - span]) {
            const layout = freeze(G.build({ keys: keys(count), columns,
                focus: { key: 'player-0', row: 0, column, span } }));
            const source = byKey(layout, 'player-0');
            for (const direction of directions) for (const target of operations.visualNeighbors(layout, source.key, direction)) {
                const plan = operations.visualStep(layout, source.key, direction, target.key);
                assert.equal(plan.kind, 'step');
                const moved = byKey(plan.next, source.key);
                assert.equal(Math.abs(moved.row - source.row) + Math.abs(moved.column - source.column), 1);
                assertLogical(plan.next);
                assertProjection(plan.next);
                assert.deepEqual(operations.visualStep(layout, target.key, reverse[direction], source.key).next, plan.next);
                if (!G.neighbors(layout, source.key, direction).some(item => item.key === target.key)) shiftedEdges++;
                steps++;
            }
        }
    }
    assert.ok(steps > 1000);
    assert.ok(shiftedEdges > 0);
});

test('centered tail resize previews retain the displayed opposite edge and clip growth to the pane', () => {
    const layout = freeze(G.build({ keys: keys(5), columns: 4 }));
    const key = 'player-4', before = JSON.stringify(layout);
    const measure = { width: 800, height: 450, columnGap: 8, rowGap: 6 };
    const pitch = (measure.width + measure.columnGap) / layout.columns;
    const originalLeft = 1.5 * pitch;
    const originalRight = 2.5 * pitch - measure.columnGap;
    assert.equal(byKey(layout, key).column, 0);
    assert.equal(byKey(L.presentation(layout), key).column, 1.5);
    for (const corner of ['ne', 'nw']) for (const span of [2, 256]) {
        const plan = operations.previewSize(layout, key, span, corner, measure);
        assert.equal(plan.kind, 'size');
        const preview = plan.preview;
        if (corner === 'ne') assert.equal(preview.left, originalLeft);
        else assert.equal(preview.left + preview.width, originalRight);
        assert.equal(preview.top + preview.height, measure.height, 'north handles fix the original displayed bottom');
        assert.ok(preview.left >= 0 && preview.top >= 0);
        assert.ok(preview.left + preview.width <= measure.width);
        assert.ok(preview.top + preview.height <= measure.height);
        if (span === 256) {
            if (corner === 'ne') assert.equal(preview.left + preview.width, measure.width);
            else assert.equal(preview.left, 0);
            assert.equal(preview.top, 0);
        }
        assertLogical(plan.next);
    }
    assert.equal(JSON.stringify(layout), before);
});

test('operations, projection and state persistence retain integer anchors and round trip the same presentation', () => {
    const state = L.createState({ buildGeometry: G.build });
    state.setOrder(keys(11));
    state.commit(G.build({ keys: state.order, columns: 5 }));
    const commit = plan => {
        assert.notEqual(plan.kind, 'none');
        const logical = state.commit(plan.next);
        assertLogical(logical);
        const projected = assertProjection(logical);
        const restored = G.build({ keys: state.order, columns: logical.columns,
            focus: logical.items.find(item => item.span > 1) });
        assert.deepEqual(canonicalItems(restored), canonicalItems(logical));
        assert.deepEqual(canonicalItems(L.presentation(restored)), canonicalItems(projected));
    };
    commit(operations.exchange(state.geometry, 'player-0', 'player-10'));
    commit(operations.grow(state.geometry, 'player-0'));
    commit(operations.resize(state.geometry, 'player-0', 3, 'se'));
    commit(operations.swapFocus(state.geometry, 'player-5'));
    commit(operations.shrink(state.geometry, 'player-5'));
    commit(operations.shrink(state.geometry, 'player-5'));
    state.setOrder(state.order.filter(key => key !== 'player-10'));
    assertLogical(state.geometry);
    assertProjection(state.geometry);
    const before = JSON.stringify(state.geometry);
    L.presentation(state.geometry);
    assert.equal(JSON.stringify(state.geometry), before);
});
