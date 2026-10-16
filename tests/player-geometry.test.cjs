'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build, grow, shrink, swap, choose } = require('../player-geometry.js');

const keys = count => Array.from({ length: count }, (_, index) => `player-${index}`);
const item = (layout, key) => layout.items.find(value => value.key === key);
const occupiedArea = layout => layout.items.reduce((sum, value) => sum + value.span ** 2, 0);

function assertLayout(layout, expectedKeys) {
    assert.deepEqual([...layout.items.map(value => value.key)].sort(), [...expectedKeys].sort());
    assert.equal(new Set(layout.items.map(value => value.key)).size, expectedKeys.length);
    assert.ok(layout.items.filter(value => value.span > 1).length <= 1);
    assert.ok(layout.columns * layout.rows >= occupiedArea(layout));
    const cells = new Set();
    for (const value of layout.items) {
        assert.ok(Number.isInteger(value.row) && value.row >= 0);
        assert.ok(Number.isInteger(value.column) && value.column >= 0);
        assert.ok(Number.isInteger(value.span) && value.span >= 1);
        assert.ok(value.row + value.span <= layout.rows);
        assert.ok(value.column + value.span <= layout.columns);
        for (let row = value.row; row < value.row + value.span; row++) {
            for (let column = value.column; column < value.column + value.span; column++) {
                const cell = `${row}:${column}`;
                assert.ok(!cells.has(cell), `${value.key} overlaps cell ${cell}`);
                cells.add(cell);
            }
        }
    }
}

test('build pins one square and packs every other player into the first free cell', () => {
    const list = keys(8);
    const layout = build({ keys: list, columns: 4,
        focus: { key: list[4], span: 2, row: 0, column: 1 } });
    assert.deepEqual(item(layout, list[4]), { key: list[4], span: 2, row: 0, column: 1 });
    assert.deepEqual(item(layout, list[0]), { key: list[0], span: 1, row: 0, column: 0 });
    assert.deepEqual(item(layout, list[1]), { key: list[1], span: 1, row: 0, column: 3 });
    assert.deepEqual(item(layout, list[2]), { key: list[2], span: 1, row: 1, column: 0 });
    assertLayout(layout, list);
    assert.deepEqual(layout, build({ keys: list, columns: 4,
        focus: { key: list[4], span: 2, row: 0, column: 1 } }));
});

test('focus anchors clamp at the left and right edges and add enough rows', () => {
    const list = keys(6);
    const layout = build({ keys: list, columns: 2,
        focus: { key: list[0], span: 3, row: -10, column: 99 } });
    assert.equal(layout.columns, 3);
    assert.deepEqual(item(layout, list[0]), { key: list[0], span: 3, row: 0, column: 0 });
    assertLayout(layout, list);
    const below = build({ keys: list, columns: 4,
        focus: { key: list[0], span: 2, row: 8, column: 1 } });
    assert.equal(below.rows, 10);
    assertLayout(below, list);
});

test('growth prefers up and right, then uses down and left at the boundary', () => {
    const list = keys(16), base = build({ keys: list, columns: 4 });
    const middle = grow(base, list[5]);
    assert.deepEqual(item(middle, list[5]), { key: list[5], span: 2, row: 0, column: 1 });
    const corner = grow(base, list[3]);
    assert.deepEqual(item(corner, list[3]), { key: list[3], span: 2, row: 0, column: 2 });
    const bottomRight = grow(base, list[15]);
    assert.deepEqual(item(bottomRight, list[15]), { key: list[15], span: 2, row: 2, column: 2 });
    for (const layout of [middle, corner, bottomRight]) assertLayout(layout, list);
});

test('repeated growth adds 3, 5, 7 and 9 logical cells without losing players', () => {
    const list = keys(25);
    let layout = build({ keys: list, columns: 5 });
    const deltas = [];
    for (let step = 0; step < 4; step++) {
        const oldArea = occupiedArea(layout);
        layout = grow(layout, list[12]);
        deltas.push(occupiedArea(layout) - oldArea);
        assert.equal(layout.columns, 5);
        assertLayout(layout, list);
    }
    assert.deepEqual(deltas, [3, 5, 7, 9]);
    const wider = grow(layout, list[12]);
    assert.equal(wider.columns, 6);
    assertLayout(wider, list);
});

test('choosing another player restores the former focus to a single cell', () => {
    const list = keys(12), initial = build({ keys: list, columns: 4 });
    const grown = grow(grow(initial, list[6]), list[6]);
    const changed = grow(grown, list[9]);
    assert.equal(item(changed, list[6]).span, 1);
    assert.equal(item(changed, list[9]).span, 2);
    assertLayout(changed, list);
    assert.equal(grow(changed, 'missing'), changed);
});

test('switching focus after a column change preserves the former focus in current visual order', () => {
    const list = keys(12), formerKey = list[9], nextKey = list[8];
    const grown = grow(build({ keys: list, columns: 4 }), formerKey);
    const narrowed = build({ keys: visualKeys(grown), columns: 2,
        focus: item(grown, formerKey) });
    assert.deepEqual(visualKeys(narrowed), [0, 1, 9, 2, 3, 4, 5, 6, 7, 8, 10, 11].map(index => list[index]));
    assert.notDeepEqual(narrowed.items.map(value => value.key), visualKeys(narrowed));
    const expectedOrdinary = visualKeys(narrowed).filter(key => key !== nextKey);
    const before = JSON.stringify(narrowed), next = grow(narrowed, nextKey);
    assert.deepEqual(visualKeys(next).filter(key => key !== nextKey), expectedOrdinary);
    assert.equal(item(next, formerKey).span, 1);
    assert.equal(item(next, nextKey).span, 2);
    assert.equal(JSON.stringify(narrowed), before);
    assertLayout(next, list);
    const restored = build({ keys: visualKeys(next), columns: next.columns,
        focus: next.items.find(value => value.span > 1) });
    for (const value of next.items) assert.deepEqual(item(restored, value.key), value);
});

test('shrink releases one square ring at a time and retains its top-left anchor', () => {
    const list = keys(20), key = list[13];
    let layout = build({ keys: list, columns: 6,
        focus: { key, span: 5, row: 2, column: 1 } });
    const released = [];
    for (let span = 4; span >= 1; span--) {
        const before = JSON.stringify(layout), order = visualKeys(layout);
        const oldArea = occupiedArea(layout);
        const next = shrink(layout, key);
        released.push(oldArea - occupiedArea(next));
        assert.equal(item(next, key).span, span);
        if (span > 1) {
            assert.equal(item(next, key).row, 2);
            assert.equal(item(next, key).column, 1);
        } else assert.deepEqual(visualKeys(next), order);
        assert.equal(JSON.stringify(layout), before);
        assertLayout(next, list);
        assertFirstFreePacking(next);
        layout = next;
    }
    assert.deepEqual(released, [9, 7, 5, 3]);
    assert.equal(shrink(layout, key), layout);
    assert.equal(shrink(layout, 'missing'), layout);
    assert.equal(shrink(null, key), null);
    assert.equal(shrink(undefined, key), undefined);
});

test('shrinking a moved focus to 1x1 preserves the latest visual order', () => {
    const list = keys(15), key = list[4];
    let layout = grow(build({ keys: list, columns: 5 }), key);
    layout = swap(layout, key, list[13]);
    layout = swap(layout, list[1], list[10]);
    const before = visualKeys(layout);
    assert.notDeepEqual(before, list);
    const next = shrink(layout, key);
    assert.deepEqual(next.items.map(value => value.key), before);
    assert.deepEqual(visualKeys(next), before);
    assert.ok(next.items.every(value => value.span === 1));
    const restored = build({ keys: visualKeys(next), columns: next.columns });
    assert.deepEqual(restored, next);
    assert.equal(shrink(next, key), next);
    assertLayout(next, list);
});

test('shrink reclaims surplus columns while keeping all players and the nearest legal origin', () => {
    const list = keys(3), key = list[1];
    const layout = build({ keys: list, columns: 100,
        focus: { key, span: 8, row: 12, column: 80 } });
    const next = shrink(layout, key);
    assert.equal(next.columns, 9);
    assert.deepEqual(item(next, key), { key, span: 7, row: 12, column: 2 });
    assertLayout(next, list);
    const only = build({ keys: [key], columns: 100,
        focus: { key, span: 3, row: 0, column: 97 } });
    const smaller = shrink(only, key), ordinary = shrink(smaller, key);
    assert.equal(smaller.columns, 2);
    assert.equal(ordinary.columns, 1);
    assert.deepEqual(ordinary.items, [{ key, row: 0, column: 0, span: 1 }]);
    assertLayout(smaller, [key]);
    assertLayout(ordinary, [key]);
});

test('shrink trims entirely empty trailing columns without moving a low pinned focus', () => {
    const list = keys(2), key = list[1];
    const layout = build({ keys: list, columns: 3,
        focus: { key, span: 3, row: 98, column: 0 } });
    const next = shrink(layout, key);
    assert.equal(next.columns, 2);
    assert.equal(next.rows, 100);
    assert.deepEqual(item(next, key), { key, span: 2, row: 98, column: 0 });
    assert.deepEqual(item(next, list[0]), { key: list[0], span: 1, row: 0, column: 0 });
    const rebuilt = build({ keys: visualKeys(next), columns: next.columns,
        focus: next.items.find(value => value.span > 1) });
    assert.deepEqual(rebuilt, next);
    assertLayout(next, list);
});

test('trimmed shrink layouts restore the same visual order and positions across sparse anchors', () => {
    const random = randomGenerator(0x51a1c0de);
    let trimmed = 0;
    for (let step = 0; step < 300; step++) {
        const list = keys(1 + random(25)), key = list[random(list.length)];
        const span = 2 + random(8), columns = span + random(20);
        const layout = build({ keys: list, columns,
            focus: { key, span, row: random(100), column: random(columns - span + 1) } });
        const before = JSON.stringify(layout), next = shrink(layout, key);
        const untrimmed = build({ keys: visualKeys(layout),
            columns: Math.min(columns, span - 1 + list.length - 1),
            focus: span > 2 ? { ...item(layout, key), span: span - 1 } : null });
        if (next.columns < untrimmed.columns) trimmed++;
        for (const value of next.items) assert.deepEqual(value, item(untrimmed, value.key),
            'trimming trailing columns must retain every item coordinate');
        const rebuilt = build({ keys: visualKeys(next), columns: next.columns,
            focus: next.items.find(value => value.span > 1) });
        assert.deepEqual(visualKeys(rebuilt), visualKeys(next));
        for (const value of next.items) assert.deepEqual(item(rebuilt, value.key), value);
        assert.equal(next.columns, next.items.reduce((maximum, value) => Math.max(maximum,
            value.column + value.span), 1));
        assert.equal(JSON.stringify(layout), before);
        assertLayout(next, list);
        assertFirstFreePacking(next);
    }
    assert.ok(trimmed > 0, 'the deterministic cases must exercise actual trailing-column trimming');
});

test('ordinary swaps exchange exact cells while keeping the enlarged focus pinned', () => {
    const list = keys(12), layout = grow(build({ keys: list, columns: 4 }), list[5]);
    const changed = swap(layout, list[1], list[10]);
    const source = item(layout, list[1]), target = item(layout, list[10]);
    assert.deepEqual(item(changed, list[1]), { ...target, key: list[1] });
    assert.deepEqual(item(changed, list[10]), { ...source, key: list[10] });
    assert.deepEqual(item(changed, list[5]), item(layout, list[5]));
    assertLayout(changed, list);
    assert.equal(swap(layout, list[1], list[1]), layout);
    assert.equal(swap(layout, list[1], 'missing'), layout);
});

test('moving the enlarged player uses the destination origin and safely reflows neighbors', () => {
    const list = keys(12), layout = grow(build({ keys: list, columns: 4 }), list[5]);
    for (const [source, target] of [[list[5], list[11]], [list[11], list[5]]]) {
        const changed = swap(layout, source, target);
        const destination = item(layout, list[11]);
        assert.equal(item(changed, list[5]).row, destination.row);
        assert.equal(item(changed, list[5]).column, Math.min(destination.column, layout.columns - 2));
        assert.equal(item(changed, list[5]).span, 2);
        assertLayout(changed, list);
    }
});

test('adaptive columns score contained base video area and preserve the focus anchor', () => {
    const list = keys(15), focus = { key: list[8], span: 3, row: 1, column: 2 };
    for (const [width, height] of [[1920, 900], [900, 900], [380, 700], [260, 8]]) {
        const chosen = choose({ keys: list, focus, width, height, columnGap: 10, rowGap: 10, force: true });
        assertLayout(chosen, list);
        assert.equal(item(chosen, focus.key).row, focus.row);
        assert.equal(item(chosen, focus.key).column, Math.min(focus.column, chosen.columns - focus.span));
        assert.ok(Number.isFinite(chosen.area) && chosen.area >= 0);
        for (let columns = focus.span; columns <= focus.span + list.length - 1; columns++) {
            const candidate = build({ keys: list, focus, columns });
            const cellWidth = Math.max(0, (width - 10 * (columns - 1)) / columns);
            const cellHeight = Math.max(0, (height - 10 * (candidate.rows - 1)) / candidate.rows);
            const videoWidth = Math.min(cellWidth, cellHeight * 16 / 9);
            assert.ok(chosen.area + .011 >= videoWidth ** 2 / (16 / 9));
        }
    }
});

test('hysteresis retains near-equivalent columns and hidden panes retain their previous columns', () => {
    const list = keys(6), options = { keys: list, columnGap: 10, rowGap: 10 };
    const previous = choose({ ...options, width: 1200, height: 700 });
    const stable = choose({ ...options, width: 1250, height: 700, previous });
    const raw = choose({ ...options, width: 1250, height: 700, force: true });
    assert.equal(stable.columns, previous.columns);
    assert.notEqual(raw.columns, previous.columns);
    assert.ok(raw.area <= stable.area * 1.06);
    const hidden = choose({ ...options, width: 0, height: 900, previous });
    assert.equal(hidden.columns, previous.columns);
    assert.equal(hidden.area, 0);
    assertLayout(hidden, list);
    assert.deepEqual(choose(), { columns: 1, rows: 1, items: [], area: 0 });
});

test('large counts, narrow grids and repeated moves always retain a collision-free square', () => {
    for (const count of [1, 2, 5, 20, 100]) {
        const list = keys(count);
        for (const columns of [1, 2, 5, 12]) {
            let layout = build({ keys: list, columns });
            for (let span = 2; span <= 9; span++) {
                layout = grow(layout, list[Math.floor(count / 2)]);
                assertLayout(layout, list);
            }
            if (count > 1) {
                layout = swap(layout, list[Math.floor(count / 2)], list[0]);
                assertLayout(layout, list);
            }
        }
    }
});

function randomGenerator(seed) {
    let state = seed >>> 0;
    return maximum => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return Math.floor(state / 0x100000000 * maximum);
    };
}

function visualKeys(layout) {
    return [...layout.items].sort((a, b) => a.row - b.row || a.column - b.column).map(value => value.key);
}

function assertFirstFreePacking(layout) {
    const focus = layout.items.find(value => value.span > 1);
    // Independent oracle: enumerate the available cells and compare their order.
    const free = [];
    for (let row = 0; row < layout.rows; row++) {
        for (let column = 0; column < layout.columns; column++) {
            if (!focus || row < focus.row || row >= focus.row + focus.span ||
                column < focus.column || column >= focus.column + focus.span) free.push({ row, column });
        }
    }
    const ordinary = layout.items.filter(value => value.span === 1);
    ordinary.forEach((value, index) => {
        assert.deepEqual({ row: value.row, column: value.column }, free[index]);
    });
    assert.equal(layout.rows, Math.max(1, Math.ceil(occupiedArea(layout) / layout.columns),
        focus ? focus.row + focus.span : 0));
}

function measuredArea(layout, width, height, columnGap, rowGap) {
    const cellWidth = Math.max(0, (width - columnGap * (layout.columns - 1)) / layout.columns);
    const cellHeight = Math.max(0, (height - rowGap * (layout.rows - 1)) / layout.rows);
    return Math.min(cellWidth, cellHeight * 16 / 9) ** 2 / (16 / 9);
}

test('seeded grow, shrink, swap, selection and resize sequences stay collision-free and preserve their inputs', () => {
    let operations = 0;
    for (const seed of [1, 0x12345678, 0xabcdef01, 20261016, 0xffffffff]) {
        const random = randomGenerator(seed);
        let nextKey = 24, list = keys(nextKey);
        let layout = build({ keys: list, columns: 5 });
        for (let step = 0; step < 200; step++) {
            const before = JSON.stringify(layout);
            const operation = random(6);
            let next;
            if (operation === 0 && list.length) {
                const key = list[random(list.length)], current = item(layout, key);
                const oldFocus = layout.items.find(value => value.span > 1);
                next = grow(layout, key);
                const enlarged = item(next, key);
                assert.deepEqual(visualKeys(next).filter(value => value !== key),
                    visualKeys(layout).filter(value => value !== key),
                    'growing or switching focus must retain every other player in its current relative order');
                assert.equal(enlarged.span, current.span + 1);
                assert.equal(enlarged.row, Math.max(0, current.row - 1));
                assert.equal(enlarged.column, Math.min(next.columns - enlarged.span,
                    current.column + enlarged.span <= next.columns ? current.column : Math.max(0, current.column - 1)));
                assert.equal(occupiedArea(next), list.length + enlarged.span ** 2 - 1);
                if (oldFocus && oldFocus.key !== key) assert.equal(item(next, oldFocus.key).span, 1);
            } else if (operation === 1 && list.length > 1) {
                const source = list[random(list.length)];
                let target = list[random(list.length)];
                if (source === target) target = list[(list.indexOf(source) + 1) % list.length];
                const sourceItem = item(layout, source), targetItem = item(layout, target);
                next = swap(layout, source, target);
                if (sourceItem.span === 1 && targetItem.span === 1) {
                    assert.deepEqual(item(next, source), { ...targetItem, key: source });
                    assert.deepEqual(item(next, target), { ...sourceItem, key: target });
                } else {
                    const focus = sourceItem.span > 1 ? sourceItem : targetItem;
                    const destination = sourceItem.span > 1 ? targetItem : sourceItem;
                    assert.deepEqual(item(next, focus.key), { ...focus, row: destination.row,
                        column: Math.min(destination.column, next.columns - focus.span) });
                }
            } else if (operation === 2) {
                // Remove the focus sometimes, return to zero players, then add new keys.
                const nextKeys = list.filter(() => random(4) !== 0);
                for (let add = random(4); add > 0; add--) nextKeys.push(`player-${nextKey++}`);
                next = build({ keys: nextKeys, columns: 1 + random(15),
                    focus: layout.items.find(value => value.span > 1) });
                list = nextKeys;
            } else if (operation === 3) {
                const width = [0, 1, 8, 260, 380, 900, 1920][random(7)];
                const height = [0, 1, 8, 260, 700, 900, 1200][random(7)];
                const gap = random(3) * .625;
                next = choose({ keys: list, width, height, columnGap: gap, rowGap: gap,
                    previous: layout, focus: layout.items.find(value => value.span > 1), force: true });
                assert.ok(Number.isFinite(next.area) && next.area >= 0);
                if (width > 0 && height > 0 && list.length) {
                    assert.ok(Math.abs(next.area - measuredArea(next, width, height, gap, gap)) < .001);
                    const span = next.items.find(value => value.span > 1)?.span || 1;
                    for (let columns = span; columns <= span + list.length - 1; columns++) {
                        const candidate = build({ keys: list, columns,
                            focus: layout.items.find(value => value.span > 1) });
                        assert.ok(next.area + .011 >= measuredArea(candidate, width, height, gap, gap));
                    }
                }
            } else if (operation === 4 && list.length) {
                const currentFocus = layout.items.find(value => value.span > 1);
                const key = currentFocus && random(4) > 0 ? currentFocus.key : list[random(list.length)];
                const current = item(layout, key), order = visualKeys(layout);
                next = shrink(layout, key);
                if (current.span === 1) assert.equal(next, layout);
                else {
                    const span = current.span - 1;
                    assert.equal(item(next, key).span, span);
                    assert.ok(next.columns <= Math.min(layout.columns, span + list.length - 1));
                    assert.equal(next.columns, next.items.reduce((maximum, value) => Math.max(maximum,
                        value.column + value.span), 1));
                    assert.equal(occupiedArea(next), list.length + span ** 2 - 1);
                    assert.deepEqual(next.items.map(value => value.key), order);
                    if (span > 1) {
                        assert.equal(item(next, key).row, current.row);
                        assert.equal(item(next, key).column, Math.min(current.column, next.columns - span));
                    } else assert.deepEqual(visualKeys(next), order);
                }
            } else {
                next = build({ keys: visualKeys(layout), columns: layout.columns,
                    focus: layout.items.find(value => value.span > 1) });
                for (const value of layout.items) assert.deepEqual(item(next, value.key), value,
                    'saving visual order and restoring it must retain the same cell');
            }
            assert.equal(JSON.stringify(layout), before, `seed ${seed}, step ${step} mutated its input`);
            layout = next;
            assertLayout(layout, list);
            assertFirstFreePacking(layout);
            operations++;
        }
    }
    assert.equal(operations, 1000);
});

test('app-style visual order swaps retain exact ordinary destinations after focus moves and resizes', () => {
    const list = keys(30), random = randomGenerator(0xc0ffee);
    let layout = grow(build({ keys: list, columns: 6 }), list[14]);
    for (let step = 0; step < 120; step++) {
        const ordinary = layout.items.filter(value => value.span === 1);
        const source = ordinary[random(ordinary.length)];
        let target = ordinary[random(ordinary.length)];
        if (source.key === target.key) target = ordinary[(ordinary.indexOf(source) + 1) % ordinary.length];
        const order = visualKeys(layout), sourceIndex = order.indexOf(source.key), targetIndex = order.indexOf(target.key);
        [order[sourceIndex], order[targetIndex]] = [order[targetIndex], order[sourceIndex]];
        const pending = swap(layout, source.key, target.key);
        const rebuilt = build({ keys: order, columns: pending.columns,
            focus: pending.items.find(value => value.span > 1) });
        assert.deepEqual(item(rebuilt, source.key), { ...target, key: source.key });
        assert.deepEqual(item(rebuilt, target.key), { ...source, key: target.key });
        assertLayout(rebuilt, list);
        layout = choose({ keys: visualKeys(rebuilt), width: [380, 900, 1920][random(3)],
            height: [700, 900, 1200][random(3)], previous: rebuilt,
            focus: rebuilt.items.find(value => value.span > 1) });
        const focus = layout.items.find(value => value.span > 1);
        layout = swap(layout, focus.key, ordinary[random(ordinary.length)].key);
        if (step % 12 === 0) layout = grow(layout, list[random(list.length)]);
        assertLayout(layout, list);
    }
});

test('focus removal, duplicate keys and malformed numeric geometry normalize safely', () => {
    const list = keys(4);
    const focus = { key: list[2], span: 3, row: 2, column: 1 };
    const removed = build({ keys: [list[0], list[0], list[1]], columns: 0, focus });
    assertLayout(removed, list.slice(0, 2));
    assert.ok(removed.items.every(value => value.span === 1));
    const normalized = build({ keys: list, columns: NaN,
        focus: { key: list[1], span: 2.9, row: -5.1, column: Infinity } });
    assert.deepEqual(item(normalized, list[1]), { key: list[1], span: 2, row: 0, column: 0 });
    assertLayout(normalized, list);
    const hidden = choose({ keys: list, width: Infinity, height: NaN, columnGap: -100,
        rowGap: Infinity, previous: { columns: -1 }, focus });
    assert.equal(hidden.area, 0);
    assertLayout(hidden, list);
});
