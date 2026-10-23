/* Cross-origin player controls for a userscript manager; no extension APIs. */
(function (root) {
    'use strict';
    const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
    const validToken = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{32,128}$/.test(value);
    const validFrame = value => Number.isSafeInteger(value) && value > 0;
    const validRequest = (id, sequence) => validFrame(sequence) && typeof id === 'string' && /^[0-9a-f]{48}_[0-9a-z]{1,11}$/.test(id) && id.endsWith(`_${sequence.toString(36)}`);
    const fail = (code, message) => ({ ok: false, code, message, state: null });
    function validCommand(value) {
        if (!object(value) || Object.keys(value).some(key => !['action', 'value', 'guard', 'focus'].includes(key))) return false;
        if ('guard' in value && (value.action !== 'setMuted' || value.value !== true || value.guard !== true)) return false;
        if ('focus' in value && (value.focus !== true || 'guard' in value ||
            !(value.action === 'setVolume' && value.value === 1 || value.action === 'setMuted' && value.value === false))) return false;
        if (value.action === 'setVolume') return typeof value.value === 'number' && Number.isFinite(value.value) && value.value >= 0 && value.value <= 1;
        if (value.action === 'setMuted') return typeof value.value === 'boolean';
        return ['getState', 'recover'].includes(value.action) && value.value === undefined;
    }
    function safeState(value) {
        if (!object(value)) return null;
        const result = {};
        for (const field of ['available', 'muted', 'paused', 'ended', 'recovering', 'recoverSupported', 'platformRecoverSupported', 'volumeSupported', 'muteSupported', 'muteGuardActive', 'focusRestorePending', 'disposed']) {
            if (typeof value[field] === 'boolean' || value[field] === null) result[field] = value[field];
        }
        for (const [field, min, max] of [['volume', 0, 1], ['readyState', 0, 4], ['errorCode', 0, 4], ['mediaId', 1, Number.MAX_SAFE_INTEGER]]) {
            if (value[field] === null) result[field] = null;
            else if (typeof value[field] === 'number' && Number.isFinite(value[field]) && value[field] >= min && value[field] <= max) result[field] = value[field];
        }
        if (Number.isSafeInteger(value.audioUserRevision) && value.audioUserRevision >= 0) result.audioUserRevision = value.audioUserRevision;
        if (['video', 'audio', null].includes(value.mediaType)) result.mediaType = value.mediaType;
        if (['no-media', 'error', 'blocked', 'ended', 'waiting', 'paused', 'playing'].includes(value.playbackStatus)) result.playbackStatus = value.playbackStatus;
        return result;
    }
    function safeResult(value) {
        if (!object(value) || typeof value.ok !== 'boolean') return fail('INVALID_RESPONSE', '播放器沒有傳回有效狀態');
        return { ok: value.ok, code: typeof value.code === 'string' && /^[A-Za-z_-]{1,40}$/.test(value.code) ? value.code : value.ok ? 'OK' : 'CONTROL_FAILED',
            message: typeof value.message === 'string' ? value.message.slice(0, 240) : '', state: safeState(value.state) };
    }
    function randomHex(win) {
        const bytes = new Uint8Array(24);
        win.crypto.getRandomValues(bytes);
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }
    function envelope(config, type, fields = {}) { return { channel: config.CHANNEL, version: config.VERSION, type, ...fields }; }
    function isEnvelope(config, message, type) {
        return object(message) && message.channel === config.CHANNEL && message.version === config.VERSION && message.type === type;
    }
    function createSiteTransport(options) {
        const win = options.window, config = options.config, doc = win.document;
        if (win.top !== win || !config.isSiteUrl(win.location.href)) throw new TypeError('An approved top-level site is required');
        const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 4500;
        const registry = new Map(), pending = new Map(), resumeTimers = new Set(), sessionId = randomHex(win);
        let disposed = false, suspended = false, sequence = 0;
        function playerUrl(frame) {
            try {
                const url = new URL(frame.src, win.location.href);
                return url.protocol === 'https:' && config.isPlayerUrl(url.href) ? url : null;
            } catch (_) { return null; }
        }
        // Match the UI's supported player cohort: one iframe per direct child.
        function frames() {
            const container = doc.getElementById('multi-stream-container');
            if (!container || !container.isConnected) return [];
            return Array.from(container.children).map(element => element.tagName === 'IFRAME' ? element : element.querySelector('iframe')).filter(frame => frame?.isConnected);
        }
        function current(record) {
            if (!record.frame.isConnected || !frames().includes(record.frame) || record.frame.contentWindow !== record.source) return false;
            const url = playerUrl(record.frame);
            return Boolean(url && url.href === record.href && url.origin === record.origin);
        }
        function finish(id, result) {
            const request = pending.get(id);
            if (!request) return;
            pending.delete(id);
            win.clearTimeout(request.timer);
            request.resolve(result);
        }
        function forget(record) {
            if (registry.get(record.frameId) === record) registry.delete(record.frameId);
            record.frame.removeEventListener('load', record.onLoad);
            for (const [id, request] of pending) if (request.record === record) finish(id, fail('STALE_FRAME', '播放器已更換，請重新偵測'));
        }
        function prune() { for (const record of registry.values()) if (!current(record)) forget(record); }
        function clear(code) {
            for (const timer of resumeTimers) win.clearTimeout(timer);
            resumeTimers.clear();
            for (const record of [...registry.values()]) forget(record);
            for (const id of pending.keys()) finish(id, fail(code, '控制連線已關閉，請重新偵測'));
        }
        function onMessage(event) {
            if (disposed || suspended || !config.isSiteUrl(win.location.href)) return;
            const message = event.data;
            if (isEnvelope(config, message, 'frame:ready')) {
                if (!validFrame(message.frameId) || !validToken(message.token) || !validToken(message.documentId) || !object(message.result) || typeof message.result.ok !== 'boolean') return;
                const frame = frames().find(value => value.contentWindow === event.source);
                if (!frame) return;
                const url = playerUrl(frame);
                if (!url || url.origin !== event.origin) return;
                prune();
                const collision = registry.get(message.frameId);
                if (collision && collision.frame !== frame) return;
                const previous = [...registry.values()].find(record => record.frame === frame);
                if (previous && previous.frameId === message.frameId && previous.token === message.token && previous.documentId === message.documentId && current(previous)) return;
                if (previous) forget(previous);
                if (registry.size >= 128) return;
                const record = { frame, source: event.source, href: url.href, origin: url.origin, frameId: message.frameId, token: message.token, documentId: message.documentId };
                record.onLoad = () => forget(record);
                frame.addEventListener('load', record.onLoad);
                registry.set(record.frameId, record);
                return;
            }
            if (isEnvelope(config, message, 'frame:interaction')) {
                if (!validFrame(message.frameId) || !validToken(message.token) || !validToken(message.documentId)) return;
                const record = registry.get(message.frameId);
                if (!record) return;
                if (!current(record)) { forget(record); return; }
                if (event.source !== record.source || event.origin !== record.origin || message.token !== record.token || message.documentId !== record.documentId) return;
                // Relay only an authenticated interaction signal. The original
                // foreign-frame input continues untouched, even if it prevents
                // the browser's default focus transition.
                if (typeof win.CustomEvent === 'function' && typeof record.frame.dispatchEvent === 'function')
                    record.frame.dispatchEvent(new win.CustomEvent('umininn-player-interaction', { bubbles: true }));
                return;
            }
            if (!isEnvelope(config, message, 'userscript:result') || !validToken(message.requestId)) return;
            const request = pending.get(message.requestId);
            if (!request) return;
            const record = request.record;
            if (!current(record)) { forget(record); return; }
            if (event.source !== record.source || event.origin !== record.origin || message.token !== record.token || message.documentId !== record.documentId || message.frameId !== record.frameId || message.sessionId !== sessionId || message.sequence !== request.sequence) return;
            finish(message.requestId, safeResult(message.result));
        }
        function sendMessage(message) {
            if (disposed || suspended) return Promise.resolve(fail('DISPOSED', '控制連線已關閉'));
            if (win.top !== win || !config.isSiteUrl(win.location.href)) return Promise.resolve(fail('UNAUTHORIZED', '只可從原網站控制播放器'));
            if (!isEnvelope(config, message, 'site:command') || !object(message.target) || !validFrame(message.target.frameId) || !validToken(message.target.token) || !validToken(message.target.documentId) || !validCommand(message.command)) return Promise.resolve(fail('INVALID_COMMAND', '播放器或操作參數無效'));
            prune();
            const record = registry.get(message.target.frameId);
            if (!record || record.token !== message.target.token || record.documentId !== message.target.documentId) return Promise.resolve(fail('FRAME_UNAVAILABLE', '播放器未連線，請重新偵測'));
            if (pending.size >= 32) return Promise.resolve(fail('BUSY', '操作過多，請稍後再試'));
            if (sequence >= Number.MAX_SAFE_INTEGER) return Promise.resolve(fail('CONTROL_FAILED', '請重新載入網站以建立控制連線'));
            const requestSequence = ++sequence;
            let requestId;
            try { requestId = `${randomHex(win)}_${requestSequence.toString(36)}`; } catch (_) { return Promise.resolve(fail('CONTROL_FAILED', '未能建立安全控制連線')); }
            // A faulty crypto implementation must not overwrite an active request.
            if (pending.has(requestId)) return Promise.resolve(fail('BUSY', '操作過多，請稍後再試'));
            return new Promise(resolve => {
                const timer = win.setTimeout(() => finish(requestId, fail('TIMEOUT', '播放器未有回覆，請重新偵測')), timeoutMs);
                pending.set(requestId, { record, timer, resolve, sequence: requestSequence });
                try { record.source.postMessage(envelope(config, 'userscript:command', { requestId, sessionId, sequence: requestSequence, frameId: record.frameId, token: record.token, documentId: record.documentId, command: { ...message.command } }), record.origin); }
                catch (_) { finish(requestId, fail('FRAME_UNAVAILABLE', '播放器未連線，請重新偵測')); }
            });
        }
        function onHide(event) {
            if (!event.persisted) { dispose(); return; }
            suspended = true;
            clear('DISPOSED');
        }
        function onShow(event) {
            if (!event.persisted || disposed) return;
            suspended = false;
            // A restored child may receive its pageshow after the parent. These
            // three bounded handshakes reconnect it without permanent polling.
            for (const delay of [0, 1000, 3000]) {
                const timer = win.setTimeout(() => {
                    resumeTimers.delete(timer);
                    if (disposed || suspended || !config.isSiteUrl(win.location.href)) return;
                    prune();
                    for (const frame of frames().slice(0, 128)) {
                        if ([...registry.values()].some(record => record.frame === frame)) continue;
                        const url = playerUrl(frame);
                        if (url) try { frame.contentWindow.postMessage(envelope(config, 'frame:probe'), url.origin); } catch (_) {}
                    }
                }, delay);
                resumeTimers.add(timer);
            }
        }
        function dispose() {
            if (disposed) return;
            disposed = true;
            clear('DISPOSED');
            observer?.disconnect();
            win.removeEventListener('message', onMessage);
            win.removeEventListener('pagehide', onHide);
            win.removeEventListener('pageshow', onShow);
        }
        const observer = typeof win.MutationObserver === 'function' ? new win.MutationObserver(prune) : null;
        if (doc.documentElement) observer?.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
        win.addEventListener('message', onMessage);
        win.addEventListener('pagehide', onHide);
        win.addEventListener('pageshow', onShow);
        return { sendMessage, dispose };
    }
    function createFrameClient(options) {
        const win = options.window, config = options.config, media = options.media, twitch = options.twitch;
        const angelthump = options.angelthump;
        const parent = win.parent;
        let location;
        try { location = new URL(win.location.href); } catch (_) { return { dispose() {} }; }
        if (!parent || parent === win || location.protocol !== 'https:' || !config.isPlayerUrl(location.href)) return { dispose() {} };
        let disposed = false, suspended = false, controller = null, unsubscribe = null, reportTimer = null, logo = null;
        let parentOrigin = null, identity = null, lastResult = null, active = 0, generation = 0;
        let boundSession = null, highestSequence = 0;
        function approvedParent(event) { return event.source === parent && win.parent === parent && config.isSiteOrigin(event.origin); }
        function send(type, fields) {
            if (!disposed && !suspended && parentOrigin && win.parent === parent) {
                try { parent.postMessage(envelope(config, type, { ...identity, ...fields }), parentOrigin); } catch (_) {}
            }
        }
        function announce() {
            if (!controller || !identity) return;
            // A delayed command reply can describe an older mute setting.
            // Announcements represent the current controller, not that old reply.
            try { lastResult = safeResult(controller.getState()); } catch (_) { return; }
            send('frame:ready', { result: lastResult });
        }
        function report(result) {
            lastResult = safeResult(result);
            if (disposed || suspended || reportTimer !== null) return;
            reportTimer = win.setTimeout(() => { reportTimer = null; announce(); }, 100);
        }
        function onPlayerPointer(event) {
            if (event.isTrusted !== true || !controller || !identity) return;
            send('frame:interaction', {});
        }
        function start(origin) {
            if (controller) return;
            parentOrigin = origin;
            const bytes = new Uint32Array(1);
            win.crypto.getRandomValues(bytes);
            identity = { frameId: bytes[0] || 1, token: randomHex(win), documentId: randomHex(win) };
            const native = media.createMediaController({ document: win.document });
            try { controller = twitch?.createTwitchController({ document: win.document, location: win.location, mediaController: native }) || native; }
            catch (error) { native.dispose(); throw error; }
            lastResult = safeResult(controller.getState());
            unsubscribe = controller.subscribe(report);
            // Apply cosmetic changes only after this direct parent is approved.
            try { logo = angelthump?.createLogoController({ document: win.document, location: win.location }) || null; }
            catch (_) { /* Cosmetic failure must not interrupt playback controls. */ }
        }
        function onMessage(event) {
            if (disposed || suspended || !approvedParent(event)) return;
            const message = event.data;
            if (isEnvelope(config, message, 'frame:probe')) {
                if (parentOrigin && parentOrigin !== event.origin) return;
                try { start(event.origin); lastResult = safeResult(controller.getState()); announce(); } catch (_) {}
                return;
            }
            if (!controller || event.origin !== parentOrigin || !isEnvelope(config, message, 'userscript:command') || message.frameId !== identity.frameId || message.token !== identity.token || message.documentId !== identity.documentId || !validRequest(message.requestId, message.sequence) || !validToken(message.sessionId)) return;
            if (boundSession && boundSession !== message.sessionId || message.sequence <= highestSequence) return;
            boundSession = message.sessionId;
            highestSequence = message.sequence;
            const reply = result => send('userscript:result', { requestId: message.requestId, sessionId: message.sessionId, sequence: message.sequence, result });
            if (!validCommand(message.command)) { reply(fail('INVALID_COMMAND', '播放器或操作參數無效')); return; }
            if (active >= 4) { reply(fail('BUSY', '操作過多，請稍後再試')); return; }
            active++;
            const currentGeneration = generation;
            const ownController = controller;
            Promise.resolve().then(() => {
                if (disposed || suspended || currentGeneration !== generation || win.parent !== parent) return fail('DISPOSED', '控制連線已關閉');
                return ownController.execute({ ...message.command });
            }).then(result => {
                if (disposed || suspended || currentGeneration !== generation) return;
                lastResult = safeResult(result);
                reply(lastResult);
                report(lastResult);
            }, () => {
                if (!disposed && !suspended && currentGeneration === generation) reply(fail('CONTROL_FAILED', '未能控制此播放器'));
            }).finally(() => { if (currentGeneration === generation) active--; });
        }
        function stop() {
            generation++;
            if (reportTimer !== null) win.clearTimeout(reportTimer);
            reportTimer = null;
            unsubscribe?.(); unsubscribe = null;
            try { logo?.dispose(); } catch (_) { /* Keep media cleanup independent. */ }
            logo = null;
            controller?.dispose(); controller = null;
            identity = null; lastResult = null; parentOrigin = null; active = 0; boundSession = null; highestSequence = 0;
        }
        function onHide(event) {
            if (!event.persisted) { dispose(); return; }
            suspended = true; stop();
        }
        function onShow(event) { if (event.persisted && !disposed) suspended = false; }
        function dispose() {
            if (disposed) return;
            disposed = true; stop();
            win.removeEventListener('message', onMessage);
            win.removeEventListener('pagehide', onHide);
            win.removeEventListener('pageshow', onShow);
            win.removeEventListener('pointerdown', onPlayerPointer, true);
            win.removeEventListener('keydown', onPlayerPointer, true);
        }
        win.addEventListener('message', onMessage);
        win.addEventListener('pagehide', onHide);
        win.addEventListener('pageshow', onShow);
        win.addEventListener('pointerdown', onPlayerPointer, { capture: true, passive: true });
        win.addEventListener('keydown', onPlayerPointer, { capture: true, passive: true });
        return { dispose };
    }
    const api = { createSiteTransport, createFrameClient };
    root.UmininnUserscript = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
