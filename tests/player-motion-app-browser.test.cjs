'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Keep the existing complete production fixture intact. This wrapper adds the
// shipped motion script at its normal load point and disables only the harness's
// unrelated test registrations. Actual media/audio/layout code stays unchanged.
const harnessFile = path.join(__dirname, 'player-layout-browser.test.cjs');
let harnessSource = fs.readFileSync(harnessFile, 'utf8');
function seam(before, after) {
    assert.equal(harnessSource.split(before).length, 2, 'unique motion harness seam: ' + before);
    harnessSource = harnessSource.replace(before, after);
}
seam('<script src="/player-layout.js"></script><script src="/player-lifecycle.js"></script>',
    '<script src="/player-layout.js"></script><script src="/player-motion.js"></script><script src="/player-lifecycle.js"></script>');
seam("'/player-lifecycle.js':lifecycleScript,", "'/player-lifecycle.js':lifecycleScript,'/player-motion.js':fs.readFileSync(path.join(root,siteFile('site/assets/js/player-motion.js')),'utf8'),");
const harnessRequire = createRequire(harnessFile), harnessModule = { exports: {} };
const harnessTest = Object.assign(() => {}, { before: test.before, after: test.after });
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + harnessSource + '\n' +
    'module.exports={fixture,optional,snapshot,assertContinuity,assertAudioContinuity,seedLayoutSound,waitExactSound};\n})',
    { filename: harnessFile })(name => name === 'node:test' ? harnessTest : harnessRequire(name),
    harnessModule, harnessModule.exports, __dirname, harnessFile);
const { fixture, optional, snapshot, assertContinuity, seedLayoutSound } = harnessModule.exports;
const browserCase = { skip: process.env.UMININN_BROWSER_TESTS !== '1', timeout: 60000 };

async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function settled(f) {
    await f.page.waitForFunction(() => playerAudioBridge.batch === null && playerAudioBridge.queueLength === 0);
    await frames(f.page);
    await f.page.evaluate(() => { for (const animation of document.getAnimations()) { try { animation.finish(); } catch (_) {} } });
    await frames(f.page);
}
async function setup(t, options = {}) {
    if (!optional(t)) return null;
    const f = await fixture(t, { width: 1200, height: 780, audioUserscript: true, ...options });
    await seedLayoutSound(f); await settled(f);
    await f.page.evaluate(() => {
        window.motionQa = [];
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (frames, options) {
            const animation = animate.call(this, frames, options);
            motionQa.push({ element: this, key: this.dataset.channelKey || this.dataset.playerKey,
                duration: animation.effect.getTiming().duration, frames: animation.effect.getKeyframes(),
                initialRect: (() => { const r = this.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })() });
            return animation;
        };
    });
    return f;
}

test('production exchanges animate retained connected media and final overlays without changing sound or frame documents', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f);
    await f.page.evaluate(() => swapPlayerPositions(fixture.keys[0], fixture.keys[2]));
    await f.page.waitForFunction(() => motionQa.some(call => call.duration === 240));
    await settled(f);
    await assertContinuity(f, before);
    assert.equal(await f.page.evaluate(() => [...activePlayers.values()].every(entry => getPlayerElement(entry).isConnected)), true);
    assert.equal(await f.page.evaluate(() => document.querySelectorAll('[data-player-motion-ghost]').length), 0);
});

test('same selection and repeated projection do not replay movement or add audio capture transactions', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f);
    await f.page.evaluate(() => { syncActivePlayers(channels); projectPlayerLayout(); updatePlayerLayout(); });
    await settled(f);
    assert.equal(await f.page.evaluate(() => motionQa.length), 0);
    await assertContinuity(f, before);
    await f.page.evaluate(() => swapPlayerPositions(fixture.keys[0], fixture.keys[2]));
    await f.page.waitForFunction(() => motionQa.some(call => call.duration === 240));
    const effect = await f.page.evaluate(() => {
        window.retainedMotionEffect = getPlayerElement(activePlayers.get(fixture.keys[0])).getAnimations()[0];
        return Boolean(retainedMotionEffect);
    });
    assert.equal(effect, true);
    await f.page.evaluate(() => syncActivePlayers(channels));
    await frames(f.page);
    assert.equal(await f.page.evaluate(() => getPlayerElement(activePlayers.get(fixture.keys[0])).getAnimations().includes(retainedMotionEffect)), true);
    await settled(f);
});

test('metadata-only renaming refreshes names and control titles without animation, audio capture or media replacement', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    await f.page.locator('#more-channels-btn').click();
    await f.page.waitForFunction(() => document.querySelectorAll('.player-name-label').length === 5);
    await settled(f);
    const media = await snapshot(f);
    const before = await f.page.evaluate(() => ({ geometry: getCurrentPlayerGeometry(), audioStart: fixtureLayoutEvents.length }));
    const name = '更正台名 <b> 純文字';
    await f.page.evaluate(async name => {
        const key = fixture.keys[0]; channels = channels.map(channel => ChannelList.channelKey(channel) === key ? { ...channel, name } : channel);
        await syncActivePlayers(channels);
    }, name);
    await f.page.waitForFunction(name => {
        const key = fixture.keys[0];
        const label = document.querySelector('#player-name-overlay [data-player-key="' + key + '"] .player-name-label');
        const enlarge = document.querySelector('#player-window-controls [data-player-key="' + key + '"] [data-player-action="enlarge"]');
        return label?.textContent === name && enlarge?.title.includes(name);
    }, name);
    await settled(f);
    const result = await f.page.evaluate(start => ({ geometry: getCurrentPlayerGeometry(), animations: motionQa.length,
        audio: fixtureLayoutEvents.slice(start).filter(event => event.type === 'umininn-player-layout-before').length,
        html: document.querySelectorAll('#player-name-overlay b').length }), before.audioStart);
    assert.deepEqual(result.geometry, before.geometry); assert.equal(result.animations, 0);
    assert.equal(result.audio, 0); assert.equal(result.html, 0); await assertContinuity(f, media);
});

test('production close retires the audible player immediately while its inert visual shrinks', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const key = await f.page.evaluate(() => fixture.keys[0]);
    const before = await f.page.evaluate(key => { const r = getPlayerElement(activePlayers.get(key)).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }, key);
    await f.page.evaluate(key => { window.closedMotionEntry = activePlayers.get(key); window.closedMotionVideo = closedMotionEntry.resource.video; closePlayer(key); }, key);
    await f.page.waitForFunction(key => !activePlayers.has(key), key);
    const result = await f.page.evaluate(() => ({ disconnected: !closedMotionVideo.isConnected,
        retired: closedMotionEntry.resource.disposed, paused: closedMotionVideo.paused,
        source: closedMotionVideo.getAttribute('src'), ghosts: document.querySelectorAll('[data-player-motion-ghost]').length,
        copies: document.querySelectorAll('[data-player-motion-ghost] video,[data-player-motion-ghost] iframe,[data-player-motion-ghost] audio').length,
        ghostInitial: motionQa.find(call => call.duration === 170)?.initialRect }));
    assert.equal(result.disconnected, true); assert.equal(result.retired, true); assert.equal(result.paused, true);
    assert.equal(result.source, null); assert.ok(result.ghosts >= 1); assert.equal(result.copies, 0);
    assert.ok(result.ghostInitial, 'the disappearing presentation has an actual shrink animation');
    for (const name of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(result.ghostInitial[name] - before[name]) < 1, 'contained-wrapper exit ghost ' + name + ' matches the removed cell');
    await settled(f); assert.equal(await f.page.locator('[data-player-motion-ghost]').count(), 0);
});

test('the legacy initial iframe shrinks on close without staying attached outside the player registry', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    await f.page.evaluate(() => {
        destroyAllHLSInstances();
        const pane = document.getElementById('multi-stream-container'); pane.replaceChildren();
        const frame = document.createElement('iframe'); frame.id = 'MyFrame'; frame.src = 'about:blank'; frame.className = 'full-screen-video';
        pane.appendChild(frame); window.legacyMotionFrame = frame; closePlayer('initial-player');
    });
    await f.page.waitForFunction(() => !legacyMotionFrame.isConnected);
    const result = await f.page.evaluate(() => ({ active: activePlayers.size, attached: document.getElementById('MyFrame') !== null,
        exit: motionQa.some(call => call.duration === 170), ghost: document.querySelectorAll('[data-player-motion-ghost]').length,
        liveCopies: document.querySelectorAll('[data-player-motion-ghost] iframe').length }));
    assert.equal(result.active, 0); assert.equal(result.attached, false); assert.equal(result.exit, true);
    assert.ok(result.ghost > 0); assert.equal(result.liveCopies, 0); await settled(f);
});

test('production selection registers a new loaded iframe once without reloading retained players', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f);
    await f.page.evaluate(() => {
        const origin = new URL(fixture.frames[0].element.src).origin;
        const channel = { name: '新加入', platform: 'bs', id: origin + '/layout-added' };
        window.newMotionKey = ChannelList.channelKey(channel); channels.push(channel); syncActivePlayers(channels);
    });
    await f.page.waitForFunction(() => motionQa.some(call => call.key === newMotionKey && call.duration === 220));
    await settled(f); await assertContinuity(f, before);
    assert.equal(await f.page.evaluate(() => motionQa.filter(call => call.element === getPlayerElement(activePlayers.get(newMotionKey)) && call.duration === 220).length), 1);
    assert.equal(await f.page.evaluate(() => getPlayerElement(activePlayers.get(newMotionKey)).isConnected), true);
});

test('production same-key retry retires the previous presentation and binds enter readiness only to the replacement', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    await f.page.evaluate(() => {
        const origin = new URL(fixture.frames[0].element.src).origin;
        PLATFORMS.at.buildUrl = channel => origin + '/layout-added?retry=' + encodeURIComponent(channel.id);
        const key = fixture.keys[2], entry = activePlayers.get(key);
        window.retryMotionOld = getPlayerElement(entry); window.retryMotionKey = key; entry.failed = true;
        syncActivePlayers(channels);
    });
    await f.page.waitForFunction(() => motionQa.some(call => call.key === retryMotionKey && call.duration === 220));
    const result = await f.page.evaluate(() => ({ same: getPlayerElement(activePlayers.get(retryMotionKey)) === retryMotionOld,
        oldConnected: retryMotionOld.isConnected, entering: motionQa.filter(call => call.element === getPlayerElement(activePlayers.get(retryMotionKey)) && call.duration === 220).length,
        exit: motionQa.some(call => call.duration === 170), connected: getPlayerElement(activePlayers.get(retryMotionKey)).isConnected }));
    assert.equal(result.same, false); assert.equal(result.oldConnected, false); assert.equal(result.entering, 1);
    assert.equal(result.exit, true); assert.equal(result.connected, true); await settled(f);
});

test('refreshing name and window controls during motion does not apply the inverse transform twice', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    await f.page.evaluate(() => toggleChannelSelection());
    await f.page.waitForFunction(() => !document.getElementById('player-name-overlay').hidden);
    await settled(f);
    await f.page.evaluate(() => swapPlayerPositions(fixture.keys[0], fixture.keys[2]));
    await f.page.waitForFunction(() => motionQa.some(call => call.duration === 240));
    await f.page.evaluate(() => {
        for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = 90; }
        playerNameOverlay.refresh(); playerWindowControls.refresh();
    });
    await frames(f.page);
    const differences = await f.page.evaluate(() => {
        const key = fixture.keys[0], a = getPlayerElement(activePlayers.get(key)).getBoundingClientRect();
        return ['player-window-controls', 'player-name-overlay'].map(id => {
            const b = document.querySelector('#' + id + ' [data-player-key="' + key + '"]').getBoundingClientRect();
            return { layer: id, dx: Math.abs(a.x - b.x), dy: Math.abs(a.y - b.y), dw: Math.abs(a.width - b.width), dh: Math.abs(a.height - b.height) };
        });
    });
    for (const value of differences) assert.ok(value.dx < 1.5 && value.dy < 1.5 && value.dw < 1.5 && value.dh < 1.5, 'mid-motion overlay must match player: ' + JSON.stringify(value));
    await settled(f);
});

test('production size changes use final calculated geometry and finish without stale hover controls', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    await f.page.evaluate(() => enlargePlayer(fixture.keys[0]));
    await f.page.waitForFunction(() => getCurrentPlayerGeometry().items.some(item => item.key === fixture.keys[0] && item.span === 2));
    await settled(f);
    assert.ok(await f.page.evaluate(() => motionQa.some(call => call.duration === 240)));
    const result = await f.page.evaluate(() => {
        const main = document.getElementById('multi-stream-container').getBoundingClientRect();
        return [...document.querySelectorAll('#player-window-controls .player-window-cell')].map(cell => {
            const element = getPlayerElement(activePlayers.get(cell.dataset.playerKey)), a = element.getBoundingClientRect(), b = cell.getBoundingClientRect();
            return { dx: Math.abs(a.left - b.left), dy: Math.abs(a.top - b.top), dw: Math.abs(a.width - b.width), dh: Math.abs(a.height - b.height), fits: a.left >= main.left - 1 && a.top >= main.top - 1 && a.right <= main.right + 1 && a.bottom <= main.bottom + 1 };
        });
    });
    assert.ok(result.length > 0);
    for (const item of result) { assert.ok(item.dx < 1 && item.dy < 1 && item.dw < 1 && item.dh < 1); assert.equal(item.fits, true); }
    await f.page.evaluate(() => shrinkPlayer(fixture.keys[0])); await settled(f);
    assert.equal(await f.page.evaluate(() => getCurrentPlayerGeometry().items.every(item => item.span === 1)), true);
    assert.equal(await f.page.evaluate(() => document.getAnimations().length), 0);
});
