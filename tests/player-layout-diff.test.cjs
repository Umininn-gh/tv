'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = name => require(fs.existsSync(path.join(__dirname, '../site/assets/js', name + '.js')) ?
    path.join(__dirname, '../site/assets/js', name + '.js') : path.join(__dirname, '..', name + '.js'));
const L = source('player-layout'), G = source('player-geometry');
const keys = count => Array.from({ length: count }, (_, index) => 'player-' + index);

test('cell comparison ignores scores, object insertion order and equivalent item array order', () => {
    const initial = G.build({ keys: keys(5), columns: 3 });
    const equivalent = { ...initial, area: 1000, score: -999, count: 5, items: [...initial.items].reverse().map(item =>
        ({ span: item.span, column: item.column, row: item.row, key: item.key })) };
    assert.deepEqual(L.compare(initial, equivalent), { columnsChanged: false, rowsChanged: false, cellsChanged: false,
        deferredChanged: false, changedKeys: [], removedKeys: [], topologyChanged: false, changed: false });
    assert.equal(L.compare(initial, { ...equivalent, deferredFocus: true }).topologyChanged, false);
    assert.equal(L.compare(initial, { ...equivalent, deferredFocus: true }).deferredChanged, true);
});

test('cell comparison detects replacement, movement, sizing, removed keys and changed tracks independently', () => {
    const initial = G.build({ keys: keys(5), columns: 3 });
    const moved = G.build({ keys: ['player-1', 'player-0', ...keys(5).slice(2)], columns: 3 });
    assert.deepEqual(L.compare(initial, moved).changedKeys.sort(), ['player-0', 'player-1']);
    assert.equal(L.compare(initial, moved).columnsChanged, false);
    const next = { ...initial, rows: 4, items: initial.items.slice(1).map(item => item.key === 'player-1' ? { ...item, span: 2 } : item) };
    const diff = L.compare(initial, next);
    assert.equal(diff.rowsChanged, true);
    assert.deepEqual(diff.removedKeys, ['player-0']);
    assert.deepEqual(diff.changedKeys, ['player-1']);
    assert.equal(L.compare(null, initial).changed, true);
});

function fixture({ deferred = false, width = 1200, height = 800 } = {}) {
    let players = keys(5), columns = 3, deferredFocus = false, committed, suspended = false;
    let captures = 0, changes = 0, commits = 0;
    const values = new Map(), writes = [], queued = [], events = new Map();
    const style = {
        getPropertyValue: key => values.get(key) || '',
        setProperty(key, value) { values.set(key, value); writes.push([key, value]); }
    };
    for (const property of ['gridTemplateColumns', 'gridTemplateRows']) Object.defineProperty(style, property, {
        get: () => values.get(property), set(value) { values.set(property, value); writes.push([property, value]); }
    });
    const view = {
        getComputedStyle: () => ({ paddingLeft: '0', paddingRight: '0', paddingTop: '0', paddingBottom: '0',
            columnGap: Math.min(10, parseFloat(values.get('--player-grid-gap-x-limit') || '99999')) + 'px',
            rowGap: Math.min(10, parseFloat(values.get('--player-grid-gap-y-limit') || '99999')) + 'px' }),
        addEventListener: (type, listener) => events.set(type, listener), removeEventListener: type => events.delete(type),
        setTimeout() { return 1; }, clearTimeout() {},
        ResizeObserver: class { observe() { suspended = false; } disconnect() { suspended = true; } }
    };
    const pane = { clientWidth: width, clientHeight: height, style, ownerDocument: { defaultView: view } };
    const controller = L.observe(pane, {
        getCount: () => players.length,
        calculate: options => ({ ...G.build({ keys: players, columns }), count: players.length,
            area: options.width * options.height, ...(deferredFocus ? { deferredFocus: true } : {}) }),
        onCommit(next) { commits++; committed = next; return next; },
        onChange() { changes++; },
        runUpdate(action, requiresLayout) {
            captures++;
            if (deferred) { queued.push({ action, requiresLayout }); return 'queued'; }
            return action();
        }
    });
    return { pane, controller, writes, queued, events,
        setPlayers(value) { players = value; }, setColumns(value) { columns = value; },
        setDeferredFocus(value) { deferredFocus = value; },
        get captures() { return captures; }, get changes() { return changes; }, get commits() { return commits; },
        get committed() { return committed; }, get suspended() { return suspended; } };
}

test('stable explicit updates and forced refreshes perform no additional capture, grid writes or change notifications', () => {
    const f = fixture();
    f.controller.update();
    assert.equal(f.captures, 1);
    assert.equal(f.writes.length, 4);
    const before = [...f.writes];
    for (let i = 0; i < 100; i++) f.controller.update({ force: i % 2 === 0 });
    assert.equal(f.captures, 1);
    assert.equal(f.changes, 1);
    assert.deepEqual(f.writes, before);
    assert.equal(f.commits, 101, 'logical bookkeeping still commits without unnecessary rendering');
});

test('a delayed capture commits no model or CSS preview and recalculates against the latest selection and dimensions', () => {
    const f = fixture({ deferred: true });
    assert.equal(f.controller.update(), 'queued');
    assert.equal(f.commits, 0);
    assert.deepEqual(f.writes, []);
    f.setPlayers(['new-player', 'player-1']); f.setColumns(1); f.pane.clientWidth = 300;
    assert.equal(f.queued[0].requiresLayout(), true);
    f.queued.shift().action();
    assert.equal(f.committed.columns, 1);
    assert.equal(f.committed.count, 2);
    assert.deepEqual(f.committed.items.map(item => item.key), ['new-player', 'player-1']);
    assert.equal(f.pane.style.getPropertyValue('--player-grid-gap-x-limit'), '75px');
});

test('disposed and hidden-page delayed callbacks cannot apply stale geometry or write styles', () => {
    for (const lifecycle of ['destroy', 'pagehide']) {
        const f = fixture({ deferred: true });
        f.controller.update();
        if (lifecycle === 'destroy') f.controller.destroy(); else f.events.get('pagehide')();
        assert.equal(f.queued[0].requiresLayout(), false);
        f.queued.shift().action();
        assert.equal(f.commits, 0);
        assert.deepEqual(f.writes, []);
    }
});

test('ordinary pixel resize changes only necessary gap-cap values without a sound-preservation cycle', () => {
    const f = fixture(); f.controller.update();
    const initialWrites = f.writes.length;
    f.pane.clientWidth += 2; f.pane.clientHeight += 1;
    f.controller.update();
    assert.equal(f.captures, 1);
    assert.equal(f.changes, 1);
    assert.deepEqual(f.writes.slice(initialWrites).map(([name]) => name), ['--player-grid-gap-x-limit', '--player-grid-gap-y-limit']);
    assert.equal(f.committed.area, 1202 * 801);
});

test('a constrained gap change captures before CSS changes and a growing capped gap uses exact final CSS', () => {
    const f = fixture({ deferred: true, width: 20, height: 20 });
    f.controller.update(); f.queued.shift().action();
    assert.equal(f.pane.style.getPropertyValue('--player-grid-gap-x-limit'), '2px');
    const count = f.writes.length;
    f.pane.clientWidth = 1000; f.pane.clientHeight = 1000;
    f.controller.update();
    assert.equal(f.writes.length, count, 'the preview cannot change actual gaps before audio is captured');
    f.queued.shift().action();
    assert.equal(f.captures, 2);
    assert.equal(f.changes, 2);
    f.controller.update();
    assert.equal(f.captures, 2, 'the adopted uncapped gap is no longer uncertain');
});

test('adopting already-projected cells avoids a second audio capture and preserves changed cell identities', () => {
    const f = fixture(); f.controller.update();
    const movedKeys = ['player-1', 'player-0', ...keys(5).slice(2)];
    f.setPlayers(movedKeys);
    f.controller.adopt({ ...G.build({ keys: movedKeys, columns: 3 }), count: 5 });
    f.controller.update();
    assert.equal(f.captures, 1);
    assert.equal(f.changes, 1);
    assert.deepEqual(f.committed.items.map(item => item.key), movedKeys);
});

test('hidden-focus metadata can be committed and notified without pretending that identical cells moved', () => {
    const f = fixture(); f.controller.update();
    f.setDeferredFocus(true); f.controller.update();
    assert.equal(f.captures, 1);
    assert.equal(f.changes, 2);
    assert.equal(f.committed.deferredFocus, true);
    f.controller.update();
    assert.equal(f.changes, 2);
});

test('grid projection drift is repaired under one capture while authoritative cell positions stay unchanged', () => {
    const f = fixture(); f.controller.update();
    const items = f.committed.items;
    f.pane.style.gridTemplateColumns = 'repeat(99, 1fr)';
    f.controller.update();
    assert.equal(f.captures, 2);
    assert.equal(f.pane.style.gridTemplateColumns, 'repeat(3, minmax(0px, 1fr))');
    assert.deepEqual(f.committed.items, items);
    f.controller.update(); assert.equal(f.captures, 2);
});
