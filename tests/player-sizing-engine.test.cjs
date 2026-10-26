'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const source = name => {
    const migrated = path.join(__dirname, '../site/assets/js', name + '.js');
    return require(fs.existsSync(migrated) ? migrated : path.join(__dirname, '..', name + '.js'));
};
const G = source('player-geometry'), L = source('player-layout'), operations = L.createOperations({ geometry: G });
const { assertCompact, assertBestDocking } = require('./helpers/player-layout-compaction.cjs');
const measure = { width: 1400, height: 830, columnGap: 10, rowGap: 10 };
const keys = n => Array.from({ length: n }, (_, i) => 'sizing-' + i);
const visual = layout => [...layout.items].sort((a, b) => a.row - b.row || a.column - b.column).map(item => item.key);
const focus = layout => layout.items.find(item => item.span > 1);
const cell = (layout, key) => layout.items.find(item => item.key === key);
const canonical = layout => ({ columns: layout.columns, rows: layout.rows,
    items: [...layout.items].sort((a, b) => a.key.localeCompare(b.key)) });
const freeze = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
};
const fit = (plan, dimensions = measure) => operations.fitSize({ keys: visual(plan.next), focus: focus(plan.next),
    growthAnchor: plan.growthAnchor, preserveAnchor: plan.preserveAnchor }, dimensions);
function rectangle(layout, item, dimensions = measure) {
    const x = (dimensions.width + dimensions.columnGap) / layout.columns;
    const y = (dimensions.height + dimensions.rowGap) / layout.rows;
    return { left: item.column * x, top: item.row * y,
        right: (item.column + item.span) * x - dimensions.columnGap,
        bottom: (item.row + item.span) * y - dimensions.rowGap };
}
function valid(layout, expected) {
    assert.deepEqual(layout.items.map(item => item.key).sort(), [...expected].sort());
    assert.ok(layout.items.filter(item => item.span > 1).length <= 1);
    const used = new Set();
    for (const item of layout.items) {
        assert.ok(Number.isInteger(item.row) && item.row >= 0 && Number.isInteger(item.column) && item.column >= 0);
        assert.ok(Number.isInteger(item.span) && item.span >= 1);
        assert.ok(item.row + item.span <= layout.rows && item.column + item.span <= layout.columns);
        for (let y = item.row; y < item.row + item.span; y++) for (let x = item.column; x < item.column + item.span; x++) {
            assert.ok(!used.has(y + ':' + x), 'cell collision ' + y + ':' + x); used.add(y + ':' + x);
        }
    }
}
function assertPreview(plan, dimensions = measure) {
    assert.equal(plan.kind, 'size');
    const box = plan.preview;
    for (const value of Object.values(box)) assert.ok(Number.isFinite(value) && value >= 0);
    assert.ok(box.left + box.width <= dimensions.width + 1e-7);
    assert.ok(box.top + box.height <= dimensions.height + 1e-7);
}

test('sizing engine requires every shared sizing operation and returns an immutable API', () => {
    for (const name of ['grow', 'shrink', 'resize']) assert.throws(() => L.createOperations({ geometry: { ...G, [name]: undefined } }), TypeError);
    assert.ok(Object.isFrozen(operations));
    for (const name of ['grow', 'shrink', 'resize', 'fitSize', 'previewSize']) assert.equal(typeof operations[name], 'function');
});

test('sizing engine fits explicit growth and its reflow through the same final-edge solver', () => {
    const order = keys(9), key = order[2];
    const layout = freeze(G.build({ keys: order, columns: 3, focus: { key, span: 2, row: 2, column: 1 } }));
    const plan = operations.grow(layout, key), fitted = fit(plan);
    assertBestDocking(layout, fitted, key); assertCompact(fitted);
    const reflowed = operations.reflow({ keys: visual(plan.next), focus: focus(plan.next),
        pending: { ...plan.next, intent: 'size', growthAnchor: plan.growthAnchor } }, { ...measure, previous: layout }).next;
    assert.deepEqual(canonical(reflowed), canonical(fitted));
    assert.equal(Object.hasOwn(fitted, 'growthAnchor'), false);
    valid(fitted, order);
});

test('sizing engine shrink keeps feasible edges without interior holes, including normal span-one fitting', () => {
    const order = keys(8), key = order[0];
    const layout = freeze(G.build({ keys: order, columns: 4, focus: { key, span: 3, row: 1, column: 1 } }));
    const plan = operations.shrink(layout, key);
    assert.equal(plan.kind, 'size'); assert.equal(plan.span, 2);
    assert.deepEqual(cell(plan.next, key), { key, span: 2, row: 1, column: 1 });
    assert.deepEqual(plan.growthAnchor, { key, span: 2, right: true, bottom: true, left: false, top: false });
    const first = fit(plan), smaller = cell(first, key);
    assertBestDocking(layout, first, key); assertCompact(first);
    const normalPlan = operations.shrink(first, key), normal = fit(normalPlan);
    assert.equal(normalPlan.span, 1); assert.equal(focus(normal), undefined);
    assert.equal(normalPlan.growthAnchor.span, 1);
    assertBestDocking(first, normal, key); assertCompact(normal);
    const expected = L.choose({ ...measure, count: order.length, force: true });
    assert.equal(normal.columns, expected.columns); assert.equal(normal.rows, expected.rows);
    valid(normal, order);
    assert.equal(operations.shrink(normal, key).kind, 'none');
});

test('sizing engine plus and minus keep the most feasible docked edges while removing all middle gaps', t => {
    let checked = 0;
    for (const count of [5, 9, 17, 32]) for (const dimensions of [measure,
        { ...measure, width: 420, height: 880 }, { ...measure, width: 1900, height: 520 }]) {
        const order = keys(count), key = order[0], span = 4, columns = 6;
        const rows = Math.ceil((count + span * span - 1) / columns);
        for (const position of [
            { row: 0, column: 0 }, { row: 0, column: columns - span },
            { row: rows - span, column: 0 }, { row: rows - span, column: columns - span },
            { row: 0, column: 1 }, { row: 1, column: 0 },
            { row: 1, column: columns - span }, { row: rows - span, column: 1 }
        ]) {
            let layout = freeze(G.build({ keys: order, columns, focus: { key, span, ...position } }));
            for (const action of ['shrink', 'shrink', 'grow', 'shrink']) {
                const original = JSON.stringify(layout), old = cell(layout, key), plan = operations[action](layout, key);
                const next = fit(plan, dimensions), item = cell(next, key);
                assertBestDocking(layout, next, key); assertCompact(next);
                assert.equal(JSON.stringify(layout), original, 'sizing never mutates the previous geometry');
                assert.equal(Object.hasOwn(next, 'growthAnchor'), false, 'docking is an action intent, not persisted layout state');
                valid(next, order); layout = freeze(next); checked++;
            }
        }
    }
    assert.equal(checked, 384); t.diagnostic('shrink docking coverage ' + checked);
});

test('sizing engine corner requests retain only the fixed opposite docked edges, including full-width ties', () => {
    const order = keys(9), key = order[0];
    const full = freeze(G.build({ keys: order, columns: 3, focus: { key, span: 3, row: 0, column: 0 } }));
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
        const plan = operations.resize(full, key, 2, corner);
        assert.equal(plan.preserveAnchor, true);
        assert.deepEqual(plan.growthAnchor, { key, span: 2, right: corner.endsWith('w'), bottom: false,
            left: corner.endsWith('e'), top: corner.startsWith('s') });
    }
    const bottom = freeze(G.build({ keys: order, columns: 3, focus: { key, span: 2, row: 2, column: 1 } }));
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
        const plan = operations.resize(bottom, key, 3, corner), fitted = fit(plan);
        assert.equal(plan.growthAnchor.right, corner.endsWith('w'));
        assert.equal(plan.growthAnchor.bottom, corner.startsWith('n'));
        assertCompact(fitted);
        valid(fitted, order);
    }
});

test('sizing preview keeps the original fixed opposite pixels when a northwest shrink chooses different final tracks', () => {
    const order = keys(9), key = order[0];
    const layout = freeze(G.build({ keys: order, columns: 4, focus: { key, span: 3, row: 0, column: 0 } }));
    const before = rectangle(layout, cell(layout, key));
    const plan = operations.previewSize(layout, key, 2, 'nw', measure); assertPreview(plan);
    assert.equal(plan.preview.left + plan.preview.width, before.right);
    assert.equal(plan.preview.top + plan.preview.height, before.bottom);
    assert.notEqual(plan.next.columns, layout.columns, 'the final fit is allowed to choose new tracks');
    assert.deepEqual(canonical(plan.next), canonical(fit(operations.resize(layout, key, 2, 'nw'))));
    assert.equal(before.right, 1047.5, 'this is the reported rightward-preview jump case');
    valid(plan.next, order);
});

test('sizing preview keeps the selected opposite corner through every handle and repeated size thresholds', () => {
    const order = keys(17), key = order[0];
    const layout = freeze(G.build({ keys: order, columns: 5, focus: { key, span: 2, row: 2, column: 2 } }));
    const before = rectangle(layout, cell(layout, key));
    for (const corner of ['nw', 'ne', 'sw', 'se']) for (const span of [1, 3, 4, 3, 1]) {
        const plan = operations.previewSize(layout, key, span, corner, measure); assertPreview(plan);
        if (corner.endsWith('w')) assert.equal(plan.preview.left + plan.preview.width, before.right);
        else assert.equal(plan.preview.left, before.left);
        if (corner.startsWith('n')) assert.equal(plan.preview.top + plan.preview.height, before.bottom);
        else assert.equal(plan.preview.top, before.top);
    }
});

test('sizing preview clips large requests to the pane without moving the fixed opposite edges', () => {
    const order = keys(9), key = order[0];
    const layout = freeze(G.build({ keys: order, columns: 4, focus: { key, span: 3, row: 1, column: 1 } }));
    const before = rectangle(layout, cell(layout, key));
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
        const plan = operations.previewSize(layout, key, 256, corner, measure); assertPreview(plan);
        assert.equal(plan.span, 256);
        if (corner.endsWith('w')) assert.equal(plan.preview.left + plan.preview.width, before.right);
        else assert.equal(plan.preview.left, before.left);
        if (corner.startsWith('n')) assert.equal(plan.preview.top + plan.preview.height, before.bottom);
        else assert.equal(plan.preview.top, before.top);
        valid(plan.next, order);
    }
});

test('sizing engine rejects missing, unchanged and unmeasurable requests and normalizes span and corner once', () => {
    const order = keys(9), key = order[0];
    const layout = freeze(G.build({ keys: order, columns: 4, focus: { key, span: 3, row: 1, column: 1 } }));
    assert.equal(operations.resize(layout, 'missing', 2).next, layout);
    assert.equal(operations.previewSize(layout, 'missing', 2, 'nw', measure).next, layout);
    assert.equal(operations.resize(layout, key, 3, 'nw').next, layout);
    const small = order[1];
    assert.equal(operations.resize(layout, small, 1, 'nw').next, layout, 'a subthreshold drag cannot remove another large tile');
    for (const dimensions of [{ ...measure, width: 0 }, { ...measure, height: 0 }, { ...measure, width: Infinity }])
        assert.equal(operations.previewSize(layout, key, 2, 'nw', dimensions).kind, 'none');
    const normalized = operations.resize(layout, key, 1024, 'invalid');
    assert.equal(normalized.span, 256); assert.equal(normalized.corner, 'se');
    assert.deepEqual(canonical(normalized.next), canonical(G.resize(layout, key, 256, 'se')));
});

test('sizing engine handles normal, empty and single-player fitting without inventing a large tile', () => {
    for (const count of [0, 1, 2, 5, 17]) {
        const order = keys(count), fitted = operations.fitSize({ keys: order,
            focus: count ? { key: order[0], span: 3, row: 0, column: 0 } : null }, measure);
        if (count < 2) assert.equal(focus(fitted), undefined);
        valid(fitted, order);
    }
});

test('sizing engine shared fitting and clipped previews preserve inputs across deterministic corner and viewport matrices', t => {
    const dimensions = [measure, { ...measure, width: 420, height: 880 }, { ...measure, width: 1800, height: 500 }];
    let cases = 0;
    for (const count of [3, 9, 11, 17, 32]) for (const columns of [3, 4, 5]) {
        const order = keys(count), key = order[0];
        const layout = freeze(G.build({ keys: order, columns, focus: { key, span: 2, row: 1, column: columns - 2 } }));
        const before = JSON.stringify(layout);
        for (const viewport of dimensions) for (const corner of ['nw', 'ne', 'sw', 'se']) for (const span of [1, 3, 4, 8]) {
            const plan = operations.previewSize(layout, key, span, corner, viewport); assertPreview(plan, viewport);
            assert.deepEqual(canonical(plan.next), canonical(fit(operations.resize(layout, key, span, corner), viewport)));
            valid(plan.next, order); cases++;
        }
        assert.equal(JSON.stringify(layout), before);
    }
    assert.equal(cases, 720); t.diagnostic('shared sizing coverage ' + cases);
});
