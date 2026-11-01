'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const read = (migrated, legacy) => fs.readFileSync(fs.existsSync(path.join(root, migrated))
    ? path.join(root, migrated) : path.join(root, legacy), 'utf8');
const appSource = read('site/assets/js/tv-app.js', 'tv-app.js');
const siteHtml = read('site/index.html', 'index.html');
const menuHtml = siteHtml.match(/<select\b[^>]*id="channel-actions"[^>]*>[\s\S]*?<\/select>/)?.[0];
const initStart = appSource.indexOf('(function initChannelActions()');
const initEnd = appSource.indexOf('\n(function initTopbarOptions()', initStart);
assert.ok(menuHtml && initStart >= 0 && initEnd > initStart, 'production animation menu seams exist');
const initActions = appSource.slice(initStart, initEnd);

function loadFixture(filename, exports, transform = source => source) {
    const file = path.join(__dirname, filename), module = { exports: {} }, originalRequire = createRequire(file);
    const quietTest = Object.assign(() => {}, { before: test.before, after: test.after });
    vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' +
        transform(fs.readFileSync(file, 'utf8')) + '\nmodule.exports={' + exports + '};\n})', { filename: file })(
        name => name === 'node:test' ? quietTest : originalRequire(name), module, module.exports, __dirname, file);
    return module.exports;
}
const appFixture = loadFixture('player-motion-app-browser.test.cjs', 'setup,fixture,frames,settled,snapshot,assertContinuity');
const toolbarFixture = loadFixture('topbar-menu-browser.test.cjs', 'fixture,open,assertIdentity', source => {
    const fake = "document.getElementById('channel-actions').addEventListener('change',event=>{fixture.changes.push(event.target.value);event.target.value=''});";
    assert.equal(source.split(fake).length, 2, 'remove only the unrelated toolbar action substitute');
    return source.replace(fake, '// The preference test installs the real production action handler.');
});
const cases = { skip: process.env.UMININN_BROWSER_TESTS !== '1', timeout: 60000 };

async function installMenu(page) {
    // The native 台務 select has the production logo as a CSS background. It is
    // unrelated to player continuity and must remain inside this closed fixture.
    await page.route(/\/assets\/(?:images\/)?mother-head-32\.png(?:\?|$)/,
        route => route.fulfill({ status: 204, body: '' }));
    await page.evaluate(html => {
        if (!document.getElementById('channel-actions')) {
            const fragment = document.createElement('div'); fragment.innerHTML = html;
            document.getElementById('input-container').appendChild(fragment.firstElementChild);
        }
    }, menuHtml);
    await page.addScriptTag({ content: initActions });
}
async function checked(page) {
    return page.locator('#channel-actions option[value^="motion:"]').evaluateAll(options =>
        options.filter(option => option.textContent.startsWith('✓ ')).map(option => option.value));
}
async function select(page, mode) { await page.locator('#channel-actions').selectOption('motion:' + mode); }

test('the real desktop animation commands override Windows reduction and save only this browser preference', cases, async t => {
    const f = await appFixture.setup(t); if (!f) return;
    await installMenu(f.page); await f.page.emulateMedia({ reducedMotion: 'reduce' });
    assert.deepEqual(await checked(f.page), ['motion:auto']);
    const before = await appFixture.snapshot(f);
    await select(f.page, 'on');
    assert.equal(await f.page.evaluate(() => playerMotionPreference), 'on');
    assert.equal(await f.page.evaluate(() => getPlayerMotion().getPreference()), 'on');
    assert.equal(await f.page.evaluate(() => localStorage.getItem('playerMotionPreference')), 'on');
    assert.deepEqual(await checked(f.page), ['motion:on']);
    assert.equal(await f.page.locator('#channel-actions').inputValue(), '', 'command dropdown retains its 台務 title');
    await f.page.evaluate(() => swapPlayerPositions(fixture.keys[0], fixture.keys[2]));
    await f.page.waitForFunction(() => motionQa.some(call => call.duration === 240));
    await appFixture.settled(f); await appFixture.assertContinuity(f, before);
    await select(f.page, 'off');
    assert.deepEqual(await checked(f.page), ['motion:off']);
    const count = await f.page.evaluate(() => motionQa.length);
    await f.page.evaluate(() => swapPlayerPositions(fixture.keys[0], fixture.keys[2]));
    await appFixture.settled(f);
    assert.equal(await f.page.evaluate(() => motionQa.length), count);
    await appFixture.assertContinuity(f, before);
});

test('saved preference survives a reload while a separate browser context retains the default', cases, async t => {
    const f = await appFixture.setup(t); if (!f) return;
    await installMenu(f.page); await select(f.page, 'on');
    await f.page.reload({ waitUntil: 'load' });
    await f.page.waitForFunction(() => activePlayers.size === 5);
    await installMenu(f.page);
    assert.equal(await f.page.evaluate(() => playerMotionPreference), 'on');
    assert.equal(await f.page.evaluate(() => getPlayerMotion().getPreference()), 'on');
    assert.deepEqual(await checked(f.page), ['motion:on']);
    const other = await appFixture.setup(t); if (!other) return;
    await installMenu(other.page);
    assert.equal(await other.page.evaluate(() => playerMotionPreference), 'auto');
    assert.deepEqual(await checked(other.page), ['motion:auto']);
});

test('real cross-tab storage events update the current mode and menu without writing it back', cases, async t => {
    const f = await appFixture.setup(t); if (!f) return;
    await installMenu(f.page); await select(f.page, 'on');
    const second = await f.page.context().newPage();
    await second.goto(f.page.url(), { waitUntil: 'load' });
    await second.waitForFunction(() => activePlayers.size === 5); await installMenu(second);
    await f.page.evaluate(() => {
        window.preferenceWrites = 0;
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, ...args) { if (key === 'playerMotionPreference') preferenceWrites++; return original.call(this, key, ...args); };
    });
    await select(second, 'off');
    await f.page.waitForFunction(() => playerMotionPreference === 'off');
    assert.equal(await f.page.evaluate(() => getPlayerMotion().getPreference()), 'off');
    assert.deepEqual(await checked(f.page), ['motion:off']);
    assert.equal(await f.page.evaluate(() => preferenceWrites), 0);
    await second.evaluate(() => localStorage.removeItem('playerMotionPreference'));
    await f.page.waitForFunction(() => playerMotionPreference === 'auto');
    assert.deepEqual(await checked(f.page), ['motion:auto']);
    await second.close();
});

test('invalid stored modes and foreign storage areas cannot force animation; unavailable storage retains in-page control', cases, async t => {
    const f = await appFixture.setup(t, { storageSeed: { playerMotionPreference: 'garbage' } }); if (!f) return;
    await installMenu(f.page);
    assert.equal(await f.page.evaluate(() => playerMotionPreference), 'auto');
    await f.page.evaluate(() => {
        const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
        Storage.prototype.getItem = function (key) { if (key === 'playerMotionPreference') throw Error('Controlled storage refusal'); return get.call(this, key); };
        Storage.prototype.setItem = function (key, ...args) { if (key === 'playerMotionPreference') throw Error('Controlled storage refusal'); return set.call(this, key, ...args); };
    });
    await f.page.emulateMedia({ reducedMotion: 'reduce' }); await select(f.page, 'on');
    assert.equal(await f.page.evaluate(() => playerMotionPreference), 'on');
    assert.deepEqual(await checked(f.page), ['motion:on']);
    await f.page.evaluate(() => dispatchEvent(new StorageEvent('storage', { key: 'playerMotionPreference', newValue: 'off', storageArea: sessionStorage })));
    assert.equal(await f.page.evaluate(() => playerMotionPreference), 'on', 'session storage cannot modify this local setting');
    await f.page.evaluate(() => dispatchEvent(new StorageEvent('storage', { key: 'unrelated', newValue: 'off', storageArea: localStorage })));
    assert.equal(await f.page.evaluate(() => playerMotionPreference), 'on');
    const count = await f.page.evaluate(() => motionQa.length);
    await f.page.evaluate(() => swapPlayerPositions(fixture.keys[0], fixture.keys[2]));
    await f.page.waitForFunction(count => motionQa.length > count, count);
    await appFixture.settled(f);
    await f.page.evaluate(() => dispatchEvent(new StorageEvent('storage', { key: 'playerMotionPreference', newValue: 'invalid', storageArea: localStorage })));
    assert.equal(await f.page.evaluate(() => playerMotionPreference), 'auto');
    assert.deepEqual(await checked(f.page), ['motion:auto']);
    assert.equal(await f.page.evaluate(() => setPlayerMotionPreference('invalid')), false);
    await f.page.evaluate(() => { setPlayerMotionPreference('on', { persist: false }); dispatchEvent(new StorageEvent('storage', { key: null, newValue: null, storageArea: localStorage })); });
    assert.equal(await f.page.evaluate(() => playerMotionPreference), 'auto');
});

test('preference lookup is cached while layouts animate and the application is idle', cases, async t => {
    const f = await appFixture.setup(t); if (!f) return;
    await installMenu(f.page); await f.page.emulateMedia({ reducedMotion: 'reduce' }); await select(f.page, 'on');
    await f.page.evaluate(() => {
        window.preferenceReads = 0;
        const get = Storage.prototype.getItem;
        Storage.prototype.getItem = function (key) { if (key === 'playerMotionPreference') preferenceReads++; return get.call(this, key); };
    });
    await f.page.evaluate(() => { swapPlayerPositions(fixture.keys[0], fixture.keys[2]); swapPlayerPositions(fixture.keys[0], fixture.keys[3]); });
    await appFixture.settled(f); await f.page.waitForTimeout(1000);
    assert.equal(await f.page.evaluate(() => preferenceReads), 0, 'no storage reads during animation frames or idle state');
});

test('the compact 台務 submenu exposes all three real preference commands and tracks its checkmark', cases, async t => {
    const page = await toolbarFixture.fixture(t, { width: 495 });
    await page.addScriptTag({ content: read('site/assets/js/player-motion.js', 'player-motion.js') });
    const helperStart = appSource.indexOf('function normalizePlayerMotionPreference(');
    const helperEnd = appSource.indexOf('/* Motion projects', helperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart);
    await page.addScriptTag({ content: "const PLAYER_MOTION_PREFERENCE_KEY='playerMotionPreference';let playerMotionPreference='auto';let playerMotion=null;\n" +
        appSource.slice(helperStart, helperEnd) + '\n' + initActions });
    await toolbarFixture.open(page);
    await page.locator('#topbar-tasks-btn').click();
    await page.locator('button[data-topbar-task="motion:on"]').click();
    assert.equal(await page.evaluate(() => playerMotionPreference), 'on');
    assert.equal(await page.evaluate(() => localStorage.getItem('playerMotionPreference')), 'on');
    await toolbarFixture.open(page); await page.locator('#topbar-tasks-btn').click();
    await page.locator('button[data-topbar-task="motion:on"]').filter({ hasText: '✓' }).waitFor();
    assert.equal(await page.locator('button[data-topbar-task^="motion:"]').count(), 3);
    await page.locator('button[data-topbar-task="motion:auto"]').click();
    assert.equal(await page.evaluate(() => playerMotionPreference), 'auto');
    await toolbarFixture.assertIdentity(page);
});
