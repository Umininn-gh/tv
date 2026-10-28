/* Public, read-only channel checks. All network access is supplied by ChannelHealth. */
(function (root) {
    'use strict';

    const BAD_HTTP = new Set([401, 403, 408, 425, 429]);
    const SLUG = /^[a-z0-9_-]{1,100}$/i;
    const VIDEO_ID = /^[a-z0-9_-]{11}$/i;
    const ALIASES = { vl: 'kick', okru: 'ok', angelthump: 'at' };
    const CONTROL = { kick: 'jeukpo', gosh: 'meidingdang', at: 'ppkkkp', vaughn: 'kingkong_tv', ok: '10268974521971', youtube: 'jNQXAC9IVRw' };

    function json(text) { try { return JSON.parse(text); } catch (error) { return null; } }
    function uncertain(response) { return !response || BAD_HTTP.has(response.status) || response.status >= 500 || !response.status; }
    function usable(response) { return !!response && response.ok && response.status >= 200 && response.status < 300; }
    function record(status, reason, evidence, extra) { return Object.assign({ status, reason, evidence }, extra || {}); }
    function evidence(url, response, summary, label, privateUrl) {
        let safe = url;
        try {
            const parsed = new URL(url);
            parsed.username = ''; parsed.password = '';
            if (privateUrl) safe = parsed.origin + '/';
            else safe = parsed.href;
        } catch (error) { safe = ''; }
        return { url: safe, label: label || '官方資料', httpStatus: response ? response.status : undefined, summary, checkedAt: new Date().toISOString() };
    }
    async function request(ctx, url, options) {
        if (ctx.signal && ctx.signal.aborted) return null;
        try {
            const response = await ctx.request(url, Object.assign({ signal: ctx.signal, maxBytes: 1024 * 1024 }, options || {}));
            if (!response || typeof response.text !== 'string') return null;
            return Object.assign({}, response, { status: Number(response.status) || 0 });
        } catch (error) { return null; }
    }
    async function control(ctx, platform, url, validate, events, options) {
        const run = async () => {
            const response = await request(ctx, url, options);
            const valid = !!validate(response);
            return { valid, evidence: evidence(url, response, valid ? '已確認正常對照入口的身份，作為本次負面結果的比較依據。' : '未能確認對照入口，沒有據此判定目標失效。', '官方正常對照') };
        };
        try {
            const result = await (ctx.control ? ctx.control(platform, run) : run());
            if (result && result.evidence) events.push(Object.assign({}, result.evidence));
            return !!(result && result.valid);
        } catch (error) {
            events.push(evidence(url, null, '對照檢查未完成，沒有據此判定目標失效。', '官方正常對照'));
            return false;
        }
    }
    function decodeHtml(value) {
        return String(value).replace(/&(?:quot|#34);/gi, '"').replace(/&(?:apos|#39|#x27);/gi, "'")
            .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
            .replace(/&#(x[0-9a-f]+|\d+);/gi, (match, code) => {
                const number = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
                return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : match;
            });
    }
    function visibleText(html) { return decodeHtml(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
    function jsonObjectAt(text, offset) {
        const start = text.indexOf('{', offset);
        if (start < 0 || start - offset > 80) return null;
        let depth = 0, quoted = false, escaped = false;
        for (let index = start; index < text.length; index++) {
            const character = text[index];
            if (quoted) {
                if (escaped) escaped = false;
                else if (character === '\\') escaped = true;
                else if (character === '"') quoted = false;
            } else if (character === '"') quoted = true;
            else if (character === '{') depth++;
            else if (character === '}' && --depth === 0) return json(text.slice(start, index + 1));
        }
        return null;
    }
    function propertyObject(text, property) {
        const marker = '"' + property + '"';
        let offset = -1;
        while ((offset = text.indexOf(marker, offset + 1)) >= 0) {
            const tail = text.slice(offset + marker.length);
            const separator = tail.match(/^\s*:\s*/);
            if (separator && tail.slice(separator[0].length).startsWith('{')) return jsonObjectAt(text, offset + marker.length + separator[0].length);
        }
        return null;
    }
    function metadataObjects(html) {
        const found = [];
        for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
            const value = json(match[1]);
            if (value) found.push(value);
        }
        for (const match of html.matchAll(/(?:data-options|data-player-options|data-player-config)\s*=\s*(["'])([\s\S]*?)\1/gi)) {
            const value = json(decodeHtml(match[2]));
            if (value) found.push(value);
        }
        return found;
    }
    function flattenObjects(values) {
        const found = [], seen = new Set();
        function walk(value, depth) {
            if (depth > 15 || value === null || value === undefined) return;
            if (typeof value === 'string') {
                if (/^\s*[\[{]/.test(value)) walk(json(value), depth + 1);
                return;
            }
            if (typeof value !== 'object' || seen.has(value)) return;
            seen.add(value);
            if (!Array.isArray(value)) found.push(value);
            Object.values(value).forEach(child => walk(child, depth + 1));
        }
        values.forEach(value => walk(value, 0));
        return found;
    }
    function accountId(value) { return value !== null && value !== undefined && /^[a-z0-9_-]{1,100}$/i.test(String(value)) ? String(value) : undefined; }
    function userLogin(value, host) {
        const raw = String(value || '').trim();
        if (!/^https?:\/\//i.test(raw)) return SLUG.test(raw) ? raw.toLowerCase() : null;
        try {
            const url = new URL(raw);
            if (!host.includes(url.hostname.toLowerCase())) return null;
            const slug = url.pathname.split('/').filter(Boolean)[0];
            return SLUG.test(slug || '') ? slug.toLowerCase() : null;
        } catch (error) { return null; }
    }

    function twitchUsers(response) {
        const data = usable(response) && json(response.text);
        if (!data || !Array.isArray(data.data)) return null;
        return data.data.every(user => user && /^\d+$/.test(String(user.id)) && SLUG.test(user.login || '')) ? data.data : null;
    }
    async function twitch(channel, ctx) {
        const events = [], login = userLogin(channel.id, ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv']);
        if (!login) return record('unknown', 'Twitch 名稱格式未能確認。', events);
        let credentials;
        try { credentials = await ctx.twitch(); } catch (error) {}
        if (!credentials || !credentials.token || !credentials.clientId) return record('unknown', '未能載入 Twitch 官方查詢所需的現有憑證。', events);
        const headers = { Authorization: 'Bearer ' + String(credentials.token).replace(/^(?:Bearer\s+|oauth:)/i, ''), 'Client-Id': credentials.clientId };
        const lookup = async query => {
            const url = 'https://api.twitch.tv/helix/users?' + query;
            const response = await request(ctx, url, { direct: true, headers });
            events.push(evidence(url, response, twitchUsers(response) === null ? '未能取得可驗證的帳戶資料。' : '已取得官方帳戶查詢結果。', 'Twitch Get Users'));
            return twitchUsers(response);
        };
        const users = await lookup('login=' + encodeURIComponent(login));
        if (users === null) return record('unknown', 'Twitch 查詢暫時受阻，不能判定帳戶失效。', events);
        let user = users.find(item => item.login.toLowerCase() === login);
        if (users.length && !user) return record('unknown', 'Twitch 回應的帳戶與查詢名稱不符，暫不判定原帳戶失效。', events);
        let previous;
        try { previous = ctx.previous ? await ctx.previous(channel) : null; } catch (error) {}
        const previousId = previous && /^\d+$/.test(String(previous.accountId)) ? String(previous.accountId) : null;
        if (previousId && (!user || String(user.id) !== previousId)) {
            const stable = await lookup('id=' + encodeURIComponent(previousId));
            if (stable === null) return record('unknown', '舊帳戶 ID 查詢受阻，暫不建議更換名稱。', events, { accountId: previousId });
            const renamed = stable.find(item => String(item.id) === previousId);
            if (stable.length && !renamed) return record('unknown', '舊帳戶 ID 回應的身份不符，暫不建議更換名稱。', events, { accountId: previousId });
            if (renamed && renamed.login.toLowerCase() !== login) return record('repair', '相同的 Twitch 帳戶 ID 已改用另一個名稱。', events, { accountId: previousId, suggestion: { id: renamed.login.toLowerCase(), platform: 'twitch' } });
            if (renamed) user = renamed;
        }
        if (!user || (previousId && String(user.id) !== previousId)) {
            const validControl = await control(ctx, 'twitch', 'https://api.twitch.tv/helix/users?login=twitch', response => (twitchUsers(response) || []).some(item => item.login.toLowerCase() === 'twitch'), events, { direct: true, headers });
            return record(validControl ? 'suspect' : 'unknown', validControl ? '官方已找不到原本的帳戶身份；可能改名或停用，請覆核。' : '未能通過官方對照查詢，不能判定帳戶失效。', events, previousId ? { accountId: previousId } : null);
        }
        const identity = { accountId: String(user.id) };
        if (/^https?:\/\//i.test(String(channel.id))) return record('repair', '官方帳戶已確認，可將完整網址改為播放器需要的頻道名稱。', events, Object.assign(identity, { suggestion: { id: user.login.toLowerCase(), platform: 'twitch' } }));
        const url = 'https://api.twitch.tv/helix/streams?user_id=' + encodeURIComponent(user.id);
        const response = await request(ctx, url, { direct: true, headers });
        const data = usable(response) && json(response.text);
        events.push(evidence(url, response, data && Array.isArray(data.data) ? '已取得直播狀態。' : '帳戶存在；直播狀態暫未能取得。', 'Twitch Get Streams'));
        if (!data || !Array.isArray(data.data)) return record('exists', '帳戶仍然存在，但直播狀態暫時無法確認。', events, identity);
        const live = data.data.some(stream => String(stream.user_id) === String(user.id) && stream.type !== '');
        return record(live ? 'live' : 'offline', live ? '帳戶存在，正在直播。' : '帳戶存在，目前沒有直播。', events, identity);
    }

    function kickAccount(response) {
        const data = usable(response) && json(response.text);
        return data && /^\d+$/.test(String(data.id)) && SLUG.test(data.slug || '') ? data : null;
    }
    function kickAbsent(response) {
        if (!response || response.status !== 404) return false;
        const data = json(response.text);
        return !!data && (data.message === 'Channel not found.' || data.message === 'Channel not found' || /^No query results for model \[App\\Models\\Channel\]/.test(data.message || ''));
    }
    async function kick(channel, ctx) {
        const events = [], slug = userLogin(channel.id, ['kick.com', 'www.kick.com']);
        if (!slug) return record('unknown', 'Kick 頻道名稱格式未能確認。', events);
        async function lookup(version, id) {
            const url = 'https://kick.com/api/' + version + '/channels/' + encodeURIComponent(id);
            const response = await request(ctx, url);
            events.push(evidence(url, response, kickAccount(response) ? '官方回傳帳戶身份。' : kickAbsent(response) ? '官方明確回報找不到頻道。' : '未取得可驗證的帳戶資料。', 'Kick 官方 API'));
            return response;
        }
        const response = await lookup('v2', slug);
        let user = kickAccount(response);
        let missing = false;
        if (!user && kickAbsent(response)) {
            const secondary = await lookup('v1', slug);
            user = kickAccount(secondary);
            missing = kickAbsent(secondary);
        }
        if (missing || (user && user.is_banned === true)) {
            const validControl = await control(ctx, 'kick', 'https://kick.com/api/v2/channels/' + CONTROL.kick, response => {
                const known = kickAccount(response);
                return known && known.slug.toLowerCase() === CONTROL.kick && known.is_banned !== true;
            }, events);
            return record(validControl ? 'suspect' : 'unknown', validControl ? user ? '官方標示此帳戶受到封禁；請覆核，未自動刪除。' : '兩個官方入口均找不到頻道；可能改名或停用，請覆核。' : '官方對照查詢未能確認，暫不判定此頻道失效。', events, user ? { accountId: String(user.id) } : null);
        }
        if (!user) return record('unknown', '未能取得 Kick 帳戶身份；保護頁或 API 錯誤不代表頻道失效。', events);
        const identity = { accountId: String(user.id) };
        if (user.slug.toLowerCase() !== slug || /^https?:\/\//i.test(String(channel.id))) return record('repair', '官方帳戶已確認，可改用目前的頻道名稱。', events, Object.assign(identity, { suggestion: { id: user.slug.toLowerCase(), platform: 'kick' } }));
        if (user.livestream === null) return record('offline', '帳戶存在，目前沒有直播。', events, identity);
        if (user.livestream && typeof user.livestream.is_live === 'boolean') return record(user.livestream.is_live ? 'live' : 'offline', user.livestream.is_live ? '帳戶存在，正在直播。' : '帳戶存在，目前沒有直播。', events, identity);
        return record('exists', 'Kick 官方已確認帳戶存在。', events, identity);
    }

    function goshIdentity(response, slug) {
        if (!usable(response)) return null;
        const objects = flattenObjects(metadataObjects(response.text));
        const type = (value, name) => value['@type'] === name || (Array.isArray(value['@type']) && value['@type'].includes(name));
        function sameUrl(value) {
            try { const url = new URL(value); return url.hostname.toLowerCase() === 'gosh.com' && url.pathname.replace(/\/$/, '').toLowerCase() === '/' + slug.toLowerCase(); } catch (error) { return false; }
        }
        const profile = objects.find(value => type(value, 'ProfilePage') && sameUrl(value.url || String(value['@id'] || '').split('#')[0]));
        const person = objects.find(value => type(value, 'Person') && sameUrl(value.url || String(value['@id'] || '').split('#')[0]));
        return profile && person ? person : null;
    }
    async function gosh(channel, ctx) {
        const events = [], slug = userLogin(channel.id, ['gosh.com', 'www.gosh.com']);
        if (!slug) return record('unknown', 'Gosh 頻道名稱格式未能確認。', events);
        const url = 'https://gosh.com/' + encodeURIComponent(slug);
        const response = await request(ctx, url);
        const person = goshIdentity(response, slug);
        events.push(evidence(url, response, person ? '官方頁面含有相符的 ProfilePage 和 Person 身份資料。' : '未取得相符的官方個人頁身份。', 'Gosh 官方個人頁'));
        if (!person) return record('unknown', '尚未確認官方個人頁；未開台或空白代理回應不能證明帳戶失效。', events);
        const proxyUrl = 'https://gosh.chicktv02.workers.dev/?channelId=' + encodeURIComponent(slug);
        const liveResponse = await request(ctx, proxyUrl, { direct: true });
        const liveData = usable(liveResponse) && json(liveResponse.text);
        const failedStatus = liveData && [liveData.status, liveData.statusCode].some(value => Number(value) >= 400 || /^(?:error|failed|failure)$/i.test(String(value)));
        const validLive = liveData && !failedStatus && !liveData.error && !liveData.errors && liveData.success !== false && typeof liveData.isLive === 'boolean' && (!liveData.channelId || String(liveData.channelId).toLowerCase() === slug);
        events.push(evidence(proxyUrl, liveResponse, validLive ? '已取得直播狀態輔助資料；沒有保存播放網址。' : failedStatus ? '輔助服務回報上游錯誤，不能據此判定離線。' : '直播狀態輔助服務暫未能確認。', 'Gosh 直播狀態輔助'));
        const identity = accountId(person.identifier && typeof person.identifier === 'object' ? person.identifier.value : person.identifier);
        const extra = identity ? { accountId: identity } : undefined;
        if (validLive) return record(liveData.isLive ? 'live' : 'offline', liveData.isLive ? '官方帳戶存在，輔助服務顯示正在直播。' : '官方帳戶存在，目前沒有直播。', events, extra);
        return record('exists', 'Gosh 官方個人頁仍然存在；直播狀態暫時未能確認。', events, extra);
    }

    function angelIdentity(response, slug) {
        const data = usable(response) && json(response.text);
        return data && data.user && accountId(data.user.id) && String(data.user.username || '').toLowerCase() === slug ? data : null;
    }
    async function angel(channel, ctx) {
        const events = [], slug = userLogin(channel.id, ['angelthump.com', 'www.angelthump.com']);
        if (!slug) return record('unknown', 'AngelThump 名稱格式未能確認。', events);
        const url = 'https://api.angelthump.com/v2/streams/' + encodeURIComponent(slug);
        const response = await request(ctx, url);
        const data = angelIdentity(response, slug);
        events.push(evidence(url, response, data ? '官方回傳相符的使用者身份。' : '串流入口未提供可驗證的帳戶身份。', 'AngelThump 官方 API'));
        if (data && data.user.banned !== true) return record(data.type === 'live' ? 'live' : data.type === 'offline' ? 'offline' : 'exists', data.type === 'live' ? '帳戶存在，正在直播。' : '帳戶身份仍然存在；離線不代表失效。', events, { accountId: String(data.user.id) });
        const payload = response && json(response.text);
        const negative = response && response.status === 404 && payload && /(?:user|channel) (?:not found|does not exist)/i.test(payload.message || payload.msg || '');
        if ((data && data.user.banned === true) || negative) {
            const validControl = await control(ctx, 'at', 'https://api.angelthump.com/v2/streams/' + CONTROL.at, response => {
                const known = angelIdentity(response, CONTROL.at);
                return known && known.user.banned !== true;
            }, events);
            if (validControl) return record('suspect', data ? '官方標示帳戶受到封禁，請覆核。' : '官方明確找不到此帳戶，請覆核是否改名或停用。', events, data ? { accountId: String(data.user.id) } : undefined);
        }
        return record('unknown', '串流 API 暫未能確認帳戶；HTTP 錯誤或沒有串流不能當作帳戶已刪除。', events);
    }

    function vaughnIdentity(response) {
        const data = usable(response) && json(response.text);
        if (!data || typeof data.live !== 'boolean') return null;
        const populated = ['followers', 'pageviews', 'lastlive', 'lastoffair'].some(key => data[key] !== null && data[key] !== undefined && data[key] !== '' && /^\d+$/.test(String(data[key])));
        return populated || data.live === true ? data : null;
    }
    async function vaughn(channel, ctx) {
        const events = [], slug = userLogin(channel.id, ['vaughn.live', 'myvaughn.com']);
        if (!slug) return record('unknown', 'Vaughn 頻道名稱格式未能確認。', events);
        const url = 'https://api.vaughnsoft.net/v1/stream/vl/' + encodeURIComponent(slug);
        const response = await request(ctx, url);
        const data = vaughnIdentity(response);
        events.push(evidence(url, response, data ? '官方回傳直播狀態或已填入的帳戶統計資料。' : '未取得已填入的帳戶身份資料。', 'Vaughn 官方 API'));
        if (data) return record(data.live ? 'live' : 'offline', data.live ? '帳戶存在，正在直播。' : '帳戶統計資料存在，目前沒有直播。', events);
        const payload = usable(response) && json(response.text);
        const emptyProfile = payload && payload.live === false && ['followers', 'pageviews', 'lastlive', 'lastoffair'].every(key => Object.prototype.hasOwnProperty.call(payload, key) && payload[key] === null);
        if (emptyProfile && await control(ctx, 'vaughn', 'https://api.vaughnsoft.net/v1/stream/vl/' + CONTROL.vaughn, vaughnIdentity, events)) return record('suspect', '官方只回傳空白帳戶資料，與正常對照頻道不同；請覆核。', events);
        return record('unknown', 'Vaughn 未能提供可驗證的帳戶資料，不能判定失效。', events);
    }

    function okMetadata(response, id) {
        if (!usable(response)) return null;
        const objects = flattenObjects(metadataObjects(response.text));
        const provider = objects.some(value => value.provider === 'LIVE_TV_ODKL');
        const movie = objects.find(value => String(value.movieId || value.id || '') === id && (typeof value.status === 'string' || typeof value.isLive === 'boolean'));
        return provider && movie ? movie : null;
    }
    async function ok(channel, ctx) {
        const events = [], id = String(channel.id || '').trim();
        if (!/^\d+$/.test(id)) return record('unknown', 'OK.ru 播放器需要數字影片 ID。', events);
        const url = 'https://ok.ru/videoembed/' + id;
        const response = await request(ctx, url);
        const movie = okMetadata(response, id);
        events.push(evidence(url, response, movie ? '已取得相符的 LIVE_TV_ODKL 直播影片資料。' : '尚未取得相符的影片身份資料。', 'OK.ru 官方播放器'));
        if (movie) return record(movie.status === 'ONLINE' ? 'live' : movie.status === 'OFFLINE' ? 'offline' : 'exists', movie.status === 'ONLINE' ? '直播影片存在，正在播出。' : '直播影片仍然存在；沒有播放不代表已刪除。', events, { accountId: id });
        if (!uncertain(response)) {
            const text = visibleText(response.text);
            const explicit = /video (?:not found|has been deleted)|video is unavailable|автор заблокирован|видео не найдено|影片不存在|影片已刪除|作者已被封鎖/i.test(text);
            if (explicit && await control(ctx, 'ok', 'https://ok.ru/videoembed/' + CONTROL.ok, response => okMetadata(response, CONTROL.ok), events)) return record('suspect', '官方播放器明確表示影片不存在或作者受限制；請覆核此入口。', events, { accountId: id });
        }
        return record('unknown', 'OK.ru 播放器受阻或資料不足，未能判定影片是否失效。', events);
    }

    async function goodgame(channel, ctx) {
        const events = [], id = String(channel.id || '').trim();
        if (channel.ggUsername && SLUG.test(channel.ggUsername)) {
            const url = 'https://goodgame.ru/api/4/users/' + encodeURIComponent(channel.ggUsername) + '/stream';
            const response = await request(ctx, url);
            const data = usable(response) && json(response.text);
            events.push(evidence(url, response, data && /^\d+$/.test(String(data.id)) ? '官方使用者入口回傳播放器身份。' : '未能取得官方使用者與播放器的對應。', 'GoodGame 官方 API'));
            if (!data || !/^\d+$/.test(String(data.id))) return record('unknown', 'GoodGame 官方使用者資料暫時無法確認；未將數字 ID 當成使用者名稱。', events);
            const extra = { accountId: String(data.id) };
            if (String(data.id) !== id) return record('repair', '官方使用者對應的播放器 ID 與現有入口不同。', events, Object.assign(extra, { suggestion: { id: String(data.id), platform: 'goodgame' } }));
            const live = typeof data.status === 'boolean' ? data.status : typeof data.online === 'boolean' ? data.online : null;
            return record(live === null ? 'exists' : live ? 'live' : 'offline', live === null ? 'GoodGame 官方已確認播放器身份。' : live ? '帳戶存在，正在直播。' : '帳戶存在，目前沒有直播。', events, extra);
        }
        if (!/^\d+$/.test(id)) return record('unknown', '缺少已確認的 GoodGame 使用者名稱或數字播放器 ID。', events);
        const url = 'https://goodgame.ru/player?' + id;
        const response = await request(ctx, url);
        const metadata = usable(response) && (propertyObject(response.text, 'stream') || propertyObject(response.text, 'channel'));
        const valid = metadata && String(metadata.id || metadata.stream_id || '') === id && (metadata.channelkey || metadata.username || metadata.name || metadata.title);
        events.push(evidence(url, response, valid ? '官方播放器含相符的身份資料。' : '只檢查原本的數字播放器入口，沒有假設它是使用者名稱。', 'GoodGame 官方播放器'));
        return record(valid ? 'exists' : 'unknown', valid ? 'GoodGame 播放器身份已確認。' : '暫未取得可驗證的播放器資料；載入失敗不等於帳戶已刪除。', events, valid ? { accountId: id } : undefined);
    }

    function youtubeTarget(value) {
        const raw = String(value || '').trim();
        if (VIDEO_ID.test(raw)) return { type: 'video', id: raw };
        if (/^UC[a-z0-9_-]{22}$/i.test(raw)) return { type: 'channel', id: raw };
        if (/^@[a-z0-9_.-]{1,100}$/i.test(raw)) return { type: 'handle', id: raw };
        try {
            const url = new URL(raw);
            if (url.hostname === 'youtu.be') return VIDEO_ID.test(url.pathname.slice(1)) ? { type: 'video', id: url.pathname.slice(1), repair: true } : null;
            if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return null;
            const parts = url.pathname.split('/').filter(Boolean);
            if (parts[0] === 'watch' && VIDEO_ID.test(url.searchParams.get('v') || '')) return { type: 'video', id: url.searchParams.get('v'), repair: true };
            if (['embed', 'live', 'shorts'].includes(parts[0]) && VIDEO_ID.test(parts[1] || '')) return { type: 'video', id: parts[1], repair: true };
            if (parts[0] === 'channel' && /^UC[a-z0-9_-]{22}$/i.test(parts[1] || '')) return { type: 'channel', id: parts[1], repair: true };
            if (/^@[a-z0-9_.-]{1,100}$/i.test(parts[0] || '')) return { type: 'handle', id: parts[0], repair: true };
        } catch (error) {}
        return null;
    }
    function oembedIdentity(response, id) {
        const data = usable(response) && json(response.text);
        return !!data && data.type === 'video' && data.provider_name === 'YouTube' && typeof data.title === 'string' && typeof data.html === 'string' && data.html.includes('/embed/' + id);
    }
    function oembedUrl(id) { return 'https://www.youtube.com/oembed?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id) + '&format=json'; }
    async function youtube(channel, ctx) {
        const events = [], target = youtubeTarget(channel.id);
        if (!target) return record('unknown', 'YouTube 入口格式未能確認；影片 ID 大小寫不會被更改。', events);
        const validControl = () => control(ctx, 'youtube', oembedUrl(CONTROL.youtube), response => oembedIdentity(response, CONTROL.youtube), events);
        if (target.type !== 'video') {
            const url = 'https://www.youtube.com/' + (target.type === 'channel' ? 'channel/' + encodeURIComponent(target.id) : '@' + encodeURIComponent(target.id.slice(1)));
            const response = await request(ctx, url);
            const metadata = usable(response) && propertyObject(response.text, 'channelMetadataRenderer');
            const externalId = metadata && /^UC[a-z0-9_-]{22}$/i.test(metadata.externalId || '') ? metadata.externalId : null;
            let handleMatches = false;
            if (metadata && target.type === 'handle') {
                try {
                    const canonical = new URL(metadata.vanityChannelUrl || metadata.channelUrl);
                    handleMatches = ['youtube.com', 'www.youtube.com'].includes(canonical.hostname) && canonical.pathname.replace(/\/$/, '').toLowerCase() === '/' + target.id.toLowerCase();
                } catch (error) {}
            }
            const matches = externalId && (target.type === 'handle' ? handleMatches : externalId === target.id);
            events.push(evidence(url, response, matches ? '官方頻道頁含相符的頻道身份。' : '尚未取得相符的官方頻道身份。', 'YouTube 官方頻道頁'));
            if (matches) return record(target.repair ? 'repair' : 'exists', 'YouTube 官方頻道仍然存在；沒有正在播出的影片不代表停用。', events, Object.assign({ accountId: externalId }, target.repair ? { suggestion: { id: externalId, platform: 'youtube' } } : {}));
            if (!uncertain(response) && /(?:this (?:page|channel) (?:isn't|is not) available|channel (?:not found|does not exist))/i.test(visibleText(response.text)) && await validControl()) return record('suspect', '官方頁面表示此頻道入口不可用，請覆核是否改名或停用。', events);
            return record('unknown', '未能確認官方頻道頁；存取限制或空白頁不能當作失效。', events);
        }
        const url = oembedUrl(target.id), response = await request(ctx, url);
        const embedded = oembedIdentity(response, target.id);
        events.push(evidence(url, response, embedded ? '官方 oEmbed 已確認相符影片。' : 'oEmbed 暫未能確認影片。', 'YouTube 官方 oEmbed'));
        const watchUrl = 'https://www.youtube.com/watch?v=' + encodeURIComponent(target.id);
        const watch = await request(ctx, watchUrl);
        const details = usable(watch) && propertyObject(watch.text, 'videoDetails');
        const live = usable(watch) && propertyObject(watch.text, 'liveBroadcastDetails');
        const playable = usable(watch) && propertyObject(watch.text, 'playabilityStatus');
        const known = embedded || details && details.videoId === target.id;
        events.push(evidence(watchUrl, watch, details && details.videoId === target.id ? '官方觀看頁含相符的影片身份。' : '觀看頁暫未能確認影片身份。', 'YouTube 官方觀看頁'));
        if (known) {
            if (target.repair) return record('repair', '官方影片已確認，可將完整網址改為保留大小寫的影片 ID。', events, { accountId: target.id, suggestion: { id: target.id, platform: 'youtube' } });
            if (details && details.videoId === target.id && live && live.isLiveNow === true) return record('live', '官方影片資料顯示正在直播。', events, { accountId: target.id });
            if (details && details.videoId === target.id && live && live.isLiveNow === false && typeof live.endTimestamp === 'string' && Number.isFinite(Date.parse(live.endTimestamp)) && Date.parse(live.endTimestamp) <= Date.now()) return record('ended', '這次直播已結束，影片仍是可識別的存檔，並非不存在。', events, { accountId: target.id });
            return record('exists', '官方已確認影片存在；未正在播放不代表失效。', events, { accountId: target.id });
        }
        const explicit = playable && ['ERROR', 'UNPLAYABLE'].includes(playable.status) && /(?:video (?:unavailable|has been removed|is private)|this video (?:is no longer available|has been removed))/i.test(playable.reason || '');
        if (!uncertain(response) && !uncertain(watch) && explicit && await validControl()) return record('suspect', '官方明確表示此影片目前無法使用；請覆核這個影片入口。', events, { accountId: target.id });
        return record('unknown', 'YouTube 存取受限或資料不足，不能以沒有播放判定影片或頻道已刪除。', events);
    }

    async function generic(channel, ctx) {
        const events = [], raw = String(channel.id || '').trim();
        let url;
        try { url = new URL(raw); } catch (error) { return record('unknown', '需要完整的 HTTP 或 HTTPS 播放網址。', events); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return record('unknown', '此網址不能安全地進行一般檢查，未傳送到代理。', events);
        const response = await request(ctx, raw, { direct: true, maxBytes: 262144 });
        events.push(evidence(raw, response, '只直接檢查指定入口；證據未保存網址路徑、參數或簽署資料。', '指定播放網址', true));
        if (uncertain(response)) return record('unknown', '網路、權限或跨來源限制令檢查未能完成；沒有把網址交給第三方代理。', events);
        if ([404, 410].includes(response.status)) return record('suspect', '這個播放網址回報找不到資源；只代表入口有問題，不能推斷帳戶已刪除。', events);
        if (!usable(response) || !response.text.trim()) return record('unknown', '未取得有效的播放內容，暫時無法確認。', events);
        if (/^\s*#EXTM3U(?:\s|$)/.test(response.text)) return record(/^#EXT-X-ENDLIST\s*$/m.test(response.text) ? 'ended' : 'exists', /^#EXT-X-ENDLIST\s*$/m.test(response.text) ? '有效播放清單已標示結束；屬已結束內容。' : '入口提供有效的 HLS 播放清單。', events);
        if (channel.platform === 'bs') {
            const text = visibleText(response.text);
            const blocked = /(?:just a moment|checking your browser|verify (?:you are|that you are) human|security verification|access denied|sign in to continue|log in to continue)/i.test(text) || /(?:cf-chl-|challenge-platform|id=["']challenge-form)/i.test(response.text);
            if (blocked) return record('unknown', '播放入口回傳保護頁、登入頁或錯誤頁，尚未確認播放器。', events);
            const offline = /channel is offline/i.test(text);
            const player = /<(?:iframe|video)\b[^>]*(?:src|data-src)\s*=/i.test(response.text) || /<video\b[\s\S]*?<source\b[^>]*src\s*=/i.test(response.text);
            if (offline || player) return record(offline ? 'offline' : 'exists', offline ? '播放頁仍存在，頁面標示目前離線。' : '指定入口包含播放器；沒有推斷其帳戶身份。', events);
        }
        return record('unknown', '回應並非可識別的播放清單或播放頁，未判定入口失效。', events);
    }

    const adapters = { twitch, kick, gosh, at: angel, vaughn, ok, goodgame, youtube, m3u8: generic, bs: generic };
    async function check(channel, ctx) {
        if (!channel || !ctx || typeof ctx.request !== 'function') return record('unknown', '檢查資料或網路服務未準備好。', []);
        const platform = ALIASES[String(channel.platform || '').toLowerCase()] || String(channel.platform || '').toLowerCase();
        const adapter = adapters[platform];
        if (!adapter) return record('unknown', '這個平台暫時未有可驗證的檢查方法。', []);
        try { return await adapter(Object.assign({}, channel, { platform }), ctx); }
        catch (error) { return record('unknown', ctx.signal && ctx.signal.aborted ? '檢查已取消。' : '檢查未能完成，未將錯誤當作頻道失效。', []); }
    }
    const api = { check, run: check };
    root.ChannelHealthPlatforms = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
