'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const migrated = path.join(__dirname, '../player-lifecycle.js');
const { create } = require(fs.existsSync(migrated) ? migrated : path.join(__dirname, '../player-lifecycle.js'));

function fixture(overrides = {}) {
    const calls = [], errors = [], resources = new WeakMap();
    const node = name => ({ name, dataset: {}, isConnected: true, removed: 0,
        remove() { this.isConnected = false; this.removed++; },
        replaceWith(next) { this.isConnected = false; next.isConnected = true; }
    });
    let registry;
    registry = create({
        render(channel, muted, wrapperClass) {
            calls.push(['render', channel.id, muted, wrapperClass]);
            const value = node(channel.id);
            const resource = { element: value, disposed: false };
            resources.set(value, resource);
            overrides.render?.(channel, registry, value);
            return value;
        },
        getResource: element => resources.get(element),
        prepareReplace: overrides.prepareReplace || (() => true),
        dispose(entry) {
            calls.push(['dispose', entry.channel.id]);
            assert.equal(registry.isCurrent(entry), false, 'ownership is invalid before provider teardown');
            overrides.dispose?.(entry, registry);
            entry.resource.disposed = true;
            registry.element(entry).remove();
        },
        onError: error => errors.push(error)
    });
    const ensure = (id, options) => registry.ensure(id, { id, name: id }, { muted: true, wrapperClass: 'video', ...options });
    return { registry, calls, errors, node, ensure };
}

test('lifecycle retains instance and lease generation through metadata and unrelated layout changes', () => {
    const f = fixture(), first = f.ensure('a'), before = f.registry.lease(first.entry);
    const updated = f.registry.ensure('a', { id: 'a', name: 'renamed' }, { muted: false, wrapperClass: 'larger' });
    assert.equal(updated.entry, first.entry); assert.equal(updated.created, false);
    assert.equal(updated.entry.channel.name, 'renamed');
    assert.equal(updated.entry.muted, true, 'metadata reconciliation does not invent a sound command');
    assert.equal(f.registry.lease('a').generation, before.generation);
    assert.equal(f.registry.isCurrent(before), true);
    assert.deepEqual(f.calls, [['render', 'a', true, 'video']]);
});

test('lifecycle uses explicit caller reuse policy and invalidates old identity before replacing the same key', () => {
    const f = fixture(), first = f.ensure('a').entry, old = f.registry.lease(first);
    const second = f.ensure('a', { reusable: () => false, failed: () => true }).entry;
    assert.notEqual(first, second); assert.equal(second.failed, true);
    assert.equal(f.registry.isCurrent(old), false); assert.equal(f.registry.isCurrent(first), false);
    assert.equal(f.registry.isCurrent(second), true);
    assert.equal(f.registry.leaseForResource(first.resource), null);
    assert.equal(f.registry.leaseForResource(second.resource).entry, second);
    assert.equal(f.registry.remove('a', first), false, 'an old owner cannot remove the replacement');
    assert.equal(f.registry.entries.get('a'), second);
});

test('lifecycle disposal is idempotent and clears remaining players even when a provider throws', () => {
    const f = fixture({ dispose(entry) { if (entry.channel.id === 'a') throw new Error('provider failed'); } });
    const a = f.ensure('a').entry; f.ensure('b');
    f.registry.clear(); f.registry.clear();
    assert.equal(f.registry.entries.size, 0);
    assert.deepEqual(f.calls.filter(call => call[0] === 'dispose'), [['dispose', 'a'], ['dispose', 'b']]);
    assert.equal(f.errors.length, 1);
    assert.equal(f.registry.element(a).isConnected, false, 'a throwing provider cannot leave its player attached');
});

test('lifecycle clear invalidates all leases before cleanup and prevents reentrant resurrection', () => {
    const f = fixture({ dispose(entry, registry) {
        assert.equal(registry.entries.size, 0);
        assert.equal(registry.ensure('new', { id: 'new' }).entry, null);
        registry.clear();
    } });
    const a = f.ensure('a').entry, b = f.ensure('b').entry;
    const leases = [f.registry.lease(a), f.registry.lease(b)];
    f.registry.clear();
    assert.ok(leases.every(value => !f.registry.isCurrent(value)));
    assert.equal(f.registry.entries.size, 0);
    assert.equal(f.calls.filter(call => call[0] === 'render').length, 2);
    assert.equal(f.ensure('c').created, true, 'a later explicit selection may create new players');
});

test('lifecycle newer same-key selection during teardown wins over an older replacement request', () => {
    let replaced = false;
    const f = fixture({ dispose(entry, registry) {
        if (!replaced) { replaced = true; registry.ensure('a', { id: 'newer-a' }, { muted: false }); }
    } });
    const old = f.ensure('a').entry;
    const result = f.ensure('a', { reusable: () => false });
    assert.equal(result.superseded, true); assert.equal(result.created, false);
    assert.equal(result.entry.channel.id, 'newer-a'); assert.equal(result.entry.muted, false);
    assert.equal(f.registry.isCurrent(old), false);
    assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['render', 'a'], ['dispose', 'a'], ['render', 'newer-a']]);
});

test('lifecycle a selection removed during rendering is disposed without being registered', () => {
    const f = fixture({ render(channel, registry) { registry.remove(channel.id); } });
    const result = f.ensure('a');
    assert.equal(result.entry, null); assert.equal(result.superseded, true);
    assert.equal(f.registry.entries.size, 0);
    assert.deepEqual(f.calls.map(call => call[0]), ['render', 'dispose']);
});

test('lifecycle clear during rendering cancels pending candidates even when no entry was registered yet', () => {
    const f = fixture({ render(channel, registry) { registry.clear(); } });
    const result = f.ensure('a');
    assert.equal(result.entry, null); assert.equal(result.superseded, true);
    assert.equal(f.registry.entries.size, 0);
    assert.deepEqual(f.calls.map(call => call[0]), ['render', 'dispose']);
});

test('lifecycle delayed error replacement cannot touch a newer player or a newer element', () => {
    const f = fixture(), first = f.ensure('a').entry, original = f.registry.lease(first);
    const error = f.node('error');
    assert.equal(f.registry.replaceElement(original, error), true);
    assert.equal(f.registry.element(first), error);
    assert.equal(first.element, error, 'the public alias follows the resource presentation');
    assert.equal(first.resource.element, error);
    assert.equal(f.registry.isCurrent(original), false, 'element identity is part of an async lease');
    assert.equal(f.registry.replaceElement(original, f.node('second-error')), false);
    const failedLease = f.registry.lease(first);
    const next = f.ensure('a', { reusable: () => false }).entry;
    assert.equal(f.registry.replaceElement(failedLease, f.node('stale-error')), false);
    assert.equal(f.registry.element(next).name, 'a');
});

test('lifecycle guards detached and disposed async targets without requiring layout or audio data', () => {
    const f = fixture(), entry = f.ensure('a').entry, current = f.registry.lease(entry);
    entry.resource.element.isConnected = false;
    assert.equal(f.registry.replaceElement(current, f.node('error')), false);
    entry.resource.disposed = true;
    assert.equal(f.registry.isCurrent(current), false);
    assert.equal(f.registry.leaseForResource(entry.resource), null);
    f.registry.remove('a');
    assert.equal(f.registry.entries.size, 0);
});

test('lifecycle replacement invalidates the old lease before invoking DOM replacement and recovers from a failed replacement', () => {
    const f = fixture(), entry = f.ensure('a').entry, old = f.registry.lease(entry);
    old.element.replaceWith = () => {
        assert.equal(f.registry.isCurrent(old), false);
        throw new Error('replacement refused');
    };
    assert.equal(f.registry.replaceElement(old, f.node('error')), false);
    assert.equal(f.registry.element(entry), old.element);
    assert.equal(entry.element, old.element, 'a refused DOM replacement rolls back both aliases');
    assert.equal(entry.resource.element, old.element);
    assert.equal(f.registry.isCurrent(old), true, 'an unchanged element remains current after rollback');
    assert.equal(f.errors.length, 1);
});

test('lifecycle can adopt existing keyed entries once and rejects forged or foreign registry leases', () => {
    const f = fixture(), g = fixture(), element = f.node('fixture');
    const entry = { channel: { id: 'fixture' }, element, resource: { element, disposed: false } };
    f.registry.entries.set('fixture', entry);
    const lease = f.registry.lease(entry);
    assert.equal(f.registry.leaseForResource(entry.resource).generation, lease.generation);
    assert.equal(g.registry.isCurrent(lease), false);
    assert.equal(f.registry.isCurrent({ ...lease }), false);
    assert.equal(f.registry.remove('fixture', entry), true);
    assert.equal(f.registry.remove('fixture', entry), false);
    assert.equal(f.registry.isCurrent(lease), false);
});

test('lifecycle public aliases survive a newer element committed during an older replacement callback', () => {
    const f = fixture(), entry = f.ensure('a').entry, original = f.registry.lease(entry);
    const next = f.node('next'), newer = f.node('newer');
    original.element.replaceWith = () => {
        original.element.isConnected = false; next.isConnected = true;
        assert.equal(entry.element, next); assert.equal(entry.resource.element, next);
        assert.equal(f.registry.replaceElement(f.registry.lease(entry), newer), true);
        throw new Error('older callback failed after the newer commit');
    };
    assert.equal(f.registry.replaceElement(original, next), false);
    assert.equal(entry.element, newer); assert.equal(entry.resource.element, newer);
    assert.equal(f.registry.element(entry), newer); assert.equal(f.registry.isCurrent(f.registry.lease(entry)), true);
    assert.equal(f.errors.length, 1);
});

test('lifecycle reentrant same-key owner replacement cannot be overwritten by an older element commit', () => {
    const f = fixture(), previous = f.ensure('a').entry, original = f.registry.lease(previous), next = f.node('error');
    let replacement;
    original.element.replaceWith = () => {
        original.element.isConnected = false; next.isConnected = true;
        replacement = f.registry.ensure('a', { id: 'new-owner' }, { reusable: () => false }).entry;
    };
    assert.equal(f.registry.replaceElement(original, next), false);
    assert.equal(f.registry.entries.get('a'), replacement); assert.equal(f.registry.element(replacement).name, 'new-owner');
    assert.equal(replacement.element, replacement.resource.element);
    assert.equal(f.registry.isCurrent(previous), false); assert.equal(f.registry.isCurrent(replacement), true);
    assert.equal(next.isConnected, false, 'teardown of the retired owner removes its just-inserted error');
});

test('lifecycle entries without a resource also restore their public alias when DOM replacement throws', () => {
    const f = fixture(), node = f.node('legacy'), entry = { element: node, channel: { id: 'legacy' } };
    f.registry.entries.set('legacy', entry);
    const original = f.registry.lease(entry);
    node.replaceWith = () => { assert.notEqual(entry.element, node); throw new Error('refused'); };
    assert.equal(f.registry.replaceElement(original, f.node('error')), false);
    assert.equal(entry.element, node); assert.equal(f.registry.isCurrent(original), true);
});

test('lifecycle centrally projects managed-slot identity on creation, reuse and changed current presentation', () => {
    const f = fixture(), first = f.ensure('a').entry;
    assert.deepEqual(first.element.dataset, { channelKey: 'a', channelName: 'a', umininnPlayerSlot: '1' });
    const presentation = f.node('plain loading'); presentation.dataset.channelKey = 'wrong';
    first.resource.element = presentation;
    const reused = f.registry.ensure('a', { id: 'a', name: '新台名' });
    assert.equal(reused.entry, first); assert.equal(reused.created, false);
    assert.equal(first.element, presentation); assert.equal(first.resource.element, presentation);
    assert.deepEqual(presentation.dataset, { channelKey: 'a', channelName: '新台名', umininnPlayerSlot: '1' });
    assert.equal(f.calls.filter(call => call[0] === 'render').length, 1);
    for (const key of ['', '  ', null, undefined, 7, {}]) assert.equal(f.registry.ensure(key, { id: 'invalid' }).entry, null);
    assert.equal(f.calls.filter(call => call[0] === 'render').length, 1, 'invalid slot keys cannot create a presentation');
});

test('lifecycle prepares an owned replacement before metadata, alias or DOM changes', () => {
    const sequence = []; let f;
    f = fixture({ prepareReplace(entry, current, next) {
        sequence.push('prepare'); assert.equal(f.registry.isCurrent(current), true);
        assert.equal(entry.element, current.element); assert.equal(entry.resource.element, current.element);
        assert.equal(next.dataset.umininnPlayerSlot, undefined); return true;
    } });
    const entry = f.ensure('a').entry, current = f.registry.lease(entry), next = f.node('plain loading');
    current.element.replaceWith = replacement => {
        sequence.push('DOM'); assert.equal(f.registry.isCurrent(current), false);
        assert.equal(entry.element, replacement); assert.equal(entry.resource.element, replacement);
        assert.deepEqual(replacement.dataset, { channelKey: 'a', channelName: 'a', umininnPlayerSlot: '1' });
        current.element.isConnected = false; replacement.isConnected = true;
    };
    assert.equal(f.registry.replaceElement(current, next), true); assert.deepEqual(sequence, ['prepare', 'DOM']);
});

test('lifecycle refuses failed, throwing, absent and asynchronous preparation without swapping or publishing the next slot', () => {
    for (const answer of [false, undefined, null, 0, Promise.resolve(true), 'throw']) {
        const f = fixture({ prepareReplace() { if (answer === 'throw') throw new Error('prepare failed'); return answer; } });
        const entry = f.ensure('a').entry, current = f.registry.lease(entry), next = f.node('loading');
        let swaps = 0; current.element.replaceWith = () => swaps++;
        assert.equal(f.registry.replaceElement(current, next), false);
        assert.equal(swaps, 0); assert.equal(entry.element, current.element); assert.equal(entry.resource.element, current.element);
        assert.equal(next.dataset.umininnPlayerSlot, undefined); assert.equal(f.registry.isCurrent(current), true);
        assert.equal(f.errors.length, answer === 'throw' ? 1 : 0);
    }
});

test('lifecycle rechecks the owner after preparation synchronously selects a newer player', () => {
    let f, newer;
    f = fixture({ prepareReplace() {
        newer = f.registry.ensure('a', { id: 'newer', name: '新選台' }, { reusable: () => false }).entry; return true;
    } });
    const previous = f.ensure('a').entry, current = f.registry.lease(previous), next = f.node('old loading');
    assert.equal(f.registry.replaceElement(current, next), false);
    assert.equal(f.registry.entries.get('a'), newer); assert.equal(f.registry.isCurrent(newer), true);
    assert.equal(newer.element.dataset.channelName, '新選台'); assert.equal(next.dataset.umininnPlayerSlot, undefined);
});

// Run the real application error transition against the real lifecycle, while
// controlling only DOM/media and overlay boundaries. This is not a text-marker
// imitation: the exact production functions must remain uniquely discoverable.
const appPath = [path.join(__dirname, '../site/assets/js/tv-app.js'), path.join(__dirname, '../tv-app.js')].find(fs.existsSync);
const appSource = fs.readFileSync(appPath, 'utf8');
function appFunction(name) {
    const start = appSource.indexOf(`function ${name}(`), end = appSource.indexOf('\n/* ', start);
    assert.ok(start >= 0 && end > start && appSource.indexOf(`function ${name}(`, start + 1) < 0, name + ' production seam');
    return appSource.slice(start, end);
}
function errorAppFixture(options = {}) {
    const calls = [], resources = new WeakMap();
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase(); this.dataset = {}; this.style = {}; this.classes = new Set(); this.isConnected = false;
            this.classList = { contains: token => this.classes.has(token), toggle: (token, enabled) => enabled ? this.classes.add(token) : this.classes.delete(token) };
        }
        remove() { this.isConnected = false; }
        replaceWith(next) { this.isConnected = false; next.isConnected = true; }
    }
    let registry, entry;
    function render(channel) {
        const video = new Element('video'); video.isConnected = true; video.paused = false;
        video.classes.add('video'); video.volume = .47; video.pauseCalls = 0;
        let muted = false;
        Object.defineProperty(video, 'muted', { get() { if (options.throwRead) throw new Error('unreadable mute'); return muted; },
            set(value) { if (options.throwWrite) throw new Error('refused mute'); if (!options.ignoreMute) muted = value; } });
        video.pause = () => {
            video.pauseCalls++; if (options.pauseThrows) throw new Error('refused pause'); video.paused = true;
            options.onPause?.({ registry, entry, video });
        };
        const resource = { video, element: video, failed: false, disposed: false }; resources.set(video, resource);
        return video;
    }
    const context = vm.createContext({ PlayerLifecycle: { create }, playerResources: resources,
        renderChannelElement: render, disposePlayerResource(value) { value.resource.disposed = true; registry.element(value).remove(); },
        document: { createElement: tag => new Element(tag) },
        projectPlayerLayout() { calls.push('layout'); if (options.refreshThrows) throw new Error('layout refresh'); },
        playerNameOverlay: { refresh() { calls.push('names'); } },
        playerWindowControls: { refresh() { calls.push('controls'); } },
        playerPositionEditor: { refresh() { calls.push('position'); } }
    });
    const registryStart = appSource.indexOf('const playerRegistry = PlayerLifecycle.create({');
    const registryEnd = appSource.indexOf('\n});', registryStart) + 4;
    assert.ok(registryStart >= 0 && registryEnd > registryStart);
    assert.equal(appSource.indexOf('const playerRegistry = PlayerLifecycle.create({', registryStart + 1), -1);
    vm.runInContext(appFunction('buildErrorDiv') + '\n' + appFunction('preparePlayerPresentationReplace') + '\n' +
        appSource.slice(registryStart, registryEnd) + '\nglobalThis.fixtureRegistry = playerRegistry;', context);
    registry = context.fixtureRegistry;
    entry = registry.ensure('m3u8|fixture-owner', { id: 'fixture-owner', name: '故障台' }).entry;
    return { registry, entry, resource: entry.resource, calls, context,
        fail(resource = entry.resource) { context.replacePlayerWithError(resource, '⚠️ 無法播放直播，請再試一次'); } };
}

test('owned error replacement retains channel identity, silences old media and updates every public presentation alias', () => {
    const f = errorAppFixture(), oldVideo = f.resource.video;
    const healthy = f.registry.ensure('m3u8|healthy', { id: 'healthy', name: '正常台' }).entry;
    f.fail();
    const error = f.registry.element(f.entry);
    assert.equal(error.tagName, 'DIV'); assert.equal(error.dataset.umininnPlayerPlaceholder, 'error');
    assert.equal(error.dataset.channelKey, 'm3u8|fixture-owner'); assert.equal(error.dataset.channelName, '故障台');
    assert.equal(error.classList.contains('video'), true);
    assert.equal(f.entry.element, error); assert.equal(f.resource.element, error); assert.equal(f.resource.video, oldVideo);
    assert.equal(f.entry.failed, true); assert.equal(f.resource.failed, true); assert.equal(f.resource.errorShown, true);
    assert.equal(oldVideo.isConnected, false); assert.equal(oldVideo.muted, true); assert.equal(oldVideo.paused, true);
    assert.equal(healthy.resource.video.muted, false); assert.equal(healthy.resource.video.paused, false);
    assert.equal(healthy.resource.video.pauseCalls, 0); assert.deepEqual(f.calls, ['layout', 'names', 'controls', 'position']);
    f.fail(); assert.equal(oldVideo.pauseCalls, 1, 'a repeated SDK failure cannot repeat a completed transition');
});

test('owned error replacement never hides media whose requested mute is ignored, refused or unreadable', () => {
    for (const mode of ['ignoreMute', 'throwWrite', 'throwRead']) {
        const f = errorAppFixture({ [mode]: true }), original = f.resource.video;
        assert.doesNotThrow(() => f.fail());
        assert.equal(f.registry.element(f.entry), original, mode); assert.equal(original.isConnected, true, mode);
        assert.equal(f.entry.failed, true); assert.equal(f.resource.failed, true); assert.notEqual(f.resource.errorShown, true);
        assert.equal(original.pauseCalls, 1); assert.deepEqual(f.calls, []);
    }
});

test('owned error replacement can quarantine a verified mute even if pause throws, and UI failures cannot prevent cleanup', () => {
    const f = errorAppFixture({ pauseThrows: true, refreshThrows: true }), original = f.resource.video;
    let providerCleanup = false;
    assert.doesNotThrow(() => { f.fail(); providerCleanup = true; });
    assert.equal(original.muted, true); assert.equal(original.isConnected, false);
    assert.equal(f.resource.errorShown, true); assert.equal(providerCleanup, true);
    assert.deepEqual(f.calls, ['layout', 'names', 'controls', 'position']);
});

test('owned error replacement rechecks ownership after native pause and never replaces a newer same-key player', () => {
    let replacement;
    const f = errorAppFixture({ onPause({ registry }) {
        replacement = registry.ensure('m3u8|fixture-owner', { id: 'newer-owner', name: '新台' }, { reusable: () => false }).entry;
    } });
    f.fail();
    assert.equal(f.registry.entries.get('m3u8|fixture-owner'), replacement);
    assert.equal(replacement.resource.video.muted, false); assert.equal(replacement.resource.video.pauseCalls, 0);
    assert.equal(replacement.failed, false); assert.notEqual(replacement.resource.errorShown, true);
    assert.deepEqual(f.calls, []);
});

test('owned error replacement marks a failed original but does not publish a placeholder after DOM replacement refusal', () => {
    const f = errorAppFixture(), original = f.resource.video;
    original.replaceWith = () => { throw new Error('refused replacement'); };
    f.fail();
    assert.equal(f.entry.element, original); assert.equal(f.resource.element, original); assert.equal(original.isConnected, true);
    assert.equal(original.muted, true); assert.equal(f.entry.failed, true); assert.equal(f.resource.failed, true);
    assert.notEqual(f.resource.errorShown, true); assert.deepEqual(f.calls, []);
});

test('production replacement hook quiesces native media for a generic loading slot without any error marker or error function', () => {
    const f = errorAppFixture(), old = f.resource.video, loading = f.context.document.createElement('div');
    loading.textContent = 'Loading';
    assert.equal(f.registry.replaceElement(f.registry.lease(f.entry), loading), true);
    assert.equal(old.muted, true); assert.equal(old.paused, true); assert.equal(old.isConnected, false);
    assert.deepEqual(loading.dataset, { channelKey: 'm3u8|fixture-owner', channelName: '故障台', umininnPlayerSlot: '1' });
    assert.equal(loading.dataset.umininnPlayerPlaceholder, undefined);
    assert.equal(f.entry.element, loading); assert.equal(f.resource.element, loading);
    assert.equal(f.entry.failed, false); assert.equal(f.resource.failed, false); assert.deepEqual(f.calls, []);
});

test('production generic replacement hook keeps a real native route attached when silence cannot be verified', () => {
    const f = errorAppFixture({ ignoreMute: true }), old = f.resource.video, loading = f.context.document.createElement('div');
    assert.equal(f.registry.replaceElement(f.registry.lease(f.entry), loading), false);
    assert.equal(old.muted, false); assert.equal(old.isConnected, true); assert.equal(f.entry.element, old);
    assert.equal(loading.dataset.umininnPlayerSlot, undefined); assert.equal(f.entry.failed, false);
});

test('production preparation rejects opaque current routes instead of treating their next status UI as silence', () => {
    for (const tag of ['private-player', 'iframe', 'object', 'embed']) {
        const f = errorAppFixture(), opaque = f.context.document.createElement(tag), loading = f.context.document.createElement('div');
        assert.equal(f.registry.replaceElement(f.registry.lease(f.entry), opaque), true);
        const before = f.registry.lease(f.entry);
        assert.equal(f.registry.replaceElement(before, loading), false, tag);
        assert.equal(f.registry.isCurrent(before), true); assert.equal(f.entry.element, opaque);
        assert.equal(loading.dataset.umininnPlayerSlot, undefined);
    }
});

test('production preparation rejects an inventory beyond its shadow traversal limit', () => {
    const f = errorAppFixture(), wrapper = f.context.document.createElement('div'), loading = f.context.document.createElement('div');
    let node = wrapper;
    for (let depth = 0; depth < 16; depth++) { node.shadowRoot = f.context.document.createElement('div'); node = node.shadowRoot; }
    assert.equal(f.registry.replaceElement(f.registry.lease(f.entry), wrapper), true);
    const before = f.registry.lease(f.entry);
    assert.equal(f.registry.replaceElement(before, loading), false);
    assert.equal(f.registry.isCurrent(before), true); assert.equal(f.entry.element, wrapper);
    assert.equal(loading.dataset.umininnPlayerSlot, undefined);
});
