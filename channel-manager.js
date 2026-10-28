/* Same-origin editor for the shared GitHub channel list. Tokens stay in this closure. */
(function () {
    'use strict';

    const PLATFORMS = {
        twitch: { label: 'Twitch', hint: '頻道名稱，或完整 Twitch 頻道網址。', placeholder: '例如：ourchickenlife' },
        kick: { label: 'Kick', hint: '填寫 Kick 的頻道名稱。', placeholder: '例如：no25no2502' },
        ok: { label: 'OK.ru', hint: '填寫 OK.ru 影片的數字 ID。', placeholder: '例如：10268974521971' },
        at: { label: 'AngelThump', hint: '填寫 AngelThump 頻道名稱。', placeholder: '例如：ppkkkp' },
        m3u8: { label: 'M3U8 (HLS)', hint: '填寫完整的公開 HLS 串流網址。', placeholder: 'https://example.com/live.m3u8', url: true },
        youtube: { label: 'YouTube Live', hint: '影片 ID、UC 開頭的頻道 ID，或完整 YouTube 影片網址。', placeholder: '影片 ID 或 https://www.youtube.com/watch?v=…' },
        bs: { label: 'BeamStream (BS)', hint: '填寫完整的播放器 embed 網址。', placeholder: 'https://…', url: true },
        vaughn: { label: 'Vaughn.Live', hint: '填寫 Vaughn.Live 頻道名稱。', placeholder: '例如：kingkong_tv' },
        gosh: { label: 'Gosh', hint: '填寫 Gosh 頻道 ID，播放時會取得最新串流。', placeholder: '例如：meidingdang' },
        goodgame: { label: 'GoodGame', hint: '填寫 GoodGame 頻道的數字 ID；如有公開頻道名稱，可一併填寫。', placeholder: '例如：219534' }
    };
    const ids = ['connection-form', 'github-token', 'connect-button', 'disconnect-button', 'connection-state', 'connection-badge', 'repository-owner', 'repository-name', 'manager-status', 'new', 'channel-form', 'channel-fields', 'editor-heading', 'cancel-edit', 'channel-name', 'channel-platform', 'channel-id', 'channel-id-label', 'channel-id-help', 'goodgame-fields', 'channel-gg-username', 'save-channel', 'save-hint', 'refresh-channels', 'channel-count', 'channel-search', 'channel-list', 'empty-list', 'legacy-channels', 'legacy-summary', 'legacy-list', 'sync-sklive', 'sklive-hint', 'sklive-result', 'sklive-summary', 'sklive-additions'];
    const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
    ui['sklive-entries'] = document.getElementById('sklive-entries');
    ui['sklive-skipped'] = document.getElementById('sklive-skipped');
    const views = {
        manage: ['掛台管理', '查看及修改已掛台的名稱、平台與入口。'],
        new: ['加台', '手動新增直播入口，加入所有人共用的清單。'],
        channels: ['del台', '逐台選擇要移除的入口，確認後才會刪除。'],
        sklive: ['SKLive 補台', '核對來源清單，只補回本站缺少的台。'],
        health: ['疑似失效台檢查', '掃描現有台，查看證據後再決定如何處理。'],
        edit: ['編輯已掛台', '修改這個頻道的資料，儲存後更新共用清單。']
    };
    const panels = Object.fromEntries(['health', 'sklive', 'new', 'channels'].map(id => [id, document.getElementById(id)]));
    const navigation = Object.fromEntries(['manage', 'new', 'channels', 'sklive', 'health'].map(view => [view, document.getElementById('view-' + view)]));
    const editorFields = ['channel-name', 'channel-id', 'channel-platform', 'channel-gg-username'];
    const drafts = { new: null, edit: null };
    let currentView = '';
    let editReturnView = 'manage';
    const state = { snapshot: null, token: '', busy: false, previous: null, readonlyFallback: false, client: null, localRaw: null, localSyncQueued: false, localSyncing: false, authGeneration: 0 };
    let healthUI = null;
    let healthScanner = null;
    let healthScannerPromise = null;
    const config = globalThis.TV_CHANNEL_SYNC_CONFIG || {};
    if (config.owner) ui['repository-owner'].textContent = String(config.owner);
    if (config.repo) ui['repository-name'].textContent = String(config.repo);

    function message(text, kind = '') {
        ui['manager-status'].textContent = text;
        ui['manager-status'].className = 'status' + (kind ? ' ' + kind : '');
    }

    function failure(error, action) {
        // Do not show server bodies or exception messages: they can echo authorization data.
        const status = Number(error && (error.status || error.statusCode));
        const code = error && error.code;
        if (code === 'rate_limit' || status === 429) return 'GitHub 查詢次數已達上限，請稍後再試。';
        if (code === 'duplicate') return '這個平台及 ID 已在共用清單中，請重新整理並編輯原有頻道。';
        if (code === 'conflict' || code === 'write_conflict') return '這個頻道已被其他人修改或刪除。請重新整理後再試；未儲存的表單仍會保留。';
        if (code === 'invalid_data') return 'GitHub 回傳的清單或儲存結果不完整，請重新整理確認；已保留目前畫面及未儲存的表單。';
        if (code === 'timeout' || code === 'network') return action === 'save' ? 'GitHub 連線中斷或逾時，請先重新整理清單確認是否已儲存，再決定是否重試。' : 'GitHub 連線中斷或逾時，請稍後重新整理。';
        if (status === 401) return 'GitHub 權杖無效或已過期，請重新連線。';
        if (status === 403) return 'GitHub 未允許這項操作，請確認權杖可存取此程式庫，並有 Contents 讀寫權限。';
        if (status === 404) return '讀不到共用清單，請確認程式庫設定及權杖的存取範圍。';
        if (status === 409 || status === 422) return '共用清單已被其他人修改，或這個頻道已存在。請重新整理後再試；未儲存的表單仍會保留。';
        return action === 'save'
            ? '未能儲存共用清單。請確認連線及 GitHub 權限後再試；未儲存的表單仍會保留。'
            : '暫時無法連線 GitHub，請檢查網絡、權杖及程式庫設定後再試。';
    }

    function canSave() { return Boolean(state.client && state.token && state.snapshot && state.snapshot.sha && !state.readonlyFallback); }

    function revokeIfUnauthorized(error) {
        if (error && error.code !== 'rate_limit' && (error.code === 'auth' || error.code === 'permission' || [401, 403].includes(Number(error.status)))) state.token = '';
    }

    function lock(busy) {
        state.busy = busy;
        ui['github-token'].disabled = busy;
        ui['connect-button'].disabled = busy;
        ui['disconnect-button'].disabled = busy;
        ui['refresh-channels'].disabled = busy;
        ui['channel-fields'].disabled = busy;
        ui['cancel-edit'].disabled = busy;
        ui['save-channel'].disabled = busy || !canSave();
        ui['sync-sklive'].disabled = busy || !state.client || typeof SKLiveImport === 'undefined';
        ui['sync-sklive'].textContent = canSave() ? '核對並補回缺少的台' : '核對 SKLive 清單';
        ui['sklive-hint'].textContent = canSave() ? '按一次便會核對並儲存漏台；沒有漏台便不提交。' : '目前只核對；連線 GitHub 後，同一按鍵可直接補回漏台。';
        ui['channel-list'].querySelectorAll('button').forEach(button => { button.disabled = busy || !canSave(); });
        ui['legacy-list'].querySelectorAll('button').forEach(button => { button.disabled = busy || !canSave(); });
        ui['save-hint'].textContent = canSave() ? '儲存會更新所有人的頻道清單。' : state.readonlyFallback ? '目前使用備用清單；重新連線成功後才可儲存。' : '連線後可儲存至共用清單。';
        ui['connection-badge'].textContent = state.token ? '已連線' : '唯讀';
        ui['connection-badge'].className = 'badge ' + (state.token ? 'connected-badge' : 'muted-badge');
        ui['disconnect-button'].hidden = !state.token;
        ui['connect-button'].textContent = state.token ? '更換連線' : '連線';
        ui['connection-state'].textContent = state.token ? '已連線 GitHub，變更會儲存到共用頻道清單。' : '可先查看頻道；輸入此程式庫的 GitHub 存取權杖後便可儲存。';
        document.body.setAttribute('aria-busy', String(busy));
        if (healthUI) healthUI.refresh();
    }

    function make(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }

    function platformFields() {
        const key = ui['channel-platform'].value;
        const platform = PLATFORMS[key] || PLATFORMS.twitch;
        ui['channel-id-label'].textContent = platform.url ? '完整網址' : '頻道 ID';
        ui['channel-id-help'].textContent = platform.hint;
        ui['channel-id'].placeholder = platform.placeholder;
        ui['goodgame-fields'].hidden = key !== 'goodgame';
    }

    function resetEditor() {
        state.previous = null;
        ui['channel-name'].value = '';
        ui['channel-id'].value = '';
        ui['channel-platform'].value = 'twitch';
        ui['channel-gg-username'].value = '';
        ui['editor-heading'].textContent = '新增頻道';
        ui['save-channel'].textContent = '新增到共用清單';
        ui['cancel-edit'].hidden = true;
        platformFields();
    }

    function editorDraft() {
        return currentView === 'edit' && !state.previous ? null : { previous: state.previous, fields: Object.fromEntries(editorFields.map(id => [id, ui[id].value])) };
    }

    function restoreEditor(draft) {
        resetEditor();
        if (!draft) return;
        state.previous = draft.previous;
        editorFields.forEach(id => { ui[id].value = draft.fields[id]; });
        if (state.previous) {
            ui['editor-heading'].textContent = '編輯頻道';
            ui['save-channel'].textContent = '儲存共用頻道';
            ui['cancel-edit'].hidden = false;
        }
        platformFields();
    }

    function applyView(requested) {
        let next = Object.hasOwn(views, requested) ? requested : 'manage';
        if (next === 'edit' && currentView !== 'edit' && !drafts.edit) next = 'manage';
        if (next !== currentView) {
            if (Object.hasOwn(drafts, currentView)) drafts[currentView] = editorDraft();
            currentView = next;
            if (Object.hasOwn(drafts, next)) restoreEditor(drafts[next]);
        }
        document.title = views[next][0] + ' · 直播台';
        document.getElementById('page-heading').textContent = views[next][0];
        document.getElementById('page-description').textContent = views[next][1];
        document.body.setAttribute('data-view', next);
        panels.health.hidden = next !== 'health';
        panels.sklive.hidden = next !== 'sklive';
        panels.new.hidden = !['new', 'edit'].includes(next);
        panels.channels.hidden = !['manage', 'channels'].includes(next);
        const active = next === 'edit' ? editReturnView : next;
        Object.entries(navigation).forEach(([view, link]) => { link.setAttribute('aria-current', active === view ? 'page' : 'false'); });
        document.getElementById('list-heading').textContent = next === 'channels' ? '選擇要刪除的台' : '已掛台';
        document.getElementById('list-purpose').textContent = next === 'channels' ? '刪除會更新所有人的共用清單；每次刪除都需要確認。' : '選擇頻道以修改名稱、平台或播放入口。';
        render();
    }

    function navigate(view) {
        location.hash = '#' + view;
        applyView(view);
    }

    function cancelEditing() {
        resetEditor();
        drafts.edit = null;
        if (currentView === 'edit') navigate(editReturnView);
    }

    function focusEditor() {
        ui.new.scrollIntoView({ behavior: 'smooth', block: 'start' });
        ui['channel-name'].focus({ preventScroll: true });
    }

    function edit(channel) {
        if (state.busy) return;
        if (currentView !== 'edit') editReturnView = ['manage', 'channels', 'health'].includes(currentView) ? currentView : 'manage';
        // Enter the editor before populating it, keeping the separate add draft intact.
        if (Object.hasOwn(drafts, currentView)) drafts[currentView] = editorDraft();
        currentView = 'edit';
        location.hash = '#edit';
        state.previous = channel;
        ui['channel-name'].value = channel.name;
        ui['channel-id'].value = channel.id;
        ui['channel-platform'].value = channel.platform;
        ui['channel-gg-username'].value = channel.ggUsername || '';
        ui['editor-heading'].textContent = '編輯頻道';
        ui['save-channel'].textContent = '儲存共用頻道';
        ui['cancel-edit'].hidden = false;
        platformFields();
        applyView('edit');
        focusEditor();
    }

    function row(channel, legacy = false) {
        const item = make('li', 'channel-row');
        const info = make('div', 'channel-info');
        info.appendChild(make('div', 'channel-name', channel.name));
        const meta = make('div', 'channel-meta');
        const special = ['twitch', 'kick', 'gosh', 'vaughn'].includes(channel.platform);
        meta.appendChild(make('span', 'badge platform-' + (special ? channel.platform : 'other'), PLATFORMS[channel.platform]?.label || channel.platform));
        meta.appendChild(make('span', 'channel-id', channel.id + (channel.ggUsername ? ' · ' + channel.ggUsername : '')));
        info.appendChild(meta);
        item.appendChild(info);
        const actions = make('div', 'row-actions');
        if (legacy) {
            const add = make('button', 'edit-button', '加入共用清單');
            add.type = 'button';
            add.addEventListener('click', () => save({ action: 'add', channel }, false));
            actions.appendChild(add);
        } else {
            const editButton = make('button', 'edit-button', '編輯');
            editButton.type = 'button';
            editButton.hidden = currentView === 'channels';
            editButton.setAttribute('aria-label', '編輯 ' + channel.name);
            editButton.addEventListener('click', () => edit(channel));
            const deleteButton = make('button', 'delete-button', '刪除');
            deleteButton.type = 'button';
            deleteButton.hidden = currentView !== 'channels';
            deleteButton.setAttribute('aria-label', '刪除 ' + channel.name);
            deleteButton.addEventListener('click', () => {
                if (!canSave() || state.busy) return;
                if (window.confirm('刪除「' + channel.name + '」？所有人的共用清單都會更新。')) save({ action: 'delete', previous: channel }, false);
            });
            actions.appendChild(editButton);
            actions.appendChild(deleteButton);
        }
        actions.querySelectorAll('button').forEach(button => { button.disabled = state.busy || !canSave(); });
        item.appendChild(actions);
        return item;
    }

    function render() {
        const channels = state.snapshot ? state.snapshot.channels : [];
        const query = ui['channel-search'].value.trim().toLocaleLowerCase();
        const visible = channels.filter(channel => [channel.name, channel.id, channel.platform, PLATFORMS[channel.platform]?.label || '', channel.ggUsername || ''].join(' ').toLocaleLowerCase().includes(query));
        ui['channel-list'].replaceChildren(...visible.map(channel => row(channel)));
        ui['channel-count'].textContent = query ? '顯示 ' + visible.length + ' / ' + channels.length + ' 個頻道' : '共 ' + channels.length + ' 個頻道';
        ui['empty-list'].hidden = visible.length > 0;
        ui['empty-list'].textContent = query ? '找不到符合的頻道，試試其他名稱或平台。' : state.snapshot ? '清單尚未有頻道。' : '暫時讀不到頻道清單，請重新整理。';
        let privateChannels = [];
        try { privateChannels = ChannelList.readCustomChannels(localStorage); } catch (_) { /* Storage can be unavailable. */ }
        const sharedKeys = new Set(channels.map(ChannelList.channelKey));
        const extras = privateChannels.filter(channel => !sharedKeys.has(ChannelList.channelKey(channel)));
        ui['legacy-channels'].hidden = extras.length === 0 || !['manage', 'new'].includes(currentView);
        ui['legacy-summary'].textContent = '瀏覽器內另有 ' + extras.length + ' 個舊私人頻道';
        ui['legacy-list'].replaceChildren(...extras.map(channel => row(channel, true)));
    }

    function accept(snapshot, fallback = false) {
        if (!snapshot || !Array.isArray(snapshot.channels) || typeof snapshot.raw !== 'string') throw new Error('Invalid shared snapshot');
        state.snapshot = snapshot;
        state.readonlyFallback = fallback;
        render();
        if (healthUI) healthUI.refresh();
    }

    async function readLocal() {
        return ChannelList.loadSharedChannels(localStorage, fetch);
    }

    async function syncLocal() {
        if (state.busy || state.localSyncing) { state.localSyncQueued = true; return; }
        if (!state.snapshot) return;
        state.localSyncing = true;
        try {
            const loaded = await readLocal();
            if (state.busy) { state.localSyncQueued = true; return; }
            if (typeof loaded.raw === 'string' && loaded.raw !== state.localRaw) {
                const changed = loaded.raw !== state.snapshot.raw;
                state.localRaw = loaded.raw;
                // Keep the editor's original record so concurrent edits still conflict safely.
                accept({ ...state.snapshot, channels: loaded.channels, raw: loaded.raw }, state.readonlyFallback);
                if (changed) message('共用清單已更新；未儲存的表單仍會保留。');
            }
        } catch (_) { /* Keep a successfully read GitHub snapshot on local network failure. */ }
        finally {
            state.localSyncing = false;
            if (state.localSyncQueued && !state.busy) { state.localSyncQueued = false; syncLocal(); }
        }
    }

    function finishOperation() {
        lock(false);
        if (state.localSyncQueued) { state.localSyncQueued = false; syncLocal(); }
    }

    async function refresh(initial = false) {
        if (state.busy) return;
        lock(true);
        message('正在讀取共用頻道…');
        let localSnapshot = null;
        try {
            // Remember the deployed version before reading GitHub, so an older Pages
            // deployment cannot later replace a newer GitHub snapshot on focus.
            try {
                const local = await readLocal();
                if (typeof local.raw === 'string') { state.localRaw = local.raw; localSnapshot = local; }
            } catch (_) { /* GitHub can remain available while this origin is not. */ }
            if (!state.client) throw new Error('Shared client unavailable');
            accept(await state.client.read(state.token));
            message('已讀取最新共用清單。', 'success');
        } catch (error) {
            if (initial && !state.snapshot) {
                try {
                    if (localSnapshot) accept({ channels: localSnapshot.channels, raw: localSnapshot.raw, sha: '' }, true);
                    else {
                        const response = await fetch('./ch1.txt?t=' + Date.now(), { cache: 'no-store' });
                        if (!response.ok) throw new Error('Fallback unavailable');
                        const raw = await response.text();
                        accept({ channels: ChannelList.parseChannelText(raw), raw, sha: '' }, true);
                    }
                    message('暫時讀不到 GitHub，現顯示本站最後部署的唯讀清單。重新連線成功後才可儲存。', 'warning');
                } catch (_) {
                    render();
                    message('暫時讀不到共用頻道，請確認網絡及程式庫設定後重新整理。', 'error');
                }
            } else {
                revokeIfUnauthorized(error);
                message(failure(error, 'read'), 'error');
            }
        } finally {
            finishOperation();
            if (initial && ['new', 'edit'].includes(currentView)) focusEditor();
        }
    }

    function validateForm() {
        const name = ui['channel-name'].value.trim();
        const id = ui['channel-id'].value.trim();
        const platform = ui['channel-platform'].value;
        const ggUsername = ui['channel-gg-username'].value.trim();
        if (!name || !id || !PLATFORMS[platform]) throw new Error('請填寫顯示名稱、平台及頻道 ID。');
        if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029,]/u.test(name + id)) throw new Error('名稱及 ID 不能包含逗號或換行，請分別填入欄位。');
        if (PLATFORMS[platform].url) {
            let url;
            try { url = new URL(id); } catch (_) { throw new Error('請填寫以 https:// 或 http:// 開頭的完整網址。'); }
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('請使用不含登入資料的公開 http:// 或 https:// 網址。');
        }
        if (platform === 'goodgame' && ggUsername && !/^[\w.-]{1,80}$/.test(ggUsername)) throw new Error('GoodGame 公開名稱只可包含英文字母、數字、底線、點或連字號。');
        const channel = ChannelList.normalizeChannel({ name, id, platform, ...(platform === 'goodgame' && ggUsername ? { ggUsername } : {}) });
        if (!channel) throw new Error('請檢查頻道資料。');
        return channel;
    }

    async function save(change, clearEditor = true) {
        if (state.busy || !canSave()) return false;
        const before = state.snapshot;
        const submittedView = currentView;
        const submittedPrevious = state.previous;
        lock(true);
        message('正在儲存共用清單…');
        try {
            const saved = await state.client.save(before, change, state.token);
            accept(saved);
            let published = true;
            try { published = ChannelList.publishSharedSnapshot(localStorage, saved.raw, before.raw, [saved.baseRaw]) !== false; } catch (_) { published = false; }
            if (clearEditor) {
                if (currentView === submittedView && state.previous === submittedPrevious) {
                    resetEditor();
                    if (Object.hasOwn(drafts, submittedView)) drafts[submittedView] = null;
                    if (submittedView === 'edit') navigate(editReturnView);
                } else if (drafts[submittedView]?.previous === submittedPrevious) drafts[submittedView] = null;
            }
            if (change.action === 'delete') {
                const deletedKey = ChannelList.channelKey(change.previous);
                if (drafts.edit?.previous && ChannelList.channelKey(drafts.edit.previous) === deletedKey) drafts.edit = null;
                if (state.previous && ChannelList.channelKey(state.previous) === deletedKey) {
                    resetEditor();
                    if (currentView === 'edit') navigate(editReturnView);
                }
            }
            message(published ? '已儲存，共用頻道清單已更新。' : 'GitHub 已儲存。這個瀏覽器暫時未能同步預覽；網站部署後會更新。', published ? 'success' : 'warning');
            return true;
        } catch (error) { revokeIfUnauthorized(error); message(failure(error, 'save'), 'error'); return false; }
        finally { finishOperation(); }
    }

    function sameHealthRecord(left, right) {
        return Boolean(left && right && ['name', 'id', 'platform', 'ggUsername'].every(field => (left[field] || '') === (right[field] || '')));
    }

    async function getHealthScanner() {
        if (!healthScannerPromise) healthScannerPromise = (async () => {
            let seed = null;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 6000);
            try {
                const response = await fetch('./channel-validation.json', { signal: controller.signal, cache: 'no-store', credentials: 'omit' });
                if (response.ok) seed = await response.json();
            } catch (_) { /* Fresh checks still work without the older account-ID snapshot. */ }
            finally { clearTimeout(timer); }
            let storage;
            try { storage = localStorage; } catch (_) { /* In-memory results remain available. */ }
            healthScanner = ChannelHealth.createScanner({ fetcher: fetch, storage, seed });
            return healthScanner;
        })();
        return healthScannerPromise;
    }

    function healthSnapshot() {
        return state.snapshot ? { ...state.snapshot, channels: state.snapshot.channels.map(channel => ({ ...channel })) } : null;
    }

    async function runHealthAction(change) {
        if (state.busy || !canSave() || !change || !['edit', 'delete'].includes(change.action)) return { ok: false };
        const key = ChannelList.channelKey(change.previous);
        const current = state.snapshot.channels.find(channel => ChannelList.channelKey(channel) === key);
        if (!sameHealthRecord(current, change.previous)) {
            message('這個頻道已被修改或移除，請重查後再決定。', 'warning');
            return { ok: false };
        }
        if (change.action === 'edit') {
            edit(current);
            if (change.channel) {
                const proposed = ChannelList.normalizeChannel({ ...current, id: change.channel.id || current.id, platform: change.channel.platform || current.platform });
                if (proposed) {
                    ui['channel-id'].value = proposed.id;
                    ui['channel-platform'].value = proposed.platform;
                    platformFields();
                }
            }
            message('已開啟入口編輯；檢查資料後按儲存才會更新共用清單。');
            return { ok: true, opened: true };
        }
        if (!window.confirm('確認刪除「' + current.name + '」的 ' + (PLATFORMS[current.platform]?.label || current.platform) + ' 入口？\n\n核查結果只是線索。刪除會更新所有人的共用清單，Git 歷史仍可復原。')) return { ok: false };
        return { ok: await save({ action: 'delete', previous: current }, false) };
    }

    function skliveSourceWarnings(report) {
        return (Array.isArray(report.sourceWarnings) ? report.sourceWarnings : []).filter(value => typeof value === 'string' && value.trim()).slice(0, 4);
    }

    function showSKLiveResult(report, additions, saved, currentChannels = []) {
        ui['sklive-result'].hidden = false;
        const skipped = report.skipped.length;
        const duplicates = report.duplicates.length;
        const sourceWarnings = skliveSourceWarnings(report);
        const current = new Map(currentChannels.map(channel => [ChannelList.channelKey(channel), channel]));
        const added = new Set(additions.map(ChannelList.channelKey));
        const included = report.channels.filter(channel => current.has(ChannelList.channelKey(channel))).length;
        const checkedAt = typeof report.checkedAt === 'string' && Number.isFinite(Date.parse(report.checkedAt))
            ? new Date(report.checkedAt).toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong', hour12: false }) + '（香港時間）' : '未提供';
        const coverage = !report.channels.length ? ' 沒有可識別的入口，清單沒有更動。'
            : additions.length ? saved ? ' 已補回 ' + additions.length + ' 台；來源的 ' + included + ' / ' + report.channels.length + ' 個入口現已在本站。'
                : ' 本站已有 ' + included + ' 個入口，另缺 ' + additions.length + ' 台（尚未儲存）。'
                : included !== report.channels.length ? ' 本站只確認 ' + included + ' / ' + report.channels.length + ' 個入口，請重新核對。'
                    : sourceWarnings.length ? ' 本次只確認成功讀取的 ' + included + ' 個入口，部分來源未完成核對。'
                    : skipped ? ' 已識別的 ' + included + ' 個入口均已在本站；未識別項目未加入。'
                        : ' 已核對 ' + included + ' 個入口，均已在本站；沒有新增或刪除。';
        ui['sklive-summary'].textContent = '來源共 ' + report.received + ' 筆（' + report.hidden + ' 筆標記隱藏），識別到 ' + report.channels.length + ' 個不同入口。' +
            (duplicates ? ' 合併 ' + duplicates + ' 筆重複。' : '') +
            (skipped ? ' ' + skipped + ' 筆未能識別，沒有自動加入。' : '') +
            coverage + (sourceWarnings.length ? ' 來源核對未完成：' + sourceWarnings.join('；') + '。' : '') +
            ' 核對時間：' + checkedAt + '。已在本站只代表清單已有入口，不代表正在直播；主頁看不到時，可先關閉「隱藏離線」核對。';
        ui['sklive-additions'].replaceChildren(...additions.map(channel => make('li', '', channel.name + ' · ' + (PLATFORMS[channel.platform]?.label || channel.platform) + ' · ' + channel.id)));
        if (ui['sklive-entries']) ui['sklive-entries'].replaceChildren(...report.channels.map(channel => {
            const key = ChannelList.channelKey(channel);
            const existing = current.get(key);
            const status = saved && added.has(key) && existing ? '已補回' : existing ? '已在本站' : '未加入（漏台）';
            const localName = existing && existing.name !== channel.name ? '（本站名稱：' + existing.name + '）' : '';
            return make('li', 'sklive-entry', status + ' · ' + channel.name + ' · ' + (PLATFORMS[channel.platform]?.label || channel.platform) + ' · ' + channel.id + localName);
        }));
        if (ui['sklive-skipped']) {
            const reasons = {
                invalid_entry: '資料不是有效的頻道項目', missing_name: '缺少台名', ambiguous_platform: '平台標記無法判定',
                unsupported_platform: '本站尚未支援此平台', unmappable_hls: '沒有可保存的固定直播入口',
                conflicting_identity: '平台 ID 與網址不一致', unmappable_identity: '無法辨識頻道 ID', invalid_public_fields: '頻道欄位不符合共用清單格式'
            };
            ui['sklive-skipped'].replaceChildren(...report.skipped.map((item, offset) => {
                const index = Number.isInteger(item.index) && item.index > 0 ? item.index : offset + 1;
                const name = typeof item.name === 'string' && item.name.trim() ? item.name : '未命名';
                const platform = typeof item.platform === 'string' && item.platform ? ' · ' + (PLATFORMS[item.platform]?.label || item.platform) : '';
                return make('li', '', '第 ' + index + ' 筆 · ' + name + platform + '：' + (reasons[item.reason] || '未能確認可用的公開入口，請人工核對'));
            }));
            ui['sklive-skipped'].hidden = !skipped;
        }
    }

    async function syncSKLive() {
        if (state.busy || !state.client || typeof SKLiveImport === 'undefined') return;
        const authGeneration = state.authGeneration;
        const before = state.snapshot;
        let stage = 'source';
        lock(true);
        ui['sklive-result'].hidden = true;
        message('正在讀取 SKLive 清單並核對漏台…');
        try {
            // The importer only sends the fixed public source URL to its proxies.
            // GitHub authorization remains confined to the existing GitHub client.
            const report = await SKLiveImport.load(fetch);
            if (authGeneration !== state.authGeneration) return;
            if (!report.channels.length) {
                showSKLiveResult(report, [], false);
                message('來源有資料，但沒有可識別的入口；沒有修改清單，請稍後再核對。', 'warning');
                return;
            }
            const writable = canSave();
            stage = writable ? 'save' : 'read';
            const result = writable
                ? await state.client.addMissing(report.channels, state.token)
                : await state.client.read();
            if (authGeneration !== state.authGeneration) return;
            const additions = writable ? result.added : SKLiveImport.compare(result.channels, report.channels).added;
            accept(result);
            let published = true;
            if (writable && additions.length) {
                try { published = ChannelList.publishSharedSnapshot(localStorage, result.raw, before && before.raw, [result.baseRaw]) !== false; } catch (_) { published = false; }
            }
            showSKLiveResult(report, additions, writable, result.channels);
            const skipped = report.skipped.length;
            const sourceWarnings = skliveSourceWarnings(report);
            const text = additions.length
                ? writable ? '已補回 ' + additions.length + ' 台，保留所有現有台及名稱。' + (!published ? ' GitHub 已儲存，網站部署完成後會更新。' : '')
                    : '找到 ' + additions.length + ' 個漏台；連線 GitHub 後，再按一次便可補回。'
                : sourceWarnings.length ? '已核對本次成功讀取的 ' + report.channels.length + ' 個入口；部分來源未完成核對，不能確認全部台已包括。沒有修改清單。'
                    : '已核對 SKLive 的 ' + report.channels.length + ' 個' + (skipped ? '已識別入口，均已包括；沒有修改清單。' : '入口，本站全部已包括；沒有修改清單。');
            message(text + (skipped ? ' 另有 ' + skipped + ' 筆未能識別，詳見核對結果。' : '') +
                (sourceWarnings.length ? ' ' + sourceWarnings.join('；') : ''), skipped || sourceWarnings.length || !published || (!writable && additions.length) ? 'warning' : 'success');
        } catch (error) {
            if (authGeneration !== state.authGeneration) return;
            if (stage === 'source') message('暫時讀不到有效的 SKLive 清單；沒有新增或刪除任何台，請稍後再試。', 'error');
            else { revokeIfUnauthorized(error); message(failure(error, stage), 'error'); }
        } finally { finishOperation(); }
    }

    Object.entries(PLATFORMS).forEach(([value, platform]) => {
        const option = make('option', '', platform.label);
        option.value = value;
        ui['channel-platform'].appendChild(option);
    });
    resetEditor();
    applyView(location.hash.slice(1));
    Object.entries(navigation).forEach(([view, link]) => {
        link.addEventListener('click', event => { event.preventDefault(); navigate(view); });
    });
    try { state.client = ChannelSync.createClient(config); } catch (_) { /* The fallback remains readable. */ }
    if (typeof ChannelHealthUI !== 'undefined' && typeof ChannelHealth !== 'undefined') {
        healthUI = ChannelHealthUI.createUI({ document, getSnapshot: healthSnapshot, canWrite: canSave, isBusy: () => state.busy, runAction: runHealthAction, onMessage: message,
            loadSnapshot: async () => {
                if (state.busy || !state.client) throw new Error('Shared list busy');
                const generation = state.authGeneration;
                lock(true);
                try {
                    const snapshot = await state.client.read(state.token);
                    if (generation !== state.authGeneration) throw new Error('Shared list changed');
                    accept(snapshot);
                    return healthSnapshot();
                } catch (error) {
                    if (generation === state.authGeneration) revokeIfUnauthorized(error);
                    throw error;
                } finally { finishOperation(); }
            },
            scanner: {
                scan: async (...args) => (await getHealthScanner()).scan(...args),
                check: async (...args) => (await getHealthScanner()).check(...args),
                history: channel => healthScanner ? healthScanner.history(channel) : [],
                recordDecision: async (...args) => (await getHealthScanner()).recordDecision(...args)
            }
        });
    }
    ui['channel-platform'].addEventListener('change', platformFields);
    ui['cancel-edit'].addEventListener('click', cancelEditing);
    ui['channel-search'].addEventListener('input', render);
    ui['refresh-channels'].addEventListener('click', () => refresh());
    ui['sync-sklive'].addEventListener('click', syncSKLive);
    ui['channel-form'].addEventListener('submit', event => {
        event.preventDefault();
        if (state.busy || !canSave()) return;
        let channel;
        try { channel = validateForm(); } catch (error) { message(error.message, 'error'); return; }
        const key = ChannelList.channelKey(channel);
        const previousKey = state.previous && ChannelList.channelKey(state.previous);
        if (state.snapshot.channels.some(value => ChannelList.channelKey(value) === key && key !== previousKey)) {
            message('這個平台及 ID 已在共用清單中，請編輯原有頻道。', 'error');
            return;
        }
        save({ action: state.previous ? 'edit' : 'add', ...(state.previous ? { previous: state.previous } : {}), channel });
    });
    ui['connection-form'].addEventListener('submit', async event => {
        event.preventDefault();
        if (state.busy) return;
        const candidate = ui['github-token'].value.trim();
        if (!candidate) { message('請先貼上 GitHub 存取權杖。', 'error'); return; }
        const authGeneration = ++state.authGeneration;
        state.token = '';
        lock(true);
        message('正在驗證 GitHub 連線…');
        try {
            if (!state.client) state.client = ChannelSync.createClient(config);
            const snapshot = await state.client.read(candidate);
            if (authGeneration !== state.authGeneration) return;
            accept(snapshot);
            state.token = candidate;
            message('已連線，可以管理共用頻道。', 'success');
        } catch (error) { message(failure(error, 'read'), 'error'); }
        finally { ui['github-token'].value = ''; finishOperation(); }
    });
    ui['disconnect-button'].addEventListener('click', () => {
        state.authGeneration++;
        state.token = '';
        ui['github-token'].value = '';
        lock(false);
        message('已中斷連線；仍可查看共用頻道。');
    });
    window.addEventListener('pagehide', () => { if (healthUI) healthUI.cancel(); state.authGeneration++; state.token = ''; ui['github-token'].value = ''; message('連線已中斷；如需儲存，請重新輸入權杖。'); });
    window.addEventListener('pageshow', event => { if (event.persisted) lock(state.busy); });
    window.addEventListener('hashchange', () => { applyView(location.hash.slice(1)); });
    window.addEventListener('focus', syncLocal);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) syncLocal(); });
    window.addEventListener('storage', event => {
        if (event.storageArea === localStorage && (event.key === ChannelList.sharedUpdateKey || event.key === null)) syncLocal();
    });
    setInterval(() => { if (!document.hidden) syncLocal(); }, 60000);
    refresh(true);
})();
