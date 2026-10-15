const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ChannelList = require('../channel-list.js');

const source = fs.readFileSync(require.resolve('../channel-manager.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../channel-manager.html'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.value = ''; this.hidden = false; this.disabled = false; this.listeners = {}; this.attributes = {}; this.textContent = ''; }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
    async dispatch(name, options = {}) { await Promise.all((this.listeners[name] || []).map(listener => listener({ preventDefault() {}, ...options }))); await tick(); }
    querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tagName === tag.toUpperCase() ? [child] : []), ...child.querySelectorAll(tag)]); }
    focus() { this.focused = true; }
    scrollIntoView() { this.scrolled = true; }
}

function snapshot(raw, sha = 'sha-one') { return { channels: ChannelList.parseChannelText(raw), raw, sha }; }
const initialRaw = '美1,meidingdang,gosh\n大波,dindinxd19,twitch\n';
const channel = (name, id, platform = 'gosh') => ({ name, id, platform });
const sourceReport = (channels = [...snapshot(initialRaw).channels, channel('來源新台', 'new-source', 'kick')], extras = {}) => ({ received: channels.length, hidden: 0, channels, duplicates: [], skipped: [], ...extras });
function compareChannels(existing, candidates) {
    const keys = new Set(existing.map(ChannelList.channelKey));
    const added = [];
    for (const candidate of candidates) {
        const key = ChannelList.channelKey(candidate);
        if (!keys.has(key)) { keys.add(key); added.push(candidate); }
    }
    return { added };
}

function fixture(options = {}) {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    const nodes = Object.fromEntries(ids.map(id => [id, new Element()]));
    const body = new Element('body');
    const document = { body, hidden: false, getElementById: id => nodes[id], createElement: tag => new Element(tag), listeners: {}, addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); } };
    const writes = [], data = new Map(), publications = [], reads = [], saves = [], batchAdds = [], sourceLoads = [], comparisons = [], windowListeners = {}, intervals = [];
    const storage = { getItem: key => data.get(key) ?? null, setItem(key, value) { data.set(key, String(value)); writes.push([key, value]); } };
    const current = { remote: snapshot(options.raw || initialRaw), local: snapshot(options.raw || initialRaw) };
    const client = {
        async read(token = '') { reads.push(token); return options.read ? options.read(token, current) : current.remote; },
        async save(before, change, token) {
            saves.push({ before, change, token });
            if (options.save) return options.save(before, change, token, current);
            const channels = [...before.channels];
            const index = change.previous ? channels.findIndex(channel => ChannelList.channelKey(channel) === ChannelList.channelKey(change.previous)) : -1;
            if (change.action === 'add') channels.push(change.channel);
            else if (change.action === 'edit') channels[index] = change.channel;
            else channels.splice(index, 1);
            const raw = channels.map(channel => [channel.name, channel.id, channel.platform, ...(channel.ggUsername ? [channel.ggUsername] : [])].join(',')).join('\n') + '\n';
            current.remote = { channels, raw, sha: 'sha-saved', baseRaw: before.raw };
            return current.remote;
        },
        async addMissing(candidates, token) {
            batchAdds.push({ candidates, token });
            if (options.addMissing) return options.addMissing(candidates, token, current);
            const latest = current.remote;
            const { added } = compareChannels(latest.channels, candidates);
            const raw = latest.raw + (added.length ? (latest.raw && !latest.raw.endsWith('\n') ? '\n' : '') + added.map(channel => [channel.name, channel.id, channel.platform, ...(channel.ggUsername ? [channel.ggUsername] : [])].join(',')).join('\n') + '\n' : '');
            current.remote = { channels: [...latest.channels, ...added], raw, sha: added.length ? 'sha-batch' : latest.sha, baseRaw: latest.raw, added, unchanged: added.length === 0 };
            return current.remote;
        }
    };
    const shared = { ...ChannelList,
        readCustomChannels: () => options.privateChannels || [],
        loadSharedChannels: async () => current.local,
        publishSharedSnapshot(_storage, raw, previousRaw, versions) { publications.push({ raw, previousRaw, versions }); return true; }
    };
    const importer = {
        async load(...args) { sourceLoads.push(args); return options.load ? options.load(...args) : options.report || sourceReport(); },
        compare(existing, candidates) { comparisons.push({ existing, candidates }); return compareChannels(existing, candidates); }
    };
    const fetcher = async () => ({ ok: true, text: async () => options.raw || initialRaw });
    const context = vm.createContext({ document, localStorage: storage, ChannelList: shared, ChannelSync: { createClient: () => client }, TV_CHANNEL_SYNC_CONFIG: { owner: 'Umininn-gh', repo: 'tv' },
        SKLiveImport: importer, fetch: fetcher, location: { hash: options.hash || '' }, URL,
        setInterval(callback, delay) { intervals.push({ callback, delay }); },
        window: { confirm: () => options.confirm !== false, addEventListener(name, listener) { (windowListeners[name] ||= []).push(listener); } }
    });
    vm.runInContext(source, context);
    const ready = async () => { await tick(); await tick(); };
    return { nodes, current, reads, saves, batchAdds, sourceLoads, comparisons, fetcher, writes, data, storage, publications, windowListeners, document, intervals, ready,
        async connect(token = 'github_test_secret') { nodes['github-token'].value = token; await nodes['connection-form'].dispatch('submit'); },
        async submit(values) { for (const [name, value] of Object.entries(values)) nodes[name].value = value; await nodes['channel-form'].dispatch('submit'); },
        async windowEvent(name, event = {}) { await Promise.all((windowListeners[name] || []).map(listener => listener(event))); await ready(); }
    };
}

function button(row, label) { return row.querySelectorAll('button').find(element => element.textContent === label); }

test('public browsing is read-only; tokens stay in memory and are cleared on disconnect and pagehide', async () => {
    const f = fixture({ hash: '#new' }); await f.ready();
    assert.deepEqual(f.reads, ['']);
    assert.equal(f.nodes['channel-list'].children.length, 2);
    assert.equal(f.nodes['save-channel'].disabled, true);
    assert.equal(f.nodes['channel-name'].focused, true);
    const token = 'github_test_secret';
    await f.connect(token);
    assert.equal(f.reads.at(-1), token);
    assert.equal(f.nodes['github-token'].value, '');
    assert.equal(f.nodes['save-channel'].disabled, false);
    assert.equal(JSON.stringify(f.writes).includes(token), false);
    assert.equal(JSON.stringify(f.nodes).includes(token), false);
    await f.nodes['disconnect-button'].dispatch('click');
    assert.equal(f.nodes['save-channel'].disabled, true);
    await f.connect(token);
    await f.windowEvent('pagehide'); await f.windowEvent('pageshow', { persisted: true });
    assert.equal(f.nodes['save-channel'].disabled, true);
    assert.equal(JSON.stringify(f.data).includes(token), false);
});

test('shared add, edit and confirmed delete publish exact raw versions and retain cross-platform identities', async () => {
    const f = fixture(); await f.ready(); await f.connect();
    await f.submit({ 'channel-name': '美1 Twitch', 'channel-id': 'MeiDingDang', 'channel-platform': 'twitch' });
    assert.equal(f.saves.length, 1);
    assert.equal(f.saves[0].change.action, 'add');
    assert.equal(f.saves[0].change.channel.id, 'meidingdang');
    assert.equal(f.nodes['channel-list'].children.length, 3);
    assert.equal(f.publications[0].previousRaw, initialRaw);
    assert.deepEqual(Array.from(f.publications[0].versions), [initialRaw]);
    await button(f.nodes['channel-list'].children[0], '編輯').dispatch('click');
    await f.submit({ 'channel-name': '美1 新名稱', 'channel-id': 'meidingdang2' });
    assert.equal(f.saves[1].change.action, 'edit');
    assert.equal(f.saves[1].change.previous.id, 'meidingdang');
    assert.equal(f.saves[1].change.channel.id, 'meidingdang2');
    await button(f.nodes['channel-list'].children[0], '刪除').dispatch('click');
    assert.equal(f.saves[2].change.action, 'delete');
    assert.equal(f.nodes['channel-list'].children.length, 2);
});

test('remote failures keep fallback read-only and never display echoed credentials', async () => {
    const token = 'github_very_private_secret';
    const f = fixture({ read: async () => { const error = new Error('Request failed Authorization: Bearer ' + token); error.status = 401; throw error; } });
    await f.ready();
    assert.equal(f.nodes['channel-list'].children.length, 2);
    assert.match(f.nodes['manager-status'].textContent, /唯讀/);
    await f.connect(token);
    assert.equal(f.nodes['github-token'].value, '');
    assert.equal(f.nodes['save-channel'].disabled, true);
    assert.equal(f.nodes['connection-badge'].textContent, '唯讀');
    assert.equal(JSON.stringify(f.nodes).includes(token), false);
    await f.submit({ 'channel-name': 'Ignored', 'channel-id': 'ignored', 'channel-platform': 'twitch' });
    assert.equal(f.saves.length, 0);
});

test('background shared updates preserve editor drafts, detect stale targets, and do not regress to older deployments', async () => {
    const f = fixture(); await f.ready(); await f.connect();
    await button(f.nodes['channel-list'].children[0], '編輯').dispatch('click');
    f.nodes['channel-name'].value = 'My unsaved name';
    f.current.remote = snapshot('New remote name,meidingdang,gosh\n', 'sha-new');
    await f.nodes['refresh-channels'].dispatch('click');
    assert.equal(f.nodes['channel-name'].value, 'My unsaved name');
    assert.equal(f.nodes['channel-list'].children.length, 1);
    await f.windowEvent('focus');
    assert.equal(f.nodes['channel-list'].children.length, 1, 'unchanged old deployment must not regress a newer GitHub read');
    f.current.local = snapshot('Another person,meidingdang,gosh\n', 'irrelevant-local-sha');
    await f.windowEvent('storage', { storageArea: f.storage, key: ChannelList.sharedUpdateKey });
    assert.equal(f.nodes['channel-name'].value, 'My unsaved name');
    assert.match(f.nodes['channel-list'].children[0].children[0].children[0].textContent, /Another person/);
    await f.submit({});
    assert.equal(f.saves[0].change.previous.name, '美1', 'the original edit target is retained for optimistic conflict checking');
    assert.equal(f.reads.length, 3, 'focus/local synchronization does not spend anonymous GitHub API requests');
});

test('all platform fields, explicit legacy promotion, search and inert channel text work', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const f = fixture({ raw: hostile + ',example,twitch\n', privateChannels: [{ name: '舊私人台', id: 'legacy-user', platform: 'kick' }] });
    await f.ready();
    assert.equal(f.nodes['channel-platform'].children.length, 10);
    assert.equal(f.nodes['channel-list'].children[0].children[0].children[0].textContent, hostile);
    assert.equal(f.nodes['channel-list'].querySelectorAll('img').length, 0);
    assert.equal(f.nodes['legacy-channels'].hidden, false);
    assert.equal(f.saves.length, 0, 'legacy channels are never automatically published');
    await f.connect();
    await button(f.nodes['legacy-list'].children[0], '加入共用清單').dispatch('click');
    assert.equal(f.saves[0].change.channel.id, 'legacy-user');
    assert.equal(f.nodes['legacy-channels'].hidden, true);
    f.nodes['channel-search'].value = 'KICK'; await f.nodes['channel-search'].dispatch('input');
    assert.equal(f.nodes['channel-list'].children.length, 1);
    assert.match(f.nodes['channel-count'].textContent, /1 \/ 2/);
    f.nodes['channel-platform'].value = 'goodgame'; await f.nodes['channel-platform'].dispatch('change');
    assert.equal(f.nodes['goodgame-fields'].hidden, false);
    await f.submit({ 'channel-name': 'GG', 'channel-id': '219534', 'channel-gg-username': 'Pomi' });
    assert.equal(f.saves.at(-1).change.channel.ggUsername, 'Pomi');
});

test('failed writes preserve a draft and revoke expired authentication without leaking server data', async () => {
    const f = fixture({ save: async () => { const error = new Error('github_test_secret'); error.status = 403; throw error; } });
    await f.ready(); await f.connect();
    await f.submit({ 'channel-name': 'Still here', 'channel-id': 'draft', 'channel-platform': 'kick' });
    assert.equal(f.nodes['channel-name'].value, 'Still here');
    assert.equal(f.nodes['channel-id'].value, 'draft');
    assert.equal(f.nodes['save-channel'].disabled, true);
    assert.equal(f.nodes['connection-badge'].textContent, '唯讀');
    assert.equal(f.nodes['manager-status'].textContent.includes('github_test_secret'), false);
    assert.equal(f.publications.length, 0);
});

test('a pending connection cannot restore authentication after pagehide', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const f = fixture({ read: async (token, current) => token ? pending : current.remote });
    await f.ready();
    const connecting = f.connect(); await tick();
    assert.equal(f.nodes['connect-button'].disabled, true);
    await f.windowEvent('pagehide');
    release(f.current.remote); await connecting;
    assert.equal(f.nodes['github-token'].value, '');
    assert.equal(f.nodes['connection-badge'].textContent, '唯讀');
    assert.equal(f.nodes['save-channel'].disabled, true);
});

test('cancelled deletion and repeated submit during an in-flight write cannot create extra mutations', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const f = fixture({ confirm: false, save: () => pending });
    await f.ready(); await f.connect();
    await button(f.nodes['channel-list'].children[0], '刪除').dispatch('click');
    assert.equal(f.saves.length, 0);
    const saving = f.submit({ 'channel-name': 'New', 'channel-id': 'new', 'channel-platform': 'kick' }); await tick();
    assert.equal(f.nodes['save-channel'].disabled, true);
    await f.nodes['channel-form'].dispatch('submit');
    assert.equal(f.saves.length, 1);
    release(snapshot(initialRaw + 'New,new,kick\n', 'new-sha')); await saving; await f.ready();
    assert.equal(f.publications.length, 1);
    assert.equal(f.nodes['save-channel'].disabled, false);
});

test('SKLive button previews against a fresh public GitHub read without writing or sending the token to the importer', async () => {
    const report = sourceReport([...snapshot(initialRaw).channels, channel('來源新台', 'new-source', 'kick'), channel('真正漏台', 'still-missing')]);
    const f = fixture({ report }); await f.ready();
    f.current.remote = snapshot(initialRaw + '別人先加入,new-source,kick\n', 'sha-current');
    f.nodes['channel-name'].value = '未儲存草稿';
    await f.nodes['sync-sklive'].dispatch('click');
    assert.deepEqual(f.reads, ['', '']);
    assert.equal(f.batchAdds.length, 0);
    assert.equal(f.saves.length, 0);
    assert.equal(f.publications.length, 0);
    assert.equal(f.nodes['channel-list'].children.length, 3, 'preview accepts the newest shared snapshot');
    assert.equal(f.nodes['sklive-additions'].children.length, 1);
    assert.match(f.nodes['sklive-additions'].children[0].textContent, /真正漏台/);
    assert.match(f.nodes['manager-status'].textContent, /找到 1 個漏台.*連線 GitHub/);
    assert.equal(f.nodes['manager-status'].className, 'status warning');
    assert.equal(f.nodes['channel-name'].value, '未儲存草稿');
    assert.equal(f.nodes['save-channel'].disabled, true);
    assert.equal(f.sourceLoads.length, 1);
    assert.equal(f.sourceLoads[0].length, 1);
    assert.equal(f.sourceLoads[0][0], f.fetcher, 'the importer receives only the fetch function');
    assert.equal(f.comparisons[0].existing, f.current.remote.channels);
});

test('connected SKLive sync makes one batch call and publishes only after confirmed success, preserving the draft', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const report = sourceReport([...snapshot(initialRaw).channels, channel('新台 A', 'new-a', 'kick'), channel('新台 B', 'new-b')]);
    const f = fixture({ report, addMissing: () => pending }); await f.ready(); await f.connect();
    await button(f.nodes['channel-list'].children[0], '編輯').dispatch('click');
    f.nodes['channel-name'].value = '保留我的草稿';
    const syncing = f.nodes['sync-sklive'].dispatch('click'); await tick();
    assert.equal(f.batchAdds.length, 1);
    assert.equal(f.batchAdds[0].candidates, report.channels);
    assert.equal(f.batchAdds[0].token, 'github_test_secret');
    assert.equal(f.saves.length, 0);
    assert.equal(f.publications.length, 0);
    assert.equal(f.nodes['channel-list'].children.length, 2, 'unconfirmed writes must not change the list');
    assert.equal(f.nodes['sync-sklive'].disabled, true);
    await f.nodes['sync-sklive'].dispatch('click');
    await f.nodes['channel-form'].dispatch('submit');
    assert.equal(f.sourceLoads.length, 1);
    assert.equal(f.batchAdds.length, 1);
    assert.equal(f.saves.length, 0);
    const baseRaw = initialRaw + '別人同時加入,unrelated,twitch\n';
    const raw = baseRaw + '新台 A,new-a,kick\n新台 B,new-b,gosh\n';
    release({ ...snapshot(raw, 'sha-confirmed'), baseRaw, added: report.channels.slice(2), unchanged: false });
    await syncing;
    assert.equal(f.nodes['channel-list'].children.length, 5);
    assert.equal(f.publications.length, 1);
    assert.equal(f.publications[0].raw, raw);
    assert.equal(f.publications[0].previousRaw, initialRaw);
    assert.deepEqual(Array.from(f.publications[0].versions), [baseRaw]);
    assert.equal(f.nodes['channel-name'].value, '保留我的草稿');
    assert.equal(f.nodes['channel-id'].value, 'meidingdang');
    assert.match(f.nodes['manager-status'].textContent, /已補回 2 台/);
    assert.equal(f.nodes['sync-sklive'].disabled, false);
    assert.equal(f.sourceLoads[0].length, 1);
    assert.equal(f.sourceLoads[0][0], f.fetcher);
    assert.equal(JSON.stringify(f.nodes).includes('github_test_secret'), false);
    assert.equal(JSON.stringify(f.writes).includes('github_test_secret'), false);
});

test('connected SKLive no-op refreshes the latest rows but does not publish a browser update', async () => {
    const f = fixture({ report: sourceReport(snapshot(initialRaw).channels) }); await f.ready(); await f.connect();
    f.current.remote = snapshot('我的自訂名,meidingdang,gosh\n大波,dindinxd19,twitch\n', 'sha-new');
    await f.nodes['sync-sklive'].dispatch('click');
    assert.equal(f.batchAdds.length, 1);
    assert.equal(f.publications.length, 0);
    assert.equal(f.nodes['sklive-additions'].children.length, 0);
    assert.match(f.nodes['channel-list'].children[0].children[0].children[0].textContent, /我的自訂名/);
    assert.match(f.nodes['manager-status'].textContent, /沒有修改清單/);
    assert.equal(f.nodes['manager-status'].className, 'status success');
});

test('SKLive source failure preserves rows, draft and GitHub authentication without echoing errors or making writes', async () => {
    let failSource = true;
    const f = fixture({ load: async () => {
        if (failSource) { const error = new Error('Authorization: Bearer github_test_secret'); error.status = 401; throw error; }
        return sourceReport();
    } }); await f.ready(); await f.connect();
    f.nodes['channel-name'].value = '來源失敗仍保留';
    f.nodes['channel-id'].value = 'draft-id';
    const rows = f.nodes['channel-list'].children;
    const previousReads = f.reads.length;
    await f.nodes['sync-sklive'].dispatch('click');
    assert.equal(f.batchAdds.length, 0);
    assert.equal(f.saves.length, 0);
    assert.equal(f.reads.length, previousReads, 'source failures do not start a GitHub operation');
    assert.equal(f.publications.length, 0);
    assert.equal(f.nodes['channel-list'].children, rows);
    assert.equal(f.nodes['channel-name'].value, '來源失敗仍保留');
    assert.equal(f.nodes['channel-id'].value, 'draft-id');
    assert.equal(f.nodes['save-channel'].disabled, false, 'a source HTTP error cannot revoke GitHub credentials');
    assert.match(f.nodes['manager-status'].textContent, /SKLive.*沒有新增或刪除/);
    assert.equal(JSON.stringify(f.nodes).includes('github_test_secret'), false);
    assert.equal(JSON.stringify(f.writes).includes('github_test_secret'), false);
    failSource = false;
    await f.nodes['sync-sklive'].dispatch('click');
    assert.equal(f.batchAdds.length, 1);
    assert.equal(f.batchAdds[0].token, 'github_test_secret');
    assert.equal(f.publications.length, 1);
});

test('SKLive GitHub write failures preserve rows and draft, revoking only unauthorized GitHub credentials', async () => {
    for (const [status, code, revoked] of [[401, 'auth', true], [403, 'permission', true], [403, 'rate_limit', false], [500, 'http', false]]) {
        const f = fixture({ addMissing: async () => { const error = new Error('github_test_secret'); error.status = status; error.code = code; throw error; } });
        await f.ready(); await f.connect();
        f.nodes['channel-name'].value = 'GitHub 失敗草稿';
        f.nodes['channel-id'].value = 'draft-id';
        const rows = f.nodes['channel-list'].children;
        await f.nodes['sync-sklive'].dispatch('click');
        assert.equal(f.batchAdds.length, 1);
        assert.equal(f.saves.length, 0);
        assert.equal(f.publications.length, 0);
        assert.equal(f.nodes['channel-list'].children, rows);
        assert.equal(f.nodes['channel-name'].value, 'GitHub 失敗草稿');
        assert.equal(f.nodes['channel-id'].value, 'draft-id');
        assert.equal(f.nodes['save-channel'].disabled, revoked);
        assert.equal(f.nodes['connection-badge'].textContent, revoked ? '唯讀' : '已連線');
        assert.equal(f.nodes['manager-status'].className, 'status error');
        assert.equal(JSON.stringify(f.nodes).includes('github_test_secret'), false);
        assert.equal(JSON.stringify(f.writes).includes('github_test_secret'), false);
    }
});

test('SKLive readonly GitHub read failure retains the previous rows and unsaved draft', async () => {
    let failRead = false;
    const f = fixture({ read: async (_token, current) => { if (failRead) { const error = new Error('private upstream details'); error.status = 500; throw error; } return current.remote; } });
    await f.ready();
    f.nodes['channel-name'].value = '唯讀草稿';
    const rows = f.nodes['channel-list'].children;
    failRead = true;
    await f.nodes['sync-sklive'].dispatch('click');
    assert.equal(f.nodes['channel-list'].children, rows);
    assert.equal(f.nodes['channel-name'].value, '唯讀草稿');
    assert.equal(f.batchAdds.length, 0);
    assert.equal(f.publications.length, 0);
    assert.equal(f.nodes['sklive-result'].hidden, true);
    assert.equal(f.nodes['manager-status'].textContent.includes('private upstream details'), false);
});

test('pagehide while SKLive source is pending prevents a later GitHub write and repeated clicks stay coalesced', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const f = fixture({ load: () => pending }); await f.ready(); await f.connect();
    f.nodes['channel-name'].value = '離開後的草稿';
    const syncing = f.nodes['sync-sklive'].dispatch('click'); await tick();
    await f.nodes['sync-sklive'].dispatch('click');
    assert.equal(f.sourceLoads.length, 1);
    assert.equal(f.batchAdds.length, 0);
    await f.windowEvent('pagehide');
    release(sourceReport()); await syncing;
    await f.windowEvent('pageshow', { persisted: true });
    assert.equal(f.batchAdds.length, 0);
    assert.equal(f.reads.length, 2, 'late source success must not start any GitHub request');
    assert.equal(f.saves.length, 0);
    assert.equal(f.publications.length, 0);
    assert.equal(f.nodes['channel-list'].children.length, 2);
    assert.equal(f.nodes['channel-name'].value, '離開後的草稿');
    assert.equal(f.nodes['save-channel'].disabled, true);
    assert.equal(f.nodes['connection-badge'].textContent, '唯讀');
    assert.equal(JSON.stringify(f.nodes).includes('github_test_secret'), false);
});

test('unrecognized SKLive rows are clearly incomplete instead of claiming all source channels are included', async () => {
    const f = fixture({ report: sourceReport(snapshot(initialRaw).channels, { received: 4, hidden: 1, duplicates: [{ index: 2 }], skipped: [{ index: 3, reason: 'unsupported' }] }) });
    await f.ready();
    await f.nodes['sync-sklive'].dispatch('click');
    assert.match(f.nodes['sklive-summary'].textContent, /來源共 4 筆.*1 筆標記隱藏/);
    assert.match(f.nodes['sklive-summary'].textContent, /合併 1 筆重複/);
    assert.match(f.nodes['sklive-summary'].textContent, /1 筆未能識別/);
    assert.doesNotMatch(f.nodes['sklive-summary'].textContent, /全部包括|沒有漏台/);
    assert.doesNotMatch(f.nodes['manager-status'].textContent, /全部已包括/);
    assert.equal(f.nodes['manager-status'].className, 'status warning');
    assert.equal(f.publications.length, 0);
});

test('all-unrecognized SKLive input warns without any GitHub operation and preserves the draft in both connection modes', async () => {
    for (const connected of [false, true]) {
        const report = sourceReport([], { received: 2, hidden: 1, skipped: [{ index: 0, reason: 'unsupported' }, { index: 1, reason: 'unsupported' }] });
        const f = fixture({ report }); await f.ready();
        if (connected) await f.connect();
        f.nodes['channel-name'].value = '所有來源未知仍保留';
        f.nodes['channel-id'].value = 'draft-id';
        const rows = f.nodes['channel-list'].children;
        const reads = f.reads.length;
        await f.nodes['sync-sklive'].dispatch('click');
        assert.equal(f.reads.length, reads, 'all-unrecognized input must not start a GitHub read');
        assert.equal(f.batchAdds.length, 0);
        assert.equal(f.saves.length, 0);
        assert.equal(f.publications.length, 0);
        assert.equal(f.comparisons.length, 0);
        assert.equal(f.nodes['channel-list'].children, rows);
        assert.equal(f.nodes['channel-name'].value, '所有來源未知仍保留');
        assert.equal(f.nodes['channel-id'].value, 'draft-id');
        assert.equal(f.nodes['sklive-result'].hidden, false);
        assert.equal(f.nodes['sklive-additions'].children.length, 0);
        assert.match(f.nodes['sklive-summary'].textContent, /沒有可識別的入口/);
        assert.match(f.nodes['manager-status'].textContent, /沒有可識別的入口.*沒有修改清單/);
        assert.doesNotMatch(f.nodes['sklive-summary'].textContent, /全部包括|沒有漏台/);
        assert.doesNotMatch(f.nodes['manager-status'].textContent, /全部已包括/);
        assert.equal(f.nodes['manager-status'].className, 'status warning');
        assert.equal(f.nodes['sync-sklive'].disabled, false);
        assert.equal(f.nodes['save-channel'].disabled, !connected);
    }
});
