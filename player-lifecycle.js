/* Own player instances independently of layout and sound policy. */
(function (root) {
    'use strict';

    function create({ render, getResource = () => undefined, dispose = () => {}, prepareReplace = () => true, onError = () => {} } = {}) {
        if (typeof render !== 'function') throw new TypeError('render is required');
        if (typeof prepareReplace !== 'function') throw new TypeError('prepareReplace must be a function');
        const entries = new Map();
        const records = new WeakMap(), resources = new WeakMap(), leases = new WeakMap();
        const revisions = new Map();
        let sequence = 0, clearEpoch = 0, clearing = false;
        const element = entry => entry?.resource ? entry.resource.element : entry?.element;
        const report = error => { try { onError(error); } catch (_) {} };
        const revision = key => { const value = ++sequence; revisions.set(key, value); return value; };
        const validKey = key => typeof key === 'string' && Boolean(key.trim());

        function projectSlot(value, target = element(value.entry)) {
            if (!validKey(value.key) || !target?.dataset) return false;
            try {
                target.dataset.channelKey = value.key;
                target.dataset.channelName = typeof value.entry.channel?.name === 'string' ? value.entry.channel.name : '';
                // The marker identifies lifecycle ownership, not a particular UI.
                target.dataset.umininnPlayerSlot = '1';
                return true;
            } catch (error) { report(error); return false; }
        }
        function syncPresentation(value) {
            const target = element(value.entry);
            value.entry.element = target;
            if (value.entry.resource) value.entry.resource.element = target;
            return projectSlot(value, target);
        }

        function record(entry, key) {
            if (!entry || typeof entry !== 'object') return null;
            let value = records.get(entry);
            if (!value) {
                // The exposed map also supports existing application fixtures.
                // Production instances are registered before ensure returns.
                if (key === undefined) {
                    for (const [candidate, current] of entries) if (current === entry) { key = candidate; break; }
                }
                if (key === undefined || entries.get(key) !== entry) return null;
                value = { key, entry, generation: ++sequence, retired: false };
                records.set(entry, value);
                if (entry.resource && typeof entry.resource === 'object') resources.set(entry.resource, value);
            }
            return value;
        }

        function live(value) {
            return Boolean(value && !value.retired && entries.get(value.key) === value.entry && !value.entry.resource?.disposed);
        }

        function teardown(value) {
            if (!value || value.tornDown) return;
            value.tornDown = true;
            const target = element(value.entry);
            try { dispose(value.entry); } catch (error) { report(error); }
            finally {
                // Provider cleanup is best effort; a throwing SDK must not
                // leave its old iframe/media attached and potentially audible.
                if (target?.isConnected) { try { target.remove?.(); } catch (error) { report(error); } }
            }
        }

        function retire(key, entry) {
            if (entries.get(key) !== entry) return null;
            const value = record(entry, key);
            // Invalidate before provider cleanup: a delayed callback or a
            // synchronous teardown event must not retain the old authority.
            value.retired = true;
            entries.delete(key);
            return value;
        }

        function ensure(key, channel, options = {}) {
            if (clearing || !validKey(key)) return { entry: null, created: false, superseded: true };
            const previous = entries.get(key);
            if (previous && live(record(previous, key)) &&
                (typeof options.reusable !== 'function' || options.reusable(previous))) {
                const value = record(previous, key);
                previous.channel = channel;
                syncPresentation(value);
                if (!live(value)) return { entry: entries.get(key) || null, created: false, superseded: true };
                return { entry: previous, created: false };
            }
            const ticket = revision(key), epoch = clearEpoch;
            if (previous) teardown(retire(key, previous));
            // A cleanup callback can issue a newer selection for this key.
            if (revisions.get(key) !== ticket || epoch !== clearEpoch || clearing)
                return { entry: entries.get(key) || null, created: false, superseded: true };
            const rendered = render(channel, options.muted, options.wrapperClass);
            const resource = getResource(rendered);
            const entry = { channel, element: rendered, resource, muted: options.muted,
                failed: typeof options.failed === 'function' ? Boolean(options.failed(rendered, resource)) : false };
            const value = { key, entry, generation: ticket, retired: false };
            records.set(entry, value);
            if (resource && typeof resource === 'object') resources.set(resource, value);
            if (!syncPresentation(value)) {
                value.retired = true;
                teardown(value);
                return { entry: entries.get(key) || null, created: false, superseded: true };
            }
            if (revisions.get(key) !== ticket || epoch !== clearEpoch || clearing) {
                value.retired = true;
                teardown(value);
                return { entry: entries.get(key) || null, created: false, superseded: true };
            }
            entries.set(key, entry);
            return { entry, created: true };
        }

        function remove(key, expectedEntry) {
            const entry = entries.get(key);
            if (expectedEntry !== undefined && entry !== expectedEntry) return false;
            // Also cancels a synchronous creation whose render callback has
            // removed this key before the candidate can be registered.
            revision(key);
            if (!entry) return false;
            teardown(retire(key, entry));
            return true;
        }

        function clear() {
            if (clearing) return;
            clearing = true;
            clearEpoch++;
            try {
                const retired = [];
                for (const [key, entry] of entries) {
                    revision(key);
                    retired.push(retire(key, entry));
                }
                // Invalidate every entry before the first provider is torn
                // down, and do not permit teardown to resurrect a player.
                for (const value of retired) teardown(value);
            } finally { clearing = false; }
        }

        function lease(entryOrKey) {
            const entry = entries.has(entryOrKey) ? entries.get(entryOrKey) : entryOrKey;
            const value = record(entry);
            if (!live(value)) return null;
            const result = Object.freeze({ key: value.key, generation: value.generation, entry,
                element: element(entry), resource: entry.resource });
            leases.set(result, value);
            return result;
        }

        function isCurrent(entryOrLease) {
            const leased = entryOrLease && leases.get(entryOrLease);
            if (leased) return live(leased) && entryOrLease.element === element(leased.entry) &&
                entryOrLease.resource === leased.entry.resource;
            return live(record(entryOrLease));
        }

        function leaseForResource(resource) {
            const value = resource && resources.get(resource);
            return live(value) && value.entry.resource === resource ? lease(value.entry) : null;
        }

        function replaceElement(current, next) {
            if (!leases.has(current) || !isCurrent(current) || !next || current.element === next ||
                !current.element?.isConnected || typeof current.element.replaceWith !== 'function') return false;
            const value = leases.get(current);
            const entry = value.entry, resource = entry.resource;
            if (!validKey(value.key)) return false;
            let prepared;
            try { prepared = prepareReplace(entry, current, next); }
            catch (error) { report(error); return false; }
            // Preparation is synchronous. A future promise is not evidence that
            // the old media is silent at the moment this DOM swap would occur.
            if (prepared !== true) return false;
            if (!isCurrent(current) || entry.resource !== resource || !current.element.isConnected) return false;
            if (!projectSlot(value, next) || !isCurrent(current)) return false;
            const previousElement = entry.element, previousResourceElement = resource?.element;
            // The public alias and resource presentation must change together.
            // A reentrant callback must never retain authority over the old node.
            entry.element = next;
            if (resource) resource.element = next;
            try { current.element.replaceWith(next); }
            catch (error) {
                if (live(value) && entry.resource === resource && entry.element === next && element(entry) === next) {
                    entry.element = previousElement;
                    if (resource) resource.element = previousResourceElement;
                }
                report(error);
                return false;
            }
            return live(value) && entry.resource === resource && entry.element === next && element(entry) === next;
        }

        return { entries, ensure, remove, clear, element, lease, leaseForResource, isCurrent, replaceElement };
    }

    const api = { create };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PlayerLifecycle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
