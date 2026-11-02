'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const source = name => {
    const migrated = path.join(__dirname, '../site/assets/js', name + '.js');
    return require(fs.existsSync(migrated) ? migrated : path.join(__dirname, '..', name + '.js'));
};
const G = source('player-geometry'), L = source('player-layout');
const operations = L.createOperations({ geometry: G });
const measure = { width: 1200, height: 800, columnGap: 8, rowGap: 8 };
const keys = count => Array.from({ length: count }, (_, index) => 'heart-' + index);
const visual = layout => [...layout.items].sort((a, b) => a.row - b.row || a.column - b.column).map(item => item.key);
const freeze = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze); Object.freeze(value);
    }
    return value;
};
const grid = (count = 8, columns = 3) => freeze(G.build({ keys: keys(count), columns }));
function exchangedOrder(layout, targetKey) {
    const order = visual(layout), firstRow = Math.min(...layout.items.map(item => item.row));
    const source = layout.items.filter(item => item.row === firstRow).sort((a, b) => b.column - a.column)[0];
    const a = order.indexOf(source.key), b = order.indexOf(targetKey);
    [order[a], order[b]] = [order[b], order[a]];
    return { order, sourceKey: source.key };
}
function assertFinal(before, targetKey, plan) {
    const expected = exchangedOrder(before, targetKey), next = plan.next;
    assert.equal(plan.kind, 'promote-top-right');
    assert.equal(plan.sourceKey, expected.sourceKey);
    assert.equal(plan.targetKey, targetKey);
    assert.deepEqual(plan.keys, visual(next));
    assert.deepEqual([...plan.keys].sort(), [...visual(before)].sort(), 'every live channel appears exactly once');
    const enlarged = next.items.filter(item => item.span > 1);
    assert.equal(enlarged.length, 1);
    const focus = enlarged[0];
    assert.deepEqual(plan.focus, focus);
    assert.equal(focus.key, targetKey); assert.equal(focus.span, 2);
    assert.equal(focus.row, 0); assert.equal(focus.column + 2, next.columns);
    assert.deepEqual(visual(next).filter(key => key !== targetKey), expected.order.filter(key => key !== targetKey),
        'unrelated channels retain their order after the one in-memory exchange');
    const occupied = new Set();
    for (const item of next.items) {
        assert.ok(Number.isInteger(item.row) && item.row >= 0);
        assert.ok(Number.isInteger(item.column) && item.column >= 0);
        assert.ok(item.row + item.span <= next.rows && item.column + item.span <= next.columns);
        for (let row = item.row; row < item.row + item.span; row++) for (let column = item.column; column < item.column + item.span; column++) {
            const cell = row * next.columns + column;
            assert.ok(!occupied.has(cell), 'no two channels overlap'); occupied.add(cell);
        }
    }
    assert.equal(occupied.size, before.items.length + 3);
    for (let cell = 0; cell < occupied.size; cell++) assert.ok(occupied.has(cell), 'no interior empty cell at ' + cell);
}

test('heart promotion: pure operation is available on the frozen layout command API', () => {
    assert.equal(typeof operations.promoteTopRight, 'function');
    assert.ok(Object.isFrozen(operations));
});

test('heart promotion: each tile swaps with the original first-row final tile before one final 2x2 fit', () => {
    const before = grid(), saved = JSON.stringify(before);
    for (const key of visual(before)) assertFinal(before, key, operations.promoteTopRight(before, key, freeze({ ...measure })));
    assert.equal(JSON.stringify(before), saved, 'planning does not mutate committed cells');
});

test('heart promotion: already top-right grows in place without disturbing ordinary channel order', () => {
    const before = grid(10, 4), key = 'heart-3';
    const plan = operations.promoteTopRight(before, key, measure);
    assertFinal(before, key, plan);
    assert.equal(plan.sourceKey, key);
    assert.deepEqual(visual(plan.next).filter(value => value !== key), visual(before).filter(value => value !== key));
});

test('heart promotion: destination follows authoritative cell coordinates rather than array insertion order', () => {
    const original = grid(8, 3), before = freeze({ ...original, items: [...original.items].reverse() });
    const plan = operations.promoteTopRight(before, 'heart-7', measure);
    assertFinal(before, 'heart-7', plan);
    assert.equal(plan.sourceKey, 'heart-2', 'the original first row ends at column two');
});

test('heart promotion: one-column and two-channel grids retain explicit top and right docking', () => {
    for (const count of [2, 3, 5, 10]) for (const dimensions of [
        { width: 320, height: 900 }, { width: 900, height: 320 }, { width: 1, height: 1 }
    ]) {
        const before = grid(count, 1);
        for (const key of [keys(count)[0], keys(count).at(-1)])
            assertFinal(before, key, operations.promoteTopRight(before, key, dimensions));
    }
});

test('heart promotion: bounded grid and aspect-ratio enumeration preserves packing, occupants and top-right focus', () => {
    let checked = 0;
    for (const count of [2, 3, 4, 5, 6, 7, 10, 17, 26, 51, 128, 256]) {
        const list = keys(count);
        for (const columns of new Set([1, 2, 3, 5, Math.ceil(Math.sqrt(count)), count].filter(value => value <= count))) {
            const before = grid(count, columns);
            for (const [width, height] of [[1600, 900], [900, 1600], [1200, 900], [3200, 900], [100, 1000], [1000, 100]]) {
                for (const key of new Set([list[0], list[Math.floor(count / 2)], list.at(-1)])) {
                    assertFinal(before, key, operations.promoteTopRight(before, key, { width, height, columnGap: 8, rowGap: 8 }));
                    checked++;
                }
            }
        }
    }
    assert.ok(checked > 1000, 'a broad deterministic boundary set actually ran');
});

test('heart promotion: no-op inputs never mutate state or seed another enlarged tile', () => {
    const normal = grid(), empty = grid(0), single = grid(1, 1);
    const enlarged = freeze(G.build({ keys: keys(8), columns: 4,
        focus: { key: 'heart-0', span: 2, row: 0, column: 2 } }));
    for (const [layout, target] of [[null, 'heart-0'], [undefined, 'heart-0'], [empty, 'heart-0'],
        [single, 'heart-0'], [normal, 'removed'], [normal, ''], [normal, null],
        [enlarged, 'heart-0'], [enlarged, 'heart-7']]) {
        const saved = JSON.stringify(layout), plan = operations.promoteTopRight(layout, target, measure);
        assert.equal(plan.kind, 'none'); assert.equal(plan.next, layout);
        assert.equal(JSON.stringify(layout), saved);
    }
});

test('heart promotion: an unmeasurable or non-finite pane defers the entire command without exchanging cells', () => {
    const before = grid(), saved = JSON.stringify(before);
    for (const invalid of [undefined, null, 0, -1, NaN, Infinity, -Infinity]) for (const axis of ['width', 'height']) {
        const plan = operations.promoteTopRight(before, 'heart-7', { ...measure, [axis]: invalid });
        assert.equal(plan.kind, 'none'); assert.equal(plan.next, before);
    }
    assert.equal(operations.promoteTopRight(before, 'heart-7').kind, 'none');
    assert.equal(JSON.stringify(before), saved);
});
