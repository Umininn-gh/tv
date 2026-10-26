'use strict';
const { assertCompact } = require('./helpers/player-layout-compaction.cjs');

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
const keys = count => Array.from({ length: count }, (_, index) => 'channel-' + index);
const visual = layout => [...layout.items].sort((a, b) => a.row - b.row || a.column - b.column).map(item => item.key);
const canonical = layout => ({ columns: layout.columns, rows: layout.rows,
    items: [...layout.items].sort((a, b) => a.key.localeCompare(b.key)) });
const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
};
const makeLayout = (count, columns, focusIndex = -1, span = 2, row = 0, column = 0) => {
    const list = keys(count);
    return G.build({ keys: list, columns, focus: focusIndex < 0 ? null : { key: list[focusIndex], span, row, column } });
};
function assertCells(layout, expectedKeys) {
    assert.deepEqual([...visual(layout)].sort(), [...expectedKeys].sort());
    assert.ok(layout.items.filter(item => item.span > 1).length <= 1);
    const used = new Set();
    for (const item of layout.items) {
        assert.ok(item.row >= 0 && item.column >= 0);
        assert.ok(item.row + item.span <= layout.rows && item.column + item.span <= layout.columns);
        for (let y = item.row; y < item.row + item.span; y++) for (let x = item.column; x < item.column + item.span; x++) {
            const cell = y + ':' + x;
            assert.ok(!used.has(cell), 'cell collision ' + cell);
            used.add(cell);
        }
    }
}

// Golden movement contract before phase 2. In particular a direct exchange
// uses swapped visual keys, not PlayerGeometry.swap's insertion-order keys.
function legacyExchange(layout, sourceKey, targetKey) {
    const order = visual(layout), a = order.indexOf(sourceKey), b = order.indexOf(targetKey);
    if (a < 0 || b < 0 || a === b) return null;
    [order[a], order[b]] = [order[b], order[a]];
    const pending = layout.items.some(item => item.span > 1) ? G.swap(layout, sourceKey, targetKey) : null;
    const focus = pending?.items.find(item => item.span > 1);
    return G.build({ keys: order, columns: pending?.columns || layout.columns, focus });
}
function legacyTarget(layout, sourceKey, targetKey, direction = null) {
    const source = layout.items.find(item => item.key === sourceKey), target = layout.items.find(item => item.key === targetKey);
    if (!source || !target || sourceKey === targetKey) return { kind: 'none', next: layout };
    if (source.span > 1 || target.span > 1) {
        const edge = ['up', 'down', 'left', 'right'].find(value => G.neighbors(layout, sourceKey, value).some(item => item.key === targetKey));
        if (direction && direction !== edge) return { kind: 'none', next: layout };
        const next = edge ? G.step(layout, sourceKey, edge, targetKey) : G.relocate(layout, sourceKey, targetKey);
        return { kind: next === layout ? 'none' : edge ? 'step' : 'relocate', next };
    }
    return { kind: 'exchange', next: legacyExchange(layout, sourceKey, targetKey) };
}

test('operations require a geometry engine and do not expose mutable routing configuration', () => {
    assert.throws(() => L.createOperations(), TypeError);
    assert.throws(() => L.createOperations({ geometry: {} }), TypeError);
    assert.ok(Object.isFrozen(operations));
});

test('directional commands require a shared edge, never wrap rows or jump to a remote tile', () => {
    const layout = freeze(makeLayout(8, 3));
    assert.equal(operations.step(layout, 'channel-2', 'right', 'channel-3').kind, 'none');
    assert.equal(operations.step(layout, 'channel-0', 'right', 'channel-2').kind, 'none');
    assert.equal(operations.step(layout, 'channel-0', 'down', 'channel-4').kind, 'none');
    const plan = operations.step(layout, 'channel-0', 'right', 'channel-1');
    assert.equal(plan.kind, 'exchange');
    assert.deepEqual(visual(plan.next), ['channel-1', 'channel-0', ...keys(8).slice(2)]);
    assertCells(plan.next, keys(8));
});

test('every large-tile shared-edge target moves exactly one base cell from either side', () => {
    const layout = freeze(makeLayout(22, 5, 0, 2, 1, 1));
    const focus = layout.items.find(item => item.span > 1);
    let checked = 0;
    for (const direction of ['up', 'down', 'left', 'right']) {
        for (const neighbor of G.neighbors(layout, focus.key, direction)) {
            const plan = operations.step(layout, focus.key, direction, neighbor.key);
            assert.equal(plan.kind, 'step');
            const moved = plan.next.items.find(item => item.key === focus.key);
            assert.equal(Math.abs(moved.row - focus.row) + Math.abs(moved.column - focus.column), 1);
            assert.equal(plan.focusDirection, direction);
            assert.equal(plan.focusKey, focus.key);
            const reverse = { up: 'down', down: 'up', left: 'right', right: 'left' };
            const fromSmall = operations.step(layout, neighbor.key, reverse[direction], focus.key);
            assert.deepEqual(canonical(fromSmall.next), canonical(plan.next));
            assert.equal(fromSmall.focusDirection, direction);
            assertCells(plan.next, keys(22)); checked++;
        }
    }
    assert.equal(checked, 8, 'two independently selectable neighbors on every focus edge');
});

test('pointer target and directional intent stay separate for adjacent and remote large-tile moves', () => {
    const layout = freeze(makeLayout(18, 5, 0, 2, 0, 0));
    const adjacent = G.neighbors(layout, 'channel-0', 'right')[0].key;
    assert.deepEqual(operations.target(layout, 'channel-0', adjacent), operations.step(layout, 'channel-0', 'right', adjacent));
    const remote = layout.items.find(item => item.row >= 3 && item.column >= 3).key;
    const placement = operations.target(layout, 'channel-0', remote);
    assert.equal(placement.kind, 'relocate');
    assert.deepEqual(canonical(placement.next), canonical(G.relocate(layout, 'channel-0', remote)));
    assert.equal(operations.target(layout, 'channel-0', remote, { direction: 'right' }).kind, 'none');
    assert.equal(operations.target(layout, 'channel-0', adjacent, { direction: 'down' }).kind, 'none');
    assertCells(placement.next, keys(18));
});

test('two small tiles can exchange across a gap even in an enlarged grid, preserving keyboard navigation', () => {
    const layout = freeze(makeLayout(12, 4, 0, 2, 1, 1));
    const small = layout.items.filter(item => item.span === 1), a = small[0].key, b = small.at(-1).key;
    assert.equal(G.neighbors(layout, a, 'down').some(item => item.key === b), false);
    const plan = operations.target(layout, a, b, { direction: 'down' });
    assert.equal(plan.kind, 'exchange');
    assert.deepEqual(canonical(plan.next), canonical(legacyExchange(layout, a, b)));
    assert.deepEqual(plan.next.items.find(item => item.span > 1), layout.items.find(item => item.span > 1));
});

test('direct exchange retains phase-one visual ordering when a large tile changes anchor', () => {
    const layout = freeze(G.grow(makeLayout(3, 2), 'channel-1'));
    const plan = operations.exchange(layout, 'channel-1', 'channel-2');
    assert.equal(plan.kind, 'exchange');
    assert.deepEqual(visual(plan.next), ['channel-2', 'channel-0', 'channel-1']);
    assert.deepEqual(canonical(plan.next), canonical(legacyExchange(layout, 'channel-1', 'channel-2')));
    assertCells(plan.next, keys(3));
});

test('stale, same-target and invalid-direction commands leave frozen input untouched', () => {
    const layout = freeze(makeLayout(8, 4, 0));
    for (const [source, target] of [['missing', 'channel-1'], ['channel-0', 'missing'], ['channel-0', 'channel-0']]) {
        for (const plan of [operations.exchange(layout, source, target), operations.target(layout, source, target),
            operations.step(layout, source, 'right', target)]) {
            assert.equal(plan.kind, 'none'); assert.equal(plan.next, layout);
        }
    }
    for (const direction of ['bogus', '__proto__', null]) assert.equal(operations.step(layout, 'channel-0', direction, 'channel-1').kind, 'none');
    assert.equal(operations.target(null, 'a', 'b').kind, 'none');
});

test('placement plans match the accepted pre-refactor rules across source, target, and keyboard intents', () => {
    let compared = 0;
    for (const count of [3, 5, 9, 17, 24]) for (const span of [1, 2, 3]) for (const anchor of [0, 1]) {
        const layout = freeze(makeLayout(count, 5, span > 1 ? Math.floor(count / 2) : -1, span, anchor, anchor));
        for (const source of keys(count)) for (const target of keys(count)) {
            const exchange = operations.exchange(layout, source, target), oldExchange = legacyExchange(layout, source, target);
            if (oldExchange) assert.deepEqual(canonical(exchange.next), canonical(oldExchange));
            else assert.equal(exchange.kind, 'none');
            for (const direction of [null, 'up', 'down', 'left', 'right']) {
                const expected = legacyTarget(layout, source, target, direction);
                const plan = operations.target(layout, source, target, { direction });
                assert.equal(plan.kind, expected.kind);
                assert.deepEqual(canonical(plan.next), canonical(expected.next));
                compared++;
            }
        }
    }
    assert.equal(compared, 29400);
});


// Frozen phase-one calculatePlayerLayout body: independent old/new policy oracle.
function legacyReflow(input, options) {
    const PlayerGeometry = G, PlayerLayout = L;
    const playerLayoutState = { focus: input.focus, pending: input.pending, setPending(value) { this.pending = value; } };
    const getPlayerPositionKeys = () => input.keys;
    function calculatePlayerLayout(options) {
        const keys = getPlayerPositionKeys();
        const focus = keys.includes(playerLayoutState.focus?.key) && keys.length > 1 ? playerLayoutState.focus : null;
        if (!focus) {
            if (playerLayoutState.pending?.intent === 'bookmark') {
                const columns = Math.max(1, Math.min(keys.length || 1, playerLayoutState.pending.columns));
                // Apply the saved grid once, then keep the existing resize
                // stability rules. Hidden panes retain the restore intent.
                if (options.width > 0 && options.height > 0) playerLayoutState.setPending(null);
                return { count: keys.length, columns, rows: Math.max(1, Math.ceil(keys.length / columns)), area: 0 };
            }
            playerLayoutState.setPending(null);
            return PlayerLayout.choose(options);
        }
        if (!(options.width > 0 && options.height > 0)) {
            // A hidden fallback grid must not overwrite the saved anchor.
            // Keep pending size/restore intent until there is a real pane.
            const columns = Math.max(focus.span, Math.min(Math.max(playerLayoutState.pending?.columns || 0,
                options.previous?.columns || 0, focus.column + focus.span), focus.span + keys.length - 1));
            return { ...PlayerGeometry.build({ keys, columns, focus }), count: keys.length, deferredFocus: true };
        }
        let next;
        if (playerLayoutState.pending?.intent === 'bookmark') {
            next = PlayerGeometry.build({ keys, columns: playerLayoutState.pending.columns, focus });
            playerLayoutState.setPending(null);
        } else if (playerLayoutState.pending?.intent === 'size' || playerLayoutState.pending?.intent === 'restore') {
            // Explicit sizing and reopening settle on the best grid immediately.
            playerLayoutState.setPending(null);
            next = PlayerGeometry.choose({ ...options, keys, focus, force: true });
        } else if (playerLayoutState.pending?.intent === 'drag') {
            // The preview already chose these tracks and the opposite corner.
            next = PlayerGeometry.build({ keys, columns: playerLayoutState.pending.columns, focus });
            playerLayoutState.setPending(null);
        } else if (playerLayoutState.pending) {
            // A saved grid may have come from a much larger selection.
            const columns = Math.max(focus.span, Math.min(playerLayoutState.pending.columns, focus.span + keys.length - 1));
            next = PlayerGeometry.build({ keys, columns, focus });
            playerLayoutState.setPending(null);
        } else if (options.preserveColumns && options.previous?.columns >= focus.span &&
            options.previous.columns <= 768) {
            next = PlayerGeometry.build({ keys, columns: options.previous.columns, focus });
        } else next = PlayerGeometry.choose({ ...options, keys, focus });
        return { ...next, count: keys.length };
    }
    const next = calculatePlayerLayout(options);
    return { next, pending: playerLayoutState.pending };
}

test('automatic fitting preserves the existing five-tile and seventeen-tile geometry choices', () => {
    for (const [count, width, height, columns] of [[5, 1400, 900, 2], [5, 1800, 500, 3], [17, 1400, 900, 4]]) {
        const input = freeze({ keys: keys(count), focus: null, pending: null });
        const options = freeze({ count, width, height, columnGap: 10, rowGap: 10, force: true });
        const plan = operations.reflow(input, options);
        assert.equal(plan.next.columns, columns);
        assert.deepEqual(plan.next, L.choose(options));
        assert.equal(plan.pending, null);
    }
});

test('bookmark and drag retain chosen tracks while size and restore select optimal tracks', () => {
    const list = keys(12), focus = { key: list[0], span: 2, row: 0, column: 0 };
    const options = freeze({ count: list.length, width: 1400, height: 900, columnGap: 10, rowGap: 10,
        previous: G.build({ keys: list, columns: 9, focus }), preserveColumns: true });
    for (const intent of ['bookmark', 'drag']) {
        const input = freeze({ keys: list, focus, pending: { columns: 9, intent } });
        const plan = operations.reflow(input, options);
        assert.equal(plan.next.columns, 9);
        assert.equal(plan.pending, null);
        assertCells(plan.next, list);
    }
    for (const intent of ['size', 'restore']) {
        const input = freeze({ keys: list, focus, pending: { columns: 9, intent } });
        const plan = operations.reflow(input, options);
        assert.equal(plan.next.columns, G.choose({ ...options, keys: list, focus, force: true }).columns);
        assert.notEqual(plan.next.columns, 9);
        assert.equal(plan.pending, null);
    }
});

test('hidden panes preserve saved focus intent and bookmark tracks until a usable measurement', () => {
    const list = keys(8), focus = { key: list[0], span: 3, row: 4, column: 6 };
    for (const intent of ['bookmark', 'drag', 'size', 'restore', undefined]) {
        const input = freeze({ keys: list, focus, pending: { columns: 9, ...(intent ? { intent } : {}) } });
        const options = freeze({ count: list.length, width: 0, height: 900, previous: { columns: 2 } });
        const hidden = operations.reflow(input, options);
        assert.equal(hidden.pending, input.pending);
        assert.equal(hidden.next.deferredFocus, true);
        assert.equal(hidden.next.items.find(item => item.span > 1).column, 6);
        assert.equal(input.focus.column, 6);
        const visible = operations.reflow({ ...input, pending: hidden.pending }, { ...options, width: 1400 });
        assert.equal(visible.pending, null);
        assert.equal(Boolean(visible.next.deferredFocus), false);
    }
    const ordinary = freeze({ keys: list, focus: null, pending: { columns: 5, intent: 'bookmark' } });
    assert.equal(operations.reflow(ordinary, { count: 8, width: 0, height: 0 }).pending, ordinary.pending);
    assert.equal(operations.reflow(ordinary, { count: 8, width: 1400, height: 900 }).pending, null);
});

test('normal exchanges do not consume an outstanding hidden bookmark or restore request', () => {
    const state = L.createState({ buildGeometry: G.build });
    state.setOrder(keys(5)); state.commit({ count: 5, columns: 3, rows: 2 });
    for (const intent of ['bookmark', 'restore']) {
        state.setPending({ columns: 4, intent });
        const pending = state.pending;
        const plan = operations.exchange(state.geometry, 'channel-0', 'channel-4');
        assert.equal(plan.enlarged, false);
        // The normal exchange commit only changes order. Existing pending intent
        // belongs to reflow, not to the placement planner or its null pending.
        state.setOrder(plan.keys);
        assert.equal(state.pending, pending);
        const input = { keys: state.order, focus: state.focus, pending: state.pending };
        const result = operations.reflow(input, { count: 5, width: 0, height: 0 });
        assert.deepEqual(result, legacyReflow(input, { count: 5, width: 0, height: 0 }));
    }
});

test('reflow compacts explicit size actions while retaining legacy viewport, restore and hidden-anchor behavior', () => {
    let compared = 0;
    for (const count of [0, 1, 2, 5, 17, 32]) {
        const list = keys(count);
        for (const focus of [null, { key: list[0] || 'missing', span: 2, row: 0, column: 0 },
            { key: list.at(-1) || 'missing', span: 3, row: 4, column: 6 }, { key: 'dormant', span: 2, row: 2, column: 3 }]) {
            for (const intent of [null, 'bookmark', 'drag', 'size', 'restore', 'legacy']) {
                for (const [width, height] of [[0, 0], [0, 700], [1400, 0], [1400, 900], [380, 650], [1920, 500]]) {
                    for (const previousColumns of [undefined, 1, 3, 9, 769]) for (const preserveColumns of [false, true]) {
                        const pending = intent ? { columns: 9, ...(intent === 'legacy' ? {} : { intent }) } : null;
                        const input = freeze({ keys: [...list], focus: focus && { ...focus }, pending });
                        const options = freeze({ count, width, height, columnGap: 10, rowGap: 10,
                            previous: previousColumns ? { columns: previousColumns } : undefined, preserveColumns,
                            force: intent === 'size' });
                        const before = JSON.stringify({ input, options });
                        const expected = legacyReflow(input, options), plan = operations.reflow(input, options);
                        const activeFocus = count > 1 && list.includes(focus?.key);
                        if (activeFocus && !(width > 0 && height > 0)) {
                            // Zero-size projection now retains the full confirmed
                            // layout, even when only a few active keys remain.
                            // Check the new contract independently of its formula.
                            assert.equal(plan.pending, input.pending);
                            assert.equal(plan.next.deferredFocus, true);
                            assert.deepEqual(plan.next.items.find(item => item.span > 1), focus);
                            assert.ok(plan.next.columns >= focus.column + focus.span);
                            if (previousColumns && previousColumns <= 768) assert.ok(plan.next.columns >= previousColumns);
                            if (pending?.columns <= 768) assert.ok(plan.next.columns >= pending.columns);
                            assert.ok(plan.next.columns <= 768);
                            assertCells(plan.next, list);
                        } else if (activeFocus && pending?.intent === 'size') {
                            assertCompact(plan.next); assertCells(plan.next, list);
                            assert.equal(plan.next.items.find(item => item.key === focus.key).span, focus.span);
                            assert.equal(plan.pending, null);
                        } else assert.deepEqual(plan, expected);
                        assert.equal(JSON.stringify({ input, options }), before, 'planning is read-only');
                        compared++;
                    }
                }
            }
        }
    }
    assert.equal(compared, 8640);
});
