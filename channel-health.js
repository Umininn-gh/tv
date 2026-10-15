/* Public, read-only channel clues. Human decisions are local; this module never edits a shared list. */
(function (root) {
    'use strict';
    const ChannelList = root.ChannelList || (typeof require === 'function' ? require('./channel-list.js') : null);
    let bundledPlatforms = root.ChannelHealthPlatforms;
    if (!bundledPlatforms && typeof require === 'function') { try { bundledPlatforms = require('./channel-health-platforms.js'); } catch (_) {} }
    const HISTORY_KEY = 'umininnChannelHealthHistoryV1';
    const DECISIONS_KEY = 'umininnChannelHealthDecisionsV1';
    const MAX_BYTES = 1024 * 1024;
    const MAX_CHANNELS = 200;
    const MAX_HISTORY = 5;
    const STATUSES = ['live', 'offline', 'exists', 'repair', 'suspect', 'ended', 'unknown'];
    const PROXIES = ['https://young-cloud-e59f.chicktv001.workers.dev/?quest=', 'https://wispy-sound-ef1a.for-api.workers.dev/?quest='];

    function error(code, message) { const value = new Error(message); value.code = code; return value; }
    function cancelled() { const value = error('cancelled', '檢查已取消。'); value.name = 'AbortError'; return value; }
    function copy(value) { return JSON.parse(JSON.stringify(value)); }
    function safeUrl(value, identity = true) {
        try {
            const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) return '';
            const original = new URL(url.href); url.username = ''; url.password = ''; url.search = ''; url.hash = '';
            if (!identity) url.pathname = '/';
            if (identity && original.protocol === 'https:' && !original.port) {
                if (original.hostname === 'api.twitch.tv' && /^\/helix\/(?:users|streams)$/.test(original.pathname)) {
                    const allowed = original.pathname.endsWith('/users') ? { login: /^[a-zA-Z0-9_]{1,25}$/, id: /^\d{1,30}$/ } : { user_login: /^[a-zA-Z0-9_]{1,25}$/, user_id: /^\d{1,30}$/ };
                    for (const [key, val] of original.searchParams) if (allowed[key] && allowed[key].test(val)) url.searchParams.append(key, val);
                } else if (original.hostname === 'goodgame.ru' && /^\/player\/?$/.test(original.pathname)) {
                    const id = original.search.match(/^\?(\d{1,30})(?:[=&]|$)/); if (id) url.search = '?' + id[1];
                } else if (original.hostname === 'www.youtube.com' && /^\/watch\/?$/.test(original.pathname)) {
                    const id = original.searchParams.get('v'); if (/^[a-zA-Z0-9_-]{11}$/.test(id || '')) url.searchParams.set('v', id);
                } else if (original.hostname === 'www.youtube.com' && /^\/oembed\/?$/.test(original.pathname)) {
                    try {
                        const nested = new URL(original.searchParams.get('url'));
                        const id = nested.hostname === 'youtu.be' ? nested.pathname.slice(1) : ['www.youtube.com', 'youtube.com'].includes(nested.hostname) && nested.pathname === '/watch' ? nested.searchParams.get('v') : '';
                        if (/^[a-zA-Z0-9_-]{11}$/.test(id || '')) { url.searchParams.set('url', 'https://www.youtube.com/watch?v=' + id); if (original.searchParams.get('format') === 'json') url.searchParams.set('format', 'json'); }
                    } catch (_) {}
                } else if (original.hostname === 'gosh.chicktv02.workers.dev' && original.pathname === '/') {
                    const id = original.searchParams.get('channelId'); if (/^[a-zA-Z0-9_-]{1,80}$/.test(id || '')) url.searchParams.set('channelId', id);
                }
            }
            return url.href;
        } catch (_) { return ''; }
    }
    function publicUrl(value) {
        let url; try { url = new URL(value); } catch (_) { return null; }
        if (!/^https?:\/\//i.test(value) || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return null;
        const host = url.hostname;
        if (!host.includes('.') || host.startsWith('[') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) return null;
        if (/^\d+(?:\.\d+){3}$/.test(host)) {
            const [a, b] = host.split('.').map(Number);
            if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))) return null;
        }
        return url;
    }
    function official(url) {
        if (url.protocol !== 'https:' || url.port) return false;
        const path = url.pathname, host = url.hostname;
        if (host === 'api.twitch.tv') return /^\/helix\/(?:users|streams)$/.test(path);
        if (host === 'kick.com') return /^\/api\/v[12]\/channels\/[a-zA-Z0-9_-]{1,80}\/?$/.test(path);
        if (host === 'gosh.com') return /^\/[a-zA-Z0-9_-]{1,80}\/?$/.test(path);
        if (host === 'api.angelthump.com') return /^\/v2\/streams\/[a-zA-Z0-9_-]{1,80}\/?$/.test(path);
        if (host === 'api.vaughnsoft.net') return /^\/v1\/stream\/vl\/[a-zA-Z0-9_-]{1,80}\/?$/.test(path);
        if (host === 'ok.ru') return /^\/videoembed\/\d{1,30}\/?$/.test(path);
        if (host === 'goodgame.ru') return /^\/api\/4\/users\/[^/]{1,160}\/stream\/?$/.test(path) || (/^\/player\/?$/.test(path) && /^\?\d{1,30}(?:&|$)/.test(url.search));
        if (host === 'www.youtube.com') return /^\/(?:oembed|watch)\/?$/.test(path) || /^\/(?:channel\/|@)[^/]{1,120}\/?$/.test(path);
        if (host === 'gosh.chicktv02.workers.dev') return path === '/' && [...url.searchParams.keys()].length === 1 && /^[a-zA-Z0-9_-]{1,80}$/.test(url.searchParams.get('channelId') || '');
        return false;
    }
    function hash(value) { let a = 2166136261; for (let i = 0; i < value.length; i++) { a ^= value.charCodeAt(i); a = Math.imul(a, 16777619); } return (a >>> 0).toString(16); }
    function localKey(channel) {
        const key = ChannelList.channelKey(channel);
        return /^https?:\/\//i.test(channel.id) ? channel.platform + '|' + safeUrl(channel.id, false) + '#' + hash(key) : key;
    }
    function safeStoredKey(value) {
        if (typeof value !== 'string' || value.length > 600 || /[?@]/.test(value)) return false;
        if (/^(?:m3u8|bs)\|https?:\/\//i.test(value)) {
            const match = value.match(/^(?:m3u8|bs)\|(https?:\/\/[^#]+)#[a-f0-9]{1,8}$/i);
            return Boolean(match && safeUrl(match[1], false) === match[1]);
        }
        return true;
    }
    function publicChannel(value) {
        const channel = ChannelList && ChannelList.normalizeChannel(value);
        if (!channel) throw error('validation', '頻道資料不完整。');
        const output = { name: channel.name, id: channel.id, platform: channel.platform };
        if (channel.ggUsername) output.ggUsername = channel.ggUsername;
        return output;
    }
    function accountId(value) { const id = value === undefined || value === null ? '' : String(value); return /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? id : undefined; }
    function raceSignal(task, signal) {
        if (signal && signal.aborted) return Promise.reject(cancelled());
        let stop;
        const abort = new Promise((_resolve, reject) => { stop = () => reject(cancelled()); if (signal) signal.addEventListener('abort', stop, { once: true }); });
        return Promise.race([Promise.resolve().then(task), abort]).finally(() => { if (signal) signal.removeEventListener('abort', stop); });
    }
    function gate(limit, signal) {
        let active = 0; const queue = [];
        function pump() {
            if (signal.aborted) { queue.splice(0).forEach(job => job.reject(cancelled())); return; }
            while (active < limit && queue.length) {
                const job = queue.shift(); active++;
                Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => { active--; pump(); });
            }
        }
        signal.addEventListener('abort', pump, { once: true });
        return task => new Promise((resolve, reject) => { if (signal.aborted) reject(cancelled()); else { queue.push({ task, resolve, reject }); pump(); } });
    }

    function createScanner(options = {}) {
        if (!ChannelList) throw error('configuration', '未能載入頻道清單工具。');
        const fetcher = options.fetcher || root.fetch;
        const adapters = options.platforms || root.ChannelHealthPlatforms || bundledPlatforms;
        const storage = options.storage;
        const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.min(options.timeoutMs, 60000) : 8000;
        const maxConcurrent = Math.max(1, Math.min(8, Math.floor(options.maxConcurrent) || 4));
        const secrets = new Set();
        const cleanAccountId = value => { const id = accountId(value); return id && !secrets.has(id) ? id : undefined; };
        const timestamp = () => { const value = options.now ? options.now() : Date.now(); const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString(); };
        function text(value, length = 500, generic = false) {
            let result = typeof value === 'string' ? value : '';
            if (/^\s*[\[{<]/.test(result)) return '回傳內容未能確認，請查看官方頁面。';
            for (const secret of secrets) if (secret) result = result.split(secret).join('[已隱藏]').split(encodeURIComponent(secret)).join('[已隱藏]');
            return result.replace(/https?:\/\/[^\s"'<>]+/gi, url => safeUrl(url, !generic)).replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [已隱藏]').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, length);
        }
        function evidence(values, generic = false) {
            return (Array.isArray(values) ? values : []).slice(0, 12).map(value => {
                if (!value || typeof value !== 'object') return null;
                const url = safeUrl(value.url, !generic); if (!url || [...secrets].some(secret => secret && url.includes(secret))) return null;
                const item = { url, label: text(value.label, 100, generic) || '官方來源', summary: text(value.summary, 500, generic), checkedAt: validTime(value.checkedAt) || timestamp() };
                if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) item.httpStatus = value.httpStatus;
                return item;
            }).filter(Boolean);
        }
        function validTime(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null; }
        function observation(value, generic = false) {
            if (!value || !STATUSES.includes(value.status)) return null;
            const result = { status: value.status, reason: text(value.reason, 500, generic), checkedAt: validTime(value.checkedAt) || timestamp(), evidence: evidence(value.evidence, generic) };
            const id = cleanAccountId(value.accountId); if (id) result.accountId = id;
            return result;
        }
        function read(key) { try { const value = JSON.parse(storage && storage.getItem(key)); return Array.isArray(value) ? value : []; } catch (_) { return []; } }
        function write(key, values) {
            try {
                let serialized = JSON.stringify(values);
                for (const secret of secrets) if (secret) serialized = serialized.split(secret).join('[已隱藏]');
                if (!storage) return false;
                storage.setItem(key, serialized); return true;
            } catch (_) { return false; }
        }
        const importedHistory = read(HISTORY_KEY), importedDecisions = read(DECISIONS_KEY);
        let stored = importedHistory.slice(0, MAX_CHANNELS).map(value => {
            if (!value || !safeStoredKey(value.key)) return null;
            return { key: value.key, observations: (Array.isArray(value.observations) ? value.observations : []).map(item => observation(item, /^(?:m3u8|bs)\|/.test(value.key))).filter(Boolean).slice(0, MAX_HISTORY), ...(accountId(value.accountId) ? { accountId: accountId(value.accountId) } : {}) };
        }).filter(Boolean);
        let decisions = importedDecisions.filter(value => value && safeStoredKey(value.key) && ['keep', 'review', 'deleted'].includes(value.decision)).slice(0, MAX_CHANNELS).map(value => ({ key: value.key, decision: value.decision, checkedAt: validTime(value.checkedAt) || timestamp() }));
        // Older local keys could retain temporary stream paths. Discard those records rather than preserving signed URLs.
        if (JSON.stringify(importedHistory) !== JSON.stringify(stored)) write(HISTORY_KEY, stored);
        if (JSON.stringify(importedDecisions) !== JSON.stringify(decisions)) write(DECISIONS_KEY, decisions);
        const seeds = new Map();
        const seedEntries = Array.isArray(options.seed) ? options.seed : options.seed && options.seed.entries;
        for (const value of Array.isArray(seedEntries) ? seedEntries : []) {
            try {
                const channel = publicChannel(value);
                const account = value.account || {};
                const id = accountId(value.accountId || (channel.platform === 'kick' ? account.channelId : null) || account.id || account.userId || account.channelId);
                if (id) seeds.set(localKey(channel), { accountId: id });
            } catch (_) {}
        }
        function lastDecision(channel) { const item = decisions.find(value => value.key === localKey(channel)); return item ? { decision: item.decision, checkedAt: item.checkedAt } : undefined; }
        function history(value) {
            const channel = publicChannel(value), item = stored.find(item => item.key === localKey(channel));
            const values = item ? item.observations.map(value => observation(value, ['m3u8', 'bs'].includes(channel.platform))).filter(Boolean) : [];
            const decision = lastDecision(channel); if (decision && values.length) values[0].lastDecision = decision;
            return copy(values);
        }
        function previous(value) {
            const channel = publicChannel(value), key = localKey(channel), item = stored.find(item => item.key === key);
            const prior = history(channel)[0];
            const id = cleanAccountId(item && item.accountId || seeds.get(key)?.accountId);
            return prior || id ? { ...(prior ? copy(prior) : {}), ...(id ? { accountId: id } : {}) } : null;
        }
        function remember(channel, result) {
            const key = localKey(channel), before = stored.find(item => item.key === key);
            const id = cleanAccountId(result.accountId) || cleanAccountId(before?.accountId) || cleanAccountId(seeds.get(key)?.accountId);
            const item = { key, observations: [observation(result, ['m3u8', 'bs'].includes(channel.platform)), ...(before ? before.observations : [])].filter(Boolean).slice(0, MAX_HISTORY), ...(id ? { accountId: id } : {}) };
            stored = [item, ...stored.filter(value => value.key !== key)].slice(0, MAX_CHANNELS);
            write(HISTORY_KEY, stored);
            return history(channel);
        }
        function recordDecision(value, decision) {
            if (!['keep', 'review', 'deleted'].includes(decision)) throw error('validation', '不支援這個本機標記。');
            const channel = publicChannel(value), key = localKey(channel), result = { key, decision, checkedAt: timestamp() };
            const next = [result, ...decisions.filter(value => value.key !== key)].slice(0, MAX_CHANNELS);
            if (!write(DECISIONS_KEY, next)) return false;
            decisions = next;
            return { ...copy(result), persisted: true };
        }
        function context(parentSignal) {
            const controller = new AbortController();
            const abort = () => controller.abort();
            if (parentSignal) { if (parentSignal.aborted) abort(); else parentSignal.addEventListener('abort', abort, { once: true }); }
            const signal = controller.signal, schedule = gate(maxConcurrent, signal), controls = new Map();
            let twitchPromise;
            async function bounded(url, headers, maximum, requestSignal) {
                const child = new AbortController();
                const stop = () => child.abort();
                let timer;
                const listeners = [...new Set([signal, requestSignal].filter(Boolean))];
                for (const value of listeners) { if (value.aborted) throw cancelled(); value.addEventListener('abort', stop, { once: true }); }
                const deadline = new Promise((_resolve, reject) => { timer = setTimeout(() => { child.abort(); reject(error('timeout', '來源回覆逾時，不能判定頻道失效。')); }, timeoutMs); });
                try {
                    return await raceSignal(() => raceSignal(() => Promise.race([Promise.resolve().then(async () => {
                        const response = await fetcher(url, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers, signal: child.signal });
                        const length = Number(response.headers && response.headers.get('content-length'));
                        if (Number.isFinite(length) && length > maximum) throw error('too_large', '來源內容超過檢查上限，不能判定頻道失效。');
                        let body = '';
                        if (response.body && typeof response.body.getReader === 'function') {
                            const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0;
                            try {
                                while (true) {
                                    const next = await reader.read(); if (next.done) break;
                                    bytes += next.value.byteLength;
                                    if (bytes > maximum) { reader.cancel().catch(() => {}); throw error('too_large', '來源內容超過檢查上限，不能判定頻道失效。'); }
                                    body += decoder.decode(next.value, { stream: true });
                                }
                                body += decoder.decode();
                            } finally { try { reader.releaseLock(); } catch (_) {} }
                        } else { body = await response.text(); if (new TextEncoder().encode(body).byteLength > maximum) throw error('too_large', '來源內容超過檢查上限，不能判定頻道失效。'); }
                        const headerNames = ['content-type', 'content-length', 'retry-after', 'cache-control', 'date'];
                        const publicHeaders = {};
                        for (const name of headerNames) { const value = response.headers && response.headers.get(name); if (value) publicHeaders[name] = text(value, 200); }
                        return { status: response.status, ok: !!response.ok, text: body, headers: { get: name => publicHeaders[String(name).toLowerCase()] || null } };
                    }), deadline]), requestSignal), signal);
                } catch (value) {
                    child.abort();
                    if (signal.aborted || requestSignal && requestSignal.aborted) throw cancelled();
                    if (value && ['timeout', 'too_large'].includes(value.code)) throw value;
                    throw error('network', '來源暫時無法讀取，不能判定頻道失效。');
                } finally { clearTimeout(timer); for (const value of listeners) value.removeEventListener('abort', stop); }
            }
            async function twitch() {
                if (!twitchPromise) twitchPromise = schedule(async () => {
                    const response = await bounded('./token.txt', { Accept: 'text/plain' }, 4096);
                    if (!response.ok) throw error('credentials', 'Twitch 查詢設定未能載入。');
                    const lines = response.text.split(/\r?\n/).map(value => value.trim());
                    if (!/^[a-zA-Z0-9._-]{8,512}$/.test(lines[0] || '') || !/^[a-zA-Z0-9._-]{8,128}$/.test(lines[1] || '')) throw error('credentials', 'Twitch 查詢設定格式不正確。');
                    secrets.add(lines[0]); secrets.add(lines[1]); return { token: lines[0], clientId: lines[1] };
                });
                return twitchPromise;
            }
            function forChannel(channel) {
                return {
                    signal, twitch, previous,
                    control(platform, checkFn) { if (!controls.has(platform)) controls.set(platform, Promise.resolve().then(() => checkFn())); return controls.get(platform); },
                    async request(value, settings = {}) {
                        const url = publicUrl(value);
                        if (!url || typeof fetcher !== 'function') throw error('unsupported', '這個來源不能安全地自動查詢，請查看原始入口。');
                        if (url.hostname === 'api.twitch.tv' && channel.platform !== 'twitch') throw error('unsupported', '這個平台不能使用 Twitch 查詢設定。');
                        const generic = ['m3u8', 'bs'].includes(channel.platform) && settings.direct === true && url.href === new URL(channel.id).href;
                        if (!official(url) && !generic) throw error('unsupported', '這個來源不在公開查詢範圍，請查看原始入口。');
                        const headers = { Accept: 'application/json,text/html,text/plain,*/*' };
                        const supplied = settings.headers && typeof settings.headers.entries === 'function' ? Object.fromEntries(settings.headers.entries()) : settings.headers || {};
                        for (const [name, value] of Object.entries(supplied)) {
                            const lower = name.toLowerCase();
                            if (lower === 'accept') headers.Accept = String(value).slice(0, 200);
                            else if (!['authorization', 'client-id'].includes(lower) || url.hostname !== 'api.twitch.tv') throw error('headers', '這個來源不接受登入資料。');
                        }
                        if (url.hostname === 'api.twitch.tv') {
                            const auth = await twitch();
                            for (const [name, value] of Object.entries(supplied)) {
                                if (name.toLowerCase() === 'authorization' && value !== 'Bearer ' + auth.token || name.toLowerCase() === 'client-id' && value !== auth.clientId) throw error('headers', 'Twitch 查詢設定不相符。');
                            }
                            headers.Authorization = 'Bearer ' + auth.token; headers['Client-Id'] = auth.clientId;
                        }
                        const maximum = Number.isFinite(settings.maxBytes) && settings.maxBytes > 0 ? Math.min(settings.maxBytes, MAX_BYTES) : MAX_BYTES;
                        const direct = generic || settings.direct === true || ['api.twitch.tv', 'gosh.chicktv02.workers.dev'].includes(url.hostname);
                        if (direct) return schedule(() => bounded(url.href, headers, maximum, settings.signal));
                        let last;
                        for (const proxy of PROXIES) {
                            try {
                                const response = await schedule(() => bounded(proxy + encodeURIComponent(url.href), headers, maximum, settings.signal));
                                if (![403, 429].includes(response.status) && response.status < 500) return response;
                                last = response;
                            } catch (value) { if (signal.aborted || value.name === 'AbortError') throw value; last = value; }
                        }
                        if (last && typeof last.status === 'number') return last;
                        throw last || error('network', '來源暫時無法讀取，不能判定頻道失效。');
                    }
                };
            }
            return { signal, forChannel, close() { if (parentSignal) parentSignal.removeEventListener('abort', abort); } };
        }
        async function probe(channel, run) {
            if (run.signal.aborted) throw cancelled();
            let base;
            try {
                base = await raceSignal(async () => {
                    const ctx = run.forChannel(channel);
                    if (adapters && typeof adapters.check === 'function') return adapters.check(copy(channel), ctx);
                    if (adapters && typeof adapters.run === 'function') return adapters.run(copy(channel), ctx);
                    const adapter = adapters && adapters[channel.platform];
                    if (typeof adapter === 'function') return adapter(copy(channel), ctx);
                    if (adapter && typeof adapter.run === 'function') return adapter.run(copy(channel), ctx);
                    throw error('unsupported', '這個平台暫未有可靠的核查方法。');
                }, run.signal);
            } catch (value) {
                if (run.signal.aborted) throw cancelled();
                const reasons = { timeout: '來源回覆逾時，不能判定頻道失效。', too_large: '來源內容超過檢查上限，不能判定頻道失效。', unsupported: '這個來源暫未能安全核查，請查看原始入口。', credentials: '查詢設定暫時未能使用，不能判定頻道失效。' };
                base = { status: 'unknown', reason: reasons[value && value.code] || '來源暫時無法讀取，不能判定頻道失效。', evidence: [] };
            }
            if (run.signal.aborted) throw cancelled();
            const result = { key: ChannelList.channelKey(channel), channel: copy(channel), status: base && STATUSES.includes(base.status) ? base.status : 'unknown', reason: text(base && base.reason, 500, ['m3u8', 'bs'].includes(channel.platform)) || '未能取得足夠資料。', checkedAt: timestamp(), evidence: evidence(base && base.evidence, ['m3u8', 'bs'].includes(channel.platform)) };
            const id = cleanAccountId(base && base.accountId) || previous(channel)?.accountId; if (id) result.accountId = id;
            if (base && base.suggestion) {
                try {
                    const suggestion = publicChannel({ name: channel.name, ...base.suggestion });
                    if (!secrets.has(suggestion.id) && !/[,\u0000-\u001f]/.test(suggestion.id) && (!/^https?:\/\//i.test(suggestion.id) || safeUrl(suggestion.id) === suggestion.id)) result.suggestion = { id: suggestion.id, platform: suggestion.platform };
                } catch (_) {}
            }
            result.history = remember(channel, result);
            const decision = lastDecision(channel); if (decision) { result.decision = decision; result.lastDecision = decision; }
            return result;
        }
        async function check(value, settings = {}) {
            const channel = publicChannel(value), run = context(settings.signal);
            try { return await probe(channel, run); } finally { run.close(); }
        }
        async function scan(values, settings = {}) {
            if (!Array.isArray(values)) throw error('validation', '頻道清單格式不正確。');
            const channels = [], seen = new Set();
            for (const value of values) { const channel = publicChannel(value), key = ChannelList.channelKey(channel); if (!seen.has(key)) { seen.add(key); channels.push(channel); } }
            const checkedAt = timestamp(), run = context(settings.signal), results = new Array(channels.length);
            const totals = Object.fromEntries(STATUSES.map(value => [value, 0])); Object.assign(totals, { total: channels.length, completed: 0 });
            let next = 0;
            function callback(fn, ...args) { if (!run.signal.aborted && typeof fn === 'function') { try { fn(...args); } catch (_) {} } }
            callback(settings.onProgress, { completed: 0, total: channels.length, cancelled: false });
            try {
                await Promise.all(Array.from({ length: Math.min(maxConcurrent, channels.length) }, async () => {
                    while (!run.signal.aborted && next < channels.length) {
                        const index = next++;
                        try {
                            const result = await probe(channels[index], run);
                            if (run.signal.aborted) break;
                            results[index] = result; totals.completed++; totals[result.status]++;
                            callback(settings.onResult, result, { completed: totals.completed, total: channels.length, index });
                            callback(settings.onProgress, { completed: totals.completed, total: channels.length, cancelled: false });
                        } catch (value) { if (!run.signal.aborted) throw value; }
                    }
                }));
                return { results: results.filter(Boolean), checkedAt, cancelled: run.signal.aborted, totals };
            } finally { run.close(); }
        }
        return Object.freeze({ scan, check, history, recordDecision });
    }
    const api = Object.freeze({ createScanner });
    root.ChannelHealth = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
