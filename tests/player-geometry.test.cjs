'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build, grow, shrink, resize, swap, neighbor, neighbors, step, choose } = require('../player-geometry.js');

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

test('neighbors follow all four touching edges and never wrap an incomplete last row', () => {
    const list = keys(8), layout = build({ keys: list, columns: 3 });
    for (const [direction, target] of [['up', 1], ['down', 7], ['left', 3], ['right', 5]]) {
        assert.equal(neighbor(layout, list[4], direction), item(layout, list[target]));
        assert.deepEqual(neighbors(layout, list[4], direction), [item(layout, list[target])]);
    }
    assert.equal(neighbor(layout, list[0], 'up'), null);
    assert.equal(neighbor(layout, list[0], 'left'), null);
    assert.equal(neighbor(layout, list[2], 'right'), null);
    assert.equal(neighbor(layout, list[7], 'right'), null, 'empty final cell is not a target');
    assert.deepEqual(neighbors(layout, list[7], 'right'), []);
    assert.equal(neighbor(layout, list[5], 'down'), null, 'do not choose a diagonal final-row player');
    assert.deepEqual(neighbors(layout, list[5], 'down'), []);
    assert.equal(neighbor(layout, list[7], 'down'), null);
    assert.equal(neighbor(build({ keys: ['only'], columns: 1 }), 'only', 'down'), null);
});

test('a direction requires a shared edge, excluding gaps and corner-only contact', () => {
    const source = { key: 'source', row: 2, column: 2, span: 1 };
    const layout = { items: [source,
        { key: 'top-corner', row: 1, column: 1, span: 1 },
        { key: 'bottom-corner', row: 3, column: 3, span: 1 },
        { key: 'top-gap', row: 0, column: 2, span: 1 },
        { key: 'bottom-gap', row: 4, column: 2, span: 1 },
        { key: 'left-gap', row: 2, column: 0, span: 1 },
        { key: 'right-gap', row: 2, column: 4, span: 1 }
    ] };
    for (const direction of ['up', 'down', 'left', 'right']) {
        assert.equal(neighbor(layout, source.key, direction), null, direction);
        assert.deepEqual(neighbors(layout, source.key, direction), [], direction);
    }
});

test('an enlarged player picks the neighbor nearest the middle of each shared side', () => {
    const source = { key: 'focus', row: 1, column: 1, span: 3 };
    const items = [source];
    for (let offset = 1; offset <= 3; offset++) {
        items.push({ key: `up-${offset}`, row: 0, column: offset, span: 1 },
            { key: `down-${offset}`, row: 4, column: offset, span: 1 },
            { key: `left-${offset}`, row: offset, column: 0, span: 1 },
            { key: `right-${offset}`, row: offset, column: 4, span: 1 });
    }
    for (const direction of ['up', 'down', 'left', 'right']) {
        assert.equal(neighbor({ items }, 'focus', direction), items.find(value => value.key === `${direction}-2`));
        const expected = [1, 2, 3].map(offset => items.find(value => value.key === `${direction}-${offset}`));
        assert.deepEqual(neighbors({ items }, 'focus', direction), expected, 'every touching player has its own target');
        assert.deepEqual(neighbors({ items: [...items].reverse() }, 'focus', direction), expected);
    }
    assert.equal(neighbor({ items }, 'left-2', 'right'), source, 'an ordinary player also finds the large touching neighbor');
    assert.deepEqual(neighbors({ items }, 'left-2', 'right'), [source]);
});

test('neighbor ties use row then column regardless of item insertion order', () => {
    const source = { key: 'focus', row: 1, column: 1, span: 2 };
    const items = [source,
        { key: 'up-right', row: 0, column: 2, span: 1 },
        { key: 'up-left', row: 0, column: 1, span: 1 },
        { key: 'right-bottom', row: 2, column: 3, span: 1 },
        { key: 'right-top', row: 1, column: 3, span: 1 }
    ];
    for (let offset = 0; offset < items.length; offset++) {
        const rotated = items.slice(offset).concat(items.slice(0, offset));
        for (const ordered of [rotated, [...rotated].reverse()]) {
            assert.equal(neighbor({ items: ordered }, 'focus', 'up').key, 'up-left');
            assert.equal(neighbor({ items: ordered }, 'focus', 'right').key, 'right-top');
            assert.deepEqual(neighbors({ items: ordered }, 'focus', 'up').map(value => value.key), ['up-left', 'up-right']);
            assert.deepEqual(neighbors({ items: ordered }, 'focus', 'right').map(value => value.key), ['right-top', 'right-bottom']);
        }
    }
    const samePosition = { items: [source,
        { key: 'z', row: 0, column: 1, span: 1 }, { key: 'a', row: 0, column: 1, span: 1 }
    ] };
    assert.equal(neighbor(samePosition, 'focus', 'up').key, 'a', 'key provides the final deterministic tie-break');
    assert.equal(neighbor({ items: [...samePosition.items].reverse() }, 'focus', 'up').key, 'a');
    assert.deepEqual(neighbors(samePosition, 'focus', 'up').map(value => value.key), ['a', 'z']);
});

test('neighbor distance uses the shared segment midpoint instead of the whole target midpoint', () => {
    const layout = { items: [
        { key: 'source', row: 3, column: 3, span: 4 },
        { key: 'large-left', row: 0, column: 1, span: 3 },
        { key: 'small-right', row: 2, column: 6, span: 1 }
    ] };
    // The two shared segments are equally far from the source midpoint;
    // whole-target centers would incorrectly prefer the small right target.
    assert.equal(neighbor(layout, 'source', 'up').key, 'large-left');
});

test('all neighbors include partial shared edges without including corner contact or nearby gaps', () => {
    const layout = { items: [
        { key: 'source', row: 3, column: 3, span: 2 },
        { key: 'up-right', row: 2, column: 4, span: 1 },
        { key: 'up-left-large', row: 0, column: 1, span: 3 },
        { key: 'up-corner', row: 2, column: 5, span: 1 },
        { key: 'up-gap', row: 0, column: 3, span: 1 },
        { key: 'left-bottom', row: 4, column: 2, span: 1 },
        { key: 'left-top-large', row: 1, column: 0, span: 3 },
        { key: 'right-large', row: 2, column: 5, span: 3 },
        { key: 'down-large', row: 5, column: 2, span: 3 }
    ] };
    assert.deepEqual(neighbors(layout, 'source', 'up').map(value => value.key), ['up-left-large', 'up-right']);
    assert.deepEqual(neighbors(layout, 'source', 'left').map(value => value.key), ['left-top-large', 'left-bottom']);
    assert.deepEqual(neighbors(layout, 'source', 'right').map(value => value.key), ['right-large']);
    assert.deepEqual(neighbors(layout, 'source', 'down').map(value => value.key), ['down-large']);
});

test('neighbor rejects invalid inputs and leaves the geometry and item identities intact', () => {
    const layout = build({ keys: keys(4), columns: 2 });
    const before = JSON.stringify(layout);
    layout.items.forEach(Object.freeze);
    Object.freeze(layout.items);
    Object.freeze(layout);
    assert.equal(neighbor(layout, 'player-0', 'right'), layout.items[1]);
    for (const direction of [undefined, null, '', 'diagonal', 'ArrowRight', 'constructor', '__proto__']) {
        assert.equal(neighbor(layout, 'player-0', direction), null);
        assert.deepEqual(neighbors(layout, 'player-0', direction), []);
    }
    assert.equal(neighbor(layout, 'missing', 'up'), null);
    assert.equal(neighbor(null, 'player-0', 'up'), null);
    assert.equal(neighbor({ items: {} }, 'player-0', 'up'), null);
    assert.equal(neighbor({ items: [null, { key: 'bad', row: 0, column: 0, span: 0 }] }, 'bad', 'right'), null);
    assert.deepEqual(neighbors(layout, 'missing', 'up'), []);
    assert.deepEqual(neighbors(null, 'player-0', 'up'), []);
    assert.deepEqual(neighbors({ items: {} }, 'player-0', 'up'), []);
    assert.deepEqual(neighbors({ items: [null, { key: 'bad', row: 0, column: 0, span: 0 }] }, 'bad', 'right'), []);
    const touching = neighbors(layout, 'player-0', 'right');
    assert.equal(touching[0], layout.items[1]);
    touching.pop();
    assert.equal(neighbors(layout, 'player-0', 'right')[0], layout.items[1], 'results are fresh arrays, not the layout items array');
    assert.equal(JSON.stringify(layout), before);
});

test('directional focus steps move one base cell and exchange only the full entering and freed strips', () => {
    const list = keys(17), focusKey = list[0];
    const layout = build({ keys: list, columns: 5,
        focus: { key: focusKey, row: 1, column: 1, span: 3 } });
    assert.equal(layout.rows, 5);
    const directions = { up: ['row', -1, 'down'], down: ['row', 1, 'up'],
        left: ['column', -1, 'right'], right: ['column', 1, 'left'] };
    for (const [direction, [axis, delta, reverse]] of Object.entries(directions)) {
        const focus = item(layout, focusKey), expectedFocus = { ...focus, [axis]: focus[axis] + delta };
        const targets = neighbors(layout, focusKey, direction);
        assert.equal(targets.length, 3);
        const next = step(layout, focusKey, direction, targets[0].key);
        assert.deepEqual(item(next, focusKey), expectedFocus);
        assert.equal(next.columns, layout.columns);
        assert.equal(next.rows, layout.rows);
        for (const current of layout.items.filter(value => value.key !== focusKey)) {
            const entering = current.row >= expectedFocus.row && current.row < expectedFocus.row + expectedFocus.span &&
                current.column >= expectedFocus.column && current.column < expectedFocus.column + expectedFocus.span;
            const expected = entering ? { ...current, [axis]: current[axis] - delta * focus.span } : current;
            assert.deepEqual(item(next, current.key), expected, `${direction}: ${current.key}`);
        }
        for (const target of targets) {
            assert.deepEqual(step(layout, focusKey, direction, target.key), next,
                'each segment on the same side moves the focus by the same one-cell amount');
            assert.deepEqual(step(layout, target.key, reverse, focusKey), next,
                'a small tile pointing at the focus moves the focus towards the small tile');
        }
        const restored = step(next, focusKey, reverse);
        for (const current of layout.items) assert.deepEqual(item(restored, current.key), current);
        assertLayout(next, list);
        assertFirstFreePacking(next);
    }
});

test('ordinary directional swaps keep all other cells and the enlarged focus fixed', () => {
    const list = keys(17), layout = build({ keys: list, columns: 5,
        focus: { key: list[0], row: 1, column: 1, span: 3 } });
    const source = layout.items.find(value => value.row === 0 && value.column === 1);
    const target = layout.items.find(value => value.row === 0 && value.column === 2);
    const next = step(layout, source.key, 'right', target.key);
    for (const current of layout.items) {
        const expected = current.key === source.key ? { ...target, key: source.key } :
            current.key === target.key ? { ...source, key: target.key } : current;
        assert.deepEqual(item(next, current.key), expected);
    }
    const normal = build({ keys: keys(8), columns: 3 });
    const normalNext = step(normal, 'player-4', 'right');
    assert.deepEqual(item(normalNext, 'player-4'), { ...item(normal, 'player-5'), key: 'player-4' });
    assert.deepEqual(item(normalNext, 'player-5'), { ...item(normal, 'player-4'), key: 'player-5' });
});

test('partial-tail focus steps stay one cell, inside existing tracks and canonically packed', () => {
    let exercised = 0, trimmed = 0;
    for (const columns of [3, 4, 5, 6]) for (const span of [2, 3]) {
        if (span > columns) continue;
        for (const count of [5, 8, 13, 17]) for (const row of [0, 1, 3]) {
            const list = keys(count), layout = build({ keys: list, columns,
                focus: { key: list[0], row, column: columns - span, span } });
            const focus = item(layout, list[0]);
            for (const [direction, axis, delta, reverse] of [['up', 'row', -1, 'down'], ['down', 'row', 1, 'up'],
                ['left', 'column', -1, 'right'], ['right', 'column', 1, 'left']]) {
                const targets = neighbors(layout, focus.key, direction);
                if (!targets.length) continue;
                const next = step(layout, focus.key, direction, targets[0].key);
                const expected = { ...focus, [axis]: focus[axis] + delta };
                const within = expected.row >= 0 && expected.column >= 0 && expected.row + span <= layout.rows &&
                    expected.column + span <= layout.columns;
                if (!within) { assert.equal(next, layout); continue; }
                assert.notEqual(next, layout);
                assert.deepEqual(item(next, focus.key), expected);
                assert.equal(next.columns, layout.columns);
                assert.ok(next.rows <= layout.rows, 'do not create a new row to finish an arrow move');
                for (const target of targets) assert.deepEqual(step(layout, target.key, reverse, focus.key), next);
                assertLayout(next, list);
                assertFirstFreePacking(next);
                const restored = build({ keys: visualKeys(next), columns: next.columns, focus: item(next, focus.key) });
                for (const current of next.items) assert.deepEqual(item(restored, current.key), current);
                if (next.rows < layout.rows) trimmed++;
                exercised++;
            }
        }
    }
    assert.ok(exercised > 100);
    assert.ok(trimmed > 0, 'moving a low focus up may reclaim an empty final row');
});

test('partial-tail steps pin unaffected tiles before filling freed-strip holes', () => {
    const layout = build({ keys: ['p0', 'p1', 'p2', 'p3'], columns: 3,
        focus: { key: 'p0', row: 0, column: 0, span: 2 } });
    assert.deepEqual(item(layout, 'p1'), { key: 'p1', row: 0, column: 2, span: 1 });
    assert.deepEqual(item(layout, 'p2'), { key: 'p2', row: 1, column: 2, span: 1 });
    assert.deepEqual(item(layout, 'p3'), { key: 'p3', row: 2, column: 0, span: 1 });
    const next = step(layout, 'p0', 'down', 'p3');
    assert.deepEqual(item(next, 'p0'), { key: 'p0', row: 1, column: 0, span: 2 });
    assert.deepEqual(item(next, 'p1'), item(layout, 'p1'), 'a representable unaffected tile must remain at its exact location');
    assert.deepEqual(item(next, 'p3'), { key: 'p3', row: 0, column: 0, span: 1 });
    assert.deepEqual(item(next, 'p2'), { key: 'p2', row: 0, column: 1, span: 1 },
        'only the tile outside the canonical slot set needs to fill the remaining hole');
    const reverse = step(next, 'p0', 'up', 'p3');
    for (const current of layout.items) assert.deepEqual(item(reverse, current.key), current);
    assertLayout(next, layout.items.map(value => value.key));
    assertFirstFreePacking(next);
});

test('seeded focus steps preserve every representable unaffected tile before packing remaining tiles', () => {
    const random = randomGenerator(0x51e9f0c5), directions = [
        ['up', 'row', -1], ['down', 'row', 1], ['left', 'column', -1], ['right', 'column', 1]
    ];
    let exercised = 0, pinned = 0, displaced = 0;
    for (let sample = 0; sample < 400; sample++) {
        const columns = 2 + random(8), span = 2 + random(Math.min(4, columns) - 1);
        const list = keys(2 + random(70)), layout = build({ keys: list, columns,
            focus: { key: list[0], row: random(6), column: random(columns - span + 1), span } });
        const focus = item(layout, list[0]), before = JSON.stringify(layout);
        for (const [direction, axis, delta] of directions) {
            const targets = neighbors(layout, focus.key, direction);
            if (!targets.length) continue;
            const expectedFocus = { ...focus, [axis]: focus[axis] + delta };
            if (expectedFocus.row < 0 || expectedFocus.column < 0 || expectedFocus.row + span > layout.rows ||
                expectedFocus.column + span > layout.columns) continue;
            const next = step(layout, focus.key, direction, targets[random(targets.length)].key);
            const slotSet = new Set(build({ keys: list, columns, focus: expectedFocus }).items
                .filter(value => value.span === 1).map(value => `${value.row}:${value.column}`));
            for (const current of layout.items.filter(value => value.span === 1)) {
                const entering = current.row >= expectedFocus.row && current.row < expectedFocus.row + span &&
                    current.column >= expectedFocus.column && current.column < expectedFocus.column + span;
                if (entering) { displaced++; continue; }
                if (slotSet.has(`${current.row}:${current.column}`)) {
                    assert.deepEqual(item(next, current.key), current, `${sample}/${direction}: ${current.key} can stay pinned`);
                    pinned++;
                }
            }
            assert.deepEqual(item(next, focus.key), expectedFocus);
            assert.equal(next.columns, columns);
            assert.ok(next.rows <= layout.rows);
            assertLayout(next, list);
            assertFirstFreePacking(next);
            const restored = build({ keys: visualKeys(next), columns, focus: expectedFocus });
            for (const current of next.items) assert.deepEqual(item(restored, current.key), current);
            assert.equal(JSON.stringify(layout), before);
            exercised++;
        }
    }
    assert.ok(exercised > 500);
    assert.ok(pinned > 5000);
    assert.ok(displaced > 1000);
});

test('directional steps validate actual targets, respect focus boundaries, and never mutate frozen input', () => {
    const list = keys(8), layout = build({ keys: list, columns: 4,
        focus: { key: list[0], row: 1, column: 2, span: 2 } });
    const before = JSON.stringify(layout);
    layout.items.forEach(Object.freeze);
    Object.freeze(layout.items);
    Object.freeze(layout);
    assert.equal(step(layout, list[0], 'right'), layout);
    assert.equal(step(layout, list[0], 'down'), layout);
    assert.equal(step(layout, list[0], 'up', 'missing'), layout);
    assert.equal(step(layout, list[0], 'up', list[0]), layout);
    assert.equal(step(layout, list[0], 'up', neighbors(layout, list[0], 'left')[0].key), layout,
        'a real neighboring key on the wrong side is still invalid');
    assert.equal(step(layout, 'missing', 'up'), layout);
    assert.equal(step(layout, list[0], 'diagonal'), layout);
    assert.equal(step(null, list[0], 'up'), null);
    assert.equal(step(undefined, list[0], 'up'), undefined);
    const next = step(layout, list[0], 'up');
    assert.deepEqual(item(next, list[0]), { ...item(layout, list[0]), row: 0 });
    assert.equal(JSON.stringify(layout), before);
    const leftEdge = build({ keys: list, columns: 4, focus: { key: list[0], row: 0, column: 0, span: 2 } });
    assert.equal(step(leftEdge, list[0], 'left'), leftEdge);
    assert.equal(step(leftEdge, list[0], 'up'), leftEdge);
    const smallAtFocusBottom = layout.items.find(value => value.row === 0 && value.column === 2);
    assert.deepEqual(step(layout, smallAtFocusBottom.key, 'down', list[0]), next);
});

test('repeated directional circuits keep one-cell focus steps and direct reversal restores every tile', () => {
    const list = keys(28), focusKey = list[0];
    const initial = build({ keys: list, columns: 6,
        focus: { key: focusKey, row: 1, column: 1, span: 3 } });
    assert.equal(initial.rows, 6);
    let layout = initial;
    for (let cycle = 0; cycle < 30; cycle++) {
        for (const direction of ['right', 'right', 'down', 'down', 'left', 'left', 'up', 'up']) {
            const before = item(layout, focusKey), next = step(layout, focusKey, direction);
            assert.notEqual(next, layout);
            const after = item(next, focusKey);
            assert.equal(Math.abs(after.row - before.row) + Math.abs(after.column - before.column), 1);
            assertLayout(next, list);
            assertFirstFreePacking(next);
            layout = next;
        }
        assert.deepEqual(item(layout, focusKey), item(initial, focusKey));
    }
    // A direct step followed by its reverse restores every ordinary tile;
    // a longer circuit can intentionally rotate the small tiles around it.
    const moved = step(layout, focusKey, 'right'), reversed = step(moved, focusKey, 'left');
    for (const current of layout.items) assert.deepEqual(item(reversed, current.key), current);
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

test('a six-player corner enlargement optimizes to three columns without shifting its logical anchor', () => {
    const list = keys(6), before = build({ keys: list, columns: 2 });
    const resized = resize(before, list[0], 2, 'se');
    assert.equal(resized.columns, 2);
    assert.equal(resized.rows, 5);
    const focus = item(resized, list[0]);
    const fitted = choose({ keys: visualKeys(resized), width: 930, height: 601,
        columnGap: 10, rowGap: 10, focus, force: true, preserveAnchor: true });
    assert.equal(fitted.columns, 3);
    assert.equal(fitted.rows, 3);
    assert.deepEqual(item(fitted, focus.key), focus);
    assert.ok(fitted.area > measuredArea(resized, 930, 601, 10, 10));
    assertLayout(fitted, list);
});

test('anchor-preserving optimization never clamps the focus column, including hidden and sparse grids', () => {
    const list = keys(12), focus = { key: list[7], span: 3, row: 2, column: 4 };
    const savedFocus = JSON.stringify(focus);
    for (const [width, height] of [[380, 900], [1920, 500], [0, 900]]) {
        const fitted = choose({ keys: list, width, height, columnGap: 10, rowGap: 10,
            focus, force: true, preserveAnchor: true, previous: { columns: 3 } });
        assert.ok(fitted.columns >= 7);
        assert.deepEqual(item(fitted, focus.key), focus);
        assertLayout(fitted, list);
        if (width > 0) {
            for (let columns = 7; columns <= 14; columns++) {
                const candidate = build({ keys: list, columns, focus });
                assert.ok(fitted.area + .011 >= measuredArea(candidate, width, height, 10, 10));
            }
        }
    }
    const normal = choose({ keys: list, width: 380, height: 900, focus, force: true });
    assert.ok(item(normal, focus.key).column < focus.column, 'legacy optimization may still clamp its anchor');
    const sparse = { key: list[0], span: 4, row: 3, column: 512 };
    const fitted = choose({ keys: list, width: 930, height: 601, focus: sparse,
        force: true, preserveAnchor: true });
    assert.equal(fitted.columns, 516);
    assert.deepEqual(item(fitted, sparse.key), sparse);
    assertLayout(fitted, list);
    assert.equal(JSON.stringify(focus), savedFocus);
});

test('anchor-preserving optimization uses the square area rather than the minimum column count', () => {
    const list = keys(15), focus = { key: list[3], span: 2, row: 0, column: 3 };
    const fitted = choose({ keys: list, width: 2000, height: 900, focus,
        columnGap: 10, rowGap: 10, force: true, preserveAnchor: true });
    assert.ok(Math.abs(fitted.area - measuredArea(fitted, 2000, 900, 10, 10)) < .001);
    assert.equal(fitted.rows, Math.ceil((list.length + 3) / fitted.columns));
    assert.deepEqual(choose({ keys: list, width: 930, height: 601, preserveAnchor: true }),
        choose({ keys: list, width: 930, height: 601 }), 'normal layouts retain existing behavior');
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

for (const corner of ['nw', 'ne', 'sw', 'se']) {
    test(`corner resize ${corner} preserves the opposite corner for growth and shrink`, () => {
        const list = keys(20), key = list[12];
        const before = build({ keys: list, columns: 10,
            focus: { key, span: 4, row: 4, column: 4 } });
        const saved = JSON.stringify(before);
        const opposite = value => ({ row: value.row + (corner[0] === 'n' ? value.span : 0),
            column: value.column + (corner[1] === 'w' ? value.span : 0) });
        for (const span of [2, 6]) {
            const next = resize(before, key, span, corner);
            assert.deepEqual(opposite(item(next, key)), opposite(item(before, key)));
            assert.equal(item(next, key).span, span);
            assert.deepEqual(next.items.map(value => value.key), visualKeys(before));
            assert.deepEqual(visualKeys(next).filter(value => value !== key),
                visualKeys(before).filter(value => value !== key));
            assertLayout(next, list);
            assertFirstFreePacking(next);
        }
        assert.equal(JSON.stringify(before), saved);
    });
}

test('corner resize clamps top/left growth and expands the grid for a right-hand edge', () => {
    const list = keys(10), key = list[0];
    const pinned = build({ keys: list, columns: 5,
        focus: { key, span: 2, row: 0, column: 0 } });
    const grown = resize(pinned, key, 8, 'nw');
    assert.deepEqual(item(grown, key), { key, span: 8, row: 0, column: 0 });
    assert.equal(grown.columns, 8);
    assertLayout(grown, list);
    const ordinary = build({ keys: list, columns: 5 });
    const edge = resize(ordinary, list[4], 4, 'se');
    assert.deepEqual(item(edge, list[4]), { key: list[4], span: 4, row: 0, column: 4 });
    assert.equal(edge.columns, 8);
    assertLayout(edge, list);
});

test('west-corner shrink retains the existing right anchor even beyond the optimal column range', () => {
    const list = keys(2), key = list[0];
    const before = build({ keys: list, columns: 5,
        focus: { key, span: 4, row: 1, column: 1 } });
    for (const corner of ['nw', 'sw']) {
        const next = resize(before, key, 2, corner);
        assert.equal(next.columns, 5);
        assert.equal(item(next, key).column, 3);
        assert.equal(item(next, key).column + item(next, key).span, 5);
        assertLayout(next, list);
    }
});

test('corner resize switches the sole focus and span one returns the visual order to a normal grid', () => {
    const list = keys(15), key = list[7], other = list[14];
    const before = build({ keys: list, columns: 6,
        focus: { key, span: 3, row: 1, column: 1 } });
    const next = resize(before, other, 2, 'ne');
    assert.equal(item(next, key).span, 1);
    assert.equal(item(next, other).span, 2);
    assertLayout(next, list);
    const normal = resize(next, key, 1, 'nw');
    assert.ok(normal.items.every(value => value.span === 1));
    assert.deepEqual(visualKeys(normal), visualKeys(next));
    assertLayout(normal, list);
    const sparse = resize(build({ keys: keys(2), columns: 5,
        focus: { key: 'player-0', span: 4, row: 1, column: 1 } }), 'player-0', 1);
    assert.equal(sparse.columns, 2);
});

test('corner resize normalizes span and corner without mutating input or inventing a missing key', () => {
    const list = keys(4), before = build({ keys: list, columns: 2 }), saved = JSON.stringify(before);
    for (const [input, expected] of [[0, 1], [-4, 1], [NaN, 1], [Infinity, 1], [-Infinity, 1],
        [undefined, 1], ['3.9', 3], [2.9, 2], [256, 256], [999, 256]]) {
        const next = resize(before, list[1], input);
        assert.equal(item(next, list[1]).span, expected);
        assertLayout(next, list);
    }
    assert.deepEqual(resize(before, list[1], 3, 'unknown'), resize(before, list[1], 3, 'se'));
    assert.equal(resize(before, 'missing', 3), before);
    assert.equal(resize(undefined, 'missing', 3), undefined);
    assert.equal(JSON.stringify(before), saved);
});

test('repeated opposite-corner resizes stay inside saved-schema limits and restore every player', () => {
    const list = keys(8), key = list[3];
    let layout = build({ keys: list, columns: 6,
        focus: { key, span: 2, row: 0, column: 0 } });
    for (let step = 0; step < 20; step++) {
        const span = step % 2 ? 2 : 256, corner = step % 2 ? 'nw' : 'se';
        const before = JSON.stringify(layout), next = resize(layout, key, span, corner);
        const saved = JSON.parse(JSON.stringify({ version: 1, columns: next.columns,
            focus: item(next, key) }));
        assert.ok(saved.focus.span >= 2 && saved.focus.span <= 256);
        assert.ok(Number.isInteger(saved.focus.row) && saved.focus.row >= 0 && saved.focus.row <= 512);
        assert.ok(Number.isInteger(saved.focus.column) && saved.focus.column >= 0 && saved.focus.column <= 512);
        assert.ok(Number.isInteger(saved.columns) && saved.columns >= saved.focus.span && saved.columns <= 768);
        const restored = build({ keys: visualKeys(next), columns: saved.columns, focus: saved.focus });
        assert.equal(restored.columns, next.columns);
        assert.equal(restored.rows, next.rows);
        for (const value of next.items) assert.deepEqual(item(restored, value.key), value);
        assert.equal(JSON.stringify(layout), before);
        assertLayout(next, list);
        layout = next;
    }
    assert.equal(item(layout, key).row, 512);
    assert.equal(item(layout, key).column, 512);
    assert.equal(layout.columns, 768);
});

test('corner resize preserves the opposite anchor up to the persisted origin boundary', () => {
    const list = keys(4), key = list[0];
    const before = build({ keys: list, columns: 768,
        focus: { key, span: 4, row: 510, column: 510 } });
    const atLimit = resize(before, key, 2, 'nw');
    assert.deepEqual(item(atLimit, key), { key, span: 2, row: 512, column: 512 });
    assert.equal(item(atLimit, key).row + 2, item(before, key).row + 4);
    assert.equal(item(atLimit, key).column + 2, item(before, key).column + 4);
    const pastLimit = resize(build({ keys: list, columns: 768,
        focus: { key, span: 4, row: 512, column: 512 } }), key, 2, 'nw');
    assert.deepEqual(item(pastLimit, key), { key, span: 2, row: 512, column: 512 });
    assertLayout(pastLimit, list);
    const outside = resize(build({ keys: list, columns: 900,
        focus: { key, span: 4, row: 700, column: 800 } }), key, 256, 'se');
    assert.deepEqual(item(outside, key), { key, span: 256, row: 512, column: 512 });
    assert.equal(outside.columns, 768);
    assertLayout(outside, list);
});

test('focused geometry needs eighteen percent improvement before changing columns', () => {
    const list = keys(6), focus = { key: list[0], span: 2, row: 0, column: 0 };
    const options = { keys: list, focus, width: 760, height: 700, columnGap: 10, rowGap: 10 };
    const previous = build({ keys: list, columns: 2, focus });
    const raw = choose({ ...options, previous, force: true });
    const stable = choose({ ...options, previous });
    assert.ok(raw.area > measuredArea(previous, 760, 700, 10, 10) * 1.06);
    assert.ok(raw.area <= stable.area * 1.18);
    assert.notEqual(raw.columns, previous.columns);
    assert.equal(stable.columns, previous.columns);
    const large = choose({ ...options, width: 1800, height: 500, previous });
    assert.notEqual(large.columns, previous.columns);
    assert.ok(large.area > measuredArea(previous, 1800, 500, 10, 10) * 1.18);
});

test('seeded corner resizes preserve the opposite anchor, one focus and visual packing without mutations', () => {
    const list = keys(24), random = randomGenerator(0x18c0ffee);
    let layout = build({ keys: list, columns: 6 });
    for (let step = 0; step < 160; step++) {
        const key = list[random(list.length)], corner = ['nw', 'ne', 'sw', 'se'][random(4)];
        const span = 1 + random(8), current = item(layout, key), before = JSON.stringify(layout);
        const order = visualKeys(layout), next = resize(layout, key, span, corner);
        assertLayout(next, list);
        assertFirstFreePacking(next);
        assert.equal(JSON.stringify(layout), before);
        assert.deepEqual(next.items.map(value => value.key), order);
        if (span > 1) {
            const changed = item(next, key);
            const bottom = current.row + current.span, right = current.column + current.span;
            if (corner[0] === 'n' && bottom >= span) assert.equal(changed.row + span, bottom);
            else assert.equal(changed.row, corner[0] === 'n' ? 0 : current.row);
            if (corner[1] === 'w' && right >= span) assert.equal(changed.column + span, right);
            else assert.equal(changed.column, corner[1] === 'w' ? 0 : current.column);
            assert.equal(changed.span, span);
            assert.ok(next.columns >= layout.columns);
            assert.deepEqual(visualKeys(next).filter(value => value !== key), order.filter(value => value !== key));
        } else assert.ok(next.items.every(value => value.span === 1));
        layout = next;
    }
});

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
