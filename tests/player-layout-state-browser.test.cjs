'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Use the established production-app/native-media/cross-origin fixture and its
// continuity assertions. Register only this phase's cases, keeping its setup.
const harnessFile = path.join(__dirname, 'player-layout-browser.test.cjs');
const harnessRequire = createRequire(harnessFile);
const harnessTest = Object.assign(() => {}, { before: test.before, after: test.after });
const harnessModule = { exports: {} };
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + fs.readFileSync(harnessFile, 'utf8') + '\n' +
    'module.exports={fixture,snapshot,stable,assertContinuity,optional,fixedDirectionGrid,settlePane};\n})',
    { filename: harnessFile })(name => name === 'node:test' ? harnessTest : harnessRequire(name),
    harnessModule, harnessModule.exports, __dirname, harnessFile);
const { fixture, snapshot, stable, assertContinuity, optional, fixedDirectionGrid, settlePane } = harnessModule.exports;
const browserCase = { skip: process.env.UMININN_BROWSER_TESTS !== '1', timeout: 30000 };

async function setup(t, options = {}) {
    if (!optional(t)) return null;
    return fixture(t, { width: 1400, height: 850, ...options });
}
async function read(f) {
    return f.page.evaluate(() => ({
        order: getPlayerPositionKeys(), geometry: { ...getCurrentPlayerGeometry(),
            items:[...getCurrentPlayerGeometry().items].sort((a,b) => a.key.localeCompare(b.key)) },
        bookmark: capturePlayerBookmark(),
        projected: [...activePlayers].map(([key, entry]) => ({ key,
            order: getPlayerElement(entry).style.order, area: getPlayerElement(entry).style.gridArea }))
    }));
}
async function corruptProjection(f) {
    await f.page.evaluate(() => {
        [...activePlayers.values()].forEach((entry, index) => {
            const element = getPlayerElement(entry);
            element.style.order = String(100 - index * 7);
            element.style.gridArea = `${10 + index} / 20 / span 2 / span 2`;
        });
    });
}
async function assertProjection(f) {
    const state = await read(f);
    assert.deepEqual(state.order, [...state.geometry.items].sort((a,b) => a.row-b.row || a.column-b.column).map(item => item.key));
    assert.deepEqual(state.bookmark.channels.map(channel => channel.key), state.order);
    assert.equal(state.geometry.items.length, state.projected.length);
    for (const tile of state.projected) {
        const item = state.geometry.items.find(item => item.key === tile.key);
        assert.equal(tile.order, String(state.order.indexOf(tile.key)), 'DOM order projects the authoritative sequence');
        assert.equal(tile.area, `${item.row+1} / ${item.column+1} / span ${item.span} / span ${item.span}`,
            'DOM area projects the authoritative geometry without becoming its source');
    }
    return state;
}

test('layout state: normal-grid CSS tampering cannot change capture, logical order or the next layout', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f), expected = await assertProjection(f);
    await corruptProjection(f);
    const corrupted = await read(f);
    assert.deepEqual(corrupted.order, expected.order);
    assert.deepEqual(corrupted.geometry, expected.geometry);
    assert.deepEqual(corrupted.bookmark, expected.bookmark);
    await f.page.evaluate(() => updatePlayerLayout());
    assert.deepEqual(await assertProjection(f), expected);
    await assertContinuity(f, before);
});

test('layout state: enlarged-grid CSS tampering cannot alter bookmark geometry or move-editor cells', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f), key = await f.page.evaluate(() => fixture.keys[0]);
    await fixedDirectionGrid(f, { columns: 4, focus: { key, span: 2, row: 0, column: 1 } });
    const expected = await assertProjection(f);
    await corruptProjection(f);
    assert.deepEqual((await read(f)).bookmark, expected.bookmark);
    await f.page.evaluate(() => updatePlayerLayout());
    await f.page.locator('#adjust-player-positions').click();
    assert.deepEqual(await assertProjection(f), expected);
    const cells = await f.page.locator('.player-position-cell').evaluateAll(elements => elements.map(element => ({ key: element.dataset.playerKey, area: element.style.gridArea })));
    for (const tile of expected.projected) assert.equal(cells.find(cell => cell.key === tile.key).area, tile.area);
    await assertContinuity(f, before);
});

test('layout state: playback-error replacement uses model placement even when the old element projection is corrupt', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const key = await f.page.evaluate(() => fixture.keys[0]);
    await fixedDirectionGrid(f, { columns: 4, focus: { key, span: 2, row: 0, column: 1 } });
    const expected = await assertProjection(f), before = await snapshot(f);
    await f.page.evaluate(() => {
        const resource = fixture.entries[0].resource;
        resource.element.style.order = '99'; resource.element.style.gridArea = '9 / 9 / span 3 / span 3';
        replacePlayerWithError(resource, '受控測試：媒體錯誤');
    });
    assert.deepEqual(await assertProjection(f), expected);
    const after = await snapshot(f);
    assert.deepEqual(after.main.slice(1).map(stable), before.main.slice(1).map(stable));
    // The browser may pause a detached failed media node itself. Every command
    // counter and sound/source property still stays untouched by replacement.
    const {paused:oldPaused,...oldFailed}=stable(before.main[0]);
    const {paused:newPaused,...newFailed}=stable(after.main[0]);
    assert.deepEqual(newFailed,{...oldFailed,same:false});
    assert.deepEqual(after.frames.map(frame => ({id:frame.id,media:frame.media.map(stable)})), before.frames.map(frame => ({id:frame.id,media:frame.media.map(stable)})));
    assert.deepEqual(await f.page.evaluate(() => fixture.identity()), {elements:false,entries:true,windows:true,removals:1,frameSources:0,loads:[1,1]});
    assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
});

test('layout state: resize and saved-bookmark round trip retain one consistent geometry and all player identities', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const before = await snapshot(f), keys = await f.page.evaluate(() => fixture.keys);
    await fixedDirectionGrid(f, { columns: 4, focus: { key:keys[2], span:2, row:0, column:2 }, order:[...keys].reverse() });
    const expected = await assertProjection(f);
    await settlePane(f, 550, 1000);
    await assertProjection(f);
    await f.page.evaluate(() => resetPlayerPositions());
    await assertProjection(f);
    await settlePane(f, 1400, 850);
    await f.page.evaluate(bookmark => applyPlayerBookmark(bookmark), expected.bookmark);
    assert.deepEqual(await assertProjection(f), expected);
    await assertContinuity(f, before);
});

test('layout state: removing the enlarged tile and reselecting it cannot leave ghost geometry or stale cells', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const keys = await f.page.evaluate(() => fixture.keys);
    await fixedDirectionGrid(f, { columns:4, focus:{key:keys[0],span:2,row:0,column:1} });
    const retainedBefore = await f.page.evaluate(() => [...activePlayers].filter(([key]) => key !== fixture.keys[0]).map(([key,entry]) => ({key,element:getPlayerElement(entry).id})));
    await f.page.evaluate(key => closePlayer(key), keys[0]);
    let state = await assertProjection(f);
    assert.equal(state.order.includes(keys[0]), false);
    assert.equal(state.geometry.items.some(item => item.key === keys[0] || item.span > 1), false);
    await f.page.evaluate(() => {
        // Reuse the fixture's inert player creator so this lifecycle check does
        // not fetch external HLS code or invent a platform renderer contract.
        fixture.addPlaceholder(channels[0]); syncActivePlayers(channels);
    });
    state = await assertProjection(f);
    assert.equal(state.order.filter(key => key === keys[0]).length, 1);
    assert.equal(state.geometry.items.filter(item => item.key === keys[0]).length, 1);
    const retainedAfter = await f.page.evaluate(() => [...activePlayers].filter(([key]) => key !== fixture.keys[0]).map(([key,entry]) => ({key,element:getPlayerElement(entry).id})));
    assert.deepEqual(retainedAfter, retainedBefore);
    assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
});

test('layout state: a same-count selection replacement drops rendered enlargement and restores the dormant focus on return', browserCase, async t => {
    const f = await setup(t); if (!f) return;
    const keys = await f.page.evaluate(() => fixture.keys), focusKey = keys[4];
    await fixedDirectionGrid(f, {columns:4,focus:{key:focusKey,span:2,row:0,column:1}});
    const before = await snapshot(f);
    const expectedNormal = await f.page.evaluate(() => {
        const pane=document.getElementById('multi-stream-container'),style=getComputedStyle(pane);
        return PlayerLayout.choose({count:5,width:pane.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),
            height:pane.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom),
            columnGap:parseFloat(style.columnGap),rowGap:parseFloat(style.rowGap),force:true}).columns;
    });
    await f.page.evaluate(() => {
        window.replacementChannel={id:'state-replacement',platform:'at',name:'同數量替換'};
        fixture.addPlaceholder(replacementChannel);
        syncActivePlayers([...channels.slice(0,4),replacementChannel]);
    });
    let state=await assertProjection(f);
    assert.equal(state.order.length,5);assert.equal(state.order.includes(focusKey),false);
    assert.equal(state.geometry.items.some(item=>item.span>1),false);
    assert.equal(state.geometry.columns,expectedNormal,'losing the focus must trigger the same normal-grid optimisation as before the refactor');
    await f.page.evaluate(() => {fixture.addPlaceholder(channels[4]);syncActivePlayers(channels);});
    state=await assertProjection(f);
    assert.equal(state.order.length,5);assert.equal(state.order.includes('at|state-replacement'),false);
    assert.deepEqual(state.geometry.items.filter(item=>item.span>1).map(item=>({key:item.key,span:item.span})),[{key:focusKey,span:2}]);
    const after=await snapshot(f);
    assert.deepEqual(after.main.slice(0,2).map(stable),before.main.slice(0,2).map(stable));
    assert.deepEqual(after.frames.map(frame=>({id:frame.id,media:frame.media.map(stable)})),before.frames.map(frame=>({id:frame.id,media:frame.media.map(stable)})));
    assert.deepEqual(f.errors,[]);assert.deepEqual(f.blocked,[]);
});

test('layout state: direct large-to-small swapping preserves the established visual ordering of the other small tile', browserCase, async t => {
    const f=await setup(t);if(!f)return;
    const keys=await f.page.evaluate(()=>{syncActivePlayers(channels.slice(0,3));return fixture.keys.slice(0,3);});
    await fixedDirectionGrid(f,{columns:2,order:keys});
    await f.page.evaluate(key=>applyPlayerSize(PlayerGeometry.grow(getCurrentPlayerGeometry(),key),{optimize:false}),keys[1]);
    let state=await assertProjection(f);
    assert.deepEqual(state.geometry.items.find(item=>item.key===keys[1]),{key:keys[1],row:0,column:0,span:2});
    const beforeMain=await f.page.evaluate(()=>fixture.snapshot().slice(0,2));
    const retainedFrame=f.frames[0],beforeFrame=await retainedFrame.evaluate(()=>({id:fixtureId,media:fixtureMedia.map(readMedia)}));
    await f.page.evaluate(()=>{window.swapIdentity=[...activePlayers.values()].map(entry=>({entry,element:getPlayerElement(entry)}));});
    assert.equal(await f.page.evaluate(keys=>swapPlayerPositions(keys[1],keys[2]),keys),true);
    state=await assertProjection(f);
    assert.deepEqual(state.order,[keys[2],keys[0],keys[1]],'the existing swapped visual order controls which small tile fills each top cell');
    assert.deepEqual(state.geometry.items.find(item=>item.key===keys[2]),{key:keys[2],row:0,column:0,span:1});
    assert.deepEqual(state.geometry.items.find(item=>item.key===keys[0]),{key:keys[0],row:0,column:1,span:1});
    assert.deepEqual(state.geometry.items.find(item=>item.key===keys[1]),{key:keys[1],row:2,column:0,span:2});
    assert.deepEqual((await f.page.evaluate(()=>fixture.snapshot().slice(0,2))).map(stable),beforeMain.map(stable));
    const afterFrame=await retainedFrame.evaluate(()=>({id:fixtureId,media:fixtureMedia.map(readMedia)}));
    assert.equal(afterFrame.id,beforeFrame.id);assert.deepEqual(afterFrame.media.map(stable),beforeFrame.media.map(stable));
    assert.equal(await f.page.evaluate(()=>swapIdentity.every(saved=>saved.element.isConnected&&getPlayerElement(saved.entry)===saved.element&&[...activePlayers.values()].includes(saved.entry))),true);
    assert.deepEqual(f.errors,[]);assert.deepEqual(f.blocked,[]);
});
