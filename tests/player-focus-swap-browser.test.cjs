'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Keep the same shipped app, real cross-origin media and trusted input harness
// as the layout operation/diff suites, without registering their broad cases.
const harnessFile = path.join(__dirname, 'player-layout-browser.test.cjs');
const harnessRequire = createRequire(harnessFile);
const harnessTest = Object.assign(() => {}, { before: test.before, after: test.after });
const harnessModule = { exports: {} };
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + fs.readFileSync(harnessFile, 'utf8') + '\n' +
    'module.exports={fixture,optional,snapshot,assertContinuity,assertAudioContinuity,fixedDirectionGrid,waitWindowGeometry,' +
    'actualMouseWindowAction,seedLayoutSound,waitOnlyAudible,waitAudio,holdAudioReply,waitHeldAudioReply,releaseAudioReply,' +
    'activeMediaSnapshot,assertActiveContinuity,playBookmarkMedia,replaceBookmarkSound};\n})',
    { filename: harnessFile })(name => name === 'node:test' ? harnessTest : harnessRequire(name),
    harnessModule, harnessModule.exports, __dirname, harnessFile);
const { fixture, optional, snapshot, assertContinuity, assertAudioContinuity, fixedDirectionGrid, waitWindowGeometry,
    actualMouseWindowAction, seedLayoutSound, waitOnlyAudible, waitAudio, holdAudioReply, waitHeldAudioReply,
    releaseAudioReply, activeMediaSnapshot, assertActiveContinuity, playBookmarkMedia, replaceBookmarkSound } = harnessModule.exports;
const browserCase = { skip: process.env.UMININN_BROWSER_TESTS !== '1', timeout: 60000 };

async function setup(t, options = {}) {
    if (!optional(t)) return null;
    const f = await fixture(t, { width: 1200, height: 800, ...options });
    if (options.audioUserscript) await seedLayoutSound(f);
    await settle(f);
    return f;
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
            items: [...value.items].sort((a, b) => a.key.localeCompare(b.key)) };
    });
}
function item(layout, key) { return layout.items.find(value => value.key === key); }
function swapped(layout, target) {
    const focus = layout.items.find(value => value.span > 1), small = item(layout, target);
    assert.ok(focus && small && small.span === 1, 'the test starts with an actual large tile and a small target');
    return { ...layout, items: layout.items.map(value => value.key === target ? { ...focus, key: target } :
        value.key === focus.key ? { ...small, key: focus.key } : value) };
}
function swapButton(f, key) {
    return f.page.locator(`.player-window-cell[data-player-key=${JSON.stringify(key)}] [data-player-action="swap-focus"]`);
}
async function waitVisibleShortcut(f, key, action) {
    await f.page.waitForFunction(({ key, action }) => {
        const cell = [...document.querySelectorAll('.player-window-cell')].find(value => value.dataset.playerKey === key);
        const button = cell?.querySelector(`[data-player-action="${action}"]`);
        if (!button || button.hidden) return false;
        const rect = button.getBoundingClientRect(), style = getComputedStyle(button);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > .5;
    }, { key, action });
}
async function availableKeys(f) {
    return f.page.locator('[data-player-action="swap-focus"]').evaluateAll(buttons => buttons.filter(button =>
        !button.hidden && getComputedStyle(button).display !== 'none' && button.getClientRects().length > 0)
        .map(button => button.closest('.player-window-cell').dataset.playerKey).sort());
}
async function prepare(f, { span = 2, focusIndex = 0, columns = 4, row = 0, column = 1 } = {}) {
    const keys = await f.page.evaluate(() => fixture.keys);
    await fixedDirectionGrid(f, { columns, focus: { key: keys[focusIndex], span, row, column }, order: keys });
    await settle(f);
    return { keys, initial: await geometry(f) };
}
async function releaseCapture(f) {
    await releaseAudioReply(f);
    await f.page.evaluate(() => { fixtureAudioGate.blockUpdates = false; });
    await settle(f);
}

test('focus swap: controls require an actual large tile and appear on its small peers without userscript', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    assert.deepEqual(await availableKeys(f), []);
    const { keys } = await prepare(f, { focusIndex: 4 });
    assert.deepEqual(await availableKeys(f), keys.slice(0, 4).sort());
    assert.equal(await swapButton(f, keys[4]).isVisible(), false, 'the current large tile cannot swap with itself');
    await f.page.evaluate(async () => {
        window.focusSwapReplacement = { id: 'focus-swap-replacement', platform: 'at', name: '替換台' };
        fixture.addPlaceholder(focusSwapReplacement);
        await syncActivePlayers([...channels.slice(0, 4), focusSwapReplacement]);
    });
    await settle(f);
    assert.equal((await geometry(f)).items.some(value => value.span > 1), false);
    assert.equal(await f.page.evaluate(() => playerLayoutState.focus?.key), keys[4], 'the saved focus is dormant after selection removes it');
    assert.deepEqual(await availableKeys(f), [], 'a remembered focus that is absent from current geometry must not expose swap buttons');
    assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
});

test('focus swap: the accessible shortcut follows sound on the left and stays clear of the right toolbar', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const { keys } = await prepare(f);
    const key = keys[4], button = swapButton(f, key);
    await f.page.keyboard.press('Tab'); await button.focus();
    await waitVisibleShortcut(f, key, 'swap-focus');
    const controls = await button.evaluate(button => {
        const cell = button.closest('.player-window-cell'), rect = element => {
            const value = element.getBoundingClientRect();
            return { left: value.left, right: value.right, top: value.top, bottom: value.bottom };
        };
        return { className: button.className, label: button.getAttribute('aria-label'), title: button.title,
            focused: button.matches(':focus-visible'), opacity: Number(getComputedStyle(button).opacity),
            move: rect(cell.querySelector('[data-player-action="move"]')),
            sound: rect(cell.querySelector('[data-player-action="audio-focus"]')), swap: rect(button),
            toolbar: rect(cell.querySelector('.player-window-buttons')), tile: rect(cell) };
    });
    assert.ok(controls.className.split(/\s+/).includes('player-window-swap-focus'));
    assert.ok(controls.label?.length > 0); assert.equal(controls.title, controls.label);
    assert.equal(controls.focused, true); assert.ok(controls.opacity > .5);
    assert.ok(controls.move.right <= controls.sound.left && controls.sound.right <= controls.swap.left,
        'move, sound and focus-swap have separate hit targets in that left-to-right order');
    assert.ok(controls.swap.right <= controls.toolbar.left, 'the new shortcut cannot cover size or close controls');
    assert.ok(controls.swap.left >= controls.tile.left && controls.swap.bottom <= controls.tile.bottom);
});

test('focus swap: tiny tiles keep all left shortcuts and right toolbar hit targets separate', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const before = await snapshot(f);
    for (const width of [196, 132]) {
        await f.page.evaluate(width => {
            document.getElementById('multi-stream-container-wrapper').style.padding = '0';
            document.getElementById('multi-stream-container').style.border = '0';
            fixture.resize(width, 180);
        }, width);
        await f.page.waitForTimeout(240);
        const { keys } = await prepare(f), button = swapButton(f, keys[4]);
        await f.page.keyboard.press('Tab'); await button.focus();
        await waitVisibleShortcut(f, keys[4], 'swap-focus');
        const controls = await button.evaluate(button => {
            const cell = button.closest('.player-window-cell'), bounds = cell.getBoundingClientRect();
            const actions = ['move', 'audio-focus', 'swap-focus', 'enlarge', 'close'];
            return { width: bounds.width, buttons: actions.map(action => {
                const node = cell.querySelector(`[data-player-action="${action}"]`), rect = node.getBoundingClientRect();
                const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                return { action, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
                    width: rect.width, height: rect.height, hit: hit?.closest('button') === node,
                    inside: rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom };
            }) };
        });
        assert.ok(controls.width > 25 && controls.width < 50, JSON.stringify(controls));
        assert.ok(controls.buttons.every(value => value.width > 0 && value.height > 0 && value.inside && value.hit),
            'each compact shortcut retains its own real hit target: ' + JSON.stringify(controls));
        for (let index = 1; index < controls.buttons.length; index++)
            assert.ok(controls.buttons[index - 1].right <= controls.buttons[index].left,
                `${controls.buttons[index - 1].action} must not overlap ${controls.buttons[index].action}`);
    }
    await assertContinuity(f, before);
});

test('focus swap: move and size editing hide the shortcut and restore it on exit', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const { keys, initial } = await prepare(f);
    for (const mode of ['#adjust-player-positions', '#enlarge-player']) {
        await f.page.locator(mode).click();
        await f.page.waitForFunction(() => document.getElementById('player-window-controls').hidden);
        assert.deepEqual(await availableKeys(f), []);
        assert.equal(await swapButton(f, keys[1]).isVisible(), false);
        await f.page.keyboard.press('Escape'); await waitWindowGeometry(f);
        assert.deepEqual(await availableKeys(f), keys.slice(1).sort());
        assert.deepEqual(await geometry(f), initial, 'opening and closing either editor does not swap any tile');
    }
});

test('focus swap: a small tile inherits the exact 2×2 or 3×3 rectangle without reflowing peers or restarting media', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f);
    for (const span of [2, 3]) {
        const { keys, initial } = await prepare(f, { span, columns: 5, row: 1, column: 1 });
        const target = keys[3];
        const rectangles = await f.page.evaluate(() => Object.fromEntries([...activePlayers].map(([key, entry]) =>
            [key, getPlayerElement(entry).getBoundingClientRect().toJSON()])));
        await actualMouseWindowAction(f, target, 'swap-focus'); await settle(f);
        assert.deepEqual(await geometry(f), swapped(initial, target), 'only the two owners of the old rectangles change');
        const after = await f.page.evaluate(() => Object.fromEntries([...activePlayers].map(([key, entry]) =>
            [key, getPlayerElement(entry).getBoundingClientRect().toJSON()])));
        for (const key of keys) {
            const previous = key === target ? keys[0] : key === keys[0] ? target : key;
            for (const side of ['left', 'top', 'right', 'bottom'])
                assert.ok(Math.abs(after[key][side] - rectangles[previous][side]) < .6, `${key} retains the expected ${side} edge`);
        }
        assert.deepEqual(await availableKeys(f), keys.filter(key => key !== target).sort());
    }
    await assertContinuity(f, before);
});

test('focus swap: missing, current-focus and no-focus requests are inert and never start sound capture', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const keys = await f.page.evaluate(() => fixture.keys), before = await snapshot(f);
    let initial = await geometry(f), events = await f.page.evaluate(() => fixtureLayoutEvents.length);
    assert.equal(await f.page.evaluate(key => swapPlayerWithFocus(key), keys[1]), false);
    assert.deepEqual(await geometry(f), initial);
    assert.equal(await f.page.evaluate(() => fixtureLayoutEvents.length), events);
    await prepare(f);
    initial = await geometry(f); events = await f.page.evaluate(() => fixtureLayoutEvents.length);
    assert.deepEqual(await f.page.evaluate(async key => [await swapPlayerWithFocus('missing-player'), await swapPlayerWithFocus(key)], keys[0]), [false, false]);
    await settle(f);
    assert.deepEqual(await geometry(f), initial);
    assert.equal(await f.page.evaluate(() => fixtureLayoutEvents.length), events);
    await assertContinuity(f, before);
});

test('focus swap: trusted clicks solo foreign and wrapped-native targets at 100% while retaining play and pause state', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const { keys } = await prepare(f), before = await snapshot(f);
    for (const [target, mediaIndex] of [[keys[2], 3], [keys[3], 4], [keys[4], 2]]) {
        const initial = await geometry(f), soundBefore = await snapshot(f);
        await actualMouseWindowAction(f, target, 'swap-focus');
        const soundAfter = await waitOnlyAudible(f, mediaIndex); await settle(f);
        assert.deepEqual(await geometry(f), swapped(initial, target));
        const oldMedia = [...soundBefore.main, ...soundBefore.frames.flatMap(frame => frame.media)];
        const newMedia = [...soundAfter.main, ...soundAfter.frames.flatMap(frame => frame.media)];
        for (let index = 0; index < oldMedia.length; index++) if (index !== mediaIndex)
            assert.equal(newMedia[index].volume, oldMedia[index].volume, 'muting a peer preserves its volume');
        await assertAudioContinuity(f, before);
    }
});

test('focus swap: rapid B then C clicks during delayed capture leave C in the original large rectangle and audible', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const { keys, initial } = await prepare(f), before = await snapshot(f);
    await holdAudioReply(f, { action: 'getState', blockUpdates: true });
    await actualMouseWindowAction(f, keys[2], 'swap-focus'); await waitHeldAudioReply(f);
    await actualMouseWindowAction(f, keys[4], 'swap-focus');
    assert.deepEqual(await geometry(f), initial, 'both requested mutations wait for the existing audio capture');
    await releaseCapture(f); await waitOnlyAudible(f, 2);
    assert.deepEqual(await geometry(f), swapped(swapped(initial, keys[2]), keys[4]),
        'queued swaps resolve against the latest committed geometry');
    await f.page.waitForTimeout(350); await waitOnlyAudible(f, 2);
    await assertAudioContinuity(f, before);
});

test('focus swap: repeated keyboard activation of the same target during capture retains one swap and the newest sound intent', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const { keys, initial } = await prepare(f), before = await snapshot(f), target = keys[2];
    await f.page.evaluate(() => {
        window.focusSwapKeyClicks = [];
        document.addEventListener('click', event => {
            if (event.target.closest('[data-player-action="swap-focus"]'))
                focusSwapKeyClicks.push({ trusted: event.isTrusted, detail: event.detail });
        }, true);
    });
    await holdAudioReply(f, { action: 'getState', blockUpdates: true });
    await f.page.keyboard.press('Tab'); await swapButton(f, target).focus();
    await f.page.keyboard.press('Enter'); await waitHeldAudioReply(f);
    await f.page.keyboard.press('Enter');
    assert.deepEqual(await f.page.evaluate(() => focusSwapKeyClicks), [{ trusted: true, detail: 0 }, { trusted: true, detail: 0 }],
        'both activations reach the real handler as keyboard clicks, independent of mouse double-click suppression');
    assert.equal(await f.page.evaluate(() => playerAudioBridge.queueLength), 2);
    assert.deepEqual(await geometry(f), initial);
    await releaseCapture(f); await waitOnlyAudible(f, 3);
    assert.deepEqual(await geometry(f), swapped(initial, target), 'the second same-target request cannot exchange the old large tile back');
    await f.page.waitForTimeout(350); await waitOnlyAudible(f, 3);
    await assertAudioContinuity(f, before);
});

test('focus swap: B then C then B during capture returns the main rectangle and 100% sound to the final B request', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const { keys, initial } = await prepare(f), before = await snapshot(f), first = keys[2], second = keys[4];
    await holdAudioReply(f, { action: 'getState', blockUpdates: true });
    await f.page.keyboard.press('Tab'); await swapButton(f, first).focus();
    await f.page.keyboard.press('Enter'); await waitHeldAudioReply(f);
    for (const target of [second, first]) {
        await swapButton(f, target).focus(); await f.page.keyboard.press('Enter');
    }
    assert.equal(await f.page.evaluate(() => playerAudioBridge.queueLength), 3);
    assert.deepEqual(await geometry(f), initial, 'all three activations are queued before any geometry commit');
    await releaseCapture(f); await waitOnlyAudible(f, 3);
    assert.deepEqual(await geometry(f), swapped(initial, first),
        'B→C→B returns C to its initial small slot while B keeps the original large rectangle');
    await f.page.waitForTimeout(350); await waitOnlyAudible(f, 3);
    await assertAudioContinuity(f, before);
});

test('focus swap: keyboard activation transfers focus from the hidden swap button to a visible control on the enlarged player', browserCase, async t => {
    if (!optional(t)) return;
    for (const audioUserscript of [false, true]) await t.test(audioUserscript ? 'sound shortcut available' : 'move shortcut fallback', async st => {
        const f = await setup(st, { audioUserscript }); if (!f) return;
        const { keys, initial } = await prepare(f), target = keys[2], before = await snapshot(f);
        await f.page.keyboard.press('Tab'); await swapButton(f, target).focus();
        await f.page.keyboard.press('Enter'); await settle(f);
        if (audioUserscript) await waitOnlyAudible(f, 3);
        assert.deepEqual(await geometry(f), swapped(initial, target));
        assert.equal(await swapButton(f, target).isVisible(), false);
        await waitVisibleShortcut(f, target, audioUserscript ? 'audio-focus' : 'move');
        const focus = await f.page.evaluate(() => {
            const active = document.activeElement, rect = active.getBoundingClientRect(), style = getComputedStyle(active);
            return { key: active.closest('.player-window-cell')?.dataset.playerKey, action: active.dataset.playerAction,
                focused: active.matches(':focus-visible'), hidden: active.hidden,
                visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > .5 };
        });
        assert.deepEqual(focus, { key: target, action: audioUserscript ? 'audio-focus' : 'move', focused: true, hidden: false, visible: true },
            'keyboard focus must stay with the newly enlarged player on an available control');
        if (audioUserscript) await assertAudioContinuity(f, before);
        else await assertContinuity(f, before);
    });
});

test('focus swap: a later trusted mute or solo command wins over a swap awaiting sound capture', browserCase, async t => {
    if (!optional(t)) return;
    for (const action of ['global-mute', 'solo']) await t.test(action, async st => {
        const f = await setup(st, { audioUserscript: true }); if (!f) return;
        const { keys, initial } = await prepare(f), before = await snapshot(f);
        await holdAudioReply(f, { action: 'getState', blockUpdates: true });
        await actualMouseWindowAction(f, keys[2], 'swap-focus'); await waitHeldAudioReply(f);
        if (action === 'global-mute') await f.page.locator('#umininn-player-control-host #quick-mute').click();
        else await actualMouseWindowAction(f, keys[4], 'audio-focus');
        await releaseCapture(f);
        assert.deepEqual(await geometry(f), swapped(initial, keys[2]), 'the later audio command does not cancel the intended layout change');
        if (action === 'global-mute') await waitAudio(f, media => media.every(value => value.muted));
        else await waitOnlyAudible(f, 2);
        await f.page.waitForTimeout(350);
        if (action === 'global-mute') await waitAudio(f, media => media.every(value => value.muted));
        else await waitOnlyAudible(f, 2);
        await assertAudioContinuity(f, before);
    });
});

test('focus swap: closing a target before its queued swap commits cannot promote or revive the removed player', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const { keys, initial } = await prepare(f), target = keys[4];
    const before = await activeMediaSnapshot(f, keys.filter(key => key !== target), { remember: true });
    await holdAudioReply(f, { action: 'getState', blockUpdates: true });
    await f.page.evaluate(key => { window.focusSwapClose = Promise.resolve(closePlayer(key)); }, target);
    await waitHeldAudioReply(f);
    await actualMouseWindowAction(f, target, 'swap-focus');
    await releaseCapture(f); assert.equal(await f.page.evaluate(() => focusSwapClose), true);
    const after = await geometry(f);
    assert.equal(after.items.some(value => value.key === target), false);
    assert.deepEqual(after.items.filter(value => value.span > 1).map(({ key, span }) => ({ key, span })),
        [{ key: keys[0], span: item(initial, keys[0]).span }], 'closing may refit the grid but cannot transfer the remaining focus');
    assert.equal(await f.page.evaluate(key => activePlayers.has(key), target), false);
    assert.equal(await swapButton(f, target).count(), 0);
    await f.page.waitForTimeout(350);
    await assertActiveContinuity(f, before);
});

test('focus swap: bookmark capture and apply restore swapped channel order, focus rectangle and selected sound', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const { keys, initial } = await prepare(f, { span: 3, columns: 5, row: 1, column: 1 });
    await actualMouseWindowAction(f, keys[2], 'swap-focus'); await waitOnlyAudible(f, 3); await settle(f);
    const expected = swapped(initial, keys[2]);
    const saved = await f.page.evaluate(() => capturePlayerBookmark());
    assert.deepEqual(saved.focus, item(expected, keys[2]));
    assert.deepEqual(saved.channels.map(channel => channel.key), await f.page.evaluate(() => getPlayerPositionKeys()));
    assert.deepEqual(saved.audio, { version: 1, audible: [{ key: keys[2], volume: 1 }] });
    await fixedDirectionGrid(f, { columns: 3, order: [...keys].reverse() }); await settle(f);
    await replaceBookmarkSound(f, { muted: false, volume: .43 }); await playBookmarkMedia(f);
    const before = await snapshot(f);
    assert.deepEqual(await f.page.evaluate(saved => applyPlayerBookmark(saved), saved), { applied: 5, missing: 0 });
    await settle(f); await waitOnlyAudible(f, 3);
    assert.deepEqual(await geometry(f), expected);
    assert.deepEqual(await f.page.evaluate(() => getPlayerPositionKeys()), saved.channels.map(channel => channel.key));
    await f.page.waitForTimeout(1100); await waitOnlyAudible(f, 3);
    await assertAudioContinuity(f, before);
});
