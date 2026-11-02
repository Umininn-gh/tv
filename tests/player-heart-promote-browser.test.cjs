'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Run the production app, layout engine, motion layer and userscript against
// real native media and two routed foreign documents. Register only this file's
// cases; the shared fixture's broad regression cases run in their own suite.
const harnessFile = path.join(__dirname, 'player-layout-browser.test.cjs');
let harnessSource = fs.readFileSync(harnessFile, 'utf8');
function seam(before, after) {
    assert.equal(harnessSource.split(before).length, 2, 'unique heart fixture seam: ' + before);
    harnessSource = harnessSource.replace(before, after);
}
seam('<script src="/player-layout.js"></script><script src="/player-lifecycle.js"></script>',
    '<script src="/player-layout.js"></script><script src="/player-motion.js"></script><script src="/player-lifecycle.js"></script>');
seam("'/player-lifecycle.js':lifecycleScript,", "'/player-lifecycle.js':lifecycleScript,'/player-motion.js':fs.readFileSync(path.join(root,siteFile('site/assets/js/player-motion.js')),'utf8'),");
const harnessRequire = createRequire(harnessFile), harnessModule = { exports: {} };
const harnessTest = Object.assign(() => {}, { before: test.before, after: test.after });
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + harnessSource + '\n' +
    'module.exports={fixture,optional,snapshot,assertContinuity,assertAudioContinuity,fixedDirectionGrid,waitWindowGeometry,' +
    'actualMouseWindowAction,seedLayoutSound,waitOnlyAudible,waitAudio,holdAudioReply,waitHeldAudioReply,releaseAudioReply,' +
    'activeMediaSnapshot,assertActiveContinuity};\n})',
    { filename: harnessFile })(name => name === 'node:test' ? harnessTest : harnessRequire(name),
    harnessModule, harnessModule.exports, __dirname, harnessFile);
const { fixture, optional, snapshot, assertContinuity, assertAudioContinuity, fixedDirectionGrid, waitWindowGeometry,
    actualMouseWindowAction, seedLayoutSound, waitOnlyAudible, waitAudio, holdAudioReply, waitHeldAudioReply,
    releaseAudioReply, activeMediaSnapshot, assertActiveContinuity } = harnessModule.exports;
const browserCase = { skip: process.env.UMININN_BROWSER_TESTS !== '1', timeout: 60000 };
const action = 'promote-top-right';
const visual = layout => [...layout.items].sort((a, b) => a.row - b.row || a.column - b.column).map(item => item.key);
const heart = (f, key) => f.page.locator(`.player-window-cell[data-player-key=${JSON.stringify(key)}] [data-player-action="${action}"]`);

async function settled(f) {
    await f.page.waitForFunction(() => playerAudioBridge.batch === null && playerAudioBridge.queueLength === 0);
    await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await f.page.evaluate(() => { for (const animation of document.getAnimations()) { try { animation.finish(); } catch (_) {} } });
    await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (await f.page.evaluate(() => activePlayers.size > 0)) await waitWindowGeometry(f);
}
async function setup(t, options = {}) {
    if (!optional(t)) return null;
    const f = await fixture(t, { width: 1200, height: 800, ...options });
    // Both the migrated source and the legacy release use the same logo. It is
    // unrelated to player control and must not leak into the network assertion.
    await f.page.route(/\/assets\/(?:images\/)?mother-head-32\.png(?:\?|$)/,
        route => route.fulfill({ status: 204, body: '' }));
    if (options.audioUserscript) await seedLayoutSound(f);
    await settled(f);
    return f;
}
async function geometry(f) {
    return f.page.evaluate(() => {
        const value = getCurrentPlayerGeometry();
        return { columns: value.columns, rows: value.rows, items: [...value.items].sort((a, b) => a.key.localeCompare(b.key)) };
    });
}
async function available(f) {
    return f.page.locator(`[data-player-action="${action}"]`).evaluateAll(buttons => buttons.filter(button =>
        !button.hidden && getComputedStyle(button).display !== 'none' && button.getClientRects().length > 0)
        .map(button => button.closest('.player-window-cell').dataset.playerKey).sort());
}
async function fixed(f, columns = 3) {
    const keys = await f.page.evaluate(() => getPlayerPositionKeys());
    await fixedDirectionGrid(f, { columns, order: keys }); await settled(f);
    return { keys, initial: await geometry(f) };
}
function assertPromotion(initial, next, key) {
    const firstRow = Math.min(...initial.items.map(item => item.row));
    const oldRight = initial.items.filter(item => item.row === firstRow).sort((a, b) => b.column - a.column)[0].key;
    const order = visual(initial), source = order.indexOf(key), destination = order.indexOf(oldRight);
    [order[source], order[destination]] = [order[destination], order[source]];
    const large = next.items.filter(item => item.span > 1);
    assert.equal(large.length, 1); assert.equal(large[0].key, key); assert.equal(large[0].span, 2);
    assert.equal(large[0].row, 0); assert.equal(large[0].column + 2, next.columns);
    assert.deepEqual(visual(next).filter(value => value !== key), order.filter(value => value !== key),
        'all small players use the old visual order after exactly the requested top-row exchange');
    const occupied = new Set();
    for (const item of next.items) {
        assert.ok(item.row >= 0 && item.column >= 0 && item.row + item.span <= next.rows && item.column + item.span <= next.columns);
        for (let y = item.row; y < item.row + item.span; y++) for (let x = item.column; x < item.column + item.span; x++) {
            const index = y * next.columns + x;
            assert.equal(occupied.has(index), false, 'players cannot overlap'); occupied.add(index);
        }
    }
    const last = Math.max(...occupied);
    assert.equal(occupied.size, last + 1, 'only trailing empty cells are allowed');
}
async function releaseCapture(f) {
    await releaseAudioReply(f); await f.page.evaluate(() => { fixtureAudioGate.blockUpdates = false; }); await settled(f);
}

test('heart promotion controls follow sound, require multiple uniform tiles and hide in either editor', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const { keys } = await fixed(f);
    assert.deepEqual(await available(f), [...keys].sort());
    await f.page.keyboard.press('Tab'); await heart(f, keys[0]).focus();
    const control = await heart(f, keys[0]).evaluate(button => {
        const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
        const cell = button.closest('.player-window-cell');
        return { text: button.textContent, label: button.getAttribute('aria-label'), title: button.title,
            audio: rect(cell.querySelector('[data-player-action="audio-focus"]')), heart: rect(button), toolbar: rect(cell.querySelector('.player-window-buttons')) };
    });
    assert.equal(control.text, '♡'); assert.ok(control.label?.length > 0); assert.equal(control.label, control.title);
    assert.ok(control.audio.right <= control.heart.left && control.heart.right <= control.toolbar.left);
    for (const selector of ['#adjust-player-positions', '#enlarge-player']) {
        await f.page.locator(selector).click();
        assert.equal(await heart(f, keys[0]).isVisible(), false);
        await f.page.keyboard.press('Escape'); await settled(f);
        assert.deepEqual(await available(f), [...keys].sort());
    }
    await f.page.evaluate(() => enlargePlayer(getPlayerPositionKeys()[0])); await settled(f);
    assert.deepEqual(await available(f), []);
    await f.page.evaluate(() => resetPlayerPositions()); await settled(f);
    await f.page.evaluate(() => { playerLayoutState.setFocus({ key: 'absent-player', span: 2, row: 0, column: 0 }); playerWindowControls.refresh(); });
    await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.deepEqual(await available(f), [...keys].sort(), 'only displayed tile sizes determine whether the shortcut is available');
});

test('heart promotion remains available after selection hides the remembered enlarged player', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const keys = await f.page.evaluate(() => fixture.keys);
    await f.page.evaluate(key => enlargePlayer(key), keys[0]); await settled(f);
    await f.page.evaluate(() => syncActivePlayers(channels.slice(1))); await settled(f);
    assert.equal(await f.page.evaluate(() => playerLayoutState.focus.key), keys[0]);
    const remaining = keys.slice(1), initial = await geometry(f), target = remaining[remaining.length - 1];
    assert.ok(initial.items.every(item => item.span === 1)); assert.deepEqual(await available(f), [...remaining].sort());
    const before = await activeMediaSnapshot(f, remaining, { remember: true });
    await actualMouseWindowAction(f, target, action); await settled(f);
    assertPromotion(initial, await geometry(f), target); await assertActiveContinuity(f, before);
});

test('heart promotion computes the exchanged upper-right 2x2 layout before projection and animates retained media once', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const { keys, initial } = await fixed(f), target = keys[4], before = await snapshot(f);
    await f.page.evaluate(() => {
        window.heartProjects = []; window.heartAnimations = [];
        const project = projectPlayerLayout, animate = Element.prototype.animate;
        projectPlayerLayout = function (...args) { heartProjects.push(JSON.parse(JSON.stringify(getCurrentPlayerGeometry()))); return project.apply(this, args); };
        Element.prototype.animate = function (frames, options) {
            const animation = animate.call(this, frames, options);
            heartAnimations.push({ key: this.dataset.channelKey || this.dataset.playerKey, duration: options.duration,
                player: [...activePlayers.values()].some(entry => getPlayerElement(entry) === this),
                layout: JSON.parse(JSON.stringify(getCurrentPlayerGeometry())), frames });
            return animation;
        };
    });
    await actualMouseWindowAction(f, target, action);
    await f.page.waitForFunction(() => heartAnimations.some(value => value.duration === 240)); await settled(f);
    const next = await geometry(f); assertPromotion(initial, next, target);
    const evidence = await f.page.evaluate(() => ({ projects: heartProjects, animations: heartAnimations.filter(value => value.duration === 240), grid: fixture.grid() }));
    assert.ok(evidence.projects.length > 0 && evidence.animations.length > 0);
    for (const projected of evidence.projects) assertPromotion(initial, projected, target);
    for (const animation of evidence.animations) assertPromotion(initial, animation.layout, target);
    const playerAnimations = evidence.animations.filter(value => value.player);
    assert.ok(playerAnimations.length > 0); assert.equal(new Set(playerAnimations.map(value => value.key)).size, playerAnimations.length,
        'each retained player has at most one transition from its old rectangle to the final rectangle');
    assert.equal(evidence.grid.fits, true); assert.deepEqual(await available(f), []);
    await assertContinuity(f, before);
});

test('heart promotion already at the first-row right edge grows without exchanging any small peers', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const { keys, initial } = await fixed(f), target = keys[2], before = await snapshot(f);
    await actualMouseWindowAction(f, target, action); await settled(f);
    assertPromotion(initial, await geometry(f), target); await assertContinuity(f, before);
});

test('heart promotion waits for a measurable pane and works after the same live pane is restored', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const { keys } = await fixed(f), target = keys[4], before = await snapshot(f);
    await f.page.evaluate(() => { document.getElementById('multi-stream-container-wrapper').style.display = 'none'; });
    await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const hidden = await geometry(f);
    assert.equal(await f.page.evaluate(key => promotePlayerTopRight(key), target), false);
    assert.deepEqual(await geometry(f), hidden, 'no zero-sized fitting result is committed');
    await f.page.evaluate(() => { document.getElementById('multi-stream-container-wrapper').style.display = ''; }); await settled(f);
    const initial = await geometry(f); await actualMouseWindowAction(f, target, action); await settled(f);
    assertPromotion(initial, await geometry(f), target); await assertContinuity(f, before);
});

test('heart promotion a trusted double click cannot enlarge twice or promote a second player', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const { keys, initial } = await fixed(f), target = keys[4], before = await snapshot(f);
    await f.page.keyboard.press('Tab'); await heart(f, target).focus(); await heart(f, target).hover(); await heart(f, target).dblclick();
    await settled(f); assertPromotion(initial, await geometry(f), target); await assertContinuity(f, before);
});

test('heart promotion refits one-column two and three-player layouts without clipping or interior gaps', browserCase, async t => {
    if (!optional(t)) return;
    for (const count of [2, 3]) await t.test(String(count) + ' players', async st => {
        const f = await setup(st, { width: 260, height: 850 }); if (!f) return;
        await f.page.evaluate(count => syncActivePlayers([channels[0], channels[1], channels[4]].slice(0, count)), count); await settled(f);
        const { keys, initial } = await fixed(f, 1), target = keys[keys.length - 1];
        const before = await activeMediaSnapshot(f, keys, { remember: true });
        await actualMouseWindowAction(f, target, action); await settled(f);
        assertPromotion(initial, await geometry(f), target);
        assert.equal(await f.page.evaluate(() => fixture.grid().fits), true); await assertActiveContinuity(f, before);
    });
});

test('heart promotion tiny controls retain distinct real hit targets with and without sound controls', browserCase, async t => {
    if (!optional(t)) return;
    for (const audioUserscript of [false, true]) await t.test(audioUserscript ? 'sound controls available' : 'without userscript', async st => {
    const f = await setup(st, { audioUserscript }); if (!f) return;
    const before = await snapshot(f);
    await f.page.evaluate(() => {
        document.getElementById('multi-stream-container-wrapper').style.padding = '0';
        document.getElementById('multi-stream-container').style.border = '0'; fixture.resize(132, 180);
    });
    await f.page.waitForTimeout(240); const { keys } = await fixed(f, 3);
    await f.page.keyboard.press('Tab'); await heart(f, keys[0]).focus();
    const controls = await heart(f, keys[0]).evaluate((button, audioUserscript) => {
        const cell = button.closest('.player-window-cell'), bounds = cell.getBoundingClientRect();
        return ['move', ...(audioUserscript ? ['audio-focus'] : []), 'promote-top-right', 'enlarge', 'close'].map(action => {
            const node = cell.querySelector(`[data-player-action="${action}"]`), r = node.getBoundingClientRect();
            return { action, left: r.left, right: r.right, width: r.width, height: r.height,
                inside: r.left >= bounds.left && r.right <= bounds.right && r.top >= bounds.top && r.bottom <= bounds.bottom,
                hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button') === node };
        });
    }, audioUserscript);
    assert.ok(controls.every(value => value.width > 0 && value.height > 0 && value.inside && value.hit), JSON.stringify(controls));
    for (let index = 1; index < controls.length; index++) assert.ok(controls[index - 1].right <= controls[index].left, JSON.stringify(controls));
    await assertContinuity(f, before);
    });
});

test('heart promotion trusted foreign-player activation solos only the promoted player at 100 percent', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const { keys, initial } = await fixed(f), target = keys[2], before = await snapshot(f);
    await actualMouseWindowAction(f, target, action); await settled(f); await waitOnlyAudible(f, 3);
    assertPromotion(initial, await geometry(f), target); await assertAudioContinuity(f, before);
});

test('heart promotion keyboard activation retains focus on an available control of the promoted player', browserCase, async t => {
    if (!optional(t)) return;
    for (const audioUserscript of [false, true]) await t.test(audioUserscript ? 'sound shortcut' : 'move shortcut', async st => {
        const f = await setup(st, { audioUserscript }); if (!f) return;
        const { keys, initial } = await fixed(f), target = keys[2], before = await snapshot(f);
        await f.page.keyboard.press('Tab'); await heart(f, target).focus(); await f.page.keyboard.press('Enter'); await settled(f);
        assertPromotion(initial, await geometry(f), target);
        const focus = await f.page.evaluate(() => ({ action: document.activeElement?.dataset.playerAction,
            key: document.activeElement?.closest('.player-window-cell')?.dataset.playerKey, hidden: document.activeElement?.hidden }));
        assert.deepEqual(focus, { action: audioUserscript ? 'audio-focus' : 'move', key: target, hidden: false });
        if (audioUserscript) { await waitOnlyAudible(f, 3); await assertAudioContinuity(f, before); }
        else await assertContinuity(f, before);
    });
});

test('heart promotion rejects duplicate requests during delayed capture without stealing the accepted sound intent', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const { keys, initial } = await fixed(f), target = keys[4], before = await snapshot(f);
    await holdAudioReply(f, { action: 'getState', blockUpdates: true });
    await actualMouseWindowAction(f, target, action); await waitHeldAudioReply(f);
    const intent = await f.page.evaluate(() => document.documentElement.getAttribute('data-umininn-player-audio-intent'));
    await f.page.keyboard.press('Tab'); await heart(f, keys[0]).focus(); await f.page.keyboard.press('Enter');
    assert.deepEqual(await geometry(f), initial, 'geometry remains unchanged while real media state capture is held');
    assert.equal(await f.page.evaluate(() => document.documentElement.getAttribute('data-umininn-player-audio-intent')), intent,
        'a second heart activation cannot replace the accepted target audio intent');
    await releaseCapture(f); await waitOnlyAudible(f, 2); assertPromotion(initial, await geometry(f), target);
    await f.page.waitForTimeout(350); await waitOnlyAudible(f, 2); await assertAudioContinuity(f, before);
});

test('heart promotion respects later mute intent and focus after keyboard activation awaits capture', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const { keys, initial } = await fixed(f), target = keys[4], before = await snapshot(f);
    await holdAudioReply(f, { action: 'getState', blockUpdates: true });
    await f.page.keyboard.press('Tab'); await heart(f, target).focus(); await f.page.keyboard.press('Enter'); await waitHeldAudioReply(f);
    const mute = f.page.locator('#umininn-player-control-host #quick-mute'); await mute.focus(); await mute.click();
    await f.page.evaluate(() => {
        window.heartLatestFocused = document.activeElement;
        window.heartLatestShadowFocused = heartLatestFocused.shadowRoot?.activeElement;
    });
    await releaseCapture(f); assertPromotion(initial, await geometry(f), target);
    await waitAudio(f, media => media.every(value => value.muted)); await f.page.waitForTimeout(350);
    await waitAudio(f, media => media.every(value => value.muted)); await assertAudioContinuity(f, before);
    assert.equal(await f.page.evaluate(() => document.activeElement === heartLatestFocused &&
        document.activeElement.shadowRoot?.activeElement === heartLatestShadowFocused), true,
        'finishing an old keyboard promotion cannot steal focus from the later mute command');
});

test('heart promotion a player failure during held capture cannot promote its replacement or revive stale media', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const { keys, initial } = await fixed(f), target = keys[4];
    const before = await activeMediaSnapshot(f, keys.filter(key => key !== target), { remember: true });
    await holdAudioReply(f, { action: 'getState', blockUpdates: true });
    await actualMouseWindowAction(f, target, action); await waitHeldAudioReply(f);
    await f.page.evaluate(key => {
        window.heartStaleElement = getPlayerElement(activePlayers.get(key));
        replacePlayerWithError(activePlayers.get(key).resource, '受控測試播放器失敗');
    }, target);
    await f.page.waitForFunction(() => !heartStaleElement.isConnected);
    await releaseCapture(f); assert.deepEqual(await geometry(f), initial);
    assert.equal(await f.page.evaluate(key => getPlayerElement(activePlayers.get(key)).textContent, target), '受控測試播放器失敗');
    assert.equal(await f.page.evaluate(() => heartStaleElement.isConnected), false);
    await assertActiveContinuity(f, before);
});

test('heart promotion invalid and already-enlarged requests are inert without layout capture or audio changes', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const { keys } = await fixed(f);
    assert.equal(await f.page.evaluate(() => promotePlayerTopRight('missing-player')), false);
    await f.page.evaluate(key => enlargePlayer(key), keys[0]); await settled(f);
    const before = await snapshot(f), initial = await geometry(f), start = await f.page.evaluate(() => fixtureLayoutEvents.length);
    assert.equal(await f.page.evaluate(key => promotePlayerTopRight(key), keys[4]), false);
    assert.deepEqual(await geometry(f), initial); assert.equal(await f.page.evaluate(() => fixtureLayoutEvents.length), start);
    await assertContinuity(f, before);
});

test('heart promotion starts a fresh focus-swap memory round even when old geometry repeats', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    await f.page.evaluate(() => syncActivePlayers([channels[0], channels[1], channels[4]])); await settled(f);
    const { keys } = await fixed(f, 3), [a, b, c] = keys;
    const before = await activeMediaSnapshot(f, keys, { remember: true });
    await actualMouseWindowAction(f, a, action); await settled(f);
    await actualMouseWindowAction(f, b, 'swap-focus'); await settled(f);
    const saved = await f.page.evaluate(() => JSON.parse(localStorage.getItem('playerFocusSwapMemory')));
    assert.deepEqual({ large: saved.large, small: saved.small }, { large: b, small: a });
    await f.page.evaluate(key => shrinkPlayer(key), b); await settled(f);
    await actualMouseWindowAction(f, b, action); await settled(f);
    assert.equal(await f.page.evaluate(() => localStorage.getItem('playerFocusSwapMemory')), null);
    const initial = await geometry(f), large = initial.items.find(item => item.key === b), small = initial.items.find(item => item.key === c);
    const expected = { ...initial, items: initial.items.map(item => item.key === b ? { ...small, key: b } : item.key === c ? { ...large, key: c } : item) };
    await actualMouseWindowAction(f, c, 'swap-focus'); await settled(f);
    assert.deepEqual(await geometry(f), expected, 'a previous promotion round cannot relocate a third small peer');
    await assertActiveContinuity(f, before);
});
