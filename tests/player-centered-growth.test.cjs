'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const source = name => {
    const migrated = path.join(__dirname, '../site/assets/js', name + '.js');
    return require(fs.existsSync(migrated) ? migrated : path.join(__dirname, '..', name + '.js'));
};
const G = source('player-geometry'), L = source('player-layout');
const operations = L.createOperations({ geometry: G });
const { assertCompact, dockScore, maximumDockScore } = require('./helpers/player-layout-compaction.cjs');
const corners = ['nw', 'ne', 'sw', 'se'];
const keys = count => Array.from({ length: count }, (_, index) => 'centered-' + index);
const byKey = (layout, key) => layout.items.find(item => item.key === key);
const visual = layout => [...layout.items].sort((a, b) => a.row - b.row || a.column - b.column).map(item => item.key);
const freeze = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze); Object.freeze(value);
    }
    return value;
};
const measure = { width: 1400, height: 1000, columnGap: 10, rowGap: 10 };
function rectangle(layout, item, dimensions) {
    const pitchX = (dimensions.width + dimensions.columnGap) / layout.columns;
    const pitchY = (dimensions.height + dimensions.rowGap) / layout.rows;
    return { left: item.column * pitchX, right: (item.column + item.span) * pitchX - dimensions.columnGap,
        top: item.row * pitchY, bottom: (item.row + item.span) * pitchY - dimensions.rowGap };
}
const sideMismatch = (wanted, actual) => Number((wanted - .5) * (actual - .5) < -1e-9);
function audit(layout, key, plan, dimensions) {
    assert.equal(plan.kind, 'size');
    assertCompact(plan.next);
    assert.deepEqual(plan.next.items.map(item => item.key).sort(), layout.items.map(item => item.key).sort());
    assert.deepEqual(plan.next.items.filter(item => item.span > 1).map(item => item.key), [key]);
    const shown = L.presentation(layout), original = rectangle(shown, byKey(shown, key), dimensions);
    const actual = rectangle(plan.next, byKey(plan.next, key), dimensions);
    const previewCenter = (plan.preview.left + plan.preview.width / 2) / dimensions.width;
    const actualCenter = (actual.left + actual.right) / (2 * dimensions.width);
    const previewCenterY = (plan.preview.top + plan.preview.height / 2) / dimensions.height;
    const actualCenterY = (actual.top + actual.bottom) / (2 * dimensions.height);
    const fixed = {
        x: (plan.corner.endsWith('w') ? original.right : original.left) / dimensions.width,
        y: (plan.corner.startsWith('n') ? original.bottom : original.top) / dimensions.height
    };
    // An independent exhaustive compact-grid oracle checks spatial intent and
    // video area. It does not call either production fit or anchor scorer.
    const count = layout.items.length, span = plan.span, occupied = count + span * span - 1;
    let bestSide = Infinity, bestArea = -1, nearest = Infinity;
    const maximumColumns = Math.floor((occupied - span) / (span - 1));
    for (let columns = span; columns <= maximumColumns; columns++) {
        const rows = Math.ceil(occupied / columns);
        const cellWidth = Math.max(0, (dimensions.width - dimensions.columnGap * (columns - 1)) / columns);
        const cellHeight = Math.max(0, (dimensions.height - dimensions.rowGap * (rows - 1)) / rows);
        const videoWidth = Math.min(cellWidth, cellHeight * 16 / 9), area = videoWidth * videoWidth * 9 / 16;
        for (let row = 0; row + span <= rows; row++) for (let column = 0; column + span <= columns; column++) {
            if ((row + span - 1) * columns + column + span > occupied) continue;
            const box = rectangle({ columns, rows }, { row, column, span }, dimensions);
            const side = sideMismatch(previewCenter, (box.left + box.right) / (2 * dimensions.width)) +
                sideMismatch(previewCenterY, (box.top + box.bottom) / (2 * dimensions.height));
            const x = (plan.corner.endsWith('w') ? box.right : box.left) / dimensions.width;
            const y = (plan.corner.startsWith('n') ? box.bottom : box.top) / dimensions.height;
            const distance = (x - fixed.x) ** 2 + (y - fixed.y) ** 2;
            if (side < bestSide || side === bestSide && area > bestArea + .01) {
                bestSide = side; bestArea = area; nearest = distance;
            } else if (side === bestSide && Math.abs(area - bestArea) <= .01) nearest = Math.min(nearest, distance);
        }
    }
    assert.equal(sideMismatch(previewCenter, actualCenter) + sideMismatch(previewCenterY, actualCenterY), bestSide,
        'avoid crossing the preview in either axis when a compact alternative exists');
    const cellWidth = Math.max(0, (dimensions.width - dimensions.columnGap * (plan.next.columns - 1)) / plan.next.columns);
    const cellHeight = Math.max(0, (dimensions.height - dimensions.rowGap * (plan.next.rows - 1)) / plan.next.rows);
    const videoWidth = Math.min(cellWidth, cellHeight * 16 / 9), area = videoWidth * videoWidth * 9 / 16;
    assert.ok(Math.abs(area - bestArea) <= .011, 'choose the largest video area on the intended side: ' + JSON.stringify({ area, bestArea, key, corner: plan.corner, span }));
    const x = (plan.corner.endsWith('w') ? actual.right : actual.left) / dimensions.width;
    const y = (plan.corner.startsWith('n') ? actual.bottom : actual.top) / dimensions.height;
    const distance = (x - fixed.x) ** 2 + (y - fixed.y) ** 2;
    assert.ok(distance <= nearest + 1e-8, 'retain the closest displayed opposite corner among equally good compact fits');
    for (const value of Object.values(plan.preview)) assert.ok(Number.isFinite(value) && value >= 0);
    assert.ok(plan.preview.left + plan.preview.width <= dimensions.width + 1e-7);
    assert.ok(plan.preview.top + plan.preview.height <= dimensions.height + 1e-7);
}

function auditNormal(layout, key, plan, dimensions) {
    assert.equal(plan.kind, 'size'); assert.equal(plan.span, 1);
    assertCompact(plan.next); assert.ok(plan.next.items.every(item => item.span === 1));
    assert.deepEqual(plan.next.items.map(item => item.key).sort(), layout.items.map(item => item.key).sort());
    const shown = L.presentation(layout), original = rectangle(shown, byKey(shown, key), dimensions);
    const actualShown = L.presentation(plan.next), actual = rectangle(actualShown, byKey(actualShown, key), dimensions);
    const px = (plan.preview.left + plan.preview.width / 2) / dimensions.width;
    const py = (plan.preview.top + plan.preview.height / 2) / dimensions.height;
    const fixed = { x: (plan.corner.endsWith('w') ? original.right : original.left) / dimensions.width,
        y: (plan.corner.startsWith('n') ? original.bottom : original.top) / dimensions.height };
    const score = box => ({ penalty: sideMismatch(px, (box.left + box.right) / (2 * dimensions.width)) +
        sideMismatch(py, (box.top + box.bottom) / (2 * dimensions.height)),
        distance: ((plan.corner.endsWith('w') ? box.right : box.left) / dimensions.width - fixed.x) ** 2 +
            ((plan.corner.startsWith('n') ? box.bottom : box.top) / dimensions.height - fixed.y) ** 2 });
    // With unit cells the normal track fit is fixed. Enumerate each displayed
    // slot independently, including the half-track translation of a short row.
    const count = layout.items.length, columns = plan.next.columns, rows = plan.next.rows;
    const tail = count % columns || columns;
    let bestPenalty = Infinity, nearest = Infinity;
    for (let index = 0; index < count; index++) {
        const row = Math.floor(index / columns), column = index % columns + (row === rows - 1 ? (columns - tail) / 2 : 0);
        const value = score(rectangle({ columns, rows }, { row, column, span: 1 }, dimensions));
        if (value.penalty < bestPenalty) { bestPenalty = value.penalty; nearest = value.distance; }
        else if (value.penalty === bestPenalty) nearest = Math.min(nearest, value.distance);
    }
    const value = score(actual);
    assert.equal(value.penalty, bestPenalty, 'shrinking to 1x1 preserves the best feasible displayed side in both axes');
    assert.ok(value.distance <= nearest + 1e-8, 'the minimum-size player uses the closest displayed normal slot');
    const areaFor = columnCount => {
        const rowCount = Math.ceil(count / columnCount);
        const cellWidth = Math.max(0, (dimensions.width - dimensions.columnGap * (columnCount - 1)) / columnCount);
        const cellHeight = Math.max(0, (dimensions.height - dimensions.rowGap * (rowCount - 1)) / rowCount);
        const videoWidth = Math.min(cellWidth, cellHeight * 16 / 9);
        return videoWidth * videoWidth * 9 / 16;
    };
    const bestArea = Math.max(...Array.from({ length: count }, (_, index) => areaFor(index + 1)));
    assert.ok(Math.abs(areaFor(columns) - bestArea) <= .011, 'return to the best normal track fit before choosing its slot');
}

test('the reported centered last-row rightward drag grows on the right instead of jumping across the pane', () => {
    const order = keys(7), key = order[6];
    const layout = freeze(G.build({ keys: order, columns: 4, focus: { key: order[0], row: 0, column: 1, span: 3 } }));
    const before = JSON.stringify(layout);
    assert.equal(L.presentation(layout).offsets.get(key), .5);
    const plan = operations.previewSize(layout, key, 2, 'ne', measure);
    assert.ok(plan.preview.left > measure.width / 2);
    assert.equal(plan.next.columns, 3); assert.equal(plan.next.rows, 4);
    assert.deepEqual(byKey(plan.next, key), { key, row: 1, column: 1, span: 2 });
    audit(layout, key, plan, measure);
    assert.equal(JSON.stringify(layout), before, 'projection and fitting never rewrite persisted integer geometry');
});

test('every centered tail position and corner preserves its shown side through replacement of an existing large player', () => {
    let checked = 0;
    const dimensions = [measure, { width: 2200, height: 250, columnGap: 8, rowGap: 6 },
        { width: 350, height: 1500, columnGap: 6, rowGap: 8 }];
    for (const column of [0, 1]) {
        const order = keys(7), layout = freeze(G.build({ keys: order, columns: 4,
            focus: { key: order[0], row: 0, column, span: 3 } })), before = JSON.stringify(layout);
        const tail = layout.items.filter(item => L.presentation(layout).offsets.get(item.key) !== 0);
        assert.equal(tail.length, 3);
        for (const item of tail) for (const corner of corners) for (const span of [2, 3, 5]) for (const size of dimensions) {
            audit(layout, item.key, operations.previewSize(layout, item.key, span, corner, size), size); checked++;
        }
        assert.equal(JSON.stringify(layout), before);
    }
    assert.equal(checked, 216);
});

test('normal incomplete rows, half tracks and negative centering offsets retain integer compact fits', () => {
    const layouts = [
        G.build({ keys: keys(7), columns: 4 }), G.build({ keys: keys(5), columns: 4 }),
        G.build({ keys: keys(8), columns: 5 }), G.build({ keys: keys(11), columns: 5 }),
        { columns: 8, rows: 4, items: [4, 6].map((column, index) => ({ key: 'negative-' + index, row: 2, column, span: 1 })) }
    ];
    let checked = 0;
    for (const source of layouts) {
        const layout = freeze(source), before = JSON.stringify(layout);
        const tail = layout.items.filter(item => L.presentation(layout).offsets.get(item.key) !== 0);
        assert.ok(tail.length > 0);
        for (const item of tail) for (const corner of corners) for (const span of [2, 4, 256]) {
            const plan = operations.previewSize(layout, item.key, span, corner, measure);
            audit(layout, item.key, plan, measure); checked++;
        }
        assert.equal(JSON.stringify(layout), before);
    }
    assert.equal(checked, 120);
});

test('raw sizing and plus or minus actions keep their original docking policy without visual drag intent', () => {
    const order = keys(9), layout = freeze(G.build({ keys: order, columns: 3 }));
    let checked = 0;
    for (const item of layout.items) for (const corner of corners) {
        assert.equal(L.presentation(layout).offsets.get(item.key), 0);
        const raw = operations.resize(layout, item.key, 2, corner);
        const fitted = operations.fitSize({ keys: visual(raw.next), focus: raw.next.items.find(value => value.span > 1),
            growthAnchor: raw.growthAnchor, preserveAnchor: raw.preserveAnchor }, { ...measure, previous: layout });
        assert.equal(Object.hasOwn(raw, 'visualAnchor'), false, 'low-level sizing has no screen-space drag intent');
        assertCompact(fitted);
        assert.equal(dockScore(fitted, item.key, raw.growthAnchor),
            maximumDockScore({ count: order.length, span: 2, docks: raw.growthAnchor }));
        checked++;
    }
    assert.equal(checked, 36);
    for (const item of layout.items) {
        const grown = operations.grow(layout, item.key);
        assert.ok(grown.growthAnchor);
        assert.equal(grown.growthAnchor.left, item.column === 0);
        assert.equal(grown.growthAnchor.right, item.column + item.span === layout.columns);
    }
});

test('a centered one-third-width tile growing downward does not jump above the pane center', () => {
    const order = keys(4), key = order[3], layout = freeze(G.build({ keys: order, columns: 3 }));
    assert.equal(byKey(L.presentation(layout), key).column, 1, 'the lone last-row tile occupies the centered third');
    for (const corner of ['sw', 'se']) {
        const plan = operations.previewSize(layout, key, 2, corner, measure);
        const actual = rectangle(plan.next, byKey(plan.next, key), measure);
        assert.ok(plan.preview.top > measure.height / 2);
        assert.ok((actual.top + actual.bottom) / 2 >= measure.height / 2 - 1e-7,
            'a downward request may refit to the middle, but must not flip to the upper half');
        audit(layout, key, plan, measure);
    }
});

test('third-, half- and quarter-width centered rows retain both visual axes through clipped growth', () => {
    let checked = 0;
    const sizes = [measure, { width: 420, height: 1200, columnGap: 6, rowGap: 8 },
        { width: 2200, height: 300, columnGap: 8, rowGap: 6 }];
    for (const [count, columns] of [[4, 3], [7, 3], [3, 2], [5, 4]]) {
        const order = keys(count), key = order[count - 1], layout = freeze(G.build({ keys: order, columns }));
        assert.ok(L.presentation(layout).offsets.get(key) !== 0);
        const before = JSON.stringify(layout);
        for (const corner of corners) for (const span of [2, 3, 8, 256]) for (const size of sizes) {
            audit(layout, key, operations.previewSize(layout, key, span, corner, size), size); checked++;
        }
        assert.equal(JSON.stringify(layout), before);
    }
    assert.equal(checked, 192);
});

test('growing, shrinking to the minimum, restoring a centered row and growing again keeps layouts valid', () => {
    let sequences = 0;
    for (const [count, columns] of [[4, 3], [7, 3], [3, 2], [5, 4]]) for (const corner of corners) {
        const order = keys(count), key = order[count - 1];
        const start = freeze(G.build({ keys: order, columns })), before = JSON.stringify(start);
        const grown = operations.previewSize(start, key, 2, corner, measure);
        audit(start, key, grown, measure);
        for (const method of ['corner', 'step']) {
            let shrunk;
            if (method === 'corner') {
                const plan = operations.previewSize(grown.next, key, 1, corner, measure);
                auditNormal(grown.next, key, plan, measure); shrunk = plan.next;
            }
            else {
                const plan = operations.shrink(grown.next, key);
                shrunk = operations.reflow({ keys: visual(plan.next), focus: null,
                    pending: { ...plan.next, intent: 'size', growthAnchor: plan.growthAnchor } }, { ...measure, previous: grown.next }).next;
            }
            assertCompact(shrunk); assert.ok(shrunk.items.every(item => item.span === 1));
            assert.equal(operations.shrink(shrunk, key).kind, 'none', 'unit size is the lower bound');
            assert.equal(operations.previewSize(shrunk, key, 1, corner, measure).kind, 'none');
            // Restore the same saved column count through the real reflow seam;
            // a prior resize may have moved a different player into the tail.
            const restored = operations.reflow({ keys: visual(shrunk), focus: null,
                pending: { intent: 'bookmark', columns } }, { ...measure, previous: shrunk }).next;
            const centered = freeze(G.build({ keys: visual(shrunk), columns: restored.columns }));
            const target = centered.items.find(item => L.presentation(centered).offsets.get(item.key) !== 0).key;
            const next = operations.previewSize(centered, target, 2, corner, measure);
            audit(centered, target, next, measure);
            const retained = operations.reflow({ keys: visual(next.next), focus: byKey(next.next, target),
                pending: { ...next.next, intent: 'drag' } }, { ...measure, width: measure.width + 5, height: measure.height + 3,
                previous: next.next }).next;
            assertCompact(retained);
            assert.deepEqual([...retained.items].sort((a, b) => a.key.localeCompare(b.key)),
                [...next.next.items].sort((a, b) => a.key.localeCompare(b.key)),
                'a small following reflow cannot move the committed enlarged anchor');
            sequences++;
        }
        assert.equal(JSON.stringify(start), before);
    }
    assert.equal(sequences, 32);
});

test('an already enlarged centered square occupying one third of the width follows all four resize corners', () => {
    let checked = 0;
    for (const [count, columns, span, row] of [[7, 6, 2, 0], [15, 9, 3, 1]]) {
        const order = keys(count), key = order[0], layout = freeze(G.build({ keys: order, columns,
            focus: { key, span, row, column: span } })), before = JSON.stringify(layout);
        assert.equal(byKey(layout, key).span / layout.columns, 1 / 3);
        assert.equal(L.presentation(layout).offsets.get(key), 0, 'a centered large square does not need a translated last row');
        for (const corner of corners) for (const target of [...new Set([2, span + 1, 8])].filter(value => value !== span)) {
            audit(layout, key, operations.previewSize(layout, key, target, corner, measure), measure); checked++;
        }
        for (const corner of corners) {
            const plan = operations.previewSize(layout, key, 1, corner, measure);
            auditNormal(layout, key, plan, measure);
            assert.deepEqual(plan.next.items.map(item => item.key).sort(), [...order].sort());
            assert.equal(operations.shrink(plan.next, key).kind, 'none');
            for (const value of Object.values(plan.preview)) assert.ok(Number.isFinite(value) && value >= 0);
        }
        assert.equal(JSON.stringify(layout), before);
    }
    assert.equal(checked, 20);
});

test('odd short rows and even controls retain every tail position through all corners and a track breakpoint', () => {
    let grownCases = 0, shrunkCases = 0, trackChanges = 0;
    const testedTails = new Set();
    // The 7-player 2x2 fit switches between three and four columns in this
    // one-pixel interval. Keep the same source grid while crossing that fit.
    const dimensions = [1754, 1755, 1756].map(width => ({ ...measure, width }));
    for (let columns = 2; columns <= 10; columns++) for (let tail = 1; tail < columns; tail++) {
        if (tail % 2 === 0 && tail !== 2 && tail !== 4) continue;
        testedTails.add(tail);
        const order = keys(columns + tail), layout = freeze(G.build({ keys: order, columns })), before = JSON.stringify(layout);
        for (const item of layout.items.filter(value => value.row === 1)) for (const corner of corners) for (const span of [2, 3]) {
            let previousColumns;
            for (const size of dimensions) {
                const plan = operations.previewSize(layout, item.key, span, corner, size);
                audit(layout, item.key, plan, size); grownCases++;
                if (previousColumns !== undefined && previousColumns !== plan.next.columns) trackChanges++;
                previousColumns = plan.next.columns;
                if (span === 2 && size === dimensions[0]) {
                    const shrunk = operations.previewSize(plan.next, item.key, 1, corner, size);
                    auditNormal(plan.next, item.key, shrunk, size); shrunkCases++;
                    assert.equal(operations.shrink(shrunk.next, item.key).kind, 'none');
                }
            }
        }
        assert.equal(JSON.stringify(layout), before);
    }
    assert.deepEqual([...testedTails].sort((a, b) => a - b), [1, 2, 3, 4, 5, 7, 9]);
    assert.equal(grownCases, 3000); assert.equal(shrunkCases, 500);
    assert.ok(trackChanges > 0, 'the one-pixel viewport probes must exercise an actual final-track change');
});
