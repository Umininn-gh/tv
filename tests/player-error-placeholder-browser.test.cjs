'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Run the complete production app/controller in real media documents. The only
// provider substitute below is the HLS SDK boundary; its fatal callback is the
// callback registered by the production renderer, not a hand-made error DIV.
const harnessFile = path.join(__dirname, 'player-layout-browser.test.cjs');
let harnessSource = fs.readFileSync(harnessFile, 'utf8');
function seam(before, after) {
    assert.equal(harnessSource.split(before).length, 2, 'unique error-placeholder seam: ' + before);
    harnessSource = harnessSource.replace(before, after);
}
seam("const root = path.resolve(__dirname, '..');",
    "const root = process.env.UMININN_ERROR_PLACEHOLDER_ASSET_ROOT || path.resolve(__dirname, '..');");
seam("require('../tools/build-player-userscript.cjs').RELEASE_VERSION",
    "(process.env.UMININN_ERROR_PLACEHOLDER_VERSION || require('../tools/build-player-userscript.cjs').RELEASE_VERSION)");
const harnessRequire = createRequire(harnessFile), harnessModule = { exports: {} };
const harnessTest = Object.assign(() => {}, { before: test.before, after: test.after });
vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + harnessSource + '\n' +
    'module.exports={fixture,optional,primeAudio,actualMouseWindowAction,waitFocusStatus,holdAudioReply,waitHeldAudioReply,releaseAudioReply,wav};\n})',
    { filename: harnessFile })(name => name === 'node:test' ? harnessTest : harnessRequire(name),
    harnessModule, harnessModule.exports, __dirname, harnessFile);
const { fixture, optional, primeAudio, actualMouseWindowAction, waitFocusStatus,
    holdAudioReply, waitHeldAudioReply, releaseAudioReply, wav } = harnessModule.exports;
const enabled = process.env.UMININN_BROWSER_TESTS === '1';

async function setup(t) {
    if (!optional(t)) return null;
    const f = await fixture(t, { width: 1400, height: 850, audioUserscript: true });
    f.keys = await f.page.evaluate(() => fixture.keys);
    await primeAudio(f);
    return f;
}

async function prepareHlsPeers(f, indexes, { destroyThrows = false } = {}) {
    await f.page.evaluate(async ({ indexes, destroyThrows }) => {
        window.errorQaHlsInstances ||= [];
        if (!window.errorQaCanPlayType) {
            window.errorQaCanPlayType = HTMLMediaElement.prototype.canPlayType;
            HTMLMediaElement.prototype.canPlayType = function (type) {
                return type === 'application/vnd.apple.mpegurl' ? '' : errorQaCanPlayType.call(this, type);
            };
        }
        window.Hls = class {
            static Events = { MANIFEST_PARSED: 'model-manifest', ERROR: 'model-error' };
            static isSupported() { return true; }
            constructor() { this.handlers = new Map(); this.destroyCalls = 0; this.destroyThrows = destroyThrows; errorQaHlsInstances.push(this); }
            on(type, callback) { this.handlers.set(type, callback); }
            loadSource(source) { this.modelSource = source; }
            attachMedia(video) {
                this.video = video;
                video.src = '/silent.wav?hls=' + video.id;
                this.handlers.get(Hls.Events.MANIFEST_PARSED)?.();
            }
            emitFatal() { this.handlers.get(Hls.Events.ERROR)?.('model-error', { fatal: true }); }
            destroy() {
                this.destroyCalls++;
                if (this.destroyThrows) throw new Error('Controlled SDK destroy failure');
                this.video.pause(); this.video.removeAttribute('src'); this.video.load();
            }
        };
        for (const index of indexes) {
            const key = fixture.keys[index], entry = activePlayers.get(key);
            playerRegistry.remove(key, entry);
        }
        await syncActivePlayers(channels);
        for (const index of indexes) {
            const entry = activePlayers.get(fixture.keys[index]);
            if (!entry) throw new Error('HLS fixture missing replacement ' + JSON.stringify({ index, key: fixture.keys[index], active: [...activePlayers.keys()], channels }));
            const video = entry.resource.video;
            video.id = 'native-' + index;
            video.canPlayType = () => ''; // Force the production HLS SDK branch on every browser.
            video.loop = true;
            instrumentMedia(video);
        }
    }, { indexes, destroyThrows });
    await f.page.waitForFunction(indexes => indexes.every(index => {
        const entry = activePlayers.get(fixture.keys[index]);
        return entry?.resource?.hls && entry.resource.video.readyState >= 2;
    }), indexes);
    await f.page.evaluate(async indexes => {
        for (const index of indexes) {
            const video = activePlayers.get(fixture.keys[index]).resource.video;
            video.muted = true; video.volume = .57; await video.play();
        }
    }, indexes);
}

async function fatal(f, indexes) {
    await f.page.evaluate(indexes => {
        window.errorQaFailed ||= new Map();
        for (const index of indexes) {
            const key = fixture.keys[index], entry = activePlayers.get(key), resource = entry.resource;
            errorQaFailed.set(key, { entry, resource, video: resource.video, hls: resource.hls });
            resource.hls.emitFatal();
        }
    }, indexes);
    await f.page.waitForFunction(indexes => indexes.every(index => {
        const entry = activePlayers.get(fixture.keys[index]);
        return entry.resource.failed && entry.resource.errorShown && entry.resource.element.tagName === 'DIV';
    }), indexes);
}

async function mediaStates(f) {
    const main = await f.page.evaluate(() => [...document.getElementById('multi-stream-container').children].flatMap(tile => {
        const media = tile.matches('video,audio') ? [tile] : [...tile.querySelectorAll('video,audio')];
        return media.map(video => ({ key: tile.getAttribute('data-channel-key'), id: video.id,
            muted: video.muted, volume: video.volume, paused: video.paused }));
    }));
    const foreign = await Promise.all(f.frames.map((frame, index) => frame.evaluate(key =>
        [...document.querySelectorAll('video,audio')].map(video => ({ key, id: video.id,
            muted: video.muted, volume: video.volume, paused: video.paused })), f.keys[index + 2])));
    return [...main, ...foreign.flat()];
}

async function waitSingleSound(f, key, timeout = 8000) {
    const deadline = Date.now() + timeout;
    let states;
    do {
        states = await mediaStates(f);
        if (states.some(state => state.key === key && state.muted === false && state.volume === 1) &&
            states.every(state => state.key === key || state.muted === true)) return states;
        await f.page.waitForTimeout(50);
    } while (Date.now() < deadline);
    const status = await f.page.locator('#umininn-player-panel-host #audio-focus-status').textContent();
    assert.fail('Error-placeholder focus did not converge: ' + JSON.stringify({ key, states, status }));
}

async function assertStoppedErrors(f, indexes) {
    const states = await f.page.evaluate(indexes => indexes.map(index => {
        const key = fixture.keys[index], failed = errorQaFailed.get(key), tile = failed.resource.element;
        return { key, channel: tile.getAttribute('data-channel-key'), name: tile.getAttribute('data-channel-name'),
            marker: tile.getAttribute('data-umininn-player-placeholder'), slot: tile.getAttribute('data-umininn-player-slot'), connected: tile.isConnected,
            failed: failed.resource.failed, errorShown: failed.resource.errorShown,
            videoConnected: failed.video.isConnected, muted: failed.video.muted, paused: failed.video.paused,
            state: failed.video.readyState, hls: failed.resource.hls, destroyCalls: failed.hls.destroyCalls };
    }), indexes);
    for (const state of states) {
        assert.equal(state.connected, true); assert.equal(state.failed, true); assert.equal(state.errorShown, true);
        assert.equal(state.videoConnected, false); assert.equal(state.muted, true); assert.equal(state.paused, true);
        assert.equal(state.hls, null); assert.equal(state.destroyCalls, 1);
        assert.equal(state.channel, state.key); assert.ok(state.name); assert.equal(state.marker, 'error'); assert.equal(state.slot, '1');
    }
}

async function captureHealthy(f, excluded) {
    const main = await f.page.evaluate(excluded => {
        const blocked = new Set(excluded);
        window.errorQaHealthy = new Map([...activePlayers].filter(([key]) => !blocked.has(key))
            .map(([key, entry]) => [key, { entry, element: getPlayerElement(entry) }]));
        return [...errorQaHealthy].filter(([, saved]) => saved.entry.resource?.video)
            .map(([key, saved]) => ({ key, state: readMedia(fixtureMedia.find(item => item.video === saved.entry.resource.video)) }));
    }, excluded);
    const frames = await Promise.all(f.frames.map(frame => frame.evaluate(() => ({ id: fixtureId, media: fixtureMedia.map(readMedia) }))));
    return { main, frames };
}

async function assertHealthy(f, before) {
    assert.equal(await f.page.evaluate(() => [...errorQaHealthy].every(([key, saved]) =>
        activePlayers.get(key) === saved.entry && getPlayerElement(saved.entry) === saved.element && saved.element.isConnected)), true);
    const current = await f.page.evaluate(() => [...errorQaHealthy].filter(([, saved]) => saved.entry.resource?.video)
        .map(([key, saved]) => ({ key, state: readMedia(fixtureMedia.find(item => item.video === saved.entry.resource.video)) })));
    const continuity = ({ time, muted, volume, ...rest }) => rest;
    assert.deepEqual(current.map(item => ({ key: item.key, state: continuity(item.state) })),
        before.main.map(item => ({ key: item.key, state: continuity(item.state) })));
    for (const [index, frame] of f.frames.entries()) {
        const after = await frame.evaluate(() => ({ id: fixtureId, media: fixtureMedia.map(readMedia) }));
        assert.equal(after.id, before.frames[index].id);
        assert.deepEqual(after.media.map(continuity), before.frames[index].media.map(continuity));
    }
    assert.ok([...f.navigations.values()].every(count => count === 1));
    assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
}

test('error placeholder: two real fatal HLS peers do not silence healthy native or foreign sound controls',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        await prepareHlsPeers(f, [1, 4]);
        const healthy = await captureHealthy(f, [f.keys[1], f.keys[4]]);
        await fatal(f, [1, 4]);
        // The before-fix run reaches the real sound request before checking the
        // newly introduced marker, so its failure proves the audible symptom.
        for (const index of [0, 3, 2]) {
            await actualMouseWindowAction(f, f.keys[index], 'audio-focus');
            await waitSingleSound(f, f.keys[index]); await waitFocusStatus(f, '只開啟');
        }
        await assertStoppedErrors(f, [1, 4]);
        await assertHealthy(f, healthy);
    });

test('error placeholder: a fatal peer appearing during an existing focus request retains the healthy target',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        await prepareHlsPeers(f, [1]); const healthy = await captureHealthy(f, [f.keys[1]]);
        await holdAudioReply(f, { action: 'getState', blockUpdates: true });
        await actualMouseWindowAction(f, f.keys[0], 'audio-focus'); await waitHeldAudioReply(f);
        await fatal(f, [1]);
        await releaseAudioReply(f); await f.page.evaluate(() => { fixtureAudioGate.blockUpdates = false; });
        await waitSingleSound(f, f.keys[0]); await assertStoppedErrors(f, [1]); await assertHealthy(f, healthy);
    });

test('error placeholder: a throwing HLS destroy cannot leave its detached old video audible',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        await prepareHlsPeers(f, [1], { destroyThrows: true });
        await f.page.evaluate(async key => { const video = activePlayers.get(key).resource.video; video.muted = false; video.volume = .67; await video.play(); }, f.keys[1]);
        const healthy = await captureHealthy(f, [f.keys[1]]); await fatal(f, [1]);
        await actualMouseWindowAction(f, f.keys[0], 'audio-focus'); await waitSingleSound(f, f.keys[0]);
        await assertStoppedErrors(f, [1]); await assertHealthy(f, healthy);
    });

test('error placeholder: selecting an error target cannot open its retired media or another tile',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        await prepareHlsPeers(f, [1]); await fatal(f, [1]);
        await actualMouseWindowAction(f, f.keys[0], 'audio-focus'); await waitSingleSound(f, f.keys[0]);
        await actualMouseWindowAction(f, f.keys[1], 'audio-focus'); await waitFocusStatus(f, '未開啟');
        assert.ok((await mediaStates(f)).every(state => state.muted)); await assertStoppedErrors(f, [1]);
    });

test('error placeholder: recreating the same channel discards the empty proof and stale fatal callback',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        await prepareHlsPeers(f, [1]); await fatal(f, [1]);
        await actualMouseWindowAction(f, f.keys[0], 'audio-focus'); await waitSingleSound(f, f.keys[0]);
        await f.page.evaluate(async key => {
            window.errorQaRetired = errorQaFailed.get(key);
            await syncActivePlayers(channels);
            const next = activePlayers.get(key).resource.video;
            next.id = 'native-1-restored'; next.canPlayType = () => ''; next.loop = true; instrumentMedia(next);
        }, f.keys[1]);
        await f.page.waitForFunction(key => activePlayers.get(key).resource.video.readyState >= 2, f.keys[1]);
        await f.page.evaluate(async key => { await activePlayers.get(key).resource.video.play(); }, f.keys[1]);
        await actualMouseWindowAction(f, f.keys[1], 'audio-focus'); await waitSingleSound(f, f.keys[1]);
        await f.page.evaluate(() => errorQaRetired.hls.emitFatal());
        await f.page.waitForTimeout(250); await waitSingleSound(f, f.keys[1]);
        assert.equal(await f.page.evaluate(key => {
            const current = activePlayers.get(key);
            return errorQaRetired.resource.disposed && !errorQaRetired.resource.video.isConnected &&
                current.resource.video.isConnected && current.resource.element === current.resource.video &&
                !current.resource.element.hasAttribute('data-umininn-player-placeholder');
        }, f.keys[1]), true);
        assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
    });

test('error placeholder: an ordinary unknown empty DIV still blocks a guessed sound opening',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        await f.page.evaluate(() => {
            const channel = { platform: 'at', id: 'uncontrolled-empty', name: '未知空格' };
            channels.push(channel); const key = fixture.addPlaceholder(channel), element = activePlayers.get(key).element;
            element.setAttribute('data-channel-key', key); element.setAttribute('data-channel-name', channel.name);
            projectPlayerLayout();
        });
        await actualMouseWindowAction(f, f.keys[0], 'audio-focus'); await waitFocusStatus(f, '未開啟');
        assert.ok((await mediaStates(f)).every(state => state.muted));
    });

test('error placeholder: marked containers still mute hidden audio and reject an inaccessible audible iframe',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        await prepareHlsPeers(f, [1]); await fatal(f, [1]);
        await f.page.evaluate(async key => {
            const audio = document.createElement('audio'); audio.id = 'error-hidden-audio'; audio.hidden = true;
            audio.src = '/silent.wav?error-hidden'; audio.loop = true; audio.volume = .62; audio.muted = false;
            instrumentMedia(audio); activePlayers.get(key).resource.element.appendChild(audio); await audio.play();
        }, f.keys[1]);
        await actualMouseWindowAction(f, f.keys[0], 'audio-focus'); await waitSingleSound(f, f.keys[0]);
        assert.equal(await f.page.locator('#error-hidden-audio').evaluate(audio => audio.muted), true);
        const origin = 'https://error-placeholder-opaque.invalid';
        await f.page.context().route(origin + '/**', route => {
            const url = new URL(route.request().url());
            if (url.pathname === '/silent.wav') return route.fulfill({ contentType: 'audio/wav', body: wav });
            return route.fulfill({ contentType: 'text/html', body: '<!doctype html><audio id="opaque-error-audio" loop src="/silent.wav"></audio>' });
        });
        const navigation = f.page.waitForEvent('framenavigated', { predicate: frame => frame.url() === origin + '/player' });
        await f.page.evaluate(({ key, origin }) => {
            const frame = document.createElement('iframe'); frame.allow = 'autoplay'; frame.src = origin + '/player';
            activePlayers.get(key).resource.element.appendChild(frame);
        }, { key: f.keys[1], origin });
        const opaque = await navigation;
        await opaque.waitForFunction(() => document.getElementById('opaque-error-audio').readyState >= 2);
        await opaque.evaluate(async () => { const audio = document.getElementById('opaque-error-audio'); audio.muted = false; audio.volume = .72; await audio.play(); });
        await actualMouseWindowAction(f, f.keys[0], 'audio-focus'); await waitFocusStatus(f, '未開啟');
        assert.ok((await mediaStates(f)).every(state => state.muted));
        assert.equal(await opaque.evaluate(() => document.getElementById('opaque-error-audio').muted), false,
            'a marker cannot pretend it muted the inaccessible route');
        assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
    });

test('managed player slot: an ordinary loading replacement proves old media silence without error text or marker',
    { skip: !enabled, timeout: 60000 }, async t => {
        const f = await setup(t); if (!f) return;
        await prepareHlsPeers(f, [1]);
        await f.page.evaluate(async key => {
            const video = activePlayers.get(key).resource.video;
            video.muted = false; video.volume = .66; await video.play();
        }, f.keys[1]);
        const healthy = await captureHealthy(f, [f.keys[1]]);
        const replacement = await f.page.evaluate(key => {
            const entry = activePlayers.get(key), previous = entry.resource.video;
            const loading = document.createElement('div'); loading.className = 'video'; loading.textContent = 'Preparing player';
            const replaced = playerRegistry.replaceElement(playerRegistry.lease(entry), loading);
            projectPlayerLayout();
            return { replaced, slot: loading.getAttribute('data-umininn-player-slot'),
                channel: loading.getAttribute('data-channel-key'), name: loading.getAttribute('data-channel-name'),
                errorMarker: loading.getAttribute('data-umininn-player-placeholder'),
                failed: entry.resource.failed, errorShown: Boolean(entry.resource.errorShown),
                oldMuted: previous.muted, oldPaused: previous.paused, oldConnected: previous.isConnected };
        }, f.keys[1]);
        assert.equal(replacement.replaced, true); assert.equal(replacement.slot, '1');
        assert.equal(replacement.channel, f.keys[1]); assert.ok(replacement.name);
        assert.equal(replacement.errorMarker, null); assert.equal(replacement.failed, false); assert.equal(replacement.errorShown, false);
        assert.equal(replacement.oldMuted, true); assert.equal(replacement.oldPaused, true); assert.equal(replacement.oldConnected, false);
        await actualMouseWindowAction(f, f.keys[0], 'audio-focus'); await waitSingleSound(f, f.keys[0]);
        await actualMouseWindowAction(f, f.keys[3], 'audio-focus'); await waitSingleSound(f, f.keys[3]);
        await assertHealthy(f, healthy);
    });
