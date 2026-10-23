'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = name => {
    const migrated = path.join(__dirname, '../site/assets/js', name + '.js');
    return require(fs.existsSync(migrated) ? migrated : path.join(__dirname, '..', name + '.js'));
};
const { createState, choose } = source('player-layout');
const G = source('player-geometry');
const make = () => createState({ buildGeometry: G.build });
const visual = layout => [...layout.items].sort((a, b) => a.row - b.row || a.column - b.column).map(item => item.key);
const keys = count => Array.from({ length: count }, (_, i) => 'channel-' + i);

function assertCommitted(state, expected) {
    assert.deepEqual(state.order, visual(state.geometry));
    assert.deepEqual([...state.order].sort(), [...expected].sort());
    assert.equal(new Set(state.order).size, state.order.length);
    const occupied = new Set();
    for (const item of state.geometry.items) {
        assert.ok(item.row >= 0 && item.column >= 0 && item.span >= 1);
        assert.ok(item.row + item.span <= state.geometry.rows);
        assert.ok(item.column + item.span <= state.geometry.columns);
        for (let row = item.row; row < item.row + item.span; row++) {
            for (let column = item.column; column < item.column + item.span; column++) {
                const cell = row + ':' + column;
                assert.ok(!occupied.has(cell), 'cells never overlap: ' + cell);
                occupied.add(cell);
            }
        }
    }
}

test('layout state starts with explicit empty geometry and isolated instances', () => {
    const a = make(), b = make();
    assert.deepEqual(a.geometry.items, []);
    assert.equal(a.geometry.columns, 1);
    assert.equal(a.geometry.rows, 1);
    assert.equal(a.enlargedGeometry, null);
    a.setOrder(['a', 'b']);
    a.commit({ columns: 2, rows: 1, count: 2, area: 99 });
    assertCommitted(a, ['a', 'b']);
    assert.deepEqual(b.order, []);
    assert.deepEqual(b.geometry.items, []);
});

test('normal layout commits explicit positions without any DOM or CSS input', () => {
    const state = make();
    state.setOrder(['c', 'a', 'b', 'd', 'e']);
    state.commit({ count: 5, columns: 3, rows: 2, area: 200 });
    assert.deepEqual(state.geometry.items, [
        { key: 'c', row: 0, column: 0, span: 1 },
        { key: 'a', row: 0, column: 1, span: 1 },
        { key: 'b', row: 0, column: 2, span: 1 },
        { key: 'd', row: 1, column: 0, span: 1 },
        { key: 'e', row: 1, column: 1, span: 1 }
    ]);
    assert.equal(state.enlargedGeometry, null);
    assertCommitted(state, ['a', 'b', 'c', 'd', 'e']);
});

test('reordering normal players changes logical positions and preserves adopted tracks', () => {
    const state = make();
    state.setOrder(['a', 'b', 'c', 'd']);
    state.commit({ columns: 2, rows: 2, count: 4 });
    const old = state.geometry;
    state.setOrder(['d', 'b', 'c', 'a']);
    assert.equal(state.geometry.columns, 2);
    assert.equal(state.geometry.items.find(item => item.key === 'd').column, 0);
    assert.equal(state.geometry.items.find(item => item.key === 'a').row, 1);
    assert.deepEqual(old.items.map(item => item.key), ['a', 'b', 'c', 'd']);
    assertCommitted(state, ['a', 'b', 'c', 'd']);
});

test('external arrays and layout objects cannot mutate the live model or earlier snapshots', () => {
    const state = make(), order = ['a', 'b', 'c'];
    state.setOrder(order); order.reverse();
    assert.deepEqual(state.order, ['a', 'b', 'c']);
    const next = G.build({ keys: state.order, columns: 3, focus: { key: 'b', span: 2, row: 0, column: 1 } });
    state.commit(next);
    const old = state.geometry;
    next.items[0].row = 500;
    assert.notEqual(old.items[0].row, 500);
    assert.throws(() => { state.order.push('injected'); }, TypeError);
    assert.throws(() => { state.geometry.items[0].row = 500; }, TypeError);
    assert.throws(() => { state.focus.span = 99; }, TypeError);
    state.setOrder(['a']); state.commit({ columns: 1, rows: 1, count: 1 });
    assert.equal(old.items.length, 3);
    assertCommitted(state, ['a']);
});

test('enlarged commit adopts canonical visual order and retains the matching focus', () => {
    const state = make(), list = keys(9);
    state.setOrder(list);
    const layout = G.build({ keys: list, columns: 4, focus: { key: list[7], span: 2, row: 0, column: 0 } });
    state.commit(layout);
    assert.equal(state.order[0], list[7]);
    assert.deepEqual(state.focus, { key: list[7], span: 2, row: 0, column: 0 });
    assert.equal(state.enlargedGeometry, state.geometry);
    assertCommitted(state, list);
});

test('hidden-pane fallback preserves the desired saved anchor until a usable commit', () => {
    const state = make(), list = keys(8);
    const desired = { key: list[0], span: 3, row: 5, column: 4 };
    const pending = { columns: 7, intent: 'restore' };
    state.setOrder(list); state.setFocus(desired); state.setPending(pending);
    desired.column = 99; pending.columns = 99;
    state.commit({ ...G.build({ keys: list, columns: 3, focus: state.focus }), deferredFocus: true });
    assert.equal(state.geometry.items.find(item => item.span > 1).column, 0);
    assert.equal(state.focus.column, 4);
    assert.equal(state.pending.columns, 7);
    state.commit(G.build({ keys: list, columns: 7, focus: state.focus }));
    state.setPending(null);
    assert.equal(state.focus.column, 4);
    assert.equal(state.pending, null);
    assertCommitted(state, list);
});

test('temporarily absent enlarged channel retains preference without becoming a live tile', () => {
    const state = make(), list = keys(8);
    const focus = { key: list[6], span: 2, row: 0, column: 1 };
    state.setOrder(list); state.setFocus(focus);
    state.commit(G.build({ keys: list, columns: 4, focus }));
    const visible = list.filter(key => key !== focus.key);
    state.setOrder(visible); state.commit({ columns: 3, rows: 3, count: visible.length });
    assert.equal(state.enlargedGeometry, null);
    assert.equal(state.focus.key, focus.key);
    assertCommitted(state, visible);
    state.setOrder(list); state.commit(G.build({ keys: list, columns: 4, focus: state.focus }));
    assert.equal(state.enlargedGeometry.items.find(item => item.span > 1).key, focus.key);
    assertCommitted(state, list);
});

test('remembered positions retain dormant channels while the live geometry contains selected channels only', () => {
    const state = make();
    state.setPreferredOrder(['offline', 'a', 'b', 'a']);
    state.setOrder(['b', 'a', 'new']); state.rememberOrder();
    assert.deepEqual(state.preferredOrder, ['b', 'a', 'new', 'offline']);
    assert.deepEqual(state.geometry.items.map(item => item.key), ['b', 'a', 'new']);
    state.setPreferredOrder(keys(300));
    assert.equal(state.preferredOrder.length, 256);
    assert.throws(() => { state.preferredOrder[0] = 'changed'; }, TypeError);
});

test('old stored order still deduplicates invalid entries and reset clears pending enlargement explicitly', () => {
    const state = make();
    state.setPreferredOrder(['a', null, 5, 'b', 'a']);
    assert.deepEqual(state.preferredOrder, ['a', 'b']);
    state.setOrder(['a', 'b']); state.setFocus({ key: 'a', span: 2, row: 0, column: 0 });
    state.setPending({ columns: 3, intent: 'bookmark' });
    state.setPreferredOrder([]); state.setFocus(null); state.setPending(null);
    state.commit({ columns: 2, rows: 1, count: 2 });
    assert.equal(state.focus, null); assert.equal(state.pending, null);
    assert.equal(state.enlargedGeometry, null); assert.deepEqual(state.preferredOrder, []);
    assertCommitted(state, ['a', 'b']);
});

test('mixed size, direction, cross-grid move and shrink operations keep one committed model', () => {
    const state = make(), list = keys(17);
    state.setOrder(list); state.commit({ columns: 5, rows: 4, count: 17 });
    for (let cycle = 0; cycle < 30; cycle++) {
        const focusKey = list[cycle % list.length];
        state.commit(G.grow(state.geometry, focusKey));
        assertCommitted(state, list);
        for (const direction of ['right', 'down', 'left', 'up']) {
            const neighbor = G.neighbors(state.geometry, focusKey, direction)[0];
            if (neighbor) state.commit(G.step(state.geometry, focusKey, direction, neighbor.key));
            assertCommitted(state, list);
        }
        state.commit(G.relocate(state.geometry, focusKey, list[(cycle + 9) % list.length]));
        assertCommitted(state, list);
        const next = G.shrink(state.geometry, focusKey);
        state.setFocus(next.items.find(item => item.span > 1) || null);
        state.commit(next); state.rememberOrder();
        assertCommitted(state, list);
        assert.deepEqual(state.preferredOrder, state.order);
    }
});

test('responsive fitting updates normal cells without replacing order or introducing a focus', () => {
    const state = make(), list = keys(32);
    state.setOrder([...list].reverse());
    for (const [width, height] of [[1800, 700], [380, 700], [800, 800], [260, 8], [1800, 700]]) {
        state.commit(choose({ count: list.length, width, height, force: true }));
        assert.deepEqual(state.order, [...list].reverse());
        assert.equal(state.enlargedGeometry, null);
        assertCommitted(state, list);
    }
});
