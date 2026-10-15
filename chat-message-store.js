/* Local chat storage. Heavy message bodies and offscreen DOM live outside the
 * in-memory cache; disk failure must never be treated as successful eviction. */
(function (global) {
    'use strict';
    const readTag = (tags, name) => String(tags || '').match(new RegExp('(?:^|;)' + name + '=([^;]*)'))?.[1] || '';
    const uidFor = record => record.id || readTag(record.ircMessage?.tags, 'id') ||
        [record.user?.login || record.user || '', record.timestamp, record.content || ''].join('\u0001');
    const loginFor = record => String(record.user?.login || record.login || (typeof record.user === 'string' ? record.user : '')).toLowerCase();
    const refFor = (login, timestamp) => String(login).toLowerCase() + '\u0001' + String(timestamp);
    const requestResult = (request, timeoutMs = 5000) => new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { request.transaction?.abort(); } catch (_) {}
            reject(new Error('Local chat storage request timed out'));
        }, timeoutMs);
        request.onsuccess = () => {
            if (settled) { if (typeof request.result?.close === 'function') request.result.close(); return; }
            settled = true; clearTimeout(timer); resolve(request.result);
        };
        request.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(request.error || new Error('Local chat storage request failed')); } };
    });

    class ChatMessageStore {
        constructor(options = {}) {
            this.databaseName = options.databaseName || 'chick-chat-local-messages';
            this.session = options.session || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
            this.maxCachedRecords = Math.max(30, options.maxCachedRecords || 1200);
            this.maxUserNames = Math.max(10, options.maxUserNames || 500);
            this.onEvict = options.onEvict || (() => {});
            this.onError = options.onError || (() => {});
            this.memory = new Map();
            this.aliases = new Map();
            this.metadata = new Map();
            this.keys = new Map();
            this.references = new Map();
            this.users = new Map();
            this.deliveries = new Map();
            this.maxDeliveredKeys = 2000;
            this.deliveryWriteFailed = false;
            this.pinned = new Set();
            this.pending = Promise.resolve();
            this.failed = false;
            this.cache = this.makeCacheProxy();
            this.userCache = this.makeUserProxy();
            this.ready = this.open();
            this.pageHideHandler = event => { if (!event.persisted) this.close(); };
            global.addEventListener?.('pagehide', this.pageHideHandler);
        }
        async open() {
            try {
                if (!global.indexedDB) throw new Error('IndexedDB is unavailable');
                const request = global.indexedDB.open(this.databaseName, 3);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains('records')) {
                        const records = db.createObjectStore('records', { keyPath: 'key' });
                        records.createIndex('reference', 'reference');
                        records.createIndex('session', 'session');
                        records.createIndex('updatedAt', 'updatedAt');
                    }
                    if (!db.objectStoreNames.contains('pages')) {
                        const pages = db.createObjectStore('pages', { keyPath: 'key' });
                        pages.createIndex('session', 'session');
                        pages.createIndex('updatedAt', 'updatedAt');
                    }
                    if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
                    if (!db.objectStoreNames.contains('deliveries')) {
                        const deliveries = db.createObjectStore('deliveries', { keyPath: 'id' });
                        deliveries.createIndex('session', 'session');
                    }
                };
                this.db = await requestResult(request);
                this.db.onversionchange = () => this.db.close();
                await this.transaction('sessions', 'readwrite', store => store.put({ id: this.session, updatedAt: Date.now(), closed: false }));
                // An origin-wide Web Lock survives background timer throttling.
                // Cleanup must not mistake an old but still-open tab for a dead visit.
                if (global.navigator?.locks) {
                    let acquired;
                    const lockReady = new Promise(resolve => { acquired = resolve; });
                    global.navigator.locks.request(this.databaseName + ':session:' + this.session, async () => {
                        acquired();
                        await new Promise(resolve => { this.releaseSessionLock = resolve; });
                    }).catch(error => { acquired(); this.report(error); });
                    await lockReady;
                }
                // Previous visits are not a permanent chat archive. A separate
                // session namespace also prevents two open tabs from erasing one another.
                this.expireOldSessions().catch(error => this.report(error));
                return true;
            } catch (error) { this.report(error); return false; }
        }
        report(error) {
            const previous = this.lastError;
            this.failed = true;
            this.lastError = String(error?.message || error);
            if (previous !== this.lastError) this.onError(error);
        }
        async expireOldSessions() {
            if (!this.db) return;
            const cutoff = Date.now() - 24 * 60 * 60 * 1000;
            const sessions = await requestResult(this.db.transaction('sessions').objectStore('sessions').getAll());
            const purge = async id => {
                await Promise.all(['records', 'pages', 'deliveries'].map(name => this.transaction(name, 'readwrite', store => {
                    const request = store.index('session').openCursor(IDBKeyRange.only(id));
                    request.onsuccess = () => { const cursor = request.result; if (cursor) { cursor.delete(); cursor.continue(); } };
                })));
                await this.transaction('sessions', 'readwrite', store => store.delete(id));
            };
            for (const session of sessions) {
                if (session.id === this.session || session.updatedAt >= cutoff) continue;
                if (global.navigator?.locks) {
                    await global.navigator.locks.request(this.databaseName + ':session:' + session.id, { ifAvailable: true }, lock => lock ? purge(session.id) : undefined);
                } else if (session.closed) await purge(session.id);
            }
        }
        queue(operation) {
            const result = this.pending.then(async () => {
                if (!await this.ready || !this.db) throw new Error('Local chat storage is unavailable');
                return operation();
            });
            this.pending = result.catch(error => this.report(error));
            return result;
        }
        transaction(name, mode, callback) {
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(name, mode);
                let settled = false;
                const timer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    try { tx.abort(); } catch (_) {}
                    reject(new Error('Local chat storage transaction timed out'));
                }, 5000);
                let result;
                try { result = callback(tx.objectStore(name)); }
                catch (error) { settled = true; clearTimeout(timer); tx.abort(); reject(error); return; }
                tx.oncomplete = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
                tx.onerror = tx.onabort = () => { if (!settled) { settled = true; clearTimeout(timer); reject(tx.error || new Error('Local chat storage transaction failed')); } };
            });
        }
        remember(record, options = {}) {
            if (!record || typeof record !== 'object') return record;
            const uid = String(options.id || uidFor(record));
            const previous = this.metadata.get(uid);
            const aliases = new Set([uid, ...(previous?.aliases || []), ...(options.aliases || [])]);
            if (record.timestamp != null) aliases.add(String(record.timestamp));
            const reference = refFor(loginFor(record), record.timestamp);
            const metadata = { uid, aliases: [...aliases], reference, login: loginFor(record), timestamp: Number(record.timestamp), key: options.key || previous?.key || uid };
            this.metadata.set(uid, metadata);
            if (previous?.key && previous.key !== metadata.key && this.keys.get(previous.key) === uid) this.keys.delete(previous.key);
            this.keys.set(metadata.key, uid);
            if (!this.references.has(reference)) this.references.set(reference, new Set());
            this.references.get(reference).add(uid);
            for (const alias of aliases) this.aliases.set(alias, uid);
            this.memory.delete(uid);
            this.memory.set(uid, record);
            if (metadata.login && record.displayName) this.setUserName(metadata.login, record.displayName);
            this.evict();
            this.queue(() => this.transaction('records', 'readwrite', store => store.put({
                key: this.session + ':' + uid, session: this.session,
                reference: this.session + ':' + reference, updatedAt: Date.now(), metadata, record
            }))).catch(() => {});
            return record;
        }
        getCached(id) {
            const uid = this.aliases.get(String(id)) || String(id);
            const record = this.memory.get(uid);
            if (record) { this.memory.delete(uid); this.memory.set(uid, record); }
            return record;
        }
        findCachedReference(login, timestamp) {
            const ids = this.references.get(refFor(login, timestamp));
            if (!ids || ids.size !== 1) return null;
            return this.getCached(ids.values().next().value) || null;
        }
        referenceCount(login, timestamp) { return this.references.get(refFor(login, timestamp))?.size || 0; }
        async getById(id) {
            const cached = this.getCached(id);
            if (cached) return cached;
            const uid = this.aliases.get(String(id)) || String(id);
            await this.pending;
            if (!await this.ready || !this.db) return null;
            try {
                const value = await requestResult(this.db.transaction('records').objectStore('records').get(this.session + ':' + uid));
                if (!value) return null;
                this.memory.set(uid, value.record); this.evict();
                return value.record;
            } catch (error) { this.report(error); return null; }
        }
        async getByReference(login, timestamp) {
            const ids = this.references.get(refFor(login, timestamp));
            // The custom quote format has no message ID. Two messages by the same
            // user in one millisecond are genuinely ambiguous: never guess.
            if (!ids || ids.size !== 1) return null;
            return this.getById(ids.values().next().value);
        }
        hasKey(key) { return this.keys.has(String(key)) || this.metadata.has(String(key)); }
        cacheDelivery(key) {
            this.deliveries.delete(key);
            this.deliveries.set(key, true);
            while (this.deliveries.size > this.maxDeliveredKeys) this.deliveries.delete(this.deliveries.keys().next().value);
        }
        rememberDelivery(key) {
            if (key == null || key === '') return;
            key = String(key);
            const existed = this.deliveries.has(key);
            this.cacheDelivery(key);
            if (existed) return;
            this.queue(() => this.transaction('deliveries', 'readwrite', store => store.put({
                id: this.session + ':' + key, session: this.session, key
            }))).catch(() => { this.deliveryWriteFailed = true; });
        }
        recentlyDelivered(key) {
            if (key == null || key === '' || !this.deliveries.has(String(key))) return false;
            this.cacheDelivery(String(key));
            return true;
        }
        async wasDelivered(key) {
            if (key == null || key === '') return false;
            key = String(key);
            if (this.recentlyDelivered(key)) return true;
            await this.pending;
            if (!await this.ready || !this.db || this.deliveryWriteFailed) {
                const error = new Error('Chat delivery history cannot currently be verified');
                this.report(error);
                throw error;
            }
            try {
                const delivery = await requestResult(this.db.transaction('deliveries').objectStore('deliveries').get(this.session + ':' + key));
                if (!delivery) return false;
                this.cacheDelivery(key);
                return true;
            } catch (error) { this.report(error); throw error; }
        }
        setUserName(login, name) {
            const key = String(login).toLowerCase();
            this.users.delete(key); this.users.set(key, name);
            while (this.users.size > this.maxUserNames) this.users.delete(this.users.keys().next().value);
        }
        getUserName(login) { return this.users.get(String(login).toLowerCase()); }
        prune(retainedIds = []) {
            this.pinned = new Set([...retainedIds].map(id => this.aliases.get(String(id)) || String(id)));
            this.evict();
        }
        evict() {
            for (const [uid, record] of this.memory) {
                if (this.memory.size <= this.maxCachedRecords) break;
                if (this.pinned.has(uid)) continue;
                this.memory.delete(uid);
                this.onEvict(record, this.metadata.get(uid)?.aliases || [uid]);
            }
            // A burst may temporarily outgrow the virtual DOM's protected window.
            // Pinned rows remain safely on disk; they must not defeat the hard cap.
            for (const [uid, record] of this.memory) {
                if (this.memory.size <= this.maxCachedRecords) break;
                this.memory.delete(uid);
                this.onEvict(record, this.metadata.get(uid)?.aliases || [uid]);
            }
        }
        async forget(ids) {
            const removed = new Set([...ids].map(id => this.aliases.get(String(id)) || String(id)));
            for (const uid of removed) {
                const metadata = this.metadata.get(uid);
                const record = this.memory.get(uid);
                this.memory.delete(uid); this.pinned.delete(uid); this.metadata.delete(uid);
                if (metadata) {
                    if (this.keys.get(metadata.key) === uid) this.keys.delete(metadata.key);
                    for (const alias of metadata.aliases) if (this.aliases.get(alias) === uid) this.aliases.delete(alias);
                    const references = this.references.get(metadata.reference);
                    references?.delete(uid);
                    if (!references?.size) this.references.delete(metadata.reference);
                }
                if (record) this.onEvict(record, metadata?.aliases || [uid]);
            }
            if (!removed.size) return;
            return this.queue(() => this.transaction('records', 'readwrite', store => {
                for (const uid of removed) store.delete(this.session + ':' + uid);
            })).catch(() => {});
        }
        savePage(page) {
            return this.queue(() => this.transaction('pages', 'readwrite', store => store.put({
                ...page, key: this.session + ':' + page.id, session: this.session, updatedAt: Date.now()
            })));
        }
        async loadPage(id) {
            await this.pending;
            if (!await this.ready || !this.db) throw new Error('Local chat storage is unavailable');
            const value = await requestResult(this.db.transaction('pages').objectStore('pages').get(this.session + ':' + id));
            if (!value) throw new Error('Stored chat page is unavailable');
            return value;
        }
        deletePage(id) { return this.queue(() => this.transaction('pages', 'readwrite', store => store.delete(this.session + ':' + id))); }
        async archiveBuffered(entries) {
            const id = 'buffer-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
            await this.savePage({ id, entries });
            return { archiveId: id, count: entries.length, timestamp: Math.min(...entries.map(entry => entry.timestamp)), lastTimestamp: Math.max(...entries.map(entry => entry.timestamp)),
                items: entries.map(entry => ({ id: entry.html?.match(/data-message-id="([^"]*)"/)?.[1], key: entry.key, timestamp: entry.timestamp,
                    login: entry.html?.match(/data-user-login="([^"]*)"/)?.[1] || '' })) };
        }
        async restoreBuffered(reference) {
            const page = await this.loadPage(reference.archiveId);
            await this.deletePage(reference.archiveId);
            return page.entries || [];
        }
        async clear() {
            const ids = [...this.metadata.keys()];
            this.memory.clear(); this.metadata.clear(); this.keys.clear(); this.aliases.clear(); this.references.clear(); this.users.clear(); this.pinned.clear(); this.deliveries.clear();
            if (!await this.ready || !this.db) return;
            await this.pending;
            await Promise.all(['records', 'pages', 'deliveries'].map(name => this.transaction(name, 'readwrite', store => {
                const request = store.index('session').openCursor(IDBKeyRange.only(this.session));
                request.onsuccess = () => { const cursor = request.result; if (cursor) { cursor.delete(); cursor.continue(); } };
            })));
            return ids.length;
        }
        statistics() { return { cachedRecords: this.memory.size, recordMetadata: this.metadata.size, userNames: this.users.size, pinnedRecords: this.pinned.size, deliveredKeys: this.deliveries.size, storageFailed: this.failed }; }
        close() {
            if (!this.db) return;
            try { this.db.transaction('sessions', 'readwrite').objectStore('sessions').put({ id: this.session, updatedAt: Date.now(), closed: true }); }
            catch (_) { /* The browser may already be closing the connection. */ }
            this.releaseSessionLock?.();
            this.releaseSessionLock = null;
        }
        makeCacheProxy() {
            return new Proxy(Object.create(null), {
                get: (_, key) => typeof key === 'string' ? this.getCached(key) : undefined,
                set: (_, key, value) => { this.remember(value, { aliases: [String(key)] }); return true; },
                deleteProperty: (_, key) => { this.forget([String(key)]); return true; },
                ownKeys: () => [...this.aliases.keys()].filter(key => this.memory.has(this.aliases.get(key))),
                getOwnPropertyDescriptor: (_, key) => this.getCached(String(key)) ? { enumerable: true, configurable: true } : undefined
            });
        }
        makeUserProxy() {
            return new Proxy(Object.create(null), {
                get: (_, key) => typeof key === 'string' ? this.getUserName(key) : undefined,
                set: (_, key, value) => { this.setUserName(key, value); return true; },
                ownKeys: () => [...this.users.keys()],
                getOwnPropertyDescriptor: (_, key) => this.users.has(String(key)) ? { enumerable: true, configurable: true } : undefined
            });
        }
        createVirtualizer(options) { return new ChatRowVirtualizer(this, options); }
    }

    class ChatRowVirtualizer {
        constructor(store, options) {
            this.store = store;
            this.options = options;
            this.messages = options.messages;
            this.container = options.container;
            this.keepRecent = Math.max(30, options.keepRecent || 300);
            this.pageSize = Math.max(10, options.pageSize || 50);
            this.pages = new Map();
            this.sequence = 0;
            this.busy = Promise.resolve();
            this.scheduled = false;
            this.disconnected = false;
            this.observer = new MutationObserver(() => this.schedule());
            this.observer.observe(this.messages, { childList: true });
            this.scrollHandler = () => this.schedule();
            this.container.addEventListener('scroll', this.scrollHandler, { passive: true });
            global.addEventListener('resize', this.scrollHandler, { passive: true });
        }
        rows() { return [...this.messages.children].filter(row => row.classList.contains('chat-line')); }
        trailingLiveCount() {
            let count = 0;
            for (const child of [...this.messages.children].reverse()) {
                if (child.dataset.archivePage) break;
                if (child.classList.contains('chat-line')) count++;
            }
            return count;
        }
        logicalCount() { return [...this.messages.children].reduce((sum, row) => sum + (Number(row.dataset.archiveCount) || (row.classList.contains('chat-line') ? 1 : 0)), 0); }
        oldestTimestamp() { const first = this.messages.firstElementChild; return Number(first?.dataset.msgTs) || null; }
        metadataFor(row) {
            const received = Number(row.dataset.receivedTs);
            return { id: row.dataset.messageId || '', key: row.dataset.messageKey || '', timestamp: Number(row.dataset.msgTs) || 0,
                receivedTs: Number.isFinite(received) && received > 0 ? received : 0, login: row.dataset.userLogin || '' };
        }
        async completeEntryMetadata(entry, record) {
            const metadata = entry.metadata || {};
            if (!(metadata.receivedTs > 0)) {
                record = record || entry.record || await this.store.getById(metadata.id);
                const received = Number(readTag(record?.ircMessage?.tags, 'rm-received-ts'));
                metadata.receivedTs = Number.isFinite(received) && received > 0 ? received : 0;
            }
            entry.metadata = metadata;
            return metadata;
        }
        setPageFirstMetadata(element, metadata) {
            element.dataset.receivedTs = metadata?.receivedTs > 0 ? String(metadata.receivedTs) : '';
            element.dataset.firstMessageId = metadata?.id || metadata?.key || '';
        }
        schedule() {
            if (this.scheduled || this.disconnected || this.store.failed) return;
            this.scheduled = true;
            setTimeout(() => { this.scheduled = false; this.run().catch(error => this.options.onError?.(error)); }, 40);
        }
        enqueue(operation) {
            const result = this.busy.then(operation);
            this.busy = result.catch(error => this.options.onError?.(error));
            return result;
        }
        run() { return this.enqueue(() => this.sweep()); }
        viewport() { return this.options.captureViewport?.(); }
        restore(viewport) { this.options.restoreViewport?.(viewport); }
        async sweep() {
            if (!this.options.isPaused() || this.store.failed || this.disconnected) return;
            const viewport = this.container.getBoundingClientRect();
            const margin = Math.max(800, this.container.clientHeight * 2);
            for (const [id, page] of this.pages) {
                if (!page.element.isConnected) { this.pages.delete(id); continue; }
                const rect = page.element.getBoundingClientRect();
                if (rect.bottom >= viewport.top - margin && rect.top <= viewport.bottom + margin) await this.restorePage(id);
            }
            const rows = this.rows();
            const protectedRows = new Set(rows.slice(-this.keepRecent));
            let group = [];
            const flush = async () => { if (group.length >= this.pageSize) await this.archiveRows(group); group = []; };
            for (const child of [...this.messages.children]) {
                const rect = child.getBoundingClientRect();
                const distant = rect.bottom < viewport.top - margin || rect.top > viewport.bottom + margin;
                const timestamp = Number(child.dataset.msgTs);
                const overlapsUnreadablePage = [...this.pages.values()].some(page => page.unreadable &&
                    timestamp >= Number(page.element.dataset.msgTs) && timestamp <= Number(page.element.dataset.lastMsgTs));
                if (child.classList.contains('chat-line') && !protectedRows.has(child) && distant && !overlapsUnreadablePage) {
                    group.push(child);
                    if (group.length >= this.pageSize) await flush();
                } else await flush();
            }
            await flush();
            this.store.prune(this.rows().map(row => row.dataset.messageId).filter(Boolean));
        }
        async archiveRows(rows) {
            if (!rows.length || rows.some(row => !row.isConnected)) return;
            const id = 'rows-' + (++this.sequence) + '-' + Date.now().toString(36);
            const records = rows.map(row => this.options.getRecord?.(row.dataset.messageId) || this.store.getCached(row.dataset.messageId));
            const items = rows.map(row => this.metadataFor(row));
            const entries = rows.map((row, index) => {
                const next = rows[index + 1];
                const rect = row.getBoundingClientRect();
                const style = getComputedStyle(row);
                const height = Math.max(1, next ? next.getBoundingClientRect().top - rect.top : rect.height + parseFloat(style.marginBottom || '0'));
                return { html: row.outerHTML, record: records[index], metadata: items[index], height };
            });
            await this.completeEntryMetadata(entries[0], records[0]);
            await this.store.savePage({ id, entries });
            if (rows.some(row => !row.isConnected) || !this.options.isPaused()) { await this.store.deletePage(id); return; }
            const viewport = this.viewport();
            const first = rows[0], last = rows.at(-1), next = last.nextElementSibling;
            const top = first.getBoundingClientRect().top;
            const lastStyle = getComputedStyle(last);
            const height = Math.max(1, (next ? next.getBoundingClientRect().top : last.getBoundingClientRect().bottom + parseFloat(lastStyle.marginBottom || '0')) - top);
            const placeholder = document.createElement('div');
            placeholder.className = 'chat-archive-page';
            placeholder.dataset.archivePage = id;
            placeholder.dataset.archiveCount = String(rows.length);
            placeholder.dataset.msgTs = String(Math.min(...items.map(item => item.timestamp)));
            placeholder.dataset.lastMsgTs = String(Math.max(...items.map(item => item.timestamp)));
            this.setPageFirstMetadata(placeholder, items[0]);
            placeholder.setAttribute('aria-hidden', 'true');
            placeholder.style.cssText = 'height:' + height + 'px;min-height:' + height + 'px;flex:0 0 auto;margin:0;padding:0;border:0;overflow:hidden;pointer-events:none;';
            first.before(placeholder);
            for (const row of rows) { this.options.onArchive?.(row); row.remove(); }
            this.pages.set(id, { element: placeholder, items });
            this.restore(viewport);
        }
        async restorePage(id) {
            const metadata = this.pages.get(id);
            if (!metadata?.element.isConnected) return [];
            let page;
            try { page = await this.store.loadPage(id); }
            catch (error) { if (!metadata.element.isConnected) return []; throw error; }
            const viewport = this.viewport();
            const nodes = [];
            for (const entry of page.entries || []) {
                const record = entry.record || await this.store.getById(entry.metadata?.id);
                await this.completeEntryMetadata(entry, record);
                const rendered = await this.options.renderRecord?.(record, entry);
                if (rendered === null) {
                    if (entry.metadata?.id) this.store.forget([entry.metadata.id]);
                    this.options.onDiscard?.(entry.metadata, record);
                    continue;
                }
                if (record) this.options.rememberRecord?.(record, entry.metadata);
                const html = rendered === undefined ? entry.html : rendered;
                const template = document.createElement('template'); template.innerHTML = html.trim();
                const row = template.content.firstElementChild;
                if (!row) continue;
                if (entry.metadata?.key) row.dataset.messageKey = entry.metadata.key;
                if (entry.metadata?.receivedTs > 0) row.dataset.receivedTs = String(entry.metadata.receivedTs);
                nodes.push(row);
            }
            if (!metadata.element.isConnected) return [];
            // New rows must remain visible even if a previous read of this page
            // failed. They are temporarily placed after its placeholder; merge
            // them into their correct position when the stored page is readable.
            const interleaved = [];
            let next = metadata.element.nextElementSibling;
            const endTimestamp = Number(metadata.element.dataset.lastMsgTs);
            while (next && !next.dataset.archivePage && next.classList.contains('chat-line') && Number(next.dataset.msgTs) <= endTimestamp) {
                interleaved.push(next); next = next.nextElementSibling;
            }
            const combined = [...nodes, ...interleaved].sort((a, b) => Number(a.dataset.msgTs) - Number(b.dataset.msgTs));
            metadata.element.replaceWith(...combined);
            this.pages.delete(id);
            await this.options.onRestore?.(nodes);
            this.restore(viewport);
            await this.store.deletePage(id);
            return nodes;
        }
        materializeForId(id) {
            return this.enqueue(async () => {
                for (const [pageId, page] of this.pages) if (page.items.some(item => item.id === id || item.key === id || String(item.timestamp) === String(id))) {
                    await this.restorePage(pageId); return true;
                }
                return false;
            });
        }
        materializeRange(start, end = start) {
            return this.enqueue(async () => {
                for (const [id, page] of [...this.pages]) {
                    if (Number(page.element.dataset.msgTs) <= end && Number(page.element.dataset.lastMsgTs) >= start) await this.restorePage(id);
                }
            });
        }
        whenIdle() { return this.busy; }
        prepareTrim(max) {
            return this.enqueue(async () => {
                let remaining = this.logicalCount() - max;
                for (const child of [...this.messages.children]) {
                    if (remaining <= 0) break;
                    const count = Number(child.dataset.archiveCount) || 1;
                    if (child.dataset.archivePage && count > remaining) {
                        await this.restorePage(child.dataset.archivePage);
                        break;
                    }
                    remaining -= count;
                }
            });
        }
        insertElements(elements) {
            return this.enqueue(async () => {
                for (const row of [...elements]) {
                    const timestamp = Number(row.dataset.msgTs) || 0;
                    for (const [id, page] of [...this.pages]) {
                        if (Number(page.element.dataset.msgTs) <= timestamp && Number(page.element.dataset.lastMsgTs) >= timestamp) {
                            try { await this.restorePage(id); }
                            catch (error) {
                                // A storage read failure must never discard an
                                // independently received new message. Keep the
                                // old page and its measured height, show the row
                                // beside it, and report the temporary limitation.
                                page.unreadable = true;
                                this.options.onError?.(error);
                            }
                        }
                    }
                    if (this.options.shouldInsert?.(row) === false) {
                        const metadata = this.metadataFor(row);
                        if (metadata.id) this.store.forget([metadata.id]);
                        this.options.onArchive?.(row);
                        this.options.onDiscard?.(metadata);
                        continue;
                    }
                    const viewport = this.viewport();
                    const next = [...this.messages.children].find(child => Number(child.dataset.msgTs) > timestamp);
                    this.messages.insertBefore(row, next || null);
                    await this.options.onRestore?.([row]);
                    this.restore(viewport);
                }
                this.schedule();
            });
        }
        trimToLatest(max) {
            const removed = [];
            let remaining = this.logicalCount() - max;
            for (const child of [...this.messages.children]) {
                if (remaining <= 0) break;
                const page = this.pages.get(child.dataset.archivePage);
                const count = Number(child.dataset.archiveCount) || 1;
                // The latest keepRecent rows are never archived, so a trim to
                // keepRecent or fewer can discard whole older archive pages.
                if (page && count > remaining) throw new Error('Materialize the boundary page before trimming');
                if (page) { removed.push(...page.items); this.pages.delete(child.dataset.archivePage); this.store.deletePage(child.dataset.archivePage).catch(() => {}); }
                else if (child.classList.contains('chat-line')) { removed.push(this.metadataFor(child)); this.options.onArchive?.(child); }
                child.remove(); remaining -= count;
            }
            this.store.forget(removed.map(item => item.id).filter(Boolean));
            this.store.prune(this.rows().map(row => row.dataset.messageId).filter(Boolean));
            return removed;
        }
        removeWhere(predicate) {
            return this.enqueue(async () => {
                const removed = [];
                for (const [id, metadata] of [...this.pages]) {
                    const selected = metadata.items.filter(predicate);
                    if (!selected.length) continue;
                    if (selected.length === metadata.items.length) {
                        metadata.element.remove(); this.pages.delete(id); removed.push(...selected); await this.store.deletePage(id);
                    } else {
                        // A timeout/ban can affect one user across thousands of
                        // archived rows. Edit pages on disk rather than materializing
                        // their images and videos just to remove them again.
                        const page = await this.store.loadPage(id);
                        const entries = page.entries.filter(entry => !predicate(entry.metadata));
                        await this.completeEntryMetadata(entries[0]);
                        await this.store.savePage({ id, entries });
                        if (!metadata.element.isConnected) continue;
                        const totalHeight = page.entries.reduce((sum, entry) => sum + (entry.height || 1), 0);
                        const remainingHeight = entries.reduce((sum, entry) => sum + (entry.height || 1), 0);
                        const height = parseFloat(metadata.element.style.height) * remainingHeight / totalHeight;
                        metadata.element.style.height = metadata.element.style.minHeight = Math.max(1, height) + 'px';
                        metadata.items = entries.map(entry => entry.metadata);
                        metadata.element.dataset.archiveCount = String(metadata.items.length);
                        metadata.element.dataset.msgTs = String(Math.min(...metadata.items.map(item => item.timestamp)));
                        metadata.element.dataset.lastMsgTs = String(Math.max(...metadata.items.map(item => item.timestamp)));
                        this.setPageFirstMetadata(metadata.element, metadata.items[0]);
                        removed.push(...selected);
                    }
                }
                for (const row of this.rows()) if (predicate(this.metadataFor(row))) { removed.push(this.metadataFor(row)); this.options.onArchive?.(row); row.remove(); }
                // Keep the usual trim boundary materialized after a timeout/ban
                // reduces the number of recent rows. Only a handful of pages load.
                while (this.trailingLiveCount() < this.keepRecent && this.pages.size) {
                    const latest = [...this.pages].sort((a, b) => Number(b[1].element.dataset.lastMsgTs) - Number(a[1].element.dataset.lastMsgTs))[0];
                    await this.restorePage(latest[0]);
                }
                await this.store.forget(removed.map(item => item.id).filter(Boolean));
                return removed;
            });
        }
        clear() {
            return this.enqueue(async () => {
                for (const child of [...this.messages.children]) { this.options.onArchive?.(child); child.remove(); }
                const ids = [...this.pages.keys()]; this.pages.clear();
                await Promise.all(ids.map(id => this.store.deletePage(id)));
                await this.store.clear();
            });
        }
        statistics() { return { liveRows: this.rows().length, archivedPages: this.pages.size, archivedRows: [...this.pages.values()].reduce((sum, page) => sum + page.items.length, 0), logicalRows: this.logicalCount(), ...this.store.statistics() }; }
        disconnect() { this.disconnected = true; this.observer.disconnect(); this.container.removeEventListener('scroll', this.scrollHandler); global.removeEventListener('resize', this.scrollHandler); }
    }
    global.ChatMessageStore = ChatMessageStore;
    if (typeof module !== 'undefined' && module.exports) module.exports = { ChatMessageStore, ChatRowVirtualizer };
})(typeof window === 'undefined' ? globalThis : window);
