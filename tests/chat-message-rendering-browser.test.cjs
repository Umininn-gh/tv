'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startChatBrowser, channel, baseTimestamp, row } = require('./helpers/chat-browser-fixture.cjs');
const enabled = process.env.UMININN_BROWSER_TESTS === '1';
let fixture;
test.before(async () => { if (enabled) fixture = await startChatBrowser(); });
test.after(async () => { if (fixture) await fixture.close(); });

function browserTest(name, action) {
    test(name, { skip: !enabled }, async () => {
        const chat = await fixture.open();
        try { await action(chat); }
        finally { await chat.close(); }
    });
}

browserTest('different no-ID messages in the same millisecond survive cache and resource rerender', async chat => {
    const { page } = chat;
    const time = baseTimestamp + 1000;
    chat.send(row('', 'alice', time, 'First no-ID message'), row('', 'bob', time, 'Second no-ID message'),
        row('', 'alice', time, 'Third no-ID message'));
    await page.waitForFunction(() => document.querySelectorAll('[data-user-login="alice"]').length === 2);
    const before = await page.locator('[data-user-login="alice"], [data-user-login="bob"]').evaluateAll(rows => rows.map(row => ({ id: row.dataset.messageId, text: row.textContent })));
    assert.equal(new Set(before.map(row => row.id)).size, 3);
    await page.evaluate(() => refreshVisibleMessages());
    const after = await page.locator('[data-user-login="alice"], [data-user-login="bob"]').evaluateAll(rows => rows.map(row => ({ id: row.dataset.messageId, text: row.textContent })));
    assert.deepEqual(after, before);
    assert.equal(after.filter(row => row.text.includes('First no-ID message')).length, 1);
    assert.equal(after.filter(row => row.text.includes('Second no-ID message')).length, 1);
    assert.equal(after.filter(row => row.text.includes('Third no-ID message')).length, 1);
});

browserTest('untagged messages received at identical Date.now keep distinct stable identities after structured clone', async chat => {
    const result = await chat.page.evaluate(({ channel, time }) => {
        const originalNow = Date.now;
        Date.now = () => time;
        try {
            const messages = ['First untagged message', 'Second untagged message'].map(body => parseIrcLine(`:untagged!untagged@untagged.tmi.twitch.tv PRIVMSG #${channel} :${body}`));
            messages.forEach(message => renderChatMessage(message));
            const before = [...document.querySelectorAll('[data-user-login="untagged"]')].map(row => ({ id: row.dataset.messageId, text: row.textContent }));
            const cloneIds = messages.map(message => chatMessageIdentity(structuredClone(message)));
            refreshVisibleMessages();
            const after = [...document.querySelectorAll('[data-user-login="untagged"]')].map(row => ({ id: row.dataset.messageId, text: row.textContent }));
            return { before, after, cloneIds };
        } finally { Date.now = originalNow; }
    }, { channel, time: baseTimestamp + 2000 });
    assert.equal(result.before.length, 2);
    assert.equal(new Set(result.before.map(row => row.id)).size, 2);
    assert.deepEqual(result.cloneIds, result.before.map(row => row.id));
    assert.deepEqual(result.after, result.before);
});

browserTest('bodyless gift and raid USERNOTICE events render escaped system text', async chat => {
    chat.send(
        `@id=gift-notice;msg-id=subgift;display-name=Gifter;login=gifter;system-msg=Gifter\\sgave\\sa\\ssub\\s<img\\ssrc=x\\sonerror=alert(1)>;tmi-sent-ts=${baseTimestamp + 3000} :tmi.twitch.tv USERNOTICE #${channel}`,
        `@id=raid-notice;msg-id=raid;display-name=Raider;login=raider;system-msg=Raider\\sis\\sraiding\\swith\\s42\\sviewers;tmi-sent-ts=${baseTimestamp + 3001} :tmi.twitch.tv USERNOTICE #${channel}`
    );
    const gift = chat.page.locator('[data-message-id="gift-notice"]');
    const raid = chat.page.locator('[data-message-id="raid-notice"]');
    await raid.waitFor();
    assert.match(await gift.innerText(), /Gifter gave a sub <img src=x onerror=alert\(1\)>/);
    assert.equal(await gift.locator(':scope > span:last-child img, :scope > span:last-child script').count(), 0);
    assert.match(await raid.innerText(), /Raider is raiding with 42 viewers/);
});

browserTest('a blocked Twitter widget retains the visible original URL without an empty tall preview', async chat => {
    const url = 'https://x.com/fixture/status/123456789?token=a%2Fb&view=full#details';
    chat.send(row('blocked-tweet', 'social', baseTimestamp + 4000, `[y]${url}[t]`));
    const wrapper = chat.page.locator('[data-message-id="blocked-tweet"] .chat-media-embed');
    await wrapper.waitFor();
    await chat.page.waitForFunction(() => document.querySelector('[data-message-id="blocked-tweet"] .chat-media-embed')?.dataset.embedState === 'failed');
    const origin = wrapper.locator('.chat-media-origin a');
    assert.equal(await origin.getAttribute('href'), url);
    assert.equal(await origin.innerText(), url);
    assert.equal(await origin.isVisible(), true);
    await chat.page.waitForFunction(() => {
        const wrapper = document.querySelector('[data-message-id="blocked-tweet"] .chat-media-embed');
        return wrapper && wrapper.getBoundingClientRect().height < 200;
    });
    assert.match(await wrapper.innerText(), /原(?:連結|網址|帖)/);
    assert.equal(chat.requests.filter(request => new URL(request.url).hostname === 'platform.twitter.com').length, 1, 'One owned loader request, no per-message script retries');
});

browserTest('Twitter script success without a rendered iframe does not claim the post loaded', async chat => {
    const url = 'https://x.com/fixture/status/987654321?token=a%2Fb';
    chat.send(row('unavailable-tweet', 'social', baseTimestamp + 4500, `[y]${url}[t]`));
    const wrapper = chat.page.locator('[data-message-id="unavailable-tweet"] .chat-media-embed');
    await wrapper.waitFor();
    await chat.page.waitForFunction(() => document.querySelector('[data-message-id="unavailable-tweet"] .chat-media-embed')?.dataset.embedState === 'failed');
    await chat.page.evaluate(() => {
        window.twttr = { widgets: { load: () => Promise.resolve() } };
        onChatTwitterScriptLoaded();
    });
    await chat.page.waitForFunction(() => document.querySelector('[data-message-id="unavailable-tweet"] .chat-media-embed')?.dataset.embedState === 'unavailable');
    assert.equal(await wrapper.locator('.twitter-tweet-container').isVisible(), false);
    assert.match(await wrapper.locator('.chat-media-status').innerText(), /暫未顯示/);
    assert.equal(await wrapper.locator('.chat-media-origin a').isVisible(), true);
    await chat.page.evaluate(() => {
        window.twttr.widgets.load = async wrapper => {
            const iframe = document.createElement('iframe');
            iframe.title = 'Owned widget fixture';
            iframe.src = 'about:blank';
            wrapper.querySelector('.twitter-tweet-container').append(iframe);
        };
        onChatTwitterScriptLoaded();
    });
    await chat.page.waitForFunction(() => document.querySelector('[data-message-id="unavailable-tweet"] .chat-media-embed')?.dataset.embedState === 'loaded');
    assert.equal(await wrapper.locator('.twitter-tweet-container').isVisible(), true);
    await chat.page.evaluate(() => onChatTwitterScriptError());
    assert.equal(await wrapper.getAttribute('data-embed-state'), 'loaded');
    assert.equal(await wrapper.locator('.chat-media-origin a').getAttribute('href'), url);
});

browserTest('video error and manual retry preserve the complete signed URL and loaded state', async chat => {
    const url = 'https://mock-media.invalid/clip.flv?token=a%2Fb&expires=123#part';
    chat.send(row('failed-video', 'videoauthor', baseTimestamp + 5000, `[y]${url}[t]`));
    const wrapper = chat.page.locator('[data-message-id="failed-video"] .chat-media-embed');
    await chat.page.waitForFunction(() => document.querySelector('[data-message-id="failed-video"] .chat-media-embed')?.dataset.embedState === 'failed');
    assert.match(await wrapper.locator('.chat-media-status').innerText(), /未能播放/);
    assert.equal(await wrapper.locator('.chat-media-origin a').getAttribute('href'), url);
    assert.equal(await wrapper.locator('.chat-media-origin a').isVisible(), true);
    const retry = wrapper.locator('.chat-media-retry');
    assert.equal(await retry.isVisible(), true);
    // Replace only the browser media transport, so this tests the real retry UI
    // without a codec/network dependency or a third-party video request.
    await wrapper.locator('video').evaluate(video => { video.load = () => { video.dataset.retryCalls = String(Number(video.dataset.retryCalls || 0) + 1); }; });
    await retry.click();
    assert.equal(await wrapper.getAttribute('data-embed-state'), 'loading');
    assert.equal(await wrapper.locator('video').getAttribute('src'), url);
    assert.equal(await wrapper.locator('video').getAttribute('data-retry-calls'), '1');
    await wrapper.locator('video').dispatchEvent('loadeddata');
    assert.equal(await wrapper.getAttribute('data-embed-state'), 'loaded');
    assert.equal(await wrapper.locator('video').isVisible(), true);
    assert.equal(await retry.isVisible(), false);
    assert.equal(await wrapper.locator('.chat-media-origin a').getAttribute('href'), url);
});

browserTest('cross-origin iframe failures keep the original link and replace the broken preview', async chat => {
    const url = 'https://youtu.be/abc12345?t=90&token=a%2Fb';
    chat.send(row('failed-frame', 'frameauthor', baseTimestamp + 6000, `[y]${url}[t]`));
    const wrapper = chat.page.locator('[data-message-id="failed-frame"] .chat-media-embed');
    await wrapper.locator('iframe').waitFor();
    await wrapper.locator('iframe').dispatchEvent('error');
    assert.equal(await wrapper.getAttribute('data-embed-state'), 'failed');
    assert.equal(await wrapper.locator('iframe').isVisible(), false);
    assert.match(await wrapper.locator('.chat-media-status').innerText(), /未能載入/);
    assert.equal(await wrapper.locator('.chat-media-origin a').getAttribute('href'), url);
    assert.equal(await wrapper.locator('.chat-media-origin a').isVisible(), true);
});

browserTest('missing legacy quotes explain absent context and backfill when the parent arrives', async chat => {
    const time = baseTimestamp + 7000;
    chat.send(row('missing-parent-reply', 'child', time + 1, `[r]lateparent,${time}[m] Reply stays readable`));
    const reply = chat.page.locator('[data-message-id="missing-parent-reply"]');
    await reply.waitFor();
    assert.match(await reply.innerText(), /原留言暫未取得/);
    assert.match(await reply.innerText(), /Reply stays readable/);
    chat.send(row('late-parent', 'lateparent', time, 'Late parent recovered'));
    await chat.page.waitForFunction(() => document.querySelector('[data-message-id="missing-parent-reply"] .quote-box')?.textContent.includes('Late parent recovered'));
    assert.ok(!(await reply.innerText()).includes('原留言暫未取得'));
    assert.match(await reply.innerText(), /Reply stays readable/);
    assert.equal(await chat.page.locator('[data-message-id="missing-parent-reply"]').count(), 1);
});
