/* DOM media controls only. No source changes, automatic play or ad detection. */
(function (root) {
    'use strict';
    const EVENTS = ['volumechange', 'play', 'playing', 'pause', 'ended', 'loadedmetadata', 'canplay', 'waiting', 'stalled', 'emptied', 'error'];
    const SCAN_DELAY = 80;
    const PLAY_TIMEOUT = 3000;
    const GUARD_WINDOW = 2000;
    const GUARD_REPAIR_LIMIT = 8;
    function createMediaController(options = {}) {
        const doc = options.document || root.document;
        if (!doc) throw new TypeError('A document is required');
        const scope = options.scope || doc;
        const view = doc.defaultView || root;
        const clock = options.clock || view;
        const later = (clock.setTimeout || root.setTimeout).bind(clock);
        const clear = (clock.clearTimeout || root.clearTimeout).bind(clock);
        const listeners = new Set();
        const ids = new WeakMap();
        let nextId = 0;
        let audioUserRevision = 0;
        let media = null;
        let disposed = false;
        let scanning = false;
        let applying = false;
        let scanTimer = null;
        let pending = null;
        let playRequest = null;
        let requestedVolume = null;
        let requestedMuted = null;
        let muteGuard = false;
        let guardTimer = null;
        let guardFailure = false;
        let guardMedia = new Set();
        // Own only routes this guard actually silenced. A platform's already
        // muted preload must never acquire permission to become audible.
        const guardOwned = new Map();
        const guardRepairs = new Map();
        const guardBlocked = new Set();
        let blocked = false;
        let waiting = false;
        let lastNotification = '';
        let observedRoots = new Set();
        let observedMedia = new Set();
        const MO = view.MutationObserver || root.MutationObserver;
        const RO = view.ResizeObserver || root.ResizeObserver;
        const mutations = typeof MO === 'function' ? new MO(scheduleScan) : null;
        const sizes = typeof RO === 'function' ? new RO(scheduleScan) : null;

        const read = (node, key, fallback = null) => {
            try { return node && node[key] !== undefined ? node[key] : fallback; } catch (_) { return fallback; }
        };
        const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
        const isMedia = node => node && ['VIDEO', 'AUDIO'].includes(String(node.tagName).toUpperCase());
        function connected(node) { return Boolean(node && read(node, 'isConnected', true)); }
        function parentOf(node) { return node.parentElement || node.getRootNode?.().host || null; }
        function visibleArea(node) {
            if (!connected(node)) return 0;
            try {
                const rect = node.getBoundingClientRect();
                const width = Number(rect.width), height = Number(rect.height);
                if (!(width > 0 && height > 0)) return 0;
                let left = Number(rect.left) || 0, top = Number(rect.top) || 0;
                let right = left + width, bottom = top + height;
                for (let ancestor = node; ancestor; ancestor = parentOf(ancestor)) {
                    if (ancestor.hidden) return 0;
                    const style = view.getComputedStyle?.(ancestor);
                    if (style && (style.display === 'none' || style.contentVisibility === 'hidden' || ['hidden', 'collapse'].includes(style.visibility) || style.opacity === '0')) return 0;
                    if (ancestor !== node && style) {
                        const bounds = ancestor.getBoundingClientRect();
                        if (/^(hidden|clip|auto|scroll)$/.test(style.overflowX || style.overflow || '')) {
                            left = Math.max(left, Number(bounds.left) || 0);
                            right = Math.min(right, (Number(bounds.left) || 0) + Number(bounds.width));
                        }
                        if (/^(hidden|clip|auto|scroll)$/.test(style.overflowY || style.overflow || '')) {
                            top = Math.max(top, Number(bounds.top) || 0);
                            bottom = Math.min(bottom, (Number(bounds.top) || 0) + Number(bounds.height));
                        }
                    }
                }
                const viewportWidth = Number(view.innerWidth) || Number(doc.documentElement?.clientWidth) || Infinity;
                const viewportHeight = Number(view.innerHeight) || Number(doc.documentElement?.clientHeight) || Infinity;
                return Math.max(0, Math.min(right, viewportWidth) - Math.max(left, 0)) *
                    Math.max(0, Math.min(bottom, viewportHeight) - Math.max(top, 0));
            } catch (_) { return 0; }
        }
        function collect() {
            const roots = new Set();
            const found = new Set();
            function visit(container) {
                if (!container || roots.has(container)) return;
                roots.add(container);
                if (isMedia(container)) found.add(container);
                for (const node of container.querySelectorAll?.('video,audio') || []) found.add(node);
                if (container.shadowRoot) visit(container.shadowRoot);
                for (const node of container.querySelectorAll?.('*') || []) if (node.shadowRoot) visit(node.shadowRoot);
            }
            visit(scope);
            return { roots, candidates: [...found] };
        }
        function state() {
            const available = !disposed && connected(media);
            const volume = available ? number(read(media, 'volume')) : null;
            const guarded = muteGuard ? [...guardMedia].filter(connected) : [];
            const muted = muteGuard && guarded.length ? guarded.every(node => read(node, 'muted') === true) :
                available && typeof read(media, 'muted') === 'boolean' ? media.muted : null;
            const paused = available && typeof read(media, 'paused') === 'boolean' ? media.paused : null;
            const ended = available && typeof read(media, 'ended') === 'boolean' ? media.ended : null;
            const readyState = available ? number(read(media, 'readyState')) : null;
            const errorCode = available ? number(read(read(media, 'error'), 'code')) : null;
            const playbackStatus = !available ? 'no-media' : errorCode ? 'error' : blocked ? 'blocked' : ended ? 'ended' :
                waiting || paused === false && readyState < 3 ? 'waiting' : paused ? 'paused' : 'playing';
            return { available, mediaId: available ? ids.get(media) : null, mediaType: available ? String(media.tagName).toLowerCase() : null,
                volume, muted, paused, ended, readyState, playbackStatus, errorCode, recovering: Boolean(pending),
                recoverSupported: available && typeof media.play === 'function', volumeSupported: available && volume !== null,
                muteSupported: (available || guarded.length > 0) && muted !== null, muteGuardActive: !disposed && muteGuard,
                focusRestorePending: !disposed && guardOwned.size > 0, audioUserRevision, disposed };
        }
        function result(ok = true, code = 'OK', message = '') { return { ok, code, message, state: state() }; }
        function currentResult() { return disposed ? result(false, 'DISPOSED', '控制器已關閉') : muteGuard && guardFailure ?
            result(false, 'NOT_APPLIED', '平台沒有保留全部影片的靜音設定，請重新按放大') : connected(media) ? result() : result(false, 'NO_MEDIA', '未找到可見的影片或音訊'); }
        function clearMuteGuard(preserveOwned = false) {
            if (guardTimer !== null) clear(guardTimer);
            guardTimer = null;
            muteGuard = false;
            guardFailure = false;
            guardRepairs.clear();
            guardBlocked.clear();
            for (const node of guardMedia) for (const event of EVENTS) node.removeEventListener(event, onGuardEvent);
            guardMedia.clear();
            if (!preserveOwned) guardOwned.clear();
        }
        function onNativeIntent(event) {
            if (event.isTrusted !== true) return;
            audioUserRevision++;
            clearMuteGuard();
            // A native player interaction supersedes the focus preference,
            // including its carry-over setting for a future media replacement.
            requestedMuted = null;
            requestedVolume = null;
            notify();
        }
        function observeGuard(candidates) {
            for (const node of guardOwned.keys()) if (!connected(node) || !candidates.includes(node)) guardOwned.delete(node);
            if (!muteGuard) return;
            const next = new Set(candidates.filter(connected));
            for (const node of guardMedia) if (!next.has(node)) {
                for (const event of EVENTS) node.removeEventListener(event, onGuardEvent);
                guardRepairs.delete(node);
                guardBlocked.delete(node);
            }
            for (const node of next) if (!guardMedia.has(node)) {
                for (const event of EVENTS) node.addEventListener(event, onGuardEvent);
            }
            guardMedia = next;
        }
        function repairGuard() {
            if (!muteGuard || disposed || applying) return;
            let failed = false;
            applying = true;
            try {
                const time = typeof clock.now === 'number' ? clock.now : Date.now();
                for (const node of guardMedia) {
                    if (!connected(node) || read(node, 'muted') === true) continue;
                    if (guardBlocked.has(node)) { failed = true; continue; }
                    let attempts = guardRepairs.get(node) || [];
                    attempts = attempts.filter(at => time - at < GUARD_WINDOW);
                    // A platform that repeatedly restores sound must not cause
                    // a permanent setter/event loop. A new focus request rearms it.
                    if (attempts.length >= GUARD_REPAIR_LIMIT) { guardBlocked.add(node); failed = true; continue; }
                    attempts.push(time);
                    guardRepairs.set(node, attempts);
                    if (!guardOwned.has(node) && read(node, 'muted') === false) guardOwned.set(node, true);
                    try { node.muted = true; } catch (_) { failed = true; }
                    if (read(node, 'muted') !== true) failed = true;
                }
            } finally { applying = false; }
            guardFailure = failed;
        }
        function onGuardEvent(event) {
            if (!muteGuard || disposed || applying) return;
            if (guardBlocked.has(event.currentTarget)) return;
            // These events cover deferred platform sound restoration, ad/media
            // swaps and a new source without any permanent polling timer.
            if (!['volumechange', 'play', 'playing', 'loadedmetadata', 'canplay', 'emptied'].includes(event.type)) return;
            if (guardTimer !== null) return;
            guardTimer = later(() => {
                guardTimer = null;
                if (!muteGuard || disposed) return;
                scan();
                notify();
            }, SCAN_DELAY);
        }
        function notify() {
            if (scanning || applying) return;
            const value = currentResult();
            const fingerprint = JSON.stringify(value);
            if (fingerprint === lastNotification) return;
            lastNotification = fingerprint;
            for (const listener of [...listeners]) { try { listener(value); } catch (_) {} }
        }
        function stopOwnRequest(attempt) {
            // Cancel only this controller's still-pending manual play request.
            if (attempt.cancelled || !attempt.calledPlay || typeof attempt.media.pause !== 'function') return;
            attempt.cancelled = true;
            try { attempt.media.pause(); } catch (_) {}
        }
        function finish(attempt, ok, code, message, cancelPlay = false) {
            if (pending !== attempt) return;
            pending = null;
            clear(attempt.timer);
            // A deadline limits our confirmation wait, not the user's playback
            // intent. Retain the unresolved native request for later disposal or
            // node replacement, but never pause the current player on timeout.
            if (code !== 'PLAY_TIMEOUT' && playRequest === attempt) playRequest = null;
            if (cancelPlay) stopOwnRequest(attempt);
            const value = result(ok, code, message);
            attempt.resolve(value);
            notify();
        }
        function checkPlaying(attempt) {
            if (pending !== attempt || attempt.media !== media || disposed) return;
            if (read(media, 'paused') === false && !read(media, 'ended') &&
                (attempt.seenPlaying || attempt.fulfilled && Number(read(media, 'readyState', 0)) >= 2)) {
                blocked = false;
                waiting = false;
                finish(attempt, true, 'OK', '已確認播放器開始播放');
            }
        }
        function onMediaEvent(event) {
            if (event.currentTarget && event.currentTarget !== media) return;
            if (event.type === 'playing') { blocked = false; waiting = false; if (pending) pending.seenPlaying = true; }
            if (event.type === 'waiting' || event.type === 'stalled') waiting = true;
            if (['pause', 'ended', 'emptied'].includes(event.type)) waiting = false;
            if (pending) {
                if (event.type === 'error') finish(pending, false, 'PLAY_FAILED', '播放器回報媒體錯誤');
                else if (event.type === 'pause' && pending.calledPlay && read(media, 'paused') === true) finish(pending, false, 'CANCELLED', '播放請求已被暫停');
                else checkPlaying(pending);
            }
            notify();
            if (['loadedmetadata', 'emptied'].includes(event.type)) scheduleScan();
        }
        function bind(next) {
            if (next === media) return;
            const old = media;
            if (old) for (const event of EVENTS) old.removeEventListener(event, onMediaEvent);
            media = next;
            blocked = false;
            waiting = false;
            if (media) {
                if (!ids.has(media)) ids.set(media, ++nextId);
                for (const event of EVENTS) media.addEventListener(event, onMediaEvent);
                applying = true;
                // Carry only explicit user settings to a replacement, never fight volumechange.
                try { if (requestedVolume !== null) media.volume = requestedVolume; } catch (_) {}
                try { if (requestedMuted !== null) media.muted = requestedMuted; } catch (_) {}
                applying = false;
            }
            if (pending) finish(pending, false, 'MEDIA_CHANGED', '播放器已更換，請重新按恢復播放', true);
            if (playRequest && playRequest.media !== media) {
                const stale = playRequest;
                playRequest = null;
                stopOwnRequest(stale);
            }
        }
        function observe(roots, candidates) {
            if (mutations && (roots.size !== observedRoots.size || [...roots].some(item => !observedRoots.has(item)))) {
                mutations.disconnect();
                for (const container of roots) {
                    try { mutations.observe(container, { childList: true, subtree: true, attributes: true,
                        attributeFilter: ['style', 'class', 'hidden', 'width', 'height'] }); } catch (_) {}
                }
                observedRoots = roots;
            }
            if (sizes) {
                for (const item of observedMedia) if (!candidates.includes(item)) sizes.unobserve?.(item);
                for (const item of candidates) if (!observedMedia.has(item)) { try { sizes.observe(item); } catch (_) {} }
                observedMedia = new Set(candidates);
            }
        }
        function scan() {
            if (disposed || scanning) return;
            scanning = true;
            try {
                const { roots, candidates } = collect();
                observe(roots, candidates);
                const ranked = candidates.map(node => ({ node, area: visibleArea(node), video: String(node.tagName).toUpperCase() === 'VIDEO' }))
                    .filter(item => item.area > 0).sort((a, b) => Number(b.video) - Number(a.video) || b.area - a.area || Number(b.node === media) - Number(a.node === media));
                bind(ranked[0]?.node || null);
                observeGuard(candidates);
                repairGuard();
            } finally { scanning = false; }
            notify();
        }
        function scheduleScan() {
            if (disposed || scanTimer !== null) return;
            scanTimer = later(() => { scanTimer = null; scan(); }, SCAN_DELAY);
        }
        function getState() { scan(); return currentResult(); }
        async function execute(command) {
            if (disposed) return currentResult();
            if (!command || !['getState', 'setVolume', 'setMuted', 'recover'].includes(command.action)) return result(false, 'INVALID_ACTION', '不支援此操作');
            if (command.action === 'setVolume' && (typeof command.value !== 'number' || !Number.isFinite(command.value) || command.value < 0 || command.value > 1)) return result(false, 'INVALID_VALUE', '音量必須是 0 至 1 的數字');
            if (command.action === 'setMuted' && typeof command.value !== 'boolean') return result(false, 'INVALID_VALUE', '靜音設定必須是布林值');
            if (command.guard !== undefined && (command.guard !== true || command.action !== 'setMuted' || command.value !== true)) return result(false, 'INVALID_VALUE', '靜音保護只支援全部靜音');
            if ('focus' in command && (command.focus !== true || 'guard' in command ||
                !(command.action === 'setVolume' && command.value === 1 || command.action === 'setMuted' && command.value === false)))
                return result(false, 'INVALID_VALUE', '單台開聲只支援音量 100% 及解除靜音');
            if (command.action === 'setMuted') {
                // Re-arming and the explicit solo action retain ownership of
                // earlier hidden routes; ordinary manual controls revoke it.
                clearMuteGuard(command.guard === true || command.focus === true);
                if (command.guard === true) {
                    muteGuard = true;
                    requestedMuted = null;
                }
            }
            scan();
            if (command.guard === true) {
                // Keep the intent even before a platform creates its media.
                // scan() will apply it to later nodes and hidden audio alike.
                notify();
                return currentResult();
            }
            if (!media || command.action === 'getState') return currentResult();
            if (command.action === 'setVolume' || command.action === 'setMuted') {
                const property = command.action === 'setVolume' ? 'volume' : 'muted';
                if (property === 'volume' && number(read(media, property)) === null || property === 'muted' && typeof read(media, property) !== 'boolean') return result(false, 'NOT_SUPPORTED', '此播放器未提供這項聲音控制');
                const routes = command.focus === true ? [...new Set([media, ...guardOwned.keys()])].filter(connected) : [media];
                let rejected = false, applied = true, primaryWritten = false;
                applying = true;
                try {
                    for (const node of routes) {
                        // Focus may reach a secondary soundtrack even when the
                        // primary video already reported unmuted/100%.
                        try { node[property] = command.value; if (node === media) primaryWritten = true; } catch (_) { rejected = true; }
                        if (property === 'volume' ? number(read(node, property)) === null || Math.abs(Number(read(node, property)) - command.value) >= 0.001 :
                            read(node, property) !== command.value) applied = false;
                    }
                    if (primaryWritten) {
                        if (property === 'volume') requestedVolume = command.value;
                        else requestedMuted = command.value;
                    }
                } finally { applying = false; }
                if (command.focus === true && property === 'muted' && applied && !rejected) guardOwned.clear();
                notify();
                return result(applied && !rejected, rejected ? 'NOT_SUPPORTED' : applied ? 'OK' : 'NOT_APPLIED',
                    rejected ? '播放器拒絕更改聲音設定' : applied ? '' : '平台沒有保留所要求的聲音設定');
            }
            if (typeof media.play !== 'function') return result(false, 'NOT_SUPPORTED', '此播放器不支援恢復播放');
            if (pending) return pending.promise;
            if (read(media, 'paused') === false && !read(media, 'ended') && Number(read(media, 'readyState', 0)) >= 3 && !waiting) return result(true, 'OK', '播放器已在播放');
            blocked = false;
            const attempt = { media, fulfilled: false, seenPlaying: false, calledPlay: false };
            attempt.promise = new Promise(resolve => { attempt.resolve = resolve; });
            pending = attempt;
            playRequest = attempt;
            attempt.timer = later(() => finish(attempt, false, 'PLAY_TIMEOUT', '尚未確認播放，播放器可能仍在等待；請稍後查看或在播放器內按播放'), PLAY_TIMEOUT);
            notify();
            if (disposed || pending !== attempt || media !== attempt.media) return attempt.promise;
            try {
                attempt.calledPlay = true;
                const request = attempt.media.play();
                Promise.resolve(request).then(() => {
                    if (playRequest === attempt) playRequest = null;
                    attempt.fulfilled = true;
                    checkPlaying(attempt);
                }, error => {
                    if (playRequest === attempt) playRequest = null;
                    if (pending !== attempt) return;
                    blocked = error?.name === 'NotAllowedError';
                    finish(attempt, false, blocked ? 'PLAY_BLOCKED' : 'PLAY_FAILED', blocked ? '瀏覽器拒絕播放，請在播放器內親自按播放' : '播放器拒絕恢復播放');
                });
            } catch (error) {
                blocked = error?.name === 'NotAllowedError';
                finish(attempt, false, blocked ? 'PLAY_BLOCKED' : 'PLAY_FAILED', blocked ? '瀏覽器拒絕播放，請在播放器內親自按播放' : '播放器拒絕恢復播放');
            }
            return attempt.promise;
        }
        function subscribe(listener) {
            if (typeof listener !== 'function') return () => {};
            if (!disposed) listeners.add(listener);
            try { listener(getState()); } catch (_) {}
            return () => listeners.delete(listener);
        }
        function dispose() {
            if (disposed) return;
            disposed = true;
            if (scanTimer !== null) clear(scanTimer);
            scanTimer = null;
            mutations?.disconnect();
            sizes?.disconnect();
            clearMuteGuard();
            scope.removeEventListener?.('pointerdown', onNativeIntent, true);
            scope.removeEventListener?.('keydown', onNativeIntent, true);
            view.removeEventListener?.('resize', scheduleScan);
            doc.removeEventListener?.('scroll', scheduleScan, true);
            if (media) for (const event of EVENTS) media.removeEventListener(event, onMediaEvent);
            if (pending) finish(pending, false, 'DISPOSED', '控制器已關閉，播放請求已取消', true);
            if (playRequest) {
                const stale = playRequest;
                playRequest = null;
                stopOwnRequest(stale);
            }
            media = null;
            notify();
            listeners.clear();
        }
        view.addEventListener?.('resize', scheduleScan);
        doc.addEventListener?.('scroll', scheduleScan, true);
        scope.addEventListener?.('pointerdown', onNativeIntent, true);
        scope.addEventListener?.('keydown', onNativeIntent, true);
        scan();
        return { getState, execute, subscribe, dispose };
    }
    const api = { createMediaController };
    root.UmininnMedia = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
