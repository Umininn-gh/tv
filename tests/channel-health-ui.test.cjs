const test = require('node:test');
const assert = require('node:assert/strict');
const ChannelList = require('../channel-list.js');
const ChannelHealthUI = require('../channel-health-ui.js');

const tick = () => new Promise(resolve => setImmediate(resolve));
const channel = (name, id, platform = 'twitch', extra = {}) => ({ name, id, platform, ...extra });
const initial = [channel('Alpha', 'alpha'), channel('Bravo', 'bravo', 'gosh'), channel('Charlie', 'charlie', 'kick')];
const clone = value => structuredClone(value);

class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.value = ''; this.hidden = false; this.disabled = false; this.listeners = {}; this.attributes = {}; this._text = ''; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; this._text = ''; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
    removeEventListener(name, listener) { this.listeners[name] = (this.listeners[name] || []).filter(item => item !== listener); }
    async dispatch(name) { await Promise.all((this.listeners[name] || []).map(listener => listener({ preventDefault() {} }))); await tick(); }
}

function descendants(node, predicate) { return node.children.flatMap(child => [...(predicate(child) ? [child] : []), ...descendants(child, predicate)]); }
function byClass(node, name) { return descendants(node, child => (child.className || '').split(' ').includes(name)); }
function button(row, label) { return descendants(row, child => child.tagName === 'BUTTON').find(child => child.textContent === label); }
function row(f, index = 0) { return f.nodes['health-results'].children[index]; }
function snapshot(channels) { return { channels: clone(channels), raw: channels.map(item => [item.name, item.id, item.platform, ...(item.ggUsername ? [item.ggUsername] : [])].join(',')).join('\n') + '\n', sha: 'sha-current' }; }
function result(channel, status = 'exists', extra = {}) { return { key: ChannelList.channelKey(channel), channel: clone(channel), status, reason: '查核結果 ' + status, checkedAt: 1792147200000, evidence: [], history: [], ...extra }; }

function fixture(options = {}) {
    const ids = ['health', 'health-start', 'health-cancel', 'health-summary', 'health-results', 'health-filter', 'health-progress'];
    const nodes = Object.fromEntries(ids.map(id => [id, new Element()]));
    nodes['health-filter'].value = 'all';
    const document = { getElementById: id => nodes[id], createElement: tag => new Element(tag) };
    const current = { snapshot: snapshot(options.channels || initial), writable: options.writable ?? false, busy: false };
    const loads = [], scans = [], checks = [], decisions = [], actions = [], messages = [];
    const makeResult = value => options.result ? options.result(value) : result(value, options.statuses?.[value.id] || 'exists');
    const scanner = {
        async scan(channels, callbacks) {
            scans.push({ channels, callbacks });
            if (options.scan) return options.scan(channels, callbacks, current);
            const results = channels.map(makeResult);
            results.forEach((item, index) => { callbacks.onResult(item, { completed: index + 1, total: results.length, index }); callbacks.onProgress({ completed: index + 1, total: results.length, cancelled: false }); });
            return { results, checkedAt: 1792147200000, cancelled: false, totals: { total: results.length, completed: results.length } };
        },
        async check(value, config) { checks.push({ channel: value, config }); return options.check ? options.check(value, config, current) : makeResult(value); },
        async recordDecision(value, decision) { decisions.push({ channel: value, decision }); return options.recordDecision ? options.recordDecision(value, decision) : true; }
    };
    const ui = ChannelHealthUI.createUI({ document, scanner,
        async loadSnapshot() { loads.push(true); const value = options.loadSnapshot ? await options.loadSnapshot(current) : current.snapshot; current.snapshot = value; return value; },
        getSnapshot: () => current.snapshot, canWrite: () => current.writable, isBusy: () => current.busy,
        async runAction(change) {
            actions.push(change);
            if (options.runAction) return options.runAction(change, current);
            if (change.action === 'delete') current.snapshot = snapshot(current.snapshot.channels.filter(value => ChannelList.channelKey(value) !== ChannelList.channelKey(change.previous)));
            return true;
        },
        onMessage(text, kind) { messages.push({ text, kind }); }
    });
    return { ui, nodes, document, current, scanner, loads, scans, checks, decisions, actions, messages,
        start: () => nodes['health-start'].dispatch('click'),
        filter: async value => { nodes['health-filter'].value = value; await nodes['health-filter'].dispatch('change'); }
    };
}

test('start awaits the fresh snapshot before scanning and passes only public channel fields', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const f = fixture({ loadSnapshot: () => pending });
    const starting = f.start(); await tick();
    assert.equal(f.loads.length, 1);
    assert.equal(f.scans.length, 0);
    assert.equal(f.nodes['health-start'].disabled, true);
    assert.equal(f.nodes['health-cancel'].hidden, false);
    const fresh = [channel('最新 GoodGame', '219534', 'goodgame', { ggUsername: 'Public_Name', token: 'not-public' })];
    release(snapshot(fresh)); await starting;
    assert.equal(f.scans.length, 1);
    assert.deepEqual(f.scans[0].channels, [channel('最新 GoodGame', '219534', 'goodgame', { ggUsername: 'Public_Name' })]);
    assert.equal(f.actions.length, 0);
    assert.equal(f.nodes['health-results'].children.length, 1);
    assert.match(f.nodes['health-progress'].textContent, /檢查完成：1 \/ 1/);
    assert.equal(f.nodes['health-cancel'].hidden, true);
});

test('cancelling during fresh-list loading prevents a later scan and hides the cancel control when idle', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const f = fixture({ loadSnapshot: () => pending });
    assert.equal(f.nodes['health-cancel'].hidden, true);
    assert.match(f.nodes['health-summary'].textContent, /掃描全部現有台/);
    const starting = f.start(); await tick();
    assert.equal(f.nodes['health-cancel'].hidden, false);
    await f.nodes['health-cancel'].dispatch('click');
    assert.equal(f.nodes['health-cancel'].hidden, true);
    release(snapshot(initial)); await starting;
    assert.equal(f.scans.length, 0);
    assert.equal(f.actions.length, 0);
    assert.equal(f.nodes['health-results'].children.length, 0);
    assert.match(f.nodes['health-progress'].textContent, /檢查已取消/);
});

test('readonly reports retain offline and unknown channels; keep is local and never skips later scans', async () => {
    const f = fixture({ statuses: { alpha: 'live', bravo: 'offline', charlie: 'unknown' } });
    await f.start();
    assert.match(row(f, 1).textContent, /離線（仍有效）/);
    assert.match(row(f, 2).textContent, /無法確認/);
    for (const item of f.nodes['health-results'].children) {
        assert.equal(button(item, '刪除').disabled, true);
        assert.equal(button(item, '編輯').disabled, true);
        assert.equal(button(item, '保留').disabled, false);
        assert.equal(button(item, '重新檢查').disabled, false);
    }
    await button(row(f, 1), '保留').dispatch('click');
    assert.deepEqual(f.decisions, [{ channel: initial[1], decision: 'keep' }]);
    assert.equal(f.actions.length, 0);
    assert.match(row(f, 1).textContent, /下次檢查仍會查核/);
    await f.start();
    assert.equal(f.scans.length, 2);
    assert.equal(f.scans[1].channels.length, 3);
    await button(row(f, 2), '重新檢查').dispatch('click');
    assert.equal(f.checks.length, 1);
    assert.equal(f.actions.length, 0);
});

test('all statuses have meaningful filters and counts without hiding unperformed checks from the summary', async () => {
    const statuses = ['live', 'offline', 'exists', 'repair', 'suspect', 'ended', 'unknown'];
    const channels = statuses.map(status => channel(status, status));
    const f = fixture({ channels, statuses: Object.fromEntries(statuses.map(status => [status, status])) });
    await f.start();
    assert.match(f.nodes['health-summary'].textContent, /共 7 台，已檢查 7 台/);
    await f.filter('attention');
    assert.deepEqual(f.nodes['health-results'].children.map(item => !item.hidden), [false, false, false, true, true, true, false]);
    await f.filter('normal');
    assert.deepEqual(f.nodes['health-results'].children.map(item => !item.hidden), [true, true, true, false, false, false, false]);
    await f.filter('unknown');
    assert.deepEqual(f.nodes['health-results'].children.map(item => !item.hidden), [false, false, false, false, false, false, true]);
    await f.filter('all');
    assert.ok(f.nodes['health-results'].children.every(item => !item.hidden));
    assert.equal(f.actions.length, 0);
});

test('cancellation retains completed results, labels unperformed rows, and ignores late scan callbacks and returns', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const f = fixture({ scan: async (channels, callbacks) => { callbacks.onResult(result(channels[0], 'live')); return pending; } });
    const starting = f.start(); await tick();
    assert.match(f.nodes['health-summary'].textContent, /已檢查 1 台/);
    await f.nodes['health-cancel'].dispatch('click');
    assert.equal(f.scans[0].callbacks.signal.aborted, true);
    f.scans[0].callbacks.onResult(result(initial[1], 'offline'));
    f.scans[0].callbacks.onProgress({ completed: 3, total: 3 });
    release({ results: initial.map(item => result(item)), cancelled: true }); await starting;
    assert.match(f.nodes['health-progress'].textContent, /檢查已取消：1 \/ 3/);
    assert.match(f.nodes['health-summary'].textContent, /尚未檢查 2 台/);
    assert.match(row(f, 1).textContent, /未檢查（已取消）/);
    assert.match(row(f, 2).textContent, /未檢查（已取消）/);
    assert.equal(f.actions.length, 0);
    assert.equal(f.nodes['health-start'].disabled, false);
});

test('a renamed row becomes stale while unrelated deletions and edits leave other rows actionable', async () => {
    const f = fixture({ writable: true }); await f.start();
    f.current.snapshot = snapshot([channel('Alpha 改名', 'alpha'), initial[1]]);
    f.ui.refresh();
    assert.equal(button(row(f, 0), '刪除').disabled, true);
    assert.equal(button(row(f, 1), '刪除').disabled, false);
    assert.equal(button(row(f, 2), '刪除').disabled, true);
    await button(row(f, 0), '刪除').dispatch('click');
    assert.equal(f.actions.length, 0, 'stale actions are guarded even when triggered programmatically');
    await button(row(f, 0), '重新檢查').dispatch('click');
    assert.equal(f.checks[0].channel.name, 'Alpha 改名');
    assert.equal(button(row(f, 0), '刪除').disabled, false);
    assert.equal(button(row(f, 1), '刪除').disabled, false);
    await button(row(f, 1), '刪除').dispatch('click');
    assert.equal(f.actions.length, 1);
    assert.equal(f.actions[0].previous.id, 'bravo');
    assert.deepEqual(f.decisions.at(-1), { channel: initial[1], decision: 'deleted' });
    assert.equal(button(row(f, 0), '刪除').disabled, false, 'deleting another row does not invalidate the rechecked result');
});

test('public GoodGame metadata changes and missing identities remain stale until a matching current row is rechecked', async () => {
    const original = channel('GoodGame', '123', 'goodgame', { ggUsername: 'Original' });
    const f = fixture({ channels: [original], writable: true }); await f.start();
    f.current.snapshot = snapshot([{ ...original, ggUsername: 'Changed' }]); f.ui.refresh();
    assert.equal(button(row(f), '刪除').disabled, true);
    await button(row(f), '重新檢查').dispatch('click');
    assert.equal(f.checks[0].channel.ggUsername, 'Changed');
    assert.equal(button(row(f), '刪除').disabled, false);
    f.current.snapshot = snapshot([channel('GoodGame', '456', 'goodgame', { ggUsername: 'Changed' })]); f.ui.refresh();
    assert.equal(button(row(f), '刪除').disabled, true);
    await button(row(f), '重新檢查').dispatch('click');
    assert.equal(button(row(f), '刪除').disabled, true, 'a check cannot restore write actions for an absent shared entry');
});

test('repair suggestions only open the editor with original optimistic metadata, never auto-save or delete', async () => {
    const f = fixture({ writable: true, result: value => result(value, 'repair', { suggestion: { id: 'new-identity', platform: 'kick', secret: 'not-public' } }) });
    await f.start();
    assert.equal(f.actions.length, 0);
    await button(row(f), '修復／編輯').dispatch('click');
    assert.deepEqual(f.actions, [{ action: 'edit', previous: initial[0], channel: channel('Alpha', 'new-identity', 'kick') }]);
    assert.deepEqual(f.current.snapshot.channels, initial);
    assert.equal(f.decisions.length, 0);
    assert.match(row(f).textContent, /儲存後才會修改/);
});

test('delete decisions are recorded only after manager confirmation; refusal and failed writes keep report actions available', async () => {
    let outcome = false;
    const f = fixture({ writable: true, statuses: { alpha: 'offline' }, runAction: async () => { if (outcome === 'error') throw new Error('github_private_secret'); return outcome; } });
    await f.start();
    await button(row(f), '刪除').dispatch('click');
    assert.equal(f.decisions.length, 0);
    assert.equal(button(row(f), '刪除').disabled, false);
    outcome = 'error';
    await button(row(f), '刪除').dispatch('click');
    assert.equal(f.decisions.length, 0);
    assert.equal(JSON.stringify(f.messages).includes('github_private_secret'), false);
    outcome = { ok: true };
    await button(row(f), '刪除').dispatch('click');
    assert.deepEqual(f.decisions, [{ channel: initial[0], decision: 'deleted' }]);
    assert.equal(button(row(f), '刪除').disabled, true);
    assert.match(row(f).textContent, /已刪除/);
});

test('repeated row actions during a pending write cannot duplicate writes or preempt confirmation', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const f = fixture({ writable: true, runAction: () => pending }); await f.start();
    const deleting = button(row(f), '刪除').dispatch('click'); await tick();
    assert.equal(f.actions.length, 1);
    assert.equal(f.decisions.length, 0);
    assert.equal(f.nodes['health-start'].disabled, true);
    await button(row(f), '刪除').dispatch('click');
    assert.equal(f.actions.length, 1);
    release(true); await deleting;
    assert.equal(f.decisions.length, 1);
});

test('recheck uses cancellation and cannot update a report after cancel or dispose', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const f = fixture({ check: () => pending }); await f.start();
    const checking = button(row(f), '重新檢查').dispatch('click'); await tick();
    assert.equal(f.nodes['health-cancel'].hidden, false);
    f.ui.cancel();
    assert.equal(f.nodes['health-cancel'].hidden, true);
    assert.equal(f.checks[0].config.signal.aborted, true);
    release(result(initial[0], 'repair')); await checking;
    assert.equal(button(row(f), '編輯').textContent, '編輯');
    assert.doesNotMatch(row(f).textContent, /可修復/);
    f.ui.dispose();
    await f.start();
    assert.equal(f.scans.length, 1);
});

test('failed fresh snapshot reads keep the previous report and never scan a stale fallback or display exception text', async () => {
    let fail = false;
    const f = fixture({ loadSnapshot: current => { if (fail) throw new Error('github_private_secret'); return current.snapshot; } });
    await f.start();
    const rows = f.nodes['health-results'].children;
    fail = true;
    await f.start();
    assert.equal(f.scans.length, 1);
    assert.equal(f.nodes['health-results'].children, rows);
    assert.match(f.nodes['health-progress'].textContent, /讀取最新共用清單失敗.*未開始檢查/);
    assert.equal(f.nodes.health.textContent.includes('github_private_secret'), false);
    assert.equal(JSON.stringify(f.messages).includes('github_private_secret'), false);
    assert.equal(f.actions.length, 0);
});

test('evidence and historical reasons render as inert text with only HTTP(S) links and no URL credentials', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const f = fixture({ channels: [channel(hostile, 'alpha')], result: value => result(value, 'unknown', {
        reason: hostile,
        evidence: [{ url: 'https://example.com/channel/alpha', label: hostile, summary: '官方頁面', httpStatus: 403 }, { url: 'javascript:alert(1)', label: 'bad' }, { url: 'https://user:password@example.com/private', label: 'private' }],
        history: [{ checkedAt: 1792147000000, status: 'offline', reason: '歷史離線', evidence: [] }]
    }) });
    await f.start();
    const item = row(f);
    assert.equal(descendants(item, node => node.tagName === 'IMG').length, 0);
    const links = descendants(item, node => node.tagName === 'A');
    assert.equal(links.length, 1);
    assert.equal(links[0].href, 'https://example.com/channel/alpha');
    assert.equal(links[0].rel, 'noopener noreferrer');
    assert.match(item.textContent, /歷史離線/);
    assert.match(item.textContent, /HTTP 403/);
    assert.match(item.textContent, /查核時間/);
    const details = byClass(item, 'health-details')[0]; details.open = true;
    f.ui.refresh(); await f.filter('unknown');
    assert.equal(byClass(row(f), 'health-details')[0], details);
    assert.equal(details.open, true, 'refreshes retain the open evidence/history disclosure');
});

test('the current observation is not repeated as history, while genuinely older or different observations remain visible', async () => {
    for (const older of [null, { checkedAt: 1792147000000, reason: '較早核查' }, { checkedAt: 1792147200000, reason: '同時但不同核查原因' }]) {
        const f = fixture({ channels: [initial[0]], result: value => {
            const current = result(value, 'offline', { evidence: [{ url: 'https://example.com/current', label: '本次證據' }] });
            current.history = [{ status: current.status, reason: current.reason, checkedAt: current.checkedAt, evidence: current.evidence }];
            if (older) current.history.push({ status: 'offline', checkedAt: older.checkedAt, reason: older.reason, evidence: [{ url: 'https://example.com/older', label: '歷史證據' }] });
            return current;
        } });
        await f.start();
        assert.equal(descendants(row(f), item => item.tagName === 'A').length, older ? 2 : 1);
        assert.equal(byClass(row(f), 'health-history-heading').length, older ? 1 : 0);
        if (older) assert.ok(row(f).textContent.includes(older.reason));
    }
    const differentFirst = fixture({ channels: [initial[0]], result: value => result(value, 'offline', { history: [{ status: 'unknown', checkedAt: 1792147200000, reason: '不同的首筆紀錄', evidence: [] }] }) });
    await differentFirst.start();
    assert.match(row(differentFirst).textContent, /不同的首筆紀錄/);
});

test('persisted review decisions are shown with time on subsequent scans and successful local actions update their own note', async () => {
    let decision = { decision: 'review', checkedAt: 1792147000000 };
    const f = fixture({ channels: [initial[0]], result: value => result(value, 'unknown', { decision }), recordDecision: async (_value, action) => {
        decision = { decision: action, checkedAt: 1792147200000 };
        return { ...decision, persisted: true };
    } });
    await f.start();
    assert.match(byClass(row(f), 'health-decision')[0].textContent, /審核標記：待審核.*2026/);
    await button(row(f), '保留').dispatch('click');
    assert.match(byClass(row(f), 'health-decision')[0].textContent, /審核標記：保留/);
    assert.match(byClass(row(f), 'health-action-note')[0].textContent, /下次檢查仍會查核/);
    await f.start();
    assert.match(byClass(row(f), 'health-decision')[0].textContent, /審核標記：保留/);
    assert.equal(f.scans.length, 2, 'review decisions do not skip later checks');
});
