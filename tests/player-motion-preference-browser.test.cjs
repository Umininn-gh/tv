'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Reuse the closed real-browser/media fixture, retaining its browser lifecycle
// hooks while registering only the preference-specific cases in this file.
const fixtureFile = path.join(__dirname, 'player-motion-browser.test.cjs');
const fixtureModule = { exports: {} }, fixtureRequire = createRequire(fixtureFile);
const fixtureTest = Object.assign(() => {}, { before: test.before, after: test.after });
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' +
    fs.readFileSync(fixtureFile, 'utf8') + '\nmodule.exports={fixture,frames,settle};\n})', { filename: fixtureFile })(
    name => name === 'node:test' ? fixtureTest : fixtureRequire(name), fixtureModule, fixtureModule.exports, __dirname, fixtureFile);
const { fixture, frames, settle } = fixtureModule.exports;
const browserCase = { skip: process.env.UMININN_BROWSER_TESTS !== '1', timeout: 30000 };

test('forced on overrides a reduced-motion system for movement, loaded entrance and inert exit', browserCase, async t => {
    const f = await fixture(t, { reducedMotion: 'reduce' });
    await f.page.evaluate(() => swap('a', 'b')); await frames(f.page);
    assert.equal(await f.page.evaluate(() => motionCalls.length), 0, 'default follows the system');
    await f.page.evaluate(() => { motion.setPreference('on'); swap('a', 'c'); }); await frames(f.page);
    assert.equal(await f.page.evaluate(() => motion.getPreference()), 'on');
    assert.ok(await f.page.evaluate(() => motionCalls.some(call => call.timing.duration === 240)));
    await settle(f.page);
    const release = f.hold('/preference-delayed.wav');
    await f.page.evaluate(() => { const item = addItem('new-native', 'video', { src: '/preference-delayed.wav', index: 3 }); motion.enter(item); });
    await frames(f.page);
    assert.equal(await f.page.evaluate(() => calls('new-native').length), 0);
    release();
    await f.page.waitForFunction(() => calls('new-native').some(call => call.timing.duration === 220));
    await settle(f.page);
    await f.page.evaluate(() => { const item = items.get('new-native'); motion.leave(item); items.delete(item.key); item.element.pause(); item.element.remove(); });
    assert.ok(await f.page.locator('[data-player-motion-ghost]').count() > 0);
    assert.ok(await f.page.evaluate(() => motionCalls.some(call => call.timing.duration === 170)));
    await settle(f.page);
});

test('explicit off cancels active effects and pending entrances while preserving connected media and sound', browserCase, async t => {
    const { page } = await fixture(t);
    await page.evaluate(() => { motion.setPreference('on'); swap('a', 'b'); }); await frames(page);
    assert.ok(await page.evaluate(() => document.getAnimations().length) > 0);
    await page.evaluate(() => motion.setPreference('off')); await frames(page);
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
    const count = await page.evaluate(() => motionCalls.length);
    await page.evaluate(() => {
        swap('a', 'c'); const item = addItem('off-twitch', 'twitch', { index: 3 }); motion.enter(item);
        item.element.dataset.streamPlaybackState = 'playing'; motion.leave(item);
    }); await frames(page);
    assert.equal(await page.evaluate(() => motionCalls.length), count);
    assert.equal(await page.locator('[data-player-motion-ghost]').count(), 0);
    assert.equal(await page.evaluate(() => [...items.values()].every(item => item.element.isConnected)), true);
    await page.evaluate(() => { motion.setPreference('on'); swap('a', 'b'); }); await frames(page);
    assert.ok(await page.evaluate(count => motionCalls.length > count, count));
    await settle(page);
});

test('OS preference changes cannot cancel forced-on effects, while auto still reacts immediately', browserCase, async t => {
    const { page } = await fixture(t);
    await page.evaluate(() => { motion.setPreference('on'); swap('a', 'b'); }); await frames(page);
    await page.evaluate(() => { window.savedPreferenceAnimation = document.getElementById('a').getAnimations()[0]; savedPreferenceAnimation.pause(); savedPreferenceAnimation.currentTime = 80; });
    await page.emulateMedia({ reducedMotion: 'reduce' }); await frames(page);
    assert.equal(await page.evaluate(() => document.getElementById('a').getAnimations().includes(savedPreferenceAnimation)), true);
    await page.evaluate(() => motion.setPreference('auto')); await frames(page);
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
    const count = await page.evaluate(() => motionCalls.length);
    await page.evaluate(() => swap('a', 'c')); await frames(page);
    assert.equal(await page.evaluate(() => motionCalls.length), count);
    await page.emulateMedia({ reducedMotion: 'no-preference' }); await frames(page);
    await page.evaluate(() => swap('a', 'b')); await frames(page);
    assert.ok(await page.evaluate(count => motionCalls.length > count, count));
    await settle(page);
});

test('invalid modes are rejected and forced on still honors fullscreen and held-pointer safety guards', browserCase, async t => {
    const { page } = await fixture(t, { reducedMotion: 'reduce' });
    const result = await page.evaluate(() => {
        motion.destroy(); motion = PlayerMotion.create({ pane, getItems: () => [...items.values()], preference: 'invalid' });
        const initial = motion.getPreference(), rejected = motion.setPreference('always');
        motion.setPreference('on'); Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => pane });
        swap('a', 'b'); return { initial, rejected };
    });
    assert.deepEqual(result, { initial: 'auto', rejected: false }); await frames(page);
    assert.equal(await page.evaluate(() => motionCalls.length), 0);
    await page.evaluate(() => { delete document.fullscreenElement; document.dispatchEvent(new Event('fullscreenchange')); });
    await page.mouse.move(200, 150); await page.mouse.down();
    await page.evaluate(() => swap('a', 'c')); await frames(page);
    assert.equal(await page.evaluate(() => motionCalls.length), 0, 'forced on does not animate under an active gesture');
    await page.mouse.up();
    await page.evaluate(() => swap('a', 'b')); await frames(page);
    assert.ok(await page.evaluate(() => motionCalls.length) > 0); await settle(page);
});

test('enabling animation does not replay entrances that completed while animation was disabled', browserCase, async t => {
    const { page } = await fixture(t, { reducedMotion: 'reduce' });
    await page.evaluate(() => { const item = addItem('already-ready', 'twitch', { index: 3 }); motion.enter(item); item.element.dataset.streamPlaybackState = 'playing'; });
    await frames(page);
    await page.evaluate(() => motion.setPreference('on')); await frames(page);
    assert.equal(await page.evaluate(() => calls('already-ready').length), 0);
    await page.evaluate(() => { const item = addItem('future-ready', 'twitch', { index: 4 }); motion.enter(item); item.element.dataset.streamPlaybackState = 'playing'; });
    await page.waitForFunction(() => calls('future-ready').some(call => call.timing.duration === 220));
    await settle(page);
});

test('forcing on under Windows reduction starts the same finite effects as ordinary system-enabled animation', browserCase, async t => {
    const { page } = await fixture(t, { reducedMotion: 'no-preference' });
    await page.evaluate(() => { motion.setPreference('auto'); swap('a', 'b'); }); await frames(page);
    const ordinary = await page.evaluate(() => motionCalls.map(call => ({ id: call.id, duration: call.timing.duration, easing: call.timing.easing })));
    await settle(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => { motionCalls.length = 0; motion.setPreference('on'); swap('a', 'b'); }); await frames(page);
    const forced = await page.evaluate(() => motionCalls.map(call => ({ id: call.id, duration: call.timing.duration, easing: call.timing.easing })));
    assert.deepEqual(forced, ordinary, 'override does not introduce extra effects, layers or longer durations');
    await settle(page); assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
});

test('forced on creates no continuing idle polling, animation frames or storage reads after a 51-tile transition', browserCase, async t => {
    const { page } = await fixture(t, { reducedMotion: 'reduce' });
    await page.evaluate(() => {
        pane.style.gridTemplateRows = 'repeat(17,minmax(0,1fr))';
        for (let i = 3; i < 51; i++) addItem('budget-' + i, 'div', { index: i });
        projectOverlays(); motion.setPreference('on');
        for (let i = 3; i < 51; i++) swap('a', 'budget-' + i);
    }); await frames(page); await settle(page);
    const activity = await page.evaluate(async () => {
        const originalRaf = window.requestAnimationFrame, originalInterval = window.setInterval,
            originalGet = Storage.prototype.getItem;
        const results = [];
        for (const mode of ['on', 'off']) {
            motion.setPreference(mode);
            const counter = { mode, raf: 0, intervals: 0, storageReads: 0 };
            window.requestAnimationFrame = function (...args) { counter.raf++; return originalRaf.apply(this, args); };
            window.setInterval = function (...args) { counter.intervals++; return originalInterval.apply(this, args); };
            Storage.prototype.getItem = function (...args) { counter.storageReads++; return originalGet.apply(this, args); };
            await new Promise(resolve => setTimeout(resolve, 1000)); results.push(counter);
            window.requestAnimationFrame = originalRaf; window.setInterval = originalInterval; Storage.prototype.getItem = originalGet;
        }
        return results;
    });
    assert.deepEqual(activity, ['on', 'off'].map(mode => ({ mode, raf: 0, intervals: 0, storageReads: 0 })));
    assert.equal(await page.evaluate(() => items.size), 51);
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
    assert.equal(await page.locator('[data-player-motion-ghost]').count(), 0);
    console.log('Motion preference idle sample: 51 tiles, on/off each 1 s, 0 scheduled RAF/interval/storage reads (not a hardware CPU benchmark).');
});
