/* Saved player arrangements contain channel identities and geometry, never media. */
(function (root) {
    'use strict';

    const STORAGE_KEY = 'umininn.layoutBookmarks.v1';
    const MAX_BOOKMARKS = 50;
    const IDLE_MS = 30000;
    const copy = value => JSON.parse(JSON.stringify(value));
    const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
    const hue = value => integer(value, 0, 359) ? value : Math.floor(Math.random() * 360);
    const shortText = (value, limit) => Array.from(value).slice(0, limit).join('');

    function normalizeSnapshot(value) {
        if (!value || typeof value !== 'object' || !Array.isArray(value.channels) ||
            !integer(value.channels.length, 1, 256) || !integer(value.columns, 1, 768)) {
            throw new Error('這個佈局的頻道或分格資料不完整。');
        }
        const seen = new Set();
        const channels = value.channels.map(channel => {
            if (!channel || typeof channel.key !== 'string' || !channel.key.trim() ||
                channel.key.length > 4096 || seen.has(channel.key) ||
                typeof channel.name !== 'string' || !channel.name.trim()) {
                throw new Error('佈局包含重複或無效的頻道。');
            }
            seen.add(channel.key);
            return { key: channel.key, name: shortText(channel.name.trim(), 200), color: hue(channel.color) };
        });
        let focus = null;
        if (value.focus != null) {
            const current = value.focus;
            if (!seen.has(current.key) || !integer(current.row, 0, 512) ||
                !integer(current.column, 0, 512) || !integer(current.span, 2, 256) ||
                current.column + current.span > value.columns || channels.length < 2) {
                throw new Error('佈局的放大格資料無效。');
            }
            focus = { key: current.key, row: current.row, column: current.column, span: current.span };
        }
        const aspectRatio = typeof value.aspectRatio === 'number' && Number.isFinite(value.aspectRatio) &&
            value.aspectRatio > 0 ? Math.max(.35, Math.min(4, value.aspectRatio)) : 16 / 9;
        return { channels, columns: value.columns, focus, aspectRatio };
    }

    function bookmarkName(name) {
        if (typeof name !== 'string' || !name.trim()) throw new Error('請輸入書籤名稱。');
        return shortText(name.trim(), 60);
    }

    function createStore(storage) {
        let bookmarks = [];
        let removed = null;
        let error = null;
        let idSequence = 0;
        function read() {
            if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
                throw new Error('此瀏覽器未能使用本機儲存空間。');
            }
            const raw = storage.getItem(STORAGE_KEY);
            if (raw == null || raw === '') return [];
            let data;
            try { data = JSON.parse(raw); } catch (_) { throw new Error('書籤資料無法讀取；原有資料已保留。'); }
            if (data?.version !== 1 || !Array.isArray(data.bookmarks) || data.bookmarks.length > MAX_BOOKMARKS) {
                throw new Error('書籤資料版本不相容；原有資料已保留。');
            }
            const ids = new Set();
            return data.bookmarks.map(entry => {
                if (!entry || typeof entry.id !== 'string' || !entry.id || entry.id.length > 100 || ids.has(entry.id) ||
                    !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.updatedAt)) {
                    throw new Error('書籤資料不完整；原有資料已保留。');
                }
                ids.add(entry.id);
                return { id: entry.id, name: bookmarkName(entry.name), snapshot: normalizeSnapshot(entry.snapshot),
                    createdAt: entry.createdAt, updatedAt: entry.updatedAt };
            });
        }
        function reload() {
            try {
                bookmarks = read();
                error = null;
                return copy(bookmarks);
            } catch (failure) { error = failure; throw failure; }
        }
        function write(next) {
            // A denied or full store must never appear to have saved a bookmark.
            storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, bookmarks: next }));
            bookmarks = next;
            error = null;
        }
        function mutate(id, change) {
            const latest = read();
            const index = latest.findIndex(entry => entry.id === id);
            if (index < 0) throw new Error('這個書籤已被刪除，請重新選擇。');
            const next = change(latest[index]);
            latest[index] = next;
            write(latest);
            return copy(next);
        }
        try { reload(); } catch (failure) { error = failure; }
        return {
            list: () => copy(bookmarks),
            getError: () => error,
            reload,
            add(name, snapshot) {
                const latest = read();
                if (latest.length >= MAX_BOOKMARKS) throw new Error('最多可儲存 50 個佈局，請先刪除不再使用的書籤。');
                const stamp = Date.now();
                let id;
                do { id = 'layout-' + stamp.toString(36) + '-' + (++idSequence).toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
                while (latest.some(entry => entry.id === id));
                const entry = { id, name: bookmarkName(name), snapshot: normalizeSnapshot(snapshot), createdAt: stamp, updatedAt: stamp };
                write([entry, ...latest]);
                return copy(entry);
            },
            rename(id, name) {
                const normalized = bookmarkName(name);
                return mutate(id, entry => ({ ...entry, name: normalized, updatedAt: Date.now() }));
            },
            update(id, snapshot) {
                return mutate(id, entry => {
                    const colors = new Map(entry.snapshot.channels.map(channel => [channel.key, channel.color]));
                    const next = snapshot && Array.isArray(snapshot.channels) ? { ...snapshot, channels: snapshot.channels.map(channel =>
                        channel && !integer(channel.color, 0, 359) && colors.has(channel.key) ? { ...channel, color: colors.get(channel.key) } : channel) } : snapshot;
                    return { ...entry, snapshot: normalizeSnapshot(next), updatedAt: Date.now() };
                });
            },
            move(id, direction) {
                const latest = read();
                const index = latest.findIndex(entry => entry.id === id);
                if (index < 0) throw new Error('這個書籤已被刪除，請重新選擇。');
                const step = direction === 'up' || direction === -1 ? -1 : direction === 'down' || direction === 1 ? 1 : 0;
                if (!step) throw new Error('書籤排序方向無效。');
                const destination = index + step;
                if (destination >= 0 && destination < latest.length) {
                    [latest[index], latest[destination]] = [latest[destination], latest[index]];
                    write(latest);
                } else { bookmarks = latest; error = null; }
                return copy(latest[Math.max(0, Math.min(latest.length - 1, destination))]);
            },
            importLocal(entries) {
                if (!Array.isArray(entries)) throw new Error('本機書籤資料無效。');
                const incoming = createStore({ getItem: () => JSON.stringify({ version: 1, bookmarks: entries }), setItem() {} });
                if (incoming.getError()) throw incoming.getError();
                const latest = read();
                const additions = incoming.list().filter(entry => !latest.some(item => item.id === entry.id));
                if (latest.length + additions.length > MAX_BOOKMARKS) throw new Error('加入後會超過 50 個書籤，請先空出位置。');
                write(latest.concat(additions));
                return additions.length;
            },
            remove(id) {
                const latest = read();
                const index = latest.findIndex(entry => entry.id === id);
                if (index < 0) throw new Error('這個書籤已被刪除。');
                const entry = latest[index];
                write(latest.filter(item => item.id !== id));
                removed = { entry, index };
                return copy(entry);
            },
            canUndo: () => Boolean(removed),
            undo() {
                if (!removed) return null;
                const latest = read();
                if (latest.length >= MAX_BOOKMARKS) throw new Error('書籤已滿，請先空出一個位置再復原。');
                if (latest.some(entry => entry.id === removed.entry.id)) throw new Error('這個書籤已存在，未有重複加入。');
                const entry = copy(removed.entry);
                latest.splice(Math.min(removed.index, latest.length), 0, entry);
                write(latest);
                removed = null;
                return copy(entry);
            }
        };
    }

    function mount({ button, panel, capture, apply, beforeOpen = () => {}, storage, store: providedStore } = {}) {
        if (!button || !panel || typeof capture !== 'function' || typeof apply !== 'function') throw new Error('書籤選單未能初始化。');
        const doc = panel.ownerDocument, view = doc.defaultView || root;
        if (storage === undefined) { try { storage = view.localStorage; } catch (_) {} }
        const sharedMode = Boolean(providedStore), store = providedStore || createStore(storage);
        const localStore = sharedMode ? createStore(storage) : null, cleanups = [];
        let opened = false, idleTimer = null, refreshTimer = null, returnFocus = null, renameDraft = null;
        let busy = false, applying = false, reloadBusy = false, destroyed = false, undoMessage = '', unsubscribe = null;
        let renderedData = null, pointerActive = false, keyboardActive = false, pointerRenderTimer = null, pendingFocus = null;
        function el(tag, className, text) {
            const node = doc.createElement(tag);
            if (className) node.className = className;
            if (text !== undefined) node.textContent = text;
            return node;
        }
        function action(text, className = '', title = text) {
            const node = el('button', className, text); node.type = 'button'; node.title = title;
            if (className) node.dataset.bookmarkAction = className;
            return node;
        }
        function on(target, type, listener, options) {
            target.addEventListener(type, listener, options);
            cleanups.push(() => target.removeEventListener(type, listener, options));
        }
        const header = el('div', 'layout-bookmarks-header'), title = el('h3', '', '台佈局書籤');
        title.id = 'layout-bookmarks-title';
        const closeButton = action('×', 'layout-bookmarks-close', '關閉書籤選單');
        closeButton.setAttribute('aria-label', '關閉書籤選單'); header.append(title, closeButton);
        const saveButton = action('＋ 儲存目前佈局', 'layout-bookmarks-save');
        const help = el('p', 'layout-bookmarks-help', sharedMode ?
            '全站共用，所有使用者都可儲存、修改及排序。點縮圖即可套用台佈局。' :
            '儲存正在觀看的台、排列及放大格。點縮圖即可套用；書籤只儲存在此瀏覽器。');
        const syncStatus = el('p', 'layout-bookmarks-sync');
        syncStatus.setAttribute('role', 'status'); syncStatus.setAttribute('aria-live', 'polite'); syncStatus.hidden = !sharedMode;
        const importButton = action('', 'layout-bookmarks-import'); importButton.hidden = true;
        const importNote = el('p', 'layout-bookmarks-import-note'); importNote.hidden = true;
        const feedback = el('p', 'layout-bookmarks-status');
        feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); feedback.hidden = true;
        const undoBar = el('div', 'layout-bookmarks-undo'); undoBar.hidden = true;
        const undoText = el('span'), undoButton = action('復原刪除'); undoBar.append(undoText, undoButton);
        const list = el('div', 'layout-bookmarks-list');
        panel.replaceChildren(header, saveButton, help, syncStatus, importButton, importNote, feedback, undoBar, list);
        panel.hidden = true; button.setAttribute('aria-controls', panel.id); button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-haspopup', 'dialog');
        function status(message, failed = false) {
            feedback.textContent = message; feedback.hidden = !message; feedback.classList.toggle('is-error', failed);
        }
        function failure(error) { status(error?.message || '操作未能完成，請再試一次。', true); }
        function resetIdle() {
            if (idleTimer !== null) view.clearTimeout(idleTimer);
            idleTimer = opened ? view.setTimeout(() => close(), IDLE_MS) : null;
        }
        function pendingLocalEntries() {
            if (!localStore) return [];
            const shared = store.list();
            const identity = entry => JSON.stringify({ keys: entry.snapshot.channels.map(channel => channel.key),
                columns: entry.snapshot.columns, focus: entry.snapshot.focus });
            return localStore.list().filter(entry => !shared.some(item => item.id === entry.id ||
                item.name === entry.name && identity(item) === identity(entry)));
        }
        function refreshImport() {
            if (!localStore) return;
            const error = localStore.getError(), count = pendingLocalEntries().length;
            importButton.hidden = Boolean(error) || !count;
            importButton.textContent = '將本機 ' + count + ' 個書籤加入共用';
            importNote.hidden = !error;
            importNote.textContent = error ? '本機書籤未能讀取；原有資料已保留，不影響共用書籤。' : '';
        }
        function updateControls() {
            // Reads are queued with writes by the shared store. They must not
            // disable a button between pointerdown/up or blur a name draft.
            const locked = busy;
            for (const node of panel.querySelectorAll('button,input')) {
                if (node !== closeButton) node.disabled = locked || node.dataset.atBoundary === 'true';
            }
            saveButton.disabled = locked || store.list().length >= MAX_BOOKMARKS;
            undoButton.disabled = locked || !store.canUndo(); panel.setAttribute('aria-busy', String(locked));
            undoBar.hidden = !store.canUndo(); undoText.textContent = undoMessage;
            if (sharedMode) {
                const state = store.getSyncState?.() || 'idle';
                syncStatus.textContent = applying ? '正在套用佈局…' : busy ? '儲存中…' : reloadBusy || state === 'syncing' ? '載入中…' :
                    state === 'synced' ? '已同步 · 全站共用' : state === 'offline' ? '離線快取 · 尚未連線至共用書籤' :
                    state === 'error' ? '同步失敗 · 請稍後再試' : '正在連接共用書籤…';
                syncStatus.classList.toggle('is-error', state === 'error' || state === 'offline');
                syncStatus.title = store.getError?.()?.message || '';
            }
        }
        function cardFor(id) { return Array.from(list.children).find(card => card.dataset.bookmarkId === id); }
        function focusAction(id, className, scroll = false) {
            if (!opened || destroyed) return;
            if (pointerActive || keyboardActive) { pendingFocus = { id, className, scroll }; return; }
            const card = cardFor(id), preferred = card?.querySelector('.' + className);
            const target = preferred && !preferred.disabled ? preferred :
                Array.from(card?.querySelectorAll('.layout-bookmark-move-up,.layout-bookmark-move-down,.layout-bookmark-preview') || []).find(node => !node.disabled);
            target?.focus({ preventScroll: true });
            if (scroll) card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        function canAct(allowRename = false) {
            if (destroyed || busy) return false;
            if (renameDraft && !allowRename) {
                status('請先儲存或取消正在修改的名稱。', true); renameDraft.input.focus(); return false;
            }
            return true;
        }
        async function mutation(operation, success, { allowRename = false } = {}) {
            if (!canAct(allowRename)) return;
            busy = true; updateControls();
            try {
                const result = await operation();
                if (destroyed) return;
                busy = false; render(); success?.(result);
            } catch (error) {
                if (!destroyed) { busy = false; render(); failure(error); if (opened && renameDraft) renameDraft.input.focus(); }
            } finally { busy = false; if (!destroyed) updateControls(); }
        }
        function renderPreview(entry) {
            const preview = action('', 'layout-bookmark-preview', '套用「' + entry.name + '」');
            preview.setAttribute('aria-label', '套用「' + entry.name + '」，' + entry.snapshot.channels.length + ' 台');
            preview.style.aspectRatio = String(entry.snapshot.aspectRatio);
            const geometry = root.PlayerGeometry;
            if (!geometry || typeof geometry.build !== 'function') {
                preview.append(el('span', 'layout-bookmark-preview-unavailable', '佈局預覽暫未載入')); return preview;
            }
            const snapshot = entry.snapshot;
            const layout = geometry.build({ keys: snapshot.channels.map(channel => channel.key), columns: snapshot.columns, focus: snapshot.focus });
            preview.style.gridTemplateColumns = 'repeat(' + layout.columns + ', minmax(0, 1fr))';
            preview.style.gridTemplateRows = 'repeat(' + layout.rows + ', minmax(0, 1fr))';
            preview.style.setProperty('--bookmark-columns', layout.columns); preview.style.setProperty('--bookmark-rows', layout.rows);
            const positions = new Map(layout.items.map(item => [item.key, item]));
            for (const channel of snapshot.channels) {
                const item = positions.get(channel.key), cell = el('span', 'layout-bookmark-cell', channel.name);
                cell.title = channel.name;
                cell.style.gridArea = (item.row + 1) + ' / ' + (item.column + 1) + ' / span ' + item.span + ' / span ' + item.span;
                cell.style.setProperty('--bookmark-hue', channel.color); preview.append(cell);
            }
            return preview;
        }
        function beginRename(entry, card) {
            if (!canAct()) return;
            const row = card.querySelector('.layout-bookmark-name-row'), input = el('input', 'layout-bookmark-name-input');
            input.type = 'text'; input.value = entry.name; input.maxLength = 120;
            input.setAttribute('aria-label', '書籤名稱，最多 60 個字');
            const save = action('儲存', 'layout-bookmark-name-save'), cancel = action('取消', 'layout-bookmark-name-cancel');
            const draft = { id: entry.id, input }; renameDraft = draft; row.replaceChildren(input, save, cancel);
            function cancelRename() {
                if (busy) return;
                renameDraft = null; renderedData = null; render(); focusAction(entry.id, 'layout-bookmark-rename');
            }
            function commitRename() {
                if (!canAct(true)) return;
                const name = input.value, id = entry.id, expected = copy(entry);
                mutation(() => store.rename(id, name, { expected }), updated => {
                    if (renameDraft === draft) renameDraft = null;
                    renderedData = null; render(); status('已重新命名為「' + updated.name + '」。'); focusAction(id, 'layout-bookmark-rename');
                }, { allowRename: true });
            }
            save.addEventListener('click', commitRename); cancel.addEventListener('click', cancelRename);
            input.addEventListener('keydown', event => {
                if (event.isComposing) return;
                if (event.key === 'Enter') { event.preventDefault(); commitRename(); }
                else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelRename(); }
            }); input.focus(); input.select();
        }
        function render() {
            if (destroyed) return;
            refreshImport(); updateControls();
            if (renameDraft || pointerActive || keyboardActive) return;
            const entries = store.list(), signature = JSON.stringify(entries);
            if (signature === renderedData) return;
            renderedData = signature;
            const scrollTop = panel.scrollTop, active = list.contains(doc.activeElement) ? doc.activeElement : null;
            const activeId = active?.closest('.layout-bookmark-card')?.dataset.bookmarkId, activeAction = active?.dataset.bookmarkAction;
            list.replaceChildren();
            saveButton.title = entries.length >= MAX_BOOKMARKS ? '已達 50 個書籤，請先刪除一個' : '儲存目前實際觀看的台及佈局';
            if (!entries.length) {
                const empty = el('div', 'layout-bookmarks-empty');
                empty.append(el('span', 'layout-bookmarks-empty-icon', '🔖'), el('strong', '', '留下喜歡的台佈局'),
                    el('p', '', '先選好要看的台及大小，再按上方「儲存目前佈局」。')); list.append(empty);
            }
            entries.forEach((entry, index) => {
                const card = el('article', 'layout-bookmark-card'); card.dataset.bookmarkId = entry.id;
                const nameRow = el('div', 'layout-bookmark-name-row'), name = el('h4', 'layout-bookmark-name', entry.name); name.title = entry.name;
                const up = action('↑', 'layout-bookmark-move-up', '向上移動「' + entry.name + '」');
                const down = action('↓', 'layout-bookmark-move-down', '向下移動「' + entry.name + '」');
                up.setAttribute('aria-label', up.title); down.setAttribute('aria-label', down.title);
                up.dataset.atBoundary = String(index === 0); down.dataset.atBoundary = String(index === entries.length - 1);
                const rename = action('改名', 'layout-bookmark-rename', '重新命名「' + entry.name + '」'); nameRow.append(name, up, down, rename);
                const preview = renderPreview(entry);
                const meta = el('p', 'layout-bookmark-meta', entry.snapshot.channels.length + ' 台 · 點縮圖套用' + (entry.snapshot.focus ? ' · 有放大格' : ''));
                const actions = el('div', 'layout-bookmark-actions'), applyButton = action('套用', 'layout-bookmark-apply', '套用「' + entry.name + '」');
                const updateButton = action('更新為目前佈局', 'layout-bookmark-update');
                const deleteButton = action('刪除', 'layout-bookmark-delete', '刪除「' + entry.name + '」，刪除後可復原');
                actions.append(applyButton, updateButton, deleteButton); card.append(nameRow, preview, meta, actions);
                rename.addEventListener('click', () => beginRename(entry, card));
                for (const [control, direction, neighbor] of [[up, 'up', entries[index - 1]], [down, 'down', entries[index + 1]]]) control.addEventListener('click', () => {
                    if (!canAct()) return;
                    const id = entry.id, name = entry.name, expected = copy(entry), expectedNeighbor = neighbor?.id || null;
                    mutation(() => store.move(id, direction, { expected, expectedNeighbor }), () => {
                        status('已' + (direction === 'up' ? '向上' : '向下') + '移動「' + name + '」。'); focusAction(id, 'layout-bookmark-move-' + direction, true);
                    });
                });
                async function applyEntry() {
                    if (!canAct()) return;
                    const chosen = copy(entry);
                    if (!store.list().some(item => item.id === chosen.id)) { failure(new Error('這個書籤已被刪除。')); return; }
                    busy = applying = true; updateControls();
                    try {
                        const result = await apply(copy(chosen.snapshot), chosen);
                        if (result?.applied === false || result?.applied === 0) throw new Error('未有套用任何頻道，已保留目前播放。');
                        close();
                    } catch (error) { if (!destroyed) failure(error); }
                    finally { busy = applying = false; if (!destroyed) updateControls(); }
                }
                preview.addEventListener('click', applyEntry); applyButton.addEventListener('click', applyEntry);
                updateButton.addEventListener('click', () => {
                    if (!canAct()) return;
                    const id = entry.id, name = entry.name, expected = copy(entry);
                    let snapshot; try { snapshot = copy(capture()); } catch (error) { failure(error); return; }
                    mutation(() => store.update(id, snapshot, { expected }), () => { status('「' + name + '」已更新為目前佈局。'); focusAction(id, 'layout-bookmark-update'); });
                });
                deleteButton.addEventListener('click', () => {
                    if (!canAct()) return;
                    const id = entry.id, name = entry.name, expected = copy(entry);
                    mutation(() => store.remove(id, { expected }), () => {
                        undoMessage = '已刪除「' + name + '」。'; render(); status(''); if (opened) undoButton.focus({ preventScroll: true });
                    });
                }); list.append(card);
            }); updateControls(); panel.scrollTop = scrollTop;
            if (activeId && activeAction) focusAction(activeId, activeAction);
        }
        async function refresh() {
            if (!opened || destroyed || busy || reloadBusy) return;
            reloadBusy = true; updateControls();
            try { await store.reload(); if (opened && !destroyed) render(); }
            catch (error) { if (opened && !destroyed) failure(error); }
            finally { reloadBusy = false; if (!destroyed) updateControls(); }
        }
        function open() {
            if (destroyed || opened) return;
            beforeOpen(); returnFocus = doc.activeElement; opened = true;
            panel.hidden = false; button.setAttribute('aria-expanded', 'true'); status('');
            if (localStore) { try { localStore.reload(); } catch (_) {} }
            render(); resetIdle(); panel.focus({ preventScroll: true }); refresh();
            if (sharedMode) refreshTimer = view.setInterval(() => refresh(), 15000);
        }
        function close(restoreFocus = true) {
            if (!opened) return;
            const shouldRestore = restoreFocus && panel.contains(doc.activeElement);
            opened = false; panel.hidden = true; button.setAttribute('aria-expanded', 'false');
            if (renameDraft) renderedData = null;
            renameDraft = null; resetIdle();
            if (refreshTimer !== null) view.clearInterval(refreshTimer); refreshTimer = null;
            pointerActive = keyboardActive = false;
            pendingFocus = null;
            if (pointerRenderTimer !== null) view.clearTimeout(pointerRenderTimer); pointerRenderTimer = null;
            if (shouldRestore) { const target = returnFocus?.isConnected && !panel.contains(returnFocus) ? returnFocus : button; target.focus({ preventScroll: true }); }
        }
        on(button, 'click', () => opened ? close() : open()); on(closeButton, 'click', () => close());
        on(saveButton, 'click', () => {
            if (!canAct()) return;
            const current = store.list(); let number = current.length + 1;
            while (current.some(entry => entry.name === '佈局 ' + number)) number++;
            const name = '佈局 ' + number; let snapshot;
            try { snapshot = copy(capture()); } catch (error) { failure(error); return; }
            mutation(() => store.add(name, snapshot), entry => status('已儲存「' + entry.name + '」，可按「改名」方便日後尋找。'));
        });
        on(undoButton, 'click', () => {
            if (!canAct()) return;
            mutation(() => store.undo(), entry => { if (entry) { status('已復原「' + entry.name + '」。'); focusAction(entry.id, 'layout-bookmark-preview'); } });
        });
        on(importButton, 'click', () => {
            if (!canAct() || !localStore) return;
            let entries; try { localStore.reload(); entries = pendingLocalEntries(); } catch (error) { refreshImport(); failure(error); return; }
            if (!entries.length) { refreshImport(); return; }
            const frozen = copy(entries);
            mutation(() => store.importLocal(frozen), result => {
                const imported = typeof result === 'number' ? result : result?.imported ?? frozen.length;
                const skipped = typeof result === 'object' && result ? result.skipped ?? frozen.length - imported : frozen.length - imported;
                status('已加入 ' + imported + ' 個本機書籤' + (skipped > 0 ? '，略過 ' + skipped + ' 個已匯入的書籤' : '') + '；本機原有書籤已保留。');
            });
        });
        for (const type of ['pointermove', 'pointerdown', 'pointerup', 'click', 'keydown', 'keyup', 'input', 'change', 'wheel', 'touchstart', 'touchmove', 'touchend'])
            on(panel, type, event => { if (opened && event.isTrusted === true) resetIdle(); }, { capture: true, passive: true });
        on(panel, 'pointerdown', () => { if (opened) pointerActive = true; }, true);
        function scheduleRender() {
            if (pointerRenderTimer !== null) view.clearTimeout(pointerRenderTimer);
            pointerRenderTimer = opened ? view.setTimeout(() => {
                pointerRenderTimer = null; render();
                const nextFocus = pendingFocus; pendingFocus = null;
                if (nextFocus) focusAction(nextFocus.id, nextFocus.className, nextFocus.scroll);
            }, 0) : null;
        }
        function releasePointer() { pointerActive = false; scheduleRender(); }
        on(view, 'pointerup', releasePointer); on(view, 'pointercancel', releasePointer);
        on(panel, 'keydown', event => { if (opened && [' ', 'Enter'].includes(event.key) && event.target.tagName === 'BUTTON') keyboardActive = true; }, true);
        on(view, 'keyup', event => { if ([' ', 'Enter'].includes(event.key)) { keyboardActive = false; scheduleRender(); } });
        on(view, 'blur', () => { pointerActive = keyboardActive = false; scheduleRender(); });
        on(doc, 'pointerdown', event => { if (opened && !panel.contains(event.target) && !button.contains(event.target)) close(false); }, true);
        on(doc, 'keydown', event => { if (opened && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close(); } });
        function subscribe() {
            if (unsubscribe || !sharedMode || typeof store.subscribe !== 'function') return;
            unsubscribe = store.subscribe(() => { if (opened && !destroyed) render(); });
        }
        subscribe(); on(view, 'focus', () => { if (sharedMode && opened) refresh(); });
        on(view, 'online', () => { if (sharedMode && opened) refresh(); });
        on(view, 'pagehide', () => { close(false); unsubscribe?.(); unsubscribe = null; });
        on(view, 'pageshow', () => { if (!destroyed) subscribe(); });
        on(view, 'storage', event => {
            if (event.key !== STORAGE_KEY && event.key !== null || event.storageArea && event.storageArea !== storage) return;
            if (sharedMode) { try { localStore.reload(); } catch (_) {} if (opened) { refreshImport(); updateControls(); } }
            else { try { store.reload(); if (opened) { if (renameDraft) status('其他分頁更新了書籤；正在修改的名稱會保留，儲存或取消後即可顯示更新。'); render(); } } catch (error) { if (opened) failure(error); } }
        });
        render();
        return { open, close, isOpen: () => opened, store,
            destroy() { close(false); destroyed = true; unsubscribe?.(); unsubscribe = null; cleanups.splice(0).forEach(cleanup => cleanup()); } };
    }

    const api = { normalizeSnapshot, createStore, mount };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.LayoutBookmarks = api;
})(typeof globalThis === 'object' ? globalThis : this);
