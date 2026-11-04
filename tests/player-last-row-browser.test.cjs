'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Keep the complete media, audio, editor and production CSS model. Load the
// shipped motion controller at its normal load point and register only these
// additional regressions, leaving the shared fixture and its tests untouched.
const harnessFile = path.join(__dirname, 'player-layout-browser.test.cjs');
let harnessSource = fs.readFileSync(harnessFile, 'utf8');
function seam(before, after) {
    assert.equal(harnessSource.split(before).length, 2, 'unique last-row fixture seam: ' + before);
    harnessSource = harnessSource.replace(before, after);
}
seam('<script src="/player-layout.js"></script><script src="/player-lifecycle.js"></script>',
    '<script src="/player-layout.js"></script><script src="/player-motion.js"></script><script src="/player-lifecycle.js"></script>');
seam("'/player-lifecycle.js':lifecycleScript,", "'/player-lifecycle.js':lifecycleScript,'/player-motion.js':fs.readFileSync(path.join(root,siteFile('site/assets/js/player-motion.js')),'utf8'),");
const harnessRequire = createRequire(harnessFile), harnessModule = { exports: {} };
const harnessTest = Object.assign(() => {}, { before: test.before, after: test.after });
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + harnessSource + '\n' +
    'module.exports={fixture,optional,snapshot,assertContinuity,assertAudioContinuity,seedLayoutSound,' +
    'fixedDirectionGrid,actualMouseWindowAction,activeMediaSnapshot,assertActiveContinuity,waitExactSound,exactSound,' +
    'startCornerDrag,moveCornerDrag,assertPreviewOnly};\n})',
    { filename: harnessFile })(name => name === 'node:test' ? harnessTest : harnessRequire(name),
    harnessModule, harnessModule.exports, __dirname, harnessFile);
const { fixture, optional, snapshot, assertContinuity, assertAudioContinuity, seedLayoutSound,
    fixedDirectionGrid, actualMouseWindowAction, activeMediaSnapshot, assertActiveContinuity,
    waitExactSound, exactSound, startCornerDrag, moveCornerDrag, assertPreviewOnly } = harnessModule.exports;
const browserCase = { skip: process.env.UMININN_BROWSER_TESTS !== '1', timeout: 90000 };
const cell = (f, key) => f.page.locator(`.player-position-cell[data-player-key=${JSON.stringify(key)}]`);
const near = (a, b, label, tolerance = .65) => assert.ok(Math.abs(a - b) <= tolerance,
    `${label}: ${a} should equal ${b}`);

async function frames(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function settled(f) {
    await f.page.waitForFunction(() => playerAudioBridge.batch === null && playerAudioBridge.queueLength === 0);
    await frames(f.page);
    await f.page.evaluate(() => { for (const animation of document.getAnimations()) { try { animation.finish(); } catch (_) {} } });
    await frames(f.page);
}
async function setup(t, options = {}) {
    if (!optional(t)) return null;
    const f = await fixture(t, { width: 1201, height: 800, viewport: { width: 2000, height: 1300 }, ...options });
    await f.page.route(/\/assets\/(?:images\/)?mother-head-32\.png(?:\?|$)/,
        route => route.fulfill({ status: 204, body: '' }));
    if (options.audioUserscript) await seedLayoutSound(f);
    await settled(f);
    await f.page.evaluate(() => {
        const rect = node => {
            const r = getPlayerMotion().layoutRect(node);
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };
        window.lastRowRead = function () {
            const pane = document.getElementById('multi-stream-container'), p = pane.getBoundingClientRect(), s = getComputedStyle(pane);
            const n = name => parseFloat(s[name]) || 0;
            const content = { left: p.left + n('borderLeftWidth') + n('paddingLeft'),
                right: p.right - n('borderRightWidth') - n('paddingRight'),
                top: p.top + n('borderTopWidth') + n('paddingTop'),
                bottom: p.bottom - n('borderBottomWidth') - n('paddingBottom') };
            content.width = content.right - content.left; content.height = content.bottom - content.top;
            const geometry = JSON.parse(JSON.stringify(getCurrentPlayerGeometry()));
            const editor = document.getElementById('player-position-editor');
            return { geometry, content, gapX: n('columnGap'), gapY: n('rowGap'),
                players: [...activePlayers].map(([key, entry]) => {
                    const element = getPlayerElement(entry);
                    return { key, area: element.style.gridArea, translate: element.style.translate, rect: rect(element) };
                }),
                layers: ['player-window-controls', 'player-name-overlay', 'player-position-editor'].flatMap(id => {
                    const layer = document.getElementById(id);
                    if (!layer || layer.hidden || id === 'player-position-editor' && editor.hidden) return [];
                    return [...layer.querySelectorAll('[data-player-key]')].filter(node =>
                        node.matches('.player-window-cell,.player-name-cell,.player-position-cell')).map(node =>
                        ({ layer: id, key: node.dataset.playerKey, rect: rect(node) }));
                }) };
        };
        window.lastRowAnimations = []; window.lastRowProjects = [];
        const animate = Element.prototype.animate, project = projectPlayerLayout;
        Element.prototype.animate = function (keyframes, options) {
            const player = [...activePlayers].find(([, entry]) => getPlayerElement(entry) === this);
            if (player) lastRowAnimations.push({ key: player[0], duration: options.duration,
                keyframes, display: lastRowRead() });
            return animate.call(this, keyframes, options);
        };
        projectPlayerLayout = function (...args) {
            const value = project.apply(this, args); lastRowProjects.push(lastRowRead()); return value;
        };
    });
    return f;
}
async function read(f) { return f.page.evaluate(() => lastRowRead()); }
async function fixed(f, columns, focus = null) {
    const order = await f.page.evaluate(() => getPlayerPositionKeys());
    await fixedDirectionGrid(f, { columns, focus, order }); await settled(f); return order;
}
function integerGeometry(value, label = 'layout') {
    if (Array.isArray(value)) return value.forEach((item, index) => integerGeometry(item, `${label}[${index}]`));
    if (!value || typeof value !== 'object') return;
    for (const [name, item] of Object.entries(value)) {
        if (['row', 'column', 'span', 'rows', 'columns'].includes(name))
            assert.ok(Number.isInteger(item), `${label}.${name} remains an integer: ${item}`);
        else integerGeometry(item, `${label}.${name}`);
    }
}
function audit(display, { overlays = true } = {}) {
    const { geometry: g, players, content: c, gapX, gapY } = display;
    integerGeometry(g); assert.equal(players.length, g.items.length);
    if (!players.length || c.width <= 0 || c.height <= 0) return { eligible: false, offset: 0 };
    const bottom = Math.max(...g.items.map(item => item.row + item.span)) - 1;
    const tail = g.items.filter(item => item.row <= bottom && item.row + item.span > bottom);
    const eligible = tail.every(item => item.span === 1);
    const tailKeys = new Set(tail.map(item => item.key));
    const tailRects = players.filter(item => tailKeys.has(item.key)).map(item => item.rect);
    const left = Math.min(...tailRects.map(r => r.left)), right = Math.max(...tailRects.map(r => r.right));
    const pitchX = (c.width + gapX) / g.columns, pitchY = (c.height + gapY) / g.rows;
    const firstColumn = Math.min(...tail.map(item => item.column));
    const logicalLeft = c.left + firstColumn * pitchX;
    const offset = eligible ? (c.width - (Math.max(...tail.map(item => item.column + 1)) - firstColumn) * pitchX + gapX) / 2 - firstColumn * pitchX : 0;
    if (eligible) near(left - c.left, c.right - right, 'the complete final small-tile group is centered');
    else near(left, logicalLeft, 'a square intersecting the bottom keeps the logical row position');
    for (const player of players) {
        const item = g.items.find(item => item.key === player.key), r = player.rect;
        assert.ok(r.width > 0 && r.height > 0, player.key + ' has positive dimensions');
        assert.ok(r.left >= c.left - .7 && r.right <= c.right + .7 && r.top >= c.top - .7 && r.bottom <= c.bottom + .7,
            player.key + ' fits inside the pane content');
        near(r.left, c.left + item.column * pitchX + (eligible && tailKeys.has(item.key) ? offset : 0), player.key + ' projected x');
        near(r.top, c.top + item.row * pitchY, player.key + ' projected y');
        near(r.width, item.span * pitchX - gapX, player.key + ' width');
        near(r.height, item.span * pitchY - gapY, player.key + ' height');
    }
    for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
        const a = players[i].rect, b = players[j].rect;
        assert.ok(a.right <= b.left + .7 || b.right <= a.left + .7 || a.bottom <= b.top + .7 || b.bottom <= a.top + .7,
            `${players[i].key} and ${players[j].key} do not overlap`);
    }
    if (overlays) for (const layer of display.layers) {
        const player = players.find(item => item.key === layer.key); assert.ok(player);
        for (const side of ['left', 'top', 'right', 'bottom']) near(layer.rect[side], player.rect[side], layer.layer + ' ' + layer.key + ' ' + side);
    }
    return { eligible, offset, tail: tail.map(item => item.key) };
}
async function auditStored(f) {
    const stored = await f.page.evaluate(() => ({ geometry: getCurrentPlayerGeometry(),
        values: ['playerEnlargementLayout', 'playerPositionOrder', 'playerFocusSwapMemory'].map(key => {
            try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; }
        }) }));
    integerGeometry(stored);
}
async function clearMotion(f) { await f.page.evaluate(() => { lastRowAnimations = []; lastRowProjects = []; }); }
async function auditMotion(f) {
    const result = await f.page.evaluate(() => ({ animations: lastRowAnimations, projects: lastRowProjects }));
    for (const display of result.projects) audit(display, { overlays: false });
    for (const animation of result.animations) audit(animation.display, { overlays: false });
    const moves = result.animations.filter(item => item.duration === 240);
    for (const key of new Set(moves.map(item => item.key)))
        assert.equal(moves.filter(item => item.key === key).length, 1, key + ' receives one FLIP movement');
    return result;
}

test('counts 5 through 17 center every incomplete final row while full rows and a single column stay flush', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f); let centered = 0, flush = 0;
    for (let count = 5; count <= 17; count++) {
        if (count > 5) await f.page.evaluate(index => {
            const channel = { id: 'tail-' + index, platform: 'at', name: '佔位 ' + index };
            channels.push(channel); fixture.addPlaceholder(channel); syncActivePlayers(channels);
        }, count);
        await settled(f);
        const result = audit(await read(f)); Math.abs(result.offset) > 1 ? centered++ : flush++;
        await auditStored(f);
    }
    assert.ok(centered > 0 && flush > 0, 'the real fit algorithm covers partial and complete rows');
    await fixed(f, 1); const one = audit(await read(f)); near(one.offset, 0, 'one-column offset');
    await assertContinuity(f, before);
});

test('odd half-pitch rows use the actual bordered padded content width and nonzero gaps at small sizes', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f);
    for (const size of [{ width: 1001, height: 803, gap: 7 }, { width: 151, height: 127, gap: 3 }, { width: 61, height: 89, gap: 1 }]) {
        await f.page.evaluate(({ width, height, gap }) => {
            fixture.resize(width, height);
            const pane = document.getElementById('multi-stream-container');
            pane.style.padding = '3px 5px'; pane.style.border = '2px solid transparent'; pane.style.gap = gap + 'px';
        }, size);
        await f.page.waitForTimeout(240); await fixed(f, 4);
        const result = audit(await read(f)); assert.ok(result.eligible && result.offset > 0);
    }
    await assertContinuity(f, before);
});

test('an enlarged square reaching the final row prevents translation of every intersecting tile', browserCase, async t => {
    const f = await setup(t, { players: 7 }); if (!f) return;
    const keys = await fixed(f, 4), before = await snapshot(f);
    await fixed(f, 4, { key: keys[0], row: 1, column: 0, span: 2 });
    const state = await read(f), result = audit(state);
    assert.equal(result.eligible, false); near(result.offset, 0, 'bottom-square offset');
    assert.ok(state.geometry.items.some(item => item.span > 1 && item.row + item.span === state.geometry.rows));
    await f.page.locator('#adjust-player-positions').click(); await frames(f.page); audit(await read(f));
    await f.page.keyboard.press('Escape'); await assertContinuity(f, before);
});

test('exchange, large-tile swap, heart promotion, growth and shrink project their final centered arrangement before movement', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const keys = await fixed(f, 4), before = await snapshot(f);
    const operations = [
        () => f.page.evaluate(keys => swapPlayerPositions(keys[0], keys[4]), keys),
        () => f.page.evaluate(key => enlargePlayer(key), keys[0]),
        () => actualMouseWindowAction(f, keys[4], 'swap-focus'),
        () => f.page.evaluate(key => shrinkPlayer(key), keys[4]),
        () => actualMouseWindowAction(f, keys[1], 'promote-top-right'),
        () => f.page.evaluate(key => enlargePlayer(key), keys[1]),
        () => f.page.evaluate(key => shrinkPlayer(key), keys[1]),
        () => f.page.evaluate(() => resetPlayerPositions())
    ];
    for (const operation of operations) {
        await clearMotion(f); await operation(); await settled(f);
        audit(await read(f)); await auditMotion(f); await auditStored(f);
    }
    await assertContinuity(f, before);
});

test('names, window controls and both editor modes coincide with translated final media bounds', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    await fixed(f, 4); const before = await snapshot(f);
    await f.page.locator('#more-channels-btn').click(); await frames(f.page);
    let state = await read(f); audit(state);
    assert.equal(state.layers.filter(layer => layer.layer === 'player-name-overlay').length, 5);
    for (const selector of ['#adjust-player-positions', '#enlarge-player']) {
        await f.page.locator(selector).click(); await frames(f.page); state = await read(f); audit(state);
        assert.equal(state.layers.filter(layer => layer.layer === 'player-position-editor').length, 5);
        await f.page.keyboard.press('Escape'); await settled(f);
    }
    await assertContinuity(f, before);
});

test('vertical keyboard movement selects the closest projected tile and real dragging hits the centered target', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const keys = await fixed(f, 4), before = await snapshot(f);
    await f.page.locator('#adjust-player-positions').click(); await frames(f.page);
    await cell(f, keys[4]).press('ArrowUp'); await settled(f);
    const order = await f.page.evaluate(() => getPlayerPositionKeys());
    assert.equal(order.indexOf(keys[4]), 1, 'the centered bottom tile chooses the nearest top-row center, with stable left tie');
    audit(await read(f));
    await f.page.keyboard.press('Escape'); await fixed(f, 4); await f.page.locator('#adjust-player-positions').click();
    const sourceKey = keys[0], targetKey = (await read(f)).geometry.items.find(item => item.row === 1).key;
    const a = await cell(f, sourceKey).boundingBox(), b = await cell(f, targetKey).boundingBox();
    assert.ok(a && b);
    await f.page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await f.page.mouse.down();
    await f.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
    await f.page.waitForFunction(key => document.querySelector('.position-target')?.dataset.playerKey === key, targetKey);
    await f.page.mouse.up(); await settled(f);
    const moved = await read(f); audit(moved);
    assert.equal(moved.geometry.items.find(item => item.key === sourceKey).row, 1);
    await f.page.keyboard.press('Escape'); await assertContinuity(f, before);
});

test('direction controls cover only positive projected edge intersections and remain clickable', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const keys = await fixed(f, 4), before = await snapshot(f);
    const result = await f.page.evaluate(() => {
        const state = lastRowRead(), byKey = new Map(state.players.map(item => [item.key, item.rect]));
        return [...document.querySelectorAll('.player-direction-button')].map(button => {
            const key = button.closest('.player-window-cell').dataset.playerKey, target = button.dataset.targetKey;
            const a = byKey.get(key), b = byKey.get(target), direction = button.dataset.playerAction.replace('swap-', '');
            const vertical = direction === 'up' || direction === 'down';
            const overlap = vertical ? Math.min(a.right, b.right) - Math.max(a.left, b.left) : Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            const r = button.getBoundingClientRect();
            return { key, target, direction, overlap, width: r.width, height: r.height };
        });
    });
    assert.ok(result.length > 0);
    for (const value of result) assert.ok(value.overlap > .5 && value.width > 0 && value.height > 0, JSON.stringify(value));
    const bottomKey = keys[4], up = result.filter(value => value.key === bottomKey && value.direction === 'up');
    assert.deepEqual(up.map(value => value.target).sort(), keys.slice(1, 3).sort(), 'half-column centering exposes both genuine upward neighbors');
    const arrow = f.page.locator(`.player-window-cell[data-player-key=${JSON.stringify(bottomKey)}] [data-player-action="swap-up"][data-target-key=${JSON.stringify(up[0].target)}]`);
    await f.page.keyboard.press('Tab'); await arrow.focus(); await arrow.hover(); await arrow.click();
    await settled(f); audit(await read(f)); await assertContinuity(f, before);
});

test('corner preview starts at the centered tile and commits a single fitted layout on release', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const keys = await fixed(f, 4), before = await snapshot(f), key = keys[4];
    await f.page.locator('#enlarge-player').click(); await frames(f.page);
    const initial = await read(f), original = initial.players.find(item => item.key === key).rect;
    const drag = await startCornerDrag(f, key, 'ne');
    await moveCornerDrag(f, drag, 1.1, .3); await assertPreviewOnly(f, drag);
    const preview = await f.page.locator('.player-resize-preview').boundingBox(); assert.ok(preview);
    near(preview.x, original.left, 'preview retains the translated starting left edge');
    near(preview.y + preview.height, original.bottom, 'preview retains the opposite starting bottom edge');
    assert.deepEqual((await read(f)).geometry, initial.geometry, 'preview keeps the committed integer cells');
    await clearMotion(f); await f.page.mouse.up(); await settled(f);
    audit(await read(f)); await auditMotion(f); await auditStored(f);
    await f.page.keyboard.press('Escape'); await assertContinuity(f, before);
});

test('a translate-only final-row change animates an unchanged grid area once with the final centering already applied', browserCase, async t => {
    const f = await setup(t, { players: 6, height: 600 }); if (!f) return;
    const keys = await fixed(f, 3), tail = keys[3];
    const old = (await read(f)).players.find(item => item.key === tail);
    const retained = await activeMediaSnapshot(f, keys.slice(0, 5), { remember: true });
    await clearMotion(f);
    await f.page.evaluate(key => closePlayer(key), keys[5]); await settled(f);
    const current = (await read(f)).players.find(item => item.key === tail);
    assert.equal(current.area, old.area, 'the retained tile stays in its logical grid cell');
    assert.notEqual(current.translate, old.translate, 'only its final-row presentation offset changes');
    const result = await auditMotion(f);
    assert.equal(result.animations.filter(item => item.key === tail && item.duration === 240).length, 1);
    await assertActiveContinuity(f, retained);
});

test('bookmark return and ordinary, zero-size and restored pane reflows preserve integer layouts and final row centering', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const keys = await fixed(f, 4), before = await snapshot(f);
    const saved = await f.page.evaluate(async () => { const value = await capturePlayerBookmark(); delete value.audio; return value; });
    integerGeometry(saved);
    await f.page.evaluate(keys => swapPlayerPositions(keys[0], keys[4]), keys); await settled(f);
    await f.page.evaluate(value => applyPlayerBookmark(value), saved); await settled(f);
    audit(await read(f)); await auditStored(f);
    for (const [width, height] of [[797, 613], [319, 1031], [0, 0], [1201, 800]]) {
        await clearMotion(f); await f.page.evaluate(([width, height]) => fixture.resize(width, height), [width, height]);
        await f.page.waitForTimeout(250); await settled(f);
        if (width) { audit(await read(f)); await auditMotion(f); }
        await auditStored(f);
    }
    await assertContinuity(f, before);
});

test('selection, start reset and same-key error replacement keep projected rows and retained media aligned', browserCase, async t => {
    const f = await setup(t, { players: 7 }); if (!f) return;
    const keys = await fixed(f, 4), retained = await activeMediaSnapshot(f, keys.slice(0, 5), { remember: true });
    await f.page.evaluate(() => syncActivePlayers(channels.slice(0, 6))); await settled(f); audit(await read(f));
    await f.page.evaluate(() => generateChannelOptions());
    await f.page.locator('#more-channels-btn').click();
    await f.page.locator('#fixture-watch-selected').click();
    await settled(f); audit(await read(f)); await assertActiveContinuity(f, retained);
    await f.page.evaluate(() => replacePlayerWithError(fixture.entries[1].resource, '本地播放失敗'));
    await settled(f); audit(await read(f));
    assert.equal(await f.page.evaluate(() => {
        const entry = activePlayers.get(fixture.keys[1]);
        return entry.failed && entry.resource.errorShown && getPlayerElement(entry).textContent.includes('本地播放失敗');
    }), true);
    await f.page.locator('#adjust-player-positions').click(); await frames(f.page); audit(await read(f));
    await f.page.keyboard.press('Escape'); await auditStored(f);
    await f.page.evaluate(() => syncActivePlayers(channels.slice(0, 1))); await settled(f);
    const single = await read(f); audit(single);
    assert.equal(single.geometry.items.length, 1); near(single.players[0].rect.left, single.content.left, 'a single player fills its pane');
});

test('off and reduced-motion auto apply final centering immediately and retain the latest manual sound and foreign documents', browserCase, async t => {
    const f = await setup(t, { audioUserscript: true }); if (!f) return;
    const keys = await fixed(f, 4);
    for (const preference of ['off', 'auto']) {
        await f.page.emulateMedia({ reducedMotion: 'reduce' });
        await f.page.evaluate(preference => getPlayerMotion().setPreference(preference), preference);
        const before = await seedLayoutSound(f), expected = exactSound(before);
        await clearMotion(f);
        await f.page.evaluate(keys => swapPlayerPositions(keys[0], keys[4]), keys); await settled(f);
        audit(await read(f)); await auditMotion(f); await waitExactSound(f, expected);
        assert.equal(await f.page.evaluate(() => lastRowAnimations.length), 0);
        await assertAudioContinuity(f, before);
    }
});

test('a centered foreign iframe fills native fullscreen and returns to its centered cell without replacing media', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const key = await f.page.evaluate(() => fixture.keys[2]);
    const order = await f.page.evaluate(key => [...getPlayerPositionKeys().filter(value => value !== key), key], key);
    await fixedDirectionGrid(f, { columns: 4, order }); await settled(f);
    const initial = await read(f), original = initial.players.find(item => item.key === key);
    assert.ok(audit(initial).tail.includes(key));
    assert.ok(parseFloat(original.translate) > 0, 'the iframe starts with an actual final-row translation');
    await f.page.locator('#more-channels-btn').click(); await frames(f.page);
    assert.equal(await f.page.locator('#player-name-overlay').isVisible(), true);
    const before = await snapshot(f);
    await f.page.evaluate(key => {
        const button = document.createElement('button'); button.id = 'last-row-fullscreen'; button.textContent = '全螢幕';
        window.lastRowFullscreenError = null;
        button.onclick = () => getPlayerElement(activePlayers.get(key)).requestFullscreen().catch(error => {
            lastRowFullscreenError = error.name + ': ' + error.message;
        });
        document.getElementById('more-channels-btn').after(button);
    }, key);
    await f.page.locator('#last-row-fullscreen').click();
    await f.page.waitForFunction(() => document.fullscreenElement || lastRowFullscreenError);
    assert.equal(await f.page.evaluate(() => lastRowFullscreenError), null, 'trusted input must enter actual native fullscreen');
    await f.page.waitForFunction(() => document.fullscreenElement && document.getElementById('player-window-controls').hidden && document.getElementById('player-name-overlay').hidden);
    await frames(f.page);
    const fullscreen = await f.page.evaluate(key => {
        const element = getPlayerElement(activePlayers.get(key)), r = element.getBoundingClientRect();
        return { actual: document.fullscreenElement === element, translate: getComputedStyle(element).translate,
            inline: element.style.translate, left: r.left, top: r.top, width: r.width, height: r.height,
            viewport: { width: innerWidth, height: innerHeight } };
    }, key);
    assert.equal(fullscreen.actual, true); assert.equal(fullscreen.translate, 'none');
    assert.equal(fullscreen.inline, original.translate, 'fullscreen overrides presentation without discarding the return offset');
    near(fullscreen.left, 0, 'fullscreen left'); near(fullscreen.top, 0, 'fullscreen top');
    near(fullscreen.width, fullscreen.viewport.width, 'fullscreen width');
    near(fullscreen.height, fullscreen.viewport.height, 'fullscreen height');
    assert.equal(await f.page.locator('#player-window-controls').isVisible(), false);
    assert.equal(await f.page.locator('#player-name-overlay').isVisible(), false);
    await f.page.evaluate(() => document.exitFullscreen());
    await f.page.waitForFunction(() => !document.fullscreenElement); await settled(f);
    const returned = await read(f), restored = returned.players.find(item => item.key === key); audit(returned);
    for (const side of ['left', 'top', 'width', 'height']) near(restored.rect[side], original.rect[side], 'restored iframe ' + side);
    assert.equal(await f.page.evaluate(() => document.querySelectorAll('[data-player-motion],[data-player-motion-ghost]').length), 0);
    await assertContinuity(f, before);
});
