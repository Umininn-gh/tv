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

function fixture({ fallback = false, stabilizeResize = false, getResizeStability = () => false, calculate = choose,
    width = 1400, height = 900 } = {}) {
    let clock = 0, next = 0, count = 6, deliveries = 0, changes = 0;
    const timers = new Map(), events = new Map();
    const properties = new Map();
    const calculations = [];
    const pane = { clientWidth: width, clientHeight: height,
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
    const controller = observe(pane, { getCount: () => count, stabilizeResize, getResizeStability,
        calculate(options) { calculations.push(options); return calculate(options); },
        onChange: () => changes++ });
    function resize(width, height) {
        Object.assign(pane, { clientWidth: width, clientHeight: height });
        if (fallback) events.get('resize')?.();
        else if (observed) { deliveries++; callback(); }
    }
    function advance(ms) {
        clock += ms;
        for (const [id, timer] of [...timers]) if (timer.due <= clock) { timers.delete(id); timer.fn(); }
    }
    return { pane, controller, resize, advance, events, view, timers, properties, calculations,
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

test('preserveColumns keeps valid tracks while recalculating count, rows and contained area', () => {
    const previous = grid(6, 1400, 900);
    const preserved = grid(7, 1800, 500, { previous, preserveColumns: true, force: true });
    assert.equal(preserved.columns, previous.columns);
    assert.equal(preserved.count, 7);
    assert.equal(preserved.rows, 4);
    assert.ok(preserved.area > 0);
    assert.notEqual(preserved.area, previous.area);
    assert.notEqual(grid(7, 1800, 500, { force: true }).columns, preserved.columns);
    assert.deepEqual(grid(7, 1800, 500, { previous: { columns: 99 }, preserveColumns: true }),
        grid(7, 1800, 500));
});

const lastCalculation = f => f.calculations[f.calculations.length - 1];
const resizeAndFlush = (f, width, height) => { f.resize(width, height); f.advance(180); };

test('opt-in stability preserves a one-pixel round trip and still calculates each measurement', () => {
    // This boundary changes the optimal grid after a single pixel. A consumer
    // may optimize eagerly while relying on the observer's explicit hint.
    const f = fixture({ stabilizeResize: true, width: 1228, height: 700,
        calculate: options => choose({ ...options, force: true }) });
    f.controller.update();
    assert.equal(f.controller.getColumns(), 2);
    assert.equal(lastCalculation(f).preserveColumns, false);
    resizeAndFlush(f, 1229, 701);
    assert.equal(f.controller.getColumns(), 2);
    assert.equal(lastCalculation(f).preserveColumns, true);
    resizeAndFlush(f, 1228, 700);
    assert.equal(f.controller.getColumns(), 2);
    assert.equal(lastCalculation(f).preserveColumns, true);
    assert.equal(f.calculations.length, 3);
    const defaultObserver = fixture({ width: 1228, height: 700,
        calculate: options => choose({ ...options, force: true }) });
    defaultObserver.controller.update();
    resizeAndFlush(defaultObserver, 1229, 700);
    assert.equal(lastCalculation(defaultObserver).preserveColumns, false);
    assert.equal(defaultObserver.controller.getColumns(), 3);
});

test('small resize steps stay anchored until their cumulative change exceeds the reference band', () => {
    const f = fixture({ stabilizeResize: true, width: 100, height: 100 });
    f.controller.update();
    for (let width = 101; width <= 105; width++) {
        resizeAndFlush(f, width, 100);
        assert.equal(lastCalculation(f).preserveColumns, true, `width ${width}`);
    }
    resizeAndFlush(f, 106, 100);
    assert.equal(lastCalculation(f).preserveColumns, false);
    resizeAndFlush(f, 110, 100);
    assert.equal(lastCalculation(f).preserveColumns, true, 'significant measurements establish a new reference');
    resizeAndFlush(f, 112, 100);
    assert.equal(lastCalculation(f).preserveColumns, false);
    assert.equal(f.calculations.length, 9);
});

test('both dimensions must stay in their own bands, including minimum and maximum pixel limits', () => {
    const f = fixture({ stabilizeResize: true, width: 20, height: 2000 });
    f.controller.update();
    resizeAndFlush(f, 22, 2032);
    assert.equal(lastCalculation(f).preserveColumns, true, 'minimum 2px and maximum 32px boundaries are inclusive');
    resizeAndFlush(f, 23, 2032);
    assert.equal(lastCalculation(f).preserveColumns, false, 'width alone can exceed its band');
    resizeAndFlush(f, 23, 2064);
    assert.equal(lastCalculation(f).preserveColumns, true);
    resizeAndFlush(f, 23, 2065);
    assert.equal(lastCalculation(f).preserveColumns, false, 'height alone can exceed its band');
});

test('explicit force and count changes override a small resize and reset its reference', () => {
    const f = fixture({ stabilizeResize: true, width: 100, height: 100 });
    f.controller.update();
    resizeAndFlush(f, 104, 100);
    assert.equal(lastCalculation(f).preserveColumns, true);
    f.controller.update({ force: true });
    assert.equal(lastCalculation(f).force, true);
    assert.equal(lastCalculation(f).preserveColumns, false);
    resizeAndFlush(f, 108, 100);
    assert.equal(lastCalculation(f).preserveColumns, true, 'explicit force reset the width reference to 104');
    f.setCount(7);
    assert.equal(lastCalculation(f).force, true);
    assert.equal(lastCalculation(f).preserveColumns, false);
    resizeAndFlush(f, 112, 100);
    assert.equal(lastCalculation(f).preserveColumns, true, 'count changes reset the width reference to 108');
    assert.equal(lastCalculation(f).count, 7);
});

test('small measurements still apply logical geometry changes without an explicit force', () => {
    let span = 1;
    const f = fixture({ stabilizeResize: true, calculate: options => ({ ...choose(options),
        items: [{ key: 'focus', row: 0, column: 0, span }] }) });
    f.controller.update();
    const changed = f.changes;
    span = 2;
    f.controller.update();
    assert.equal(lastCalculation(f).preserveColumns, true);
    assert.equal(lastCalculation(f).force, false);
    assert.equal(f.changes, changed + 1);
    assert.equal(f.calculations.length, 2);
});

test('hidden measurements retain the positive reference and defer hidden force until visible', () => {
    const f = fixture({ stabilizeResize: true, width: 100, height: 100 });
    f.controller.update();
    const columns = f.controller.getColumns();
    resizeAndFlush(f, 0, 0);
    assert.equal(f.controller.getColumns(), columns);
    assert.equal(lastCalculation(f).preserveColumns, true);
    resizeAndFlush(f, 104, 100);
    assert.equal(lastCalculation(f).preserveColumns, true, 'zero size did not overwrite the 100px reference');
    resizeAndFlush(f, 0, 100);
    f.controller.update({ force: true });
    assert.equal(lastCalculation(f).force, true);
    assert.equal(lastCalculation(f).preserveColumns, true);
    f.controller.update();
    assert.equal(lastCalculation(f).force, true, 'hidden force stays pending across additional hidden measurements');
    resizeAndFlush(f, 104, 100);
    assert.equal(lastCalculation(f).force, true);
    assert.equal(lastCalculation(f).preserveColumns, false);
    f.controller.update();
    assert.equal(lastCalculation(f).force, false);
    assert.equal(lastCalculation(f).preserveColumns, true);
    resizeAndFlush(f, 108, 100);
    assert.equal(lastCalculation(f).preserveColumns, true, 'visible force established the new reference at 104');
});

test('initial hidden state, hidden count changes and page lifecycle force a useful fresh measurement', () => {
    const f = fixture({ stabilizeResize: true, width: 0, height: 0 });
    f.controller.update();
    assert.equal(lastCalculation(f).force, true);
    assert.equal(lastCalculation(f).preserveColumns, false);
    f.setCount(10);
    assert.equal(lastCalculation(f).force, true);
    assert.equal(lastCalculation(f).preserveColumns, true);
    resizeAndFlush(f, 1400, 900);
    assert.equal(lastCalculation(f).force, true);
    assert.equal(lastCalculation(f).preserveColumns, false);
    const calls = f.calculations.length;
    f.resize(0, 0);
    f.events.get('pagehide')();
    f.advance(180);
    assert.equal(f.calculations.length, calls, 'pagehide cancelled the scheduled hidden measurement');
    f.controller.update({ force: true });
    assert.equal(f.calculations.length, calls, 'suspended panes wait until pageshow');
    f.events.get('pageshow')();
    assert.equal(lastCalculation(f).force, true);
    assert.equal(lastCalculation(f).preserveColumns, true);
    resizeAndFlush(f, 1401, 901);
    assert.equal(lastCalculation(f).force, true);
    assert.equal(lastCalculation(f).preserveColumns, false);
    f.controller.update();
    assert.equal(lastCalculation(f).force, false);
    assert.equal(lastCalculation(f).preserveColumns, true);
    f.controller.destroy();
    assert.equal(f.events.size, 0);
    assert.equal(f.timers.size, 0);
});

test('deferred focus transitions notify once even when tracks, item positions and gaps stay identical', () => {
    const f = fixture({ stabilizeResize: true, width: 0, height: 0,
        calculate: options => ({ count: options.count, columns: 2, rows: 3,
            items: [{ key: 'focus', row: 0, column: 0, span: 2 }],
            deferredFocus: options.width > 0 && options.height > 0 ? undefined : true }) });
    f.view.getComputedStyle = () => ({ rowGap: '0px', columnGap: '0px',
        paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px' });
    f.controller.update();
    assert.equal(f.changes, 1);
    f.controller.update();
    assert.equal(f.changes, 1);
    resizeAndFlush(f, 100, 100);
    assert.equal(f.changes, 2, 'revealing a deferred focus must commit its visible anchor');
    f.controller.update();
    assert.equal(f.changes, 2, 'unchanged visible state must not notify again');
    resizeAndFlush(f, 100, 0);
    assert.equal(f.changes, 3);
    f.controller.update();
    assert.equal(f.changes, 3, 'unchanged hidden state must not notify again');
    resizeAndFlush(f, 100, 100);
    assert.equal(f.changes, 4);
    f.controller.update();
    assert.equal(f.changes, 4);
    assert.equal(f.calculations.length, 8);
});

test('enlargement stability retains a manual grid during proportional scaling and small aspect changes', () => {
    const f = fixture({ width: 1000, height: 1000, getResizeStability: () => true,
        calculate: options => !options.previous ? { count: options.count, columns: 5, rows: 2 } :
            choose({ ...options, force: true }) });
    f.controller.update();
    assert.equal(f.controller.getColumns(), 5);
    for (const [width, height] of [[3000, 3000], [500, 500], [1140, 1000]]) {
        resizeAndFlush(f, width, height);
        assert.equal(lastCalculation(f).preserveColumns, true);
        assert.equal(f.controller.getColumns(), 5, 'manual columns need not be the optimal layout');
    }
    assert.equal(f.timers.size, 0);
    f.controller.destroy();
});

test('enlargement aspect boundaries are inclusive on either side and ignore the old 32px limit', () => {
    const f = fixture({ width: 1000, height: 1000, stabilizeResize: true,
        getResizeStability: () => true,
        calculate: options => ({ count: options.count, columns: 2, rows: 3 }) });
    f.controller.update();
    for (const [width, expected] of [[1033, true], [1150, true], [1151, false], [850, true], [849, false]]) {
        resizeAndFlush(f, width, 1000);
        assert.equal(lastCalculation(f).preserveColumns, expected, `width ${width}`);
    }
    resizeAndFlush(f, 1000, 2000);
    assert.equal(lastCalculation(f).preserveColumns, false, 'a portrait transition can optimize');
    f.controller.destroy();
});

test('failed optimization keeps the adopted aspect anchor across cumulative out-of-band measurements', () => {
    const f = fixture({ width: 1000, height: 1000, getResizeStability: () => true,
        calculate: options => ({ count: options.count, columns: 2, rows: 3 }) });
    f.controller.update();
    for (const width of [1140, 1150]) {
        resizeAndFlush(f, width, 1000);
        assert.equal(lastCalculation(f).preserveColumns, true);
    }
    for (const width of [1160, 1170, 1200]) {
        resizeAndFlush(f, width, 1000);
        assert.equal(lastCalculation(f).preserveColumns, false,
            'an unchanged topology cannot re-arm the band at its latest measurement');
    }
    resizeAndFlush(f, 1100, 1000);
    assert.equal(lastCalculation(f).preserveColumns, true, 'returning to the adopted aspect is still stable');
    f.controller.destroy();
});

test('an adopted topology establishes a new aspect anchor, including item-only geometry changes', () => {
    let columns = 2, row = 0;
    const f = fixture({ width: 1000, height: 1000, getResizeStability: () => true,
        calculate: options => ({ count: options.count, columns, rows: Math.ceil(options.count / columns),
            items: [{ key: 'focus', row, column: 0, span: 2 }] }) });
    f.controller.update();
    columns = 3;
    resizeAndFlush(f, 1200, 1000);
    assert.equal(lastCalculation(f).preserveColumns, false);
    resizeAndFlush(f, 1350, 1000);
    assert.equal(lastCalculation(f).preserveColumns, true);
    row = 1;
    f.controller.update();
    resizeAndFlush(f, 1500, 1000);
    assert.equal(lastCalculation(f).preserveColumns, true,
        'the new focus position adopted at 1350 supplies the reference');
    f.controller.destroy();
});

test('explicit force and count changes reset enlargement stability without waiting for a ratio change', () => {
    const f = fixture({ width: 1000, height: 1000, getResizeStability: () => true,
        calculate: options => ({ count: options.count, columns: 2, rows: Math.ceil(options.count / 2) }) });
    f.controller.update();
    resizeAndFlush(f, 1100, 1000);
    f.controller.update({ force: true });
    assert.equal(lastCalculation(f).preserveColumns, false);
    assert.equal(lastCalculation(f).force, true);
    resizeAndFlush(f, 1250, 1000);
    assert.equal(lastCalculation(f).preserveColumns, true);
    f.setCount(7);
    assert.equal(lastCalculation(f).force, true);
    assert.equal(lastCalculation(f).preserveColumns, false);
    resizeAndFlush(f, 1430, 1000);
    assert.equal(lastCalculation(f).preserveColumns, true);
    resizeAndFlush(f, 1440, 1000);
    assert.equal(lastCalculation(f).preserveColumns, false);
    f.controller.destroy();
});

test('enlargement hidden and page lifecycle measurements retain the positive anchor and pending force', () => {
    const f = fixture({ width: 1000, height: 1000, getResizeStability: () => true });
    f.controller.update();
    resizeAndFlush(f, 0, 0);
    resizeAndFlush(f, 1120, 1000);
    assert.equal(lastCalculation(f).preserveColumns, true);
    resizeAndFlush(f, 0, 1000);
    f.events.get('pagehide')();
    f.controller.update({ force: true });
    f.events.get('pageshow')();
    assert.equal(lastCalculation(f).force, true);
    resizeAndFlush(f, 1120, 1000);
    assert.equal(lastCalculation(f).force, true);
    assert.equal(lastCalculation(f).preserveColumns, false);
    resizeAndFlush(f, 1240, 1000);
    assert.equal(lastCalculation(f).preserveColumns, true);
    f.controller.destroy();
    assert.equal(f.timers.size, 0);
    assert.equal(f.events.size, 0);
});

test('inactive or dormant enlargement keeps normal resize behavior and can activate without a stale anchor', () => {
    let active = false;
    const f = fixture({ width: 1000, height: 1000, stabilizeResize: true,
        getResizeStability: () => active,
        calculate: options => ({ count: options.count, columns: 2, rows: 3 }) });
    f.controller.update();
    resizeAndFlush(f, 1040, 1000);
    assert.equal(lastCalculation(f).preserveColumns, false, 'normal 32px band is unchanged');
    active = true;
    f.controller.update();
    resizeAndFlush(f, 1180, 1000);
    assert.equal(lastCalculation(f).preserveColumns, true);
    active = false;
    resizeAndFlush(f, 1220, 1000);
    assert.equal(lastCalculation(f).preserveColumns, false);
    active = true;
    f.controller.update();
    resizeAndFlush(f, 1380, 1000);
    assert.equal(lastCalculation(f).preserveColumns, true, 'reactivation starts with the current adopted shape');
    f.controller.destroy();
});

test('enlargement aspect gating and focused eighteen-percent gain work together', () => {
    const geometry = require('../player-geometry.js');
    const list = Array.from({ length: 6 }, (_, index) => `player-${index}`);
    const focus = { key: list[0], span: 2, row: 0, column: 0 };
    const f = fixture({ width: 700, height: 700, getResizeStability: () => true,
        calculate(options) {
            const next = !options.previous || options.preserveColumns ? geometry.build({ keys: list,
                columns: options.previous?.columns || 2, focus }) : geometry.choose({ ...options, keys: list, focus });
            return { ...next, count: options.count };
        } });
    f.controller.update();
    resizeAndFlush(f, 780, 700);
    assert.equal(f.controller.getColumns(), 2);
    assert.equal(lastCalculation(f).preserveColumns, true);
    resizeAndFlush(f, 815, 700);
    assert.equal(lastCalculation(f).preserveColumns, false);
    assert.equal(f.controller.getColumns(), 3);
    resizeAndFlush(f, 920, 700);
    assert.equal(lastCalculation(f).preserveColumns, true);
    assert.equal(f.controller.getColumns(), 3);
    f.controller.destroy();
});
