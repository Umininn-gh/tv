'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migrated = path.join(__dirname, '../player-lifecycle.js');
const { create } = require(fs.existsSync(migrated) ? migrated : path.join(__dirname, '../player-lifecycle.js'));

function fixture(overrides = {}) {
    const calls = [], errors = [], resources = new WeakMap();
    const node = name => ({ name, isConnected: true, removed: 0,
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
