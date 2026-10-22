/* Shared layouts use optimistic document versions; a failed save never becomes local success. */
(function (root) {
    'use strict';
    const layouts = typeof module === 'object' && module.exports ? require('./layout-bookmarks.js') : root.LayoutBookmarks;
    const ENDPOINT = 'https://firestore.googleapis.com/v1/projects/test-3ebe7/databases/(default)/documents/layoutBookmarks/shared';
    const CACHE_KEY = 'umininn.layoutBookmarks.sharedCache.v1';
    const MAX_BYTES = 850 * 1024;
    const copy = value => JSON.parse(JSON.stringify(value));
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const layoutIdentity = snapshot => ({ keys: snapshot.channels.map(channel => channel.key), columns: snapshot.columns, focus: snapshot.focus });
    class SharedBookmarkError extends Error {
        constructor(code, message, details = {}) { super(message); this.name = 'SharedBookmarkError'; this.code = code; Object.assign(this, details); }
    }
    const invalid = message => new SharedBookmarkError('invalid', message);
    const conflict = () => new SharedBookmarkError('conflict', '其他使用者剛修改了這個書籤，請重新載入後再試。');
    function nameOf(name) {
        if (typeof name !== 'string' || !name.trim()) throw invalid('請輸入書籤名稱。');
        return Array.from(name.trim()).slice(0, 60).join('');
    }
    function savedSnapshot(snapshot) {
        if (!snapshot || !Array.isArray(snapshot.channels) || snapshot.channels.some(channel =>
            !channel || !Number.isInteger(channel.color) || channel.color < 0 || channel.color > 359)) {
            throw invalid('書籤配色資料不完整；原有資料已保留。');
        }
        return layouts.normalizeSnapshot(snapshot);
    }
    function normalizeDocument(data) {
        if (!data || data.version !== 1 || !Array.isArray(data.bookmarks) || data.bookmarks.length > 50) {
            throw invalid('共用書籤資料版本不相容或超過 50 個；原有資料已保留。');
        }
        const ids = new Set();
        const bookmarks = data.bookmarks.map(entry => {
            if (!entry || typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 100 || ids.has(entry.id) ||
                !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.updatedAt)) throw invalid('共用書籤資料不完整；原有資料已保留。');
            ids.add(entry.id);
            return { id: entry.id, name: nameOf(entry.name), snapshot: savedSnapshot(entry.snapshot),
                createdAt: entry.createdAt, updatedAt: entry.updatedAt };
        });
        const normalized = { version: 1, bookmarks };
        if (new TextEncoder().encode(JSON.stringify(normalized)).length > MAX_BYTES) throw invalid('書籤資料太大，請減少書籤或頻道數目。');
        return normalized;
    }
    function createTransport({ endpoint = ENDPOINT, fetcher = root.fetch?.bind(root), timeoutMs = 15000 } = {}) {
        if (typeof fetcher !== 'function') throw invalid('此瀏覽器未能連接共用書籤。');
        const missing = Symbol('missing document');
        async function request(method, url, body) {
            const controller = new AbortController();
            let timedOut = false;
            let timer;
            const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
                timedOut = true; controller.abort(); reject(new Error('timeout'));
            }, timeoutMs); });
            try {
                const response = await Promise.race([timeout, fetcher(url, { method, cache: 'no-store', signal: controller.signal,
                    headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })]);
                let data;
                try { data = await Promise.race([timeout, response.json()]); } catch (_) {
                    if (timedOut) throw new Error('timeout');
                    if (response.ok) throw new SharedBookmarkError('invalid-response', '伺服器回應不完整，請重新載入確認。', { outcomeUnknown: method !== 'GET' });
                    data = null;
                }
                if (!response.ok) {
                    if (method === 'GET' && response.status === 404) return missing;
                    const condition = data?.error?.status;
                    if (method !== 'GET' && (response.status === 409 || response.status === 412 ||
                        (response.status === 400 && condition === 'FAILED_PRECONDITION'))) throw conflict();
                    const code = response.status === 403 ? 'permission-denied' : response.status === 429 ? 'rate-limited' :
                        response.status === 503 ? 'unavailable' : 'server';
                    const outcomeUnknown = method !== 'GET' && response.status >= 500;
                    const message = code === 'permission-denied' ? '網站未允許讀寫共用書籤。' : code === 'rate-limited' ?
                        '共用書籤暫時繁忙，請稍後再試。' : outcomeUnknown ? '未能確認書籤是否已儲存，請先重新載入查看。' : '暫時未能連接共用書籤，請稍後再試。';
                    throw new SharedBookmarkError(code, message, { status: response.status, outcomeUnknown });
                }
                return data;
            } catch (error) {
                if (error instanceof SharedBookmarkError) throw error;
                throw new SharedBookmarkError(timedOut ? 'timeout' : 'network', method !== 'GET' ? '未能確認書籤是否已儲存，請先重新載入查看。' :
                    timedOut ? '共用書籤連線逾時，請重新載入確認。' : '共用書籤連線失敗，請檢查網絡後重新載入。', { outcomeUnknown: method !== 'GET', cause: error });
            } finally { clearTimeout(timer); }
        }
        function decode(data) {
            if (data === missing) return { document: { version: 1, bookmarks: [] }, token: null };
            if (!data || typeof data !== 'object') throw invalid('共用書籤回應資料不完整。');
            if (data.fields?.version?.integerValue !== '1' && data.fields?.version?.integerValue !== 1) throw invalid('共用書籤資料版本不相容。');
            if (typeof data.updateTime !== 'string' || !data.updateTime || typeof data.fields?.payload?.stringValue !== 'string') throw invalid('共用書籤回應資料不完整。');
            let document;
            try { document = JSON.parse(data.fields.payload.stringValue); } catch (_) { throw invalid('共用書籤資料無法讀取；原有資料已保留。'); }
            return { document: normalizeDocument(document), token: data.updateTime };
        }
        return {
            async read() { return decode(await request('GET', endpoint)); },
            async write(document, token) {
                const normalized = normalizeDocument(document);
                if (token !== null && (typeof token !== 'string' || !token)) throw invalid('共用書籤版本資料不完整。');
                const query = token === null ? 'currentDocument.exists=false' : 'currentDocument.updateTime=' + encodeURIComponent(token);
                const result = await request('PATCH', endpoint + (endpoint.includes('?') ? '&' : '?') + query, {
                    fields: { version: { integerValue: '1' }, payload: { stringValue: JSON.stringify(normalized) } }
                });
                try { return decode(result); } catch (error) { error.outcomeUnknown = true; throw error; }
            }
        };
    }
    function createStore({ transport = createTransport(), cacheStorage, now = () => Date.now(), makeId } = {}) {
        let bookmarks = [], removed = null, error = null, syncState = 'idle', queue = Promise.resolve(), sequence = 0;
        const listeners = new Set();
        if (cacheStorage === undefined) { try { cacheStorage = root.localStorage; } catch (_) {} }
        try {
            const cached = cacheStorage?.getItem(CACHE_KEY);
            if (cached) bookmarks = normalizeDocument(JSON.parse(cached)).bookmarks;
        } catch (_) { /* The network remains authoritative when the optional cache is corrupt or unavailable. */ }
        function emit() {
            const state = { syncState, error, bookmarks: copy(bookmarks) };
            listeners.forEach(listener => { try { listener(state); } catch (_) {} });
        }
        function commit(next) {
            bookmarks = normalizeDocument({ version: 1, bookmarks: next }).bookmarks;
            try { cacheStorage?.setItem(CACHE_KEY, JSON.stringify({ version: 1, bookmarks })); } catch (_) {}
        }
        function schedule(task, isReload = false) {
            const pending = queue.then(async () => {
                syncState = 'syncing'; error = null; emit();
                try {
                    const result = await task();
                    syncState = 'synced'; error = null; emit();
                    return result;
                } catch (failure) {
                    error = failure; syncState = isReload || ['network', 'timeout', 'unavailable'].includes(failure?.code) ? 'offline' : 'error';
                    emit(); throw failure;
                }
            });
            queue = pending.catch(() => {});
            return pending;
        }
        async function mutate(change) {
            for (let attempt = 0; attempt < 3; attempt++) {
                const latest = await transport.read();
                const normalized = normalizeDocument(latest.document);
                const mutation = change(copy(normalized.bookmarks));
                if (mutation.unchanged) {
                    commit(normalized.bookmarks); mutation.after?.(); return copy(mutation.result);
                }
                const next = normalizeDocument({ version: 1, bookmarks: mutation.bookmarks });
                let saved;
                try { saved = await transport.write(next, latest.token); } catch (failure) {
                    if (failure?.code === 'conflict' && !failure.outcomeUnknown && attempt < 2) continue;
                    throw failure;
                }
                // Only the server-confirmed document may be used as the new cache.
                const confirmed = normalizeDocument(saved?.document);
                commit(confirmed.bookmarks); mutation.after?.(); return copy(mutation.result);
            }
            throw conflict();
        }
        const expectedEntry = id => copy(bookmarks.find(entry => entry.id === id) || null);
        function findExpected(latest, expected, fields) {
            if (!expected) throw conflict();
            const index = latest.findIndex(entry => entry.id === expected.id);
            if (index < 0 || fields.some(field => !same(latest[index][field], expected[field]))) throw conflict();
            return index;
        }
        function uniqueId(latest) {
            for (let tries = 0; tries < 100; tries++) {
                const id = makeId ? makeId() : 'layout-' + now().toString(36) + '-' + (++sequence).toString(36) + '-' +
                    (root.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
                if (typeof id === 'string' && id.trim() && id.length <= 100 && !latest.some(entry => entry.id === id)) return id;
            }
            throw invalid('未能建立獨立書籤編號，請再試一次。');
        }
        const store = {
            list: () => copy(bookmarks), getError: () => error, canUndo: () => Boolean(removed), getSyncState: () => syncState,
            subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
            reload() { return schedule(async () => { const result = await transport.read(); commit(normalizeDocument(result.document).bookmarks); return copy(bookmarks); }, true); },
            async add(name, snapshot) {
                const captured = copy(snapshot);
                return schedule(async () => {
                    const normalizedName = nameOf(name), normalized = layouts.normalizeSnapshot(captured);
                    let entry;
                    return mutate(latest => {
                        if (latest.length >= 50) throw invalid('最多可儲存 50 個佈局，請先刪除不再使用的書籤。');
                        if (!entry || latest.some(item => item.id === entry.id)) {
                            const stamp = now(); entry = { id: uniqueId(latest), name: normalizedName, snapshot: normalized, createdAt: stamp, updatedAt: stamp };
                        }
                        return { bookmarks: [entry, ...latest], result: entry };
                    });
                });
            },
            async rename(id, name, options = {}) {
                const expected = options.expected ? copy(options.expected) : expectedEntry(id);
                return schedule(() => {
                    const normalized = nameOf(name);
                    return mutate(latest => {
                        const index = findExpected(latest, expected, ['name']);
                        latest[index] = { ...latest[index], name: normalized, updatedAt: now() };
                        return { bookmarks: latest, result: latest[index] };
                    });
                });
            },
            async update(id, snapshot, options = {}) {
                const expected = options.expected ? copy(options.expected) : expectedEntry(id);
                const captured = copy(snapshot);
                return schedule(() => {
                    if (!expected) throw conflict();
                    const colors = new Map(expected.snapshot.channels.map(channel => [channel.key, channel.color]));
                    const candidate = captured && Array.isArray(captured.channels) ? { ...captured, channels: captured.channels.map(channel =>
                        channel && colors.has(channel.key) ? { ...channel, color: colors.get(channel.key) } : channel) } : captured;
                    const normalized = layouts.normalizeSnapshot(candidate);
                    return mutate(latest => {
                        const index = findExpected(latest, expected, ['snapshot']);
                        latest[index] = { ...latest[index], snapshot: normalized, updatedAt: now() };
                        return { bookmarks: latest, result: latest[index] };
                    });
                });
            },
            async remove(id, options = {}) {
                const expected = options.expected ? copy(options.expected) : expectedEntry(id);
                return schedule(() => mutate(latest => {
                    const index = findExpected(latest, expected, ['name', 'snapshot', 'createdAt', 'updatedAt']);
                    const entry = latest[index], before = latest[index - 1]?.id, after = latest[index + 1]?.id;
                    latest.splice(index, 1);
                    return { bookmarks: latest, result: entry, after() { removed = { entry: copy(entry), index, before, after }; } };
                }));
            },
            async undo() {
                const pending = removed && copy(removed);
                return schedule(async () => {
                    if (!pending) return null;
                    return mutate(latest => {
                        const existing = latest.find(entry => entry.id === pending.entry.id);
                        if (existing) return { unchanged: true, result: existing, after() { removed = null; } };
                        if (latest.length >= 50) throw invalid('書籤已滿，請先空出一個位置再復原。');
                        const before = latest.findIndex(entry => entry.id === pending.before);
                        const after = latest.findIndex(entry => entry.id === pending.after);
                        const index = after >= 0 ? after : before >= 0 ? before + 1 : Math.min(pending.index, latest.length);
                        latest.splice(index, 0, pending.entry);
                        return { bookmarks: latest, result: pending.entry, after() { removed = null; } };
                    });
                });
            },
            async move(id, direction, options = {}) {
                const delta = direction === 'up' || direction === -1 ? -1 : direction === 'down' || direction === 1 ? 1 : 0;
                const expected = options.expected ? copy(options.expected) : expectedEntry(id), index = bookmarks.findIndex(entry => entry.id === id);
                const neighbor = Object.prototype.hasOwnProperty.call(options, 'expectedNeighbor') ? options.expectedNeighbor :
                    index >= 0 && delta ? bookmarks[index + delta]?.id : null;
                return schedule(() => {
                    if (!delta) throw invalid('請選擇向上或向下移動。');
                    return mutate(latest => {
                        const current = findExpected(latest, expected, []);
                        if (!neighbor) {
                            if (latest[current + delta]) throw conflict();
                            return { unchanged: true, result: latest[current] };
                        }
                        if (latest[current + delta]?.id !== neighbor) throw conflict();
                        [latest[current], latest[current + delta]] = [latest[current + delta], latest[current]];
                        return { bookmarks: latest, result: latest[current + delta] };
                    });
                });
            },
            async importLocal(entries) {
                const captured = copy(entries);
                return schedule(() => {
                    const incoming = normalizeDocument({ version: 1, bookmarks: captured }).bookmarks;
                    return mutate(latest => {
                        const additions = [];
                        for (const entry of incoming) {
                            if (!latest.concat(additions).some(item => item.id === entry.id ||
                                (item.name === entry.name && same(layoutIdentity(item.snapshot), layoutIdentity(entry.snapshot))))) additions.push(entry);
                        }
                        if (latest.length + additions.length > 50) throw invalid('匯入後會超過 50 個書籤，請先刪除部分共用書籤。');
                        return additions.length ? { bookmarks: latest.concat(additions), result: additions.length } : { unchanged: true, result: 0 };
                    });
                });
            }
        };
        return store;
    }
    const api = { normalizeDocument, createTransport, createStore, SharedBookmarkError, CACHE_KEY, ENDPOINT, MAX_BYTES };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SharedBookmarks = api;
})(typeof globalThis === 'object' ? globalThis : this);
