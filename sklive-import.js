/* Read a fixed public SKLive list and propose additions; never remove existing channels. */
(function (root) {
    'use strict';

    const ChannelList = root.ChannelList || (typeof require === 'function' ? require('./channel-list.js') : null);
    const ChannelSync = root.ChannelSync || (typeof require === 'function' ? require('./channel-sync.js') : null);
    const SOURCE_URL = 'https://skknower.com/user/ctvhiki49713';
    const CURRENT_API_URL = 'https://skknower.com/api/userlive/ctvhiki49713';
    const API_URL = 'https://live.sk-knower.com/skgamerversion_api.php?page=ctvhiki49713';
    const PROXIES = Object.freeze([
        'https://young-cloud-e59f.chicktv001.workers.dev/?quest=',
        'https://wispy-sound-ef1a.for-api.workers.dev/?quest='
    ]);
    const MAX_BYTES = 1024 * 1024;
    const SLUG = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,79}$/;
    const TWITCH_SLUG = /^[a-zA-Z0-9_]{1,25}$/;
    const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
    const YOUTUBE_CHANNEL_ID = /^(?:UC|HC)[a-zA-Z0-9_-]{16,30}$/;

    function failure(code, message) {
        const error = new Error(message);
        error.code = code;
        error.isSKLiveImportError = true;
        return error;
    }

    function dependencies() {
        if (!ChannelList || !ChannelSync) throw failure('configuration', '未能載入頻道工具，請重新整理頁面。');
    }

    function publicUrl(value) {
        if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null;
        let url;
        try { url = new URL(value); } catch (_) { return null; }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname || /[\u0000-\u0020\u007f]/u.test(value)) return null;
        const host = url.hostname.toLowerCase();
        // Imported sources must not publish private-network URLs. No source URL is fetched here.
        if (!host.includes('.') || host.startsWith('[') || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host)) return null;
        if (/^\d+(?:\.\d+){3}$/.test(host)) {
            const [a, b] = host.split('.').map(Number);
            if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))) return null;
        }
        return url;
    }

    function officialUrlId(platform, value) {
        const url = publicUrl(value);
        if (!url || url.port) return null;
        const host = url.hostname;
        const path = url.pathname;
        let match;
        if (platform === 'twitch') {
            if (['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'].includes(host)) match = path.match(/^\/([a-zA-Z0-9_]{1,25})\/?$/);
            if (host === 'player.twitch.tv' && path === '/') {
                const id = url.searchParams.get('channel');
                if (id && TWITCH_SLUG.test(id)) return id;
            }
        } else if (platform === 'kick') {
            if (['kick.com', 'www.kick.com', 'player.kick.com'].includes(host)) match = path.match(/^\/([a-zA-Z0-9_][a-zA-Z0-9_-]{0,79})\/?$/);
        } else if (platform === 'ok') {
            if (['ok.ru', 'www.ok.ru'].includes(host)) match = path.match(/^\/(?:videoembed|video|live)\/(\d{1,30})\/?$/);
        } else if (platform === 'at') {
            if (['angelthump.com', 'www.angelthump.com'].includes(host)) match = path.match(/^\/([a-zA-Z0-9_][a-zA-Z0-9_-]{0,79})\/?$/);
            if (host === 'player.angelthump.com' && path === '/') {
                const id = url.searchParams.get('channel');
                if (id && SLUG.test(id)) return id;
            }
        } else if (platform === 'vaughn') {
            if (['vaughn.live', 'www.vaughn.live', 'myvaughn.com', 'www.myvaughn.com'].includes(host)) match = path.match(/^\/([a-zA-Z0-9_][a-zA-Z0-9_-]{0,79})\/?$/);
        } else if (platform === 'gosh') {
            if (['gosh.com', 'www.gosh.com'].includes(host)) match = path.match(/^\/([a-zA-Z0-9_][a-zA-Z0-9_-]{0,79})\/?$/);
        } else if (platform === 'goodgame') {
            if (['goodgame.ru', 'www.goodgame.ru'].includes(host) && /^\/player\/?$/.test(path)) match = url.search.match(/^\?(\d{1,30})(?:&|$)/);
        } else if (platform === 'youtube') {
            if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) {
                if (/^\/watch\/?$/.test(path)) {
                    const id = url.searchParams.get('v');
                    if (id && VIDEO_ID.test(id)) return id;
                }
                match = path.match(/^\/(?:embed|channel)\/([a-zA-Z0-9_-]+)\/?$/);
                if (match && (VIDEO_ID.test(match[1]) || YOUTUBE_CHANNEL_ID.test(match[1]))) return match[1];
                return null;
            }
            if (['youtu.be', 'www.youtu.be'].includes(host)) match = path.match(/^\/([a-zA-Z0-9_-]{11})\/?$/);
        }
        return match ? match[1] : null;
    }

    function plainId(platform, value) {
        if (typeof value !== 'string') return null;
        const id = value.trim();
        if (platform === 'twitch') return TWITCH_SLUG.test(id) ? id : null;
        if (platform === 'youtube') return VIDEO_ID.test(id) || YOUTUBE_CHANNEL_ID.test(id) ? id : null;
        if (platform === 'ok' || platform === 'goodgame') return /^\d{1,30}$/.test(id) ? id : null;
        return SLUG.test(id) ? id : null;
    }

    function validated(channel) {
        const normalized = ChannelList.normalizeChannel(channel);
        if (!normalized) return null;
        try { ChannelSync.serializeChannels([normalized]); } catch (_) { return null; }
        const result = { name: normalized.name, id: normalized.id, platform: normalized.platform };
        if (normalized.ggUsername) result.ggUsername = normalized.ggUsername;
        return result;
    }

    function mappedChannel(item, name) {
        const rawPlatform = typeof item.platform === 'string' ? item.platform.trim().toLowerCase() : '';
        const details = typeof item.details === 'string' || typeof item.details === 'number' ? String(item.details).trim() : '';
        const sourceUrl = typeof item.url === 'string' ? item.url.trim() : '';
        let platform = rawPlatform;
        if (rawPlatform === 'vl') {
            if (officialUrlId('kick', sourceUrl) || officialUrlId('kick', details)) platform = 'kick';
            else if (officialUrlId('vaughn', sourceUrl) || officialUrlId('vaughn', details)) platform = 'vaughn';
            else return { reason: 'ambiguous_platform' };
        } else if (rawPlatform === 'okru') platform = 'ok';
        else if (rawPlatform === 'angelthump') platform = 'at';
        if (platform === 'm3u8') {
            const goshId = plainId('gosh', details) || officialUrlId('gosh', details) || officialUrlId('gosh', sourceUrl);
            if (goshId) return { channel: validated({ name, id: goshId, platform: 'gosh' }) };
            for (const value of [details, sourceUrl]) {
                const url = publicUrl(value);
                // Gosh playback links expire. Only the account identity belongs in a saved list.
                if (url && !/(?:^|\.)gosh\d*\.app$/i.test(url.hostname) && /\.m3u8$/i.test(url.pathname)) return { channel: validated({ name, id: value, platform: 'm3u8' }) };
            }
            return { reason: 'unmappable_hls' };
        }
        if (!['twitch', 'kick', 'ok', 'at', 'youtube', 'vaughn', 'gosh', 'goodgame'].includes(platform)) return { reason: 'unsupported_platform' };
        let id = plainId(platform, details) || officialUrlId(platform, details);
        const urlId = officialUrlId(platform, sourceUrl);
        if (id && urlId && ChannelList.channelKey({ name, id, platform }) !== ChannelList.channelKey({ name, id: urlId, platform })) return { reason: 'conflicting_identity' };
        if (!id) id = urlId;
        if (!id) return { reason: 'unmappable_identity' };
        return { channel: validated({ name, id, platform }) };
    }

    function currentRow(item) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
        return {
            displayname: item.name,
            details: item.details,
            platform: item.platform,
            url: typeof item.embed === 'string' && item.embed.trim() ? item.embed : typeof item.play?.url === 'string' ? item.play.url : ''
        };
    }

    function parse(payload) {
        dependencies();
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw failure('invalid_data', 'SKLive 未回傳有效的頻道清單，原有頻道沒有更動。');
        }
        const current = Array.isArray(payload.sources);
        if (current && payload.id !== 'ctvhiki49713') throw failure('invalid_data', 'SKLive 回傳的來源並非指定頻道，原有頻道沒有更動。');
        const rows = current ? payload.sources.map(currentRow) : payload.channels;
        if (!Array.isArray(rows) || !rows.length) throw failure('invalid_data', 'SKLive 未回傳有效的頻道清單，原有頻道沒有更動。');
        const channels = [], duplicates = [], skipped = [];
        const seen = new Map();
        let hidden = 0;
        rows.forEach((item, offset) => {
            const index = offset + 1;
            if (!item || typeof item !== 'object' || Array.isArray(item)) { skipped.push({ index, reason: 'invalid_entry' }); return; }
            const displayName = typeof item.displayname === 'string' ? item.displayname : '';
            if (/:hide:/i.test(displayName)) hidden++;
            const name = displayName.replace(/:hide:/gi, '').trim();
            const platform = typeof item.platform === 'string' ? item.platform.trim().toLowerCase().slice(0, 40) : '';
            const diagnostic = { index, name: name.slice(0, 160), platform };
            if (!name) { skipped.push({ ...diagnostic, reason: 'missing_name' }); return; }
            const mapped = mappedChannel(item, name);
            if (!mapped.channel) { skipped.push({ ...diagnostic, reason: mapped.reason || 'invalid_public_fields' }); return; }
            const key = ChannelList.channelKey(mapped.channel);
            if (seen.has(key)) { duplicates.push({ ...diagnostic, reason: 'duplicate_identity', duplicateOf: seen.get(key) }); return; }
            seen.set(key, index);
            channels.push(mapped.channel);
        });
        return { channels, received: rows.length, hidden, duplicates, skipped, sourceUrl: SOURCE_URL, checkedAt: new Date().toISOString() };
    }

    async function readLimited(response, maximum) {
        const length = Number(response.headers && response.headers.get('content-length'));
        if (Number.isFinite(length) && length > maximum) throw failure('too_large', 'SKLive 回傳的資料過大，原有頻道沒有更動。');
        if (response.body && typeof response.body.getReader === 'function') {
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8', { fatal: true });
            let text = '', bytes = 0;
            try {
                while (true) {
                    const next = await reader.read();
                    if (next.done) break;
                    bytes += next.value.byteLength;
                    if (bytes > maximum) { reader.cancel().catch(() => {}); throw failure('too_large', 'SKLive 回傳的資料過大，原有頻道沒有更動。'); }
                    text += decoder.decode(next.value, { stream: true });
                }
                return text + decoder.decode();
            } finally { try { reader.releaseLock(); } catch (_) {} }
        }
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength > maximum) throw failure('too_large', 'SKLive 回傳的資料過大，原有頻道沒有更動。');
        return text;
    }

    async function load(fetcher = root.fetch, options = {}) {
        dependencies();
        if (typeof fetcher !== 'function') throw failure('configuration', '瀏覽器未能讀取 SKLive，請重新整理頁面。');
        const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.min(options.timeoutMs, 60000) : 20000;
        const maximum = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? Math.min(options.maxBytes, MAX_BYTES) : MAX_BYTES;
        async function readSource(apiUrl, current) {
            let lastError;
            for (const proxy of PROXIES) {
                const url = proxy + encodeURIComponent(apiUrl);
                const controller = new AbortController();
                let timer;
                const deadline = new Promise((_resolve, reject) => {
                    timer = setTimeout(() => { controller.abort(); reject(failure('timeout', '讀取 SKLive 逾時，原有頻道沒有更動。')); }, timeoutMs);
                });
                try {
                    return await Promise.race([Promise.resolve().then(async () => {
                        const response = await fetcher(url, { method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: controller.signal });
                        if (!response || !response.ok) throw failure('http', 'SKLive 暫時未能讀取，原有頻道沒有更動。');
                        const text = await readLimited(response, maximum);
                        let payload;
                        try { payload = JSON.parse(text); } catch (_) { throw failure('invalid_data', 'SKLive 回傳的資料格式不正確，原有頻道沒有更動。'); }
                        if (!payload || !Array.isArray(current ? payload.sources : payload.channels)) throw failure('invalid_data', 'SKLive 回傳的資料格式不正確，原有頻道沒有更動。');
                        const report = parse(payload);
                        // Keep raw rows inside this call only; reports never copy private settings or temporary URLs.
                        return { report, rows: current ? payload.sources.map(currentRow) : payload.channels,
                            hiddenRows: current ? [] : payload.channels.filter(item => item && typeof item.displayname === 'string' && /:hide:/i.test(item.displayname)) };
                    }), deadline]);
                } catch (error) {
                    controller.abort();
                    lastError = error && error.isSKLiveImportError ? error : failure('network', '未能連接 SKLive，原有頻道沒有更動。');
                } finally { clearTimeout(timer); }
            }
            throw lastError;
        }
        // The current page owns visible entries. The older API is read solely to
        // retain explicitly hidden entries, without resurrecting stale visible rows.
        const [current, legacy] = await Promise.allSettled([
            readSource(CURRENT_API_URL, true), readSource(API_URL, false)
        ]);
        if (current.status === 'rejected' && legacy.status === 'rejected') throw current.reason;
        const sourceWarnings = [];
        const sourceApis = [];
        if (current.status === 'rejected') {
            sourceWarnings.push('目前版 SKLive 清單暫時讀取失敗；只核對舊版來源，未能確認最新可見入口。');
            sourceApis.push(API_URL);
            return { ...legacy.value.report, sourceWarnings, sourceApis };
        }
        sourceApis.push(CURRENT_API_URL);
        const report = current.value.report;
        if (legacy.status === 'rejected') {
            sourceWarnings.push('舊版隱藏入口暫時讀取失敗；本次只核對目前版可見入口。');
            return { ...report, sourceWarnings, sourceApis };
        }
        sourceApis.push(API_URL);
        if (legacy.value.report.skipped.length) sourceWarnings.push('舊版來源有未能識別的資料；隱藏入口可能未完成核對。');
        if (!legacy.value.hiddenRows.length) return { ...report, sourceWarnings, sourceApis };
        return { ...parse({ channels: [...current.value.rows, ...legacy.value.hiddenRows] }), sourceWarnings, sourceApis };
    }

    function compare(existing, incoming) {
        dependencies();
        if (!Array.isArray(existing)) throw failure('validation', '原有頻道清單格式不正確。');
        try { ChannelSync.serializeChannels(existing); } catch (_) { throw failure('validation', '原有頻道清單格式不正確，已停止同步。'); }
        const values = Array.isArray(incoming) ? incoming : incoming && incoming.channels;
        if (!Array.isArray(values)) throw failure('validation', '匯入頻道清單格式不正確。');
        const channels = existing.slice(), added = [], seen = new Set(existing.map(ChannelList.channelKey));
        let alreadyPresent = 0;
        for (const value of values) {
            const channel = validated(value);
            if (!channel) throw failure('validation', '匯入頻道包含無效資料，原有頻道沒有更動。');
            const key = ChannelList.channelKey(channel);
            if (seen.has(key)) { alreadyPresent++; continue; }
            seen.add(key); channels.push(channel); added.push(channel);
        }
        return { channels, added, alreadyPresent, existingCount: existing.length };
    }

    const api = Object.freeze({ parse, load, compare, sourceUrl: SOURCE_URL, apiUrl: API_URL, currentApiUrl: CURRENT_API_URL, legacyApiUrl: API_URL });
    root.SKLiveImport = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
