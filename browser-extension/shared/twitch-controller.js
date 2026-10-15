/* Manual Twitch controls only. Platform clicks never imply successful playback. */
(function (root) {
    'use strict';
    const PLAY_TARGETS = new Set(['player-play-pause-button', 'player-overlay-play-button']);
    const PLAY_LABEL = /^(?:play|播放)(?:\s*\(\s*(?:k|space(?:bar)?|空白(?:鍵|键)?|空格(?:鍵|键)?)(?:\s*\/\s*(?:k|space(?:bar)?|空白(?:鍵|键)?|空格(?:鍵|键)?))*\s*\))?$/iu;
    const WAIT_MS = 3000;
    const SCAN_MS = 80;
    function isTwitchUrl(value) {
        try {
            const url = new URL(value?.href || value);
            return url.protocol === 'https:' && url.hostname === 'player.twitch.tv' &&
                !url.username && !url.password && (!url.port || url.port === '443');
        } catch (_) { return false; }
    }
    function createTwitchController(options = {}) {
        const doc = options.document || root.document;
        const native = options.mediaController;
        if (!doc || !native || !['getState', 'execute', 'subscribe', 'dispose'].every(key => typeof native[key] === 'function')) {
            throw new TypeError('A document and mediaController are required');
        }
        const view = doc.defaultView || root;
        const location = options.location || doc.location || view.location;
        // No platform DOM handling outside the exact, embedded Twitch origin.
        if (!isTwitchUrl(location) || !view.parent || view.parent === view) return native;
        const clock = options.clock || view;
        const later = (clock.setTimeout || root.setTimeout).bind(clock);
        const clear = (clock.clearTimeout || root.clearTimeout).bind(clock);
        const listeners = new Set();
        let disposed = false;
        let pending = null;
        let scanTimer = null;
        let snapshot = native.getState();
        let lastNotification = '';
        let observedRoots = new Set();
        const MO = view.MutationObserver || root.MutationObserver;
        const observer = typeof MO === 'function' ? new MO(scheduleScan) : null;
        function parentOf(node) { return node.parentElement || node.getRootNode?.().host || null; }
        function attr(node, key) { try { return node.getAttribute?.(key); } catch (_) { return null; } }
        function trueAttr(node, key) { return String(attr(node, key)).trim().toLowerCase() === 'true'; }
        function explicitPlay(button) {
            if (String(button.tagName).toUpperCase() !== 'BUTTON' || !PLAY_TARGETS.has(attr(button, 'data-a-target'))) return false;
            if (button.disabled || button.matches?.(':disabled') || button.isConnected === false || trueAttr(button, 'aria-disabled')) return false;
            const labels = ['aria-label', 'title'].map(key => attr(button, key)).filter(value => typeof value === 'string' && value.trim());
            // Every supplied label must agree. In particular, never click a Pause toggle.
            return labels.length > 0 && labels.every(label => {
                const text = label.normalize('NFKC').trim().replace(/\s+/gu, ' ');
                return PLAY_LABEL.test(text) || attr(button, 'data-a-target') === 'player-overlay-play-button' && text === '遊玩';
            });
        }
        function visible(button) {
            try {
                const rect = button.getBoundingClientRect();
                let left = Number(rect.left) || 0, top = Number(rect.top) || 0;
                let right = left + Number(rect.width), bottom = top + Number(rect.height);
                if (!(right > left && bottom > top)) return false;
                for (let node = button; node; node = parentOf(node)) {
                    if (node.hidden || node.inert || trueAttr(node, 'aria-hidden')) return false;
                    const style = view.getComputedStyle?.(node);
                    if (style && (style.display === 'none' || style.contentVisibility === 'hidden' ||
                        ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0 ||
                        node === button && style.pointerEvents === 'none')) return false;
                    if (node !== button && style) {
                        const bounds = node.getBoundingClientRect();
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
                left = Math.max(left, 0); top = Math.max(top, 0);
                right = Math.min(right, Number(view.innerWidth) || Infinity);
                bottom = Math.min(bottom, Number(view.innerHeight) || Infinity);
                if (!(right > left && bottom > top)) return false;
                // A covered control is not a visible Play target. Unknown hit targets,
                // including shadow retargeting, fail conservatively.
                if (typeof doc.elementFromPoint === 'function') {
                    const hit = doc.elementFromPoint((left + right) / 2, (top + bottom) / 2);
                    if (!hit || hit !== button && !button.contains?.(hit)) return false;
                }
                return true;
            } catch (_) { return false; }
        }
        function playButton() {
            const roots = new Set(), candidates = [];
            function visit(container) {
                if (!container || roots.has(container)) return;
                roots.add(container);
                for (const button of container.querySelectorAll?.('button[data-a-target]') || []) {
                    if (explicitPlay(button) && visible(button)) candidates.push(button);
                }
                for (const node of container.querySelectorAll?.('*') || []) if (node.shadowRoot) visit(node.shadowRoot);
            }
            visit(doc);
            if (!disposed && observer && (roots.size !== observedRoots.size || [...roots].some(item => !observedRoots.has(item)))) {
                observer.disconnect();
                for (const node of roots) observer.observe(node, { childList: true, subtree: true, attributes: true,
                    attributeFilter: ['data-a-target', 'aria-label', 'title', 'disabled', 'aria-disabled', 'aria-hidden', 'inert', 'hidden', 'style', 'class'] });
                observedRoots = roots;
            }
            // Twitch can display the cover Play and toolbar Play simultaneously.
            // Prefer the explicit cover control; use the toolbar only without it.
            const overlays = candidates.filter(button => attr(button, 'data-a-target') === 'player-overlay-play-button');
            if (overlays.length) return overlays.length === 1 ? overlays[0] : null;
            return candidates.length === 1 ? candidates[0] : null;
        }
        function playing(value) {
            const state = value?.state;
            return state?.available === true && state.paused === false && state.ended === false &&
                !state.errorCode && state.playbackStatus === 'playing' && Number(state.readyState) >= 2;
        }
        function decorate(value = snapshot) {
            const supported = !disposed && Boolean(playButton());
            return { ...value,
                message: supported && value.state?.playbackStatus === 'no-media' ? '影片尚未載入，可按恢復播放啟動 Twitch' : value.message,
                state: { ...value.state,
                recoverSupported: !disposed && (value.state?.recoverSupported === true || supported),
                platformRecoverSupported: supported, recovering: !disposed && (Boolean(pending) || value.state?.recovering === true) } };
        }
        function disposedResult() { return { ok: false, code: 'DISPOSED', message: '控制器已關閉', state: { ...snapshot.state, disposed: true, recovering: false, recoverSupported: false, platformRecoverSupported: false } }; }
        function current() { return disposed ? disposedResult() : decorate(); }
        function notify() {
            const value = current();
            const fingerprint = JSON.stringify(value);
            if (fingerprint === lastNotification) return;
            lastNotification = fingerprint;
            for (const listener of [...listeners]) { try { listener(value); } catch (_) {} }
        }
        function finish(attempt, ok, code, message) {
            if (pending !== attempt) return;
            pending = null;
            if (attempt.timer !== null) clear(attempt.timer);
            attempt.resolve(disposed ? disposedResult() : { ok, code, message, state: decorate().state });
            notify();
        }
        function check(attempt) {
            if (pending !== attempt || attempt.kind !== 'platform' || !attempt.clicked || disposed) return;
            if (playing(snapshot)) finish(attempt, true, 'OK', '已確認播放器開始播放');
        }
        const unsubscribe = native.subscribe(value => {
            if (disposed) return;
            snapshot = value;
            if (pending) check(pending);
            notify();
        });
        function getState() {
            if (!disposed) snapshot = native.getState();
            return current();
        }
        function scheduleScan() {
            if (disposed || scanTimer !== null) return;
            scanTimer = later(() => { scanTimer = null; getState(); notify(); }, SCAN_MS);
        }
        async function execute(command) {
            if (disposed) return disposedResult();
            if (command?.action !== 'recover') {
                const value = await native.execute(command);
                if (disposed) return disposedResult();
                snapshot = value;
                return decorate(value);
            }
            if (pending) return pending.promise;
            snapshot = native.getState();
            if (disposed) return disposedResult();
            if (playing(snapshot)) return { ok: true, code: 'OK', message: '播放器已在播放', state: decorate().state };
            const button = playButton();
            const attempt = { kind: button ? 'platform' : 'native', clicked: false, timer: null };
            attempt.promise = new Promise(resolve => { attempt.resolve = resolve; });
            pending = attempt;
            notify();
            if (disposed || pending !== attempt) return attempt.promise;
            // Revalidate after subscribers run: the Play control may have changed
            // into Pause while the platform was already starting slowly.
            snapshot = native.getState();
            if (disposed || pending !== attempt) return attempt.promise;
            if (playing(snapshot)) { finish(attempt, true, 'OK', '播放器已在播放'); return attempt.promise; }
            if (button && playButton() === button && typeof button.click === 'function') {
                attempt.clicked = true;
                attempt.timer = later(() => {
                    if (pending !== attempt || disposed) return;
                    snapshot = native.getState();
                    if (pending !== attempt) return;
                    if (playing(snapshot)) finish(attempt, true, 'OK', '已確認播放器開始播放');
                    else finish(attempt, false, 'PLAY_TIMEOUT', '已按平台播放，但尚未確認播放；請稍後查看或在播放器內親自按播放');
                }, WAIT_MS);
                try { button.click(); }
                catch (_) { finish(attempt, false, 'CONTROL_FAILED', '未能按下平台播放，請在播放器內親自按播放'); }
                if (pending === attempt && !disposed) { snapshot = native.getState(); check(attempt); notify(); }
            } else {
                // Native play never toggles Pause. No delayed button click or retry
                // follows this fallback, including after its confirmation timeout.
                attempt.kind = 'native';
                let request;
                try { request = native.execute(command); }
                catch (_) { finish(attempt, false, 'CONTROL_FAILED', '未能控制此播放器'); return attempt.promise; }
                Promise.resolve(request).then(value => {
                    if (disposed || pending !== attempt || !value) return;
                    snapshot = value;
                    finish(attempt, value.ok, value.code, value.message);
                }, () => { if (!disposed) finish(attempt, false, 'CONTROL_FAILED', '未能控制此播放器'); });
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
            observer?.disconnect();
            view.removeEventListener?.('resize', scheduleScan);
            doc.removeEventListener?.('scroll', scheduleScan, true);
            unsubscribe();
            native.dispose();
            snapshot = native.getState();
            if (pending) finish(pending, false, 'DISPOSED', '控制器已關閉');
            listeners.clear();
        }
        view.addEventListener?.('resize', scheduleScan);
        doc.addEventListener?.('scroll', scheduleScan, true);
        playButton();
        return { getState, execute, subscribe, dispose };
    }
    const api = { createTwitchController, isTwitchUrl };
    root.UmininnTwitch = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
