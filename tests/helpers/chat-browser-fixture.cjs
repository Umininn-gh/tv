'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { resolveChatFile } = require('./chat-paths.cjs');

const channel = 'whitewing940920';
const baseTimestamp = 1792500000000;
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const row = (id, login, timestamp, body, tags = '') =>
    `@display-name=${login}${id ? ';id=' + id : ''};tmi-sent-ts=${timestamp}${tags} :${login}!${login}@${login}.tmi.twitch.tv PRIVMSG #${channel} :${body}`;

function playwrightRuntime() {
    try { return require('playwright'); }
    catch (_) { return require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
}

async function startChatBrowser() {
    // The repository's file named jquery-3.6.0.min.js is an unrelated Firebase
    // module. Use the genuine, licensed vendored jQuery without a CDN request.
    const jquery = fs.readFileSync(resolveChatFile('jquery-3.3.1.min.js'), 'utf8');
    assert.match(jquery.slice(0, 100), /jQuery v3\.3\.1/);
    const files = {
        'test3.html': 'test3.html', 'chat/': 'test3.html', 'chat/index.html': 'test3.html',
        'chat-message-format.js': 'chat-message-format.js', 'chat-message-store.js': 'chat-message-store.js',
        'chat-resource-refresh.js': 'chat-resource-refresh.js',
        'assets/js/chat-message-format.js': 'chat-message-format.js',
        'assets/js/chat-message-store.js': 'chat-message-store.js',
        'assets/js/chat-resource-refresh.js': 'chat-resource-refresh.js',
        'assets/js/site-paths.js': 'site-paths.js'
    };
    const server = http.createServer((request, response) => {
        const name = new URL(request.url, 'http://localhost').pathname.slice(1);
        if (Object.hasOwn(files, name)) {
            response.writeHead(200, { 'content-type': files[name].endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' });
            return response.end(fs.readFileSync(resolveChatFile(files[name])));
        }
        if (/\.(?:png|webp)$/.test(name)) return response.writeHead(200, { 'content-type': 'image/png' }).end(pixel);
        const json = {
            'b.txt': {}, 'audio.txt': [], 'showset.txt': { set: [] }, 'twitch.txt': { twitch: [] },
            'data/chat-badges.json': {}, 'data/audio.json': [],
            'data/emote-sets.json': { set: [] }, 'data/emotes/twitch.json': { twitch: [] }
        };
        if (Object.hasOwn(json, name)) return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(json[name]));
        response.writeHead(404).end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = `http://127.0.0.1:${server.address().port}/`;
    let browser;
    try {
        const executablePath = process.env.UMININN_BROWSER_EXECUTABLE;
        browser = await playwrightRuntime().chromium.launch({ headless: true,
            ...(executablePath ? { executablePath } : { channel: 'msedge' }) });
    } catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }

    return {
        browser, address,
        async open() {
            const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
            const page = await context.newPage();
            page.setDefaultTimeout(10000);
            const pageErrors = [], parsingErrors = [], requests = [], sentCommands = [], connections = [];
            page.on('pageerror', error => pageErrors.push(error.message));
            page.on('console', message => {
                if (message.type() === 'error' && /格式轉換失敗|處理(?:歷史)?訊息錯誤|ReferenceError|TypeError|RangeError/.test(message.text())) parsingErrors.push(message.text());
            });
            await context.route('**/*', route => {
                const request = route.request(), url = new URL(request.url());
                requests.push({ url: url.href, type: request.resourceType() });
                if (url.href.startsWith(address)) return route.continue();
                if (url.hostname === 'code.jquery.com') return route.fulfill({ contentType: 'text/javascript', body: jquery });
                if (url.hostname === 'recent-messages.robotty.de') return route.fulfill({ contentType: 'application/json', body: '{"messages":[]}' });
                if (url.hostname === 'gql.twitch.tv') return route.fulfill({ contentType: 'application/json', body: '{"data":{"badges":[],"user":{"badges":[]}}}' });
                if (url.pathname.endsWith('iconjsonp.php')) return route.fulfill({ contentType: 'application/json', body: '[]' });
                if (url.hostname === 'platform.twitter.com') return route.abort('blockedbyclient');
                if (url.hostname === 'mock-media.invalid') return route.abort('failed');
                if (request.resourceType() === 'image') return route.fulfill({ contentType: 'image/png', body: pixel });
                if (request.resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>Owned fixture: preview unavailable.</p>' });
                // Fail closed: all unrelated network activity stays in this mock.
                return route.fulfill({ contentType: 'application/json', body: '{}' });
            });
            await context.routeWebSocket('wss://irc-ws.chat.twitch.tv:443/', socket => {
                connections.push(socket);
                socket.onMessage(text => {
                    sentCommands.push(String(text));
                    if (String(text) === `JOIN #${channel}`) socket.send(`@room-id=fixture :tmi.twitch.tv ROOMSTATE #${channel}\r\n` + row('fixture-ready', 'fixture', baseTimestamp, 'Fixture connected') + '\r\n');
                });
            });
            await page.goto(address + 'test3.html');
            await page.locator('[data-message-id="fixture-ready"]').waitFor();
            await page.waitForFunction(() => chatResourcesReady && !isFetchingHistory);
            return {
                page, context, pageErrors, parsingErrors, requests, sentCommands,
                send(...lines) { assert.ok(connections.length); connections.at(-1).send(lines.join('\r\n') + '\r\n'); },
                async close() {
                    try {
                        assert.deepEqual(pageErrors, [], 'No browser runtime exceptions');
                        assert.deepEqual(parsingErrors, [], 'No parser/rendering exceptions');
                        assert.ok(!sentCommands.some(text => /\bPRIVMSG\b/.test(text)), 'The owned browser never posts chat messages');
                    } finally { await context.close(); }
                }
            };
        },
        async close() { await browser.close(); await new Promise(resolve => server.close(resolve)); }
    };
}

module.exports = { startChatBrowser, channel, baseTimestamp, row };
