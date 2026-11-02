'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');

// Reuse the production media/layout/motion fixture, without registering its
// feature cases. The actual app, CSS and userscript remain unmodified.
const harnessFile = path.join(__dirname, 'player-heart-promote-browser.test.cjs');
const harnessRequire = createRequire(harnessFile), harnessModule = { exports: {} };
const harnessTest = Object.assign(() => {}, { before: test.before, after: test.after });
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + fs.readFileSync(harnessFile, 'utf8') + '\n' +
    'module.exports={setup,settled,fixed,geometry,heart,actualMouseWindowAction,snapshot,assertContinuity,assertAudioContinuity};\n})',
    { filename: harnessFile })(name => name === 'node:test' ? harnessTest : harnessRequire(name),
    harnessModule, harnessModule.exports, __dirname, harnessFile);
const { setup, settled, fixed, geometry, heart, actualMouseWindowAction, snapshot, assertContinuity, assertAudioContinuity } = harnessModule.exports;
const browserCase = { skip: process.env.UMININN_BROWSER_TESTS !== '1', timeout: 60000 };
const cell = (f, key) => f.page.locator(`.player-window-cell[data-player-key=${JSON.stringify(key)}]`);
const label = (f, key) => cell(f, key).locator('.player-window-name');
async function capture(f, key, name) {
    if (process.env.UMININN_CORNER_NAME_SCREENSHOTS !== '1') return;
    const folder = path.join(__dirname, '../outputs'); fs.mkdirSync(folder, { recursive: true });
    await cell(f, key).screenshot({ path: path.join(folder, `player-corner-name-${name}.png`) });
}

async function visibleNames(f) {
    return f.page.locator('.player-window-name').evaluateAll(nodes => nodes.filter(node => !node.hidden &&
        getComputedStyle(node).display !== 'none' && node.getClientRects().length > 0)
        .map(node => node.closest('.player-window-cell').dataset.playerKey).sort());
}
async function nameState(f, key, action) {
    return cell(f, key).evaluate((node, action) => {
        const name = node.querySelector('.player-window-name'), button = node.querySelector(`[data-player-action="${action}"]`);
        const rect = element => { const value = element.getBoundingClientRect();
            return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height }; };
        const style = getComputedStyle(name), bounds = name.getBoundingClientRect();
        const hit = bounds.width > 0 ? document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2) : null;
        return { text: name.textContent, title: button.title, hidden: name.hidden, name: rect(name), button: rect(button),
            toolbar: rect(node.querySelector('.player-window-buttons')), tile: rect(node),
            pointerEvents: style.pointerEvents, opacity: Number(style.opacity), overflow: style.overflow,
            textOverflow: style.textOverflow, whiteSpace: style.whiteSpace, scrollWidth: name.scrollWidth,
            hitName: Boolean(hit?.closest('.player-window-name')) };
    }, action);
}

test('corner names sit after the current heart or swap shortcut with and without userscript sound controls', browserCase, async t => {
    for (const audioUserscript of [false, true]) await t.test(audioUserscript ? 'sound controls' : 'no userscript', async st => {
        const f = await setup(st, { audioUserscript }); if (!f) return;
        const { keys } = await fixed(f), before = await snapshot(f);
        assert.deepEqual(await visibleNames(f), [...keys].sort());
        await f.page.keyboard.press('Tab'); await heart(f, keys[4]).focus();
        const names = await f.page.evaluate(() => Object.fromEntries([...activePlayers].map(([key, entry]) => [key, entry.channel.name])));
        let state = await nameState(f, keys[4], 'promote-top-right');
        assert.equal(state.text, names[keys[4]]); assert.ok(state.title.includes(state.text));
        assert.ok(state.name.left >= state.button.right && state.name.right <= state.toolbar.left);
        assert.ok(state.name.width > 0 && state.name.height > 0 && state.opacity > 0);
        assert.equal(state.pointerEvents, 'none'); assert.equal(state.hitName, false);
        if (audioUserscript) await capture(f, keys[4], 'normal');
        await actualMouseWindowAction(f, keys[4], 'promote-top-right'); await settled(f);
        assert.deepEqual(await visibleNames(f), keys.filter(key => key !== keys[4]).sort());
        await cell(f, keys[0]).locator('[data-player-action="swap-focus"]').focus();
        state = await nameState(f, keys[0], 'swap-focus');
        assert.equal(state.text, names[keys[0]]);
        assert.ok(state.name.left >= state.button.right && state.name.right <= state.toolbar.left);
        await assertAudioContinuity(f, before);
    });
});

test('long corner names ellipsize inside the free toolbar gap and do not intercept player or control hit targets', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const { keys } = await fixed(f), before = await snapshot(f), key = keys[0];
    const name = '很長的直播台名稱 <b> 純文字 '.repeat(12).trim();
    await f.page.evaluate(async ({ key, name }) => {
        channels = channels.map(channel => ChannelList.channelKey(channel) === key ? { ...channel, name } : channel);
        await syncActivePlayers(channels);
    }, { key, name });
    await settled(f); await f.page.keyboard.press('Tab'); await heart(f, key).focus();
    const state = await nameState(f, key, 'promote-top-right');
    assert.equal(state.text, name); assert.equal(state.whiteSpace, 'nowrap'); assert.equal(state.overflow, 'hidden');
    assert.equal(state.textOverflow, 'ellipsis'); assert.ok(state.scrollWidth > state.name.width);
    assert.ok(state.name.left >= state.button.right && state.name.right <= state.toolbar.left);
    assert.equal(state.pointerEvents, 'none'); assert.equal(state.hitName, false);
    const hits = await cell(f, key).evaluate(node => ['move', 'audio-focus', 'promote-top-right', 'enlarge', 'close'].map(action => {
        const button = node.querySelector(`[data-player-action="${action}"]`), r = button.getBoundingClientRect();
        return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button') === button;
    }));
    assert.ok(hits.every(Boolean), 'the added text cannot cover any existing button');
    assert.equal(await label(f, key).evaluate(node => node.childElementCount), 0, 'channel names stay plain text');
    await capture(f, key, 'long');
    await assertContinuity(f, before);
});

test('corner names refresh metadata without replacing labels, animating, capturing audio or touching media', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const { keys, initial } = await fixed(f), key = keys[2], before = await snapshot(f);
    const start = await f.page.evaluate(key => {
        window.savedCornerLabel = document.querySelector(`.player-window-cell[data-player-key="${key}"] .player-window-name`);
        window.cornerTextMutations = 0; window.cornerAnimationCount = 0;
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (...args) { cornerAnimationCount++; return animate.apply(this, args); };
        window.cornerObserver = new MutationObserver(records => { cornerTextMutations += records.length; });
        cornerObserver.observe(savedCornerLabel, { childList: true, characterData: true, subtree: true });
        return fixtureLayoutEvents.length;
    }, key);
    const name = '新台名 <img src=x onerror=alert(1)> & ♡';
    await f.page.evaluate(async ({ key, name }) => {
        channels = channels.map(channel => ChannelList.channelKey(channel) === key ? { ...channel, name } : channel);
        await syncActivePlayers(channels);
    }, { key, name });
    await settled(f);
    assert.equal(await label(f, key).textContent(), name);
    let evidence = await f.page.evaluate(({ key, start }) => ({ same: savedCornerLabel === document.querySelector(`.player-window-cell[data-player-key="${key}"] .player-window-name`),
        children: savedCornerLabel.childElementCount, changes: cornerTextMutations, animations: cornerAnimationCount,
        audio: fixtureLayoutEvents.slice(start).filter(event => event.type === 'umininn-player-layout-before').length }), { key, start });
    assert.equal(evidence.same, true); assert.equal(evidence.children, 0); assert.ok(evidence.changes > 0);
    assert.equal(evidence.animations, 0); assert.equal(evidence.audio, 0);
    await f.page.evaluate(() => { cornerTextMutations = 0; for (let index = 0; index < 10; index++) playerWindowControls.refresh(); });
    await settled(f);
    assert.equal(await f.page.evaluate(() => cornerTextMutations), 0, 'unchanged names do not rewrite their DOM on refresh');
    assert.deepEqual(await geometry(f), initial); await assertContinuity(f, before);
});

test('corner labels disappear with their shortcut for single players and editors without changing the selected layout', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const { keys, initial } = await fixed(f), before = await snapshot(f);
    for (const selector of ['#adjust-player-positions', '#enlarge-player']) {
        await f.page.locator(selector).click();
        assert.equal(await label(f, keys[0]).isVisible(), false);
        await f.page.keyboard.press('Escape'); await settled(f);
        assert.deepEqual(await visibleNames(f), [...keys].sort());
    }
    assert.deepEqual(await geometry(f), initial); await assertContinuity(f, before);
    await f.page.evaluate(() => syncActivePlayers([channels[0]])); await settled(f);
    assert.deepEqual(await visibleNames(f), [], 'a single player has neither promotion shortcut nor corner name');
});

test('tiny corner labels cannot push icons together or overflow the player when there is no text room', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const before = await snapshot(f);
    await f.page.evaluate(() => {
        document.getElementById('multi-stream-container-wrapper').style.padding = '0';
        document.getElementById('multi-stream-container').style.border = '0'; fixture.resize(132, 180);
    });
    await f.page.waitForTimeout(240); const { keys } = await fixed(f, 3);
    await f.page.keyboard.press('Tab'); await heart(f, keys[0]).focus();
    const controls = await cell(f, keys[0]).evaluate(node => {
        const bounds = node.getBoundingClientRect();
        return ['move', 'audio-focus', 'promote-top-right', 'enlarge', 'close'].map(action => {
            const button = node.querySelector(`[data-player-action="${action}"]`), r = button.getBoundingClientRect();
            return { action, left: r.left, right: r.right, width: r.width, height: r.height,
                inside: r.left >= bounds.left && r.right <= bounds.right && r.top >= bounds.top && r.bottom <= bounds.bottom,
                hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button') === button };
        });
    });
    assert.ok(controls.every(value => value.width > 0 && value.height > 0 && value.inside && value.hit), JSON.stringify(controls));
    for (let index = 1; index < controls.length; index++) assert.ok(controls[index - 1].right <= controls[index].left);
    const state = await nameState(f, keys[0], 'promote-top-right');
    assert.equal(state.pointerEvents, 'none'); assert.equal(state.hitName, false);
    if (!state.hidden && state.name.width > 0) assert.ok(state.name.left >= state.button.right && state.name.right <= state.toolbar.left);
    await capture(f, keys[0], 'tiny');
    await assertContinuity(f, before);
});
