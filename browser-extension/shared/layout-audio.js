/* Preserve each channel's sound across one layout transaction. No source changes. */
(function (root) {
    'use strict';
    const CAPTURE_MS = 2500, RESTORE_MS = 30000, FOCUS_MS = 6000, POLL_MS = 1000, LIMIT = 4;
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
            let unaddressable = 0;
            let list;
            try { list = options.getEntries() || []; } catch (_) { result.ambiguous = 1; return result; }
            if (typeof list[Symbol.iterator] !== 'function') { result.ambiguous = 1; return result; }
            for (const item of list) {
                if (!item || typeof item.key !== 'string' || !item.key.trim()) { unaddressable++; continue; }
                if (duplicates.has(item.key)) continue;
                if (result.has(item.key)) { result.delete(item.key); duplicates.add(item.key); }
                else result.set(item.key, item);
            }
            result.ambiguous = duplicates.size + unaddressable;
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
            const failed = records.filter(item => ['failed', 'stale', 'timeout'].includes(item.status)).length + ctx.captureFailures + (ctx.focusFailure ? 1 : 0);
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
        function write(ctx, stage, record, command, permitted) {
            // The tail retains an issued operation after logical cancellation.
            // Its successor checks its lease only after that operation settles.
            const completed = writeTail.then(async () => {
                if (!live(ctx, stage)) return { kind: 'stopped' };
                if (!current(record.lease)) return { kind: 'stale' };
                if (permitted && !permitted()) return { kind: 'blocked' };
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
            return { key, desired: { ...desired }, snapshot: { ...desired }, lease: null, state: null, finished: false, status: 'captured',
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
                        for (const key of ['muted', 'volume']) if (!own(record.desired, key) && own(desired, key)) {
                            record.desired[key] = desired[key]; record.snapshot[key] = desired[key];
                        }
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
        function focused(ctx, item) {
            return Boolean(item && item.key === ctx.focus.key && item.identity === ctx.focus.identity &&
                (!ctx.focus.element || item.element === ctx.focus.element));
        }
        function focusCohort(ctx) {
            const found = entries(), peers = [];
            let target = null;
            ctx.focusFailure = Boolean(found.ambiguous);
            for (const item of found.values()) {
                let record = ctx.records.get(item.key);
                if (!record) { record = makeRecord(item.key, {}); ctx.records.set(item.key, record); }
                const isTarget = focused(ctx, item);
                record.focusTarget = isTarget;
                // Peers can acquire a new document: muting the current document
                // is safe. Opening the target is bound to its original identity.
                if (!record.lease || !same(record.lease, item)) {
                    record.lease = { ...item }; record.state = null;
                    record.muteSatisfied = false; record.volumeSatisfied = false;
                }
                record.finished = false; record.status = 'waiting'; record.failed = false;
                record.partial = false; record.reason = '';
                record.desired.muted = !isTarget;
                if (isTarget) { record.desired.volume = 1; target = record; }
                else {
                    if (own(record.snapshot, 'volume')) record.desired.volume = record.snapshot.volume;
                    else delete record.desired.volume;
                    peers.push(record);
                }
            }
            for (const record of ctx.records.values()) if (!found.has(record.key)) finish(record, 'removed', 'removed');
            if (!target) ctx.focusFailure = true;
            return { target, peers };
        }
        function focusState(record, state) {
            record.state = { ...sound(state), muteGuardActive: state?.muteGuardActive === true };
            record.muteSatisfied = record.state.muted === record.desired.muted;
            record.volumeSatisfied = !own(record.desired, 'volume') || own(record.state, 'volume') &&
                Math.abs(record.state.volume - record.desired.volume) < 0.001;
        }
        function focusSafe(ctx) {
            const found = entries();
            if (found.ambiguous || !focused(ctx, found.get(ctx.focus.key))) return false;
            for (const item of found.values()) {
                if (focused(ctx, item)) continue;
                const record = ctx.records.get(item.key);
                if (!record || record.failed || !record.lease || !same(record.lease, item) || !current(record.lease) ||
                    record.state?.muted !== true || !record.guardConfirmed) return false;
            }
            return true;
        }
        function hiddenPeer(record, item, result) {
            // NO_MEDIA means no visible primary media. A readable peer may
            // still contain hidden audio that the all-media guard can silence.
            return !record.focusTarget && item.readable === true && result?.code === 'NO_MEDIA' && result.state?.available === false;
        }
        function guardedHiddenPeer(record, item, result) {
            return hiddenPeer(record, item, result) && result.state.muted === true &&
                result.state.muteSupported === true && result.state.muteGuardActive === true;
        }
        async function focusRead(ctx, stage, record) {
            const item = entries().get(record.key);
            if (!item || !same(record.lease, item) || !current(item)) return false;
            if (item.ready !== true && item.readable !== true) { record.state = null; record.guardConfirmed = false; return false; }
            const outcome = await read(ctx, stage, record.lease);
            if (!live(ctx, stage)) return false;
            const hidden = outcome.kind === 'result' && hiddenPeer(record, item, outcome.value);
            if (outcome.kind !== 'result' || !hidden && (outcome.value?.ok !== true || outcome.value?.state?.available === false)) {
                record.failed = true; record.reason = 'read-unconfirmed'; return false;
            }
            focusState(record, outcome.value.state);
            record.guardConfirmed = hidden ? guardedHiddenPeer(record, item, outcome.value) :
                record.state.muted === true && record.state.muteGuardActive;
            if (hidden) return true; // The guarded write below must prove actual silence.
            if (!own(record.state, 'muted')) { record.failed = true; record.reason = 'mute-unsupported'; return false; }
            return true;
        }
        async function focusWrite(ctx, stage, record, command) {
            const opening = record.focusTarget && (command.action === 'setVolume' || command.action === 'setMuted' && command.value === false);
            const outcome = await write(ctx, stage, record, command, opening ? () => focusSafe(ctx) : null);
            if (!live(ctx, stage)) return false;
            const hiddenGuard = command.action === 'setMuted' && command.value === true && command.guard === true &&
                outcome.kind === 'result' && guardedHiddenPeer(record, record.lease, outcome.value);
            if (outcome.kind !== 'result' || outcome.value?.ok !== true && !hiddenGuard) {
                record.failed = true; record.reason = `${command.action}-unconfirmed`; return false;
            }
            focusState(record, outcome.value.state);
            const property = command.action === 'setMuted' ? 'muted' : 'volume';
            if (!own(record.state, property) || (property === 'volume' ?
                Math.abs(record.state[property] - command.value) >= 0.001 : record.state[property] !== command.value)) {
                record.failed = true; record.reason = `${property}-unconfirmed`; return false;
            }
            if (command.action === 'setMuted' && command.value === true && command.guard === true) {
                // A successful mute does not prove the platform accepted its
                // persistent guard. An explicit refusal must keep focus closed.
                record.guardConfirmed = record.state.muteGuardActive === true;
                if (!record.guardConfirmed) {
                    record.failed = true; record.reason = 'mute-guard-unconfirmed'; return false;
                }
            }
            else if (record.state.muted !== true || outcome.value.state?.muteGuardActive === false) record.guardConfirmed = false;
            return true;
        }
        async function guardFocusPeers(ctx, stage, peers) {
            // Queue each ready peer's mute as its own read completes rather
            // than waiting for every other platform's read to respond.
            await each(peers, async record => {
                record.guardConfirmed = false;
                if (!await focusRead(ctx, stage, record) || !live(ctx, stage)) return;
                if (record.state.muted !== true || !record.guardConfirmed) {
                    if (!await focusWrite(ctx, stage, record, { action: 'setMuted', value: true, guard: true })) return;
                }
                if (!live(ctx, stage)) return;
                if (own(record.desired, 'volume') && own(record.state, 'volume') && !record.volumeSatisfied) {
                    if (!await focusWrite(ctx, stage, record, { action: 'setVolume', value: record.desired.volume })) return;
                    // A platform may clear mute while applying its volume.
                    if (record.state.muted !== true || !record.guardConfirmed) {
                        if (!await focusWrite(ctx, stage, record, { action: 'setMuted', value: true, guard: true })) return;
                    }
                }
                if (!record.failed && record.state.muted === true && record.guardConfirmed) {
                    const partial = own(record.desired, 'volume') && !record.volumeSatisfied;
                    finish(record, partial ? 'skipped' : 'restored', partial ? 'volume-unsupported' : '');
                }
            });
        }
        async function closeUnsafeFocus(ctx, stage, target) {
            if (!target || !live(ctx, stage)) return;
            if (target.state?.muted === false && !focusSafe(ctx))
                await focusWrite(ctx, stage, target, { action: 'setMuted', value: true, guard: true });
        }
        async function processFocus(ctx, stage) {
            let { target, peers } = focusCohort(ctx);
            await Promise.all([
                guardFocusPeers(ctx, stage, peers),
                (async () => {
                    if (target && await focusRead(ctx, stage, target)) await closeUnsafeFocus(ctx, stage, target);
                })()
            ]);
            if (!live(ctx, stage)) return;
            if (focusSafe(ctx) && target && !target.failed) {
                // Drain writes already issued by manual/legacy controllers only
                // after peers are muted. This wait is outside our write tail.
                const callback = ctx.beforeOpen || options.beforeOpen;
                if (typeof callback === 'function') {
                    let request;
                    try { request = Promise.resolve(callback()).then(() => ({ kind: 'settled' }), () => ({ kind: 'error' })); }
                    catch (_) { request = Promise.resolve({ kind: 'error' }); }
                    const outcome = await boundary(ctx, stage, request);
                    if (!live(ctx, stage)) return;
                    if (outcome.kind !== 'settled') { target.failed = true; target.reason = 'prior-audio-unconfirmed'; }
                }
                if (!target.failed) {
                    // The drain and volume restoration may publish a new frame
                    // or clear mute. Re-read every current peer before opening.
                    ({ target, peers } = focusCohort(ctx));
                    await guardFocusPeers(ctx, stage, peers);
                    if (!live(ctx, stage)) return;
                    if (target && await focusRead(ctx, stage, target) && focusSafe(ctx)) {
                        if (!target.volumeSatisfied) await focusWrite(ctx, stage, target, { action: 'setVolume', value: 1 });
                        if (live(ctx, stage) && !target.failed && focusSafe(ctx) && target.state?.muted !== false)
                            await focusWrite(ctx, stage, target, { action: 'setMuted', value: false });
                    }
                }
            }
            if (!live(ctx, stage)) return;
            if (target && !target.failed && target.state?.muted === false) {
                // An unmute/volume ACK can be delayed while another platform
                // replaces media or clears mute. Cached pre-open confirmation
                // is insufficient to declare the final cohort safe.
                ({ target, peers } = focusCohort(ctx));
                await guardFocusPeers(ctx, stage, peers);
                if (!live(ctx, stage)) return;
                if (target) await focusRead(ctx, stage, target);
            }
            if (!live(ctx, stage)) return;
            await closeUnsafeFocus(ctx, stage, target);
            if (!live(ctx, stage)) return;
            // A frame can arrive or renew its document during the last target
            // read. It was absent from this pass, so keep a bounded next pass
            // rather than completing with no poll left to discover that peer.
            const drifted = [...entries().values()].some(item => {
                const record = ctx.records.get(item.key);
                return !record?.lease || !same(record.lease, item);
            });
            const pending = drifted || peers.some(record => !record.finished && !record.failed) || target && !target.failed && !target.state;
            for (const record of peers) if (record.failed) finish(record, 'failed', record.reason);
            if (target) {
                if (!target.failed && focusSafe(ctx) && target.state?.muted === false && target.volumeSatisfied) finish(target, 'restored');
                else if (target.failed || !pending || ctx.focusFailure) finish(target, 'failed', target.reason || 'focus-withheld');
                else { target.status = 'waiting'; target.finished = false; }
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
            try { if (ctx.focus) await processFocus(ctx, stage); else await process(ctx, stage, leaseRecords(ctx, stage)); }
            finally { ctx.running = false; }
            if (!live(ctx, stage)) return;
            completed(ctx, stage);
            schedule(ctx, stage);
        }
        function restore(ticket, policy) {
            const ctx = active;
            if (!ctx || ctx.cancelled || ctx.ticket !== ticket || ctx.phase === 'preparing') return Promise.resolve({ ok: false, code: 'CANCELLED', ticket });
            if (ctx.phase === 'restoring' && !ctx.initialDone) return ctx.initialPromise;
            closeStage(ctx);
            if (policy?.focus && (!ctx.focus || ctx.focus.key !== policy.focus.key || ctx.focus.identity !== policy.focus.identity ||
                ctx.focus.element !== policy.focus.element)) {
                ctx.focus = { ...policy.focus };
                ctx.captureFailures = 0;
                ctx.restoreDeadline = null;
            }
            if (typeof policy?.beforeOpen === 'function') ctx.beforeOpen = policy.beforeOpen;
            if (ctx.restoreDeadline === null || ctx.focus && ctx.phase === 'complete') ctx.restoreDeadline = now() + (ctx.focus ? FOCUS_MS : RESTORE_MS);
            // A zero-delay timer does not stop Promise microtasks: without an
            // eager check, a retry after timeout could finish and unmute before
            // its expired stage's timer had a chance to run.
            if (ctx.focus && now() >= ctx.restoreDeadline) {
                timeout(ctx);
                return Promise.resolve(summary(ctx, 'TIMEOUT'));
            }
            if (ctx.focus) focusCohort(ctx);
            // Reuse after playback recovery checks the original snapshot again;
            // it does not extend the first round's deadline for loading players.
            for (const record of ctx.records.values()) if (!['removed', 'stale'].includes(record.status)) {
                record.finished = false; record.status = 'captured'; record.reason = ''; record.failed = false; record.partial = false;
                record.muteSatisfied = false; record.volumeSatisfied = false;
            }
            ctx.phase = 'restoring'; ctx.initialDone = false; ctx.running = true;
            const remaining = Math.max(ctx.focus ? 0 : CAPTURE_MS, ctx.restoreDeadline - now());
            const stage = createStage(ctx, remaining, () => timeout(ctx));
            emit(ctx, 'restoring', 'RUNNING');
            ctx.initialPromise = (async () => {
                const drained = await boundary(ctx, stage, writeTail.then(() => ({ kind: 'settled' })));
                if (drained.kind === 'settled' && live(ctx, stage)) {
                    if (ctx.focus) await processFocus(ctx, stage);
                    else await process(ctx, stage, leaseRecords(ctx, stage));
                }
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
        return { prepare, restore, notify, cancel, settle: () => writeTail, focusSupported: true };
    }
    const api = { createLayoutAudioFlow };
    root.UmininnLayoutAudio = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
