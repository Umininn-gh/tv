/* Stateless, same-tab routing between the approved site and its player frames. */
(function (root) {
    'use strict';
    if (!root.UmininnConfig && typeof root.importScripts === 'function') root.importScripts('shared/config.js');

    function createBroker(api, options = {}) {
        const config = options.config || root.UmininnConfig || (typeof require === 'function' ? require('./shared/config.js') : null);
        if (!config || !api?.runtime?.onMessage || !api?.tabs) throw new TypeError('Extension configuration and messaging APIs are required');
        const promiseApi = options.promiseApi ?? Boolean(root.browser && api === root.browser);
        const later = options.setTimeout || root.setTimeout.bind(root);
        const clear = options.clearTimeout || root.clearTimeout.bind(root);
        const timeoutMs = options.timeoutMs ?? 6000;
        const maxPending = options.maxPending ?? 32;
        let pending = 0;
        const fail = (code, message) => ({ ok: false, code, message, state: null });
        const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
        const positiveFrame = value => Number.isSafeInteger(value) && value > 0;
        const validToken = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{32,128}$/.test(value);
        const validDocument = value => value == null || typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

        function validCommand(command) {
            if (!object(command)) return false;
            if ('guard' in command && (command.action !== 'setMuted' || command.value !== true || command.guard !== true)) return false;
            if ('focus' in command && (command.focus !== true || 'guard' in command ||
                !(command.action === 'setVolume' || command.action === 'setMuted' && command.value === false))) return false;
            if (command.action === 'setVolume') return typeof command.value === 'number' && Number.isFinite(command.value) && command.value >= 0 && command.value <= 1;
            if (command.action === 'setMuted') return typeof command.value === 'boolean';
            return ['getState', 'recover'].includes(command.action) && command.value === undefined;
        }
        function safeState(state) {
            if (!object(state)) return null;
            const result = {};
            for (const field of ['available', 'muted', 'paused', 'ended', 'recovering', 'recoverSupported', 'platformRecoverSupported', 'volumeSupported', 'muteSupported', 'muteGuardActive', 'focusRestorePending', 'disposed']) {
                if (typeof state[field] === 'boolean' || state[field] === null) result[field] = state[field];
            }
            for (const [field, min, max] of [['volume', 0, 1], ['readyState', 0, 4], ['errorCode', 0, 4], ['mediaId', 1, Number.MAX_SAFE_INTEGER]]) {
                if (state[field] === null) result[field] = null;
                else if (typeof state[field] === 'number' && Number.isFinite(state[field]) && state[field] >= min && state[field] <= max) result[field] = state[field];
            }
            if (Number.isSafeInteger(state.audioUserRevision) && state.audioUserRevision >= 0) result.audioUserRevision = state.audioUserRevision;
            if (['video', 'audio', null].includes(state.mediaType)) result.mediaType = state.mediaType;
            if (['no-media', 'error', 'blocked', 'ended', 'waiting', 'paused', 'playing'].includes(state.playbackStatus)) result.playbackStatus = state.playbackStatus;
            return result;
        }
        function safeResult(value) {
            if (!object(value) || typeof value.ok !== 'boolean') return fail('INVALID_RESPONSE', '播放器沒有傳回有效狀態');
            return {
                ok: value.ok,
                code: typeof value.code === 'string' && /^[A-Z_]{1,40}$/.test(value.code) ? value.code : value.ok ? 'OK' : 'CONTROL_FAILED',
                message: typeof value.message === 'string' ? value.message.slice(0, 240) : '',
                state: safeState(value.state)
            };
        }
        function callTabs(method, args) {
            if (promiseApi) {
                try { return Promise.resolve(api.tabs[method](...args)); }
                catch (error) { return Promise.reject(error); }
            }
            return new Promise((resolve, reject) => {
                try {
                    api.tabs[method](...args, value => {
                        const error = api.runtime.lastError;
                        if (error) reject(new Error(error.message || 'Extension API failed'));
                        else resolve(value);
                    });
                } catch (error) { reject(error); }
            });
        }
        function sameSiteDocument(a, b) {
            try {
                const first = new URL(a), second = new URL(b);
                return first.origin === second.origin && first.pathname === second.pathname && first.search === second.search;
            } catch (_) { return false; }
        }
        function validate(message, sender) {
            if (!object(message) || !config.isEnvelope(message) || !['frame:identify', 'site:command'].includes(message.type)) return fail('INVALID_REQUEST', '不支援此訊息');
            if (!sender || sender.id !== api.runtime.id || !Number.isSafeInteger(sender.tab?.id) || sender.tab.id < 0 ||
                sender.documentLifecycle && sender.documentLifecycle !== 'active') return fail('UNAUTHORIZED', '此來源不能控制播放器');
            if (message.type === 'frame:identify') {
                if (!positiveFrame(sender.frameId) || !config.isPlayerUrl(sender.url)) return fail('UNAUTHORIZED', '此來源不是已授權的播放器');
            } else {
                if (sender.frameId !== 0 || !config.isSiteUrl(sender.url)) return fail('UNAUTHORIZED', '只可從原網站控制播放器');
                const target = message.target;
                if (!object(target) || !positiveFrame(target.frameId) || !validToken(target.token) || !validDocument(target.documentId) || !validCommand(message.command)) {
                    return fail('INVALID_COMMAND', '播放器或操作參數無效');
                }
            }
            return null;
        }
        async function route(message, sender, active) {
            let tab;
            try { tab = await callTabs('get', [sender.tab.id]); }
            catch (_) { return fail('TAB_UNAVAILABLE', '網站分頁已關閉或未獲授權'); }
            if (!active()) return fail('TIMEOUT', '操作已逾時');
            if (!tab || tab.id !== sender.tab.id || !config.isSiteUrl(tab.url)) return fail('UNAUTHORIZED', '分頁已離開原網站');
            if (message.type === 'frame:identify') {
                return { ok: true, frameId: sender.frameId, documentId: validDocument(sender.documentId) ? sender.documentId ?? null : null };
            }
            if (!sameSiteDocument(sender.url, tab.url)) return fail('STALE_DOCUMENT', '網站頁面已更換，請重新確認播放器');
            const command = { action: message.command.action };
            if (message.command.value !== undefined) command.value = message.command.value;
            if (message.command.guard === true) command.guard = true;
            if (message.command.focus === true) command.focus = true;
            const target = { frameId: message.target.frameId };
            // Chromium can additionally select the exact document. The per-document
            // token remains required on both engines, including Firefox versions
            // whose tabs.sendMessage options do not expose documentId.
            if (!promiseApi && message.target.documentId) target.documentId = message.target.documentId;
            try {
                const response = await callTabs('sendMessage', [sender.tab.id, {
                    channel: config.CHANNEL, version: config.VERSION, type: 'frame:command',
                    token: message.target.token, command
                }, target]);
                return safeResult(response);
            } catch (_) { return fail('FRAME_UNAVAILABLE', '播放器未連線，請重新檢查狀態'); }
        }
        function handle(message, sender) {
            const invalid = validate(message, sender);
            if (invalid) return Promise.resolve(invalid);
            if (pending >= maxPending) return Promise.resolve(fail('BUSY', '操作過多，請稍後再試'));
            pending++;
            return new Promise(resolve => {
                let settled = false;
                const finish = value => {
                    if (settled) return;
                    settled = true;
                    clear(timer);
                    pending--;
                    resolve(value);
                };
                const timer = later(() => finish(fail('TIMEOUT', '播放器未有回覆，請重新檢查狀態')), timeoutMs);
                route(message, sender, () => !settled).then(finish, () => finish(fail('CONTROL_FAILED', '未能控制此播放器')));
            });
        }
        function onMessage(message, sender, respond) {
            if (!object(message) || !config.isEnvelope(message) || !['frame:identify', 'site:command'].includes(message.type)) return false;
            handle(message, sender).then(result => { try { respond(result); } catch (_) {} });
            return true;
        }
        api.runtime.onMessage.addListener(onMessage);
        return { handle, dispose() { api.runtime.onMessage.removeListener(onMessage); } };
    }

    const api = root.browser || root.chrome;
    if (api?.runtime?.onMessage) createBroker(api);
    if (typeof module === 'object' && module.exports) module.exports = { createBroker };
})(globalThis);
