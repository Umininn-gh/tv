'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = name => {
    const migrated = path.join(__dirname, '../site/assets/js', name + '.js');
    return require(fs.existsSync(migrated) ? migrated : path.join(__dirname, '..', name + '.js'));
};
const G = load('player-geometry'), L = load('player-layout');
const operations = L.createOperations({ geometry: G });
const COUNTS = [0, 1, 2, 3, 5, 8, 9, 10, 17, 31, 64];
const SPANS = [2, 3, 4, 8];
const DIRECTIONS = {
    up: { axis: 'row', delta: -1, reverse: 'down' },
    down: { axis: 'row', delta: 1, reverse: 'up' },
    left: { axis: 'column', delta: -1, reverse: 'right' },
    right: { axis: 'column', delta: 1, reverse: 'left' }
};
const keysFor = count => Array.from({ length: count }, (_, index) => 'boundary-' + index);
const visual = layout => [...layout.items].sort((a, b) => a.row - b.row || a.column - b.column).map(item => item.key);
const cell = (layout, key) => layout.items.find(item => item.key === key);
const focusOf = layout => layout.items.find(item => item.span > 1) || null;
const position = item => `${item.row}:${item.column}`;
const inside = (square, item) => item.row >= square.row && item.row < square.row + square.span &&
    item.column >= square.column && item.column < square.column + square.span;
const freeze = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze); Object.freeze(value);
    }
    return value;
};
const canonical = layout => ({ columns: layout.columns, rows: layout.rows,
    items: [...layout.items].sort((a, b) => a.key.localeCompare(b.key)) });

// Independent occupancy oracle: enumerate actual base cells, not build(),
// visual order, CSS order, or another operation from the production engine.
function assertCells(layout, expectedKeys, context = '') {
    assert.ok(Number.isInteger(layout.columns) && layout.columns > 0, context + ' columns');
    assert.ok(Number.isInteger(layout.rows) && layout.rows > 0, context + ' rows');
    assert.deepEqual(layout.items.map(item => item.key).sort(), [...expectedKeys].sort(), context + ' identities');
    assert.ok(layout.items.filter(item => item.span > 1).length <= 1, context + ' only one focus');
    const occupied = new Set();
    for (const item of layout.items) {
        for (const field of ['row', 'column', 'span']) assert.ok(Number.isInteger(item[field]), context + ' integer ' + field);
        assert.ok(item.row >= 0 && item.column >= 0 && item.span >= 1, context + ' nonnegative cell');
        assert.ok(item.row + item.span <= layout.rows && item.column + item.span <= layout.columns, context + ' bounded ' + item.key);
        for (let row = item.row; row < item.row + item.span; row++) for (let column = item.column; column < item.column + item.span; column++) {
            const at = `${row}:${column}`;
            assert.ok(!occupied.has(at), context + ' collision at ' + at);
            occupied.add(at);
        }
    }
    const span = focusOf(layout)?.span || 1;
    assert.equal(occupied.size, expectedKeys.length + (expectedKeys.length ? span * span - 1 : 0), context + ' occupied area');
    return occupied;
}

function ordinarySlots(columns, focus, count) {
    const result = [];
    for (let row = 0; result.length < count; row++) for (let column = 0; column < columns && result.length < count; column++) {
        const item = { row, column };
        if (!focus || !inside(focus, item)) result.push(position(item));
    }
    return new Set(result);
}
function assertCanonicalSlots(layout, context = '') {
    const focus = focusOf(layout);
    const actual = new Set(layout.items.filter(item => item.span === 1).map(position));
    assert.deepEqual(actual, ordinarySlots(layout.columns, focus, actual.size), context + ' first-free ordinary slots');
}
function touching(layout, source, direction) {
    return layout.items.filter(target => {
        if (target.key === source.key) return false;
        if (direction === 'up' || direction === 'down') return (direction === 'up' ? target.row + target.span === source.row : target.row === source.row + source.span) &&
            target.column < source.column + source.span && target.column + target.span > source.column;
        return (direction === 'left' ? target.column + target.span === source.column : target.column === source.column + source.span) &&
            target.row < source.row + source.span && target.row + target.span > source.row;
    });
}
function reflow(layout, { pending = null, width = 1400, height = 830, preserveColumns = false, keys = visual(layout), focus = focusOf(layout) } = {}) {
    const plan = operations.reflow({ keys, focus, pending }, { count: keys.length, width, height,
        columnGap: 10, rowGap: 10, previous: layout, preserveColumns });
    return { ...plan, next: plan.next.items ? plan.next : { ...plan.next, ...G.build({ keys, columns: plan.next.columns }) } };
}
function layouts() {
    const result = [];
    for (const count of COUNTS.filter(count => count >= 2)) for (const span of SPANS) for (const columns of [span, span + 1, span + 3]) {
        const list = keysFor(count), rows = Math.max(span, Math.ceil((count + span * span - 1) / columns));
        const anchors = new Set([[0, 0], [0, columns - span], [rows - span, 0], [rows - span, columns - span],
            [Math.floor((rows - span) / 2), Math.floor((columns - span) / 2)], [rows + 1, columns - span]].map(value => value.join(':')));
        for (const anchor of anchors) {
            const [row, column] = anchor.split(':').map(Number);
            result.push(G.build({ keys: list, columns, focus: { key: list[Math.floor(count / 2)], span, row, column } }));
        }
    }
    return result;
}

test('boundary matrix: zero/single/tail grids and large corner/edge/interior anchors have unique bounded cells', t => {
    let cases = 0;
    for (const count of COUNTS) for (const columns of [1, 2, 3, 4, 8, 9]) {
        const list = keysFor(count), layout = G.build({ keys: list, columns });
        assertCells(layout, list); assertCanonicalSlots(layout); cases++;
    }
    for (const layout of layouts()) {
        assertCells(layout, layout.items.map(item => item.key)); assertCanonicalSlots(layout); cases++;
    }
    assert.ok(cases > 400); t.diagnostic('boundary coverage ' + JSON.stringify({ group: 'initial-geometries', cases,
        includes: ['zero', 'single', 'partial-tail', 'corners', 'edges', 'interior', 'low-anchor'] }));
});

test('boundary matrix: every selectable large-tile edge moves one cell, including downward steps into partial tails', t => {
    let cases = 0, downward = 0, pinned = 0, blocked = 0;
    for (const candidate of layouts()) {
        const layout = freeze(candidate), list = visual(layout), focus = focusOf(layout), before = JSON.stringify(layout);
        for (const [direction, { axis, delta, reverse }] of Object.entries(DIRECTIONS)) {
            const targets = touching(layout, focus, direction), expected = { ...focus, [axis]: focus[axis] + delta };
            const within = expected.row >= 0 && expected.column >= 0 && expected.row + expected.span <= layout.rows &&
                expected.column + expected.span <= layout.columns;
            for (const target of targets) {
                const plan = operations.step(layout, focus.key, direction, target.key);
                if (!within) { assert.equal(plan.kind, 'none'); assert.equal(plan.next, layout); blocked++; continue; }
                assert.equal(plan.kind, 'step'); assert.deepEqual(cell(plan.next, focus.key), expected);
                assert.equal(plan.next.columns, layout.columns); assert.ok(plan.next.rows <= layout.rows);
                assertCells(plan.next, list); assertCanonicalSlots(plan.next);
                const slots = ordinarySlots(layout.columns, expected, list.length - 1);
                for (const item of layout.items.filter(item => item.span === 1)) if (!inside(expected, item) && slots.has(position(item))) {
                    assert.deepEqual(cell(plan.next, item.key), item, 'uncovered representable peer stays pinned'); pinned++;
                }
                const fromSmall = operations.step(layout, target.key, reverse, focus.key);
                assert.equal(fromSmall.kind, 'step'); assert.deepEqual(canonical(fromSmall.next), canonical(plan.next));
                assert.equal(fromSmall.focusDirection, direction);
                cases++; if (direction === 'down') downward++;
            }
            if (!targets.length) assert.equal(operations.step(layout, focus.key, direction).kind, 'none');
        }
        assert.equal(JSON.stringify(layout), before);
    }
    assert.ok(cases > 300 && downward > 50 && pinned > 1000);
    t.diagnostic('boundary coverage ' + JSON.stringify({ group: 'explicit-edge-targets', cases, downward, pinned, blocked }));
});

test('boundary matrix: a full entering strip exchanges with the freed strip without moving any unrelated peer', t => {
    let cases = 0;
    for (const span of SPANS) {
        const columns = span + 2, rows = span + 2, count = columns * rows - span * span + 1, list = keysFor(count);
        const layout = freeze(G.build({ keys: list, columns, focus: { key: list[0], row: 1, column: 1, span } }));
        assert.equal(layout.rows, rows);
        for (const [direction, { axis, delta, reverse }] of Object.entries(DIRECTIONS)) for (const target of touching(layout, focusOf(layout), direction)) {
            const plan = operations.step(layout, list[0], direction, target.key), moved = cell(plan.next, list[0]);
            assert.equal(plan.kind, 'step'); assert.equal(moved[axis], 1 + delta);
            for (const item of layout.items) {
                const expected = item.key === list[0] ? { ...item, [axis]: item[axis] + delta } :
                    inside(moved, item) ? { ...item, [axis]: item[axis] - delta * span } : item;
                assert.deepEqual(cell(plan.next, item.key), expected);
            }
            const reverseTarget = touching(plan.next, moved, reverse)[0];
            assert.ok(reverseTarget); const restored = operations.step(plan.next, list[0], reverse, reverseTarget.key);
            assert.deepEqual(canonical(restored.next), canonical(layout));
            assertCells(plan.next, list); cases++;
        }
    }
    assert.equal(cases, SPANS.reduce((sum, span) => sum + span * 4, 0));
    t.diagnostic('boundary coverage ' + JSON.stringify({ group: 'complete-strips-and-reversals', cases }));
});

test('boundary matrix: ordinary arrows never wrap a row, bridge a gap, or move the enlarged peer', t => {
    let cases = 0;
    for (const layout of layouts().filter((_, index) => index % 7 === 0)) {
        freeze(layout); const list = visual(layout);
        for (const source of layout.items.filter(item => item.span === 1)) for (const direction of Object.keys(DIRECTIONS)) {
            for (const target of touching(layout, source, direction).filter(item => item.span === 1)) {
                const plan = operations.step(layout, source.key, direction, target.key);
                assert.equal(plan.kind, 'exchange');
                for (const item of layout.items) assert.deepEqual(cell(plan.next, item.key), item.key === source.key ?
                    { ...target, key: source.key } : item.key === target.key ? { ...source, key: target.key } : item);
                assertCells(plan.next, list); cases++;
            }
            const remote = layout.items.find(item => item.key !== source.key && !touching(layout, source, direction).some(target => target.key === item.key));
            if (remote) { const rejected = operations.step(layout, source.key, direction, remote.key); assert.equal(rejected.kind, 'none'); assert.equal(rejected.next, layout); }
        }
    }
    assert.ok(cases > 200); t.diagnostic('boundary coverage ' + JSON.stringify({ group: 'ordinary-exchanges', cases,
        includes: ['wrong-side-rejection', 'remote-target-rejection'] }));
});

test('boundary matrix: remote placement clamps both axes inside existing tracks and keeps representable uncovered peers', t => {
    let cases = 0, down = 0;
    for (const layout of layouts().filter((_, index) => index % 3 === 0)) {
        freeze(layout); const list = visual(layout), focus = focusOf(layout), ordinary = layout.items.filter(item => item.span === 1);
        const candidates = [...new Set([ordinary[0], ordinary.at(-1), ...['row', 'column'].flatMap(axis => [
            ordinary.reduce((a, b) => a[axis] < b[axis] ? a : b), ordinary.reduce((a, b) => a[axis] > b[axis] ? a : b)])])];
        for (const target of candidates) {
            const next = G.relocate(layout, focus.key, target.key);
            const expected = { ...focus, row: Math.min(target.row, layout.rows - focus.span), column: Math.min(target.column, layout.columns - focus.span) };
            assert.deepEqual(cell(next, focus.key), expected); assert.equal(next.columns, layout.columns); assert.ok(next.rows <= layout.rows);
            if (expected.row === focus.row && expected.column === focus.column) assert.equal(next, layout);
            else {
                const slots = ordinarySlots(layout.columns, expected, list.length - 1);
                for (const peer of ordinary) if (!inside(expected, peer) && slots.has(position(peer))) assert.deepEqual(cell(next, peer.key), peer);
                if (expected.row > focus.row) down++;
            }
            assertCells(next, list); assertCanonicalSlots(next); cases++;
        }
    }
    assert.ok(cases > 400 && down > 10); t.diagnostic('boundary coverage ' + JSON.stringify({ group: 'bounded-destinations', cases, lowerPlacements: down }));
});

test('boundary matrix: all four resize corners preserve their opposite corner when it remains representable', t => {
    let cases = 0;
    for (const layout of layouts().filter((_, index) => index % 7 === 0)) {
        freeze(layout); const list = visual(layout), focus = focusOf(layout), before = JSON.stringify(layout);
        for (const span of [1, 2, 4, 8]) for (const corner of ['nw', 'ne', 'sw', 'se']) {
            const next = G.resize(layout, focus.key, span, corner);
            assertCells(next, list); assertCanonicalSlots(next);
            if (span === 1) assert.equal(focusOf(next), null);
            else {
                const expected = { ...focus, span,
                    row: Math.max(0, focus.row + (corner[0] === 'n' ? focus.span - span : 0)),
                    column: Math.max(0, focus.column + (corner[1] === 'w' ? focus.span - span : 0)) };
                assert.deepEqual(cell(next, focus.key), expected);
                if (corner[0] === 'n' && focus.row + focus.span >= span) assert.equal(expected.row + span, focus.row + focus.span);
                if (corner[1] === 'w' && focus.column + focus.span >= span) assert.equal(expected.column + span, focus.column + focus.span);
            }
            cases++;
        }
        assert.equal(JSON.stringify(layout), before);
    }
    assert.ok(cases > 500); t.diagnostic('boundary coverage ' + JSON.stringify({ group: 'corner-size-pairs', cases,
        includes: ['low-anchor', 'bottom-right'] }));
});

test('boundary matrix: a down move followed by drag commit, hidden pane, and visible reflow keeps the exact placement', t => {
    let cases = 0;
    for (const layout of layouts()) {
        const focus = focusOf(layout), target = touching(layout, focus, 'down')[0];
        if (!target) continue;
        const plan = operations.step(freeze(layout), focus.key, 'down', target.key);
        if (plan.kind === 'none') continue;
        const moved = plan.next, state = L.createState({ buildGeometry: G.build }); state.commit(moved);
        state.setPending({ ...moved, intent: 'drag' });
        for (const [width, height] of [[1400, 830], [320, 900], [1, 1], [0, 830], [1400, 0], [0, 0]]) {
            const input = { keys: state.order, focus: state.focus, pending: state.pending };
            const result = operations.reflow(input, { count: state.order.length, width, height,
                previous: state.geometry, columnGap: 10, rowGap: 10 });
            assert.deepEqual(canonical(result.next), canonical(moved));
            assert.equal(Boolean(result.next.deferredFocus), width === 0 || height === 0);
            assert.equal(result.pending === state.pending, width === 0 || height === 0);
            assertCells(result.next, state.order); cases++;
        }
        const stable = reflow(moved, { preserveColumns: true, width: 1399, height: 829 }).next;
        assert.deepEqual(canonical(stable), canonical(moved), 'a preserved-column reflow must not undo the downward placement');
    }
    assert.ok(cases > 200); t.diagnostic('boundary coverage ' + JSON.stringify({ group: 'down-placement-commits', cases,
        panes: ['ordinary', 'narrow', 'tiny', 'hidden'] }));
});

test('boundary matrix: deliberate gaps above low anchors are valid, while slots before the last ordinary peer stay dense', () => {
    const list = keysFor(3), layout = G.build({ keys: list, columns: 5, focus: { key: list[0], row: 7, column: 3, span: 2 } });
    assertCells(layout, list); assertCanonicalSlots(layout);
    assert.equal(layout.rows, 9); assert.deepEqual(cell(layout, list[1]), { key: list[1], row: 0, column: 0, span: 1 });
    assert.deepEqual(cell(layout, list[2]), { key: list[2], row: 0, column: 1, span: 1 });
    assert.ok(layout.rows * layout.columns > list.length + 3, 'a low user anchor intentionally preserves unused tracks');
    const moved = G.relocate(layout, list[0], list[2]);
    assertCells(moved, list); assertCanonicalSlots(moved); assert.equal(focusOf(moved).row, 0);
    assert.ok(moved.rows < layout.rows, 'moving a low focus upwards may reclaim wholly unused bottom rows');
});

test('boundary matrix: focus swaps after lower placement change exactly two occupants and survive canonical reconstruction', t => {
    let cases = 0;
    for (const span of SPANS) {
        const list = keysFor(31), initial = G.build({ keys: list, columns: span + 3, focus: { key: list[0], row: 1, column: 1, span } });
        const targets = touching(initial, focusOf(initial), 'down');
        const lower = targets.length ? operations.step(initial, list[0], 'down', targets[0].key).next : initial;
        const beforeFocus = focusOf(lower);
        for (const target of lower.items.filter(item => item.span === 1)) {
            const plan = operations.swapFocus(freeze(lower), target.key);
            assert.equal(plan.kind, 'swap-focus');
            for (const item of lower.items) {
                const expected = item.key === beforeFocus.key ? { ...target, key: item.key } :
                    item.key === target.key ? { ...beforeFocus, key: item.key } : item;
                assert.deepEqual(cell(plan.next, item.key), expected);
            }
            assert.equal(plan.next.columns, lower.columns); assert.equal(plan.next.rows, lower.rows);
            assertCells(plan.next, list); assertCanonicalSlots(plan.next);
            const restored = G.build(JSON.parse(JSON.stringify({ keys: visual(plan.next), columns: plan.next.columns, focus: focusOf(plan.next) })));
            assert.deepEqual(canonical(restored), canonical(plan.next)); cases++;
        }
    }
    assert.equal(cases, 120); t.diagnostic('boundary coverage ' + JSON.stringify({ group: 'lower-focus-swaps-and-restores', cases }));
});

test('boundary matrix: stale keys, boundaries, and wrong-side commands remain identities on frozen layouts', () => {
    for (const layout of layouts().filter((_, index) => index % 11 === 0)) {
        freeze(layout); const focus = focusOf(layout), list = visual(layout), before = JSON.stringify(layout);
        for (const direction of [...Object.keys(DIRECTIONS), 'diagonal', '__proto__', null]) {
            for (const [source, target] of [[focus.key, 'missing'], ['missing', list[0]], [focus.key, focus.key]]) {
                const plan = operations.step(layout, source, direction, target);
                assert.equal(plan.kind, 'none'); assert.equal(plan.next, layout);
            }
        }
        assert.equal(operations.swapFocus(layout, focus.key).next, layout);
        assert.equal(operations.swapFocus(layout, 'missing').next, layout);
        assert.equal(operations.target(layout, 'missing', list[0]).next, layout);
        assert.equal(operations.target(layout, list[0], 'missing').next, layout);
        assert.equal(JSON.stringify(layout), before);
    }
});

test('boundary matrix: removing the low focus or reducing selection to zero/one drops the inactive enlargement safely', t => {
    let cases = 0;
    for (const count of COUNTS.filter(count => count >= 2)) for (const span of SPANS) {
        const list = keysFor(count), layout = G.build({ keys: list, columns: span + 2,
            focus: { key: list[Math.floor(count / 2)], row: 5, column: 2, span } });
        for (const keys of [[], [list[0]], list.filter(key => key !== focusOf(layout).key)]) {
            const plan = reflow(layout, { keys, pending: { ...layout, intent: 'drag' } });
            assertCells(plan.next, keys); assertCanonicalSlots(plan.next); assert.equal(focusOf(plan.next), null);
            assert.equal(plan.pending, null, 'an inactive focus must not retain a pending drag'); cases++;
        }
    }
    assert.equal(cases, 108); t.diagnostic('boundary coverage ' + JSON.stringify({ group: 'selection-transitions', cases,
        selections: ['empty', 'single', 'removed-focus'] }));
});

test('boundary limits: supported span 256 and row/column 512 remain bounded through corner drags, swaps and visible restore', () => {
    const list = ['boundary-large', 'boundary-a', 'boundary-b'];
    const initial = freeze(G.build({ keys: list, columns: 768,
        focus: { key: list[0], row: 512, column: 512, span: 256 } }));
    // At supported extremes, use rectangle intersection rather than allocating
    // a grid for all empty tracks or visiting every covered base cell.
    function rectangles(layout) {
        assert.deepEqual(layout.items.map(item => item.key).sort(), [...list].sort());
        assert.ok(layout.columns >= 1 && layout.columns <= 768 && layout.rows >= 1 && layout.rows <= 768);
        assert.ok(layout.items.filter(item => item.span > 1).length <= 1);
        for (let a = 0; a < layout.items.length; a++) {
            const item = layout.items[a];
            assert.ok(Number.isInteger(item.row) && item.row >= 0 && item.row <= 512);
            assert.ok(Number.isInteger(item.column) && item.column >= 0 && item.column <= 512);
            assert.ok(Number.isInteger(item.span) && item.span >= 1 && item.span <= 256);
            assert.ok(item.row + item.span <= layout.rows && item.column + item.span <= layout.columns);
            for (const peer of layout.items.slice(a + 1)) assert.ok(item.row + item.span <= peer.row ||
                peer.row + peer.span <= item.row || item.column + item.span <= peer.column || peer.column + peer.span <= item.column,
            'supported extreme rectangles must never overlap');
        }
    }
    rectangles(initial);
    for (const corner of ['nw', 'ne', 'sw', 'se']) for (const span of [1, 2, 255, 256, 1024]) {
        const next = G.resize(initial, list[0], span, corner); rectangles(next);
        assert.equal(cell(next, list[0]).span, Math.min(256, span));
    }
    for (const key of list.slice(1)) rectangles(operations.swapFocus(initial, key).next);
    rectangles(G.relocate(initial, list[0], list[1]));
    assert.deepEqual(canonical(reflow(initial, { pending: { ...initial, intent: 'drag' } }).next), canonical(initial));
    const restored = G.build(JSON.parse(JSON.stringify({ keys: visual(initial), columns: initial.columns, focus: focusOf(initial) })));
    assert.deepEqual(canonical(restored), canonical(initial));
});

test('boundary lifecycle: sparse lower corner-drag intent survives a deferred projection and subsequent small resizes', () => {
        const list = ['boundary-large', 'boundary-a', 'boundary-b'];
        const initial = G.build({ keys: list, columns: 7, focus: { key: list[0], row: 0, column: 1, span: 6 } });
        const dragged = G.resize(initial, list[0], 2, 'nw');
        assert.deepEqual(focusOf(dragged), { key: list[0], row: 4, column: 5, span: 2 }, 'a normal northwest shrink produces this legal sparse anchor');
        const state = L.createState({ buildGeometry: G.build }); state.commit(dragged);
        state.setPending({ ...dragged, intent: 'drag' });
        const hidden = operations.reflow({ keys: state.order, focus: state.focus, pending: state.pending },
            { count: list.length, width: 0, height: 830, previous: state.geometry });
        assert.equal(hidden.next.deferredFocus, true); assert.equal(hidden.pending, state.pending);
        // A hidden projection retains the confirmed sparse tracks as well as
        // the authoritative saved focus and pending drag intent.
        assert.equal(hidden.next.columns, dragged.columns);
        assert.deepEqual(focusOf(hidden.next), focusOf(dragged));
        state.commit(hidden.next); state.setPending(hidden.pending);
        assert.deepEqual(state.focus, focusOf(dragged)); assert.equal(state.pending.columns, dragged.columns);
        const visible = operations.reflow({ keys: state.order, focus: state.focus, pending: state.pending },
            { count: list.length, width: 1400, height: 830, previous: state.geometry });
        assert.deepEqual(canonical(visible.next), canonical(dragged));
        state.commit(visible.next); state.setPending(visible.pending);
        for (const [width, height] of [[1399, 829], [1401, 831], [1400, 830]]) {
            const adjusted = operations.reflow({ keys: state.order, focus: state.focus, pending: state.pending },
                { count: list.length, width, height, previous: state.geometry, preserveColumns: true });
            assert.deepEqual(canonical(adjusted.next), canonical(dragged));
            state.commit(adjusted.next); state.setPending(adjusted.pending);
        }
    });

test('BND-003: a settled sparse lower anchor survives hidden projection followed by the original viewport', t => {
        const list = ['boundary-large', 'boundary-a', 'boundary-b'];
        const initial = G.build({ keys: list, columns: 7, focus: { key: list[0], row: 0, column: 1, span: 6 } });
        const dragged = G.resize(initial, list[0], 2, 'nw');
        assert.deepEqual(focusOf(dragged), { key: list[0], row: 4, column: 5, span: 2 });
        const state = L.createState({ buildGeometry: G.build }); state.commit(dragged);
        state.setPending(null); // The trusted corner drag has already settled.
        const hidden = operations.reflow({ keys: state.order, focus: state.focus, pending: state.pending },
            { count: list.length, width: 0, height: 0, previous: state.geometry });
        assert.equal(hidden.next.deferredFocus, true);
        assert.equal(hidden.next.columns, dragged.columns);
        assert.deepEqual(focusOf(hidden.next), focusOf(dragged),
            'a bookmark captured while hidden must contain the confirmed tracks and focus');
        state.commit(hidden.next); state.setPending(hidden.pending);
        assert.deepEqual(state.focus, focusOf(dragged), 'deferred commit preserves the authoritative anchor initially');
        const visible = operations.reflow({ keys: state.order, focus: state.focus, pending: state.pending },
            { count: list.length, width: 1500, height: 1000, previous: state.geometry, preserveColumns: true });
        state.commit(visible.next); state.setPending(visible.pending);
        t.diagnostic(JSON.stringify({ issue: 'BND-003', intended: { columns: dragged.columns, focus: focusOf(dragged) },
            temporary: { columns: hidden.next.columns, focus: focusOf(hidden.next) },
            revealed: { columns: state.geometry.columns, focus: focusOf(state.geometry) } }));
        assert.deepEqual(canonical(state.geometry), canonical(dragged),
            'returning to the original viewport must restore the settled anchor, rather than adopt provisional hidden tracks');
    });

test('boundary lifecycle: repeated zero-width and zero-height measurements retain sparse anchors and valid bookmark snapshots', () => {
    const list = ['boundary-large', 'boundary-a', 'boundary-b'];
    for (const anchor of [
        { row: 4, column: 5, span: 2, columns: 7 },
        { row: 512, column: 512, span: 256, columns: 768 }
    ]) {
        const initial = G.build({ keys: list, columns: anchor.columns,
            focus: { key: list[0], row: anchor.row, column: anchor.column, span: anchor.span } });
        const state = L.createState({ buildGeometry: G.build }); state.commit(initial);
        for (const [width, height] of [[0, 830], [1400, 0], [0, 0], [0, 830], [1400, 830]]) {
            const before = JSON.stringify(state.geometry);
            const plan = operations.reflow({ keys: state.order, focus: state.focus, pending: state.pending },
                { count: list.length, width, height, previous: state.geometry, preserveColumns: true });
            assert.equal(JSON.stringify(state.geometry), before, 'calculation never mutates the confirmed input');
            assert.equal(plan.next.columns, initial.columns);
            assert.deepEqual(focusOf(plan.next), focusOf(initial));
            assert.equal(Boolean(plan.next.deferredFocus), width === 0 || height === 0);
            // The real app captures bookmark columns/focus from committed
            // geometry. Serializing this projection must keep its exact pose.
            const saved = JSON.parse(JSON.stringify({ columns: plan.next.columns,
                keys: visual(plan.next), focus: focusOf(plan.next) }));
            assert.deepEqual(canonical(G.build(saved)), canonical(initial));
            assert.ok(plan.next.columns <= 768);
            assertCanonicalSlots(plan.next);
            state.commit(plan.next); state.setPending(plan.pending);
        }
        assert.deepEqual(canonical(state.geometry), canonical(initial));
    }
});

test('boundary lifecycle: hidden track preservation stays within the supported schema limit', () => {
    const list = ['boundary-large', 'boundary-a'];
    const focus = { key: list[0], row: 512, column: 512, span: 256 };
    const previous = G.build({ keys: list, columns: 768, focus });
    for (const columns of [768, 769, 10000]) {
        const pending = { columns, intent: 'drag' };
        const result = operations.reflow({ keys: list, focus, pending },
            { count: list.length, width: 0, height: 0, previous });
        assert.equal(result.next.columns, 768);
        assert.deepEqual(focusOf(result.next), focus);
        assert.equal(result.pending, pending);
        assert.equal(result.next.deferredFocus, true);
    }
});

test('boundary sequences: deterministic mixed operations keep identity, occupancy, bounded tracks and replayable failures', t => {
    const seeds = [0x10adbeef, 0x26b0700d, 0x1234abcd, 0x7fffffff];
    const totals = { actions: 0, grow: 0, shrink: 0, corner: 0, step: 0, target: 0, swapFocus: 0, selection: 0, viewport: 0, restore: 0 };
    for (const seed of seeds) {
        let state = seed >>> 0, nextKey = 100;
        const random = maximum => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return maximum ? state % maximum : 0; };
        let list = keysFor(17), layout = G.build({ keys: list, columns: 5, focus: { key: list[0], row: 2, column: 2, span: 3 } });
        const trace = [];
        for (let index = 0; index < 200; index++) {
            const operation = random(9), before = JSON.stringify(layout), focus = focusOf(layout);
            freeze(layout); let next = layout;
            const action = { seed: '0x' + seed.toString(16), index, operation };
            try {
                if (operation === 0 && list.length) {
                    const key = focus?.key || list[random(list.length)];
                    next = focus?.span >= 8 ? G.shrink(layout, key) : G.grow(layout, key);
                    next = reflow(next, { pending: { ...next, intent: 'size' }, width: 320 + random(1600), height: 240 + random(900) }).next;
                    totals.grow++;
                } else if (operation === 1 && focus) {
                    next = G.shrink(layout, focus.key); next = reflow(next, { pending: { ...next, intent: 'size' } }).next; totals.shrink++;
                } else if (operation === 2 && list.length) {
                    const key = focus?.key || list[random(list.length)], span = 1 + random(8), corner = ['nw', 'ne', 'sw', 'se'][random(4)];
                    Object.assign(action, { key, span, corner }); next = G.resize(layout, key, span, corner);
                    next = reflow(next, { pending: { ...next, intent: 'drag' }, width: 300, height: 900 }).next; totals.corner++;
                } else if (operation === 3 && focus) {
                    const direction = Object.keys(DIRECTIONS)[random(4)], targets = touching(layout, focus, direction), target = targets[random(targets.length)];
                    Object.assign(action, { direction, target: target?.key }); const plan = operations.step(layout, focus.key, direction, target?.key);
                    next = plan.next;
                    if (plan.kind === 'step') {
                        const expected = { ...focus, [DIRECTIONS[direction].axis]: focus[DIRECTIONS[direction].axis] + DIRECTIONS[direction].delta };
                        assert.deepEqual(cell(next, focus.key), expected);
                        next = reflow(next, { pending: { ...next, intent: 'drag' } }).next;
                        assert.deepEqual(cell(next, focus.key), expected, 'drag commit must not change the step anchor');
                    }
                    totals.step++;
                } else if (operation === 4 && focus && list.length > 1) {
                    const target = layout.items.filter(item => item.span === 1)[random(list.length - 1)];
                    action.target = target.key; next = operations.target(layout, focus.key, target.key).next;
                    next = reflow(next, { pending: { ...next, intent: 'drag' } }).next; totals.target++;
                } else if (operation === 5 && focus && list.length > 1) {
                    const target = layout.items.filter(item => item.span === 1)[random(list.length - 1)];
                    action.target = target.key; next = operations.swapFocus(layout, target.key).next; totals.swapFocus++;
                } else if (operation === 6) {
                    list = list.filter(() => random(5) !== 0);
                    if (list.length > 62) list = list.slice(0, 60);
                    for (let add = random(4); add > 0; add--) list.push('boundary-added-' + nextKey++);
                    next = reflow(layout, { keys: list, width: 700, height: 900 }).next; totals.selection++;
                } else if (operation === 7) {
                    const width = [0, 1, 300, 1400, 1920][random(5)], height = [0, 1, 300, 830, 1200][random(5)];
                    Object.assign(action, { width, height }); next = reflow(layout, { width, height }).next; totals.viewport++;
                } else {
                    next = G.build(JSON.parse(JSON.stringify({ keys: visual(layout), columns: layout.columns, focus })));
                    assert.deepEqual(canonical(next), canonical(layout)); totals.restore++;
                }
                assert.equal(JSON.stringify(layout), before, 'operation mutated its frozen input');
                assertCells(next, list); assertCanonicalSlots(next); totals.actions++;
                layout = next; trace.push(action); if (trace.length > 20) trace.shift();
            } catch (error) {
                error.message += '\nREPLAY ' + JSON.stringify({ seed: action.seed, index, action, preceding: trace, before: JSON.parse(before) });
                throw error;
            }
        }
    }
    assert.equal(totals.actions, 800);
    for (const [name, count] of Object.entries(totals)) assert.ok(count > 0, name + ' must be exercised');
    t.diagnostic('boundary coverage ' + JSON.stringify({ group: 'seeded-mixed-sequences', ...totals }));
});
