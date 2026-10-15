const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
let playwright;
try { playwright = require('playwright'); }
catch (_) {
    playwright = require(path.join(require('node:os').homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright'));
}
const { chromium } = playwright;
const helper = fs.readFileSync(path.join(__dirname, '..', 'chat-message-store.js'));
const server = http.createServer((req, res) => {
    if (req.url === '/chat-message-store.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(helper);
    res.writeHead(200, { 'content-type': 'text/html' }).end('<style>body{margin:0}#pane{width:600px;height:400px;overflow:auto;overflow-anchor:none}#messages{padding:0}.chat-line{height:60px;box-sizing:border-box;margin:0 0 4px}</style><div id="pane"><div id="messages"></div></div><script src="/chat-message-store.js"></script>');
});
async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const results = {};
    try {
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        results.boundedCacheAndDiskLookup = await page.evaluate(async () => {
            window.store = new ChatMessageStore({ databaseName: 'owned-chat-memory-test-' + Date.now(), maxCachedRecords: 120, maxUserNames: 50 });
            await store.ready;
            window.record = (id, timestamp, login = 'user-' + id) => ({ id, content: 'Message ' + id, user: { login, displayName: login }, displayName: login, timestamp, receivedTs: timestamp + 500000,
                ircMessage: { tags: 'id=' + id + ';tmi-sent-ts=' + timestamp + ';rm-received-ts=' + (timestamp + 500000), source: login + '!test', command: 'PRIVMSG', params: ['#owned'], body: 'Message ' + id } });
            for (let i = 0; i < 500; i++) store.remember(record('cache-' + i, i + 1000));
            await store.pending;
            return { ...store.statistics(), first: (await store.getById('cache-0'))?.content, last: store.cache['cache-499']?.content };
        });
        assert.equal(results.boundedCacheAndDiskLookup.cachedRecords, 120);
        assert.equal(results.boundedCacheAndDiskLookup.userNames, 50);
        assert.equal(results.boundedCacheAndDiskLookup.first, 'Message cache-0');
        assert.equal(results.boundedCacheAndDiskLookup.last, 'Message cache-499');

        results.deliveryLedgerOutlivesRawRetention = await page.evaluate(async () => {
            for (let i = 0; i < 5000; i++) store.rememberDelivery('delivered-' + i);
            store.remember(record('ledger-raw-row', 8000), { key: 'ledger-raw-row' });
            store.rememberDelivery('ledger-raw-row');
            await store.forget(['ledger-raw-row']);
            await store.pending;
            const earlyAbsentFromMemory = !store.recentlyDelivered('delivered-0');
            const earlyFoundOnDisk = await store.wasDelivered('delivered-0');
            const rawGone = await store.getById('ledger-raw-row') === null;
            const deliveryKept = await store.wasDelivered('ledger-raw-row');
            const unknown = await store.wasDelivered('never-delivered');
            const diskEntry = await new Promise((resolve, reject) => {
                const request = store.db.transaction('deliveries').objectStore('deliveries').get(store.session + ':delivered-0');
                request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
            });
            const cap = store.statistics().deliveredKeys;
            await store.clear();
            return { earlyAbsentFromMemory, earlyFoundOnDisk, rawGone, deliveryKept, unknown, cap,
                minimalFields: Object.keys(diskEntry).sort(), afterClear: await store.wasDelivered('delivered-0'), clearedKeys: store.statistics().deliveredKeys };
        });
        assert.deepEqual(results.deliveryLedgerOutlivesRawRetention, { earlyAbsentFromMemory: true, earlyFoundOnDisk: true,
            rawGone: true, deliveryKept: true, unknown: false, cap: 2000, minimalFields: ['id', 'key', 'session'], afterClear: false, clearedKeys: 0 });

        results.exactAndAmbiguousReferences = await page.evaluate(async () => {
            store.remember(record('same-alice', 9001, 'alice'));
            store.remember(record('same-bob', 9001, 'bob'));
            const alice = await store.getByReference('alice', 9001);
            const bob = await store.getByReference('bob', 9001);
            store.remember(record('same-alice-two', 9001, 'alice'));
            store.cache.__proto__ = record('__proto__', 9010, 'constructor');
            const countBeforeEviction = store.referenceCount('alice', 9001);
            for (let i = 0; i < 150; i++) store.remember(record('reference-evict-' + i, 9200 + i));
            return { alice: alice?.id, bob: bob?.id, ambiguous: await store.getByReference('alice', 9001), proto: (await store.getById('__proto__'))?.id,
                countBeforeEviction, countAfterEviction: store.referenceCount('alice', 9001) };
        });
        assert.deepEqual(results.exactAndAmbiguousReferences, { alice: 'same-alice', bob: 'same-bob', ambiguous: null, proto: '__proto__', countBeforeEviction: 2, countAfterEviction: 2 });

        results.pausedArchive = await page.evaluate(async () => {
            await store.clear();
            window.paused = true;
            window.pane = document.getElementById('pane');
            window.messages = document.getElementById('messages');
            window.rowHtml = record => '<div class="chat-line" data-message-id="' + record.id + '" data-message-key="' + record.id + '" data-user-login="' + record.user.login + '" data-msg-ts="' + record.timestamp + '" data-received-ts="' + record.receivedTs + '">' + record.content + '</div>';
            const fragment = document.createDocumentFragment();
            for (let i = 0; i < 1800; i++) {
                const message = record('row-' + i, 100000 + i * 10, 'reader-' + (i % 4));
                store.remember(message, { key: message.id });
                const template = document.createElement('template'); template.innerHTML = rowHtml(message); fragment.append(template.content.firstElementChild);
            }
            messages.append(fragment);
            pane.scrollTop = 700 * 64;
            const capture = () => {
                const top = pane.getBoundingClientRect().top;
                const first = [...messages.querySelectorAll('.chat-line')].find(row => row.getBoundingClientRect().bottom >= top);
                return { id: first?.dataset.messageId, offset: first ? first.getBoundingClientRect().top - top : 0, scrollTop: pane.scrollTop };
            };
            const restore = state => {
                const anchor = [...messages.querySelectorAll('.chat-line')].find(row => row.dataset.messageId === state?.id);
                if (anchor) pane.scrollTop += anchor.getBoundingClientRect().top - pane.getBoundingClientRect().top - state.offset;
                else if (state) pane.scrollTop = state.scrollTop;
            };
            window.capture = capture;
            window.virtualizer = store.createVirtualizer({ messages, container: pane, isPaused: () => paused, keepRecent: 300, pageSize: 50,
                getRecord: id => store.getCached(id), rememberRecord: (value, metadata) => store.remember(value, { key: metadata.key }),
                renderRecord: (value, entry) => value ? rowHtml({ ...value, content: value.content + ' restored' }) : entry.html,
                captureViewport: capture, restoreViewport: restore, onError: error => { window.virtualError = error.message; } });
            const before = capture(), heightBefore = pane.scrollHeight;
            await store.pending; await virtualizer.run();
            return { before, after: capture(), heightBefore, heightAfter: pane.scrollHeight, stats: virtualizer.statistics(), error: window.virtualError || null };
        });
        assert.equal(results.pausedArchive.stats.logicalRows, 1800);
        assert.ok(results.pausedArchive.stats.liveRows <= 450, JSON.stringify(results.pausedArchive));
        assert.ok(results.pausedArchive.stats.archivedRows >= 1300);
        assert.equal(results.pausedArchive.after.id, results.pausedArchive.before.id);
        assert.ok(Math.abs(results.pausedArchive.after.offset - results.pausedArchive.before.offset) < 1);
        assert.ok(Math.abs(results.pausedArchive.heightAfter - results.pausedArchive.heightBefore) < 1);
        assert.equal(results.pausedArchive.error, null);

        results.archivedCursorAndFirstItemModeration = await page.evaluate(async () => {
            const first = messages.firstElementChild;
            const before = { archived: !!first.dataset.archivePage, id: first.dataset.firstMessageId,
                receivedTs: Number(first.dataset.receivedTs), sentTs: Number(first.dataset.msgTs) };
            const removed = await virtualizer.removeWhere(item => item.id === 'row-0');
            const next = messages.firstElementChild;
            const after = { archived: !!next.dataset.archivePage, id: next.dataset.firstMessageId,
                receivedTs: Number(next.dataset.receivedTs), sentTs: Number(next.dataset.msgTs) };
            // Put the first row back so subsequent count-based tests retain their fixture.
            const firstRecord = record('row-0', 100000, 'reader-0'); store.remember(firstRecord, { key: firstRecord.id });
            const template = document.createElement('template'); template.innerHTML = rowHtml(firstRecord);
            await virtualizer.insertElements([template.content.firstElementChild]);
            return { before, after, removed: removed.length };
        });
        assert.deepEqual(results.archivedCursorAndFirstItemModeration, { before: { archived: true, id: 'row-0', receivedTs: 600000, sentTs: 100000 },
            after: { archived: true, id: 'row-1', receivedTs: 600010, sentTs: 100010 }, removed: 1 });

        results.restoreAndSortedInsert = await page.evaluate(async () => {
            const restored = await virtualizer.materializeForId('row-20');
            const restoredText = document.querySelector('[data-message-id="row-20"]')?.textContent;
            const archived = [...virtualizer.pages.values()].find(page => page.items.some(item => item.id === 'row-1010'));
            const message = record('out-of-order', 110105, 'late-user'); store.remember(message, { key: message.id });
            const template = document.createElement('template'); template.innerHTML = rowHtml(message);
            await virtualizer.insertElements([template.content.firstElementChild]);
            const row = document.querySelector('[data-message-id="out-of-order"]');
            return { restored, restoredText, wasArchived: !!archived, previous: row.previousElementSibling.dataset.messageId, next: row.nextElementSibling.dataset.messageId, count: virtualizer.logicalCount() };
        });
        assert.equal(results.restoreAndSortedInsert.restored, true);
        assert.ok(results.restoreAndSortedInsert.restoredText.startsWith('Message row-20'));
        assert.equal(results.restoreAndSortedInsert.wasArchived, true);
        assert.equal(results.restoreAndSortedInsert.previous, 'row-1010');
        assert.equal(results.restoreAndSortedInsert.next, 'row-1011');
        assert.equal(results.restoreAndSortedInsert.count, 1801);

        results.moderationAndTrim = await page.evaluate(async () => {
            await virtualizer.run();
            const one = await virtualizer.removeWhere(item => item.id === 'row-100');
            const allByUser = await virtualizer.removeWhere(item => item.login === 'reader-3');
            const afterModeration = virtualizer.logicalCount();
            const beforeTrim = virtualizer.statistics();
            paused = false;
            const removed = virtualizer.trimToLatest(300);
            await store.pending;
            return { one: one.length, allByUser: allByUser.length, afterModeration, beforeTrim, removed: removed.length, stats: virtualizer.statistics(), first: messages.firstElementChild.dataset.messageId, deleted: await store.getById('row-100') };
        });
        assert.equal(results.moderationAndTrim.one, 1);
        assert.equal(results.moderationAndTrim.allByUser, 450);
        assert.equal(results.moderationAndTrim.afterModeration, 1350);
        assert.equal(results.moderationAndTrim.stats.logicalRows, 300);
        assert.equal(results.moderationAndTrim.stats.archivedRows, 0);
        assert.equal(results.moderationAndTrim.stats.recordMetadata, 300);
        assert.equal(results.moderationAndTrim.deleted, null);

        results.backgroundSpool = await page.evaluate(async () => {
            const references = [];
            for (let chunk = 0; chunk < 20; chunk++) references.push(await store.archiveBuffered(Array.from({ length: 100 }, (_, i) => ({
                key: 'background-' + (chunk * 100 + i), timestamp: 200000 + chunk * 100 + i,
                html: '<div data-message-id="background-' + (chunk * 100 + i) + '" data-user-login="background-user">Message</div>'
            }))));
            const referenceBytes = JSON.stringify(references).length;
            const restored = [];
            for (const reference of references) restored.push(...await store.restoreBuffered(reference));
            return { refs: references.length, referenceBytes, restored: restored.length, unique: new Set(restored.map(entry => entry.key)).size,
                first: restored[0].key, last: restored.at(-1).key };
        });
        assert.equal(results.backgroundSpool.restored, 2000);
        assert.equal(results.backgroundSpool.unique, 2000);
        assert.equal(results.backgroundSpool.first, 'background-0');
        assert.equal(results.backgroundSpool.last, 'background-1999');

        results.diskFailurePreservesRows = await page.evaluate(async () => {
            virtualizer.disconnect();
            messages.innerHTML = '';
            for (let i = 0; i < 500; i++) messages.insertAdjacentHTML('beforeend', rowHtml(record('failure-' + i, 300000 + i)));
            pane.scrollTop = 0; paused = true;
            const original = store.savePage;
            store.savePage = () => Promise.reject(new Error('Owned quota failure'));
            const failing = store.createVirtualizer({ messages, container: pane, isPaused: () => true, keepRecent: 300, pageSize: 50 });
            let error;
            try { await failing.run(); } catch (problem) { error = problem.message; }
            failing.disconnect(); store.savePage = original;
            return { count: failing.logicalCount(), actual: messages.querySelectorAll('.chat-line').length, error };
        });
        assert.equal(results.diskFailurePreservesRows.count, 500);
        assert.equal(results.diskFailurePreservesRows.actual, 500);
        assert.equal(results.diskFailurePreservesRows.error, 'Owned quota failure');

        results.concurrentArchiveArrow = await page.evaluate(async () => {
            messages.innerHTML = '';
            for (let i = 0; i < 700; i++) messages.insertAdjacentHTML('beforeend', rowHtml(record('race-' + i, 400000 + i)));
            pane.scrollTop = 0; paused = true;
            let started, release;
            const gate = new Promise(resolve => { release = resolve; });
            const pending = new Promise(resolve => { started = resolve; });
            const original = store.savePage.bind(store);
            let first = true;
            store.savePage = async value => { if (first) { first = false; started(); await gate; } return original(value); };
            const racing = store.createVirtualizer({ messages, container: pane, isPaused: () => paused, keepRecent: 300, pageSize: 50 });
            const running = racing.run();
            await pending;
            paused = false;
            const removed = racing.trimToLatest(300);
            release(); await running; await store.pending;
            store.savePage = original; racing.disconnect();
            return { removed: removed.length, count: racing.logicalCount(), pages: racing.pages.size, first: messages.firstElementChild.dataset.messageId,
                last: messages.lastElementChild.dataset.messageId };
        });
        assert.deepEqual(results.concurrentArchiveArrow, { removed: 400, count: 300, pages: 0, first: 'race-400', last: 'race-699' });

        results.concurrentArchiveInsert = await page.evaluate(async () => {
            messages.innerHTML = '';
            for (let i = 0; i < 700; i++) messages.insertAdjacentHTML('beforeend', rowHtml(record('insert-race-' + i, 500000 + i * 10)));
            pane.scrollTop = 0; paused = true;
            let started, release;
            const gate = new Promise(resolve => { release = resolve; });
            const pending = new Promise(resolve => { started = resolve; });
            const original = store.savePage.bind(store);
            let first = true;
            store.savePage = async value => { if (first) { first = false; started(); await gate; } return original(value); };
            const racing = store.createVirtualizer({ messages, container: pane, isPaused: () => paused, keepRecent: 300, pageSize: 50 });
            const running = racing.run(); await pending;
            const template = document.createElement('template'); template.innerHTML = rowHtml(record('insert-during-write', 500505));
            const inserting = racing.insertElements([template.content.firstElementChild]);
            release(); await running; await inserting;
            store.savePage = original; racing.disconnect();
            const row = document.querySelector('[data-message-id="insert-during-write"]');
            window.__lastVirtualizer = racing;
            return { count: racing.logicalCount(), previous: row.previousElementSibling.dataset.messageId, next: row.nextElementSibling.dataset.messageId };
        });
        assert.deepEqual(results.concurrentArchiveInsert, { count: 701, previous: 'insert-race-50', next: 'insert-race-51' });

        results.readFailureKeepsNewRowsAndLaterSorts = await page.evaluate(async () => {
            const virtual = window.__lastVirtualizer;
            const [pageId, page] = [...virtual.pages][0], candidate = page.items[Math.floor(page.items.length / 2)];
            const load = store.loadPage.bind(store);
            let failed = false, warning = false;
            virtual.options.onError = () => { warning = true; };
            store.loadPage = async id => { if (id === pageId && !failed) { failed = true; throw new Error('Owned transient storage read failure'); } return load(id); };
            const message = record('read-failure-new-row', candidate.timestamp + 5);
            store.remember(message, { key: message.id });
            const template = document.createElement('template'); template.innerHTML = rowHtml(message);
            await virtual.insertElements([template.content.firstElementChild]);
            const visibleDuringFailure = !!document.querySelector('[data-message-id="read-failure-new-row"]');
            await virtual.materializeForId(candidate.id);
            const metadata = [...messages.children].flatMap(child => child.dataset.archivePage ? virtual.pages.get(child.dataset.archivePage).items : [virtual.metadataFor(child)]);
            store.loadPage = load;
            return { warning, visibleDuringFailure, count: virtual.logicalCount(), unique: new Set(metadata.map(item => item.id)).size,
                sorted: metadata.every((item, index) => !index || metadata[index - 1].timestamp <= item.timestamp) };
        });
        assert.deepEqual(results.readFailureKeepsNewRowsAndLaterSorts, { warning: true, visibleDuringFailure: true, count: 702, unique: 702, sorted: true });

        results.activeOldTabSurvivesCleanup = await page.evaluate(async () => {
            const databaseName = 'owned-chat-session-cleanup-' + Date.now();
            const active = new ChatMessageStore({ databaseName, session: 'active-old-tab' }); await active.ready;
            active.remember(record('active-old-row', 1)); await active.pending;
            active.rememberDelivery('active-old-delivery'); await active.pending;
            await active.transaction('sessions', 'readwrite', objectStore => objectStore.put({ id: active.session, updatedAt: 1, closed: false }));
            const newer = new ChatMessageStore({ databaseName, session: 'newer-tab' }); await newer.ready; await newer.expireOldSessions();
            active.memory.clear();
            const preserved = (await active.getById('active-old-row'))?.id;
            active.deliveries.clear();
            const activeDeliveryPreserved = await active.wasDelivered('active-old-delivery');
            active.close();
            await active.transaction('sessions', 'readwrite', objectStore => objectStore.put({ id: active.session, updatedAt: 1, closed: true }));
            await newer.expireOldSessions();
            active.memory.clear();
            const removed = await active.getById('active-old-row');
            active.deliveries.clear();
            const closedDeliveryRemoved = !await active.wasDelivered('active-old-delivery');
            newer.close();
            return { locks: !!navigator.locks, preserved, removed, activeDeliveryPreserved, closedDeliveryRemoved };
        });
        assert.equal(results.activeOldTabSurvivesCleanup.preserved, 'active-old-row');
        assert.equal(results.activeOldTabSurvivesCleanup.removed, null);
        assert.equal(results.activeOldTabSurvivesCleanup.activeDeliveryPreserved, true);
        assert.equal(results.activeOldTabSurvivesCleanup.closedDeliveryRemoved, true);
        assert.deepEqual(errors, []);
        fs.mkdirSync(path.join(__dirname, '..', 'work'), { recursive: true });
        fs.writeFileSync(path.join(__dirname, '..', 'work', 'chat-message-store-test-results.json'), JSON.stringify(results, null, 2));
        console.log(JSON.stringify({ passed: Object.keys(results).length, results }, null, 2));
    } finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
