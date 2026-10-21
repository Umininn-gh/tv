/* The extension adds its controls without changing the hosted website. */
(function (root) {
    'use strict';
    const config = root.UmininnConfig;
    const media = root.UmininnMedia;
    const runtime = (root.browser || root.chrome)?.runtime;
    const recovery = root.UmininnRecovery;
    const CHANNEL = 'umininn-tv-player';
    const VERSION = 1;

    function validResult(result) {
        return result && typeof result.ok === 'boolean' && typeof result.code === 'string' &&
            (!result.state || typeof result.state === 'object');
    }

    function aggregateAudio(states) {
        const present = states.filter(state => state && typeof state === 'object');
        const values = present.map(state => state.volume).filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
        const common = values.length > 0 && values.length === present.length && values.every(value => Math.abs(value - values[0]) < 0.001);
        return { muted: present.length > 0 && present.every(state => state.muted === true), volume: common ? values[0] : null,
            mixed: values.length > 0 && !common };
    }

    function canControl(entry, action) {
        if (entry.kind === 'unsupported' || entry.kind === 'frame' && !entry.target) return false;
        const result = entry.result;
        const state = result?.state;
        if (!state) return false;
        // Twitch can show a real Play control before it has created a video.
        const platformPlay = action === 'recover' && state.platformRecoverSupported === true && state.recoverSupported === true;
        if (!platformPlay && (result.code === 'no-media' || state.playbackStatus === 'no-media')) return false;
        const support = { setVolume: 'volumeSupported', setMuted: 'muteSupported', recover: 'recoverSupported' }[action];
        if (support && state[support] === false) return false;
        const caps = result.capabilities || state.capabilities || {};
        return caps[action] !== false;
    }

    function isWatchStartTarget(target) {
        const button = target?.closest?.('button');
        return Boolean(button?.parentElement?.id === 'channel-selection' &&
            /^\s*watchSelectedChannels\s*\(\s*\)\s*;?\s*$/.test(button.getAttribute('onclick') || ''));
    }

    function isRecoveryReady(entry, result = entry.result) {
        if (entry.kind === 'unsupported') return true;
        const state = result?.state;
        if (!state) return false;
        if (state.disposed || state.errorCode || state.playbackStatus === 'error') return true;
        const mediaReady = state.available && (state.readyState >= 1 || state.paused === false || state.ended);
        // A connected frame can expose an empty <video> before Twitch has
        // initialized it. Wait for metadata or a trustworthy platform Play.
        if (entry.kind === 'frame') return Boolean(entry.target && (mediaReady || state.platformRecoverSupported));
        return Boolean(mediaReady);
    }

    // A slow/absent player must not hold back other ready players in this pass.
    function createReadinessPass(options) {
        const { clock, context } = options;
        const now = options.now || (() => Date.now());
        const started = now(), stable = new Map(), submitted = new Set();
        let timer = null, finished = false, resolve;
        const promise = new Promise(done => { resolve = done; });
        function finish() {
            if (finished) return;
            finished = true;
            if (timer !== null) clock.clearTimeout(timer);
            context.signal?.removeEventListener('abort', finish);
            resolve();
        }
        function check() {
            timer = null;
            if (finished || context.isCancelled()) { finish(); return; }
            const snapshot = options.snapshot();
            const time = now(), ready = [], waiting = [];
            for (const entry of snapshot.entries) {
                if (submitted.has(entry)) continue;
                options.refresh(entry, time);
                if (!isRecoveryReady(entry)) {
                    stable.delete(entry);
                    waiting.push(entry);
                    continue;
                }
                let mark = stable.get(entry);
                if (!mark || mark.generation !== entry.generation) {
                    mark = { generation: entry.generation, since: time };
                    stable.set(entry, mark);
                }
                if (time - mark.since >= 600) ready.push(entry);
                else waiting.push(entry);
            }
            for (const entry of ready) submitted.add(entry);
            options.onWaiting(waiting, snapshot.pendingWrappers);
            if (finished || context.isCancelled()) { finish(); return; }
            if (ready.length) context.enqueueReady(ready);
            if (finished || context.isCancelled()) { finish(); return; }
            if ((!waiting.length && !snapshot.pendingWrappers.length && time - started >= 600) || time - started >= 30000) {
                finish();
                return;
            }
            timer = clock.setTimeout(check, 200);
        }
        context.signal?.addEventListener('abort', finish, { once: true });
        if (context.isCancelled()) finish();
        else timer = clock.setTimeout(check, 0);
        return { promise, finish };
    }

    // Only the last requested enlarged tile may open its sound. Requests share
    // one worker so an older, already-issued frame command settles before the
    // next request's mute barrier. Cancelling also lets explicit controls wait
    // for that barrier instead of racing a late unmute response.
    function createAudioFocusFlow(options) {
        const clock = options.clock;
        const now = options.now || (() => Date.now());
        const waitMs = options.waitMs ?? 6000;
        let active = null, pending = null, draining = false, disposed = false;
        const cancelled = () => ({ phase: 'cancelled' });
        function stop(request) {
            if (!request) return;
            request.cancelled = true;
            request.wake?.();
        }
        function report(request, value) {
            if (!disposed && !request.cancelled) options.onStatus?.(value);
            return value;
        }
        function wait(request) {
            return new Promise(resolve => {
                const timer = clock.setTimeout(done, 100);
                function done() {
                    clock.clearTimeout(timer);
                    request.wake = null;
                    resolve();
                }
                request.wake = done;
                if (request.cancelled || disposed) done();
            });
        }
        function current(item) { return options.isCurrent(item); }
        async function run(request) {
            report(request, { phase: 'preparing', target: request.target });
            const started = now();
            let items;
            for (;;) {
                if (request.cancelled || disposed) return cancelled();
                options.refresh?.();
                items = options.snapshot();
                if (!items.some(item => item.key === request.target)) return report(request, { phase: 'removed', target: request.target });
                if (!items.some(item => options.readiness(item) === 'pending') || now() - started >= waitMs) break;
                await wait(request);
            }
            if (request.cancelled || disposed) return cancelled();
            const results = await Promise.all(items.map(async item => {
                const readiness = options.readiness(item);
                if (!current(item)) return { item, code: 'stale' };
                if (readiness !== 'ready') return { item, code: readiness };
                try {
                    const result = await options.execute(item, { action: 'setMuted', value: true });
                    return { item, code: result?.ok && result.state?.muted === true ? null : result?.code || 'unconfirmed' };
                } catch (_) { return { item, code: 'error' }; }
            }));
            if (request.cancelled || disposed) return cancelled();
            const failures = results.filter(result => result.code).map(result => ({ key: result.item.key, name: result.item.name, code: result.code }));
            const fresh = options.snapshot();
            for (const item of fresh) {
                if (!items.some(previous => previous.key === item.key && previous.identity === item.identity && previous.generation === item.generation) ||
                    !current(item) || item.state?.muted !== true) {
                    if (!failures.some(failure => failure.key === item.key)) failures.push({ key: item.key, name: item.name, code: 'changed' });
                }
            }
            const target = fresh.find(item => item.key === request.target);
            if (!target || !items.some(item => item.key === request.target && item.identity === target.identity && item.generation === target.generation)) {
                return report(request, { phase: 'removed', target: request.target });
            }
            if (failures.length) return report(request, { phase: 'partial', target: request.target, failures });
            if (!options.canSetVolume(target)) return report(request, { phase: 'partial', target: request.target,
                failures: [{ key: target.key, name: target.name, code: 'volume-unsupported' }] });
            const volumeResult = await options.execute(target, { action: 'setVolume', value: 1 });
            if (request.cancelled || disposed) return cancelled();
            if (!volumeResult?.ok || volumeResult.state?.volume !== 1) return report(request, { phase: 'partial', target: request.target,
                failures: [{ key: target.key, name: target.name, code: volumeResult?.ok ? 'volume-unconfirmed' : volumeResult?.code || 'volume-unconfirmed' }] });
            // Check the complete cohort again after the volume command;
            // a frame navigation/removal/new player must not bypass the barrier.
            const final = options.snapshot();
            const changed = final.filter(item => !fresh.some(previous => previous.key === item.key && previous.identity === item.identity && previous.generation === item.generation) ||
                !current(item) || item.state?.muted !== true);
            if (!current(target) || !final.some(item => item.key === target.key && item.identity === target.identity && item.generation === target.generation)) {
                return report(request, { phase: 'removed', target: request.target });
            }
            if (changed.length) return report(request, { phase: 'partial', target: request.target,
                failures: changed.map(item => ({ key: item.key, name: item.name, code: 'changed' })) });
            if (request.cancelled || disposed) return cancelled();
            const result = await options.execute(target, { action: 'setMuted', value: false });
            if (request.cancelled || disposed) return cancelled();
            if (!current(target) || !options.snapshot().some(item => item.key === target.key && item.identity === target.identity && item.generation === target.generation)) {
                return report(request, { phase: 'removed', target: request.target });
            }
            return report(request, result?.ok && result.state?.muted === false ? { phase: 'focused', target: request.target, name: target.name } :
                { phase: 'partial', target: request.target, failures: [{ key: target.key, name: target.name, code: result?.code || 'unconfirmed' }] });
        }
        async function drain() {
            if (draining) return;
            draining = true;
            while (pending && !disposed) {
                const request = active = pending;
                pending = null;
                let result;
                try { result = await run(request); }
                catch (_) { result = report(request, { phase: 'partial', target: request.target, failures: [{ name: '播放器', code: 'error' }] }); }
                request.resolve(result);
                request.settled();
                active = null;
            }
            draining = false;
        }
        function cancel() {
            stop(active);
            if (pending) { pending.resolve(cancelled()); pending.settled(); pending = null; }
            return active?.done || Promise.resolve();
        }
        function request(target) {
            if (disposed) return Promise.resolve(cancelled());
            cancel();
            const value = { target, cancelled: false };
            const promise = new Promise(resolve => { value.resolve = resolve; });
            value.done = new Promise(resolve => { value.settled = resolve; });
            pending = value;
            void drain();
            return promise;
        }
        return { request, cancel, dispose() { disposed = true; void cancel(); } };
    }

    function createSiteController(options) {
        const win = options.window;
        const doc = options.document;
        const api = options.runtime;
        const cfg = options.config;
        const messageChannel = cfg.CHANNEL || CHANNEL;
        const messageVersion = cfg.VERSION || VERSION;
        const permissionHint = cfg.PERMISSION_HINT || '擴充功能的網站權限';
        const factory = options.media;
        const recoveryFactory = options.recovery || recovery;
        const entries = new Map();
        let host, shadow, panelHost, panelShadow, toggle, quickDetect, panel, list, summary, observer, lateObserver, masterVolume, masterReadout, detectButton, recoveryStatus, recoveryFlow, audioFocusStatus, audioFocusFlow;
        let sequence = 0, scanTimer = null, disposed = false, globalMuted = null;
        let preparation = null, preparedCohort = new Set(), watchStartTimer = null, unreadyWrappers = 0;
        let recoveryStartGeneration = 0;
        let preparationWaiting = '', lastRecoveryStatus = null;
        let panelIdleCleanup = null, highlightObserver = null, highlightStyle = null, highlightFrame = null, touchPointer = false, revealedEntry = null;
        let revealOrder = '', revealViewport = '';
        let highlightLayer = null, highlightViewport = null, highlightResizeObserver = null;
        const highlightRings = new Map();

        // Each menu publishes only its own pointer state. Reading the other
        // menu's marker for the row alone prevents a two-way observer loop.
        const controlsHighlight = 'data-umininn-controls-highlight';
        const selectionHighlight = 'data-umininn-selection-highlight';
        function fullscreenActive() { return Boolean(doc.fullscreenElement || doc.webkitFullscreenElement); }
        function paintHighlights() {
            if (!highlightLayer) return;
            const pane = doc.getElementById('multi-stream-container');
            const selected = [...entries.values()].filter(entry => entry.element.parentElement === pane && entry.element.hasAttribute(controlsHighlight));
            const suspended = disposed || doc.hidden || fullscreenActive() || panel?.hidden || pane?.hidden || !pane?.isConnected;
            const paneBox = suspended ? null : pane.getBoundingClientRect();
            if (suspended || !selected.length || !paneBox?.width || !paneBox?.height) {
                highlightLayer.hidden = true;
                for (const ring of highlightRings.values()) ring.remove();
                highlightRings.clear();
                return;
            }
            highlightLayer.hidden = false;
            const layerBox = highlightLayer.getBoundingClientRect();
            const scaleX = layerBox.width ? highlightLayer.clientWidth / layerBox.width : 1;
            const scaleY = layerBox.height ? highlightLayer.clientHeight / layerBox.height : 1;
            Object.assign(highlightViewport.style, {
                left: `${(paneBox.left - layerBox.left) * scaleX}px`, top: `${(paneBox.top - layerBox.top) * scaleY}px`,
                width: `${paneBox.width * scaleX}px`, height: `${paneBox.height * scaleY}px`,
                borderRadius: win.getComputedStyle(pane).borderRadius
            });
            const keep = new Set();
            for (const entry of selected) {
                const box = entry.element.getBoundingClientRect();
                const visibility = win.getComputedStyle(entry.element).visibility;
                if (entry.element.hidden || visibility === 'hidden' || visibility === 'collapse' || !box.width || !box.height || box.right <= paneBox.left || box.left >= paneBox.right || box.bottom <= paneBox.top || box.top >= paneBox.bottom) continue;
                keep.add(entry);
                let ring = highlightRings.get(entry);
                if (!ring) {
                    ring = node('span', null, { 'data-player-ring': '', 'data-player-id': String(entry.id) });
                    highlightRings.set(entry, ring); highlightViewport.appendChild(ring);
                }
                Object.assign(ring.style, {
                    left: `${(box.left - paneBox.left) * scaleX}px`, top: `${(box.top - paneBox.top) * scaleY}px`,
                    width: `${box.width * scaleX}px`, height: `${box.height * scaleY}px`
                });
            }
            for (const [entry, ring] of highlightRings) if (!keep.has(entry)) { ring.remove(); highlightRings.delete(entry); }
            highlightLayer.hidden = !highlightRings.size;
        }
        function hoveredWindowKeys() {
            return new Set([...doc.querySelectorAll('.player-window-cell[data-player-key]')].filter(cell => cell.matches(':hover')).map(cell => cell.dataset.playerKey));
        }
        function windowControlsHovered(entry, windowKeys) {
            const key = entry.element.dataset.channelKey || (entry.element.id === 'MyFrame' ? 'initial-player' : '');
            return Boolean(key && (windowKeys || hoveredWindowKeys()).has(key));
        }
        function revealHoveredEntry(entry) {
            if (entry === revealedEntry) return;
            revealedEntry = entry;
            if (!entry || disposed || panel?.hidden || doc.hidden || touchPointer || !entry.row?.isConnected) return;
            const bounds = panel.getBoundingClientRect();
            const top = bounds.top + panel.clientTop, bottom = top + panel.clientHeight;
            const row = entry.row.getBoundingClientRect(), viewportHeight = bottom - top;
            // Scroll only this menu, by the smallest amount needed. Oversized
            // rows already spanning the viewport require no movement.
            let delta = 0;
            if (row.top < top && row.bottom > bottom) return;
            if (row.top < top) delta = row.height > viewportHeight ? row.bottom - bottom : row.top - top;
            else if (row.bottom > bottom) delta = row.height > viewportHeight ? row.top - top : row.bottom - bottom;
            if (Math.abs(delta) > 0.5) panel.scrollTop += delta;
        }
        function updateHighlight(entry, windowKeys) {
            const live = !disposed && !doc.hidden && !fullscreenActive() && !panel?.hidden && entries.get(entry.element) === entry &&
                entry.element.parentElement === doc.getElementById('multi-stream-container');
            const canHover = !touchPointer && (!win.matchMedia || win.matchMedia('(any-hover: hover)').matches);
            const ownHover = Boolean(live && canHover && (entry.row?.matches(':hover') || entry.element.matches(':hover') || windowControlsHovered(entry, windowKeys)));
            entry.element.toggleAttribute(controlsHighlight, ownHover);
            if (live && (ownHover || entry.element.hasAttribute(selectionHighlight))) entry.row.dataset.playerHighlighted = 'true';
            else entry.row?.removeAttribute('data-player-highlighted');
        }
        function updateHighlights() {
            const keys = !disposed && !doc.hidden && !panel?.hidden ? hoveredWindowKeys() : new Set();
            if (!disposed && !doc.hidden && !panel?.hidden) {
                const viewport = `${panel.clientWidth},${panel.clientHeight}`;
                if (viewport !== revealViewport) { revealViewport = viewport; revealedEntry = null; }
            }
            let hovered = null;
            const canHover = !disposed && !doc.hidden && !fullscreenActive() && !panel?.hidden && !touchPointer && (!win.matchMedia || win.matchMedia('(any-hover: hover)').matches);
            for (const entry of entries.values()) {
                updateHighlight(entry, keys);
                if (canHover && entry.element.parentElement === doc.getElementById('multi-stream-container') &&
                    (entry.element.matches(':hover') || windowControlsHovered(entry, keys))) hovered = entry;
            }
            revealHoveredEntry(hovered);
            paintHighlights();
        }
        function scheduleHighlights() {
            if (disposed || !panel || panel.hidden || doc.hidden || fullscreenActive() || highlightFrame !== null) return;
            highlightFrame = win.requestAnimationFrame(() => { highlightFrame = null; updateHighlights(); });
        }
        function windowControlsPointer(event) {
            if (disposed || !panel || panel.hidden || doc.hidden) return;
            if (!event.target?.closest?.('.player-window-cell[data-player-key]')) return;
            if (event.pointerType) touchPointer = event.pointerType === 'touch';
            scheduleHighlights();
        }
        function onHighlightVisibility() { updateHighlights(); if (!doc.hidden) scheduleHighlights(); }
        function onHighlightFullscreen() { updateHighlights(); if (!fullscreenActive()) scheduleHighlights(); }
        function observeEntryHover(entry) {
            const update = event => {
                if (disposed || !panel || panel.hidden || doc.hidden) return;
                const previous = touchPointer;
                if (event.pointerType) touchPointer = event.pointerType === 'touch';
                if (previous !== touchPointer) updateHighlights();
                else { updateHighlight(entry); paintHighlights(); }
                // Firefox updates :hover after pointer boundary dispatch.
                scheduleHighlights();
            };
            entry.element.addEventListener('pointerenter', update);
            entry.element.addEventListener('pointerleave', update);
            entry.element.addEventListener('pointermove', update);
            entry.row.addEventListener('pointerenter', update);
            entry.row.addEventListener('pointerleave', update);
            entry.row.addEventListener('pointermove', update);
            highlightResizeObserver?.observe(entry.element);
            entry.hoverCleanup = () => {
                highlightResizeObserver?.unobserve(entry.element);
                entry.element.removeEventListener('pointerenter', update);
                entry.element.removeEventListener('pointerleave', update);
                entry.element.removeEventListener('pointermove', update);
                entry.row.removeEventListener('pointerenter', update);
                entry.row.removeEventListener('pointerleave', update);
                entry.row.removeEventListener('pointermove', update);
                entry.element.removeAttribute(controlsHighlight);
                entry.row.removeAttribute('data-player-highlighted');
                highlightRings.get(entry)?.remove(); highlightRings.delete(entry);
            };
        }

        function node(tag, text, attributes = {}) {
            const element = doc.createElement(tag);
            if (text !== null) element.textContent = text;
            for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
            return element;
        }
        function envelope(type, fields = {}) {
            const audioPreference = type === 'site:audio-preference';
            return { channel: audioPreference ? CHANNEL : messageChannel,
                version: audioPreference ? VERSION : messageVersion, type, ...fields };
        }
        function activeElement() { return panelShadow?.activeElement || shadow?.activeElement; }
        function positionPanel() {
            if (!host || !panel || panel.hidden) return;
            const top = Math.min(Math.max(12, Math.round(host.getBoundingClientRect().bottom + 8)), Math.max(12, win.innerHeight - 90));
            panel.style.top = `${top}px`;
            panel.style.maxHeight = `${Math.max(1, win.innerHeight - top - 12)}px`;
            updateHighlights();
            scheduleHighlights();
        }
        function runtimeSend(message) {
            return new Promise(resolve => {
                let finished = false;
                const timer = win.setTimeout(() => finish({ ok: false, code: 'timeout', message: '控制連線逾時，請重新偵測。' }), 5000);
                function finish(value) {
                    if (finished) return;
                    finished = true;
                    win.clearTimeout(timer);
                    resolve(value || { ok: false, code: 'unavailable', message: '播放器控制未能連接。' });
                }
                try {
                    const request = api.sendMessage(message);
                    if (request && typeof request.then === 'function') request.then(finish, () => finish({ ok: false, code: 'unavailable', message: '連線已中斷，請重新整理網頁。' }));
                    else finish({ ok: false, code: 'unavailable', message: '此瀏覽器版本未支援控制連線。' });
                } catch (_) { finish({ ok: false, code: 'unavailable', message: '連線已中斷，請重新整理網頁。' }); }
            });
        }
        function order(entry) { return Number(entry.element.style.order) || 0; }
        function currentEntries() { return [...entries.values()].sort((a, b) => order(a) - order(b) || a.id - b.id); }
        function describe(entry, index) {
            const channelName = entry.element.getAttribute('data-channel-name')?.trim();
            if (channelName) return `${index + 1}. ${channelName}`;
            const frame = entry.frame;
            if (!frame) return `${index + 1}. 原生播放器`;
            try {
                const url = new URL(frame.src, win.location.href);
                const names = { 'player.twitch.tv': 'Twitch', 'player.kick.com': 'Kick', 'ok.ru': 'OK', 'player.angelthump.com': 'AngelThump', 'goodgame.ru': 'GoodGame', 'player.goodgame.ru': 'GoodGame' };
                const platform = names[url.hostname] || (/youtube/.test(url.hostname) ? 'YouTube' : url.hostname);
                const channel = url.searchParams.get('channel') || url.searchParams.get('video') || url.pathname.split('/').filter(Boolean).pop() || '';
                return `${index + 1}. ${platform}${channel && !['player', 'videoembed'].includes(channel) ? ' · ' + channel : ''}`;
            } catch (_) { return `${index + 1}. 外站播放器`; }
        }
        const can = canControl;
        function renderEntry(entry) {
            if (!entry.row) return;
            const state = entry.result?.state;
            const labels = { playing: '播放中', paused: '已暫停', waiting: '緩衝中', blocked: '請在播放器內按播放', error: '來源錯誤', ended: '已結束', 'no-media': '尚未找到影片' };
            entry.status.textContent = entry.notice || entry.result?.message || labels[state?.playbackStatus] || '正在偵測播放器…';
            if (state) {
                const volume = state.volume;
                if (typeof volume === 'number' && Number.isFinite(volume) && volume >= 0 && volume <= 1) {
                    if (activeElement() !== entry.volume) entry.volume.value = String(Math.round(volume * 100));
                    entry.level.textContent = `${Math.round(volume * 100)}%`;
                } else entry.level.textContent = '—';
                entry.mute.textContent = state.muted ? '開聲' : '靜音';
                entry.mute.setAttribute('aria-pressed', String(Boolean(state.muted)));
            }
            entry.volume.disabled = entry.busy || !can(entry, 'setVolume');
            entry.mute.disabled = entry.busy || !can(entry, 'setMuted');
            entry.recover.disabled = entry.busy || !can(entry, 'recover');
        }
        function refreshSummary() {
            if (!summary) return;
            const all = currentEntries();
            const connected = all.filter(entry => can(entry, 'setMuted')).length;
            summary.textContent = all.length ? `${connected}／${all.length} 台可調整聲音；恢復播放不會重載。` : '開始觀看後會列出播放器。';
            const audio = aggregateAudio(all.filter(entry => can(entry, 'setVolume')).map(entry => entry.result.state));
            if (masterVolume && activeElement() !== masterVolume) {
                if (audio.volume !== null) masterVolume.value = String(Math.round(audio.volume * 100));
                masterReadout.textContent = audio.volume !== null ? `${Math.round(audio.volume * 100)}%` : audio.mixed ? '各台不同' : '—';
                masterVolume.setAttribute('aria-valuetext', masterReadout.textContent);
            }
            const original = doc.getElementById('toggle-all-audio');
            if (original && all.length) {
                const playable = all.filter(entry => can(entry, 'setMuted'));
                const muted = aggregateAudio(playable.map(entry => entry.result.state)).muted;
                original.textContent = muted ? '🔊 全部開聲' : '🔇 全部靜音';
                original.setAttribute('aria-pressed', String(muted));
                original.title = '由播放控制同步聲音；不支援的台會列出。';
            }
        }
        function applyResult(entry, result) {
            if (disposed || !entries.has(entry.element) || !validResult(result)) return;
            entry.result = result;
            entry.notice = '';
            renderEntry(entry);
            refreshSummary();
        }
        async function execute(entry, command) {
            const readable = entry.kind === 'native' || entry.kind === 'frame' && Boolean(entry.target);
            if (entry.busy || !entries.has(entry.element) ||
                (command.action === 'getState' ? !readable : !can(entry, command.action))) return { ok: false, code: 'unavailable' };
            const generation = entry.generation;
            const target = entry.target;
            entry.busy = true;
            entry.notice = command.action === 'recover' ? '正在確認播放…' : command.action === 'getState' ? '正在讀取狀態…' : '正在套用…';
            renderEntry(entry);
            let result;
            try {
                result = entry.controller ? await entry.controller.execute(command) : await runtimeSend(envelope('site:command', { target, command }));
            } catch (_) { result = { ok: false, code: 'error', message: '操作未完成，請在播放器內操作。' }; }
            if (disposed || !entries.has(entry.element) || generation !== entry.generation) return { ok: false, code: 'stale' };
            entry.busy = false;
            if (validResult(result)) applyResult(entry, result);
            else entry.notice = '未收到有效的播放器回應。';
            renderEntry(entry);
            return result;
        }
        async function applyAll(command) {
            const all = currentEntries();
            if (!all.length) { summary.textContent = '請先開始觀看，再調整聲音。'; return; }
            const results = await Promise.all(all.map(async entry => ({ entry, result: await execute(entry, command) })));
            if (disposed) return;
            const failed = results.filter(item => !item.result?.ok);
            summary.textContent = failed.length ? `${failed.length} 台未能套用：${failed.map(item => item.entry.name.textContent).join('、')}` : `${all.length} 台已套用。`;
        }

        function afterAudioFocus(action) {
            showAudioFocusStatus({ phase: 'cancelled' });
            const settled = audioFocusFlow?.cancel() || Promise.resolve();
            return settled.then(() => { if (!disposed) return action(); });
        }

        function setGlobalMuted(muted) {
            globalMuted = muted;
            // Keep the site's selection metadata in step without invoking its
            // fallback audio handler, which can reload cross-origin frames.
            win.postMessage(envelope('site:audio-preference', { muted }), win.location.origin);
            refreshSummary();
            void afterAudioFocus(() => applyAll({ action: 'setMuted', value: muted }));
        }

        function isCurrent(entry, generation) {
            return !disposed && entries.get(entry.element) === entry && entry.element.isConnected &&
                entry.generation === generation && (!entry.frame || entry.frame.isConnected && entry.frame.src === entry.source);
        }
        function clearPreparation() { preparation?.finish(); }
        function prepareRecovery(context) {
            clearPreparation();
            preparedCohort = new Set(doc.getElementById('multi-stream-container')?.children || []);
            unreadyWrappers = 0;
            preparationWaiting = '';
            const probed = new Map();
            const pendingWrappers = () => [...preparedCohort].filter(element => element.isConnected &&
                element.classList?.contains('twitch-wrapper') && !entries.has(element));
            const token = createReadinessPass({
                clock: win, context,
                snapshot() {
                    scan();
                    return { entries: currentEntries().filter(entry => preparedCohort.has(entry.element)), pendingWrappers: pendingWrappers() };
                },
                refresh(entry, time) {
                    if (entry.kind === 'native') applyResult(entry, entry.controller.getState());
                    else if (entry.kind === 'frame') {
                        const previous = probed.get(entry);
                        // Re-read while waiting, including when a connected frame
                        // had no video/Play yet. Probing never resets its identity.
                        if (!previous || previous.generation !== entry.generation || time - previous.at >= 1000) {
                            probed.set(entry, { generation: entry.generation, at: time });
                            probe(entry);
                        }
                    }
                },
                onWaiting(waiting, wrappers) {
                    const count = waiting.length + wrappers.length;
                    const names = waiting.slice(0, 3).map(entry => entry.name.textContent);
                    if (wrappers.length && names.length < 3) names.push(`${wrappers.length} 台 Twitch 容器`);
                    preparationWaiting = count ? `仍等待 ${count} 台就緒${names.length ? '（' + names.join('、') + (count > 3 ? '等' : '') + '）' : ''}；已就緒的台會先處理。` : '';
                    if (lastRecoveryStatus) showRecoveryStatus(lastRecoveryStatus);
                }
            });
            preparation = token;
            return token.promise.then(() => {
                if (preparation !== token) return;
                unreadyWrappers = pendingWrappers().length;
                preparationWaiting = '';
                preparation = null;
            });
        }
        function showRecoveryStatus(value) {
            if (disposed || !recoveryStatus) return;
            lastRecoveryStatus = value;
            const running = value.phase === 'preparing' || value.phase === 'checking';
            detectButton.disabled = running;
            detectButton.setAttribute('aria-busy', String(running));
            quickDetect.disabled = running;
            quickDetect.setAttribute('aria-busy', String(running));
            let text;
            if (value.phase === 'preparing') text = '正在偵測，等待播放器載入…';
            else if (value.phase === 'checking') text = `正在檢查 ${value.checked}／${value.total} 台；已嘗試恢復 ${value.attempted} 台…`;
            else if (value.phase === 'cancelled') text = '已取消上一輪偵測。';
            else {
                const skipped = value.skipped || {};
                const details = [[skipped.playing, '台已在播放或緩衝'], [value.recovered, '台已恢復'],
                    [value.waiting, '台尚未確認播放'], [value.failed, '台未能恢復'],
                    [(skipped.unsupported || 0) + (skipped.unknown || 0), '台未支援或未就緒'],
                    [(skipped.busy || 0) + (skipped.stale || 0), '台已略過'], [unreadyWrappers, '台播放器未載入']]
                    .filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
                const total = value.total + unreadyWrappers;
                text = total ? `已檢查 ${value.checked}／${total} 台：${details.join('；')}。` : '沒有找到播放器，請先開始觀看。';
            }
            if (running && preparationWaiting) text += ' ' + preparationWaiting;
            recoveryStatus.textContent = text;
            toggle.title = text;
            quickDetect.title = text;
        }
        function runRecovery(reason, generation = ++recoveryStartGeneration) {
            if (disposed || !recoveryFlow || generation !== recoveryStartGeneration) return Promise.resolve();
            return afterAudioFocus(() => {
                if (disposed || generation !== recoveryStartGeneration) return;
                return recoveryFlow.run({ reason });
            });
        }
        function cancelPendingRecovery() {
            recoveryStartGeneration++;
            if (watchStartTimer !== null) win.clearTimeout(watchStartTimer);
            watchStartTimer = null;
        }
        function scheduleRecoveryAfterLayout(reason) {
            if (disposed) return;
            cancelPendingRecovery();
            const generation = recoveryStartGeneration;
            showAudioFocusStatus({ phase: 'cancelled' });
            void audioFocusFlow?.cancel();
            recoveryFlow?.cancel();
            clearPreparation();
            // A new task observes the completed selection/layout, including
            // retained players and SDK wrappers whose media is still loading.
            watchStartTimer = win.setTimeout(() => {
                watchStartTimer = null;
                void runRecovery(reason, generation);
            }, 0);
        }
        function onWatchStart(event) {
            if (disposed || !isWatchStartTarget(event.target)) return;
            scheduleRecoveryAfterLayout('start');
        }
        function onBookmarkRestored(event) {
            if (disposed || event.target !== doc.getElementById('multi-stream-container')) return;
            scheduleRecoveryAfterLayout('bookmark');
        }
        function addRow(entry) {
            const row = node('section', null, { class: 'player', 'data-player-id': String(entry.id) });
            entry.row = row;
            entry.name = node('strong', '播放器');
            entry.status = node('div', '正在偵測播放器…', { class: 'state', role: 'status' });
            entry.volume = node('input', null, { type: 'range', min: '0', max: '100', step: '1', value: '100', 'aria-label': '播放器音量' });
            entry.level = node('span', '—', { class: 'level' });
            entry.mute = node('button', '靜音', { type: 'button', 'aria-pressed': 'false' });
            entry.recover = node('button', '恢復播放', { type: 'button' });
            const controls = node('div', null, { class: 'row' });
            controls.append(entry.volume, entry.level, entry.mute, entry.recover);
            row.append(entry.name, controls, entry.status);
            list.appendChild(row);
            observeEntryHover(entry);
            entry.volume.addEventListener('input', () => { entry.level.textContent = `${entry.volume.value}%`; });
            entry.volume.addEventListener('change', () => { const value = Number(entry.volume.value) / 100; void afterAudioFocus(() => execute(entry, { action: 'setVolume', value })); });
            entry.mute.addEventListener('click', () => { const value = !entry.result?.state?.muted; void afterAudioFocus(() => execute(entry, { action: 'setMuted', value })); });
            entry.recover.addEventListener('click', () => { void afterAudioFocus(() => execute(entry, { action: 'recover' })); });
        }
        function clearProbeTimers(entry) {
            entry.probeTimers.forEach(timer => win.clearTimeout(timer));
            entry.probeTimers = [];
        }
        function probe(entry, reset = false) {
            if (entry.kind !== 'frame') return;
            if (reset) {
                clearProbeTimers(entry);
                entry.target = null;
                entry.generation++;
                entry.busy = false;
                entry.result = null;
                entry.notice = '正在偵測；沒有回應時請確認' + permissionHint + '。';
            }
            try { entry.frame.contentWindow.postMessage(envelope('frame:probe'), new URL(entry.frame.src, win.location.href).origin); } catch (_) {}
            renderEntry(entry);
        }
        function scheduleProbe(entry) {
            probe(entry, true);
            for (const delay of [1000, 3000]) entry.probeTimers.push(win.setTimeout(() => { if (!entry.target && entry.element.isConnected) probe(entry); }, delay));
        }
        function removeEntry(entry) {
            if (revealedEntry === entry) revealedEntry = null;
            entry.hoverCleanup?.();
            clearProbeTimers(entry);
            entry.generation++;
            entry.unsubscribe?.();
            entry.controller?.dispose();
            if (entry.frame) entry.frame.removeEventListener('load', entry.onLoad);
            entry.row?.remove();
            entries.delete(entry.element);
        }
        function scan() {
            scanTimer = null;
            if (disposed || !list) return;
            const container = doc.getElementById('multi-stream-container');
            const desired = new Set();
            if (container) for (const element of container.children) {
                const frame = element.tagName === 'IFRAME' ? element : element.querySelector('iframe');
                const video = element.matches('video,audio') ? element : element.querySelector('video,audio');
                if (!frame && !video) continue;
                desired.add(element);
                let entry = entries.get(element);
                if (entry && (entry.frame !== frame || entry.source !== (frame?.src || ''))) { removeEntry(entry); entry = null; }
                if (!entry) {
                    entry = { element, frame, source: frame?.src || '', id: ++sequence, generation: 0, busy: false, target: null, result: null, probeTimers: [] };
                    entry.kind = frame ? cfg.isPlayerUrl(frame.src) ? 'frame' : 'unsupported' : 'native';
                    entries.set(element, entry);
                    addRow(entry);
                    if (entry.kind === 'native') {
                        entry.controller = factory.createMediaController({ document: doc, scope: element });
                        entry.unsubscribe = entry.controller.subscribe(result => applyResult(entry, result));
                        applyResult(entry, entry.controller.getState());
                        if (globalMuted !== null) void execute(entry, { action: 'setMuted', value: globalMuted });
                    } else if (entry.kind === 'frame') {
                        entry.onLoad = () => scheduleProbe(entry);
                        frame.addEventListener('load', entry.onLoad);
                        scheduleProbe(entry);
                    } else entry.notice = '此播放器網域未支援；請使用播放器內的控制。';
                }
            }
            for (const entry of [...entries.values()]) if (!desired.has(entry.element)) removeEntry(entry);
            const ordered = currentEntries(), nextOrder = ordered.map(entry => entry.id).join(',');
            if (nextOrder !== revealOrder) { revealOrder = nextOrder; revealedEntry = null; }
            ordered.forEach((entry, index) => {
                entry.name.textContent = describe(entry, index);
                entry.row.style.order = String(index);
                entry.volume.setAttribute('aria-label', `${entry.name.textContent} 音量`);
                renderEntry(entry);
            });
            refreshSummary();
            updateHighlights();
            scheduleHighlights();
        }
        function queueScan() { if (scanTimer === null) scanTimer = win.setTimeout(scan, 80); }
        function onFrameMessage(event) {
            const data = event.data;
            if (!data || data.channel !== messageChannel || data.version !== messageVersion || data.type !== 'frame:ready' ||
                !Number.isInteger(data.frameId) || data.frameId <= 0 || typeof data.token !== 'string' || !/^[a-zA-Z0-9_-]{32,128}$/.test(data.token) || !validResult(data.result)) return;
            for (const entry of entries.values()) {
                if (entry.kind !== 'frame' || event.source !== entry.frame.contentWindow) continue;
                let origin;
                try { origin = new URL(entry.frame.src, win.location.href).origin; } catch (_) { return; }
                if (event.origin !== origin || !cfg.isPlayerUrl(entry.frame.src)) return;
                const first = !entry.target || entry.target.token !== data.token;
                if (first) { entry.generation++; entry.busy = false; }
                entry.target = { frameId: data.frameId, token: data.token, documentId: typeof data.documentId === 'string' ? data.documentId : null };
                clearProbeTimers(entry);
                applyResult(entry, data.result);
                if (first && globalMuted !== null) void execute(entry, { action: 'setMuted', value: globalMuted });
                return;
            }
        }
        function audioFocusSnapshot() {
            const container = doc.getElementById('multi-stream-container');
            return Array.from(container?.children || []).map(element => {
                const entry = entries.get(element);
                return { key: element, identity: entry || element, entry, generation: entry?.generation ?? -1,
                    name: entry?.name?.textContent || element.getAttribute('data-channel-name') || '尚未載入的播放器',
                    state: entry?.result?.state };
            });
        }
        function refreshAudioFocus() {
            scan();
            const time = Date.now();
            for (const entry of entries.values()) {
                if (entry.busy) continue;
                if (entry.kind === 'native') applyResult(entry, entry.controller.getState());
                else if (entry.kind === 'frame' && (!entry.audioFocusProbeAt || time - entry.audioFocusProbeAt >= 1000)) {
                    entry.audioFocusProbeAt = time;
                    probe(entry);
                }
            }
        }
        function showAudioFocusStatus(value) {
            if (!audioFocusStatus || disposed) return;
            const reasons = { unsupported: '未支援聲音控制', pending: '尚未就緒或仍在操作', stale: '播放器已更換', changed: '播放器狀態已改變',
                'volume-unsupported': '未支援音量控制', 'volume-unconfirmed': '未能確認音量已設為 100%',
                unconfirmed: '未確認靜音', unavailable: '控制未能連接', timeout: '控制逾時' };
            let text = '';
            if (value.phase === 'preparing') text = '正在將所有播放器靜音，再只開啟放大格的聲音…';
            else if (value.phase === 'focused') text = `已靜音其他播放器，只開啟「${value.name}」的聲音（音量 100%）。`;
            else if (value.phase === 'removed') text = '放大格已移除或更換，已取消開聲。';
            else if (value.phase === 'partial') text = `未開啟放大格的聲音；${value.failures.map(item => `${item.name}：${reasons[item.code] || item.code}`).join('；')}。請確認後重新按放大。`;
            audioFocusStatus.textContent = text;
            audioFocusStatus.hidden = !text;
            if (toggle) {
                if (text) toggle.title = text;
                else toggle.removeAttribute('title');
            }
        }
        function onAudioFocus(event) {
            const container = doc.getElementById('multi-stream-container');
            // A plain bubbling event works across Firefox userscript sandboxes;
            // only a current pane itself may request focus, never its inner DOM.
            if (disposed || !audioFocusFlow || !container || event.target?.parentElement !== container) return;
            cancelPendingRecovery();
            recoveryFlow?.cancel();
            clearPreparation();
            if (watchStartTimer !== null) { win.clearTimeout(watchStartTimer); watchStartTimer = null; }
            globalMuted = true;
            win.postMessage(envelope('site:audio-preference', { muted: true }), win.location.origin);
            refreshSummary();
            void audioFocusFlow.request(event.target);
        }
        function originalMuteClick(event) {
            if (!event.target?.closest?.('#toggle-all-audio')) return;
            if (!entries.size) { showAudioFocusStatus({ phase: 'cancelled' }); void audioFocusFlow?.cancel(); return; }
            event.preventDefault();
            event.stopImmediatePropagation();
            const available = currentEntries().filter(entry => can(entry, 'setMuted'));
            const muted = aggregateAudio(available.map(entry => entry.result.state)).muted;
            setGlobalMuted(!muted);
        }
        function mount() {
            if (disposed || host) return Boolean(host);
            const input = doc.getElementById('input-container');
            const container = doc.getElementById('multi-stream-container');
            if (!input || !container) return false;
            host = node('span', null, { id: 'umininn-player-control-host' });
            host.style.cssText = 'display:inline-flex;align-items:center;gap:4px;height:18px;flex-shrink:0;';
            shadow = host.attachShadow({ mode: 'open' });
            const style = node('style', `:host{font:12px system-ui,sans-serif;color:#eee}*{box-sizing:border-box}button,input{font:inherit}button{background:#292d36;color:#fff;border:1px solid #596172;border-radius:5px;cursor:pointer;padding:4px 7px}button:disabled,input:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid #58c8ff;outline-offset:2px}#toggle{height:18px;min-height:18px;line-height:16px;padding:0 5px;font-size:11px;white-space:nowrap}#panel{position:fixed;right:12px;top:44px;width:min(470px,calc(100vw - 24px));max-height:75vh;overflow:auto;z-index:2147483646;background:#16191f;border:1px solid #657084;border-radius:10px;padding:12px;box-shadow:0 8px 28px #0009}#panel[hidden]{display:none}.row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.heading{justify-content:space-between}.state,#summary,.help{color:#bac5d7;font-size:11px;line-height:1.5;margin:5px 0;overflow-wrap:anywhere}#players{display:flex;flex-direction:column;gap:8px}.player{border-top:1px solid #3c4351;padding-top:8px}.player strong{display:block;margin-bottom:5px;overflow-wrap:anywhere}.player input{width:140px;max-width:32vw}.level{min-width:34px;text-align:right}.master{margin:9px 0}a{color:#83cfff}`);
            style.textContent += '.player[data-player-highlighted="true"]{background:#193a50;box-shadow:inset 0 0 0 2px #58c8ff;border-radius:5px}';
            highlightStyle = node('style', '#umininn-player-hover-layer{position:absolute;inset:0;z-index:12;pointer-events:none;overflow:hidden;contain:layout paint}#umininn-player-hover-layer[hidden]{display:none}#umininn-player-hover-layer .umininn-player-ring-viewport{position:absolute;overflow:hidden;pointer-events:none}#umininn-player-hover-layer [data-player-ring]{position:absolute;display:block;box-sizing:border-box;box-shadow:inset 0 0 0 3px #58c8ff;pointer-events:none}#multi-stream-container .kick-wrapper,#multi-stream-container .kick-iframe{border-radius:0}', { id: 'umininn-player-highlight-style' });
            (doc.head || doc.documentElement).appendChild(highlightStyle);
            highlightLayer = node('div', null, { id: 'umininn-player-hover-layer', 'aria-hidden': 'true', hidden: '' });
            highlightViewport = node('div', null, { class: 'umininn-player-ring-viewport' }); highlightLayer.appendChild(highlightViewport);
            const highlightRoot = doc.getElementById('multi-stream-container-wrapper') || doc.body;
            if (highlightRoot === doc.body) highlightLayer.style.position = 'fixed';
            highlightRoot.appendChild(highlightLayer);
            if (typeof win.ResizeObserver === 'function') {
                highlightResizeObserver = new win.ResizeObserver(scheduleHighlights);
                highlightResizeObserver.observe(container); highlightResizeObserver.observe(highlightRoot);
            }
            toggle = node('button', '🎚 播放控制', { id: 'toggle', type: 'button', 'aria-expanded': 'false', 'aria-haspopup': 'dialog' });
            const quickMute = node('button', '🔇', { id: 'quick-mute', type: 'button', title: '全部靜音', 'aria-label': '全部靜音' });
            quickMute.style.cssText = 'height:18px;min-height:18px;width:22px;line-height:16px;padding:0;font-size:12px;';
            quickDetect = node('button', '↻ 偵測恢復', { id: 'quick-recover', type: 'button', title: '重新偵測全部播放器，未播放的台各嘗試恢復一次' });
            quickDetect.style.cssText = 'height:18px;min-height:18px;line-height:16px;padding:0 5px;font-size:11px;white-space:nowrap;';
            panel = node('section', null, { id: 'panel', role: 'dialog', 'aria-label': '播放器控制' });
            panel.hidden = true;
            const heading = node('div', null, { class: 'row heading' });
            const close = node('button', '關閉', { type: 'button' });
            heading.append(node('strong', '播放器控制' + (cfg.DISPLAY_VERSION ? ' · ' + cfg.DISPLAY_VERSION : '')), close);
            summary = node('div', '正在偵測播放器…', { id: 'summary', role: 'status', 'aria-live': 'polite' });
            audioFocusStatus = node('div', '', { id: 'audio-focus-status', class: 'state', role: 'status', 'aria-live': 'polite', hidden: '' });
            const master = node('div', null, { class: 'row master' });
            const mute = node('button', '全部靜音', { type: 'button' });
            const unmute = node('button', '全部開聲', { type: 'button' });
            const volume = node('input', null, { type: 'range', min: '0', max: '100', value: '100', 'aria-label': '全部播放器音量' });
            const masterLevel = node('span', '100%');
            masterVolume = volume;
            masterReadout = masterLevel;
            master.append(mute, unmute, node('label', '總音量'), volume, masterLevel);
            detectButton = node('button', '偵測並恢復未播放', { id: 'recover-all', type: 'button' });
            recoveryStatus = node('div', '按一下偵測全部播放器，並對未播放的台嘗試恢復一次。', { id: 'recovery-status', class: 'state', role: 'status', 'aria-live': 'polite' });
            const help = node('p', 'Twitch 會先嘗試平台播放鍵；瀏覽器拒絕時，請在播放器內按 Play。影片未載入時暫不可調整聲音；未授權或未知網域不能控制。', { class: 'help' });
            list = node('div', null, { id: 'players' });
            panel.append(heading, summary, audioFocusStatus, master, detectButton, recoveryStatus, help, list);
            // The real toolbar contains layout/paint and clips overflow. A fixed
            // descendant is still trapped there; mount the panel outside it.
            panelHost = node('div', null, { id: 'umininn-player-panel-host' });
            panelHost.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;display:block;';
            panelShadow = panelHost.attachShadow({ mode: 'open' });
            panelShadow.append(style.cloneNode(true), node('style', '#panel{pointer-events:auto;}'), panel);
            shadow.append(style, quickMute, toggle, quickDetect);
            input.appendChild(host);
            doc.body.appendChild(panelHost);
            panel.addEventListener('scroll', updateHighlights, true);
            panel.addEventListener('scroll', scheduleHighlights, true);
            let idleTimer = null;
            const activityEvents = ['pointerdown', 'pointermove', 'pointerup', 'click', 'keydown', 'keyup', 'input', 'change', 'wheel', 'touchstart', 'touchmove', 'touchend'];
            function clearIdleTimer() {
                if (idleTimer !== null) win.clearTimeout(idleTimer);
                idleTimer = null;
            }
            function armIdleTimer() {
                clearIdleTimer();
                idleTimer = win.setTimeout(() => {
                    idleTimer = null;
                    if (disposed || panel.hidden) return;
                    const restoreFocus = panel.contains(panelShadow.activeElement);
                    setOpen(false);
                    if (restoreFocus) toggle.focus({ preventScroll: true });
                }, 30000);
            }
            function onPanelActivity(event) {
                // Status updates, scripted clicks/focus and restored scrollTop
                // are not user activity. Wheel/keys/pointer movement cover scrolling.
                if (event.isTrusted && !disposed && !panel.hidden) armIdleTimer();
            }
            function onPanelPageHide() {
                setOpen(false);
                cancelPendingRecovery();
                recoveryFlow?.cancel();
                clearPreparation();
            }
            for (const type of activityEvents) panel.addEventListener(type, onPanelActivity, { capture: true, passive: true });
            win.addEventListener('pagehide', onPanelPageHide);
            panelIdleCleanup = () => {
                clearIdleTimer();
                for (const type of activityEvents) panel.removeEventListener(type, onPanelActivity, true);
                win.removeEventListener('pagehide', onPanelPageHide);
            };
            function setOpen(open) {
                clearIdleTimer();
                panel.hidden = !open;
                doc.documentElement.toggleAttribute('data-umininn-player-controls-open', open);
                toggle.setAttribute('aria-expanded', String(open));
                updateHighlights();
                scheduleHighlights();
                if (open) {
                    positionPanel();
                    scan();
                    for (const entry of entries.values()) if (!entry.target) probe(entry);
                    close.focus({ preventScroll: true });
                    armIdleTimer();
                }
            }
            toggle.addEventListener('click', () => setOpen(panel.hidden));
            close.addEventListener('click', () => { setOpen(false); toggle.focus(); });
            function onKeyDown(event) {
                if (event.key === 'Escape' && !panel.hidden) {
                    event.stopPropagation();
                    setOpen(false);
                    toggle.focus();
                }
            }
            shadow.addEventListener('keydown', onKeyDown);
            panelShadow.addEventListener('keydown', onKeyDown);
            win.addEventListener('resize', positionPanel);
            win.addEventListener('scroll', positionPanel, true);
            mute.addEventListener('click', () => { setGlobalMuted(true); });
            quickMute.addEventListener('click', () => { setGlobalMuted(true); });
            unmute.addEventListener('click', () => { setGlobalMuted(false); });
            volume.addEventListener('input', () => { masterLevel.textContent = `${volume.value}%`; });
            volume.addEventListener('change', () => { const value = Number(volume.value) / 100; void afterAudioFocus(() => applyAll({ action: 'setVolume', value })); });
            audioFocusFlow = createAudioFocusFlow({
                clock: win, snapshot: audioFocusSnapshot, refresh: refreshAudioFocus,
                readiness(item) {
                    const entry = item.entry;
                    if (entry?.kind === 'unsupported') return 'unsupported';
                    if (!entry || entry.busy || !can(entry, 'setMuted')) return 'pending';
                    return 'ready';
                },
                isCurrent(item) {
                    return item.key.parentElement === doc.getElementById('multi-stream-container') && item.key.isConnected &&
                        (item.entry ? entries.get(item.key) === item.entry && isCurrent(item.entry, item.generation) : !entries.has(item.key));
                },
                canSetVolume: item => Boolean(item.entry && can(item.entry, 'setVolume')),
                execute: (item, command) => isCurrent(item.entry, item.generation) ? execute(item.entry, command) : Promise.resolve({ ok: false, code: 'stale' }),
                onStatus: showAudioFocusStatus
            });
            if (recoveryFactory?.createRecoveryFlow) {
                recoveryFlow = recoveryFactory.createRecoveryFlow({
                    clock: win, concurrency: 4, operationTimeoutMs: 6000,
                    prepare: prepareRecovery,
                    getEntries: () => currentEntries().filter(entry => preparedCohort.has(entry.element)),
                    refresh: entry => execute(entry, { action: 'getState' }),
                    isReady: isRecoveryReady,
                    recover: entry => execute(entry, { action: 'recover' }),
                    isCurrent, onStatus: showRecoveryStatus
                });
            } else {
                detectButton.disabled = true;
                quickDetect.disabled = true;
                recoveryStatus.textContent = '批次控制未載入，請重新載入擴充功能及網頁。';
            }
            detectButton.addEventListener('click', () => { void runRecovery('manual'); });
            quickDetect.addEventListener('click', () => { void runRecovery('manual'); });
            observer = new win.MutationObserver(() => { queueScan(); scheduleHighlights(); });
            observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'class', 'style', 'hidden', 'data-channel-name', 'data-channel-key'] });
            highlightObserver = new win.MutationObserver(records => {
                for (const record of records) {
                    if (record.type === 'childList') { updateHighlights(); break; }
                    const entry = entries.get(record.target);
                    if (entry) updateHighlight(entry);
                }
                paintHighlights();
            });
            highlightObserver.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: [selectionHighlight] });
            doc.addEventListener('click', originalMuteClick, true);
            doc.addEventListener('click', onWatchStart, true);
            doc.addEventListener('umininn-player-bookmark-restored', onBookmarkRestored, true);
            doc.addEventListener('umininn-player-audio-focus', onAudioFocus, true);
            doc.addEventListener('pointerover', windowControlsPointer, true);
            doc.addEventListener('pointerout', windowControlsPointer, true);
            doc.addEventListener('pointermove', windowControlsPointer, true);
            doc.addEventListener('visibilitychange', onHighlightVisibility);
            doc.addEventListener('fullscreenchange', onHighlightFullscreen);
            doc.addEventListener('webkitfullscreenchange', onHighlightFullscreen);
            win.addEventListener('message', onFrameMessage);
            scan();
            return true;
        }
        function start() {
            if (!mount()) {
                lateObserver = new win.MutationObserver(() => { if (mount()) { lateObserver.disconnect(); lateObserver = null; } });
                lateObserver.observe(doc.documentElement, { childList: true, subtree: true });
            }
        }
        function dispose() {
            if (disposed) return;
            disposed = true;
            cancelPendingRecovery();
            revealedEntry = null;
            doc.documentElement.removeAttribute('data-umininn-player-controls-open');
            panelIdleCleanup?.();
            panelIdleCleanup = null;
            recoveryFlow?.dispose();
            audioFocusFlow?.dispose();
            clearPreparation();
            if (watchStartTimer !== null) win.clearTimeout(watchStartTimer);
            if (scanTimer !== null) win.clearTimeout(scanTimer);
            if (highlightFrame !== null) win.cancelAnimationFrame(highlightFrame);
            highlightFrame = null;
            observer?.disconnect(); lateObserver?.disconnect(); highlightObserver?.disconnect(); highlightResizeObserver?.disconnect();
            for (const entry of [...entries.values()]) removeEntry(entry);
            doc.removeEventListener('click', originalMuteClick, true);
            doc.removeEventListener('click', onWatchStart, true);
            doc.removeEventListener('umininn-player-bookmark-restored', onBookmarkRestored, true);
            doc.removeEventListener('umininn-player-audio-focus', onAudioFocus, true);
            doc.removeEventListener('pointerover', windowControlsPointer, true);
            doc.removeEventListener('pointerout', windowControlsPointer, true);
            doc.removeEventListener('pointermove', windowControlsPointer, true);
            doc.removeEventListener('visibilitychange', onHighlightVisibility);
            doc.removeEventListener('fullscreenchange', onHighlightFullscreen);
            doc.removeEventListener('webkitfullscreenchange', onHighlightFullscreen);
            win.removeEventListener('message', onFrameMessage);
            win.removeEventListener('resize', positionPanel);
            win.removeEventListener('scroll', positionPanel, true);
            host?.remove();
            panelHost?.remove();
            panel?.removeEventListener('scroll', updateHighlights, true);
            panel?.removeEventListener('scroll', scheduleHighlights, true);
            highlightStyle?.remove();
            highlightLayer?.remove(); highlightRings.clear();
        }
        return { start, dispose, scan };
    }
    if (typeof module === 'object' && module.exports) module.exports = { createSiteController, validResult, aggregateAudio, canControl, isWatchStartTarget, isRecoveryReady, createReadinessPass, createAudioFocusFlow };
    // Firefox's content-script global inherits from Window but is not Window itself.
    const contentWindow = root.window;
    if (contentWindow && config && media && runtime && contentWindow.top === contentWindow && config.isSiteUrl(contentWindow.location.href) && !contentWindow.document.getElementById('umininn-player-control-host')) {
        const controller = createSiteController({ window: contentWindow, document: contentWindow.document, runtime, config, media });
        controller.start();
        contentWindow.addEventListener('pagehide', event => { if (!event.persisted) controller.dispose(); });
    }
})(globalThis);
