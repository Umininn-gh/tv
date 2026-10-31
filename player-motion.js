/* Visual transitions only: connected media, layout authority and audio stay independent. */
(function (root) {
    'use strict';

    const MOVE_MS = 240, ENTER_MS = 220, LEAVE_MS = 170, READY_TIMEOUT_MS = 15000;
    const EASING = 'cubic-bezier(.2,.8,.2,1)';
    const MAX_GHOSTS = 64, MAX_CANVAS_GHOSTS = 8;
    const LAYERS = '#player-window-controls .player-window-cell[data-player-key], ' +
        '#player-name-overlay .player-name-cell[data-player-key], ' +
        '#player-position-editor .player-position-cell[data-player-key]';

    function create({ pane, getItems, canAnimate = () => true, onSettled = () => {} } = {}) {
        if (!pane || typeof getItems !== 'function') throw new TypeError('pane and getItems are required');
        const document = pane.ownerDocument, view = document?.defaultView || root;
        const wrapper = pane.parentElement;
        const active = new Map(), pending = new Map(), entering = new Map(), ghosts = new Set();
        const entered = new WeakSet(), leaving = new WeakSet(), pointers = new Set();
        let media;
        try { media = view.matchMedia?.('(prefers-reduced-motion: reduce)'); } catch (_) {}
        let destroyed = false, suspended = false, depth = 0, frame = null, before = null;
        let batching = 0, needsSettled = false, ghostLayer = null, canvasGhosts = 0;
        const requestFrame = callback => typeof view.requestAnimationFrame === 'function'
            ? view.requestAnimationFrame(callback) : view.setTimeout(callback, 16);
        const cancelFrame = id => typeof view.cancelAnimationFrame === 'function'
            ? view.cancelAnimationFrame(id) : view.clearTimeout(id);
        const rect = node => {
            try {
                const value = node.getBoundingClientRect();
                const result = { left: value.left, top: value.top, width: value.width, height: value.height };
                return Object.values(result).every(Number.isFinite) && result.width > 0 && result.height > 0 ? result : null;
            } catch (_) { return null; }
        };
        const signature = node => [node.offsetLeft, node.offsetTop, node.offsetWidth, node.offsetHeight,
            node.style?.gridArea || '', node.style?.order || ''].join('|');
        function items() {
            const result = new Map();
            try {
                for (const item of getItems() || [])
                    if (item && typeof item.key === 'string' && item.element?.isConnected &&
                        typeof item.element.getBoundingClientRect === 'function') result.set(item.key, item);
            } catch (_) {}
            return result;
        }
        const current = item => items().get(item.key)?.element === item.element;
        function allowed() {
            if (destroyed || suspended || pointers.size || media?.matches || document?.hidden ||
                document?.fullscreenElement || document?.webkitFullscreenElement || document?.mozFullScreenElement ||
                !pane.isConnected || !rect(pane)) return false;
            try { return canAnimate() !== false; } catch (_) { return false; }
        }
        function companions(key) {
            try { return Array.from(wrapper?.querySelectorAll(LAYERS) || []).filter(node => node.dataset.playerKey === key); }
            catch (_) { return []; }
        }
        function notify() {
            if (!batching && needsSettled && !active.size && !ghosts.size) {
                needsSettled = false;
                if (!destroyed) { try { onSettled(); } catch (_) {} }
            }
        }
        function batch(action) {
            batching++;
            try { return action(); } finally { batching--; notify(); }
        }
        function removeGhost(node) {
            if (!ghosts.delete(node)) return;
            if (node.dataset.playerMotionCanvas === '1') canvasGhosts--;
            node.remove();
            if (!ghosts.size && ghostLayer) { ghostLayer.remove(); ghostLayer = null; }
        }
        function finish(record, cancel = false) {
            if (active.get(record.node) !== record) return;
            active.delete(record.node);
            view.clearTimeout(record.timer);
            // Invalidating the record first makes finish/cancel reentrancy harmless.
            try { record.animation.onfinish = null; record.animation.oncancel = null; record.animation.cancel(); } catch (_) {}
            if (record.node.getAttribute?.('data-player-motion') === record.kind)
                record.node.removeAttribute('data-player-motion');
            if (record.ghost) removeGhost(record.node);
            notify();
        }
        function animate(node, key, owner, frames, kind, duration, ghost = false) {
            if (typeof node.animate !== 'function') { if (ghost) removeGhost(node); return false; }
            const previous = active.get(node);
            if (previous) finish(previous, true);
            let animation;
            try { animation = node.animate(frames, { duration, easing: EASING, fill: 'none' }); }
            catch (_) { if (ghost) removeGhost(node); return false; }
            const record = { node, key, owner, animation, kind, ghost, timer: null };
            active.set(node, record);
            needsSettled = true;
            node.setAttribute('data-player-motion', kind);
            const complete = () => {
                // Temporarily detaching an effect during a synchronous layout
                // transaction can settle an earlier finished promise. Its restored
                // running animation must not be retired by that old notification.
                if (animation.playState === 'finished') finish(record);
            };
            animation.onfinish = complete;
            animation.oncancel = () => finish(record, true);
            if (animation.finished?.then) animation.finished.then(complete, () => {});
            record.timer = view.setTimeout(() => finish(record), duration + 100);
            return true;
        }
        function cancelVisuals() {
            batch(() => {
                if (frame !== null) cancelFrame(frame);
                frame = null;
                before = null;
                entering.clear();
                for (const record of [...active.values()]) finish(record, true);
                for (const ghost of [...ghosts]) removeGhost(ghost);
            });
        }
        function clearPending(value) {
            if (pending.get(value.item.element) !== value) return;
            pending.delete(value.item.element);
            view.clearTimeout(value.timer);
            for (const cleanup of value.cleanup) { try { cleanup(); } catch (_) {} }
        }
        function cancelAll() {
            cancelVisuals();
            for (const value of [...pending.values()]) clearPending(value);
        }
        function refresh() {
            const live = items();
            batch(() => {
                for (const record of [...active.values()]) {
                    if (record.ghost) continue;
                    if (!record.node.isConnected || live.get(record.key)?.element !== record.owner ||
                        (record.node !== record.owner && record.node.dataset.playerKey !== record.key))
                        finish(record, true);
                }
                for (const value of [...pending.values()]) {
                    const item = live.get(value.item.key);
                    if (item?.element !== value.item.element || item.resource?.disposed || item.resource?.failed)
                        clearPending(value);
                }
                for (const [element, item] of entering)
                    if (live.get(item.key)?.element !== element) entering.delete(element);
                if (!allowed()) cancelVisuals();
            });
        }
        function capture() {
            const result = new Map();
            for (const [key, item] of items()) {
                const bounds = rect(item.element);
                if (!bounds) continue;
                const layers = new Map();
                for (const node of companions(key)) {
                    const bounds = rect(node);
                    if (bounds) layers.set(node, bounds);
                }
                result.set(key, { item, bounds, signature: signature(item.element), layers });
            }
            return result;
        }
        function detachEffects(nodes) {
            const result = [];
            for (const record of active.values()) {
                if (record.ghost || !record.animation.effect || (nodes && !nodes.has(record.node))) continue;
                try {
                    const saved = { record, effect: record.animation.effect,
                        time: record.animation.currentTime, state: record.animation.playState };
                    record.animation.effect = null;
                    result.push(saved);
                } catch (_) {}
            }
            return result;
        }
        function restoreEffects(saved) {
            for (const value of saved) {
                const { record } = value;
                if (active.get(record.node) !== record) continue;
                try {
                    record.animation.effect = value.effect;
                    if (value.time !== null) record.animation.currentTime = value.time;
                    if (value.state === 'running') record.animation.play();
                    else if (value.state === 'paused') record.animation.pause();
                } catch (_) { finish(record, true); }
            }
        }
        function layoutRect(element) {
            // Overlay renderers may run during a transition. Their CSS must be
            // based on the committed cell, not this frame's temporary transform.
            const saved = detachEffects(new Set([element]));
            try { return element.getBoundingClientRect(); }
            finally { restoreEffects(saved); }
        }
        function movement(from, to) {
            if (!from || !to) return null;
            const dx = from.left - to.left, dy = from.top - to.top;
            const sx = from.width / to.width, sy = from.height / to.height;
            if (![dx, dy, sx, sy].every(Number.isFinite) || sx <= 0 || sy <= 0 ||
                (Math.abs(dx) < .25 && Math.abs(dy) < .25 && Math.abs(from.width - to.width) < .25 &&
                    Math.abs(from.height - to.height) < .25)) return null;
            return { dx, dy, sx, sy };
        }
        function moveFrames(node, change) {
            let base = 'none';
            try { base = view.getComputedStyle(node).transform || 'none'; } catch (_) {}
            const suffix = base === 'none' ? '' : ' ' + base;
            return [{ transform: `translate(${change.dx}px, ${change.dy}px) scale(${change.sx}, ${change.sy})${suffix}`,
                transformOrigin: '0px 0px' }, { transform: base, transformOrigin: '0px 0px' }];
        }
        function flush() {
            frame = null;
            const first = before;
            before = null;
            refresh();
            if (!allowed()) { entering.clear(); return; }
            const live = items(), targets = [];
            batch(() => {
                // Decide from untransformed layout metrics. An unchanged action
                // leaves its currently running animation untouched.
                for (const [key, previous] of first || []) {
                    const item = live.get(key);
                    if (!item || item.element !== previous.item.element ||
                        signature(item.element) === previous.signature) continue;
                    const nodes = [item.element, ...companions(key)];
                    for (const node of nodes) {
                        const record = active.get(node);
                        if (record) finish(record, true);
                    }
                    targets.push({ key, item, previous, nodes });
                }
                const additions = [...entering.values()].filter(item => live.get(item.key)?.element === item.element && rect(item.element));
                entering.clear();
                const additionNodes = new Set();
                const entrances = [];
                for (const item of additions) {
                    for (const node of [item.element, ...companions(item.key)]) {
                        additionNodes.add(node);
                        const record = active.get(node);
                        if (record) finish(record, true);
                        entrances.push({ item, node });
                    }
                }
                // Read the complete final geometry and base styles before
                // starting effects on either media or their companion overlays.
                const moves = [];
                for (const target of targets) {
                    for (const node of target.nodes) {
                        if (additionNodes.has(node)) continue;
                        const initial = node === target.item.element ? target.previous.bounds : target.previous.layers.get(node);
                        const change = movement(initial, rect(node));
                        if (change) moves.push({ ...target, node, change });
                    }
                }
                for (const entrance of entrances) {
                    let opacity = '1', base = 'none';
                    try { const style = view.getComputedStyle(entrance.node); opacity = style.opacity || '1'; base = style.transform || 'none'; } catch (_) {}
                    entrance.frames = [
                        { transform: `scale(.04)${base === 'none' ? '' : ' ' + base}`, transformOrigin: '50% 50%', opacity: '0.15' },
                        { transform: base, transformOrigin: '50% 50%', opacity }
                    ];
                }
                for (const move of moves) move.frames = moveFrames(move.node, move.change);
                for (const move of moves)
                    animate(move.node, move.key, move.item.element, move.frames, 'move', MOVE_MS);
                for (const { item, node, frames } of entrances) {
                    // Waiting players were never hidden or scaled. The short
                    // entrance begins only after the applicable readiness signal.
                    animate(node, item.key, item.element, frames, 'enter', ENTER_MS);
                }
            });
        }
        function schedule() {
            if (frame === null && !destroyed) frame = requestFrame(flush);
        }
        function run(action) {
            if (typeof action !== 'function') throw new TypeError('action is required');
            if (destroyed) return action();
            const outer = depth === 0;
            let effects = [];
            if (outer) {
                if (allowed()) {
                    // Coalesce same-turn changes into one route from the first
                    // visible layout to the last committed layout.
                    if (!before) before = capture();
                    effects = detachEffects();
                } else cancelVisuals();
            }
            depth++;
            try { return action(); }
            finally {
                depth--;
                if (outer) {
                    restoreEffects(effects);
                    refresh();
                    if (before || entering.size) schedule();
                }
            }
        }
        function enter(item) {
            if (!item?.element || entered.has(item.element) || !current(item)) return false;
            entered.add(item.element);
            if (!allowed() || item.resource?.failed || item.resource?.disposed) return false;
            const value = { item, cleanup: [], timer: null };
            pending.set(item.element, value);
            const done = grow => {
                if (pending.get(item.element) !== value) return;
                clearPending(value);
                if (grow && current(item) && allowed() && !item.resource?.failed && !item.resource?.disposed) {
                    entering.set(item.element, item);
                    schedule();
                }
            };
            const listen = (node, event, callback) => {
                node.addEventListener(event, callback);
                value.cleanup.push(() => node.removeEventListener(event, callback));
            };
            const observe = (node, callback, options) => {
                if (typeof view.MutationObserver !== 'function') return;
                const observer = new view.MutationObserver(callback);
                observer.observe(node, options);
                value.cleanup.push(() => observer.disconnect());
            };
            const boundFrames = new WeakSet();
            const bindFrameLoad = () => {
                const iframe = item.element.tagName === 'IFRAME' ? item.element : item.element.querySelector('iframe');
                if (!iframe || boundFrames.has(iframe)) return;
                boundFrames.add(iframe);
                // Cross-origin document load is the strongest signal an
                // ordinary embed exposes; it is not proof of decoded video.
                listen(iframe, 'load', () => done(true));
                listen(iframe, 'error', () => done(false));
            };
            value.timer = view.setTimeout(() => done(false), READY_TIMEOUT_MS);
            const video = item.resource?.video || (item.element.tagName === 'VIDEO' ? item.element : null);
            if (video) {
                const ready = () => { if (video.readyState >= 2) done(true); };
                for (const event of ['loadeddata', 'canplay', 'playing']) listen(video, event, ready);
                listen(video, 'error', () => done(false));
                ready();
            } else if (item.resource?.twitch || item.element.dataset.streamPlaybackState ||
                item.element.classList.contains('twitch-wrapper')) {
                const ready = () => {
                    if (item.element.dataset.streamQualityMode === 'platform-auto') { bindFrameLoad(); return; }
                    const state = item.element.dataset.streamPlaybackState;
                    if (state === 'playing') done(true);
                    else if (['paused', 'blocked', 'offline', 'ended'].includes(state)) done(false);
                };
                observe(item.element, ready, { childList: true, subtree: true, attributes: true,
                    attributeFilter: ['data-stream-playback-state', 'data-stream-quality-mode'] });
                ready();
            } else if (item.resource?.youtube || item.element.dataset.embedAudioState ||
                item.element.classList.contains('youtube-wrapper') || item.element.querySelector('[data-embed-audio-state]')) {
                const ready = () => {
                    const iframe = item.element.tagName === 'IFRAME' ? item.element : item.element.querySelector('iframe');
                    if (iframe?.dataset.embedAudioState === 'ready') done(true);
                    else if (['failed', 'unavailable', 'error'].includes(iframe?.dataset.embedAudioState)) done(false);
                };
                observe(item.element, ready, { childList: true, subtree: true, attributes: true,
                    attributeFilter: ['data-embed-audio-state'] });
                ready();
            } else {
                bindFrameLoad();
                if (item.element.tagName !== 'IFRAME') observe(item.element, bindFrameLoad, { childList: true, subtree: true });
            }
            return true;
        }
        function layer() {
            const host = document.body || document.documentElement;
            if (!host) return null;
            const bounds = rect(pane);
            if (!bounds) return null;
            if (!ghostLayer) {
                ghostLayer = document.createElement('div');
                ghostLayer.dataset.playerMotionGhostLayer = '1';
                ghostLayer.setAttribute('aria-hidden', 'true');
                ghostLayer.setAttribute('inert', '');
                ghostLayer.style.cssText = 'position:fixed;pointer-events:none;overflow:hidden;z-index:14;contain:layout paint;';
                // The real player wrapper uses contain:layout, which establishes
                // a fixed-position containing block. A viewport-based static
                // image belongs under body or its offset would be counted twice.
                host.appendChild(ghostLayer);
            }
            Object.assign(ghostLayer.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
            return { node: ghostLayer, bounds };
        }
        function leave(item) {
            if (!item?.element?.isConnected || leaving.has(item.element) || !allowed() || ghosts.size >= MAX_GHOSTS) return false;
            // Lifecycle retires the lease before invoking teardown. A just-retired
            // connected node is valid here; an older node must not impersonate a
            // newly registered player with the same channel key.
            const live = items().get(item.key);
            if (live && live.element !== item.element) return false;
            const bounds = rect(item.element);
            if (!bounds) return false;
            const target = layer();
            if (!target) return false;
            leaving.add(item.element);
            let ghost = null;
            const video = item.resource?.video || (item.element.tagName === 'VIDEO' ? item.element : null);
            if (canvasGhosts < MAX_CANVAS_GHOSTS && video?.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
                try {
                    const canvas = document.createElement('canvas');
                    const scale = Math.min(1, 640 / video.videoWidth, 360 / video.videoHeight);
                    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
                    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
                    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                    canvas.dataset.playerMotionCanvas = '1';
                    ghost = canvas;
                    canvasGhosts++;
                } catch (_) {}
            }
            if (!ghost) {
                ghost = document.createElement('div');
                ghost.textContent = item.channel?.name || item.element.dataset.channelName || '';
            }
            ghost.dataset.playerMotionGhost = '1';
            ghost.setAttribute('aria-hidden', 'true');
            ghost.style.cssText = 'position:absolute;pointer-events:none;object-fit:contain;background:#080a0c;color:#ddd;' +
                'display:flex;align-items:center;justify-content:center;font:14px system-ui;overflow:hidden;border-radius:8px;';
            Object.assign(ghost.style, { left: `${bounds.left - target.bounds.left}px`, top: `${bounds.top - target.bounds.top}px`,
                width: `${bounds.width}px`, height: `${bounds.height}px` });
            target.node.appendChild(ghost);
            ghosts.add(ghost);
            return batch(() => animate(ghost, item.key, null,
                [{ transform: 'scale(1)', opacity: '1' }, { transform: 'scale(.04)', opacity: '0' }], 'leave', LEAVE_MS, true));
        }
        const pointerDown = event => { pointers.add(event.pointerId); cancelVisuals(); };
        const pointerUp = event => pointers.delete(event.pointerId);
        const releasePointers = () => pointers.clear();
        const pageHide = () => { suspended = true; pointers.clear(); cancelAll(); };
        const pageShow = () => { suspended = false; refresh(); };
        const motionChange = () => { if (media?.matches) cancelAll(); };
        const fullscreenChange = () => cancelAll();
        const blur = () => { pointers.clear(); cancelVisuals(); };
        const viewportChange = () => {
            // Static exit images are fixed to their captured viewport rectangle.
            // Do not leave one behind after a scroll or browser resize.
            batch(() => { for (const ghost of [...ghosts]) {
                const record = active.get(ghost);
                if (record) finish(record, true); else removeGhost(ghost);
            } });
        };
        wrapper?.addEventListener('pointerdown', pointerDown, true);
        for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) document?.addEventListener(event, pointerUp, true);
        for (const event of ['dragend', 'drop']) document?.addEventListener(event, releasePointers, true);
        for (const event of ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange'])
            document?.addEventListener(event, fullscreenChange);
        view.addEventListener?.('pagehide', pageHide);
        view.addEventListener?.('pageshow', pageShow);
        view.addEventListener?.('blur', blur);
        view.addEventListener?.('resize', viewportChange);
        view.addEventListener?.('scroll', viewportChange, true);
        if (media?.addEventListener) media.addEventListener('change', motionChange);
        else media?.addListener?.(motionChange);
        function destroy() {
            if (destroyed) return;
            destroyed = true;
            cancelAll();
            wrapper?.removeEventListener('pointerdown', pointerDown, true);
            for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) document?.removeEventListener(event, pointerUp, true);
            for (const event of ['dragend', 'drop']) document?.removeEventListener(event, releasePointers, true);
            for (const event of ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange'])
                document?.removeEventListener(event, fullscreenChange);
            view.removeEventListener?.('pagehide', pageHide);
            view.removeEventListener?.('pageshow', pageShow);
            view.removeEventListener?.('blur', blur);
            view.removeEventListener?.('resize', viewportChange);
            view.removeEventListener?.('scroll', viewportChange, true);
            if (media?.removeEventListener) media.removeEventListener('change', motionChange);
            else media?.removeListener?.(motionChange);
        }
        return { run, enter, leave, refresh, layoutRect, cancelAll, destroy };
    }

    const api = { create };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PlayerMotion = api;
})(typeof globalThis === 'object' ? globalThis : this);
