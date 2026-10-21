const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { resolveChatFile } = require('./helpers/chat-paths.cjs');

const source = fs.readFileSync(resolveChatFile('test3.html'), 'utf8');
const start = source.indexOf('let historyHasLoaded = false;');
const end = source.indexOf('// ===================== 連線邏輯', start);
assert.ok(start >= 0 && end > start, 'Extract the production history implementation');
const historySource = source.slice(start, end);
const now = Date.UTC(2026, 9, 21, 12);
const channel = 'whitewing940920';
const fixture = (id, received) => ({ id, received });

function createHistory({ checkpoint = now - 10000, records = [], initial = false, clock = now, response } = {}) {
    let available = records;
    let reply = response;
    const requests = [];
    const delivered = new Map(initial || !checkpoint ? [] : [[`known-${checkpoint}`, fixture(`known-${checkpoint}`, checkpoint)]]);
    const errors = [];
    const status = { textContent: '', title: '' };
    const context = vm.createContext({
        console: { error: (...args) => errors.push(args.map(String).join(' ')), warn() {} },
        URLSearchParams, AbortController,
        Date: class extends Date { static now() { return clock; } },
        setTimeout: () => 1, clearTimeout() {},
        isFetchingHistory: false, pendingHistoryRefresh: false, pendingOlderHistory: false,
        CHANNEL: channel, CHAT_HISTORY_BATCH_SIZE: 30, MAX_MESSAGES: 300, retentionPaused: true,
        autoScroll: false, unreadResetVersion: 0, unreadWatermark: 0,
        chatConnectionWarning: '', hasJoinedChannel: true, isInitialLoad: false,
        messageBuffer: [], chatVirtualizer: null, seenMessageIds: new Set(),
        getLogicalChatCount: () => delivered.size,
        getBufferedChatCount: () => 0,
        getOldestRetainedHistoryCursor: () => delivered.size ? Math.min(...Array.from(delivered.values(), item => item.received)) : null,
        document: { getElementById(id) {
            if (id === 'historyStatus') return status;
            if (id === 'messages') return { get firstElementChild() {
                const first = Array.from(delivered.values()).sort((a, b) => a.received - b.received)[0];
                return first ? { dataset: { messageId: first.id } } : null;
            } };
            return null;
        } },
        getTagValue: (tags, key) => tags.split(';').find(tag => tag.startsWith(`${key}=`))?.slice(key.length + 1) || null,
        parseIrcLine(raw) {
            const match = raw.match(/^@([^ ]+) :([^ ]+) (\w+) ([^ ]+) :(.*)$/);
            return match ? { tags: match[1], source: match[2], command: match[3], params: [match[4]], body: match[5] } : null;
        },
        isChatEventForChannel: message => message.params[0] === `#${channel}`,
        isDisplayableChatMessage: message => message.command === 'PRIVMSG' && Boolean(message.body),
        chatMessageKey: message => message.tags.match(/(?:^|;)id=([^;]+)/)?.[1],
        hydrateReceivedChatTimestamp() {},
        renderChatMessage(message) {
            const id = message.tags.match(/(?:^|;)id=([^;]+)/)?.[1];
            const received = Number(message.tags.match(/(?:^|;)rm-received-ts=(\d+)/)?.[1]);
            if (id) delivered.set(id, fixture(id, received));
        },
        chatMessageStore: { hasKey: key => delivered.has(key), wasDelivered: async key => delivered.has(key) },
        pauseChatFollowing() {}, forceScrollToBottom() {},
        async fetch(url) {
            const query = new URL(url).searchParams;
            requests.push({ after: Number(query.get('after')) || null, before: Number(query.get('before')) || null });
            const custom = reply ? await reply(requests.length, query) : null;
            const selected = (custom?.records || available)
                .filter(item => (!query.has('after') || item.received > Number(query.get('after'))) &&
                    (!query.has('before') || item.received < Number(query.get('before'))))
                .slice(-Number(query.get('limit')));
            const code = custom?.status || 200;
            return { ok: code >= 200 && code < 300, status: code, json: async () => ({
                messages: selected.map(item => `@id=${item.id};rm-received-ts=${item.received};tmi-sent-ts=${item.received} :fixture!fixture@fixture PRIVMSG #${channel} :${item.id}`),
                error_code: custom?.error_code || null,
                error: custom?.error || null
            }) };
        }
    });
    vm.runInContext(historySource, context);
    vm.runInContext(`historyHasLoaded = ${!initial}; historyReceivedCheckpoint = ${checkpoint};`, context);
    return {
        requests, delivered, errors, status,
        fetch: older => context.fetchRecentMessages(older),
        state: () => vm.runInContext('({ checkpoint: historyReceivedCheckpoint, recovering: Boolean(historyRecovery), retry: historyRetryOlder, transient: historyServiceWarning, coverage: historyCoverageWarningText(), warningCount: historyCoverageWarnings.size, hasMore: hasMoreHistory })', context),
        setRecords(value) { available = value; }, setResponse(value) { reply = value; }
    };
}

test('provider800 cap leaves a persistent possible-gap warning after recovering the available tail', async () => {
    const checkpoint = now - 10000;
    const missed = Array.from({ length: 1001 }, (_, i) => fixture(`missed-${i}`, checkpoint + i + 1));
    const chat = createHistory({ checkpoint, records: missed.slice(-800) });
    await chat.fetch();
    assert.equal(chat.delivered.size - 1, 800);
    assert.equal(chat.state().checkpoint, missed.at(-1).received);
    assert.match(chat.state().coverage, /可能.*800則/);
    assert.match(chat.status.textContent, /部分留言可能未能補回/);
    assert.equal(chat.requests.length, 2);
    const newest = missed.at(-1);
    chat.setRecords([newest, fixture('after-cap', newest.received + 1)]);
    await chat.fetch();
    assert.equal(chat.delivered.has('after-cap'), true);
    assert.match(chat.state().coverage, /800則/);
    assert.equal(chat.state().warningCount, 1);
});

test('actual clean overlap across multiple pages recovers1001 rows without claiming a gap', async () => {
    const checkpoint = now - 10000;
    const records = [fixture(`known-${checkpoint}`, checkpoint), ...Array.from({ length: 1001 }, (_, i) => fixture(`complete-${i}`, checkpoint + i + 1))];
    const chat = createHistory({ checkpoint, records });
    await chat.fetch();
    assert.equal(chat.delivered.size, 1002);
    assert.equal(chat.requests.length, 2);
    assert.equal(chat.state().coverage, '');
    assert.equal(chat.state().recovering, false);
});

test('recent quiet empty history does not assert that any message was lost', async () => {
    const chat = createHistory();
    await chat.fetch();
    assert.equal(chat.state().coverage, '');
    assert.equal(chat.state().checkpoint, now - 10000);
});

test('expired24h checkpoint warns only of possible expiry even when the channel may have been quiet', async () => {
    const checkpoint = now - 24 * 60 * 60 * 1000 - 1;
    const chat = createHistory({ checkpoint });
    await chat.fetch();
    assert.match(chat.state().coverage, /可能.*24小時/);
    assert.doesNotMatch(chat.state().coverage, /確定|已遺失|漏了\d/);
    assert.equal(chat.state().checkpoint, checkpoint);
    chat.setRecords([fixture('new-after-expiry', now)]);
    await chat.fetch();
    assert.match(chat.state().coverage, /24小時/);
});

test('ordinary503 retry preserves checkpoint and a later clean overlap clears transient failure only', async () => {
    const checkpoint = now - 10000;
    const records = [fixture(`known-${checkpoint}`, checkpoint), fixture('after-retry', checkpoint + 1)];
    const chat = createHistory({ checkpoint, records, response: number => number === 1 ? { status: 503 } : null });
    await chat.fetch();
    assert.equal(chat.state().checkpoint, checkpoint);
    assert.equal(chat.state().recovering, true);
    assert.equal(chat.state().coverage, '');
    assert.equal(chat.errors.length, 1);
    assert.match(chat.errors[0], /503/);
    await chat.fetch();
    assert.equal(chat.delivered.has('after-retry'), true);
    assert.equal(chat.requests[0].after, chat.requests[1].after);
    assert.equal(chat.state().recovering, false);
    assert.equal(chat.state().transient, '');
    assert.equal(chat.state().coverage, '');
});

test('collector-not-joined evidence survives later successful overlap', async () => {
    const checkpoint = now - 10000;
    const records = [fixture(`known-${checkpoint}`, checkpoint), fixture('while-unavailable', checkpoint + 1)];
    const chat = createHistory({ checkpoint, records, response: () => ({ error_code: 'channel_not_joined', error: 'not joined' }) });
    await chat.fetch();
    assert.match(chat.state().coverage, /歷史服務曾未完整收錄/);
    assert.equal(chat.state().recovering, true);
    chat.setResponse(null);
    await chat.fetch();
    assert.equal(chat.state().transient, '');
    assert.equal(chat.state().recovering, false);
    assert.match(chat.status.textContent, /歷史服務曾未完整收錄/);
});

test('unavailable initial history keeps its coverage evidence after subsequent normal recovery', async () => {
    const records = Array.from({ length: 100 }, (_, i) => fixture(`unjoined-initial-${i}`, now - 100000 + i));
    const chat = createHistory({ initial: true, checkpoint: 0, records, response: () => ({ error_code: 'channel_not_joined' }) });
    await chat.fetch();
    assert.equal(chat.delivered.size, 30);
    assert.match(chat.state().coverage, /歷史服務曾未完整收錄/);
    const previousNewest = records.at(-1);
    chat.setResponse(null);
    chat.setRecords([previousNewest, fixture('joined-live', previousNewest.received + 1)]);
    await chat.fetch();
    assert.equal(chat.delivered.has('joined-live'), true);
    assert.equal(chat.state().transient, '');
    assert.match(chat.status.textContent, /歷史服務曾未完整收錄/);
});

test('short purged history without its known anchor is uncertain rather than silently complete', async () => {
    const checkpoint = now - 10000;
    const chat = createHistory({ checkpoint, records: [fixture('purged-tail', checkpoint + 1)] });
    await chat.fetch();
    assert.equal(chat.delivered.has('purged-tail'), true);
    assert.match(chat.state().coverage, /未能銜接上次紀錄/);
});

test('same-millisecond unpageable service window keeps its warning after later successful requests', async () => {
    const checkpoint = now - 10000;
    const rows = Array.from({ length: 801 }, (_, i) => fixture(`tied-${i}`, checkpoint + 1));
    const chat = createHistory({ checkpoint, records: rows });
    await chat.fetch();
    assert.equal(chat.state().retry, false);
    assert.match(chat.state().coverage, /分頁曾無法完整前進/);
    chat.setRecords([fixture(`known-${checkpoint}`, checkpoint), fixture('after-tie', checkpoint + 2)]);
    await chat.fetch();
    assert.equal(chat.delivered.has('after-tie'), true);
    assert.match(chat.state().coverage, /分頁曾無法完整前進/);
});

test('initial30 and each explicit older30 retain their existing behavior', async () => {
    const records = Array.from({ length: 100 }, (_, i) => fixture(`initial-${i}`, now - 100000 + i));
    const chat = createHistory({ initial: true, checkpoint: 0, records });
    await chat.fetch();
    assert.equal(chat.delivered.size, 30);
    assert.equal(chat.delivered.has('initial-70'), true);
    await chat.fetch(true);
    assert.equal(chat.delivered.size, 60);
    assert.equal(chat.delivered.has('initial-40'), true);
    assert.equal(chat.state().coverage, '');
    assert.equal(chat.requests.length, 1);
});

test('unknown checkpoint never invents an earlier gap', async () => {
    const chat = createHistory({ checkpoint: 0, records: [fixture('first-known', now)] });
    await chat.fetch();
    assert.equal(chat.delivered.has('first-known'), true);
    assert.equal(chat.state().coverage, '');
});
