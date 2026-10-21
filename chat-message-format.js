(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ChatMessageFormat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    const decodeHtml = value => String(value ?? '').replace(/&(?:amp|quot|#39|lt|gt);/g, entity =>
        ({ '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' })[entity]);
    const unescapeTag = value => String(value ?? '').replace(/\\([s:nr\\])/g, (_, char) =>
        ({ s: ' ', ':': ';', n: '\n', r: '\r', '\\': '\\' })[char]);

    function getTag(tags, name) {
        if (tags && typeof tags === 'object') {
            return Object.prototype.hasOwnProperty.call(tags, name) ? String(tags[name] ?? '') : '';
        }
        for (const entry of String(tags ?? '').split(';')) {
            const index = entry.indexOf('=');
            if (index >= 0 && entry.slice(0, index) === name) return unescapeTag(entry.slice(index + 1));
        }
        return '';
    }

    // Return the original string, rather than URL.href: signed GIF URLs must stay intact.
    function safeUrl(value, allowRelative = false) {
        if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f]/.test(value)) return null;
        if (!allowRelative && !/^https?:\/\//i.test(value)) return null;
        try {
            const parsed = new URL(value, 'https://chat.invalid/');
            return ['https:', 'http:'].includes(parsed.protocol) ? value : null;
        } catch (_) { return null; }
    }

    function ownEmote(map, word) {
        const key = String(word ?? '').toLowerCase();
        if (!map || !Object.prototype.hasOwnProperty.call(map, key)) return null;
        return safeUrl(map[key], true);
    }

    function isHost(host, domain) { return host === domain || host.endsWith(`.${domain}`); }
    function parseStartTime(value) {
        if (!value) return 0;
        if (/^\d+(?:s)?$/i.test(value)) return Number.parseInt(value, 10);
        const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(value);
        return match ? (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) : 0;
    }

    function classifyMediaUrl(value) {
        const original = typeof value === 'string' ? value.trim() : '';
        if (!safeUrl(original)) return { kind: 'invalid', url: original };
        const parsed = new URL(original);
        const host = parsed.hostname.toLowerCase();
        const path = parsed.pathname;
        const result = { kind: 'link', url: original };
        if (/\.(?:jpe?g|png|gifv?|webp|avif|bmp|svg|ico)$/i.test(path)) return { ...result, kind: 'image' };
        if (/\.(?:webm|mp4|m3u8|flv|mov|m4v|ogv)$/i.test(path)) return { ...result, kind: 'video' };
        if (isHost(host, 'youtu.be') || isHost(host, 'youtube.com') || isHost(host, 'youtube-nocookie.com')) {
            const parts = path.split('/').filter(Boolean);
            const id = isHost(host, 'youtu.be') ? parts[0] :
                path === '/watch' ? parsed.searchParams.get('v') :
                ['embed', 'shorts', 'live'].includes(parts[0]) ? parts[1] : null;
            if (id && /^[A-Za-z0-9_-]{6,64}$/.test(id)) {
                return { ...result, kind: 'youtube', id,
                    start: parseStartTime(parsed.searchParams.get('t') || parsed.searchParams.get('start') || '') };
            }
            return result;
        }
        if ((isHost(host, 'twitter.com') || isHost(host, 'x.com')) && /\/(?:status|statuses)\/\d+(?:\/|$)/.test(path)) {
            return { ...result, kind: 'twitter', canonicalUrl: `https://twitter.com${path}${parsed.search}${parsed.hash}` };
        }
        if ((isHost(host, 'threads.com') || isHost(host, 'threads.net')) && /^\/@[\w.]+\/post\/[\w-]+\/?$/.test(path)) {
            return { ...result, kind: 'threads', path: path.replace(/\/$/, '') };
        }
        if (isHost(host, 'steampowered.com') || isHost(host, 'steamcommunity.com')) {
            const app = /\/app\/(\d+)(?:\/|$)/.exec(path);
            if (app) return { ...result, kind: 'steam', id: app[1] };
        }
        if (isHost(host, 'facebook.com') || isHost(host, 'fb.watch')) return { ...result, kind: 'facebook' };
        return result;
    }

    function linkHtml(value) {
        const escaped = escapeHtml(value);
        return `<a href="${escaped}" target="_blank" rel="noopener noreferrer" style="color:#58a6ff;">${escaped}</a>`;
    }

    function embeddedMediaHtml(media, kind, preview, status, controls = '') {
        // Keep this outside the third-party widget: it must remain readable when
        // a script is blocked, an iframe refuses to embed, or a codec is absent.
        return `<div class="chat-media-embed" data-embed-kind="${kind}" data-embed-state="loading">${preview}<div class="chat-media-status" role="status">${status}</div>${controls}<div class="chat-media-origin">原連結：${linkHtml(media.url)}</div></div>`;
    }

    function mediaHtml(value, type, options) {
        const media = classifyMediaUrl(value);
        if (media.kind === 'invalid') return escapeHtml(value);
        const escaped = escapeHtml(media.url);
        const renderImage = options.renderImage || ((url, settings) => `<img src="${escapeHtml(url)}" alt="${escapeHtml(settings.label || '圖片')}">`);
        if (type === 'S') return renderImage(media.url, { emote: false });
        if (type === 'a') return options.renderAudio ? options.renderAudio(media.url) : linkHtml(media.url);
        if (media.kind === 'youtube') {
            return embeddedMediaHtml(media, 'youtube', `<iframe class="media-preview" title="YouTube 影片預覽" src="https://www.youtube.com/embed/${media.id}?start=${media.start}" frameborder="0" allowfullscreen onload="onMediaLoaded()" onerror="onChatEmbedError(this)" loading="lazy"></iframe>`, '若預覽無法顯示，可開啟原連結。');
        }
        if (media.kind === 'twitter') {
            return embeddedMediaHtml(media, 'twitter', `<div class="twitter-tweet-container" style="max-height:400px; overflow:hidden;"><blockquote class="twitter-tweet"><a href="${escapeHtml(media.canonicalUrl)}"></a></blockquote></div>`, '若預覽無法顯示，可開啟原帖。');
        }
        if (media.kind === 'threads') {
            return embeddedMediaHtml(media, 'threads', `<iframe title="Threads 帖子預覽" src="https://www.threads.com${media.path}/embed" allowtransparency="true" allowfullscreen frameborder="0" height="300" style="background:#FFF;border-radius:12px;width:100%" onload="onMediaLoaded()" onerror="onChatEmbedError(this)" loading="lazy"></iframe>`, '若預覽無法顯示，可開啟原連結。');
        }
        if (media.kind === 'video') {
            return embeddedMediaHtml(media, 'video', `<video controls class="media-preview" autoplay loop muted playsinline src="${escaped}" onloadeddata="onChatVideoLoaded(this)" onerror="onChatVideoError(this)"></video>`, '若影片無法播放，可開啟原連結；部分格式可能不受瀏覽器支援。', '<button type="button" class="chat-media-retry" hidden onclick="retryChatVideo(this,event)">重試</button>');
        }
        if (media.kind === 'steam') return embeddedMediaHtml(media, 'steam', `<iframe class="media-preview" title="Steam 遊戲預覽" src="https://store.steampowered.com/widget/${media.id}" frameborder="0" onload="onMediaLoaded()" onerror="onChatEmbedError(this)" loading="lazy"></iframe>`, '若預覽無法顯示，可開啟原連結。');
        if (media.kind === 'facebook' && type === 'y') {
            return embeddedMediaHtml(media, 'facebook', `<iframe title="Facebook 影片預覽" src="https://www.facebook.com/plugins/video.php?href=${escapeHtml(encodeURIComponent(media.url))}&amp;show_text=0&amp;width=300" width="300" height="200" style="border:none;overflow:hidden" scrolling="no" frameborder="0" allowfullscreen onload="onMediaLoaded()" onerror="onChatEmbedError(this)" loading="lazy"></iframe>`, '若預覽無法顯示，可開啟原連結。');
        }
        return type === 's' || media.kind === 'image' ? renderImage(media.url, { emote: false }) : linkHtml(media.url);
    }

    function renderPlain(text, options) {
        return text.split(/(\s+)/).map(word => {
            if (!word || /^\s+$/.test(word)) return escapeHtml(word);
            const src = ownEmote(options.altMap, word);
            if (src && options.renderImage) return options.renderImage(src, { emote: true, label: word });
            if (/^https?:\/\//i.test(word) && safeUrl(word)) return linkHtml(word);
            return escapeHtml(word);
        }).join('');
    }

    function renderContent(input, options = {}) {
        // processRTag provides escaped text plus opaque trusted tokens, never raw HTML.
        const source = options.escapedInput ? decodeHtml(input) : String(input ?? '');
        const prefix = /\[(S|s|y|Y|a|A)\]/g;
        let cursor = 0, output = '', match;
        while ((match = prefix.exec(source))) {
            const type = /[yYaA]/.test(match[1]) ? match[1].toLowerCase() : match[1];
            const start = prefix.lastIndex;
            const remainder = source.slice(start);
            const closing = type === 'a' ? /\[o\]/ig : type === 'S' ? /\[?E\]/g : type === 's' ? /\[?e\]/g : /\[?t\]/ig;
            const explicitClosing = type === 'a' ? /\[o\]/i : type === 'S' ? /\[E\]/ : type === 's' ? /\[e\]/ : /\[t\]/i;
            const explicitEnd = explicitClosing.exec(remainder);
            const nextPrefix = /\[(?:S|s|y|Y|a|A)\]/.exec(remainder);
            let end;
            while ((end = closing.exec(remainder))) {
                // A legacy e]/t] terminator is not the closing bracket of an IPv6 host or URL path.
                const before = remainder.slice(0, end.index);
                if (!end[0].startsWith('[') && before.lastIndexOf('[') > before.lastIndexOf(']')) continue;
                break;
            }
            // An unescaped e]/t] can occur inside a valid URL query or path.
            // Prefer the unambiguous bracketed terminator for this media tag,
            // without borrowing a terminator from the next tag or swallowing
            // ordinary text after an already complete legacy media URL.
            if (explicitEnd && (!nextPrefix || explicitEnd.index < nextPrefix.index) &&
                safeUrl(remainder.slice(0, explicitEnd.index).replace(/[\r\n]/g, '').trim())) end = explicitEnd;
            let value, after;
            if (end && (!nextPrefix || end.index < nextPrefix.index)) {
                value = remainder.slice(0, end.index).replace(/[\r\n]/g, '').trim();
                after = start + end.index + end[0].length;
            } else if (type !== 'a') {
                const bare = /^\s*(https?:\/\/[^\s]+)/i.exec(remainder);
                if (!bare) continue;
                value = bare[1];
                const adjacentTag = /\[(?:S|s|y|Y|a|A|r|R)\]/.exec(value);
                if (adjacentTag) value = value.slice(0, adjacentTag.index);
                after = start + bare[0].indexOf(bare[1]) + value.length;
            } else continue;
            output += renderPlain(source.slice(cursor, match.index), options);
            output += mediaHtml(value, type, options);
            cursor = after;
            prefix.lastIndex = after;
        }
        output += renderPlain(source.slice(cursor), options);
        return options.restoreHtml ? options.restoreHtml(output) : output;
    }

    function prepareNativeBody(rawBody, tags, options = {}) {
        let text = String(rawBody ?? '');
        const action = text.startsWith('\u0001ACTION ');
        if (action) {
            text = text.slice(8);
            if (text.endsWith('\u0001')) text = text.slice(0, -1);
        }
        const chars = Array.from(text);
        const ranges = [];
        const add = (start, end, url, kind) => {
            start = Number(start); end = Number(end);
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= chars.length || !safeUrl(url)) return;
            ranges.push({ start, end, url, kind });
        };
        const gifTag = getTag(tags, 'gifs');
        for (const entry of gifTag.split(/,(?=\d+-\d+\|)/)) {
            const gif = /^(\d+)-(\d+)\|[^|]+\|(https?:\/\/[\s\S]+)$/i.exec(entry);
            if (gif) add(gif[1], gif[2], gif[3], 'gif');
        }
        for (const entry of getTag(tags, 'emotes').split('/')) {
            const emote = /^([A-Za-z0-9_-]+):(.+)$/.exec(entry);
            if (!emote) continue;
            for (const pair of emote[2].split(',')) {
                const range = /^(\d+)-(\d+)$/.exec(pair);
                if (range) add(range[1], range[2], `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(emote[1])}/default/dark/2.0`, 'emote');
            }
        }
        // GIFs win overlapping ranges. Ignore malformed overlaps, preserving all unclaimed text.
        ranges.sort((a, b) => a.kind === b.kind ? a.start - b.start || a.end - b.end : a.kind === 'gif' ? -1 : 1);
        const accepted = [];
        for (const range of ranges) {
            if (!accepted.some(other => range.start <= other.end && range.end >= other.start)) accepted.push(range);
        }
        accepted.sort((a, b) => a.start - b.start);
        if (!options.renderImage || !options.protectHtml) return { text, action };
        let cursor = 0, output = '';
        for (const range of accepted) {
            const label = chars.slice(range.start, range.end + 1).join('');
            const html = options.renderImage(range.url, { emote: range.kind === 'emote', label, preserveUrl: range.kind === 'gif', nativeGif: range.kind === 'gif' });
            output += chars.slice(cursor, range.start).join('') + options.protectHtml(html);
            cursor = range.end + 1;
        }
        return { text: output + chars.slice(cursor).join(''), action };
    }

    return { escapeHtml, decodeHtml, getTag, safeUrl, ownEmote, classifyMediaUrl, renderContent, prepareNativeBody };
});
