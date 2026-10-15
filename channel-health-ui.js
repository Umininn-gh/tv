/* Health reports are read-only until an explicit action reaches the manager. */
(function (root) {
    'use strict';

    const ChannelList = root.ChannelList || (typeof require === 'function' ? require('./channel-list.js') : null);
    const FIELDS = ['name', 'id', 'platform', 'ggUsername'];
    const LABELS = { live: '直播中', offline: '離線（仍有效）', exists: '入口存在', repair: '可修復', suspect: '疑似失效', ended: '固定影片已結束', unknown: '無法確認' };
    const DECISIONS = { keep: '保留', review: '待審核', deleted: '已刪除' };

    function publicChannel(value) {
        if (!value || typeof value !== 'object') return null;
        const channel = {};
        for (const field of FIELDS) if (typeof value[field] === 'string') channel[field] = value[field];
        return ChannelList && ChannelList.channelKey(channel) ? channel : null;
    }

    function sameChannel(left, right) {
        return Boolean(left && right && FIELDS.every(field => (left[field] || '') === (right[field] || '')));
    }

    function dateLabel(value) {
        const date = new Date(value);
        return value !== undefined && value !== null && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-HK', { hour12: false }) : '時間不詳';
    }

    function safeUrl(value) {
        try {
            const url = new URL(value);
            return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
        } catch (_) { return ''; }
    }

    function createUI({ document, scanner, loadSnapshot, getSnapshot, canWrite, isBusy, runAction, onMessage = () => {} }) {
        const ids = ['health', 'health-start', 'health-cancel', 'health-summary', 'health-results', 'health-filter', 'health-progress'];
        const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
        if (!ChannelList || ids.some(id => !ui[id]) || !scanner || typeof scanner.scan !== 'function') throw new Error('Health UI unavailable');
        const state = { rows: [], running: false, loading: false, cancelled: false, disposed: false, generation: 0, controllers: new Set() };

        function make(tag, className, text) {
            const node = document.createElement(tag);
            if (className) node.className = className;
            if (text !== undefined) node.textContent = text;
            return node;
        }

        function currentChannels() {
            try { return new Map((getSnapshot()?.channels || []).map(channel => [ChannelList.channelKey(channel), channel])); }
            catch (_) { return new Map(); }
        }

        function isStale(row, current = currentChannels()) {
            return !sameChannel(row.channel, current.get(row.key));
        }

        function evidenceList(evidence) {
            const list = make('ul', 'health-evidence');
            for (const item of Array.isArray(evidence) ? evidence : []) {
                if (!item || typeof item !== 'object') continue;
                const line = make('li');
                const url = safeUrl(item.url);
                if (url) {
                    const link = make('a', '', typeof item.label === 'string' ? item.label : '查核來源');
                    link.href = url;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                    line.appendChild(link);
                }
                if (typeof item.summary === 'string') line.appendChild(make('span', '', (url ? ' · ' : '') + item.summary));
                if (Number.isInteger(item.httpStatus)) line.appendChild(make('span', '', ' · HTTP ' + item.httpStatus));
                if (line.children.length) list.appendChild(line);
            }
            return list;
        }

        function createRow(channel) {
            const row = { channel, key: ChannelList.channelKey(channel), result: null, decision: null, working: false, deleted: false, note: '' };
            const element = make('li', 'health-row');
            const heading = make('div', 'health-row-heading');
            const name = make('strong', 'health-name');
            const status = make('span', 'badge health-status');
            heading.appendChild(name);
            heading.appendChild(status);
            const identity = make('p', 'channel-meta');
            const reason = make('p', 'health-reason');
            const checked = make('p', 'hint health-checked');
            const decision = make('p', 'hint health-decision');
            const stale = make('p', 'health-stale');
            const note = make('p', 'hint health-action-note');
            const details = make('details', 'health-details');
            details.appendChild(make('summary', '', '查核證據與歷史'));
            const detailBody = make('div');
            details.appendChild(detailBody);
            const actions = make('div', 'row-actions health-actions');
            const recheck = make('button', 'subtle', '重新檢查');
            const keep = make('button', 'subtle', '保留');
            const edit = make('button', 'edit-button', '編輯');
            const remove = make('button', 'delete-button', '刪除');
            for (const button of [recheck, keep, edit, remove]) { button.type = 'button'; actions.appendChild(button); }
            recheck.addEventListener('click', () => recheckRow(row));
            keep.addEventListener('click', () => keepRow(row));
            edit.addEventListener('click', () => act(row, 'edit'));
            remove.addEventListener('click', () => act(row, 'delete'));
            for (const child of [heading, identity, reason, checked, decision, stale, note, details, actions]) element.appendChild(child);
            row.view = { element, name, status, identity, reason, checked, decision, stale, note, detailBody, recheck, keep, edit, remove, renderedResult: undefined };
            return row;
        }

        function renderDetails(row) {
            const body = row.view.detailBody;
            const result = row.result;
            body.replaceChildren();
            if (!result) { body.appendChild(make('p', 'hint', '尚未有查核證據。')); return; }
            body.appendChild(evidenceList(result.evidence));
            const history = make('ol', 'health-history');
            const entries = Array.isArray(result.history) ? result.history : [];
            for (let index = 0; index < entries.length; index++) {
                const entry = entries[index];
                if (!entry || typeof entry !== 'object') continue;
                if (index === 0 && entry.checkedAt === result.checkedAt && entry.status === result.status && entry.reason === result.reason) continue;
                const item = make('li');
                item.appendChild(make('p', '', dateLabel(entry.checkedAt) + ' · ' + (LABELS[entry.status] || LABELS.unknown) + (typeof entry.reason === 'string' ? ' · ' + entry.reason : '')));
                item.appendChild(evidenceList(entry.evidence));
                history.appendChild(item);
            }
            if (history.children.length) {
                body.appendChild(make('p', 'health-history-heading', '歷次核查'));
                body.appendChild(history);
            }
        }

        function refresh() {
            if (state.disposed) return;
            const current = currentChannels();
            const busy = Boolean(isBusy());
            const writing = Boolean(canWrite());
            const pending = state.rows.some(row => row.working);
            ui['health-start'].disabled = state.running || pending || busy;
            ui['health-cancel'].hidden = !state.controllers.size;
            ui['health-cancel'].disabled = !state.controllers.size;
            ui.health.setAttribute('aria-busy', String(state.running || pending));
            const filter = ui['health-filter'].value || 'all';
            const counts = Object.fromEntries(Object.keys(LABELS).map(status => [status, 0]));
            let completed = 0;
            let staleCount = 0;
            for (const row of state.rows) {
                const view = row.view;
                const status = row.result && LABELS[row.result.status] ? row.result.status : 'unknown';
                const stale = isStale(row, current);
                if (row.result) { counts[status]++; completed++; }
                if (stale && !row.deleted) staleCount++;
                view.name.textContent = row.channel.name;
                view.identity.textContent = row.channel.platform + ' · ' + row.channel.id + (row.channel.ggUsername ? ' · ' + row.channel.ggUsername : '');
                view.status.textContent = row.result ? LABELS[status] : state.cancelled ? '未檢查（已取消）' : '尚未檢查';
                view.status.className = 'badge health-status health-' + (row.result ? status : 'pending');
                view.reason.textContent = typeof row.result?.reason === 'string' ? row.result.reason : '';
                view.checked.textContent = row.result ? '查核時間：' + dateLabel(row.result.checkedAt) : '';
                const decision = row.decision;
                view.decision.hidden = !decision || !DECISIONS[decision.decision];
                view.decision.textContent = view.decision.hidden ? '' : '審核標記：' + DECISIONS[decision.decision] + ' · ' + dateLabel(decision.checkedAt);
                view.stale.hidden = !stale || row.deleted;
                view.stale.textContent = current.has(row.key) ? '此台資料已更改；請重新檢查後再編輯或刪除。' : '此台已從目前清單移除；這份結果不適用於目前清單。';
                view.note.textContent = row.note;
                view.note.hidden = !row.note;
                view.recheck.disabled = state.running || row.working || busy || row.deleted;
                view.keep.disabled = row.working || row.deleted;
                view.edit.disabled = !writing || busy || state.running || row.working || stale || row.deleted || !row.result;
                view.remove.disabled = view.edit.disabled;
                view.edit.textContent = row.result?.suggestion ? '修復／編輯' : '編輯';
                view.element.hidden = filter === 'attention' ? !(['repair', 'suspect', 'ended'].includes(status) || stale) : filter === 'normal' ? !row.result || !['live', 'offline', 'exists'].includes(status) : filter === 'unknown' ? Boolean(row.result && status !== 'unknown') : false;
                if (view.renderedResult !== row.result) { renderDetails(row); view.renderedResult = row.result; }
            }
            if (state.rows.length) {
                ui['health-summary'].textContent = '共 ' + state.rows.length + ' 台，已檢查 ' + completed + ' 台；' +
                    Object.entries(counts).map(([status, count]) => LABELS[status] + ' ' + count).join('、') + '。' +
                    (completed < state.rows.length ? ' 尚未檢查 ' + (state.rows.length - completed) + ' 台。' : '') +
                    (staleCount ? ' ' + staleCount + ' 台資料已更改或移除。' : '');
            } else if (!state.loading) ui['health-summary'].textContent = '按「掃描全部現有台」逐台核對目前共用清單。';
        }

        function setResult(row, result) {
            if (!result || typeof result !== 'object') return;
            row.result = result;
            row.decision = result.decision || null;
            row.deleted = false;
        }

        async function start() {
            if (state.disposed || state.running || state.rows.some(row => row.working) || isBusy()) return;
            const generation = ++state.generation;
            const controller = new AbortController();
            state.controllers.add(controller);
            state.running = state.loading = true;
            state.cancelled = false;
            ui['health-progress'].textContent = '正在讀取最新共用清單…';
            refresh();
            try {
                const snapshot = await loadSnapshot();
                if (generation !== state.generation || state.disposed) return;
                if (!snapshot || !Array.isArray(snapshot.channels)) throw new Error('Invalid snapshot');
                const unique = new Map();
                for (const value of snapshot.channels) {
                    const channel = publicChannel(value);
                    if (channel) unique.set(ChannelList.channelKey(channel), channel);
                }
                state.rows = [...unique.values()].map(createRow);
                ui['health-results'].replaceChildren(...state.rows.map(row => row.view.element));
                state.loading = false;
                const rows = new Map(state.rows.map(row => [row.key, row]));
                ui['health-progress'].textContent = '已檢查 0 / ' + state.rows.length + ' 台。';
                refresh();
                const report = await scanner.scan(state.rows.map(row => ({ ...row.channel })), {
                    signal: controller.signal,
                    onResult(result) {
                        if (generation !== state.generation || state.disposed) return;
                        const row = rows.get(result.key || ChannelList.channelKey(result.channel));
                        if (row) setResult(row, result);
                        ui['health-progress'].textContent = '已檢查 ' + state.rows.filter(row => row.result).length + ' / ' + state.rows.length + ' 台。';
                        refresh();
                    },
                    onProgress(progress) {
                        if (generation !== state.generation || state.disposed) return;
                        ui['health-progress'].textContent = '已檢查 ' + progress.completed + ' / ' + progress.total + ' 台。';
                    }
                });
                if (generation !== state.generation || state.disposed) return;
                for (const result of report.results || []) {
                    const row = rows.get(result.key || ChannelList.channelKey(result.channel));
                    if (row) setResult(row, result);
                }
                state.cancelled = Boolean(report.cancelled);
                const completed = state.rows.filter(row => row.result).length;
                ui['health-progress'].textContent = (state.cancelled ? '檢查已取消' : '檢查完成') + '：' + completed + ' / ' + state.rows.length + ' 台。';
            } catch (_) {
                if (generation !== state.generation || state.disposed) return;
                ui['health-progress'].textContent = state.loading ? '讀取最新共用清單失敗；未開始檢查。' : '檢查中斷；已保留完成的結果。';
                onMessage(state.loading ? '暫時讀不到最新清單，請重新整理後再檢查。' : '健康檢查暫時中斷，未完成的台可重新檢查；沒有修改共用清單。', 'error');
            } finally {
                state.controllers.delete(controller);
                if (generation === state.generation) { state.running = state.loading = false; refresh(); }
            }
        }

        async function recheckRow(row) {
            if (state.disposed || state.running || row.working || row.deleted || isBusy()) return;
            const generation = state.generation;
            const controller = new AbortController();
            const channel = publicChannel(currentChannels().get(row.key)) || row.channel;
            row.working = true;
            state.controllers.add(controller);
            refresh();
            try {
                const result = await scanner.check({ ...channel }, { signal: controller.signal });
                if (generation !== state.generation || state.disposed) return;
                row.channel = channel;
                setResult(row, result);
                row.note = '已重新檢查；保留或刪除仍由你決定。';
            } catch (_) {
                if (generation !== state.generation || state.disposed) return;
                row.note = '重新檢查失敗，保留上次結果；尚未修改清單。';
            } finally {
                state.controllers.delete(controller);
                if (generation === state.generation) { row.working = false; refresh(); }
            }
        }

        async function keepRow(row) {
            if (state.disposed || row.working || row.deleted) return;
            try {
                const saved = await scanner.recordDecision({ ...row.channel }, 'keep');
                if (state.disposed) return;
                if (saved && DECISIONS[saved.decision]) row.decision = { decision: saved.decision, checkedAt: saved.checkedAt };
                row.note = saved === false ? '此瀏覽器未能儲存保留標記；共用清單沒有改動。' : '已標記保留；下次檢查仍會查核此台。';
            } catch (_) { row.note = '此瀏覽器未能儲存保留標記；共用清單沒有改動。'; }
            refresh();
        }

        async function act(row, action) {
            if (state.disposed || state.running || row.working || row.deleted || !row.result || !canWrite() || isBusy()) return;
            if (isStale(row)) { refresh(); onMessage('這個台的資料已改變，請重新檢查後再操作。', 'warning'); return; }
            const change = { action, previous: { ...row.channel } };
            if (action === 'edit') {
                const suggestion = row.result.suggestion;
                const next = suggestion && publicChannel({ ...row.channel, id: suggestion.id, platform: suggestion.platform });
                change.channel = next || { ...row.channel };
            }
            row.working = true;
            refresh();
            try {
                const result = await runAction(change);
                if (state.disposed || !(result === true || result?.ok === true)) return;
                if (action === 'delete') {
                    row.deleted = true;
                    row.note = '已刪除；共用清單已更新。';
                    try {
                        const saved = await scanner.recordDecision({ ...row.channel }, 'deleted');
                        if (saved && DECISIONS[saved.decision]) row.decision = { decision: saved.decision, checkedAt: saved.checkedAt };
                    } catch (_) { /* The confirmed shared deletion remains successful. */ }
                } else row.note = '已放入編輯表單；儲存後才會修改共用清單。';
            } catch (_) { if (!state.disposed) onMessage('操作未完成；共用清單及未儲存的表單已保留，請重新整理確認。', 'error'); }
            finally { row.working = false; refresh(); }
        }

        function cancel() {
            if (state.disposed || !state.controllers.size) return;
            state.generation++;
            for (const controller of state.controllers) controller.abort();
            state.controllers.clear();
            state.running = state.loading = false;
            state.cancelled = true;
            state.rows.forEach(row => { row.working = false; });
            ui['health-progress'].textContent = '檢查已取消：' + state.rows.filter(row => row.result).length + ' / ' + state.rows.length + ' 台；已完成的結果保留。';
            refresh();
        }

        function dispose() {
            cancel();
            state.disposed = true;
            ui['health-start'].removeEventListener('click', start);
            ui['health-cancel'].removeEventListener('click', cancel);
            ui['health-filter'].removeEventListener('change', refresh);
        }

        ui['health-start'].addEventListener('click', start);
        ui['health-cancel'].addEventListener('click', cancel);
        ui['health-filter'].addEventListener('change', refresh);
        refresh();
        return Object.freeze({ refresh, cancel, dispose });
    }

    const api = { createUI };
    root.ChannelHealthUI = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
