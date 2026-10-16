'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { choose, observe } = require('../player-layout.js');

const grid = (count, width = 1400, height = 900, extra = {}) =>
    choose({ count, width, height, columnGap: 10, rowGap: 10, ...extra });

test('uses pane shape rather than the square root of the count', () => {
    assert.equal(grid(6).columns, 2);
    assert.equal(grid(6, 1800, 500).columns, 3);
    assert.equal(grid(6, 380, 700).columns, 1);
    assert.equal(grid(10).columns, 3);
    assert.equal(grid(20).columns, 4);
});

test('every count fits, without a fixed minimum size or cropping', () => {
    for (const count of [1, 2, 5, 6, 10, 17, 20, 50, 100]) {
        for (const [width, height] of [[1920, 900], [900, 900], [380, 450], [380, 10]]) {
            const chosen = grid(count, width, height);
            assert.ok(chosen.columns * chosen.rows >= count);
            assert.equal(chosen.rows, Math.ceil(count / chosen.columns));
            const cellWidth = Math.max(0, (width - (chosen.columns - 1) * 10) / chosen.columns);
            const cellHeight = Math.max(0, (height - (chosen.rows - 1) * 10) / chosen.rows);
            assert.ok(chosen.area <= cellWidth * cellHeight + 0.001);
            assert.ok(Number.isFinite(chosen.area));
        }
    }
});

test('scores contained video area, actual gaps and empty-slot ties', () => {
    const a = grid(6), oldVideoArea = Math.pow((1400 - 20) / 3, 2) / (16 / 9);
    assert.ok(a.area > oldVideoArea * 1.28);
    assert.notEqual(grid(6, 900, 450, { columnGap: 100 }).area,
        grid(6, 900, 450, { columnGap: 0 }).area);
    // Identical per-video area: favour the grid without an unnecessary row.
    assert.deepEqual(grid(2, 1600, 900, { columnGap: 0, rowGap: 0 }),
        { count: 2, columns: 1, rows: 2, area: 360000 });
});

test('small fluctuations retain the adopted grid; meaningful improvement switches it', () => {
    const previous = grid(6, 1200, 700);
    const borderline = grid(6, 1250, 700, { previous });
    const raw = grid(6, 1250, 700, { force: true });
    assert.notEqual(raw.columns, previous.columns);
    assert.equal(borderline.columns, previous.columns);
    assert.ok(raw.area <= borderline.area * 1.06);
    const large = grid(6, 1800, 500, { previous });
    assert.equal(large.columns, 3);
});

test('zero or hidden panes retain columns until a usable measurement, including count changes', () => {
    assert.deepEqual(grid(0), { count: 0, columns: 1, rows: 1, area: 0 });
    const previous = grid(6);
    assert.equal(grid(6, 0, 900, { previous }).columns, 2);
    assert.equal(grid(10, 0, 900, { previous }).rows, 5);
    assert.equal(grid(1, 0, 0, { previous }).columns, 1);
    assert.ok(Number.isFinite(grid(20, 0, 0).rows));
});

function fixture({ fallback = false } = {}) {
    let clock = 0, next = 0, count = 6, deliveries = 0, changes = 0;
    const timers = new Map(), events = new Map();
    const properties = new Map();
    const pane = { clientWidth: 1400, clientHeight: 900,
        style: { setProperty: (name, value) => properties.set(name, value) } };
    const view = {
        getComputedStyle: () => ({ rowGap: `${Math.min(10, parseFloat(properties.get('--player-grid-gap-y-limit') || '10'))}px`,
            columnGap: `${Math.min(10, parseFloat(properties.get('--player-grid-gap-x-limit') || '10'))}px`,
            paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px' }),
        addEventListener: (type, fn) => events.set(type, fn),
        removeEventListener: type => events.delete(type),
        setTimeout(fn, ms) { const id = ++next; timers.set(id, { fn, due: clock + ms }); return id; },
        clearTimeout: id => timers.delete(id)
    };
    let callback, observed = false;
    if (!fallback) view.ResizeObserver = class {
        constructor(fn) { callback = fn; }
        observe(target) { assert.equal(target, pane); observed = true; }
        disconnect() { observed = false; }
    };
    pane.ownerDocument = { defaultView: view };
    const controller = observe(pane, { getCount: () => count, onChange: () => changes++ });
    function resize(width, height) {
        Object.assign(pane, { clientWidth: width, clientHeight: height });
        if (fallback) events.get('resize')?.();
        else if (observed) { deliveries++; callback(); }
    }
    function advance(ms) {
        clock += ms;
        for (const [id, timer] of [...timers]) if (timer.due <= clock) { timers.delete(id); timer.fn(); }
    }
    return { pane, controller, resize, advance, events, view, timers, properties,
        setCount(value) { count = value; controller.update(); },
        get changes() { return changes; }, get deliveries() { return deliveries; }, get observed() { return observed; } };
}

for (const fallback of [false, true]) {
    test(`${fallback ? 'window fallback' : 'pane observer'} debounces resize and never polls a stable pane`, () => {
        const f = fixture({ fallback });
        f.controller.update(); assert.equal(f.controller.getColumns(), 2);
        assert.equal(f.changes, 1); assert.equal(f.timers.size, 0);
        for (let i = 0; i < 10; i++) { f.resize(1800 + i, 500); f.advance(30); }
        assert.equal(f.changes, 1); assert.equal(f.timers.size, 1);
        f.advance(180);
        assert.equal(f.controller.getColumns(), 3); assert.equal(f.changes, 2);
        f.advance(60000); assert.equal(f.changes, 2); assert.equal(f.timers.size, 0);
        // Track changes don't write pane dimensions, flex, child order or sources.
        assert.deepEqual(Object.keys(f.pane.style).sort(), ['gridTemplateColumns', 'gridTemplateRows', 'setProperty']);
        f.controller.destroy(); assert.equal(f.events.size, 0);
    });
}

test('count updates immediately; page lifecycle and dispose cancel outstanding work', () => {
    const f = fixture();
    f.controller.update();
    f.resize(1800, 500);
    f.setCount(10);
    assert.equal(f.timers.size, 0); assert.equal(f.controller.getColumns(), 5);
    f.resize(380, 700);
    f.events.get('pagehide')();
    assert.equal(f.timers.size, 0); assert.equal(f.observed, false);
    f.advance(5000); assert.equal(f.controller.getColumns(), 5);
    f.events.get('pageshow')();
    assert.equal(f.observed, true); assert.equal(f.controller.getColumns(), 2);
    f.resize(1800, 500); f.controller.destroy();
    assert.equal(f.timers.size, 0); assert.equal(f.observed, false); assert.equal(f.events.size, 0);
    f.controller.update(); assert.equal(f.controller.getColumns(), 2);
});

test('gaps shrink in tiny panes, recover afterwards, and also refresh the editor without a column change', () => {
    const f = fixture();
    f.controller.update();
    f.setCount(100); f.resize(260, 8); f.advance(180);
    const style = f.view.getComputedStyle(f.pane);
    const columns = f.controller.getColumns(), rows = Math.ceil(100 / columns);
    assert.ok(parseFloat(style.columnGap) * (columns - 1) < 260);
    assert.ok(parseFloat(style.rowGap) * (rows - 1) < 8);
    f.resize(1400, 900); f.advance(180); f.setCount(6);
    assert.equal(f.view.getComputedStyle(f.pane).columnGap, '10px');
    assert.equal(f.view.getComputedStyle(f.pane).rowGap, '10px');
    f.setCount(100); f.resize(260, 8); f.advance(180);
    const previousChanges = f.changes;
    f.resize(261, 8); f.advance(180);
    assert.equal(f.changes, previousChanges + 1);
    f.controller.destroy();
});
