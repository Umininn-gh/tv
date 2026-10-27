'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const source = name => {
    const migrated = path.join(__dirname, '../site/assets/js', name + '.js');
    return require(fs.existsSync(migrated) ? migrated : path.join(__dirname, '..', name + '.js'));
};
const G = source('player-geometry'), L = source('player-layout');
const operations = L.createOperations({ geometry: G });
const freeze = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze); Object.freeze(value);
    }
    return value;
};
const cell = (layout, key) => layout.items.find(item => item.key === key);
const focus = layout => layout.items.find(item => item.span > 1);
const slot = item => ({ row: item.row, column: item.column, span: item.span });
const visual = layout => [...layout.items].sort((a, b) => a.row - b.row || a.column - b.column).map(item => item.key);
function swap(layout, targetKey) {
    const large = focus(layout), small = cell(layout, targetKey);
    assert.ok(large && small && small.span === 1);
    return { ...layout, items: layout.items.map(item => item.key === large.key ? { ...item, ...slot(small) } :
        item.key === small.key ? { ...item, ...slot(large) } : item) };
}
function fixture(count = 7, span = 3) {
    const keys = Array.from({ length: count }, (_, index) => 'memory-' + index);
    return freeze({ ...G.build({ keys, columns: 6, focus: { key: keys[0], span, row: 2, column: 2 } }),
        count, area: 42, tag: 'retained metadata' });
}
function assertPlan(before, plan, expected, targetKey, expectedSmall) {
    assert.equal(plan.kind, 'swap-focus'); assert.deepEqual(plan.next, expected);
    assert.equal(plan.focus.key, targetKey); assert.deepEqual(plan.focus, focus(expected));
    assert.equal(plan.targetKey, targetKey); assert.equal(plan.sourceKey, focus(before).key);
    assert.deepEqual(plan.keys, visual(expected));
    assert.deepEqual(plan.memory, { large: targetKey, small: expectedSmall });
    assert.deepEqual(slot(plan.focus), slot(focus(before)), 'the large rectangle never moves or changes size');
    assert.equal(Object.hasOwn(plan.next, 'memory'), false, 'the pair is not geometry or bookmark data');
}

test('focus memory: an absent record retains the exact ordinary exchange and reports its one final pair', () => {
    for (const count of [2, 5, 17]) for (const span of [2, 3, 4]) {
        const before = fixture(count, span), original = JSON.stringify(before);
        for (const target of before.items.filter(item => item.span === 1)) {
            const plan = operations.swapFocus(before, target.key);
            assertPlan(before, plan, swap(before, target.key), target.key, focus(before).key);
            assert.equal(plan.restoredKey, null);
        }
        assert.equal(JSON.stringify(before), original);
    }
});

test('focus memory: the same large channel and a new target restore the previous small channel before one final exchange', () => {
    const initial = fixture(), a = 'memory-0', b = 'memory-1', c = 'memory-2';
    const afterB = freeze(swap(initial, b)), memory = freeze({ large: b, small: a });
    const before = JSON.stringify({ afterB, memory });
    const plan = operations.swapFocus(afterB, c, memory), expected = swap(initial, c);
    assertPlan(afterB, plan, expected, c, a);
    assert.equal(plan.restoredKey, a);
    assert.deepEqual(slot(cell(plan.next, b)), slot(cell(initial, b)), 'the previously promoted channel returns to its original small slot');
    assert.deepEqual(slot(cell(plan.next, a)), slot(cell(initial, c)), 'the original large channel occupies only the new target slot');
    assert.deepEqual(L.compare(afterB, plan.next).changedKeys.sort(), [a, b, c].sort());
    for (const item of afterB.items) if (![a, b, c].includes(item.key))
        assert.equal(cell(plan.next, item.key), item, 'unrelated cell objects are not rebuilt');
    assert.equal(JSON.stringify({ afterB, memory }), before, 'neither the record nor geometry is mutated');
});

test('focus memory: selecting the recorded small channel performs the normal inverse without an intermediate restore', () => {
    const initial = fixture(), a = 'memory-0', b = 'memory-1';
    const afterB = freeze(swap(initial, b));
    const plan = operations.swapFocus(afterB, a, freeze({ large: b, small: a }));
    assert.equal(plan.kind, 'swap-focus'); assert.deepEqual(plan.next, initial);
    assert.equal(plan.restoredKey, null, 'an exact pair must not be undone and swapped twice');
    assert.equal(plan.memory, null, 'returning to the recorded original large channel clears the one pair');
    assert.deepEqual(L.compare(afterB, plan.next).changedKeys.sort(), [a, b].sort());
});

test('focus memory: returning to A clears the pair so A-B-C-A-C-A never drifts the inactive small slots', () => {
    const initial = fixture(), a = 'memory-0';
    let layout = initial, memory = null;
    for (const target of ['memory-1', 'memory-2', a, 'memory-2', a, 'memory-3', 'memory-1', a]) {
        const plan = operations.swapFocus(layout, target, memory);
        assert.equal(plan.kind, 'swap-focus');
        assert.deepEqual(plan.next, target === a ? initial : swap(initial, target));
        if (target === a) assert.equal(plan.memory, null);
        else assert.deepEqual(plan.memory, { large: target, small: a });
        layout = freeze(plan.next); memory = freeze(plan.memory);
    }
});

test('focus memory: a changed large channel or malformed and stale pair always falls back to one normal exchange', () => {
    const before = fixture(), a = 'memory-0', b = 'memory-1', c = 'memory-2';
    const malformed = [null, undefined, '', 9, true, [], {}, { large: a }, { small: b },
        { large: '', small: b }, { large: a, small: '' }, { large: a, small: null },
        { large: a, small: a }, { large: 'removed', small: b }, { large: a, small: 'removed' },
        { large: b, small: c }, { large: b, small: a }, { large: 7, small: b }];
    for (const memory of malformed) {
        freeze(memory); const plan = operations.swapFocus(before, c, memory);
        assertPlan(before, plan, swap(before, c), c, a); assert.equal(plan.restoredKey, null);
    }
});

test('focus memory: long B-C-D promotion sequences keep every inactive small channel in its original slot', () => {
    const initial = fixture(17), keys = initial.items.map(item => item.key), originalLarge = keys[0];
    let layout = initial, memory = null;
    for (let step = 0; step < 180; step++) {
        const target = keys[1 + step % 3], before = layout;
        const plan = operations.swapFocus(before, target, memory);
        assertPlan(before, plan, swap(initial, target), target, originalLarge);
        for (const key of keys) if (key !== target && key !== originalLarge)
            assert.deepEqual(slot(cell(plan.next, key)), slot(cell(initial, key)), 'inactive small channel ' + key + ' stays put at step ' + step);
        layout = freeze(plan.next); memory = freeze(plan.memory);
    }
});

test('focus memory: missing targets, the current large channel, and an ordinary grid are read-only no-ops', () => {
    const before = fixture(), memory = freeze({ large: 'memory-0', small: 'memory-1' });
    const ordinary = freeze(G.build({ keys: ['memory-0', 'memory-1'], columns: 2 }));
    for (const [layout, target] of [[before, 'missing'], [before, 'memory-0'], [ordinary, 'memory-1'], [null, 'memory-1']]) {
        const plan = operations.swapFocus(layout, target, memory);
        assert.equal(plan.kind, 'none'); assert.equal(plan.next, layout);
        assert.equal(plan.memory, undefined, 'a failed operation cannot replace the saved pair');
    }
});
