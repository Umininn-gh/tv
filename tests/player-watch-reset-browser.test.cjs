'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const sourcePath = file => fs.existsSync(path.join(root, 'site', file)) ? path.join(root, 'site', file) : path.join(root, file);
const html = fs.readFileSync(sourcePath('index.html'), 'utf8');
const resetAt = html.indexOf('id="reset-positions-on-watch"');
assert.ok(resetAt > 0, 'production reset checkbox exists');
const resetStart = html.lastIndexOf('<label', resetAt), resetEnd = html.indexOf('</label>', resetAt) + 8;
const startMarkup = html.match(/<button\b[^>]*onclick="watchSelectedChannels\(\)"[^>]*>[\s\S]*?<\/button>/)?.[0];
assert.ok(startMarkup, 'production Start Watching button exists');
const controls = html.slice(resetStart, resetEnd) + '\n' + startMarkup;
const harnessFile = path.join(__dirname, 'player-layout-browser.test.cjs');
let harnessSource = fs.readFileSync(harnessFile, 'utf8');
function seam(before, after) {
    assert.equal(harnessSource.split(before).length, 2, 'unique watch fixture seam: ' + before);
    harnessSource = harnessSource.replace(before, after);
}
seam('<button id="fixture-watch-selected" onclick="watchSelectedChannels()">開始觀看</button>', controls);
seam('<script src="/player-layout.js"></script><script src="/player-lifecycle.js"></script>',
    '<script src="/player-layout.js"></script><script src="/player-motion.js"></script><script src="/player-lifecycle.js"></script>');
seam("'/player-lifecycle.js':lifecycleScript,", "'/player-lifecycle.js':lifecycleScript,'/player-motion.js':fs.readFileSync(path.join(root,siteFile('site/assets/js/player-motion.js')),'utf8'),");
const harnessRequire = createRequire(harnessFile), harnessModule = { exports: {} };
const harnessTest = Object.assign(() => {}, { before: test.before, after: test.after });
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + harnessSource + '\n' +
    'module.exports={fixture,optional,snapshot,assertContinuity,fixedDirectionGrid,seedLayoutSound,activeMediaSnapshot,assertActiveContinuity};\n})',
    { filename: harnessFile })(name => name === 'node:test' ? harnessTest : harnessRequire(name),
    harnessModule, harnessModule.exports, __dirname, harnessFile);
const { fixture, optional, snapshot, assertContinuity, fixedDirectionGrid, seedLayoutSound, activeMediaSnapshot, assertActiveContinuity } = harnessModule.exports;
const browserCase = { skip: process.env.UMININN_BROWSER_TESTS !== '1', timeout: 60000 };
async function settled(f) {
    await f.page.waitForFunction(() => playerAudioBridge.batch === null && playerAudioBridge.queueLength === 0);
    await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await f.page.evaluate(() => { for (const animation of document.getAnimations()) { try { animation.finish(); } catch (_) {} } });
}
async function setup(t, options = {}) {
    if (!optional(t)) return null;
    const f = await fixture(t, { width: 1200, height: 800, ...options });
    await f.page.route(/\/assets\/(?:images\/)?mother-head-32\.png(?:\?|$)/, route => route.fulfill({ status: 204, body: '' }));
    if (options.audioUserscript) await seedLayoutSound(f);
    await settled(f); return f;
}
async function selection(f, keys, reset = true) {
    await f.page.evaluate(({ keys, reset }) => {
        generateChannelOptions();
        const wanted = new Set(keys);
        for (const input of document.querySelectorAll('#channel-options input')) input.checked = wanted.has(ChannelList.channelKey({ id: input.value, platform: input.dataset.platform, name: input.dataset.name }));
        document.getElementById('reset-positions-on-watch').checked = reset;
        updateChannelSelectionSummary();
    }, { keys, reset });
}
async function state(f) {
    return f.page.evaluate(() => ({ order: getPlayerPositionKeys(), focus: playerLayoutState.focus,
        geometry: { ...JSON.parse(JSON.stringify(getCurrentPlayerGeometry())), items: [...getCurrentPlayerGeometry().items].sort((a, b) => a.key.localeCompare(b.key)) }, pending: playerLayoutState.pending,
        storage: [PLAYER_POSITION_STORAGE_KEY, PLAYER_ENLARGEMENT_STORAGE_KEY, PLAYER_FOCUS_SWAP_STORAGE_KEY].map(key => localStorage.getItem(key)) }));
}
async function watch(f) { await f.page.evaluate(() => watchSelectedChannels()); await settled(f); }

test('watch reset checkbox is checked by default, stays left of the actual Start control and toggles with keyboard', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const reset = f.page.locator('#reset-positions-on-watch');
    assert.equal(await reset.isChecked(), true);
    for (const width of [320, 375, 1200]) {
        await f.page.setViewportSize({ width, height: 900 });
        await f.page.evaluate(() => setChannelSelectionVisible(true));
        const bounds = await f.page.evaluate(() => {
            const label = document.querySelector('.channel-watch-reset'), button = document.getElementById('start-watching');
            const a = label.getBoundingClientRect(), b = button.getBoundingClientRect(), p = button.parentElement.getBoundingClientRect();
            return { parent: button.parentElement.id, onclick: button.getAttribute('onclick'), text: label.textContent.trim(),
                labelRight: a.right, buttonLeft: b.left, topDifference: Math.abs(a.top - b.top), right: b.right, paneRight: p.right };
        });
        assert.equal(bounds.parent, 'channel-selection'); assert.equal(bounds.onclick, 'watchSelectedChannels()'); assert.equal(bounds.text, '重設位置');
        assert.ok(bounds.labelRight <= bounds.buttonLeft && bounds.topDifference < 1, JSON.stringify(bounds));
        assert.ok(bounds.right <= bounds.paneRight, JSON.stringify(bounds));
    }
    const initial = await state(f), before = await snapshot(f);
    await f.page.locator('.channel-watch-reset').click(); assert.equal(await reset.isChecked(), false);
    await reset.focus(); await f.page.keyboard.press('Space'); assert.equal(await reset.isChecked(), true);
    await f.page.keyboard.press('Space'); assert.equal(await reset.isChecked(), false);
    await f.page.keyboard.press('Space'); assert.equal(await reset.isChecked(), true);
    await f.page.evaluate(() => { generateChannelOptions(); clearAllChannelSelection(); });
    assert.equal(await reset.isChecked(), true, 'channel select/clear actions do not treat the separate reset checkbox as a channel');
    const after = await state(f);
    assert.deepEqual(after.order, initial.order); assert.deepEqual(after.geometry, initial.geometry); assert.deepEqual(after.focus, initial.focus);
    await assertContinuity(f, before);
});

test('checked Start resets a reordered right-hand enlarged layout to exact channel order in one audio transaction', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const keys = await f.page.evaluate(() => channels.map(ChannelList.channelKey));
    await fixedDirectionGrid(f, { columns: 3, order: [keys[4], keys[3], keys[2], keys[1], keys[0]],
        focus: { key: keys[0], span: 2, row: 0, column: 1 } }); await settled(f);
    await f.page.evaluate(() => {
        playerLayoutState.rememberOrder(); localStorage.setItem(PLAYER_POSITION_STORAGE_KEY, JSON.stringify(playerLayoutState.preferredOrder));
        savePlayerEnlargement(); localStorage.setItem(PLAYER_FOCUS_SWAP_STORAGE_KEY, '{"version":1,"large":"old","small":"other"}');
        window.watchProjects = []; const project = projectPlayerLayout;
        projectPlayerLayout = function (...args) { watchProjects.push(JSON.parse(JSON.stringify(getCurrentPlayerGeometry()))); return project.apply(this, args); };
    });
    await selection(f, keys); const before = await snapshot(f);
    const captures = await f.page.evaluate(() => fixtureLayoutEvents.filter(event => event.type === 'umininn-player-layout-before').length);
    await watch(f); const after = await state(f);
    assert.deepEqual(after.order, keys); assert.equal(after.focus, null); assert.equal(after.pending, null);
    assert.ok(after.geometry.items.every(item => item.span === 1));
    assert.equal(await f.page.evaluate(() => fixtureLayoutEvents.filter(event => event.type === 'umininn-player-layout-before').length), captures + 1);
    const projects = await f.page.evaluate(() => watchProjects); assert.ok(projects.length > 0);
    for (const layout of projects) {
        assert.ok(layout.items.every(item => item.span === 1));
        assert.deepEqual([...layout.items].sort((a, b) => a.row - b.row || a.column - b.column).map(item => item.key), keys);
    }
    assert.deepEqual(after.storage, [null, null, null]);
    assert.equal(await f.page.evaluate(() => fixture.grid().fits), true); await assertContinuity(f, before);
});

test('unchecked Start keeps current arrangement, enlargement and manual media sound settings', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const keys = await f.page.evaluate(() => channels.map(ChannelList.channelKey));
    await fixedDirectionGrid(f, { columns: 3, order: [...keys].reverse(), focus: { key: keys[4], span: 2, row: 0, column: 1 } }); await settled(f);
    await f.page.evaluate(() => playerLayoutState.rememberOrder());
    await selection(f, keys, false); const before = await snapshot(f), initial = await state(f);
    await watch(f); const next = await state(f);
    assert.deepEqual(next.order, initial.order); assert.deepEqual(next.geometry, initial.geometry); assert.deepEqual(next.focus, initial.focus);
    assert.equal(await f.page.locator('#reset-positions-on-watch').isChecked(), false);
    await assertContinuity(f, before);
});

test('checked Start applies a new subset in default order while retaining its live players', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const keys = await f.page.evaluate(() => channels.map(ChannelList.channelKey)), retained = [keys[0], keys[2], keys[4]];
    await fixedDirectionGrid(f, { columns: 3, order: [...keys].reverse(), focus: { key: keys[4], span: 2, row: 0, column: 1 } }); await settled(f);
    await selection(f, retained); const before = await activeMediaSnapshot(f, retained, { remember: true });
    await watch(f); const next = await state(f);
    assert.deepEqual(next.order, retained); assert.equal(next.focus, null); assert.ok(next.geometry.items.every(item => item.span === 1));
    await assertActiveContinuity(f, before);
});

test('checked Start on an already default layout is a no-op without another audio capture and preserves start recognition', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const keys = await f.page.evaluate(() => channels.map(ChannelList.channelKey)); await selection(f, keys);
    const before = await snapshot(f), initial = await state(f);
    const captures = await f.page.evaluate(() => fixtureLayoutEvents.filter(event => event.type === 'umininn-player-layout-before').length);
    await watch(f); assert.deepEqual((await state(f)).geometry, initial.geometry);
    assert.equal(await f.page.evaluate(() => fixtureLayoutEvents.filter(event => event.type === 'umininn-player-layout-before').length), captures);
    await assertContinuity(f, before);
    const userSource = fs.readFileSync(sourcePath('userscript/umininn-tv-player.user.js'), 'utf8');
    const recognizer = userSource.match(/    function isWatchStartTarget\(target\) \{[\s\S]*?\n    \}/)?.[0]; assert.ok(recognizer);
    await f.page.evaluate(source => { window.watchStartRecognized = new Function(source + ';return isWatchStartTarget')()(document.getElementById('start-watching')); }, recognizer);
    assert.equal(await f.page.evaluate(() => watchStartRecognized), true);
    const foreign = await f.frames[1].evaluate(() => {
        fixtureMedia[0].video.pause();
        return { plays: fixtureMedia[0].actions.play, recoveries: fixtureAudioMessages.filter(message => message.command?.action === 'recover').length };
    });
    await f.page.evaluate(() => setChannelSelectionVisible(true));
    await f.page.locator('#start-watching').click();
    await f.frames[1].waitForFunction(plays => !fixtureMedia[0].video.paused && fixtureMedia[0].actions.play === plays + 1, foreign.plays, { timeout: 15000 });
    await f.page.waitForFunction(() => document.getElementById('umininn-player-panel-host').shadowRoot.getElementById('recovery-status').textContent.startsWith('已檢查') &&
        fixtureMedia.every(saved => !saved.video.paused), null, { timeout: 15000 });
    assert.equal(await f.frames[1].evaluate(() => fixtureAudioMessages.filter(message => message.command?.action === 'recover').length), foreign.recoveries + 1,
        'the retained foreign paused player receives exactly one existing recovery command');
    assert.equal(await f.page.evaluate(() => document.getElementById('channel-selection').style.display), 'none');
});
