/* Coordinates layout commits with the userscript sound owner; never controls media. */
(function (root) {
    'use strict';
    let layoutSequence = 0, focusSequence = 0, captureSequence = 0;
    const ATTR = 'data-umininn-layout-audio-';
    function create(options = {}) {
        const doc = options.document || root.document, win = options.window || root;
        if (!doc || !win) throw new TypeError('document and window are required');
        const paneFor = options.getPane || (() => doc.getElementById('multi-stream-container'));
        const available = options.available || (() => doc.documentElement.hasAttribute('data-umininn-player-userscript') &&
            doc.documentElement.hasAttribute('data-umininn-player-layout-audio-ready'));
        const intentFor = options.getIntent || (() => doc.documentElement.getAttribute('data-umininn-player-audio-intent'));
        const focusCurrent = options.isFocusCurrent || (focus => focus.target?.isConnected && focus.target.parentElement === paneFor());
        const later = (win.setTimeout || root.setTimeout).bind(win), clear = (win.clearTimeout || root.clearTimeout).bind(win);
        const microtask = win.queueMicrotask ? win.queueMicrotask.bind(win) : root.queueMicrotask.bind(root);
        const EventClass = win.Event || root.Event;
        const queue = [], captures = new Set();
        let batch = null, depth = 0, suspended = false, disposed = false, cancelling = false;
        const live = value => !disposed && !suspended && batch === value;
        const owns = value => value.pane?.getAttribute(ATTR + 'ticket') === value.ticket;
        const currentScope = value => !value.pane || value.pane === paneFor() && (!value.handshake || owns(value));
        const emit = (target, type) => target?.dispatchEvent(new EventClass(type, { bubbles: true }));
        function settle(request, value, error) {
            if (request.settled) return;
            request.settled = true;
            if (error) request.reject(error); else request.resolve(value);
        }
        function clearAttributes(value) {
            if (value.pane?.getAttribute(ATTR + 'ticket') !== value.ticket) return;
            for (const suffix of ['ticket', 'ack', 'focus', 'focus-requests']) value.pane.removeAttribute(ATTR + suffix);
            value.pane.removeAttribute('data-umininn-layout-bookmark-audio');
        }
        function finish(value) {
            if (batch !== value) return;
            clear(value.timer);
            clearAttributes(value);
            batch = null;
            for (const result of value.results) settle(result.request, result.value, result.error);
            if (queue.length) microtask(start);
        }
        function commit(value, restore) {
            if (!live(value) || value.phase !== 'prepare') return;
            if (!currentScope(value)) { cancel(); return; }
            clear(value.timer);
            value.phase = 'commit';
            if (restore && !available()) restore = false;
            if (!restore && value.handshake) emit(value.pane, 'umininn-player-layout-abort');
            // Abort handlers and synchronous player callbacks can leave the page.
            if (!live(value)) return;
            if (!currentScope(value)) { cancel(); return; }
            value.requests = queue.splice(0);
            depth++;
            try {
                for (const request of value.requests) {
                    if (!live(value)) break;
                    let result, error;
                    try { result = request.action(); } catch (caught) { error = caught; }
                    if (live(value) && !currentScope(value)) { cancel(); break; }
                    if (live(value)) value.results.push({ request, value: result, error });
                }
            } finally { depth--; }
            if (!live(value)) return;
            value.phase = 'restore';
            if (!restore) { finish(value); return; }
            if (!available()) {
                emit(value.pane, 'umininn-player-layout-abort');
                finish(value);
                return;
            }
            value.pane.setAttribute(ATTR + 'focus-requests', value.results.map(result => result.request.focus?.id).filter(Boolean).join(','));
            for (const result of value.results) {
                const request = result.request;
                if (result.error) continue;
                if (result.value?.applied && request.bookmarkAudio && intentFor() === request.audioIntent) {
                    value.pane.setAttribute('data-umininn-layout-bookmark-audio', JSON.stringify(request.bookmarkAudio));
                    value.pane.removeAttribute(ATTR + 'focus');
                }
                const focus = request.focus;
                if (result.value === true && focus && focus.target?.isConnected && focus.target.parentElement === paneFor() &&
                    intentFor() === focus.intent && focusCurrent(focus)) {
                    value.pane.setAttribute(ATTR + 'focus', focus.id);
                    value.pane.removeAttribute('data-umininn-layout-bookmark-audio');
                }
            }
            value.timer = later(() => {
                if (!live(value)) return;
                if (!currentScope(value)) { cancel(); return; }
                emit(value.pane, 'umininn-player-layout-abort');
                finish(value);
            }, 10000);
            emit(value.pane, 'umininn-player-layout-after');
        }
        function start() {
            if (disposed || suspended || cancelling || batch || !queue.length) return;
            const value = batch = { pane: paneFor(), ticket: String(++layoutSequence), phase: 'prepare', handshake: false, results: [], requests: [] };
            if (!value.pane || !available()) { commit(value, false); return; }
            value.handshake = true;
            value.pane.setAttribute(ATTR + 'ticket', value.ticket);
            for (const suffix of ['focus', 'focus-requests']) value.pane.removeAttribute(ATTR + suffix);
            value.pane.removeAttribute('data-umininn-layout-bookmark-audio');
            value.timer = later(() => commit(value, false), 6500);
            emit(value.pane, 'umininn-player-layout-before');
        }
        function run(action, config = {}) {
            if (typeof action !== 'function') throw new TypeError('action is required');
            if (disposed || suspended || cancelling) return false;
            if (depth || !batch && !queue.length && !available()) return action();
            // A no-op can become meaningful behind a queued move: only skip an idle queue.
            if (!batch && !queue.length && !config.focus && !config.bookmarkAudio &&
                typeof config.requiresLayout === 'function' && !config.requiresLayout()) return action();
            return new Promise((resolve, reject) => {
                queue.push({ action, resolve, reject, settled: false, focus: config.focus,
                    bookmarkAudio: config.bookmarkAudio, audioIntent: config.audioIntent, requiresLayout: config.requiresLayout });
                start();
            });
        }
        function guard(action, requiresLayout) {
            const guarded = function (...args) {
                return run(() => action.apply(this, args), {
                    requiresLayout: typeof requiresLayout === 'function' ? () => requiresLayout(...args) : undefined
                });
            };
            guarded.requiresLayout = requiresLayout;
            return guarded;
        }
        function beginFocus(key, entry, target) {
            if (disposed || suspended || cancelling || !target?.isConnected || target.parentElement !== paneFor() ||
                !doc.documentElement.hasAttribute('data-umininn-player-unified-audio-ready')) return undefined;
            const id = String(++focusSequence);
            target.setAttribute('data-umininn-player-layout-focus-request', id);
            emit(target, 'umininn-player-layout-focus-request');
            if (disposed || suspended) return undefined;
            return { id, key, entry, target, intent: intentFor() };
        }
        function bookmarkIntent() {
            if (disposed || suspended || cancelling) return undefined;
            emit(paneFor(), 'umininn-player-bookmark-audio-intent');
            return intentFor();
        }
        function captureBookmark(keys) {
            if (disposed || suspended || cancelling) return Promise.reject(new Error('頁面已離開，書籤未有儲存。'));
            const request = doc.createElement('span');
            request.hidden = true;
            request.setAttribute('data-umininn-bookmark-audio-request', String(++captureSequence));
            request.setAttribute('data-umininn-bookmark-audio-keys', JSON.stringify(keys));
            return new Promise((resolve, reject) => {
                let timer, settled = false;
                function finish(audio, error) {
                    if (settled) return;
                    settled = true;
                    clear(timer);
                    request.removeEventListener('umininn-player-bookmark-audio-result', done);
                    captures.delete(cancelCapture);
                    request.remove();
                    if (error) reject(new Error(error)); else resolve(audio);
                }
                function done(event) {
                    if (event.target !== request) return;
                    const error = request.getAttribute('data-umininn-bookmark-audio-error');
                    let audio;
                    try { audio = JSON.parse(request.getAttribute('data-umininn-bookmark-audio-result') || 'null'); } catch (_) {}
                    finish(audio, error || (!audio ? '未能確認各台聲音，書籤未有儲存。' : null));
                }
                function cancelCapture() { finish(null, '頁面已離開，書籤未有儲存。'); }
                captures.add(cancelCapture);
                request.addEventListener('umininn-player-bookmark-audio-result', done);
                timer = later(() => finish(null, '讀取聲音逾時，書籤未有儲存；請稍後重試。'), 5500);
                doc.body.appendChild(request);
                emit(request, 'umininn-player-bookmark-audio-capture');
            });
        }
        function cancel() {
            if (cancelling) return;
            cancelling = true;
            try {
                const value = batch;
                batch = null;
                const pending = queue.splice(0);
                if (value) {
                    clear(value.timer);
                    // Invalidate before notifying the userscript: reentrant callbacks
                    // must not commit or acknowledge a transaction being cancelled.
                    if (owns(value)) emit(value.pane, 'umininn-player-layout-abort');
                    clearAttributes(value);
                    pending.push(...value.requests, ...value.results.map(result => result.request));
                }
                for (const request of pending) settle(request, false);
                for (const capture of [...captures]) capture();
            } finally { cancelling = false; }
        }
        function ready(event) {
            const value = batch;
            if (value && owns(value) && event.target === value.pane && value.pane === paneFor() &&
                value.pane.getAttribute(ATTR + 'ack') === value.ticket) commit(value, true);
        }
        function restored(event) {
            const value = batch;
            if (live(value) && value?.phase === 'restore' && owns(value) && event.target === value.pane && value.pane === paneFor() &&
                value.pane.getAttribute(ATTR + 'ack') === value.ticket) finish(value);
        }
        function hide() { suspended = true; cancel(); }
        function show() { if (!disposed) suspended = false; }
        function dispose() {
            if (disposed) return;
            disposed = true;
            cancel();
            doc.removeEventListener('umininn-player-layout-ready', ready);
            doc.removeEventListener('umininn-player-layout-restored', restored);
            win.removeEventListener('pagehide', hide);
            win.removeEventListener('pageshow', show);
        }
        doc.addEventListener('umininn-player-layout-ready', ready);
        doc.addEventListener('umininn-player-layout-restored', restored);
        win.addEventListener('pagehide', hide);
        win.addEventListener('pageshow', show);
        return { run, guard, captureBookmark, beginFocus, bookmarkIntent, cancel, dispose,
            get batch() { return batch ? Object.freeze({ pane: batch.pane, ticket: batch.ticket, phase: batch.phase,
                results: Object.freeze(batch.results.map(result => Object.freeze({ ...result, request: Object.freeze({ ...result.request }) }))) }) : null; },
            get queueLength() { return queue.length; }, get depth() { return depth; },
            get suspended() { return suspended; }, get disposed() { return disposed; } };
    }
    const api = { create };
    root.PlayerAudioBridge = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
