'use strict';

const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');

// Reuse the production-app, trusted-input and real-media harness. Its existing
// broad layout cases remain separate; these cases exercise operation boundaries.
const harnessFile=path.join(__dirname,'player-layout-browser.test.cjs'),harnessRequire=createRequire(harnessFile);
const harnessTest=Object.assign(()=>{},{before:test.before,after:test.after}),harnessModule={exports:{}};
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n'+fs.readFileSync(harnessFile,'utf8')+'\n'+
    'module.exports={fixture,snapshot,assertContinuity,optional,fixedDirectionGrid,settlePane,positionCell,clickDirection,editorStepGesture,waitWindowGeometry,assertFits};\n})',
    {filename:harnessFile})(name=>name==='node:test'?harnessTest:harnessRequire(name),harnessModule,harnessModule.exports,__dirname,harnessFile);
const {fixture,snapshot,assertContinuity,optional,fixedDirectionGrid,settlePane,positionCell,clickDirection,editorStepGesture,waitWindowGeometry,assertFits}=harnessModule.exports;
const browserCase={skip:process.env.UMININN_BROWSER_TESTS!=='1',timeout:60000};

async function setup(t,options={}){
    if(!optional(t))return null;
    return fixture(t,{width:1500,height:950,players:17,...options});
}
async function geometry(f){return f.page.evaluate(()=>{
    const value=getCurrentPlayerGeometry();return {columns:value.columns,rows:value.rows,
        items:[...value.items].sort((a,b)=>a.key.localeCompare(b.key))};
})}
function item(layout,key){return layout.items.find(value=>value.key===key)}
async function prepareLargeGrid(f){
    const keys=await f.page.evaluate(()=>getPlayerPositionKeys()),key=keys[0];
    await fixedDirectionGrid(f,{columns:5,focus:{key,span:3,row:0,column:0},order:keys});
    const current=await geometry(f);
    return {keys,key,adjacent:current.items.find(value=>value.row===0&&value.column===3).key,
        distant:current.items.find(value=>value.row===0&&value.column===4).key,current};
}
async function exactPane(f,width,height,{force=false}={}){
    await f.page.evaluate(({width,height,force})=>{
        const host=document.getElementById('multi-stream-container-wrapper'),pane=document.getElementById('multi-stream-container');
        host.style.padding='0';pane.style.border='0';pane.style.padding='0';fixture.resize(width,height);
        if(force)updatePlayerLayout({force:true});
    },{width,height,force});
    await f.page.waitForFunction(({width,height})=>{const pane=document.getElementById('multi-stream-container');return pane.clientWidth===width&&pane.clientHeight===height;},{width,height});
    await f.page.waitForTimeout(240);
}

test('operation routing: adjacent triangle, keyboard, click-pair and drag all step a large tile exactly one cell',browserCase,async t=>{
    const f=await setup(t);if(!f)return;
    const before=await snapshot(f),keys=await f.page.evaluate(()=>getPlayerPositionKeys()),key=keys[0];
    let expected;
    for(const gesture of ['triangle','key','click','drag']){
        await fixedDirectionGrid(f,{columns:5,focus:{key,span:3,row:0,column:0},order:keys});
        const current=await geometry(f),target=current.items.find(value=>value.row===0&&value.column===3).key;
        if(gesture==='triangle')await clickDirection(f,key,'right',target);
        else{
            await f.page.locator('#adjust-player-positions').click();
            await editorStepGesture(f,key,target,'right',gesture);
        }
        const next=await geometry(f);
        assert.deepEqual(item(next,key),{key,row:0,column:1,span:3},gesture+' must use the shared-edge one-cell rule');
        assert.equal(next.columns,5);assert.equal(next.rows,current.rows);
        if(expected)assert.deepEqual(next,expected,'all four adjacent input paths commit identical cell geometry');
        else expected=next;
        if(gesture!=='triangle'){await f.page.keyboard.press('Escape');await waitWindowGeometry(f);}
    }
    await assertContinuity(f,before);
});

test('operation routing: explicit distant click and drag reach the bounded destination instead of using a direction step',browserCase,async t=>{
    const f=await setup(t);if(!f)return;
    const before=await snapshot(f),keys=await f.page.evaluate(()=>getPlayerPositionKeys()),key=keys[0];
    let expected;
    for(const gesture of ['click','drag']){
        await fixedDirectionGrid(f,{columns:5,focus:{key,span:3,row:0,column:0},order:keys});
        const current=await geometry(f),target=current.items.find(value=>value.row===0&&value.column===4).key;
        await f.page.locator('#adjust-player-positions').click();
        await editorStepGesture(f,key,target,'right',gesture);
        const next=await geometry(f);
        assert.deepEqual(item(next,key),{key,row:0,column:2,span:3},'the far destination is clamped so the complete 3×3 tile fits at the right edge');
        assert.equal(next.columns,5);assert.equal(next.rows,current.rows);
        if(expected)assert.deepEqual(next,expected,'click and drag share the same explicit-target result');else expected=next;
        await f.page.keyboard.press('Escape');await waitWindowGeometry(f);
    }
    await assertContinuity(f,before);
});

test('operation routing: an empty gap blocks keyboard movement while the same distant tile remains a valid pointer destination',browserCase,async t=>{
    const f=await setup(t,{players:5,width:1200,height:800});if(!f)return;
    const before=await snapshot(f),keys=await f.page.evaluate(()=>getPlayerPositionKeys()),key=keys[4];
    await fixedDirectionGrid(f,{columns:6,focus:{key,row:2,column:2,span:2},order:keys});
    const initial=await geometry(f);
    await f.page.locator('#adjust-player-positions').click();
    for(const direction of ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight']){
        await positionCell(f,key).press(direction);
        assert.deepEqual(await geometry(f),initial,'keyboard directions cannot bridge empty grid tracks');
    }
    await positionCell(f,keys[2]).press('ArrowDown');
    assert.deepEqual(await geometry(f),initial,'a small keyboard source cannot pull a distant enlarged tile across the gap');
    await editorStepGesture(f,key,keys[2],'up','click');
    const moved=await geometry(f);
    assert.deepEqual(item(moved,key),{key,row:0,column:2,span:2});
    assert.equal(moved.columns,initial.columns);assert.equal(moved.rows,2);
    await f.page.keyboard.press('Escape');await assertContinuity(f,before);
});

test('automatic layout: the two five-channel screenshot pane sizes keep their existing 2×3 and 3×2 best fits',browserCase,async t=>{
    const f=await setup(t,{players:5});if(!f)return;
    const before=await snapshot(f);
    await exactPane(f,1398,837,{force:true});
    assert.deepEqual(await f.page.evaluate(()=>{const g=getCurrentPlayerGeometry();return [g.columns,g.rows];}),[2,3]);
    assertFits(await f.page.evaluate(()=>fixture.grid()));
    await exactPane(f,1284,697);
    assert.deepEqual(await f.page.evaluate(()=>{const g=getCurrentPlayerGeometry();return [g.columns,g.rows];}),[3,2]);
    assertFits(await f.page.evaluate(()=>fixture.grid()));
    await assertContinuity(f,before);
});

test('automatic layout: seventeen channels use the existing 4×5 fit and retain a prior 5×4 grid when the gain stays below six percent',browserCase,async t=>{
    const f=await setup(t);if(!f)return;
    const before=await snapshot(f),keys=await f.page.evaluate(()=>getPlayerPositionKeys());
    await exactPane(f,1398,824,{force:true});
    assert.deepEqual(await f.page.evaluate(()=>{const g=getCurrentPlayerGeometry();return [g.columns,g.rows];}),[4,5]);
    await exactPane(f,1200,824);
    await fixedDirectionGrid(f,{columns:5,order:keys});
    await exactPane(f,1398,824);
    assert.deepEqual(await f.page.evaluate(()=>{const g=getCurrentPlayerGeometry();return [g.columns,g.rows];}),[5,4],
        'a 5.34% fitted-video area improvement does not cross the existing 6% switch threshold');
    await exactPane(f,1398,900);
    assert.deepEqual(await f.page.evaluate(()=>{const g=getCurrentPlayerGeometry();return [g.columns,g.rows];}),[4,5],
        'a sufficiently larger pane-height change can still adopt the better grid');
    assertFits(await f.page.evaluate(()=>fixture.grid()));
    await assertContinuity(f,before);
});

test('operation routing: a manual direction commit stays pinned through slight resize, then a large portrait change can refit it',browserCase,async t=>{
    const f=await setup(t);if(!f)return;
    const before=await snapshot(f),{key,adjacent}=await prepareLargeGrid(f);
    await clickDirection(f,key,'right',adjacent);
    const stepped=await geometry(f);
    assert.deepEqual(item(stepped,key),{key,row:0,column:1,span:3});
    await settlePane(f,1501,949);
    assert.deepEqual(await geometry(f),stepped,'a resize event cannot reinterpret a committed movement as a fresh target request');
    await settlePane(f,550,1000);
    const portrait=await geometry(f);
    assert.notEqual(portrait.columns,stepped.columns,'a major aspect change still invokes automatic fitting');
    assert.deepEqual(portrait.items.filter(value=>value.span>1).map(value=>({key:value.key,span:value.span})),[{key,span:3}]);
    assertFits(await f.page.evaluate(()=>fixture.grid()));
    await assertContinuity(f,before);
});
