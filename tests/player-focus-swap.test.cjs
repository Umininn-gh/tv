'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const siteFile = name => fs.existsSync(path.join(root, name)) ? name : name.replace(/^site\/assets\/(?:js|css)\//, '').replace(/^site\//, '');
const G = require(path.join(root, siteFile('site/assets/js/player-geometry.js')));
const L = require(path.join(root, siteFile('site/assets/js/player-layout.js')));
const operations = L.createOperations({ geometry: G });
const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
};
const slot = ({ row, column, span }) => ({ row, column, span });
const visual = layout => [...layout.items].sort((a, b) => a.row - b.row || a.column - b.column).map(item => item.key);

function assertExchange(before, after, targetKey) {
    const focus = before.items.find(item => item.span > 1);
    const target = before.items.find(item => item.key === targetKey);
    assert.deepEqual({ ...after, items: null }, { ...before, items: null }, 'all layout metadata and tracks survive');
    assert.deepEqual(after.items.map(item => item.key), before.items.map(item => item.key), 'channel identities keep insertion order');
    assert.deepEqual(slot(after.items.find(item => item.key === targetKey)), slot(focus));
    assert.deepEqual(slot(after.items.find(item => item.key === focus.key)), slot(target));
    assert.equal(after.items.filter(item => item.span > 1).length, 1);
    assert.deepEqual(L.compare(before, after).changedKeys.sort(), [focus.key, targetKey].sort());
    for (const item of before.items) if (item !== focus && item !== target)
        assert.equal(after.items.find(next => next.key === item.key), item, 'unrelated cells are unchanged');
}

test('focus exchange retains exact slots for arbitrary anchors, spans and target positions', () => {
    for (const count of [2, 5, 17, 32]) for (const span of [2, 3, 4]) {
        for (const [row, column] of [[0, 0], [1, 2], [5, 6]]) {
            const keys = Array.from({ length: count }, (_, index) => 'channel-' + index);
            const before = freeze({ ...G.build({ keys, columns: column + span + 2,
                focus: { key: keys[Math.floor(count / 2)], row, column, span } }), count, area: 123 });
            const original = JSON.stringify(before);
            for (const item of before.items.filter(item => item.span === 1)) {
                const after = G.swapFocus(before, item.key);
                assertExchange(before, after, item.key);
                assert.equal(JSON.stringify(before), original, 'frozen input is never modified');
                const reversed = G.swapFocus(after, before.items.find(cell => cell.span > 1).key);
                assert.deepEqual(reversed, before, 'swapping back restores the exact prior layout');
            }
        }
    }
});

test('focus exchange preserves sparse layouts and channel-specific metadata without rebuilding', () => {
    const before = freeze({ columns: 12, rows: 9, count: 4, area: 77, deferredFocus: false,
        items: [
            { key: 'focus', row: 3, column: 5, span: 3, label: 'large channel' },
            { key: 'remote', row: 8, column: 11, span: 1, label: 'remote channel' },
            { key: 'first', row: 0, column: 2, span: 1 },
            { key: 'last', row: 7, column: 0, span: 1 }
        ] });
    const after = G.swapFocus(before, 'remote');
    assertExchange(before, after, 'remote');
    assert.equal(after.items.find(item => item.key === 'focus').label, 'large channel');
    assert.equal(after.items.find(item => item.key === 'remote').label, 'remote channel');
    assert.deepEqual(after.items.find(item => item.key === 'first'), before.items[2]);
    assert.deepEqual(after.items.find(item => item.key === 'last'), before.items[3]);
});

test('focus operation exposes the new focus and visual order for a direct authoritative commit', () => {
    const state = L.createState({ buildGeometry: G.build });
    state.setOrder(['a', 'b', 'c', 'd', 'e', 'f']);
    state.commit(G.build({ keys: state.order, columns: 5, focus: { key: 'd', row: 1, column: 2, span: 2 } }));
    const before = state.geometry;
    const plan = operations.swapFocus(before, 'a');
    assert.equal(plan.kind, 'swap-focus');
    assert.equal(plan.sourceKey, 'd');
    assert.equal(plan.targetKey, 'a');
    assert.equal(plan.focus.key, 'a');
    assert.deepEqual(plan.keys, visual(plan.next));
    assertExchange(before, plan.next, 'a');
    state.commit(plan.next);
    assert.deepEqual(state.geometry, plan.next);
    assert.deepEqual(state.focus, plan.focus);
    assert.deepEqual(state.order, plan.keys);
});

test('consecutive focus exchanges always use the latest enlarged channel while retaining the big rectangle', () => {
    const keys = Array.from({ length: 17 }, (_, index) => 'channel-' + index);
    let layout = freeze(G.build({ keys, columns: 6, focus: { key: keys[0], row: 2, column: 3, span: 3 } }));
    const anchor = slot(layout.items.find(item => item.span > 1));
    for (let cycle = 1; cycle <= 120; cycle++) {
        const targetKey = keys[(cycle * 5) % keys.length];
        const before = layout;
        const plan = operations.swapFocus(before, targetKey);
        assert.equal(plan.kind, 'swap-focus');
        assertExchange(before, plan.next, targetKey);
        assert.deepEqual(slot(plan.focus), anchor);
        layout = freeze(plan.next);
    }
});

test('missing, self, ordinary, absent and multiple focus layouts are unchanged no-ops', () => {
    const layout = freeze(G.build({ keys: ['a', 'b', 'c'], columns: 3,
        focus: { key: 'b', row: 0, column: 0, span: 2 } }));
    const cases = [
        [null, 'a'], [undefined, 'a'], [{}, 'a'],
        [G.build({ keys: [], columns: 1 }), 'a'],
        [G.build({ keys: ['a', 'b'], columns: 2 }), 'a'],
        [layout, 'missing'], [layout, 'b'],
        [{ ...layout, items: [...layout.items, { key: 'other-focus', row: 4, column: 0, span: 2 }], rows: 6 }, 'a'],
        [{ ...layout, items: [...layout.items, layout.items[0]] }, 'a'],
        [{ ...layout, items: layout.items.map(item => item.key === 'a' ? { ...item, row: -1 } : item) }, 'a']
    ];
    for (const [candidate, targetKey] of cases) {
        freeze(candidate);
        assert.equal(G.swapFocus(candidate, targetKey), candidate);
        const plan = operations.swapFocus(candidate, targetKey);
        assert.equal(plan.kind, 'none');
        assert.equal(plan.next, candidate);
    }
});
