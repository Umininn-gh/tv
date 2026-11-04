'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');

// Reuse production app/CSS/media with only this file's focused cases registered.
// The broad layout suite and its feature cases remain independent.
const harnessFile = path.join(__dirname, 'player-layout-browser.test.cjs');
const harnessRequire = createRequire(harnessFile), harnessModule = { exports: {} };
const harnessTest = Object.assign(() => {}, { before: test.before, after: test.after });
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + fs.readFileSync(harnessFile, 'utf8') + '\n' +
    'module.exports={fixture,optional,snapshot,assertContinuity,readLayout,geometry,fixedDirectionGrid,waitWindowGeometry,' +
    'startCornerDrag,moveCornerDrag,assertPreviewOnly,assertResizeIdle,waitSpan,assertEditorUiClosed,activeMediaSnapshot,assertActiveContinuity};\n})',
    { filename: harnessFile })(name => name === 'node:test' ? harnessTest : harnessRequire(name),
    harnessModule, harnessModule.exports, __dirname, harnessFile);
const { fixture, optional, snapshot, assertContinuity, readLayout, geometry, fixedDirectionGrid, waitWindowGeometry,
    startCornerDrag, moveCornerDrag, assertPreviewOnly, assertResizeIdle, waitSpan, assertEditorUiClosed, activeMediaSnapshot, assertActiveContinuity } = harnessModule.exports;
const browserCase = { skip: process.env.UMININN_BROWSER_TESTS !== '1', timeout: 60000 };
const corners = ['nw', 'ne', 'sw', 'se'];
const cell = (f, key) => f.page.locator(`.player-window-cell[data-player-key=${JSON.stringify(key)}]`);
const shortcut = (f, key, corner = 'nw') => cell(f, key).locator(`.player-window-enlarge-corner[data-enlarge-corner="${corner}"]`);

async function setup(t, options = {}) {
    if (!optional(t)) return null;
    const f = await fixture(t, { width: 1200, height: 900, viewport: { width: 1600, height: 1300 }, players: 9, clock: true, ...options });
    const keys = await f.page.evaluate(() => getPlayerPositionKeys());
    await fixedDirectionGrid(f, { columns: 3, order: keys });
    return { f, keys, key: keys[4] };
}
async function assertMode(f, seconds, mode = 'enlarge') {
    const state = await geometry(f);assert.equal(state.opened, true);assert.equal(state.mode, mode);
    assert.match(await f.page.locator('.player-position-instructions').innerText(), new RegExp('閒置\\s*' + seconds + '\\s*秒'));
}
async function openCorner(f, key, corner = 'nw', seconds = 10) {
    const point = await hoverCorner(f, key, corner);
    assert.equal(await shortcut(f, key, corner).evaluate((node, point) => document.elementFromPoint(point.x, point.y)?.closest('button') === node, point), true);
    await f.page.mouse.click(point.x, point.y);await assertMode(f, seconds);
    assert.equal(await f.page.evaluate(key => document.activeElement?.dataset.playerKey === key, key), true, 'entry focuses the chosen editor tile without resizing it');
}
async function hoverCorner(f, key, corner) {
    const box = await shortcut(f, key, corner).boundingBox();assert.ok(box && box.width > 0 && box.height > 0);
    // The original move/close controls keep their entire hitbox. Enter through
    // the real thin L outside their three-pixel inset, not a covered box center.
    const point = { x: corner.endsWith('w') ? box.x + 1.5 : box.x + box.width - 1.5,
        y: corner.startsWith('n') ? box.y + 1.5 : box.y + box.height - 1.5 };
    await f.page.mouse.move(point.x, point.y);return point;
}
async function finishAt(f, duration) {
    await f.page.clock.runFor(duration - 1);assert.equal((await geometry(f)).opened, true);
    await f.page.clock.runFor(1);await assertEditorUiClosed(f);
    await f.page.clock.runFor(50);await waitWindowGeometry(f);
}
async function deliverResize(f) {
    // Native ResizeObserver delivery is tied to a real rendering opportunity;
    // advancing the paused JavaScript clock alone cannot deliver that event.
    await f.page.waitForTimeout(40);await f.page.clock.runFor(300);
    await f.page.waitForTimeout(40);await f.page.clock.runFor(50);
}

async function cornerEvidence(f) {
    return f.page.evaluate(() => {
        const bounds = document.getElementById('multi-stream-container').getBoundingClientRect(), grid=getCurrentPlayerGeometry(),positions=new Map(grid.items.map(item=>[item.key,item])),actual = [], expected = [];
        for (const tile of document.querySelectorAll('.player-window-cell')) {
            const r = tile.getBoundingClientRect();
            for (const corner of ['nw', 'ne', 'sw', 'se']) {
                const x = corner.endsWith('w') ? r.left : r.right, y = corner.startsWith('n') ? r.top : r.bottom;
                const button = tile.querySelector(`.player-window-enlarge-corner[data-enlarge-corner="${corner}"]`);
                const item=positions.get(tile.dataset.playerKey);
                // This full3×3 fixture gives semantic outer edges independent
                // of subpixel track rounding and the browser's pane border.
                if ((corner.endsWith('w')?item.column>0:item.column+item.span<grid.columns)&&
                    (corner.startsWith('n')?item.row>0:item.row+item.span<grid.rows)) expected.push(tile.dataset.playerKey + ':' + corner);
                if (button && !button.hidden && getComputedStyle(button).display !== 'none') {
                    const b = button.getBoundingClientRect(), style = getComputedStyle(button);
                    actual.push({ id: tile.dataset.playerKey + ':' + corner, action: button.dataset.playerAction, width: b.width, height: b.height,
                        opacity: Number(style.opacity), background: style.backgroundColor, distances:[x-bounds.left,bounds.right-x,y-bounds.top,bounds.bottom-y] });
                }
            }
        }
        return { actual, expected };
    });
}
async function visibleCornerIds(f) {
    return f.page.locator('.player-window-enlarge-corner:not([hidden])').evaluateAll(buttons => buttons
        .filter(button => button.getClientRects().length && getComputedStyle(button).display !== 'none' && Number(getComputedStyle(button).opacity) > 0)
        .map(button => button.closest('.player-window-cell').dataset.playerKey + ':' + button.dataset.enlargeCorner).sort());
}
async function hoverTileCenter(f, key) {
    const box = await cell(f, key).boundingBox();assert.ok(box);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await f.page.mouse.move(point.x, point.y, { steps: 8 });await f.page.waitForTimeout(40);
    await f.page.waitForFunction(key => [...document.querySelectorAll('.player-window-enlarge-corner:not([hidden])')].every(button =>
        Number(getComputedStyle(button).opacity) === (button.closest('.player-window-cell').dataset.playerKey === key ? .65 : 0)), key);
    assert.equal(await cell(f, key).getAttribute('data-hovered'), 'true', 'a real pointer over the media center reveals its own controls');
    return point;
}
async function leaveGrid(f) {
    await f.page.mouse.move(1590, 1290);
    await f.page.waitForFunction(() => [...document.querySelectorAll('.player-window-enlarge-corner:not([hidden])')].every(button => Number(getComputedStyle(button).opacity) === 0));
}

test('hovering anywhere in a tile reveals every eligible corner and hides them when moving to another tile or outside', browserCase, async t => {
    const setupResult = await setup(t, { clock: false });if (!setupResult) return;const { f, keys, key } = setupResult, before = await snapshot(f);
    await leaveGrid(f);assert.deepEqual(await visibleCornerIds(f), []);
    const center = await hoverTileCenter(f, key);
    assert.deepEqual(await visibleCornerIds(f), corners.map(corner => key + ':' + corner).sort(), 'all four interior corners appear together from a center hover');
    const cornersAtCenter = await cell(f, key).locator('.player-window-enlarge-corner').evaluateAll(buttons => buttons.map(button => ({
        opacity: Number(getComputedStyle(button).opacity), hovered: button.matches(':hover')
    })));
    assert.ok(cornersAtCenter.every(button => button.opacity === .65 && !button.hovered), JSON.stringify(cornersAtCenter));
    await cell(f, key).screenshot({ path: path.join(__dirname, '..', '..', 'corner-tile-hover-' + process.env.UMININN_BROWSER_ENGINE + '-middle.png') });
    assert.equal(await f.page.evaluate(point => document.elementFromPoint(point.x, point.y)?.id, center), 'native-4', 'revealed corner UI never intercepts the media center');
    await hoverTileCenter(f, keys[0]);
    assert.deepEqual(await visibleCornerIds(f), [keys[0] + ':se'], 'an outer corner tile reveals only its sole eligible inward corner');
    await leaveGrid(f);
    assert.deepEqual(await visibleCornerIds(f), [], 'leaving the whole grid clears every hover-only shortcut');
    await assertContinuity(f, before);

    // Playwright Chromium OOPIF input cannot update the parent :hover chain.
    // Firefox exercises the actual foreign frame hover path without synthetic
    // events or attributes; Chromium still exercises native and overlay input.
    if (process.env.UMININN_BROWSER_ENGINE === 'firefox') for (const [name, options] of [
        ['direct foreign frame', {}], ['scaled Kick frame', { productionKick: true }], ['nested Twitch frame', { productionTwitch: true }]
    ]) await t.test(name, async st => {
        const result = await setup(st, { ...options, clock: false });if (!result) return;const { f, keys } = result;
        const target = keys[2], order = [...keys];[order[2], order[4]] = [order[4], order[2]];
        await fixedDirectionGrid(f, { columns: 3, order });const before = await snapshot(f);
        await hoverTileCenter(f, target);
        assert.deepEqual(await visibleCornerIds(f), corners.map(corner => target + ':' + corner).sort(), name + ' reveals all eligible corners from its content center');
        await hoverCorner(f, target, 'nw');await f.page.waitForTimeout(40);
        assert.deepEqual(await visibleCornerIds(f), corners.map(corner => target + ':' + corner).sort(), 'handoff from a foreign player to its corner retains all four shortcuts');
        await leaveGrid(f);
        assert.deepEqual(await visibleCornerIds(f), []);await assertContinuity(f, before);
    });
});

test('corner shortcuts exclude player-pane edges while preserving small hitboxes and existing controls and media centers', browserCase, async t => {
    const setupResult = await setup(t);if (!setupResult) return;const { f, key } = setupResult, before = await snapshot(f);
    await f.page.mouse.move(1590, 1290);await f.page.clock.runFor(32);
    const evidence = await cornerEvidence(f);
    assert.deepEqual(evidence.actual.map(value => value.id).sort(), evidence.expected.sort());assert.equal(evidence.actual.length, 16, 'only interior player-pane corners are eligible even when the pane is inset from the viewport: '+JSON.stringify(evidence.actual.filter(value=>Math.min(...value.distances)<2)));
    assert.ok(evidence.actual.every(value => value.action === 'enlarge-mode' && value.width > 0 && value.width <= 12 && value.height > 0 && value.height <= 12 && value.opacity === 0 && value.background === 'rgba(0, 0, 0, 0)'), JSON.stringify(evidence));
    for (const corner of corners) {
        await hoverCorner(f, key, corner);await f.page.clock.runFor(32);await f.page.waitForTimeout(40);
        const visual = await shortcut(f, key, corner).evaluate(node => {const style=getComputedStyle(node),transform=getComputedStyle(node.querySelector('svg')).transform,matrix=transform==='none'?new DOMMatrix():new DOMMatrix(transform),r=node.getBoundingClientRect();return {opacity:Number(style.opacity),hovered:node.matches(':hover'),matrix:[matrix.a,matrix.b,matrix.c,matrix.d],hit:document.elementFromPoint(r.left+(node.dataset.enlargeCorner.endsWith('w')?1.5:r.width-1.5),r.top+(node.dataset.enlargeCorner.startsWith('n')?1.5:r.height-1.5))?.closest('button')?.dataset.playerAction}});
        assert.ok(visual.opacity > 0 && visual.opacity < 1, 'the hovered tile keeps this corner translucent: '+corner+' '+JSON.stringify(visual));
        const expected={nw:[1,0,0,1],ne:[0,1,-1,0],sw:[0,-1,1,0],se:[-1,0,0,-1]}[corner];
        visual.matrix.forEach((value,index)=>assert.ok(Math.abs(value-expected[index])<1e-6,'the '+corner+' glyph rotates into its own corner orientation'));
        if(process.env.UMININN_CORNER_TIMEOUT_SCREENSHOTS){const folder=path.resolve(process.env.UMININN_CORNER_TIMEOUT_SCREENSHOTS);fs.mkdirSync(folder,{recursive:true});await cell(f,key).screenshot({path:path.join(folder,process.env.UMININN_BROWSER_ENGINE+'-'+corner+'.png')})}
    }
    await f.page.keyboard.press('Tab');
    for (const action of ['move', 'promote-top-right', 'enlarge', 'close']) {
        const button = cell(f, key).locator(`[data-player-action="${action}"]`);await button.focus();
        assert.equal(await button.evaluate(node => { const r = node.getBoundingClientRect();return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button') === node; }), true, action + ' keeps its existing center hit target');
    }
    assert.deepEqual(await cell(f,key).evaluate(node=>{const r=node.getBoundingClientRect();return [[r.left+6,r.top+6],[r.right-6,r.top+6]].map(([x,y])=>document.elementFromPoint(x,y)?.closest('button')?.dataset.playerAction)}),['move','close'],'the old controls retain even their near-corner hit areas');
    assert.equal(await f.page.evaluate(() => [...activePlayers.values()].every(entry => { const node = getPlayerElement(entry), r = node.getBoundingClientRect();return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === node; })), true);
    await f.page.evaluate(()=>{const wrapper=document.getElementById('multi-stream-container-wrapper'),pane=document.getElementById('multi-stream-container');window.cornerFixtureHostStyle=wrapper.style.cssText;window.cornerFixturePaneBorder=pane.style.border;wrapper.style.position='fixed';wrapper.style.left='0';wrapper.style.top='0';wrapper.style.padding='0';pane.style.border='0';fixture.resize(innerWidth,innerHeight)});
    await deliverResize(f);await fixedDirectionGrid(f,{columns:3});
    const flush = await cornerEvidence(f);assert.deepEqual(flush.actual.map(value=>value.id).sort(),flush.expected.sort());assert.equal(flush.actual.length,16,'pane-border exclusion stays aligned after resizing the pane');
    await f.page.evaluate(() => { fixture.resize(132, 8); });await deliverResize(f);
    assert.equal(await f.page.locator('.player-window-enlarge-corner:not([hidden])').count(), 0, 'unusable tiny tiles have no corner shortcut');
    await f.page.evaluate(() => {document.getElementById('multi-stream-container-wrapper').style.cssText=cornerFixtureHostStyle;document.getElementById('multi-stream-container').style.border=cornerFixturePaneBorder});await deliverResize(f);
    await f.page.evaluate(()=>fixture.resize(132,8));await deliverResize(f);
    const unusable=await f.page.evaluate(()=>{
        const pane=document.getElementById('multi-stream-container'),tile=getPlayerElement(activePlayers.values().next().value),rect=value=>({left:value.left,top:value.top,width:value.width,height:value.height});
        return {paneClient:[pane.clientWidth,pane.clientHeight],pane:rect(pane.getBoundingClientRect()),actualTile:rect(tile.getBoundingClientRect()),logicalTile:rect(getPlayerLayoutRect(tile)),
            visible:Array.from(document.querySelectorAll('.player-window-enlarge-corner')).filter(button=>!button.hidden).map(button=>({key:button.closest('.player-window-cell').dataset.playerKey,corner:button.dataset.enlargeCorner}))};
    });
    assert.equal(unusable.paneClient[1],0,'the padded tiny probe reaches the intended zero-client-height pane: '+JSON.stringify(unusable));
    assert.equal(unusable.visible.length,0,'padding can make the pane unmeasurable, which must not expose shortcuts from cached geometry: '+JSON.stringify(unusable));
    await f.page.evaluate(()=>{document.getElementById('multi-stream-container-wrapper').style.cssText=cornerFixtureHostStyle});await deliverResize(f);await assertContinuity(f, before);
});

test('each actual corner entry uses ten idle seconds and only entering or expiring keeps the exact layout and media', browserCase, async t => {
    const setupResult = await setup(t);if (!setupResult) return;const { f, key } = setupResult, before = await snapshot(f), initial = await readLayout(f);
    assert.deepEqual(await f.page.evaluate(() => [PLAYER_OVERLAY_TIMEOUT_SECONDS, PLAYER_CORNER_ENLARGE_TIMEOUT_SECONDS]), [30, 10]);
    for (const corner of corners) {
        await openCorner(f, key, corner);assert.deepEqual((await readLayout(f)).logical, initial.logical);
        await finishAt(f, 10000);assert.deepEqual((await readLayout(f)).logical, initial.logical);
        assert.equal(await shortcut(f, key, corner).evaluate(node => node === document.activeElement), true, 'idle completion returns focus to its still-live corner shortcut');
    }
    await assertContinuity(f, before);
});

test('corner and ordinary editor entries replace old deadlines while keeping their ten and thirty second hints', browserCase, async t => {
    const setupResult = await setup(t);if (!setupResult) return;const { f, key } = setupResult, before = await snapshot(f);
    for (const [selector, mode] of [['#enlarge-player', 'enlarge'], ['#adjust-player-positions', 'move']]) {
        await openCorner(f, key);await f.page.clock.runFor(9000);await f.page.locator(selector).click();await assertMode(f, 30, mode);
        await f.page.clock.runFor(1001);assert.equal((await geometry(f)).opened, true, 'the replaced ten-second deadline cannot close the ordinary editor');
        await finishAt(f, 30000 - 1001);
        await f.page.locator(selector).click();await assertMode(f, 30, mode);await f.page.clock.runFor(29000);await f.page.keyboard.press('Escape');
        await f.page.clock.runFor(32);await openCorner(f, key);await f.page.clock.runFor(1001);
        assert.equal((await geometry(f)).opened, true, 'the closed thirty-second session cannot close a new corner session');await finishAt(f, 10000 - 1001);
    }
    await assertContinuity(f, before);
});

test('independent canonical timeout overrides drive their own hints and leave channel menus on the general setting', browserCase, async t => {
    const setupResult = await setup(t, { overlayTimeoutSeconds: 4, cornerTimeoutSeconds: 2 });if (!setupResult) return;const { f, key } = setupResult, before = await snapshot(f);
    assert.deepEqual(await f.page.evaluate(() => [UmininnMenuDismiss.MENU_IDLE_TIMEOUT_SECONDS, UmininnMenuDismiss.CORNER_ENLARGE_IDLE_TIMEOUT_SECONDS, PLAYER_OVERLAY_TIMEOUT_SECONDS, PLAYER_CORNER_ENLARGE_TIMEOUT_SECONDS]), [4, 2, 4, 2]);
    await f.page.locator('#more-channels-btn').click();await f.page.clock.runFor(3999);assert.equal(await f.page.locator('#channel-selection').isVisible(), true);
    await f.page.clock.runFor(1);assert.equal(await f.page.locator('#channel-selection').isVisible(), false);
    await openCorner(f, key, 'nw', 2);await finishAt(f, 2000);
    for (const [selector, mode] of [['#enlarge-player', 'enlarge'], ['#adjust-player-positions', 'move']]) {
        await f.page.locator(selector).click();await assertMode(f, 4, mode);await finishAt(f, 4000);
    }
    await assertContinuity(f, before);
});

test('corner entry restarts its ten second idle interval for trusted actions and waits for a held resize to finish', browserCase, async t => {
    const setupResult = await setup(t);if (!setupResult) return;const { f, key } = setupResult, before = await snapshot(f);
    await openCorner(f, key);await f.page.clock.runFor(9000);await f.page.locator('.player-position-toolbar-toggle').click();await finishAt(f, 10000);
    await openCorner(f, key);const drag = await startCornerDrag(f, key, 'nw');await moveCornerDrag(f, drag, .8);await f.page.clock.runFor(32);await assertPreviewOnly(f, drag);
    await f.page.clock.runFor(12000);await assertMode(f, 10);assert.deepEqual((await readLayout(f)).logical, drag.before.logical, 'a long pointer hold remains an uncommitted preview');
    await f.page.mouse.up();await assertResizeIdle(f);await waitSpan(f, key, 2);const committed = await readLayout(f);
    await finishAt(f, 10000);assert.deepEqual((await readLayout(f)).logical, committed.logical);await assertContinuity(f, before);
});

test('corner idle completion ignores hover refresh and synthetic activity and preserves outside focus', browserCase, async t => {
    const setupResult = await setup(t);if (!setupResult) return;const { f, key } = setupResult, before = await snapshot(f);
    await openCorner(f, key);await f.page.clock.runFor(5000);
    const tile = f.page.locator(`.player-position-cell[data-player-key=${JSON.stringify(key)}]`), box = await tile.boundingBox();await f.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await f.page.evaluate(() => {
        playerPositionEditor.refresh();fixture.resize(1180, 880);
        document.querySelector('.player-position-toolbar').dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    });await f.page.clock.runFor(250);const committed = await readLayout(f);await f.page.locator('#toggle-all-audio').focus();
    await f.page.clock.runFor(4749);assert.equal((await geometry(f)).opened, true);await f.page.clock.runFor(1);await assertEditorUiClosed(f);
    assert.equal(await f.page.evaluate(() => document.activeElement.id), 'toggle-all-audio');assert.deepEqual((await readLayout(f)).logical, committed.logical);await assertContinuity(f, before);
});

test('a two-player single-row pane has no eligible interior corner entry',browserCase,async t=>{
    const setupResult=await setup(t);if(!setupResult)return;const {f,keys}=setupResult;
    const before=await activeMediaSnapshot(f,keys.slice(0,2),{remember:true});await f.page.evaluate(()=>syncActivePlayers(channels.slice(0,2)));await f.page.clock.runFor(50);await fixedDirectionGrid(f,{columns:2});
    assert.equal(await f.page.locator('.player-window-enlarge-corner:not([hidden])').count(),0,'each corner touches at least one excluded outer edge of the arrangement');
    await assertActiveContinuity(f,before);
});
