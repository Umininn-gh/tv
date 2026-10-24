'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ChannelList = require('../channel-list.js');
const StreamPerformance = require('../stream-performance.js');
const PlayerLayout = require('../player-layout.js');
const PlayerGeometry = require('../player-geometry.js');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const app = read('tv-app.js');
const coreEnd = app.indexOf('/* =============== 頻道儲存 / 載入');
assert.ok(coreEnd > 0, 'the production playback core seam must exist');
const flush = () => new Promise(resolve => setImmediate(resolve));
const channel = (id, platform = 'm3u8') => ({ id, platform, name: id });

// Exercise the real login loader and real player lifecycle together, with the
// network and SDK boundary controlled so requests can finish after a close.
function fixture({ nativeHls = false } = {}) {
    const requests = [], hlsPlayers = [], flvPlayers = [], warnings = [];
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase(); this.style = {}; this.dataset = {}; this.children = [];
            this.parentNode = null; this.listeners = new Map(); this.className = '';
            this.classList = {
                contains: token => this.className.split(/\s+/).includes(token),
                toggle: (token, force) => {
                    const tokens = new Set(this.className.split(/\s+/).filter(Boolean));
                    const enabled = force === undefined ? !tokens.has(token) : Boolean(force);
                    if (enabled) tokens.add(token); else tokens.delete(token);
                    this.className = [...tokens].join(' ');
                    return enabled;
                },
                remove: (...tokens) => { this.className = this.className.split(/\s+/).filter(token => token && !tokens.includes(token)).join(' '); }
            };
            this.muted = false; this.volume = 1; this.playCalls = this.pauseCalls = this.loadCalls = 0;
        }
        get isConnected() { return this.root || Boolean(this.parentNode?.isConnected); }
        appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; return child; }
        replaceChildren(...children) { for (const child of [...this.children]) child.remove(); children.forEach(child => this.appendChild(child)); }
        remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
        replaceWith(next) { const parent = this.parentNode, index = parent.children.indexOf(this); this.remove(); parent.children.splice(index, 0, next); next.parentNode = parent; }
        set innerHTML(value) { for (const child of [...this.children]) child.remove(); this.html = value; }
        addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
        emit(type) { for (const listener of this.listeners.get(type) || []) listener({ type, target: this }); }
        setAttribute() {} removeAttribute(name) { delete this[name]; } focus() {}
        canPlayType() { return nativeHls ? 'probably' : ''; }
        play() { this.playCalls++; return Promise.resolve(); }
        pause() { this.pauseCalls++; }
        load() { this.loadCalls++; }
    }
    const pane = new Element('div'); pane.root = true;
    const head = new Element('head'); head.root = true;
    const append = head.appendChild.bind(head);
    head.appendChild = script => { requests.push(script); return append(script); };
    const loginNodes = new Map(['login-screen', 'login-form', 'login-password', 'login-submit', 'toggle-password', 'login-status']
        .map(id => [id, new Element('div')]));
    const context = vm.createContext({
        document: { head, documentElement: { hasAttribute() { return false; } },
            getElementById: id => id === 'multi-stream-container' ? pane : loginNodes.get(id) || null,
            createElement: tag => new Element(tag), addEventListener() {}, querySelectorAll: () => [] },
        location: { hostname: 'site.invalid', origin: 'https://site.invalid' },
        sessionStorage: { getItem() { return null; } }, localStorage: { setItem() {}, removeItem() {} },
        TV_LOGIN_CONFIG: { passwordHash: '0'.repeat(64), passwordSalt: 'fixture', storageKey: 'fixture' },
        ChannelList, StreamPerformance, PlayerLayout, PlayerGeometry, queueMicrotask, URL,
        console: { warn: (...args) => warnings.push(args), error() {} }, addEventListener() {}
    });
    context.window = context;
    vm.runInContext(read('login.js'), context);
    vm.runInContext(app.slice(0, coreEnd), context);
    function installHls({ throwOnAttach = false } = {}) {
        context.Hls = class {
            static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
            static isSupported() { return true; }
            constructor(config) { this.config = config; this.events = new Map(); this.destroyCalls = 0; hlsPlayers.push(this); }
            on(event, fn) { this.events.set(event, fn); }
            loadSource(src) { this.src = src; }
            attachMedia(media) { this.media = media; if (throwOnAttach) throw new Error('fixture attach error'); }
            emit(event, data) { this.events.get(event)?.(event, data); }
            destroy() { this.destroyCalls++; }
        };
    }
    function installFlv({ throwOnLoad = false } = {}) {
        context.flvjs = {
            isSupported: () => true, Events: { ERROR: 'error' },
            createPlayer(options) {
                const events = new Map(), player = { options, calls: {}, on: (event, fn) => events.set(event, fn),
                    attachMediaElement(media) { this.media = media; },
                    emitError() { events.get('error')?.(); },
                    load() { if (throwOnLoad) throw new Error('fixture load error'); },
                    play() { this.calls.play = (this.calls.play || 0) + 1; return Promise.resolve(); } };
                for (const method of ['pause', 'unload', 'detachMediaElement', 'destroy']) player[method] = () => { player.calls[method] = (player.calls[method] || 0) + 1; };
                flvPlayers.push(player); return player;
            }
        };
    }
    return { context, pane, head, requests, hlsPlayers, flvPlayers, warnings, installHls, installFlv,
        sync(channels) { context.fixtureChannels = channels; vm.runInContext('syncActivePlayers(fixtureChannels)', context); },
        entry(ch) { context.fixtureChannel = ch; return vm.runInContext('activePlayers.get(ChannelList.channelKey(fixtureChannel))', context); },
        close(ch) { context.fixtureChannel = ch; return vm.runInContext('closePlayer(ChannelList.channelKey(fixtureChannel))', context); },
        run(code) { return vm.runInContext(code, context); },
        settle(index = requests.length - 1, failure = false) { requests[index][failure ? 'onerror' : 'onload'](); },
        resources() { return vm.runInContext('({ hls: currentHLSInstances.length, flv: currentFLVInstances.length })', context); }
    };
}

test('ordinary iframe viewing loads neither playback library', async () => {
    const f = fixture(); f.sync([channel('somebody', 'at')]); await flush();
    assert.equal(f.requests.length, 0);
});

test('concurrent HLS players share one download and a closed player cannot initialize afterwards', async () => {
    const f = fixture(), a = channel('https://media.invalid/a.m3u8'), b = channel('https://media.invalid/b.m3u8');
    f.sync([a, b]); const removed = f.entry(a), retained = f.entry(b); await flush();
    assert.equal(f.requests.length, 1); assert.match(f.requests[0].src, /hls\.js/);
    f.run('toggleAllAudio()'); retained.resource.video.volume = 0.27;
    f.close(a);
    f.installHls(); f.settle(); await flush();
    assert.equal(removed.resource.disposed, true); assert.equal(removed.resource.hls, null);
    assert.equal(f.hlsPlayers.length, 1); assert.equal(f.hlsPlayers[0].media, retained.resource.video);
    assert.equal(retained.resource.video.muted, false); assert.equal(retained.resource.video.volume, 0.27);
    assert.equal(f.hlsPlayers[0].config.capLevelToPlayerSize, true);
    assert.equal(f.hlsPlayers[0].config.maxBufferLength, 15);
    f.hlsPlayers[0].emit('manifest'); assert.equal(retained.resource.video.playCalls, 1);
    f.close(b); f.hlsPlayers[0].emit('manifest');
    assert.equal(retained.resource.video.playCalls, 1, 'a late manifest cannot replay a disposed video');
    assert.equal(f.hlsPlayers[0].destroyCalls, 1); assert.equal(f.resources().hls, 0);
});

for (const invalidScript of [false, true]) {
    test(`HLS ${invalidScript ? 'missing global' : 'network failure'} is local to its player and can retry`, async () => {
        const f = fixture(), a = channel('https://media.invalid/retry.m3u8');
        f.sync([a]); const failed = f.entry(a); await flush();
        f.settle(0, !invalidScript); await flush();
        assert.equal(failed.resource.failed, true); assert.match(failed.resource.element.textContent, /重新選台/);
        assert.equal(f.hlsPlayers.length, 0); assert.equal(f.head.children.length, 0);
        f.sync([a]); await flush(); assert.equal(f.requests.length, 2);
        f.installHls(); f.settle(1); await flush();
        assert.equal(f.hlsPlayers.length, 1); assert.equal(f.entry(a).resource.failed, false);
        f.sync([]); assert.equal(f.hlsPlayers[0].destroyCalls, 1);
    });
}

test('native HLS avoids a download and its one-time JS fallback preserves the same video and audio', async () => {
    const f = fixture({ nativeHls: true }), a = channel('https://media.invalid/native.m3u8');
    f.sync([a]); const entry = f.entry(a), video = entry.resource.video; await flush();
    assert.equal(video.src, a.id); assert.equal(f.requests.length, 0);
    video.volume = 0.31; video.emit('error'); await flush();
    assert.equal(f.requests.length, 1); assert.equal(video.src, undefined);
    f.run('toggleAllAudio()'); f.installHls(); f.settle(); await flush();
    assert.equal(f.hlsPlayers[0].media, video); assert.equal(video.muted, true); assert.equal(video.volume, 0.31);
    assert.equal(entry.resource.failed, false); f.sync([]);
});

test('closing while a dynamic HLS URL is pending avoids even requesting the library', async () => {
    const f = fixture(); let finish;
    f.context.fixtureMetadata = () => new Promise(resolve => { finish = resolve; });
    const entry = f.run(`(() => {
        const video = RENDERERS.hls({ id: 'dynamic' }, { getStreamUrl: fixtureMetadata }, true, 'video');
        document.getElementById('multi-stream-container').appendChild(video);
        return { element: video, resource: playerResources.get(video) };
    })()`);
    await flush(); f.context.fixtureEntry = entry; f.run('disposePlayer(fixtureEntry)');
    finish('https://media.invalid/late.m3u8'); await flush();
    assert.equal(f.requests.length, 0); assert.equal(entry.resource.disposed, true);
});

test('FLV shares its download, ignores a removed player and releases all SDK resources on error/retry', async () => {
    const f = fixture(), a = channel('a', 'vaughn'), b = channel('b', 'vaughn');
    f.sync([a, b]); const removed = f.entry(a), retained = f.entry(b); await flush();
    assert.equal(f.requests.length, 1); assert.match(f.requests[0].src, /flv\.min\.js$/);
    f.run('toggleAllAudio()'); f.close(a); f.installFlv(); f.settle(); await flush();
    assert.equal(f.flvPlayers.length, 1); assert.equal(removed.resource.flv, null);
    assert.equal(f.flvPlayers[0].media, retained.resource.video); assert.equal(retained.resource.video.muted, false);
    f.flvPlayers[0].emitError();
    for (const method of ['pause', 'unload', 'detachMediaElement', 'destroy']) assert.equal(f.flvPlayers[0].calls[method], 1);
    assert.equal(f.resources().flv, 0); assert.equal(retained.resource.failed, true);
    f.sync([b]); await flush(); assert.equal(f.requests.length, 1); assert.equal(f.flvPlayers.length, 2);
    f.sync([]); assert.equal(f.flvPlayers[1].calls.destroy, 1); assert.equal(f.resources().flv, 0);
});

test('failed FLV download can retry after the player is selected again', async () => {
    const f = fixture(), a = channel('retry', 'vaughn');
    f.sync([a]); await flush(); f.settle(0, true); await flush();
    assert.equal(f.entry(a).resource.failed, true);
    f.sync([a]); await flush(); assert.equal(f.requests.length, 2);
    f.installFlv(); f.settle(1); await flush(); assert.equal(f.flvPlayers.length, 1); f.sync([]);
});

for (const type of ['hls', 'flv']) {
    test(`${type} initialization failure releases a partly created SDK before retry`, async () => {
        const f = fixture(), a = channel(type, type === 'hls' ? 'm3u8' : 'vaughn');
        if (type === 'hls') f.installHls({ throwOnAttach: true }); else f.installFlv({ throwOnLoad: true });
        f.sync([a]); await flush(); assert.equal(f.entry(a).resource.failed, true);
        const players = type === 'hls' ? f.hlsPlayers : f.flvPlayers;
        assert.equal(type === 'hls' ? players[0].destroyCalls : players[0].calls.destroy, 1);
        assert.equal(f.resources()[type], 0);
        if (type === 'hls') f.installHls(); else f.installFlv();
        f.sync([a]); await flush(); assert.equal(players.length, 2); f.sync([]);
    });
}

test('optional modules share one in-flight request and a successful module never reloads', async () => {
    const f = fixture(), loader = f.context.TVScriptLoader;
    const first = loader.load('./announcements.js', 'module'), second = loader.load('./announcements.js', 'module');
    assert.equal(first, second); assert.equal(f.requests.length, 1);
    f.settle(); await first;
    assert.equal(loader.load('./announcements.js', 'module'), first); assert.equal(f.requests.length, 1);
});
