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
    removeAttribute(key) { delete this.attributes[key]; }
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
    const health = { options: null, creations: 0, refreshes: 0, cancellations: 0 };
    const location = { hash: options.hash || '' };
    const context = vm.createContext({ document, localStorage: storage, ChannelList: shared, ChannelSync: { createClient: () => client }, TV_CHANNEL_SYNC_CONFIG: { owner: 'Umininn-gh', repo: 'tv' },
        ...(options.health ? { ChannelHealth: {}, ChannelHealthUI: { createUI(settings) { health.creations++; health.options = settings; return { refresh() { health.refreshes++; }, cancel() { health.cancellations++; } }; } } } : {}),
        SKLiveImport: importer, fetch: fetcher, location, URL,
        setInterval(callback, delay) { intervals.push({ callback, delay }); },
        window: { confirm: () => options.confirm !== false, addEventListener(name, listener) { (windowListeners[name] ||= []).push(listener); } }
    });
    vm.runInContext(source, context);
    const ready = async () => { await tick(); await tick(); };
    return { nodes, current, reads, saves, batchAdds, sourceLoads, comparisons, fetcher, writes, data, storage, publications, windowListeners, document, intervals, ready, health, location,
        async connect(token = 'github_test_secret') { nodes['github-token'].value = token; await nodes['connection-form'].dispatch('submit'); },
        async submit(values) { for (const [name, value] of Object.entries(values)) nodes[name].value = value; await nodes['channel-form'].dispatch('submit'); },
        async windowEvent(name, event = {}) { await Promise.all((windowListeners[name] || []).map(listener => listener(event))); await ready(); },
        async route(hash) { location.hash = hash; await this.windowEvent('hashchange'); }
    };
}

function button(row, label) { return row.querySelectorAll('button').find(element => element.textContent === label); }

function visibleFeatureSections(f) {
    return ['new', 'channels', 'sklive', 'health'].filter(id => !f.nodes[id].hidden);
}

test('each service opens only its own screen; unknown routes fall back to management', async () => {
    for (const [hash, section, active] of [
        ['', 'channels', 'manage'], ['#manage', 'channels', 'manage'],
        ['#new', 'new', 'new'], ['#channels', 'channels', 'channels'],
        ['#sklive', 'sklive', 'sklive'], ['#health', 'health', 'health'],
        ['#not-a-screen', 'channels', 'manage']
    ]) {
        const f = fixture({ hash }); await f.ready();
        assert.deepEqual(visibleFeatureSections(f), [section], hash || 'default screen');
        assert.ok(f.nodes['page-heading'].textContent, 'the visible screen has its own heading');
        assert.ok(f.nodes['page-description'].textContent, 'the visible screen explains its purpose');
        for (const view of ['manage', 'new', 'channels', 'sklive', 'health']) {
            assert.equal(f.nodes['view-' + view].attributes['aria-current'], view === active ? 'page' : 'false', hash + ' ' + view);
        }
        assert.equal(f.saves.length, 0);
        assert.equal(f.batchAdds.length, 0);
    }
});

test('management and deletion screens expose distinct actions while readonly navigation cannot mutate', async () => {
    const f = fixture(); await f.ready();
    let first = f.nodes['channel-list'].children[0];
    assert.ok(button(first, '編輯'));
    assert.ok(!button(first, '編輯').hidden);
    assert.ok(!button(first, '刪除') || button(first, '刪除').hidden);
    assert.equal(button(first, '編輯').disabled, true);
    await f.route('#channels');
    first = f.nodes['channel-list'].children[0];
    assert.ok(button(first, '刪除'));
    assert.ok(!button(first, '刪除').hidden);
    assert.ok(!button(first, '編輯') || button(first, '編輯').hidden);
    assert.equal(button(first, '刪除').disabled, true);
    await button(first, '刪除').dispatch('click');
    for (const view of ['new', 'sklive', 'health', 'manage']) await f.route('#' + view);
    assert.equal(f.saves.length, 0);
    assert.equal(f.batchAdds.length, 0);
    assert.equal(f.publications.length, 0);
});

test('new and edit drafts survive navigation independently without losing the authenticated session', async () => {
    const f = fixture({ hash: '#new' }); await f.ready(); await f.connect();
    f.nodes['channel-name'].value = '新增草稿';
    f.nodes['channel-id'].value = 'new-draft';
    f.nodes['channel-platform'].value = 'kick';
    const authenticatedReads = f.reads.length;
    await f.route('#sklive'); await f.route('#health'); await f.route('#new');
    assert.equal(f.nodes['channel-name'].value, '新增草稿');
    assert.equal(f.nodes['channel-id'].value, 'new-draft');
    assert.equal(f.nodes['channel-platform'].value, 'kick');
    await f.route('#manage');
    await button(f.nodes['channel-list'].children[0], '編輯').dispatch('click');
    assert.deepEqual(visibleFeatureSections(f), ['new']);
    assert.equal(f.nodes['channel-name'].value, '美1');
    f.nodes['channel-name'].value = '編輯草稿';
    f.nodes['channel-id'].value = 'edit-draft';
    await f.route('#new');
    assert.equal(f.nodes['channel-name'].value, '新增草稿');
    assert.equal(f.nodes['channel-id'].value, 'new-draft');
    await f.route('#edit');
    assert.equal(f.nodes['channel-name'].value, '編輯草稿');
    assert.equal(f.nodes['channel-id'].value, 'edit-draft');
    assert.equal(f.nodes['connection-badge'].textContent, '已連線');
    assert.equal(f.nodes['save-channel'].disabled, false);
    assert.equal(f.reads.length, authenticatedReads, 'screen changes do not reconnect or reload GitHub');
    assert.equal(f.saves.length, 0);
    await f.nodes['cancel-edit'].dispatch('click');
    assert.deepEqual(visibleFeatureSections(f), ['channels']);
    await f.route('#new');
    assert.equal(f.nodes['channel-name'].value, '新增草稿', 'cancelling an edit does not erase the independent new draft');
    assert.equal(JSON.stringify(f.writes).includes('github_test_secret'), false);
});

test('health repair returns to the original result screen on cancellation or successful save', async () => {
    const f = fixture({ hash: '#health', health: true }); await f.ready(); await f.connect();
    const h = f.health.options;
    const previous = h.getSnapshot().channels[0];
    const resultMarker = new Element('li'); resultMarker.textContent = '既有查核結果';
    f.nodes['health-results'].appendChild(resultMarker);
    assert.equal((await h.runAction({ action: 'edit', previous, channel: { id: 'repaired-entry', platform: 'kick' } })).opened, true);
    assert.deepEqual(visibleFeatureSections(f), ['new']);
    assert.equal(f.nodes['channel-id'].value, 'repaired-entry');
    await f.nodes['cancel-edit'].dispatch('click');
    assert.deepEqual(visibleFeatureSections(f), ['health']);
    assert.equal(f.health.options, h, 'the health UI and scanner facade are retained');
    assert.equal(f.health.creations, 1);
    assert.equal(f.nodes['health-results'].children[0], resultMarker);
    assert.equal(f.health.cancellations, 0);
    assert.equal(f.saves.length, 0);
    await h.runAction({ action: 'edit', previous, channel: { id: 'repaired-entry', platform: 'kick' } });
    await f.submit({});
    assert.equal(f.saves.length, 1);
    assert.equal(f.saves[0].change.action, 'edit');
    assert.equal(f.saves[0].change.previous.id, previous.id);
    assert.equal(f.saves[0].change.channel.id, 'repaired-entry');
    assert.deepEqual(visibleFeatureSections(f), ['health']);
    assert.equal(f.health.creations, 1);
    assert.equal(f.nodes['health-results'].children[0], resultMarker);
});

test('an edit saved after leaving its screen cannot resurrect an empty editor through browser history', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const f = fixture({ save: () => pending }); await f.ready(); await f.connect();
    await button(f.nodes['channel-list'].children[0], '編輯').dispatch('click');
    await f.submit({ 'channel-name': '已儲存名稱' });
    assert.equal(f.nodes['save-channel'].disabled, true);
    await f.route('#health');
    release(snapshot('已儲存名稱,meidingdang,gosh\n大波,dindinxd19,twitch\n', 'saved-away'));
    await f.ready();
    assert.deepEqual(visibleFeatureSections(f), ['health'], 'completion leaves the current screen alone');
    await f.route('#edit');
    assert.deepEqual(visibleFeatureSections(f), ['channels'], 'history cannot reopen a cleared edit draft as a new channel');
    assert.equal(f.nodes['view-manage'].attributes['aria-current'], 'page');
    assert.equal(f.saves.length, 1);
});

test('legacy promotion stays within management and addition even after background list rerenders', async () => {
    const f = fixture({ privateChannels: [channel('舊私人台', 'legacy-user', 'kick')] }); await f.ready();
    assert.equal(f.nodes['legacy-channels'].hidden, false);
    await f.route('#new');
    assert.equal(f.nodes['legacy-channels'].hidden, false);
    for (const view of ['channels', 'sklive', 'health']) {
        await f.route('#' + view);
        assert.equal(f.nodes['legacy-channels'].hidden, true, view);
        f.nodes['channel-search'].value = view;
        await f.nodes['channel-search'].dispatch('input');
        assert.equal(f.nodes['legacy-channels'].hidden, true, view + ' after render');
    }
    await f.route('#manage');
    assert.equal(f.nodes['legacy-channels'].hidden, false);
    assert.equal(f.saves.length, 0);
});

test('health scan always loads a fresh snapshot; readonly results have no write authority and pagehide cancels', async () => {
    const f = fixture({ health: true }); await f.ready();
    const h = f.health.options;
    assert.ok(h);
    assert.equal(h.canWrite(), false);
    assert.equal((await h.runAction({ action: 'delete', previous: h.getSnapshot().channels[0] })).ok, false);
    assert.equal(f.saves.length, 0);
    f.current.remote = snapshot('Fresh,latest,twitch\n', 'fresh-sha');
    const fresh = await h.loadSnapshot();
    assert.equal(fresh.sha, 'fresh-sha');
    assert.equal(f.nodes['channel-list'].children.length, 1);
    fresh.channels[0].name = 'mutated caller copy';
    assert.equal(h.getSnapshot().channels[0].name, 'Fresh');
    assert.equal(f.saves.length, 0);
    await f.windowEvent('pagehide');
    assert.equal(f.health.cancellations, 1);
});

test('health edit opens a repair draft without writing and refuses stale original records', async () => {
    const f = fixture({ health: true }); await f.ready(); await f.connect();
    const h = f.health.options;
    const previous = h.getSnapshot().channels[0];
    const opened = await h.runAction({ action: 'edit', previous, channel: { id: 'repaired-entry', platform: 'kick' } });
    assert.equal(opened.opened, true);
    assert.equal(f.nodes['channel-id'].value, 'repaired-entry');
    assert.equal(f.nodes['channel-platform'].value, 'kick');
    assert.equal(f.nodes['channel-name'].value, previous.name);
    assert.equal(f.saves.length, 0);
    f.current.remote = snapshot('New name,meidingdang,gosh\n大波,dindinxd19,twitch\n', 'changed');
    await h.loadSnapshot();
    assert.equal((await h.runAction({ action: 'delete', previous })).ok, false);
    assert.match(f.nodes['manager-status'].textContent, /已被修改或移除/);
    assert.equal(f.saves.length, 0);
});

test('health fresh-list read holds the shared mutation lock and does not restore a disconnected session', async () => {
    let release;
    const f = fixture({ health: true }); await f.ready(); await f.connect();
    const h = f.health.options;
    f.current.remote = new Promise(resolve => { release = resolve; });
    const pending = h.loadSnapshot();
    await tick();
    assert.equal(h.isBusy(), true);
    await f.submit({ 'channel-name': 'Blocked', 'channel-id': 'blocked', 'channel-platform': 'twitch' });
    assert.equal(f.saves.length, 0);
    await f.windowEvent('pagehide');
    release(snapshot('Too late,late,twitch\n', 'late'));
    await assert.rejects(pending);
    assert.equal(h.getSnapshot().channels[0].name, '美1');
    assert.equal(h.canWrite(), false);
    assert.equal(h.isBusy(), false);
});

test('health fresh-list auth failure revokes an expired GitHub token while preserving prior rows', async () => {
    let fail = false;
    const f = fixture({ health: true, read: async (_token, current) => {
        if (fail) throw Object.assign(new Error('private details'), { status: 401 });
        return current.remote;
    } });
    await f.ready(); await f.connect();
    fail = true;
    await assert.rejects(f.health.options.loadSnapshot());
    assert.equal(f.health.options.canWrite(), false);
    assert.equal(f.health.options.getSnapshot().channels.length, 2);
    assert.equal(f.nodes['connection-badge'].textContent, '唯讀');
});

test('health deletion reports success only after explicit confirmation and a confirmed shared save', async () => {
    const cancelled = fixture({ health: true, confirm: false }); await cancelled.ready(); await cancelled.connect();
    assert.equal((await cancelled.health.options.runAction({ action: 'delete', previous: cancelled.health.options.getSnapshot().channels[0] })).ok, false);
    assert.equal(cancelled.saves.length, 0);
    const success = fixture({ health: true }); await success.ready(); await success.connect();
    const previous = success.health.options.getSnapshot().channels[0];
    assert.equal((await success.health.options.runAction({ action: 'delete', previous })).ok, true);
    assert.equal(success.saves.length, 1);
    assert.equal(success.saves[0].change.previous.id, previous.id);
    assert.equal(success.health.options.getSnapshot().channels.length, 1);
    const failed = fixture({ health: true, save: async () => { throw Object.assign(new Error('private server body'), { code: 'write_conflict' }); } });
    await failed.ready(); await failed.connect();
    assert.equal((await failed.health.options.runAction({ action: 'delete', previous: failed.health.options.getSnapshot().channels[0] })).ok, false);
    assert.equal(failed.health.options.getSnapshot().channels.length, 2);
    assert.equal(failed.publications.length, 0);
});

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
    await f.route('#channels');
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
    await f.route('#channels');
    await button(f.nodes['channel-list'].children[0], '刪除').dispatch('click');
    assert.equal(f.saves.length, 0);
    await f.route('#new');
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
