'use strict';

const assert = require('node:assert/strict');

// Independent small-layout oracle. It deliberately does not import either
// production solver. A compact occupied prefix has no holes before its last
// used row-major slot; unused cells after that prefix are harmless.
const find = (layout, key) => layout.items.find(item => item.key === key);
function dockEdges(layout, key) {
    const item = find(layout, key);
    assert.ok(item, 'the docking source exists');
    return { left: item.column === 0, right: item.column > 0 && item.column + item.span === layout.columns,
        top: item.row === 0, bottom: item.row > 0 && item.row + item.span === layout.rows };
}
function prefixHoles(layout) {
    const area = layout.items.reduce((sum, item) => sum + item.span * item.span, 0);
    const end = layout.items.reduce((maximum, item) =>
        Math.max(maximum, (item.row + item.span - 1) * layout.columns + item.column + item.span), 0);
    return end - area;
}
function dockScore(layout, key, docks) {
    const item = find(layout, key);
    return Number(docks.left && item.column === 0) +
        Number(docks.right && item.column + item.span === layout.columns) +
        Number(docks.top && item.row === 0) +
        Number(docks.bottom && item.row + item.span === layout.rows);
}
function maximumDockScore({ count, span, docks, columns } = {}) {
    const area = count + span * span - 1;
    let best = -1;
    const first = columns || span, last = columns || span + count - 1;
    for (let width = first; width <= last; width++) {
        if (width < span) continue;
        const rows = Math.ceil(area / width);
        for (let row = 0; row + span <= rows; row++) {
            // The final square cell must be inside the occupied prefix. Every
            // other prefix slot can hold exactly one of the count-1 small tiles.
            const maxColumn = Math.min(width - span, area - (row + span - 1) * width - span);
            for (let column = 0; column <= maxColumn; column++) {
                const candidate = { columns: width, rows, items: [{ key: 'focus', span, row, column }] };
                best = Math.max(best, dockScore(candidate, 'focus', docks));
            }
        }
    }
    assert.ok(best >= 0, 'at least one compact placement is feasible');
    return best;
}
function assertCompact(layout) {
    assert.ok(Number.isInteger(layout.columns) && layout.columns > 0);
    assert.ok(Number.isInteger(layout.rows) && layout.rows > 0);
    assert.equal(new Set(layout.items.map(item => item.key)).size, layout.items.length, 'each player appears once');
    assert.ok(layout.items.filter(item => item.span > 1).length <= 1);
    const occupied = new Set();
    for (const item of layout.items) {
        for (const field of ['row', 'column', 'span']) assert.ok(Number.isInteger(item[field]));
        assert.ok(item.row >= 0 && item.column >= 0 && item.span > 0);
        assert.ok(item.column + item.span <= layout.columns && item.row + item.span <= layout.rows);
        for (let row = item.row; row < item.row + item.span; row++) for (let column = item.column; column < item.column + item.span; column++) {
            const slot = row * layout.columns + column;
            assert.equal(occupied.has(slot), false, 'players cannot overlap'); occupied.add(slot);
        }
    }
    assert.equal(prefixHoles(layout), 0, 'unused cells must follow every occupied slot, never interrupt the grid');
}
function assertBestDocking(before, after, key) {
    const docks = dockEdges(before, key), span = find(after, key).span;
    assertCompact(after);
    const expected = maximumDockScore({ count: after.items.length, span, docks,
        ...(span === 1 ? { columns: after.columns } : {}) });
    assert.equal(dockScore(after, key, docks), expected, 'keep as many original edges as a compact placement permits');
}

module.exports = { dockEdges, prefixHoles, dockScore, maximumDockScore, assertCompact, assertBestDocking };
