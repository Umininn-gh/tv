/* Shared, authenticated writes to the public channel list. Tokens are never stored. */
(function (root) {
    'use strict';

    const ChannelList = root.ChannelList || (typeof require === 'function' ? require('./channel-list.js') : null);
    const UNSAFE_FIELD = /[,\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

    function failure(code, message, status) {
        const error = new Error(message);
        error.code = code;
        error.isChannelSyncError = true;
        if (status) error.status = status;
        return error;
    }

    function publicChannel(value) {
        if (!ChannelList) throw failure('configuration', '未能載入頻道清單工具，請重新整理頁面。');
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('validation', '頻道資料不完整。');
        for (const field of ['name', 'id', 'platform', 'ggUsername']) {
            if (value[field] !== undefined && UNSAFE_FIELD.test(String(value[field]))) {
                throw failure('validation', '頻道名稱、ID 及平台不能包含逗號、換行或控制字元。');
            }
        }
        const normalized = ChannelList.normalizeChannel(value);
        if (!normalized) throw failure('validation', '請填寫有效的頻道名稱、ID 及支援的平台。');
        if (normalized.platform === 'goodgame' && value.ggUsername && !normalized.ggUsername) throw failure('validation', 'GoodGame 使用者名稱格式不正確。');
        if (normalized.platform === 'bs' || normalized.platform === 'm3u8') {
            let source;
            try { source = new URL(normalized.id); } catch (_) { /* Report the same actionable validation error below. */ }
            if (!/^https?:\/\//i.test(normalized.id) || !source || !['https:', 'http:'].includes(source.protocol) || !source.hostname) {
                throw failure('validation', 'M3U8 及嵌入播放器必須使用完整的 http:// 或 https:// 網址。');
            }
            if (source.username || source.password) throw failure('validation', '共享清單不能包含網址內的私人登入帳號或密碼，請使用不含登入資料的公開網址。');
        }
        const channel = { name: normalized.name, id: normalized.id, platform: normalized.platform };
        if (normalized.ggUsername) channel.ggUsername = normalized.ggUsername;
        return channel;
    }

    function validateChannels(values) {
        if (!Array.isArray(values)) throw failure('validation', '頻道清單格式不正確。');
        const seen = new Set();
        return values.map(value => {
            const channel = publicChannel(value);
            const key = ChannelList.channelKey(channel);
            if (seen.has(key)) throw failure('duplicate', '清單內已有相同平台及 ID 的頻道。');
            seen.add(key);
            return channel;
        });
    }

    function parseChannelText(raw) {
        if (typeof raw !== 'string') throw failure('invalid_data', '遠端頻道清單不是有效文字。');
        const channels = [];
        const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            if (!line.trim() || line.trim().startsWith('#')) continue;
            const parts = line.split(',');
            if (parts.length < 3 || parts.length > 4 || (parts.length === 4 && parts[2].trim().toLowerCase() !== 'goodgame')) {
                throw failure('invalid_data', `遠端清單第 ${index + 1} 行格式不正確；已停止同步以保留原有資料。`);
            }
            try {
                channels.push(publicChannel({ name: parts[0], id: parts[1], platform: parts[2], ...(parts.length === 4 ? { ggUsername: parts[3] } : {}) }));
            } catch (_) {
                throw failure('invalid_data', `遠端清單第 ${index + 1} 行包含未知平台或無效資料；已停止同步以保留原有資料。`);
            }
        }
        try { return validateChannels(channels); } catch (_) {
            throw failure('invalid_data', '遠端清單包含重複頻道；已停止同步以保留原有資料。');
        }
    }

    function serializeChannels(values) {
        const channels = validateChannels(values);
        return channels.map(channel => [channel.name, channel.id, channel.platform, ...(channel.ggUsername ? [channel.ggUsername] : [])].join(',')).join('\n') + (channels.length ? '\n' : '');
    }

    function encodeUtf8(text) {
        const bytes = new TextEncoder().encode(text);
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        return btoa(binary);
    }

    function decodeUtf8(base64) {
        try {
            const binary = atob(base64.replace(/\s/g, ''));
            return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
        } catch (_) { throw failure('invalid_data', '遠端頻道清單的 UTF-8 編碼不正確。'); }
    }

    function sameChannel(left, right) {
        return !!left && !!right && ['name', 'id', 'platform', 'ggUsername'].every(field => (left[field] || '') === (right[field] || ''));
    }

    function requireWriteToken(token) {
        if (typeof token !== 'string' || !token.trim() || /[\u0000-\u0020\u007f]/.test(token)) throw failure('auth', '請先輸入有權修改這個程式庫的 GitHub 憑證。');
    }

    function prepareMutation(snapshot, mutation) {
        if (!snapshot || typeof snapshot.sha !== 'string' || !snapshot.sha) throw failure('validation', '請先重新載入共享清單，再儲存修改。');
        const original = validateChannels(snapshot.channels);
        if (!mutation || !['add', 'edit', 'delete'].includes(mutation.action)) throw failure('validation', '不支援這個頻道操作。');
        const prepared = { action: mutation.action };
        if (mutation.action !== 'delete') prepared.channel = publicChannel(mutation.channel);
        if (mutation.action !== 'add') {
            const previous = publicChannel(mutation.previous);
            const key = ChannelList.channelKey(previous);
            const expected = original.find(channel => ChannelList.channelKey(channel) === key);
            if (!sameChannel(expected, previous)) throw failure('conflict', '這個頻道的資料已改變，請重新載入後再修改。');
            prepared.previous = expected;
        }
        return prepared;
    }

    function applyMutation(latest, mutation) {
        const channels = validateChannels(latest.channels);
        let targetIndex = -1;
        if (mutation.previous) {
            const previousKey = ChannelList.channelKey(mutation.previous);
            targetIndex = channels.findIndex(channel => ChannelList.channelKey(channel) === previousKey);
            if (targetIndex < 0 || !sameChannel(channels[targetIndex], mutation.previous)) {
                throw failure('conflict', '另一個人已修改或刪除這個頻道，請重新載入後再修改。');
            }
        }
        if (mutation.channel) {
            const nextKey = ChannelList.channelKey(mutation.channel);
            if (channels.some((channel, index) => index !== targetIndex && ChannelList.channelKey(channel) === nextKey)) {
                throw failure('duplicate', '已有相同平台及 ID 的頻道，請編輯現有項目。');
            }
        }
        if (mutation.action === 'add') channels.push(mutation.channel);
        else if (mutation.action === 'edit') channels[targetIndex] = mutation.channel;
        else channels.splice(targetIndex, 1);
        return channels;
    }

    function createClient(config, fetcher) {
        if (!config || !/^[A-Za-z0-9-]+$/.test(config.owner || '') || !/^[A-Za-z0-9_.-]+$/.test(config.repo || '') ||
            typeof config.branch !== 'string' || !config.branch.trim() || /[\u0000-\u001f\u007f]/.test(config.branch) ||
            typeof config.path !== 'string' || !config.path || config.path.split('/').some(part => !part || part === '.' || part === '..' || /[\\\u0000-\u001f\u007f]/.test(part))) {
            throw failure('configuration', '共享清單的 GitHub 設定不正確。');
        }
        const send = fetcher || root.fetch;
        if (typeof send !== 'function') throw failure('configuration', '瀏覽器未能連接 GitHub，請重新整理頁面。');
        const path = config.path.split('/').map(encodeURIComponent).join('/');
        const endpoint = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${path}`;
        const branch = config.branch;
        const timeoutMs = Number.isFinite(config.requestTimeoutMs) && config.requestTimeoutMs > 0 ? config.requestTimeoutMs : 20000;

        async function request(method, token, body) {
            const controller = new AbortController();
            let timer;
            const deadline = new Promise((_resolve, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    reject(failure('timeout', 'GitHub 連線逾時；如正在儲存，請重新載入清單確認結果。'));
                }, timeoutMs);
            });
            try {
                const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
                if (token) headers.Authorization = `Bearer ${token}`;
                if (body) headers['Content-Type'] = 'application/json';
                const response = await Promise.race([send(method === 'GET' ? `${endpoint}?ref=${encodeURIComponent(branch)}` : endpoint, {
                    method, headers, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
                    ...(body ? { body: JSON.stringify(body) } : {})
                }), deadline]);
                if (!response.ok) {
                    if (response.status === 401) throw failure('auth', 'GitHub 憑證無效或已過期，請重新輸入。', 401);
                    if (response.status === 403 || response.status === 429) {
                        const remaining = response.headers && response.headers.get('x-ratelimit-remaining');
                        if (response.status === 429 || remaining === '0') throw failure('rate_limit', 'GitHub 查詢次數已達上限，請稍後再試。', response.status);
                        throw failure('permission', 'GitHub 拒絕存取；請確認憑證可讀寫這個程式庫的 Contents。', 403);
                    }
                    if (response.status === 409 || response.status === 422) throw failure('write_conflict', 'GitHub 清單已更新，正在檢查修改是否衝突。', response.status);
                    if (response.status === 404) throw failure('not_found', '找不到共享清單；請確認程式庫設定及憑證權限。', 404);
                    throw failure('http', `GitHub 暫時未能處理要求（${response.status}），請稍後再試。`, response.status);
                }
                try { return await Promise.race([response.json(), deadline]); } catch (error) {
                    if (error && error.isChannelSyncError) throw error;
                    throw failure('invalid_data', 'GitHub 回傳的資料格式不正確。');
                }
            } catch (error) {
                if (error && error.isChannelSyncError) throw error;
                if (controller.signal.aborted || (error && error.name === 'AbortError')) throw failure('timeout', 'GitHub 連線逾時；如正在儲存，請重新載入清單確認結果。');
                throw failure('network', '未能連接 GitHub；如正在儲存，請重新載入清單確認結果。');
            } finally { clearTimeout(timer); }
        }

        async function read(token = '') {
            const data = await request('GET', token);
            if (!data || data.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string' || typeof data.sha !== 'string' || !data.sha) {
                throw failure('invalid_data', 'GitHub 回傳的頻道檔案格式不正確。');
            }
            const raw = decodeUtf8(data.content);
            return { channels: parseChannelText(raw), raw, sha: data.sha };
        }

        async function save(snapshot, mutation, token) {
            requireWriteToken(token);
            const prepared = prepareMutation(snapshot, mutation);
            for (let attempt = 0; attempt < 2; attempt++) {
                const latest = await read(token);
                const channels = applyMutation(latest, prepared);
                const raw = serializeChannels(channels);
                const body = { message: `Update shared channels (${prepared.action})`, content: encodeUtf8(raw), sha: latest.sha, branch };
                try {
                    const result = await request('PUT', token, body);
                    if (!result || !result.content || typeof result.content.sha !== 'string' || !result.content.sha) {
                        throw failure('invalid_data', 'GitHub 未確認儲存結果，請重新載入清單確認。');
                    }
                    return { channels, raw, sha: result.content.sha, baseRaw: latest.raw, ...(result.commit ? { commit: result.commit } : {}) };
                } catch (error) {
                    if (error.code !== 'write_conflict') throw error;
                    if (attempt === 1) throw failure('conflict', '共享清單同時有其他修改，請重新載入後再試。');
                }
            }
        }

        async function addMissing(candidates, token) {
            requireWriteToken(token);
            if (!Array.isArray(candidates)) throw failure('validation', '頻道清單格式不正確。');
            const seen = new Set();
            const prepared = [];
            for (const value of candidates) {
                const channel = publicChannel(value);
                const key = ChannelList.channelKey(channel);
                if (!seen.has(key)) {
                    seen.add(key);
                    prepared.push(channel);
                }
            }
            for (let attempt = 0; attempt < 2; attempt++) {
                const latest = await read(token);
                const existing = new Set(latest.channels.map(ChannelList.channelKey));
                const added = prepared.filter(channel => !existing.has(ChannelList.channelKey(channel)));
                if (!added.length) return { ...latest, added: [], unchanged: true, baseRaw: latest.raw };
                const channels = [...latest.channels, ...added];
                // Keep all existing rows, comments and public metadata exactly as read.
                const raw = latest.raw + (latest.raw && !latest.raw.endsWith('\n') ? '\n' : '') + serializeChannels(added);
                const body = { message: 'Update shared channels (add missing)', content: encodeUtf8(raw), sha: latest.sha, branch };
                try {
                    const result = await request('PUT', token, body);
                    if (!result || !result.content || typeof result.content.sha !== 'string' || !result.content.sha) {
                        throw failure('invalid_data', 'GitHub 未確認儲存結果，請重新載入清單確認。');
                    }
                    return { channels, raw, sha: result.content.sha, added, unchanged: false, baseRaw: latest.raw, ...(result.commit ? { commit: result.commit } : {}) };
                } catch (error) {
                    if (error.code !== 'write_conflict') throw error;
                    if (attempt === 1) throw failure('conflict', '共享清單同時有其他修改，請重新載入後再試。');
                }
            }
        }

        return Object.freeze({ read, save, addMissing });
    }

    const api = { createClient, parseChannelText, serializeChannels };
    root.ChannelSync = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
