const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ChannelList = require('../channel-list.js');
const StreamPerformance = require('../stream-performance.js');
const PlayerLayout = require('../player-layout.js');
const PlayerGeometry = require('../player-geometry.js');

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const preference = muted => ({ channel: 'umininn-tv-player', version: 1, type: 'site:audio-preference', muted });
const channel = name => ({ name, platform: 'm3u8', id: `https://example.com/${name}.m3u8` });

class Element {
    constructor(tag) {
        this.tagName = tag.toUpperCase(); this.style = {}; this.dataset = {}; this.children = []; this.parentNode = null;
        this.volume = 1; this.muted = false; this.paused = true; this.playCalls = 0; this.pauseCalls = 0; this.loadCalls = 0;
        this.classList = { toggle() {} };
    }
    get isConnected() { return this.root || Boolean(this.parentNode?.isConnected); }
    appendChild(child) { child.remove(); child.parentNode = this; this.children.push(child); return child; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    replaceChildren(...children) { for (const child of [...this.children]) child.remove(); children.forEach(child => this.appendChild(child)); }
    set innerHTML(value) { this.replaceChildren(); this.html = value; }
    get innerHTML() { return this.html || ''; }
    querySelectorAll(selector) {
        return this.children.flatMap(child => [child, ...child.querySelectorAll(selector)]).filter(child => selector === 'iframe' ? child.tagName === 'IFRAME' : true);
    }
    addEventListener() {}
    removeAttribute(name) { delete this[name]; }
    play() { this.playCalls++; this.paused = false; return Promise.resolve(); }
    pause() { this.pauseCalls++; this.paused = true; }
    load() { this.loadCalls++; }
}

function siteFixture(admin = false) {
    const pane = new Element('div'); pane.root = true;
    const selection = new Element('div');
    const window = { listeners: new Map(), addEventListener(type, listener) { this.listeners.set(type, listener); } };
    class Hls {
        static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
        static isSupported() { return true; }
        on() {} loadSource() {} attachMedia() {} destroy() {}
    }
    const context = vm.createContext({ window, location: { hostname: 'umininn-gh.github.io', origin: 'https://umininn-gh.github.io' },
        document: { getElementById: id => id === 'multi-stream-container' ? pane : id === 'channel-selection' ? selection : null,
            createElement: tag => new Element(tag), addEventListener() {}, documentElement: { hasAttribute() { return false; } } }, Hls, ChannelList, StreamPerformance, PlayerLayout, PlayerGeometry, queueMicrotask, console, URL });
    let source = read(admin ? 'admin.html' : 'tv-app.js');
    source = admin
        ? source.slice(source.indexOf('        // ======================== 全域變數'), source.indexOf('        // ======================== 載入 Twitch 憑證'))
        : source.slice(0, source.indexOf('/* =============== 頻道儲存 / 載入'));
    vm.runInContext(source, context);
    const players = admin ? 'adminPlayers' : 'activePlayers';
    return {
        pane, context, window,
        sync(list) { context.selected = list; vm.runInContext(admin ? 'renderAdminChannels(selected, "empty")' : 'syncActivePlayers(selected)', context); },
        entry(selected) { context.selectedChannel = selected; return vm.runInContext(`${players}.get(ChannelList.channelKey(selectedChannel))`, context); },
        muted() { return vm.runInContext(admin ? 'getAdminGlobalMuted()' : 'getGlobalMuted()', context); },
        send(data, overrides = {}) { window.listeners.get('message')({ data, source: window, origin: context.location.origin, ...overrides }); }
    };
}

for (const admin of [false, true]) {
    const label = admin ? 'admin' : 'main';
    test(`${label}: extension global mute survives selection changes without replaying retained media`, async () => {
        const site = siteFixture(admin), a = channel('first'), b = channel('second');
        site.sync([a, b]); await new Promise(resolve => setImmediate(resolve));
        const entry = site.entry(a), video = admin ? entry.video : entry.resource.video;
        // These are the changes the extension applies inside each media controller.
        video.muted = true; video.volume = 0.27;
        site.send(preference(true));
        assert.equal(site.muted(), true);
        assert.equal(entry.muted, true);
        assert.equal(video.pauseCalls, 0); assert.equal(video.playCalls, 0); assert.equal(video.loadCalls, 0);

        site.sync([a]);
        assert.equal(site.entry(a), entry, 'the existing player is retained');
        assert.equal(video.muted, true, 'switching from multiple players to one cannot undo the extension choice');
        assert.equal(video.volume, 0.27); assert.equal(video.paused, true);
        assert.equal(video.playCalls, 0); assert.equal(video.pauseCalls, 0); assert.equal(video.loadCalls, 0);

        video.muted = false; // later per-player adjustment stays independent
        site.sync([a]);
        assert.equal(video.muted, false, 'ordinary reconciliation preserves later individual mute changes');
        site.sync([a, b]);
        assert.equal(video.muted, false, 'adding a player preserves the existing individual choice');
        const added = site.entry(b);
        assert.equal((admin ? added.video : added.resource.video).muted, true, 'new players inherit the global choice');
    });

    test(`${label}: preference bridge rejects other sources, origins, protocols and non-Boolean values`, () => {
        const site = siteFixture(admin), a = channel('first'); site.sync([a]);
        const entry = site.entry(a), video = admin ? entry.video : entry.resource.video;
        const before = site.muted();
        for (const [data, overrides] of [
            [preference(true), { source: {} }], [preference(true), { origin: 'https://other.example' }],
            [{ ...preference(true), channel: 'other' }], [{ ...preference(true), version: 2 }],
            [{ ...preference(true), type: 'site:command' }], [preference('true')], [preference(1)], [preference(null)], [null]
        ]) {
            site.send(data, overrides);
            assert.equal(site.muted(), before); assert.equal(entry.muted, before); assert.equal(video.muted, before);
        }
        site.send(preference(true));
        assert.equal(site.muted(), true); assert.equal(entry.muted, true);
        assert.equal(video.muted, before, 'receiving a preference updates metadata only');
    });
}

test('extension publishes the exact mute-only protocol while audio commands await the focus barrier', async () => {
    const source = read('browser-extension/site-ui.js');
    const method = source.match(/        function setGlobalMuted\(muted\) \{[\s\S]*?\n        \}/);
    assert.ok(method);
    const messages = [], commands = [];
    let settleFocus;
    const focusBarrier = new Promise(resolve => { settleFocus = resolve; });
    const context = vm.createContext({
        win: { location: { origin: 'https://umininn-gh.github.io' }, postMessage: (data, origin) => messages.push({ data, origin }) },
        envelope: (type, extra) => ({ channel: 'umininn-tv-player', version: 1, type, ...extra }),
        refreshSummary() {}, afterAudioFocus: operation => focusBarrier.then(operation),
        applyAll: command => { commands.push(command); return Promise.resolve(); }
    });
    vm.runInContext('let globalMuted = null;\n' + method[0] + '\nsetGlobalMuted(true); setGlobalMuted(false);', context);
    assert.deepEqual(JSON.parse(JSON.stringify(messages)), [true, false].map(muted => ({ data: preference(muted), origin: 'https://umininn-gh.github.io' })));
    assert.deepEqual(commands, [], 'an earlier in-flight focus command must settle before manual mute commands');
    settleFocus();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(JSON.parse(JSON.stringify(commands)), [true, false].map(value => ({ action: 'setMuted', value })));
});
