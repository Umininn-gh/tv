/* Preserve each channel's sound across one layout transaction. No source changes. */
(function (root) {
    'use strict';
    const CAPTURE_MS = 2500, RESTORE_MS = 30000, POLL_MS = 1000, LIMIT = 4;
    const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
    const finiteVolume = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
    function sound(state) {
        const value = {};
        if (state && state.muteSupported !== false && typeof state.muted === 'boolean') value.muted = state.muted;
        if (state && state.volumeSupported !== false && finiteVolume(state.volume)) value.volume = state.volume;
        return value;
    }
    function createLayoutAudioFlow(options = {}) {
        for (const name of ['getEntries', 'isCurrent', 'read', 'write']) {
            if (typeof options[name] !== 'function') throw new TypeError(`${name} is required`);
        }
        const clock = options.clock || root;
        const later = (clock.setTimeout || root.setTimeout).bind(clock);
        const clear = (clock.clearTimeout || root.clearTimeout).bind(clock);
        const now = () => typeof clock.now === 'function' ? clock.now() :
            typeof clock.now === 'number' ? clock.now : Date.now();
        let active = null, writeTail = Promise.resolve(), reads = 0;
        const readWaiters = new Set();
        function entries() {
            const result = new Map(), duplicates = new Set();
            let list;
            try { list = options.getEntries() || []; } catch (_) { return result; }
            if (typeof list[Symbol.iterator] !== 'function') return result;
            for (const item of list) {
                if (!item || typeof item.key !== 'string' || !item.key.trim() || duplicates.has(item.key)) continue;
                if (result.has(item.key)) { result.delete(item.key); duplicates.add(item.key); }
                else result.set(item.key, item);
            }
            return result;
        }
        function same(left, right) {
            return Boolean(left && right && left.key === right.key && left.identity === right.identity && left.version === right.version);
        }
        function current(item) {
            try { return options.isCurrent(item) === true && same(item, entries().get(item.key)); }
            catch (_) { return false; }
        }
        function alive(ctx) { return active === ctx && !ctx.cancelled; }
        function live(ctx, stage) { return alive(ctx) && ctx.stage === stage && !stage.stopped; }
        function summary(ctx, code) {
            const records = [...ctx.records.values()];
            const failed = records.filter(item => ['failed', 'stale', 'timeout'].includes(item.status)).length + ctx.captureFailures;
            const pending = records.filter(item => !item.finished).length;
            const value = code || (pending ? 'PENDING' : failed || records.some(item => item.status === 'skipped') ? 'PARTIAL' : 'COMPLETE');
            return { ok: ['PREPARED', 'COMPLETE'].includes(value), code: value, ticket: ctx.ticket,
                total: records.length, captured: records.length, restored: records.filter(item => item.status === 'restored').length,
                pending, failed, skipped: ctx.captureSkipped + records.filter(item => ['removed', 'skipped'].includes(item.status)).length,
                results: records.map(item => ({ key: item.key, status: item.status, reason: item.reason || '' })) };
        }
        function emit(ctx, phase, code) {
            if (!alive(ctx) || typeof options.onStatus !== 'function') return;
            try { options.onStatus({ ...summary(ctx, code), phase }); } catch (_) {}
        }
        function clearPoll(ctx) {
            if (ctx.poll !== null) clear(ctx.poll);
            ctx.poll = null;
        }
        function closeStage(ctx) {
            clearPoll(ctx);
            ctx.stage?.close();
            ctx.stage = null;
        }
        function stop(ctx) {
            if (!ctx || ctx.cancelled) return;
            ctx.cancelled = true;
            closeStage(ctx);
            ctx.resolveCancel({ kind: 'cancelled' });
            ctx.phase = 'cancelled';
        }
        function createStage(ctx, duration, onExpiry) {
            closeStage(ctx);
            let resolve;
            const stage = { stopped: false, expired: false, end: new Promise(done => { resolve = done; }), close() {
                if (stage.stopped) return;
                stage.stopped = true;
                clear(stage.timer);
                resolve({ kind: 'stopped' });
            } };
            stage.timer = later(() => {
                if (stage.stopped) return;
                stage.stopped = true; stage.expired = true;
                resolve({ kind: 'timeout' });
                if (alive(ctx) && ctx.stage === stage) onExpiry?.();
            }, Math.max(0, duration));
            ctx.stage = stage;
            return stage;
        }
        function boundary(ctx, stage, request) {
            if (!live(ctx, stage)) return Promise.resolve({ kind: ctx.cancelled ? 'cancelled' : 'stopped' });
            return Promise.race([Promise.resolve(request), ctx.cancelledPromise, stage.end]);
        }
        function notifyReaders() { for (const wake of [...readWaiters]) wake(); }
        async function read(ctx, stage, item) {
            while (reads >= LIMIT && live(ctx, stage)) {
                let wake;
                const promise = new Promise(done => { wake = () => done({ kind: 'capacity' }); });
                readWaiters.add(wake);
                const result = await boundary(ctx, stage, promise);
                readWaiters.delete(wake);
                if (result.kind !== 'capacity') return result;
            }
            if (!live(ctx, stage)) return { kind: 'stopped' };
            if (!current(item)) return { kind: 'stale' };
            reads++;
            let request;
            try { request = options.read(item); } catch (_) { request = Promise.reject(new Error('Read failed')); }
            const completed = Promise.resolve(request).then(value => ({ kind: 'result', value }), () => ({ kind: 'error' }))
                .then(value => { reads--; notifyReaders(); return value; });
            const outcome = await boundary(ctx, stage, completed);
            if (outcome.kind === 'result' && !current(item)) return { kind: 'stale' };
            return outcome;
        }
        function write(ctx, stage, record, command) {
            // The tail retains an issued operation after logical cancellation.
            // Its successor checks its lease only after that operation settles.
            const completed = writeTail.then(async () => {
                if (!live(ctx, stage)) return { kind: 'stopped' };
                if (!current(record.lease)) return { kind: 'stale' };
                let result;
                try { result = await options.write(record.lease, command); }
                catch (_) { return { kind: 'error' }; }
                if (!live(ctx, stage)) return { kind: 'stopped' };
                if (!current(record.lease)) return { kind: 'stale' };
                return { kind: 'result', value: result };
            });
            writeTail = completed.then(() => {}, () => {});
            return boundary(ctx, stage, completed);
        }
        async function each(items, callback) {
            let cursor = 0;
            await Promise.all(Array.from({ length: Math.min(LIMIT, items.length) }, async () => {
                while (cursor < items.length) await callback(items[cursor++]);
            }));
        }
        function makeRecord(key, desired) {
            return { key, desired: { ...desired }, lease: null, state: null, finished: false, status: 'captured',
                reason: '', failed: false, partial: false, muteSatisfied: false, volumeSatisfied: false };
        }
        function finish(record, status, reason) {
            record.finished = true; record.status = status; record.reason = reason || '';
        }
        async function prepare(ticket) {
            const previous = active, before = entries(), carry = new Map();
            if (previous) for (const record of previous.records.values()) {
                if (before.has(record.key) && !['restored', 'removed', 'stale'].includes(record.status)) {
                    carry.set(record.key, makeRecord(record.key, record.desired));
                }
            }
            stop(previous);
            let resolveCancel;
            const ctx = { ticket, records: carry, cancelled: false, cancelledPromise: new Promise(done => { resolveCancel = done; }),
                resolveCancel, stage: null, poll: null, phase: 'preparing', captureFailures: 0, captureSkipped: 0,
                restoreDeadline: null, initialDone: false, running: false, initialPromise: null };
            active = ctx;
            const stage = createStage(ctx, CAPTURE_MS);
            emit(ctx, 'preparing', 'RUNNING');
            // Reading before an old write ACK would save an intermediate sound
            // setting. The same capture deadline also bounds this drain wait.
            const drained = await boundary(ctx, stage, writeTail.then(() => ({ kind: 'settled' })));
            if (drained.kind === 'settled' && live(ctx, stage)) {
                await each([...before.values()], async item => {
                    if (!live(ctx, stage)) return;
                    const outcome = await read(ctx, stage, item);
                    if (!live(ctx, stage)) return;
                    if (outcome.kind !== 'result') { ctx.captureFailures++; return; }
                    const desired = sound(outcome.value?.state);
                    const record = ctx.records.get(item.key);
                    if (record) {
                        for (const key of ['muted', 'volume']) if (!own(record.desired, key) && own(desired, key)) record.desired[key] = desired[key];
                    } else if (Object.keys(desired).length) ctx.records.set(item.key, makeRecord(item.key, desired));
                    else ctx.captureSkipped++;
                });
            }
            if (!alive(ctx)) return summary(ctx, 'CANCELLED');
            const expired = stage.expired;
            closeStage(ctx);
            ctx.phase = 'prepared';
            const code = expired || drained.kind !== 'settled' || ctx.captureFailures ? 'PARTIAL' : 'PREPARED';
            emit(ctx, 'prepared', code);
            return summary(ctx, code);
        }
        function timeout(ctx) {
            clearPoll(ctx);
            for (const record of ctx.records.values()) if (!record.finished) finish(record, 'timeout', 'deadline');
            ctx.phase = 'timeout';
            emit(ctx, 'timeout', 'TIMEOUT');
        }
        function completed(ctx, stage) {
            if (!live(ctx, stage)) return;
            if ([...ctx.records.values()].some(record => !record.finished)) { emit(ctx, 'waiting', 'PENDING'); return; }
            closeStage(ctx);
            ctx.phase = 'complete';
            emit(ctx, 'complete');
        }
        function leaseRecords(ctx, stage) {
            const found = entries(), batch = [];
            for (const record of ctx.records.values()) {
                if (record.finished) continue;
                const item = found.get(record.key);
                if (!item) { finish(record, 'removed', 'removed'); continue; }
                if (record.lease && !same(record.lease, item)) { finish(record, 'stale', 'lease-changed'); continue; }
                if (item.ready !== true || !current(item)) continue;
                // A loading SDK/frame may change its document before readiness.
                // Bind once, at its first ready version, then never retarget it.
                if (!record.lease) record.lease = { ...item };
                if (live(ctx, stage)) batch.push(record);
            }
            return batch;
        }
        function markOutcome(record, outcome, property, desired) {
            if (outcome.kind === 'stale') { finish(record, 'stale', 'lease-changed'); return false; }
            if (outcome.kind !== 'result') {
                record.failed = true; record.reason = `${property}-unconfirmed`; return false;
            }
            const actual = sound(outcome.value.state);
            record.state = { ...record.state, ...actual };
            if (own(record.desired, 'muted') && own(actual, 'muted')) {
                record.muteSatisfied = actual.muted === record.desired.muted;
                if (record.desired.muted === true && record.muteSatisfied) record.muteWasConfirmed = true;
            }
            if (own(record.desired, 'volume') && own(actual, 'volume')) {
                record.volumeSatisfied = Math.abs(actual.volume - record.desired.volume) < 0.001;
            }
            if (outcome.value?.ok !== true || !own(actual, property) ||
                (property === 'volume' ? Math.abs(actual[property] - desired) >= 0.001 : actual[property] !== desired)) {
                record.failed = true; record.reason = `${property}-unconfirmed`; return false;
            }
            return true;
        }
        function muteBarrier(ctx) {
            const present = entries();
            let pending = false, failed = false;
            for (const record of ctx.records.values()) {
                if (record.desired.muted !== true || record.status === 'removed') continue;
                const item = present.get(record.key);
                if (!item) continue;
                if (!record.muteSatisfied || !record.lease || !same(record.lease, item) || !current(record.lease)) {
                    if (record.finished || record.failed || record.partial) failed = true;
                    else pending = true;
                }
            }
            return { pending, failed, ok: !pending && !failed };
        }
        async function process(ctx, stage, batch) {
            await each(batch, async record => {
                const outcome = await read(ctx, stage, record.lease);
                if (!live(ctx, stage)) return;
                if (outcome.kind !== 'result') { finish(record, outcome.kind === 'stale' ? 'stale' : 'failed', 'read-unconfirmed'); return; }
                record.state = sound(outcome.value?.state);
                record.status = 'restoring';
                record.failed = false; record.partial = false;
                record.muteSatisfied = !own(record.desired, 'muted') || record.state.muted === record.desired.muted;
                record.muteWasConfirmed = record.desired.muted === true && record.muteSatisfied;
                record.volumeSatisfied = !own(record.desired, 'volume') || own(record.state, 'volume') &&
                    Math.abs(record.state.volume - record.desired.volume) < 0.001;
                if (own(record.desired, 'muted') && !own(record.state, 'muted')) { record.partial = true; record.muteSatisfied = false; }
                if (own(record.desired, 'volume') && !own(record.state, 'volume')) record.partial = true;
            });
            if (!live(ctx, stage)) return;
            // Mute the complete ready cohort before raising any volume or
            // issuing an unmute. An unknown/unready peer is never guessed safe.
            await each(batch, async record => {
                if (record.finished || record.desired.muted !== true || record.muteSatisfied || !own(record.state, 'muted')) return;
                const outcome = await write(ctx, stage, record, { action: 'setMuted', value: true });
                if (live(ctx, stage)) record.muteSatisfied = markOutcome(record, outcome, 'muted', true);
            });
            if (!live(ctx, stage)) return;
            await each(batch, async record => {
                if (record.finished || !own(record.desired, 'volume') || record.volumeSatisfied || !own(record.state, 'volume')) return;
                if (record.desired.muted === true && !record.muteSatisfied) {
                    record.partial = true; record.reason ||= 'mute-unconfirmed'; return;
                }
                const outcome = await write(ctx, stage, record, { action: 'setVolume', value: record.desired.volume });
                if (live(ctx, stage)) record.volumeSatisfied = markOutcome(record, outcome, 'volume', record.desired.volume);
            });
            if (!live(ctx, stage)) return;
            // Some platform volume controls also clear their mute setting.
            // Repair that once before considering any requested unmute.
            await each(batch, async record => {
                if (record.finished || record.desired.muted !== true || record.muteSatisfied || !record.muteWasConfirmed) return;
                const outcome = await write(ctx, stage, record, { action: 'setMuted', value: true });
                if (live(ctx, stage)) record.muteSatisfied = markOutcome(record, outcome, 'muted', true);
            });
            if (!live(ctx, stage)) return;
            await each(batch, async record => {
                if (record.finished || record.desired.muted !== false || record.muteSatisfied || !own(record.state, 'muted')) return;
                const barrier = muteBarrier(ctx);
                if (record.failed || !record.volumeSatisfied && own(record.desired, 'volume') || barrier.failed) {
                    record.partial = true; record.reason ||= 'unmute-withheld'; return;
                }
                if (!barrier.ok) { record.status = 'waiting'; return; }
                const outcome = await write(ctx, stage, record, { action: 'setMuted', value: false });
                if (live(ctx, stage)) record.muteSatisfied = markOutcome(record, outcome, 'muted', false);
            });
            if (!live(ctx, stage)) return;
            for (const record of batch) {
                if (record.finished) continue;
                if (record.desired.muted === false && !record.muteSatisfied && record.status === 'waiting') continue;
                if (!record.partial && (!record.muteSatisfied || !record.volumeSatisfied)) {
                    record.failed = true; record.reason ||= 'audio-changed';
                }
                finish(record, record.failed ? 'failed' : record.partial ? 'skipped' : 'restored', record.reason);
            }
        }
        function schedule(ctx, stage) {
            if (!live(ctx, stage) || ctx.poll !== null || ![...ctx.records.values()].some(record => !record.finished)) return;
            if (now() >= ctx.restoreDeadline) { timeout(ctx); closeStage(ctx); return; }
            ctx.poll = later(() => { ctx.poll = null; void pump(ctx, stage); }, Math.min(POLL_MS, ctx.restoreDeadline - now()));
        }
        async function pump(ctx, stage) {
            if (!live(ctx, stage) || ctx.running || !ctx.initialDone) return;
            if (now() >= ctx.restoreDeadline) { timeout(ctx); closeStage(ctx); return; }
            clearPoll(ctx);
            ctx.running = true;
            try { await process(ctx, stage, leaseRecords(ctx, stage)); }
            finally { ctx.running = false; }
            if (!live(ctx, stage)) return;
            completed(ctx, stage);
            schedule(ctx, stage);
        }
        function restore(ticket) {
            const ctx = active;
            if (!ctx || ctx.cancelled || ctx.ticket !== ticket || ctx.phase === 'preparing') return Promise.resolve({ ok: false, code: 'CANCELLED', ticket });
            if (ctx.phase === 'restoring' && !ctx.initialDone) return ctx.initialPromise;
            closeStage(ctx);
            if (ctx.restoreDeadline === null) ctx.restoreDeadline = now() + RESTORE_MS;
            // Reuse after playback recovery checks the original snapshot again;
            // it does not extend the first round's deadline for loading players.
            for (const record of ctx.records.values()) if (!['removed', 'stale'].includes(record.status)) {
                record.finished = false; record.status = 'captured'; record.reason = ''; record.failed = false; record.partial = false;
                record.muteSatisfied = false; record.volumeSatisfied = false;
            }
            ctx.phase = 'restoring'; ctx.initialDone = false; ctx.running = true;
            const remaining = Math.max(CAPTURE_MS, ctx.restoreDeadline - now());
            const stage = createStage(ctx, remaining, () => timeout(ctx));
            emit(ctx, 'restoring', 'RUNNING');
            ctx.initialPromise = (async () => {
                const drained = await boundary(ctx, stage, writeTail.then(() => ({ kind: 'settled' })));
                if (drained.kind === 'settled' && live(ctx, stage)) await process(ctx, stage, leaseRecords(ctx, stage));
                ctx.running = false; ctx.initialDone = true;
                if (!alive(ctx)) return summary(ctx, 'CANCELLED');
                if (stage.expired || ctx.phase === 'timeout') return summary(ctx, 'TIMEOUT');
                if (live(ctx, stage)) {
                    if (now() >= ctx.restoreDeadline && [...ctx.records.values()].some(record => !record.finished)) {
                        timeout(ctx); closeStage(ctx); return summary(ctx, 'TIMEOUT');
                    }
                    completed(ctx, stage);
                    schedule(ctx, stage);
                }
                return summary(ctx, ctx.phase === 'timeout' ? 'TIMEOUT' : undefined);
            })();
            return ctx.initialPromise;
        }
        function cancel() {
            const ctx = active;
            if (!ctx) return null;
            stop(ctx);
            active = null;
            return summary(ctx, 'CANCELLED');
        }
        function notify() {
            const ctx = active;
            // read()/write() may synchronously publish new state and call us.
            // Those notifications cannot recursively restart their own pass.
            if (ctx?.phase === 'restoring' && ctx.initialDone && !ctx.running && ctx.stage && !ctx.stage.stopped) void pump(ctx, ctx.stage);
        }
        return { prepare, restore, notify, cancel, settle: () => writeTail };
    }
    const api = { createLayoutAudioFlow };
    root.UmininnLayoutAudio = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
