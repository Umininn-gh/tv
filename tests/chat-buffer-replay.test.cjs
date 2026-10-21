const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { resolveChatFile } = require('./helpers/chat-paths.cjs');
const { ChatMessageStore } = require(resolveChatFile('chat-message-store.js'));

const source = fs.readFileSync(resolveChatFile('test3.html'), 'utf8');
function extract(start, end) {
    const first = source.indexOf(start), last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, 'Extract production ' + start);
    return source.slice(first, last);
}
const flushSource = extract('function flushMessageBuffer() {', '\nfunction archiveMessageBuffer()');
const metadataSource = extract('function bufferEntryMetadata(item) {', '\nfunction renderChatMessage(');
const entry = (id, timestamp = 1000) => ({ id, key: id, timestamp, login: 'reader',
    html: `<div class="chat-line" data-message-id="${id}" data-message-key="${id}" data-user-login="reader" data-msg-ts="${timestamp}">${id}</div>` });
function gate() {
    let release;
    return { promise: new Promise(resolve => { release = resolve; }), release: () => release() };
}

function createReplay() {
    const rows = [], pages = new Map(), warnings = [], acknowledgements = [], insertCalls = [], suppressed = new Set();
    const hooks = { beforeInsert: null, readPage: null, readRecord: null, deletePage: null };
    const rowFromHtml = html => {
        const attribute = name => html.match(new RegExp('data-' + name + '="([^"]*)"'))?.[1] || '';
        return { dataset: { messageId: attribute('message-id'), messageKey: attribute('message-key'),
            userLogin: attribute('user-login'), msgTs: attribute('msg-ts') },
            setAttribute(name, value) { if (name === 'data-message-key') this.dataset.messageKey = value; } };
    };
    const store = {
        async loadPage(id) {
            if (hooks.readPage) await hooks.readPage(id);
            if (!pages.has(id)) throw new Error('Stored chat page is unavailable');
            return structuredClone(pages.get(id));
        },
        async deletePage(id) {
            if (hooks.deletePage) await hooks.deletePage(id);
            acknowledgements.push({ id, displayed: rows.map(row => row.dataset.messageId) });
            pages.delete(id);
        },
        getCached() {},
        getById(id) { return hooks.readRecord ? hooks.readRecord(id) : Promise.resolve(null); },
        restoreBuffered: ChatMessageStore.prototype.restoreBuffered
    };
    const insertRows = elements => {
        for (const row of elements) {
            const next = rows.findIndex(existing => Number(existing.dataset.msgTs) > Number(row.dataset.msgTs));
            rows.splice(next < 0 ? rows.length : next, 0, row);
        }
    };
    const context = vm.createContext({
        messageBuffer: [], bufferFlushTask: null, chatMessageStore: store, chatVirtualizer: { pages: new Map() }, msgCache: {}, autoScroll: false,
        MAX_MESSAGES: 300, retentionPaused: true, showPausedRetentionStatus() {}, updateHistoryButton() {},
        document: { querySelectorAll: () => rows },
        isSuppressedChatMetadata: item => suppressed.has(item.id),
        captureChatViewport() {}, addTimestampsToElements() {}, observeChatMedia() {}, limitMessages() {}, forceScrollToBottom() {},
        insertMessageElements(elements) {
            insertCalls.push(Array.from(elements, row => row.dataset.messageId));
            if (hooks.beforeInsert) return hooks.beforeInsert(elements, insertRows);
            insertRows(elements);
        },
        safeBuildChatMessageHtml: record => record.html,
        showChatStorageWarning: error => warnings.push(error.message),
        $(html) {
            // Fixtures use plain sibling divs; production builds these strings.
            const elements = Array.from(html.matchAll(/<div\b[\s\S]*?<\/div>/g), match => rowFromHtml(match[0]));
            elements.toArray = () => Array.from(elements);
            return elements;
        }
    });
    vm.runInContext(metadataSource + '\n' + flushSource, context);
    return { context, hooks, rows, pages, warnings, acknowledgements, insertCalls, suppressed,
        ids: () => rows.map(row => row.dataset.messageId),
        flush: () => context.flushMessageBuffer(),
        regular(...entries) { context.messageBuffer.push(...entries); },
        archive(id, entries) {
            pages.set(id, { entries: structuredClone(entries) });
            const reference = { archiveId: id, count: entries.length, timestamp: entries[0].timestamp,
                items: entries.map(({ id, key, timestamp, login }) => ({ id, key, timestamp, login })) };
            context.messageBuffer.push(reference);
            return reference;
        }
    };
}

test('normal unarchived flush inserts all rows in time order and consumes the buffer', async () => {
    const replay = createReplay();
    replay.regular(entry('later', 2000), entry('earlier', 1000));
    await replay.flush();
    assert.deepEqual(replay.ids(), ['earlier', 'later']);
    assert.equal(replay.context.messageBuffer.length, 0);
    assert.equal(replay.context.bufferFlushTask, null);
    assert.deepEqual(replay.warnings, []);
});

test('a large regular buffer replays in bounded batches without dropping retained rows', async () => {
    const replay = createReplay();
    replay.regular(...Array.from({ length: 750 }, (_, i) => entry('batch-' + i, 1000 + i)));
    await replay.flush();
    assert.equal(replay.rows.length, 750);
    assert.equal(new Set(replay.ids()).size, 750);
    assert.deepEqual(replay.insertCalls.map(batch => batch.length), [300, 300, 150]);
    assert.equal(replay.context.messageBuffer.length, 0);
});

test('late older arrival during archived record hydration cannot abandon the saved batch', async () => {
    const replay = createReplay(), started = gate(), pending = gate();
    replay.archive('saved-batch', [entry('archived', 2000)]);
    replay.hooks.readRecord = async () => { started.release(); await pending.promise; return null; };
    const flushing = replay.flush();
    await started.promise;
    assert.equal(replay.pages.has('saved-batch'), true, 'Reading must not delete a page before insertion');
    assert.equal(replay.acknowledgements.length, 0);
    replay.regular(entry('late-older', 1000));
    replay.context.messageBuffer.sort((a, b) => a.timestamp - b.timestamp);
    pending.release();
    await flushing;
    assert.deepEqual(replay.ids(), ['late-older', 'archived']);
    assert.equal(replay.context.messageBuffer.length, 0);
    assert.equal(replay.pages.has('saved-batch'), false);
    assert.deepEqual(replay.acknowledgements[0], { id: 'saved-batch', displayed: ['archived'] });
    assert.deepEqual(replay.warnings, []);
});

test('failed archived insertion retains the saved page and reference for a successful retry', async () => {
    const replay = createReplay();
    replay.archive('retry-batch', [entry('retry-one'), entry('retry-two', 1001)]);
    replay.hooks.beforeInsert = () => Promise.reject(new Error('Owned insertion failure'));
    await replay.flush();
    assert.equal(replay.context.messageBuffer.length, 1);
    assert.equal(replay.pages.has('retry-batch'), true);
    assert.equal(replay.acknowledgements.length, 0);
    assert.deepEqual(replay.ids(), []);
    replay.hooks.beforeInsert = null;
    await replay.flush();
    assert.deepEqual(replay.ids(), ['retry-one', 'retry-two']);
    assert.equal(replay.context.messageBuffer.length, 0);
    assert.equal(replay.pages.has('retry-batch'), false);
    assert.deepEqual(replay.warnings, ['Owned insertion failure']);
});

test('retry after partial insertion preserves remaining rows without duplicating the first row', async () => {
    const replay = createReplay();
    replay.archive('partial-batch', [entry('partial-one'), entry('partial-two', 1001)]);
    replay.hooks.beforeInsert = (elements, insertRows) => {
        insertRows(elements.slice(0, 1));
        return Promise.reject(new Error('Owned failure after one inserted row'));
    };
    await replay.flush();
    assert.deepEqual(replay.ids(), ['partial-one']);
    assert.equal(replay.pages.has('partial-batch'), true);
    replay.hooks.beforeInsert = null;
    await replay.flush();
    assert.deepEqual(replay.ids(), ['partial-one', 'partial-two']);
    assert.deepEqual(replay.insertCalls, [['partial-one', 'partial-two'], ['partial-two']]);
    assert.equal(replay.context.messageBuffer.length, 0);
    assert.equal(replay.acknowledgements.length, 1);
});

test('moderation while record hydration awaits removes the latest deleted items before insertion', async () => {
    const replay = createReplay(), started = gate(), pending = gate();
    const reference = replay.archive('moderated-batch', [entry('deleted'), entry('retained', 1001)]);
    replay.hooks.readRecord = async () => { started.release(); await pending.promise; return null; };
    const flushing = replay.flush();
    await started.promise;
    reference.items = reference.items.filter(item => item.id !== 'deleted');
    reference.count = reference.items.length;
    replay.suppressed.add('deleted');
    pending.release();
    await flushing;
    assert.deepEqual(replay.ids(), ['retained']);
    assert.equal(replay.context.messageBuffer.length, 0);
    assert.equal(replay.pages.has('moderated-batch'), false);
});

test('a fully moderated archive removed during hydration does not resurrect any row', async () => {
    const replay = createReplay(), started = gate(), pending = gate();
    const reference = replay.archive('fully-moderated', [entry('removed')]);
    replay.hooks.readRecord = async () => { started.release(); await pending.promise; return null; };
    const flushing = replay.flush();
    await started.promise;
    replay.context.messageBuffer = replay.context.messageBuffer.filter(item => item !== reference);
    replay.pages.delete('fully-moderated');
    replay.suppressed.add('removed');
    pending.release();
    await flushing;
    assert.deepEqual(replay.ids(), []);
    assert.equal(replay.context.messageBuffer.length, 0);
    assert.deepEqual(replay.warnings, []);
});

test('moderation deleting an archive during its read cannot block the following buffered messages', async () => {
    const replay = createReplay(), started = gate(), pending = gate();
    const reference = replay.archive('deleted-during-read', [entry('removed-before-read')]);
    replay.regular(entry('following-moderation', 1001));
    replay.hooks.readPage = async id => { if (id === 'deleted-during-read') { started.release(); await pending.promise; } };
    const flushing = replay.flush();
    await started.promise;
    replay.context.messageBuffer = replay.context.messageBuffer.filter(item => item !== reference);
    replay.pages.delete('deleted-during-read');
    replay.suppressed.add('removed-before-read');
    pending.release();
    await flushing;
    assert.deepEqual(replay.ids(), ['following-moderation']);
    assert.equal(replay.context.messageBuffer.length, 0);
});

test('one unreadable saved page does not hide later independent batches or cause a retry loop', async () => {
    const replay = createReplay();
    replay.archive('temporarily-unreadable', [entry('recover-later')]);
    replay.regular(entry('regular-after-unreadable', 1001));
    replay.archive('readable-next', [entry('archived-after-unreadable', 1002)]);
    let reads = 0;
    replay.hooks.readPage = async id => {
        if (id === 'temporarily-unreadable') { reads++; throw new Error('Owned temporary page read failure'); }
    };
    await replay.flush();
    assert.deepEqual(replay.ids(), ['regular-after-unreadable', 'archived-after-unreadable']);
    assert.equal(reads, 1);
    assert.equal(replay.context.messageBuffer.length, 1);
    assert.equal(replay.context.messageBuffer[0].archiveId, 'temporarily-unreadable');
    assert.equal(replay.pages.has('temporarily-unreadable'), true);
    assert.equal(replay.pages.has('readable-next'), false);
    replay.hooks.readPage = null;
    await replay.flush();
    assert.deepEqual(replay.ids(), ['recover-later', 'regular-after-unreadable', 'archived-after-unreadable']);
    assert.equal(replay.context.messageBuffer.length, 0);
    assert.deepEqual(replay.warnings, ['Owned temporary page read failure']);
});

test('failed saved-page deletion does not block the next buffered messages or duplicate on retry', async () => {
    const replay = createReplay();
    replay.archive('delete-failure', [entry('saved-first')]);
    replay.regular(entry('regular-next', 1001));
    replay.hooks.deletePage = () => Promise.reject(new Error('Owned page deletion failure'));
    await replay.flush();
    assert.deepEqual(replay.ids(), ['saved-first', 'regular-next']);
    assert.equal(replay.context.messageBuffer.length, 0);
    assert.equal(replay.pages.has('delete-failure'), true);
    assert.deepEqual(replay.warnings, ['Owned page deletion failure']);
    await replay.flush();
    assert.deepEqual(replay.ids(), ['saved-first', 'regular-next']);
});

test('failed regular insertion retains the batch and deduplicates rows inserted before failure', async () => {
    const replay = createReplay();
    replay.regular(entry('regular-one'), entry('regular-two', 1001));
    replay.hooks.beforeInsert = (elements, insertRows) => {
        insertRows(elements.slice(0, 1));
        throw new Error('Owned regular insertion failure');
    };
    await replay.flush();
    assert.equal(replay.context.messageBuffer.length, 2);
    assert.deepEqual(replay.ids(), ['regular-one']);
    replay.hooks.beforeInsert = null;
    await replay.flush();
    assert.deepEqual(replay.ids(), ['regular-one', 'regular-two']);
    assert.equal(replay.context.messageBuffer.length, 0);
    assert.deepEqual(replay.warnings, ['Owned regular insertion failure']);
});

test('rows already in a virtualized page and repeated entries are not reinserted during retry', async () => {
    const replay = createReplay();
    replay.context.chatVirtualizer.pages.set('existing-page', { items: [{ id: 'already-archived', key: 'already-archived' }] });
    replay.archive('retry-with-duplicates', [entry('already-archived'), entry('new-row', 1001), entry('new-row', 1001)]);
    await replay.flush();
    assert.deepEqual(replay.ids(), ['new-row']);
    assert.equal(replay.context.chatVirtualizer.pages.size, 1);
    assert.equal(replay.context.messageBuffer.length, 0);
    assert.deepEqual(replay.insertCalls, [['new-row']]);
});
