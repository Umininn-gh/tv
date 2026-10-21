const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolveChatFile } = require('./helpers/chat-paths.cjs');
const format = require(resolveChatFile('chat-message-format.js'));

function renderer(extra = {}) {
    const images = [], audio = [], trusted = new Map();
    const options = {
        altMap: Object.assign(Object.create(null), { '[lol]': './local.png', kappa: 'https://example.test/kappa.png' }),
        renderImage(url, settings) {
            images.push({ url, ...settings });
            return `<img data-native="${settings.nativeGif ? 'gif' : ''}" src="${format.escapeHtml(url)}" alt="${format.escapeHtml(settings.label || '')}">`;
        },
        renderAudio(url) { audio.push(url); return `<audio src="${format.escapeHtml(url)}"></audio>`; },
        protectHtml(html) { const key = `__TRUSTED_${trusted.size}__`; trusted.set(key, html); return key; },
        restoreHtml(html) { for (const [key, value] of trusted) html = html.split(key).join(value); return html; },
        ...extra
    };
    return { options, images, audio, trusted, render(input) { return format.renderContent(input, options); } };
}

test('prototype names stay text; only own string emotes render, including relative assets', () => {
    const context = renderer({ altMap: { kappa: './kappa.png', toString: () => 'bad' } });
    const html = context.render('constructor __proto__ toString kappa');
    assert.match(html, /^constructor __proto__ toString /);
    assert.equal(context.images.length, 1);
    assert.equal(context.images[0].url, './kappa.png');
    assert.equal(format.ownEmote({ bad: 'javascript:alert(1)' }, 'bad'), null);
});

test('host classifiers reject name substrings, credentials and lookalike suffixes', () => {
    for (const url of ['https://example.test/twitter-logo.png', 'https://youtube.com.evil.test/watch?v=abc12345', 'https://twitter.com@evil.test/status/123', 'https://notsteamcommunity.test/app/123', 'https://example.test/threads.com/@name/post/id']) {
        assert.ok(['link', 'image'].includes(format.classifyMediaUrl(url).kind), url);
    }
    assert.equal(format.classifyMediaUrl('https://m.youtube.com/watch?v=abc12345&t=1h2m3s').start, 3723);
    assert.equal(format.classifyMediaUrl('https://youtu.be/abc12345?t=90').kind, 'youtube');
    assert.equal(format.classifyMediaUrl('https://mobile.x.com/name/status/123?foo=bar').canonicalUrl, 'https://twitter.com/name/status/123?foo=bar');
    assert.equal(format.classifyMediaUrl('https://www.threads.net/@name/post/abc123').kind, 'threads');
    assert.equal(format.classifyMediaUrl('https://store.steampowered.com/app/123/title/').id, '123');
    assert.equal(format.classifyMediaUrl('https://example.test/a.MP4?token=abc').kind, 'video');
});

test('all legacy media delimiters, bare URL tags, static tokens and ordinary links survive', () => {
    const context = renderer();
    const html = context.render('[S]https://img.test/a.pngE] [s]https://img.test/b.png[e] [s]https://img.test/c.pnge] [s]https://img.test/d.png [y]https://youtu.be/abc12345[t] [y]https://vid.test/a.mp4t] [y]https://vid.test/b.mp4 [a]https://audio.test/a.mp3[o] [lol] https://ordinary.test/');
    assert.deepEqual(context.images.map(item => item.url), ['https://img.test/a.png', 'https://img.test/b.png', 'https://img.test/c.png', 'https://img.test/d.png', './local.png']);
    assert.deepEqual(context.audio, ['https://audio.test/a.mp3']);
    assert.match(html, /youtube.com\/embed\/abc12345/);
    assert.equal((html.match(/<video /g) || []).length, 2);
    assert.match(html, /href="https:\/\/ordinary.test\/"/);
    context.render('[Y]https://vid.test/c.mp4[T] [A]https://audio.test/b.mp3[O]');
    assert.deepEqual(context.audio, ['https://audio.test/a.mp3', 'https://audio.test/b.mp3']);
});

test('IPv6, square-bracket paths and signed queries are not stripped or rewritten', () => {
    const context = renderer();
    for (const url of ['https://[2001:db8::1]/a.png', 'https://[2001:db8::e]/a.png', 'https://img.test/path[version]/a.png?sig=a%2Fb&x=1', 'https://img.test/path[cache]/a.png']) {
        context.render(`[s]${url}[e]`);
        context.render(`[s]${url}`);
        assert.equal(context.images.at(-1)?.url, url);
        assert.equal(context.images.at(-2)?.url, url);
    }
});

test('raw and preescaped messages cannot introduce markup, scripts or unsafe URL protocols', () => {
    for (const escapedInput of [false, true]) {
        const context = renderer({ escapedInput });
        const raw = '<img src=x onerror="alert(1)"> & &#60;script&#62; [s]javascript:alert(1)[e]';
        const html = context.render(escapedInput ? format.escapeHtml(raw) : raw);
        assert.equal(context.images.length, 0);
        assert.ok(!html.includes('<img'));
        assert.ok(!html.includes('<script'));
        assert.match(html, /&lt;img/);
        assert.match(html, /&amp;#60;script/);
    }
    const context = renderer();
    const html = context.render('[y]https://vid.test/a.mp4?x="onerror=bad[t]');
    assert.ok(!html.includes('x="onerror'));
    assert.match(html, /x=&quot;onerror/);
});

test('trusted native/quote tokens survive once-escaped text without reinterpreting source HTML', () => {
    const context = renderer({ escapedInput: true });
    const token = context.options.protectHtml('<div class="quote-box">trusted</div>');
    const html = context.render(format.escapeHtml(`<b>raw</b> ${token}`));
    assert.match(html, /^&lt;b&gt;raw&lt;\/b&gt; /);
    assert.match(html, /<div class="quote-box">trusted<\/div>/);
});

test('native ranges use Unicode code points and handle adjacent/punctuated emotes', () => {
    const context = renderer();
    const result = format.prepareNativeBody('😀 Kappa!中文Keepo', 'emotes=25:2-6/1902:10-14', context.options);
    const html = context.render(result.text);
    assert.equal(context.images.length, 2);
    assert.deepEqual(context.images.map(item => item.label), ['Kappa', 'Keepo']);
    assert.match(html, /^😀 <img/);
    assert.match(html, /!中文<img/);
});

test('/me strips only its wrapper and applies visible-body ranges', () => {
    const context = renderer();
    const result = format.prepareNativeBody('\x01ACTION Kappa waved\x01', 'emotes=25:0-4', context.options);
    assert.equal(result.action, true);
    const html = context.render(result.text);
    assert.ok(!html.includes('ACTION'));
    assert.ok(!html.includes('\x01'));
    assert.match(html, /<img .* waved$/);
    assert.equal(format.prepareNativeBody('ACTION normal', '', context.options).action, false);
});

test('native GIFs preserve the full URL and ask image renderer to bypass URL normalization', () => {
    const context = renderer();
    const gif = 'https://media.test/path.gifv?sig=a%2Fb&cid=ABC&x=1,2';
    const raw = '[GIF] hello [GIF]';
    const result = format.prepareNativeBody(raw, `gifs=0-4|id|${gif},12-16|id2|https://media.test/b.gif?foo=bar`, context.options);
    const html = context.render(result.text);
    assert.equal(context.images[0].url, gif);
    assert.equal(context.images[0].preserveUrl, true);
    assert.equal(context.images[0].nativeGif, true);
    assert.equal(context.images.length, 2);
    assert.match(html, /sig=a%2Fb&amp;cid=ABC&amp;x=1,2/);
    assert.match(html, / hello /);
    const escapedTagUrl = 'https://media.test/a.gif?token=one\\:two&literal=back\\\\slash';
    const tagResult = format.prepareNativeBody('[GIF]', `gifs=0-4|id|${escapedTagUrl}`, context.options);
    assert.equal(context.images.at(-1).url, 'https://media.test/a.gif?token=one;two&literal=back\\slash');
    assert.ok(context.render(tagResult.text).includes('token=one;two&amp;literal=back\\slash'));
});

test('invalid tags, unsafe GIFs, out-of-bounds ranges and overlaps preserve unclaimed text', () => {
    const context = renderer();
    const result = format.prepareNativeBody('Kappa rest', 'emotes=25:0-4,2-8,50-90,9-1/bad"id:6-9;gifs=0-4|gif|javascript:alert(1)', context.options);
    const html = context.render(result.text);
    assert.equal(context.images.length, 1);
    assert.match(html, / rest$/);
    const untouched = format.prepareNativeBody('<bad> text', 'emotes=25:-1-4;gifs=0-2|gif|data:image/svg+xml,evil', context.options);
    assert.equal(untouched.text, '<bad> text');
    assert.equal(context.render(untouched.text), '&lt;bad&gt; text');
});

test('GIFs win an identical emote range and malformed URL text never becomes native HTML', () => {
    const context = renderer();
    format.prepareNativeBody('Kappa', 'emotes=25:0-4;gifs=0-4|gif|https://media.test/a.gif', context.options);
    assert.equal(context.images.length, 1);
    assert.equal(context.images[0].nativeGif, true);
    const invalid = format.prepareNativeBody('hello', 'gifs=0-4|gif|https://media.test/\nmalformed', context.options);
    assert.equal(invalid.text, 'hello');
});

test('overlapping GIF/emote ranges preserve prefix and suffix outside the chosen GIF', () => {
    const context = renderer();
    const result = format.prepareNativeBody('a GIF z', 'emotes=25:0-4;gifs=2-4|gif|https://media.test/a.gif', context.options);
    assert.equal(context.images.length, 1);
    assert.equal(context.images[0].nativeGif, true);
    assert.equal(context.images[0].label, 'GIF');
    assert.match(context.render(result.text), /^a <img .* z$/);
});

test('explicit media terminators preserve literal legacy terminators inside URL paths and signed queries', () => {
    const context = renderer();
    for (const [tag, end, url] of [
        ['s', 'e', 'https://img.test/a.png?name=some]thing&sig=a%2Fb'],
        ['s', 'e', 'https://img.test/route]preview/a.png'],
        ['S', 'E', 'https://img.test/a.png?name=somE]thing'],
        ['s', 'e', 'https://[2001:db8::e]/path[cache]/a.png?note=some]thing']
    ]) {
        const html = context.render(`[${tag}]${url}[${end}] trailing words`);
        assert.equal(context.images.at(-1).url, url);
        assert.match(html, / trailing words$/);
        assert.ok(!html.endsWith(`[${end}] trailing words`));
    }
    const video = 'https://vid.test/clip.mp4?comment=part]two&token=a%2Fb';
    const html = context.render(`[y]${video}[t] after video`);
    assert.ok(html.includes(`src="${format.escapeHtml(video)}"`));
    assert.match(html, / after video$/);
});

test('legacy terminators still stop before another media tag or trailing literal bracketed text', () => {
    const context = renderer();
    const html = context.render('[s]https://img.test/first.pnge] text [e] [s]https://img.test/second.png?note=some]thing[e]');
    assert.deepEqual(context.images.map(item => item.url), [
        'https://img.test/first.png', 'https://img.test/second.png?note=some]thing'
    ]);
    assert.match(html, / text \[e\] /);
    context.render('[s]https://[2001:db8::e]/first.pnge][s]https://img.test/next.png[e]');
    assert.deepEqual(context.images.slice(-2).map(item => item.url), [
        'https://[2001:db8::e]/first.png', 'https://img.test/next.png'
    ]);
    const mixed = context.render('[y]https://vid.test/first.mp4t] [y]https://vid.test/second.mp4?note=part]two[t]');
    assert.equal((mixed.match(/<video /g) || []).length, 2);
    assert.ok(mixed.includes('src="https://vid.test/first.mp4"'));
    assert.ok(mixed.includes('src="https://vid.test/second.mp4?note=part]two"'));
});

test('tagged X previews always retain a visible original URL when the widget cannot load', () => {
    const url = 'https://mobile.x.com/example/status/123456789?token=a%2Fb&view=full#details';
    const html = renderer().render(`[y]${url}[t]`);
    assert.match(html, /data-embed-kind="twitter"/);
    assert.ok(html.includes(`<div class="chat-media-origin">原連結：<a href="${format.escapeHtml(url)}"`));
    assert.ok(html.includes(`>${format.escapeHtml(url)}</a></div>`));
    assert.match(html, /若預覽無法顯示，可開啟原帖。/);
    // The page owns one widget loader; per-message scripts would be inert when
    // appended through a parsed HTML fragment, or cause duplicate executions.
    assert.ok(!html.includes('<script'));
    // The fallback lives outside the replaceable widget markup and is neither
    // hidden nor dependent on script execution to provide message content.
    assert.ok(html.indexOf('chat-media-origin') > html.indexOf('</blockquote></div>'));
    assert.ok(!html.match(/class="chat-media-origin"[^>]*hidden/));
    assert.match(renderer().render(url), new RegExp(`^<a href=`));
});

test('native video embeds preserve signed source links and expose controlled failure and retry hooks', () => {
    for (const extension of ['mp4', 'm3u8', 'flv']) {
        const url = `https://vid.test/path.${extension}?token=a%2Fb&expires=123#part`;
        const html = renderer().render(`[y]${url}[t]`);
        assert.match(html, /data-embed-kind="video"/);
        assert.ok(html.includes(`src="${format.escapeHtml(url)}"`));
        assert.ok(html.includes(`>${format.escapeHtml(url)}</a>`));
        assert.match(html, /部分格式可能不受瀏覽器支援/);
        assert.match(html, /onerror="onChatVideoError\(this\)"/);
        assert.match(html, /onloadeddata="onChatVideoLoaded\(this\)"/);
        assert.match(html, /class="chat-media-retry" hidden onclick="retryChatVideo\(this,event\)"/);
    }
});

test('cross-origin iframe previews keep original links even if the frame loads an error page', () => {
    for (const [kind, url] of [
        ['youtube', 'https://youtu.be/abc12345?t=90&sig=a%2Fb'],
        ['threads', 'https://www.threads.net/@name/post/abc123?token=a%2Fb&x=1'],
        ['steam', 'https://store.steampowered.com/app/123/title/?token=a%2Fb&x=1'],
        ['facebook', 'https://www.facebook.com/watch/?v=123&token=a%2Fb']
    ]) {
        const html = renderer().render(`[y]${url}[t]`);
        assert.ok(html.includes(`data-embed-kind="${kind}"`));
        assert.match(html, /<iframe /);
        assert.match(html, /onerror="onChatEmbedError\(this\)"/);
        assert.ok(html.includes(`>${format.escapeHtml(url)}</a>`));
        assert.match(html, /若預覽無法顯示，可開啟原連結。/);
    }
});

test('media fallback links escape URL markup and reject unsafe source protocols', () => {
    const url = 'https://vid.test/clip.mp4?text="onerror=bad&next=<tag>';
    const html = renderer().render(`[y]${url}[t]`);
    assert.ok(html.includes(`>${format.escapeHtml(url)}</a>`));
    assert.ok(!html.includes('next=<tag>'));
    assert.ok(!html.includes('href="https://vid.test/clip.mp4?text="onerror'));
    const invalid = renderer().render('[y]javascript:alert(1)[t]');
    assert.ok(!invalid.includes('chat-media-origin'));
    assert.ok(!invalid.includes('<iframe'));
    assert.ok(!invalid.includes('<video'));
});
