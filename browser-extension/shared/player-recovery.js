/* One bounded pass per request. No polling, reloads, or automatic retry. */
(function (root) {
    'use strict';
    function createRecoveryFlow(options = {}) {
        for (const key of ['getEntries', 'refresh', 'recover', 'isCurrent']) {
            if (typeof options[key] !== 'function') throw new TypeError(`${key} is required`);
        }
        const clock = options.clock || root;
        const later = (clock.setTimeout || root.setTimeout).bind(clock);
        const clear = (clock.clearTimeout || root.clearTimeout).bind(clock);
        const limit = Number.isInteger(options.concurrency) ? Math.max(1, Math.min(4, options.concurrency)) : 4;
        const timeout = Number.isFinite(options.operationTimeoutMs) && options.operationTimeoutMs > 0 ? options.operationTimeoutMs : 6000;
        const slots = new Set(), waiters = new Set();
        let active = null, disposed = false, sequence = 0;
        function freshSummary(reason) {
            return { ok: false, code: 'RUNNING', reason, total: 0, checked: 0, attempted: 0, recovered: 0, waiting: 0, failed: 0,
                skipped: { playing: 0, busy: 0, unsupported: 0, stale: 0, unknown: 0 }, results: [] };
        }
        function summary(pass, code) {
            const value = pass.summary;
            return { ...value, code: code || value.code, ok: (code || value.code) === 'COMPLETE',
                skipped: { ...value.skipped }, results: value.results.map(item => ({ ...item })).sort((a, b) => a.index - b.index) };
        }
        function emit(pass, phase) {
            if (disposed || typeof options.onStatus !== 'function') return;
            if (phase === 'cancelled' ? active !== null && active !== pass : active !== pass) return;
            try { options.onStatus({ ...summary(pass), phase }); } catch (_) {}
        }
        function current(pass, entry, generation) {
            if (disposed || pass.cancelled || pass.finishing || active !== pass) return false;
            try {
                const accepted = options.isCurrent(entry, generation) === true;
                return accepted && !disposed && !pass.cancelled && !pass.finishing && active === pass;
            } catch (_) { return false; }
        }
        function release(slot) {
            if (!slots.delete(slot)) return;
            for (const waiter of [...waiters]) waiter.grant();
        }
        function acquire(pass) {
            if (disposed || pass.cancelled) return Promise.resolve({ kind: 'cancelled' });
            if (slots.size < limit) {
                const slot = {};
                slots.add(slot);
                return Promise.resolve({ kind: 'slot', slot });
            }
            return new Promise(resolve => {
                let done = false, timer = null;
                const waiter = { grant() {
                    if (done || slots.size >= limit) return;
                    if (disposed || pass.cancelled) { finish({ kind: 'cancelled' }); return; }
                    const slot = {}; slots.add(slot); finish({ kind: 'slot', slot });
                } };
                function finish(value) {
                    if (done) return;
                    done = true;
                    if (timer !== null) clear(timer);
                    waiters.delete(waiter);
                    resolve(value);
                }
                waiters.add(waiter);
                timer = later(() => finish({ kind: 'capacity-timeout' }), timeout);
                pass.cancelPromise.then(() => finish({ kind: 'cancelled' }));
            });
        }
        async function operate(pass, entry, generation, kind, callback) {
            const grant = await acquire(pass);
            if (grant.kind !== 'slot') return grant;
            const slot = grant.slot;
            if (!current(pass, entry, generation)) { release(slot); return { kind: pass.cancelled ? 'cancelled' : 'stale' }; }
            if (entry.busy) { release(slot); return { kind: 'busy' }; }
            let timer = null;
            const deadline = new Promise(resolve => { timer = later(() => resolve({ kind: 'timeout' }), timeout); });
            // Keep this slot until the actual callback settles. A timeout or a
            // cancelled run cannot create extra unresolved extension requests.
            let request;
            try {
                if (kind === 'recover') pass.summary.attempted++;
                request = callback(entry, { ...pass.context, generation });
            } catch (_) { request = Promise.reject(new Error('Operation failed')); }
            const completed = Promise.resolve(request).then(value => ({ kind: 'result', value }), () => ({ kind: 'error' }))
                .then(value => { release(slot); return value; });
            emit(pass, 'checking');
            const outcome = await Promise.race([completed, deadline, pass.cancelPromise.then(() => ({ kind: 'cancelled' }))]);
            clear(timer);
            return outcome;
        }
        function record(pass, item, outcome, code) {
            if (disposed || pass.cancelled || active !== pass || item.recorded) return;
            item.recorded = true;
            const result = { index: item.index, id: item.id, outcome, code: typeof code === 'string' ? code : 'UNKNOWN' };
            pass.summary.results.push(result);
            if (Object.hasOwn(pass.summary.skipped, outcome)) pass.summary.skipped[outcome]++;
            else if (['recovered', 'waiting', 'failed'].includes(outcome)) pass.summary[outcome]++;
            emit(pass, 'checking');
        }
        function confirmed(result) {
            const state = result?.state;
            return result?.ok === true && state?.available === true && state.paused === false && state.ended === false &&
                !state.errorCode && state.playbackStatus === 'playing' && Number(state.readyState) >= 2;
        }
        async function checkEntry(pass, item) {
            const entry = item.entry, generation = entry.generation;
            if (!current(pass, entry, generation)) { record(pass, item, 'stale', 'STALE'); return true; }
            if (entry.kind === 'unsupported') { record(pass, item, 'unsupported', 'NOT_SUPPORTED'); return true; }
            if (entry.busy) { record(pass, item, 'busy', 'BUSY'); return true; }
            const fresh = await operate(pass, entry, generation, 'refresh', options.refresh);
            if (disposed || pass.cancelled) return false;
            if (!current(pass, entry, generation)) { record(pass, item, 'stale', 'STALE'); return true; }
            if (fresh.kind === 'stale' || fresh.kind === 'busy') { record(pass, item, fresh.kind, fresh.kind.toUpperCase()); return true; }
            if (fresh.kind !== 'result') {
                record(pass, item, 'failed', fresh.kind === 'timeout' ? 'REFRESH_TIMEOUT' : fresh.kind === 'capacity-timeout' ? 'NO_CAPACITY' : 'REFRESH_FAILED');
                return fresh.kind !== 'timeout' && fresh.kind !== 'capacity-timeout';
            }
            const result = fresh.value, state = result?.state;
            if (!result || typeof result.ok !== 'boolean' || !state || typeof state !== 'object') { record(pass, item, 'unknown', 'UNKNOWN_STATE'); return true; }
            const platform = state.platformRecoverSupported === true && state.recoverSupported === true;
            if (!result.ok && !(String(result.code).toUpperCase() === 'NO_MEDIA' && platform)) { record(pass, item, 'failed', result.code || 'REFRESH_FAILED'); return true; }
            pass.summary.checked++;
            // An unpaused player may be buffering. Recovery must not interrupt it.
            if (state.paused === false || state.playbackStatus === 'playing') { record(pass, item, 'playing', 'ALREADY_PLAYING'); return true; }
            if (entry.busy || state.recovering === true) { record(pass, item, 'busy', 'BUSY'); return true; }
            const capabilities = result.capabilities || state.capabilities || {};
            if (state.recoverSupported !== true || capabilities.recover === false || state.disposed === true || !platform && state.available !== true) {
                record(pass, item, 'unsupported', 'NOT_SUPPORTED'); return true;
            }
            if (!platform && state.paused !== true && state.ended !== true && !['paused', 'ended', 'blocked', 'error'].includes(state.playbackStatus)) {
                record(pass, item, 'unknown', 'UNKNOWN_STATE'); return true;
            }
            // Discovery can reach its deadline, or a ready player can lose its
            // metadata/Play while queued. Use the fresh state before recovery.
            let ready = true;
            if (typeof options.isReady === 'function') {
                try { ready = options.isReady(entry, result) === true; }
                catch (_) { ready = false; }
            }
            if (!ready) {
                record(pass, item, 'unknown', 'NOT_READY'); return true;
            }
            const recovery = await operate(pass, entry, generation, 'recover', options.recover);
            if (disposed || pass.cancelled) return false;
            if (!current(pass, entry, generation)) { record(pass, item, 'stale', 'STALE'); return true; }
            if (recovery.kind === 'stale' || recovery.kind === 'busy') { record(pass, item, recovery.kind, recovery.kind.toUpperCase()); return true; }
            if (recovery.kind === 'timeout') { record(pass, item, 'waiting', 'RECOVER_TIMEOUT'); return false; }
            if (recovery.kind === 'capacity-timeout') { record(pass, item, 'failed', 'NO_CAPACITY'); return false; }
            if (recovery.kind !== 'result') { record(pass, item, 'failed', 'RECOVER_FAILED'); return true; }
            const recovered = recovery.value, playback = recovered?.state;
            if (confirmed(recovered)) record(pass, item, 'recovered', recovered.code || 'OK');
            else if (String(recovered?.code).toUpperCase() === 'PLAY_TIMEOUT' || playback?.playbackStatus === 'waiting' ||
                playback?.recovering === true || playback?.paused === false && !playback?.errorCode) record(pass, item, 'waiting', recovered?.code || 'UNCONFIRMED');
            else record(pass, item, 'failed', recovered?.code || 'RECOVER_FAILED');
            return true;
        }
        function finish(pass, code) {
            if (active !== pass || pass.cancelled || disposed) return;
            pass.finishing = true;
            pass.summary.code = code;
            emit(pass, 'complete');
            if (active !== pass || pass.cancelled || disposed) return;
            active = null;
            pass.resolve(summary(pass));
        }
        function registerEntries(pass) {
            if (disposed || pass.cancelled || active !== pass) return;
            for (const entry of new Set(options.getEntries(pass.context) || [])) {
                if (!entry || typeof entry !== 'object' || pass.items.has(entry)) continue;
                const index = pass.items.size;
                pass.items.set(entry, { entry, index, id: typeof entry.id === 'string' || typeof entry.id === 'number' ? entry.id : index,
                    queued: false, recorded: false });
            }
            pass.summary.total = pass.items.size;
        }
        function completeIfDrained(pass) {
            if (disposed || pass.cancelled || active !== pass || !pass.prepareDone || pass.running) return;
            if (pass.queue.length && pass.stoppedLanes < limit) return;
            // A timed-out lane retains its unresolved global slot. Do not create
            // more requests in that lane merely because discovery adds new rows.
            for (const item of pass.items.values()) if (!item.recorded) {
                record(pass, item, current(pass, item.entry, item.entry.generation) ? 'unknown' : 'stale', 'NOT_CHECKED');
            }
            const value = pass.summary;
            finish(pass, value.failed || value.waiting || value.skipped.busy || value.skipped.unsupported || value.skipped.unknown ? 'PARTIAL' : 'COMPLETE');
        }
        function pump(pass) {
            if (disposed || pass.cancelled || pass.finishing || active !== pass || pass.pumping) return;
            pass.pumping = true;
            try {
                while (!disposed && !pass.cancelled && active === pass && pass.queue.length && pass.running < limit - pass.stoppedLanes) {
                    const item = pass.queue.shift();
                    pass.running++;
                    Promise.resolve(checkEntry(pass, item)).then(keepLane => {
                        pass.running--;
                        if (disposed || pass.cancelled || active !== pass) return;
                        if (!keepLane) pass.stoppedLanes++;
                        pump(pass);
                    }, () => {
                        pass.running--;
                        if (disposed || pass.cancelled || active !== pass) return;
                        record(pass, item, 'failed', 'CHECK_FAILED');
                        pump(pass);
                    });
                }
            } finally { pass.pumping = false; }
            completeIfDrained(pass);
        }
        function enqueueReady(pass, entries) {
            if (disposed || pass.cancelled || pass.finishing || active !== pass || pass.prepareDone || pass.enqueuing) return 0;
            let added = 0;
            pass.enqueuing = true;
            try {
                // Registration is separate from readiness, keeping totals and row
                // indices stable even when ready players arrive in another order.
                const previousTotal = pass.items.size;
                registerEntries(pass);
                for (const entry of new Set(entries || [])) {
                    const item = pass.items.get(entry);
                    if (!item || item.queued || !current(pass, entry, entry.generation)) continue;
                    item.queued = true;
                    pass.queue.push(item);
                    added++;
                }
                if (added || pass.items.size !== previousTotal) emit(pass, 'checking');
                pump(pass);
            } catch (_) { if (!disposed && !pass.cancelled) finish(pass, 'PREPARE_FAILED'); }
            finally { pass.enqueuing = false; }
            return added;
        }
        async function perform(pass) {
            try {
                if (typeof options.prepare === 'function') await options.prepare(pass.context);
                if (disposed || pass.cancelled || active !== pass) return;
                registerEntries(pass);
                pass.prepareDone = true;
                // A final snapshot admits still-unready or newly discovered rows
                // once, while an early-completed row is never played a second time.
                for (const item of pass.items.values()) if (!item.queued) {
                    item.queued = true;
                    pass.queue.push(item);
                }
                emit(pass, 'checking');
                pump(pass);
            } catch (_) { if (!disposed && !pass.cancelled) finish(pass, 'PREPARE_FAILED'); }
        }
        function run(settings = {}) {
            if (active) return active.promise;
            const reason = typeof settings.reason === 'string' ? settings.reason : 'manual';
            if (disposed) return Promise.resolve({ ...freshSummary(reason), code: 'DISPOSED' });
            const pass = { id: ++sequence, cancelled: false, summary: freshSummary(reason), items: new Map(), queue: [],
                prepareDone: false, running: 0, stoppedLanes: 0, pumping: false, enqueuing: false, finishing: false };
            pass.promise = new Promise(resolve => { pass.resolve = resolve; });
            pass.cancelPromise = new Promise(resolve => { pass.cancelResolve = resolve; });
            pass.abort = typeof root.AbortController === 'function' ? new root.AbortController() : null;
            pass.context = { reason, signal: pass.abort?.signal, isCancelled: () => disposed || pass.cancelled || pass.finishing || active !== pass,
                enqueueReady: entries => enqueueReady(pass, entries) };
            active = pass;
            emit(pass, 'preparing');
            if (!disposed && !pass.cancelled && active === pass) void perform(pass);
            return pass.promise;
        }
        function cancel() {
            const pass = active;
            if (!pass) return null;
            pass.cancelled = true;
            pass.summary.code = disposed ? 'DISPOSED' : 'CANCELLED';
            active = null;
            pass.cancelResolve();
            pass.abort?.abort();
            const value = summary(pass);
            pass.resolve(value);
            if (!disposed) emit(pass, 'cancelled');
            return value;
        }
        function dispose() { if (!disposed) { disposed = true; cancel(); } }
        return { run, cancel, dispose, isRunning: () => Boolean(active) };
    }
    const api = { createRecoveryFlow };
    root.UmininnRecovery = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
