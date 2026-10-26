'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = name => {
    const migrated = path.join(__dirname, '../site/assets/js', name + '.js');
    return require(fs.existsSync(migrated) ? migrated : path.join(__dirname, '..', name + '.js'));
};
const G = source('player-geometry'), L = source('player-layout');
const operations = L.createOperations({ geometry: G });
const keys = count => Array.from({ length: count }, (_, index) => 'anchor-' + index);
const visual = layout => [...layout.items].sort((a, b) => a.row - b.row || a.column - b.column).map(item => item.key);
const cell = (layout, key) => layout.items.find(item => item.key === key);
const focus = layout => layout.items.find(item => item.span > 1);
const pane = { width: 1400, height: 830, columnGap: 10, rowGap: 10 };

// Match the app's explicit +/− transaction, including its size-intent reflow.
// Looking at grow() alone misses the later change in the number of tracks.
function sizeTransaction(layout, key, action = 'grow', dimensions = pane) {
    const growth = action === 'grow' ? operations.grow(layout, key) : null;
    const draft = growth ? growth.next : G[action](layout, key), order = visual(draft), enlarged = focus(draft);
    const plan = operations.reflow({ keys: order, focus: enlarged,
        pending: enlarged ? { ...draft, intent: 'size', ...(growth ? { growthAnchor: growth.growthAnchor } : {}) } : null },
    { ...dimensions, count: order.length, previous: layout });
    return plan.next.items ? plan.next : { ...plan.next, ...G.build({ keys: order, columns: plan.next.columns }) };
}

function validate(layout, expectedKeys) {
    assert.deepEqual(layout.items.map(item => item.key).sort(), [...expectedKeys].sort());
    const used = new Set();
    for (const item of layout.items) {
        assert.ok(Number.isInteger(item.row) && item.row >= 0);
        assert.ok(Number.isInteger(item.column) && item.column >= 0);
        assert.ok(Number.isInteger(item.span) && item.span >= 1);
        assert.ok(item.row + item.span <= layout.rows && item.column + item.span <= layout.columns);
        for (let y = item.row; y < item.row + item.span; y++) for (let x = item.column; x < item.column + item.span; x++) {
            assert.ok(!used.has(y + ':' + x), 'overlap at ' + y + ':' + x);
            used.add(y + ':' + x);
        }
    }
    assert.ok(layout.items.filter(item => item.span > 1).length <= 1);
}

test('anchor audit: repeated growth at the top-left preserves top/left docking and all channel identities', () => {
    for (const count of [5, 9, 17]) for (const dimensions of [pane,
        { ...pane, width: 420, height: 880 }, { ...pane, width: 1900, height: 520 }]) {
        const order = keys(count), key = order[0];
        let layout = G.build({ keys: order, columns: 3 });
        for (let step = 0; step < 5; step++) {
            layout = sizeTransaction(layout, key, 'grow', dimensions);
            assert.equal(cell(layout, key).row, 0);
            assert.equal(cell(layout, key).column, 0);
            validate(layout, order);
        }
    }
});

test('anchor audit: downward one-cell movement reaches the bottom exactly and a further step is inert', () => {
    const order = keys(9), key = order[2];
    let layout = G.build({ keys: order, columns: 3, focus: { key, row: 0, column: 1, span: 2 } });
    for (let row = 1; row <= 2; row++) {
        const adjacent = G.neighbor(layout, key, 'down');
        assert.ok(adjacent, 'a real touching tile is required for an arrow move');
        const before = cell(layout, key), plan = operations.step(layout, key, 'down', adjacent.key);
        assert.equal(plan.kind, 'step'); layout = plan.next;
        assert.deepEqual(cell(layout, key), { ...before, row });
        assert.equal(layout.columns, 3); assert.equal(layout.rows, 4);
        validate(layout, order);
    }
    assert.equal(cell(layout, key).row + cell(layout, key).span, layout.rows);
    assert.deepEqual(G.neighbors(layout, key, 'down'), []);
    assert.equal(G.step(layout, key, 'down'), layout);
});

// Explicit growth captures docking before any old-track boundary clamp.
test('BND-001: growing a right-docked 2x2 player to 3x3 keeps it at the FINAL right edge',
    () => {
        const order = keys(9), key = order[2];
        const initial = G.build({ keys: order, columns: 3 });
        const twice = sizeTransaction(initial, key);
        assert.equal(cell(twice, key).column + 2, twice.columns);
        const next = sizeTransaction(twice, key);
        validate(next, order);
        assert.equal(cell(next, key).column + cell(next, key).span, next.columns,
            'preserve the pre-growth right-edge intent after choosing the final grid');
    });

test('BND-002: a player moved down to the bottom stays at the FINAL bottom edge after growth',
    () => {
        const order = keys(9), key = order[2];
        let layout = G.build({ keys: order, columns: 3, focus: { key, row: 0, column: 1, span: 2 } });
        for (let step = 0; step < 2; step++) {
            const target = G.neighbor(layout, key, 'down');
            layout = operations.step(layout, key, 'down', target.key).next;
        }
        assert.equal(cell(layout, key).row + cell(layout, key).span, layout.rows);
        const next = sizeTransaction(layout, key);
        validate(next, order);
        assert.equal(cell(next, key).row + cell(next, key).span, next.rows,
            'growth after a deliberate downward placement must retain bottom-edge intent');
    });

test('growth docking: all four corners stay on their chosen edges through repeated final-grid choices', t => {
    let checked = 0;
    for (const count of [5, 9, 17, 32]) for (const dimensions of [pane,
        { ...pane, width: 420, height: 880 }, { ...pane, width: 1900, height: 520 }]) {
        for (const side of ['nw', 'ne', 'sw', 'se']) {
            const order = keys(count), base = G.build({ keys: order, columns: 4 });
            const key = order[0], span = 2;
            let layout = G.build({ keys: order, columns: 4, focus: { key, span,
                row: side[0] === 's' ? Math.max(span, Math.ceil((count + 3) / 4)) - span : 0,
                column: side[1] === 'e' ? 2 : 0 } });
            for (let step = 0; step < 4; step++) {
                const old = cell(layout, key), expectRight = old.column > 0 && old.column + old.span === layout.columns;
                const expectBottom = old.row > 0 && old.row + old.span === layout.rows;
                const next = sizeTransaction(layout, key, 'grow', dimensions), grown = cell(next, key);
                if (expectRight) assert.equal(grown.column + grown.span, next.columns);
                else if (old.column === 0) assert.equal(grown.column, 0);
                if (expectBottom) assert.equal(grown.row + grown.span, next.rows);
                else if (old.row === 0) assert.equal(grown.row, 0);
                assert.equal(grown.span, old.span + 1);
                validate(next, order); layout = next; checked++;
            }
            assert.equal(base.items.length, layout.items.length);
        }
    }
    t.diagnostic('growth docking coverage ' + checked);
});

test('growth docking: intent is target/span scoped and never affects shrink, drag or restore', () => {
    const order = keys(9), key = order[2];
    const layout = G.build({ keys: order, columns: 3, focus: { key, span: 2, row: 2, column: 1 } });
    const growth = operations.grow(layout, key), enlarged = focus(growth.next);
    assert.deepEqual(growth.growthAnchor, { key, span: 3, right: true, bottom: true });
    const options = { ...pane, keys: visual(growth.next), focus: enlarged, force: true };
    const plain = G.choose(options);
    for (const bad of [{ ...growth.growthAnchor, key: 'stale' }, { ...growth.growthAnchor, span: 2 }])
        assert.deepEqual(G.choose({ ...options, growthAnchor: bad }), plain);
    const restored = operations.reflow({ keys: options.keys, focus: enlarged,
        pending: { ...growth.next, intent: 'restore', growthAnchor: growth.growthAnchor } }, { ...pane, previous: layout });
    assert.deepEqual(restored.next.items, plain.items, 'reopening must not replay a past + intent');
    const missing = operations.grow(layout, 'missing'); assert.equal(missing.kind, 'none'); assert.equal(missing.next, layout);
    const other = layout.items.find(item => item.span === 1 && item.column + 1 === layout.columns);
    const switched = operations.grow(layout, other.key);
    assert.equal(switched.growthAnchor.key, other.key); assert.equal(switched.growthAnchor.span, 2);
    assert.equal(focus(switched.next).key, other.key);
    assert.equal(Object.hasOwn(growth.next, 'growthAnchor'), false, 'transient intent never enters committed geometry');
});

test('anchor audit: a bottom placement, bookmark-style reflow and hidden pane preserve its chosen row', () => {
    const order = keys(17), key = order[0];
    const initial = G.build({ keys: order, columns: 5, focus: { key, row: 0, column: 0, span: 3 } });
    const target = initial.items.find(item => item.span === 1 && item.row === initial.rows - 1);
    const relocated = operations.target(initial, key, target.key).next;
    const desired = cell(relocated, key);
    assert.equal(desired.row + desired.span, relocated.rows);
    const state = L.createState({ buildGeometry: G.build }); state.commit(relocated);
    for (const dimensions of [pane, { ...pane, width: 0 }, { ...pane, height: 0 }]) {
        const plan = operations.reflow({ keys: state.order, focus: state.focus,
            pending: { ...relocated, intent: 'bookmark' } }, { ...dimensions, previous: relocated });
        assert.deepEqual(cell(plan.next, key), desired);
        validate(plan.next, order);
        assert.equal(Boolean(plan.next.deferredFocus), dimensions.width === 0 || dimensions.height === 0);
    }
});

test('anchor audit: shrink keeps the established top-left origin until returning to 1x1', () => {
    // This is the existing shrink contract. Bottom/right docking on shrink is
    // a separate product choice, not a bounds failure or part of BND-001/002.
    const order = keys(8), key = order[0];
    let layout = G.build({ keys: order, columns: 4, focus: { key, row: 1, column: 1, span: 3 } });
    const next = sizeTransaction(layout, key, 'shrink');
    assert.equal(cell(next, key).row, 1); assert.equal(cell(next, key).column, 1);
    assert.equal(cell(next, key).span, 2); validate(next, order);
    layout = sizeTransaction(next, key, 'shrink');
    assert.ok(layout.items.every(item => item.span === 1)); validate(layout, order);
});
