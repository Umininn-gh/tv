'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const format = require('../chat-message-format.js');
const resources = require('../chat-resource-refresh.js');
const http = require('node:http');
function createServer() {
    const files = new Set(['test3.html', 'chat-message-format.js', 'chat-message-store.js', 'chat-resource-refresh.js']);
    return http.createServer((request, response) => {
        const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
        const filename = pathname.endsWith('/') ? 'test3.html' : path.posix.basename(pathname);
        if (!files.has(filename)) return response.writeHead(404).end();
        response.writeHead(200, { 'content-type': filename.endsWith('.js') ? 'application/javascript' : 'text/html' });
        response.end(fs.readFileSync(path.join(__dirname, '..', filename)));
    });
}

test('initial resource results merge into one batch, and audio carries no message changes', () => {
    const scheduled = [], applied = [];
    const batcher = new resources.Batcher(change => applied.push(change), callback => scheduled.push(callback));
    batcher.begin();
    for (let i = 0; i < 13; i++) batcher.queue({ emotes: ['Set' + i], picker: true });
    batcher.queue({ badges: true });
    batcher.queue({ audio: true });
    assert.equal(scheduled.length, 0);
    batcher.end();
    assert.equal(scheduled.length, 1);
    scheduled.shift()();
    assert.equal(applied.length, 1);
    assert.equal(applied[0].emotes.size, 13);
    assert.equal(applied[0].badges, true);
    batcher.queue({ audio: true });
    scheduled.shift()();
    assert.equal(applied[1].emotes.size, 0);
    assert.equal(applied[1].badges, false);
    assert.equal(applied[1].audio, true);
});

test('ordinary words share one safe run, while links and protected tokens remain outside', () => {
    const ordinary = Array.from({ length: 100 }, (_, i) => 'word' + i).join(' ');
    const options = { renderTextRun: text => resources.textRunHtml(text, format.escapeHtml, word => word.includes('__PROTECTED_')) };
    const html = format.renderContent(ordinary + ' https://example.test/ __PROTECTED_1__Attached <img>', options);
    assert.equal((html.match(/data-chat-text/g) || []).length, 2);
    assert.ok(html.includes(`<span data-chat-text>${ordinary} </span><a `));
    assert.ok(html.includes('__PROTECTED_1__Attached<span data-chat-text> &lt;img&gt;</span>'));
    assert.ok(!html.includes('<img>'));
});

test('actual chat startup updates only resource nodes and reconciles buffered/disk HTML', { timeout: 30000 }, async () => {
    let playwright;
    try { playwright = require('playwright'); }
    catch (_) {
        playwright = require(path.join(require('node:os').homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright'));
    }
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const launch = { headless: true };
    if (process.env.CHAT_TEST_BROWSER_PATH) launch.executablePath = process.env.CHAT_TEST_BROWSER_PATH;
    else launch.channel = 'msedge';
    let browser;
    try {
        browser = await playwright.chromium.launch(launch);
        const page = await browser.newPage({ viewport: { width: 600, height: 700 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.hostname === '127.0.0.1') return route.continue();
            if (url.hostname === 'code.jquery.com') return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(__dirname, '..', 'jquery-3.3.1.min.js')) });
            if (route.request().resourceType() === 'image') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"/>' });
            if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: '<p>Embedded preview fixture</p>' });
            return route.abort();
        });
        await page.addInitScript(() => {
            window.__requests = [];
            window.fetch = url => new Promise(resolve => window.__requests.push({ url: String(url), done: false, resolve: data => resolve({ ok: true, json: async () => data }) }));
            window.__finish = (part, data) => {
                const request = window.__requests.find(request => !request.done && request.url.includes(part));
                if (!request) throw new Error('Missing controlled request: ' + part);
                request.done = true;
                request.resolve(data);
            };
            class Socket {
                static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
                constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0); }
                send() {}
                close() { this.readyState = 3; }
            }
            window.WebSocket = Socket;
            window.__hidden = false;
            Object.defineProperty(document, 'hidden', { get: () => window.__hidden });
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/chat/`);
        await page.waitForFunction(() => window.__requests.length >= 5);
        await page.evaluate(() => {
            window.__applies = [];
            const apply = chatResourceRefresh.apply;
            chatResourceRefresh.apply = change => { __applies.push({ emotes: change.emotes.size, badges: change.badges, audio: change.audio }); apply(change); };
            window.__fullRefreshes = 0;
            const full = refreshVisibleMessages;
            refreshVisibleMessages = (...args) => { if (!args[0]) __fullRefreshes++; return full(...args); };
            altMap.known = 'https://media.test/known.png';
            customBadges['moderator/1'] = 'https://media.test/mod.png';
            myBadges = 'subscriber/1,moderator/1';
            updateBadgeCarousel();
            window.__message = (id, body, extra = '') => ({ command: 'PRIVMSG', source: 'sklate!test', params: ['#whitewing940920'],
                tags: `id=${id};display-name=sklate;tmi-sent-ts=${1000000000000 + Number(id.replace(/\D/g, '') || 0)};badges=subscriber/1,moderator/1${extra}`, body });
            for (let i = 1; i <= 35; i++) renderChatMessage(__message('row' + i, 'ordinary text ' + i), true);
            renderChatMessage(__message('parent40', 'quote sklate'), true);
            renderChatMessage(__message('resource41', 'hello sklate known [s]https://media.test/original.png[e] [y]https://media.test/original.mp4[t] [y]https://youtu.be/abc12345[t] [a]https://media.test/audio.mp3[o]'), true);
            renderChatMessage(__message('native42', 'sklate', ';emotes=25:0-5'), true);
            renderChatMessage(__message('reply43', 'reply sklate', ';reply-parent-display-name=sklate;reply-parent-msg-id=parent40;reply-parent-msg-body=quote\\ssklate'), true);
            // A local echo has no IRC record to rebuild from when flushed/restored.
            window.__oldHtml = id => `<div class="chat-line" data-message-id="${id}" data-user-login="sklate" data-msg-ts="1000000000090" data-resource-version="${chatResourceVersion}"><b>${renderBadges('subscriber/1,moderator/1')}sklate:</b><span>${parseContent('old sklate')}</span></div>`;
            window.__diskHtml = __oldHtml('disk90');
            __hidden = true;
            appendMessageWithScroll(__oldHtml('buffer91'), 'buffer91');
            __hidden = false;
        });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.evaluate(() => {
            pauseChatFollowing();
            const chat = document.getElementById('chat-container');
            chat.scrollTop = 180;
            readingAnchor = captureChatViewport();
            const row = document.querySelector('[data-message-id="resource41"]');
            window.__nodes = { row, ordinary: document.querySelector('[data-message-id="row1"]'), video: row.querySelector('video'), iframe: row.querySelector('iframe'), image: row.querySelector('img.media-preview'),
                known: row.querySelector('[data-chat-emote="known"] img'), audio: row.querySelector('.wa-audio-player'), moderator: row.querySelector('[data-chat-badge="moderator/1"]'),
                native: document.querySelector('[data-message-id="native42"] img.alt-emoji'), quote: document.querySelector('[data-message-id="reply43"] .quote-box'),
                anchor: readingAnchor.row, anchorOffset: readingAnchor.offset };
            renderEmojiPanel('BTTV');
            document.getElementById('emojiPanel').style.display = 'flex';
            window.__draftInput = document.getElementById('bttvUrl');
            __draftInput.value = 'https://draft.test/pending.gif';
            __draftInput.focus();
            __draftInput.setSelectionRange(8, 13);
            __fullRefreshes = 0;
            __finish('showset.txt', { set: Array.from({ length: 13 }, (_, i) => ({ name: 'set' + i, image: '' })) });
            __finish('b.txt', { 'subscriber/1': 'https://media.test/sub.png', 'moderator/1': 'https://media.test/mod.png' });
            __finish('gql.twitch.tv', [{ data: {} }]);
            __finish('iconjsonp.php', []);
            __finish('audio.txt', [{ name: 'fixture', url: 'https://media.test/sound.mp3' }]);
        });
        await page.waitForFunction(() => __requests.filter(request => request.url.includes('skchat_icon.php')).length === 13);
        for (let i = 0; i < 12; i++) {
            await page.evaluate(i => __finish('set=set' + i, { ['set' + i]: [{ alt: i === 0 ? 'skfirst' : 'unused' + i, src: 'https://media.test/set' + i + '.png' }] }), i);
        }
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        assert.equal(await page.evaluate(() => __applies.length), 0, 'partial initial results remain batched');
        assert.equal(await page.evaluate(() => document.querySelectorAll('[data-message-id="resource41"] [data-chat-emote="sklate"]').length), 0);
        await page.evaluate(() => renderChatMessage(__message('new60', 'skfirst'), true));
        assert.equal(await page.evaluate(() => document.querySelectorAll('[data-message-id="new60"] [data-chat-emote="skfirst"]').length), 1, 'new rows use a set immediately, before the initial batch ends');
        await page.evaluate(() => __finish('set=set12', { set12: [{ alt: 'sklate', src: 'https://media.test/late.png' }] }));
        await page.waitForFunction(() => __applies.length === 1);
        const initial = await page.evaluate(() => {
            const row = document.querySelector('[data-message-id="resource41"]');
            const chat = document.getElementById('chat-container');
            return { applies: __applies, fullRefreshes: __fullRefreshes,
                preserved: __nodes.row === row && __nodes.ordinary === document.querySelector('[data-message-id="row1"]') && __nodes.video === row.querySelector('video') && __nodes.iframe === row.querySelector('iframe') &&
                    __nodes.image === row.querySelector('img.media-preview') && __nodes.known === row.querySelector('[data-chat-emote="known"] img') && __nodes.audio === row.querySelector('.wa-audio-player') &&
                    __nodes.moderator === row.querySelector('[data-chat-badge="moderator/1"]') && __nodes.native === document.querySelector('[data-message-id="native42"] img.alt-emoji') && __nodes.quote === document.querySelector('[data-message-id="reply43"] .quote-box'),
                anchorDifference: __nodes.anchor.getBoundingClientRect().top - chat.getBoundingClientRect().top - __nodes.anchorOffset,
                lateEmote: row.querySelectorAll('[data-chat-emote="sklate"]').length,
                quoteEmote: document.querySelectorAll('[data-message-id="reply43"] .quote-box [data-chat-emote="sklate"]').length,
                username: row.querySelector('b').textContent,
                quoteName: document.querySelector('[data-message-id="reply43"] .quote-user').textContent,
                subscriber: row.querySelector('[data-chat-badge="subscriber/1"]')?.getAttribute('src'),
                carousel: document.querySelector('#chat-badge-carousel [data-chat-badge="subscriber/1"]')?.getAttribute('src'),
                draft: { same: __draftInput === document.getElementById('bttvUrl'), value: __draftInput.value, focused: document.activeElement === __draftInput,
                    selection: [__draftInput.selectionStart, __draftInput.selectionEnd] },
                limit: MAX_MESSAGES, batch: CHAT_HISTORY_BATCH_SIZE, paused: retentionPaused };
        });
        assert.equal(initial.preserved, true);
        assert.equal(initial.fullRefreshes, 0);
        assert.equal(initial.applies.length, 1);
        assert.equal(initial.lateEmote, 1);
        assert.equal(initial.quoteEmote, 1);
        assert.equal(initial.username, 'sklate:');
        assert.equal(initial.quoteName, '@sklate:');
        assert.equal(initial.subscriber, 'https://media.test/sub.png');
        assert.equal(initial.carousel, initial.subscriber);
        assert.deepEqual(initial.draft, { same: true, value: 'https://draft.test/pending.gif', focused: true, selection: [8, 13] });
        assert.ok(Math.abs(initial.anchorDifference) < 2, JSON.stringify(initial));
        assert.equal(initial.limit, 300);
        assert.equal(initial.batch, 30);
        assert.equal(initial.paused, true);

        const restored = await page.evaluate(async () => {
            await flushMessageBuffer();
            const placeholder = document.createElement('div');
            placeholder.dataset.archivePage = 'resource-page';
            placeholder.dataset.msgTs = placeholder.dataset.lastMsgTs = '1000000000090';
            const metadata = { id: 'disk90', key: 'disk90', timestamp: 1000000000090, receivedTs: 1000000000090, login: 'sklate' };
            document.getElementById('messages').append(placeholder);
            chatVirtualizer.pages.set('resource-page', { element: placeholder, items: [metadata] });
            await chatMessageStore.savePage({ id: 'resource-page', entries: [{ html: __diskHtml, metadata, height: 40 }] });
            await chatVirtualizer.restorePage('resource-page');
            return ['buffer91', 'disk90'].map(id => {
                const row = document.querySelector(`[data-message-id="${id}"]`);
                return { emote: row.querySelectorAll('[data-chat-emote="sklate"]').length, badge: row.querySelector('[data-chat-badge="subscriber/1"]')?.getAttribute('src') };
            });
        });
        for (const row of restored) assert.deepEqual(row, { emote: 1, badge: 'https://media.test/sub.png' });

        await page.evaluate(() => {
            renderEmojiPanel('音訊');
            window.__audioName = document.getElementById('audioName');
            window.__audioUrl = document.getElementById('audioUrl');
            __audioName.value = 'unsaved sound';
            __audioUrl.value = 'https://draft.test/pending.mp3';
            __audioUrl.focus();
            __audioUrl.setSelectionRange(4, 9);
            window.__mutations = [];
            window.__mutationObserver = new MutationObserver(changes => __mutations.push(...changes));
            __mutationObserver.observe(document.getElementById('messages'), { subtree: true, childList: true, attributes: true, characterData: true });
            window.__audioLoad = loadAudioData();
            __finish('audio.txt', [{ name: 'updated fixture', url: 'https://media.test/another.mp3' }]);
        });
        await page.evaluate(() => __audioLoad);
        await page.waitForFunction(() => __applies.length === 2);
        assert.deepEqual(await page.evaluate(() => ({ mutations: __mutations.length, change: __applies.at(-1), full: __fullRefreshes })),
            { mutations: 0, change: { emotes: 0, badges: false, audio: true }, full: 0 });
        assert.deepEqual(await page.evaluate(() => ({ same: __audioName === document.getElementById('audioName') && __audioUrl === document.getElementById('audioUrl'),
            name: __audioName.value, url: __audioUrl.value, focused: document.activeElement === __audioUrl, selection: [__audioUrl.selectionStart, __audioUrl.selectionEnd] })),
            { same: true, name: 'unsaved sound', url: 'https://draft.test/pending.mp3', focused: true, selection: [4, 9] });
        await page.evaluate(() => __mutationObserver.disconnect());
        const changed = await page.evaluate(async () => {
            altMap.known = 'https://media.test/known-v2.png';
            refreshChatResources({ emotes: ['known'] });
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const row = document.querySelector('[data-message-id="resource41"]');
            return { same: __nodes.known === row.querySelector('[data-chat-emote="known"] img'), url: __nodes.known.getAttribute('src'),
                other: __nodes.video === row.querySelector('video') && __nodes.iframe === row.querySelector('iframe') && __nodes.image === row.querySelector('img.media-preview') };
        });
        assert.deepEqual(changed, { same: true, url: 'https://media.test/known-v2.png', other: true });
        assert.deepEqual(errors, []);
    } finally {
        await browser?.close();
        await new Promise(resolve => server.close(resolve));
    }
});
