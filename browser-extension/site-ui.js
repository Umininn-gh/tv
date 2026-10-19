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
        let host, shadow, panelHost, panelShadow, toggle, quickDetect, panel, list, summary, observer, lateObserver, masterVolume, masterReadout, detectButton, recoveryStatus, recoveryFlow;
        let sequence = 0, scanTimer = null, disposed = false, globalMuted = null;
        let preparation = null, preparedCohort = new Set(), watchStartTimer = null, unreadyWrappers = 0;
        let preparationWaiting = '', lastRecoveryStatus = null;
        let panelIdleCleanup = null;

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

        function setGlobalMuted(muted) {
            globalMuted = muted;
            // Keep the site's selection metadata in step without invoking its
            // fallback audio handler, which can reload cross-origin frames.
            win.postMessage(envelope('site:audio-preference', { muted }), win.location.origin);
            refreshSummary();
            void applyAll({ action: 'setMuted', value: muted });
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
        function runRecovery(reason) {
            if (disposed || !recoveryFlow) return Promise.resolve();
            return recoveryFlow.run({ reason });
        }
        function onWatchStart(event) {
            if (disposed || !isWatchStartTarget(event.target)) return;
            recoveryFlow?.cancel();
            clearPreparation();
            if (watchStartTimer !== null) win.clearTimeout(watchStartTimer);
            // The page's inline handler runs after this capture listener. A new task
            // sees its complete selection, including retained players and empty SDK wrappers.
            watchStartTimer = win.setTimeout(() => {
                watchStartTimer = null;
                void runRecovery('start');
            }, 0);
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
            entry.volume.addEventListener('input', () => { entry.level.textContent = `${entry.volume.value}%`; });
            entry.volume.addEventListener('change', () => { void execute(entry, { action: 'setVolume', value: Number(entry.volume.value) / 100 }); });
            entry.mute.addEventListener('click', () => { void execute(entry, { action: 'setMuted', value: !entry.result?.state?.muted }); });
            entry.recover.addEventListener('click', () => { void execute(entry, { action: 'recover' }); });
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
            currentEntries().forEach((entry, index) => {
                entry.name.textContent = describe(entry, index);
                entry.row.style.order = String(index);
                entry.volume.setAttribute('aria-label', `${entry.name.textContent} 音量`);
                renderEntry(entry);
            });
            refreshSummary();
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
        function originalMuteClick(event) {
            if (!event.target?.closest?.('#toggle-all-audio') || !entries.size) return;
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
            toggle = node('button', '🎚 播放控制', { id: 'toggle', type: 'button', 'aria-expanded': 'false', 'aria-haspopup': 'dialog' });
            quickDetect = node('button', '↻ 偵測恢復', { id: 'quick-recover', type: 'button', title: '重新偵測全部播放器，未播放的台各嘗試恢復一次' });
            quickDetect.style.cssText = 'height:18px;min-height:18px;line-height:16px;padding:0 5px;font-size:11px;white-space:nowrap;';
            panel = node('section', null, { id: 'panel', role: 'dialog', 'aria-label': '播放器控制' });
            panel.hidden = true;
            const heading = node('div', null, { class: 'row heading' });
            const close = node('button', '關閉', { type: 'button' });
            heading.append(node('strong', '播放器控制' + (cfg.DISPLAY_VERSION ? ' · ' + cfg.DISPLAY_VERSION : '')), close);
            summary = node('div', '正在偵測播放器…', { id: 'summary', role: 'status', 'aria-live': 'polite' });
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
            panel.append(heading, summary, master, detectButton, recoveryStatus, help, list);
            // The real toolbar contains layout/paint and clips overflow. A fixed
            // descendant is still trapped there; mount the panel outside it.
            panelHost = node('div', null, { id: 'umininn-player-panel-host' });
            panelHost.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;display:block;';
            panelShadow = panelHost.attachShadow({ mode: 'open' });
            panelShadow.append(style.cloneNode(true), node('style', '#panel{pointer-events:auto;}'), panel);
            shadow.append(style, toggle, quickDetect);
            input.appendChild(host);
            doc.body.appendChild(panelHost);
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
            function onPanelPageHide() { setOpen(false); }
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
                toggle.setAttribute('aria-expanded', String(open));
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
            unmute.addEventListener('click', () => { setGlobalMuted(false); });
            volume.addEventListener('input', () => { masterLevel.textContent = `${volume.value}%`; });
            volume.addEventListener('change', () => { void applyAll({ action: 'setVolume', value: Number(volume.value) / 100 }); });
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
            observer = new win.MutationObserver(queueScan);
            observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'class', 'style'] });
            doc.addEventListener('click', originalMuteClick, true);
            doc.addEventListener('click', onWatchStart, true);
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
            panelIdleCleanup?.();
            panelIdleCleanup = null;
            recoveryFlow?.dispose();
            clearPreparation();
            if (watchStartTimer !== null) win.clearTimeout(watchStartTimer);
            if (scanTimer !== null) win.clearTimeout(scanTimer);
            observer?.disconnect(); lateObserver?.disconnect();
            for (const entry of [...entries.values()]) removeEntry(entry);
            doc.removeEventListener('click', originalMuteClick, true);
            doc.removeEventListener('click', onWatchStart, true);
            win.removeEventListener('message', onFrameMessage);
            win.removeEventListener('resize', positionPanel);
            win.removeEventListener('scroll', positionPanel, true);
            host?.remove();
            panelHost?.remove();
        }
        return { start, dispose, scan };
    }
    if (typeof module === 'object' && module.exports) module.exports = { createSiteController, validResult, aggregateAudio, canControl, isWatchStartTarget, isRecoveryReady, createReadinessPass };
    // Firefox's content-script global inherits from Window but is not Window itself.
    const contentWindow = root.window;
    if (contentWindow && config && media && runtime && contentWindow.top === contentWindow && config.isSiteUrl(contentWindow.location.href) && !contentWindow.document.getElementById('umininn-player-control-host')) {
        const controller = createSiteController({ window: contentWindow, document: contentWindow.document, runtime, config, media });
        controller.start();
        contentWindow.addEventListener('pagehide', event => { if (!event.persisted) controller.dispose(); });
    }
})(globalThis);
