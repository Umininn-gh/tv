'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const harnessFile = path.join(__dirname, 'player-layout-browser.test.cjs');
const harnessRequire = createRequire(harnessFile), harnessModule = { exports: {} };
const harnessTest = Object.assign(() => {}, { before: test.before, after: test.after });
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + fs.readFileSync(harnessFile, 'utf8') + '\n' +
    'module.exports={fixture,optional,snapshot,assertContinuity,assertAudioContinuity,fixedDirectionGrid,waitWindowGeometry,' +
    'actualMouseWindowAction,seedLayoutSound,waitOnlyAudible,holdAudioReply,waitHeldAudioReply,releaseAudioReply};\n})',
    { filename: harnessFile })(name => name === 'node:test' ? harnessTest : harnessRequire(name),
    harnessModule, harnessModule.exports, __dirname, harnessFile);
const { fixture, optional, snapshot, assertContinuity, assertAudioContinuity, fixedDirectionGrid, waitWindowGeometry,
    actualMouseWindowAction, seedLayoutSound, waitOnlyAudible, holdAudioReply, waitHeldAudioReply,
    releaseAudioReply } = harnessModule.exports;
const browserCase = { skip: process.env.UMININN_BROWSER_TESTS !== '1', timeout: 90000 };
const STORAGE = 'playerFocusSwapMemory';
const item = (layout, key) => layout.items.find(value => value.key === key);
const large = layout => layout.items.find(value => value.span > 1);
const slot = value => ({ row: value.row, column: value.column, span: value.span });
const signature = layout => JSON.stringify([layout.columns, layout.rows, [...layout.items]
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    .map(value => [value.key, value.row, value.column, value.span])]);
function swap(layout, target) {
    const focus = large(layout), small = item(layout, target);
    assert.ok(focus && small && small.span === 1);
    return { ...layout, items: layout.items.map(value => value.key === target ? { ...value, ...slot(focus) } :
        value.key === focus.key ? { ...value, ...slot(small) } : value) };
}
function expectedSwap(layout, target, record) {
    const focus = large(layout), previous = record && item(layout, record.small);
    const valid = record?.version === 1 && record.layout === signature(layout) &&
        typeof record.large === 'string' && typeof record.small === 'string' && record.large !== record.small &&
        record.large === focus.key && previous?.span === 1;
    const restored = valid && record.small !== target ? swap(layout, record.small) : layout;
    const next = swap(restored, target);
    return { next, memory: valid && record.small === target ? null :
        { version: 1, large: target, small: large(restored).key, layout: signature(next) } };
}
async function settle(f) {
    await f.page.waitForFunction(() => playerAudioBridge.batch === null && playerAudioBridge.queueLength === 0);
    await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await waitWindowGeometry(f);
}
async function geometry(f) {
    return f.page.evaluate(() => {
        const value = getCurrentPlayerGeometry();
        return { columns: value.columns, rows: value.rows,
            items: [...value.items].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) };
    });
}
async function record(f) {
    return f.page.evaluate(key => { const raw = localStorage.getItem(key); return raw === null ? null : JSON.parse(raw); }, STORAGE);
}
async function prepare(t, { audioUserscript = false } = {}) {
    if (!optional(t)) return null;
    const f = await fixture(t, { width: 1200, height: 800, audioUserscript });
    if (audioUserscript) await seedLayoutSound(f);
    const keys = await f.page.evaluate(() => fixture.keys);
    await fixedDirectionGrid(f, { columns: 4, focus: { key: keys[0], span: 2, row: 0, column: 1 }, order: keys });
    await settle(f); return { ...f, keys, initial: await geometry(f) };
}
async function activate(f, key) {
    const before = await geometry(f), saved = await record(f), expected = expectedSwap(before, key, saved);
    await actualMouseWindowAction(f, key, 'swap-focus'); await settle(f);
    assert.deepEqual(await geometry(f), expected.next);
    assert.deepEqual(await record(f), expected.memory);
    return expected;
}
async function blockMemoryStorage(f, methods) {
    await f.page.evaluate(({ key, methods }) => {
        window.fixtureMemoryStorageDescriptors = {};
        for (const method of methods) {
            const descriptor = Object.getOwnPropertyDescriptor(Storage.prototype, method);
            fixtureMemoryStorageDescriptors[method] = descriptor;
            Object.defineProperty(Storage.prototype, method, { ...descriptor, value(...args) {
                if (args[0] === key) throw new DOMException('Fixture blocked only focus-pair storage', 'SecurityError');
                return Reflect.apply(descriptor.value, this, args);
            } });
        }
    }, { key: STORAGE, methods });
}
async function unblockMemoryStorage(f) {
    await f.page.evaluate(() => {
        for (const [name, descriptor] of Object.entries(fixtureMemoryStorageDescriptors))
            Object.defineProperty(Storage.prototype, name, descriptor);
    });
}

test('focus memory browser: trusted B-C-D-A-C-A swaps keep inactive small slots stable and expose only the final projection', browserCase, async t => {
    const f = await prepare(t, { audioUserscript: true }); if (!f) return;
    const before = await snapshot(f), audible = [0, 1, 3, 4, 2];
    await f.page.evaluate(() => {
        const project = projectPlayerLayout;
        window.fixtureMemoryProjections = [];
        projectPlayerLayout = function (...args) {
            const result = project(...args), layout = getCurrentPlayerGeometry();
            fixtureMemoryProjections.push(JSON.stringify([layout.columns, layout.rows, [...layout.items]
                .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
                .map(value => [value.key, value.row, value.column, value.span])]));
            return result;
        };
    });
    for (const index of [2, 3, 4, 0, 2, 0]) {
        const previous = await geometry(f);
        await f.page.evaluate(() => { fixtureMemoryProjections.length = 0; });
        const expected = await activate(f, f.keys[index]); await waitOnlyAudible(f, audible[index]);
        assert.deepEqual(expected.next, index === 0 ? f.initial : swap(f.initial, f.keys[index]));
        const projections = await f.page.evaluate(() => fixtureMemoryProjections);
        assert.ok(projections.length > 0);
        assert.ok(projections.every(value => [signature(previous), signature(expected.next)].includes(value)),
            'restoring the remembered pair cannot briefly project its intermediate large channel');
        const keys = await f.page.evaluate(() => Object.keys(localStorage).filter(key => key === 'playerFocusSwapMemory'));
        assert.equal(keys.length, index === 0 ? 0 : 1, 'there is at most one local pair, cleared on return home');
    }
    await assertAudioContinuity(f, before);
});

test('focus memory browser: malformed, incomplete, wrong-role and stale records fall back to one normal exchange and are replaced', browserCase, async t => {
    const f = await prepare(t); if (!f) return;
    const before = await snapshot(f), a = f.keys[0], b = f.keys[1], c = f.keys[2];
    const correct = { version: 1, large: a, small: b, layout: signature(f.initial) };
    const values = ['{', 'null', '[]', '{}', JSON.stringify({ ...correct, version: 2 }),
        JSON.stringify({ ...correct, layout: 'old layout' }), JSON.stringify({ ...correct, small: '' }),
        JSON.stringify({ ...correct, large: '' }), JSON.stringify({ ...correct, small: a }),
        JSON.stringify({ ...correct, small: 'removed-player' }), JSON.stringify({ ...correct, small: null }),
        JSON.stringify({ ...correct, large: b, small: a })];
    for (const raw of values) {
        await fixedDirectionGrid(f, { columns: 4, focus: { key: a, span: 2, row: 0, column: 1 }, order: f.keys });
        await settle(f); await f.page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: STORAGE, raw });
        const current = await geometry(f);
        await actualMouseWindowAction(f, c, 'swap-focus'); await settle(f);
        assert.deepEqual(await geometry(f), swap(current, c), raw);
        assert.deepEqual(await record(f), { version: 1, large: c, small: a, layout: signature(swap(current, c)) });
    }
    // A partial registry failure can leave an old cell in the geometry after
    // its live player entry disappeared. That pair is unusable even though its
    // layout fingerprint still matches. Keep its media connected throughout.
    await fixedDirectionGrid(f, { columns: 4, focus: { key: a, span: 2, row: 0, column: 1 }, order: f.keys });
    await settle(f); await f.page.evaluate(key => localStorage.removeItem(key), STORAGE);
    await activate(f, b); const partial = await geometry(f), remembered = await record(f);
    assert.equal(remembered.large, b); assert.equal(remembered.small, a);
    assert.equal(remembered.layout, signature(partial));
    const applied = await f.page.evaluate(async ({ absent, target }) => {
        const entry = activePlayers.get(absent);
        if (!entry) throw new Error('The fault injection requires an existing live entry');
        activePlayers.delete(absent);
        try { return await swapPlayerWithFocus(target); }
        finally {
            activePlayers.set(absent, entry);
            projectPlayerLayout(); playerPositionEditor?.refresh(); playerWindowControls?.refresh();
        }
    }, { absent: a, target: c });
    await settle(f); assert.equal(applied, true);
    const expected = swap(partial, c);
    assert.deepEqual(await geometry(f), expected, 'a missing live remembered player must not be promoted from a ghost cell');
    assert.deepEqual(await record(f), { version: 1, large: c, small: b, layout: signature(expected) });
    assert.equal(await f.page.evaluate(key => activePlayers.has(key), a), true, 'fault injection always restores the live entry');
    assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
    await assertContinuity(f, before);
});

test('focus memory browser: resizing, manual placement, bookmark-style restore and selection changes invalidate an old pair context', browserCase, async t => {
    if (!optional(t)) return;
    for (const action of ['resize', 'placement', 'bookmark', 'selection']) await t.test(action, async st => {
        const f = await prepare(st); if (!f) return;
        await activate(f, f.keys[1]);
        const saved = await record(f);
        if (action === 'resize') { await actualMouseWindowAction(f, f.keys[1], 'enlarge'); await settle(f); }
        if (action === 'placement') {
            await f.page.evaluate(([a, b]) => swapPlayerPositions(a, b), [f.keys[2], f.keys[3]]); await settle(f);
        }
        if (action === 'bookmark') {
            await fixedDirectionGrid(f, { columns: 5, focus: { key: f.keys[1], span: 2, row: 1, column: 0 }, order: f.keys });
            await settle(f);
        }
        if (action === 'selection') {
            await f.page.evaluate(key => closePlayer(key), f.keys[0]); await settle(f);
        }
        const current = await geometry(f);
        assert.notEqual(signature(current), saved.layout);
        const target = f.keys[2], expected = swap(current, target);
        await actualMouseWindowAction(f, target, 'swap-focus'); await settle(f);
        assert.deepEqual(await geometry(f), expected, 'a former layout cannot undo a pair in the new layout');
        assert.deepEqual(await record(f), { version: 1, large: target, small: large(current).key, layout: signature(expected) });
        assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
    });
});

test('focus memory browser: the one pair survives page reload and is reused only when the restored geometry matches', browserCase, async t => {
    const f = await prepare(t); if (!f) return;
    await activate(f, f.keys[1]); const saved = await record(f);
    await f.page.reload();
    await f.page.waitForFunction(() => window.fixture?.keys?.length === 5 && activePlayers.size === 5);
    await settle(f);
    assert.deepEqual(await record(f), saved, 'page reload does not erase the local pair');
    const current = await geometry(f), target = f.keys[2], expected = expectedSwap(current, target, saved);
    await actualMouseWindowAction(f, target, 'swap-focus'); await settle(f);
    assert.deepEqual(await geometry(f), expected.next); assert.deepEqual(await record(f), expected.memory);
});

test('focus memory browser: adopting the same geometry preserves a valid pair rather than treating metadata refresh as a new layout', browserCase, async t => {
    const f = await prepare(t); if (!f) return;
    const before = await snapshot(f);
    await activate(f, f.keys[1]); const current = await geometry(f), saved = await record(f);
    const order = await f.page.evaluate(() => getPlayerPositionKeys());
    await fixedDirectionGrid(f, { columns: current.columns, focus: large(current), order }); await settle(f);
    assert.deepEqual(await geometry(f), current); assert.deepEqual(await record(f), saved);
    const expected = await activate(f, f.keys[2]);
    assert.deepEqual(expected.next, swap(f.initial, f.keys[2]), 'the original large channel still follows the new promotion');
    await assertContinuity(f, before);
});

test('focus memory browser: blocked reads or writes never prevent swapping or replay stale memory after a failed write', browserCase, async t => {
    if (!optional(t)) return;
    for (const method of ['getItem', 'setItem', 'removeItem']) await t.test(method, async st => {
        const f = await prepare(st); if (!f) return;
        const before = await snapshot(f);
        if (method === 'getItem') {
            await blockMemoryStorage(f, [method]);
            await actualMouseWindowAction(f, f.keys[1], 'swap-focus'); await settle(f);
            const first = await geometry(f); assert.deepEqual(first, swap(f.initial, f.keys[1]));
            await actualMouseWindowAction(f, f.keys[2], 'swap-focus'); await settle(f);
            assert.deepEqual(await geometry(f), swap(first, f.keys[2]), 'unreadable memory gives ordinary swaps');
            await unblockMemoryStorage(f);
        } else {
            await activate(f, f.keys[1]); const oldRecord = await record(f);
            await blockMemoryStorage(f, [method]);
            const target = method === 'setItem' ? f.keys[2] : f.keys[0];
            const current = await geometry(f), expected = expectedSwap(current, target, oldRecord);
            await actualMouseWindowAction(f, target, 'swap-focus'); await settle(f);
            assert.deepEqual(await geometry(f), expected.next, 'storage failure cannot cancel the current valid swap');
            await unblockMemoryStorage(f); assert.deepEqual(await record(f), oldRecord, 'the simulated write did fail');
            const nextTarget = f.keys[3], next = swap(expected.next, nextTarget);
            await actualMouseWindowAction(f, nextTarget, 'swap-focus'); await settle(f);
            assert.deepEqual(await geometry(f), next, 'the old fingerprint is stale and cannot trigger another undo');
        }
        assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []); await assertContinuity(f, before);
    });
});

test('focus memory browser: rapid queued B-C-D requests use the latest committed pair and keep only final D audible at 100 percent', browserCase, async t => {
    const f = await prepare(t, { audioUserscript: true }); if (!f) return;
    const before = await snapshot(f);
    await holdAudioReply(f, { action: 'getState', blockUpdates: true });
    await actualMouseWindowAction(f, f.keys[2], 'swap-focus'); await waitHeldAudioReply(f);
    for (const target of [f.keys[3], f.keys[4]]) await actualMouseWindowAction(f, target, 'swap-focus');
    assert.deepEqual(await geometry(f), f.initial);
    await releaseAudioReply(f); await f.page.evaluate(() => { fixtureAudioGate.blockUpdates = false; });
    await settle(f); await waitOnlyAudible(f, 2);
    const expected = swap(f.initial, f.keys[4]);
    assert.deepEqual(await geometry(f), expected);
    assert.deepEqual(await record(f), { version: 1, large: f.keys[4], small: f.keys[0], layout: signature(expected) });
    await f.page.waitForTimeout(350); await waitOnlyAudible(f, 2); await assertAudioContinuity(f, before);
});

test('focus memory browser: missing and current-focus requests leave the stored record and layout untouched', browserCase, async t => {
    const f = await prepare(t); if (!f) return;
    await activate(f, f.keys[1]); const current = await geometry(f), saved = await record(f), before = await snapshot(f);
    assert.deepEqual(await f.page.evaluate(async key => [await swapPlayerWithFocus('missing'), await swapPlayerWithFocus(key)], f.keys[1]), [false, false]);
    await settle(f); assert.deepEqual(await geometry(f), current); assert.deepEqual(await record(f), saved);
    await assertContinuity(f, before);
});
