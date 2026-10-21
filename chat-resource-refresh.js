(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ChatResourceRefresh = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    class Batcher {
        constructor(apply, schedule = callback => requestAnimationFrame(callback)) {
            this.apply = apply;
            this.schedule = schedule;
            this.depth = 0;
            this.scheduled = false;
            this.pending = this.empty();
        }
        empty() { return { emotes: new Set(), badges: false, picker: false, audio: false }; }
        begin() { this.depth++; }
        end() { this.depth = Math.max(0, this.depth - 1); this.request(); }
        queue(change = {}) {
            for (const name of change.emotes || []) this.pending.emotes.add(name.toLowerCase());
            for (const flag of ['badges', 'picker', 'audio']) this.pending[flag] ||= Boolean(change[flag]);
            this.request();
        }
        request() {
            const pending = this.pending;
            if (this.depth || this.scheduled || !(pending.emotes.size || pending.badges || pending.picker || pending.audio)) return;
            this.scheduled = true;
            this.schedule(() => {
                this.scheduled = false;
                if (this.depth) return;
                const change = this.pending;
                this.pending = this.empty();
                this.apply(change);
            });
        }
    }

    // One marker per uninterrupted text run, rather than a span for every word.
    // Protected native emotes, quotes and mentions must remain outside those runs.
    function textRunHtml(text, escapeHtml, isProtected = () => false) {
        let output = '', run = '';
        const flush = () => {
            if (run) output += run.trim() ? `<span data-chat-text>${escapeHtml(run)}</span>` : escapeHtml(run);
            run = '';
        };
        for (const word of text.split(/(\s+)/)) {
            if (isProtected(word)) { flush(); output += escapeHtml(word); }
            else run += word;
        }
        flush();
        return output;
    }

    function updateEmotes(root, names, { getUrl, renderImage }) {
        if (!root || (names && !names.size)) return false;
        const document = root.ownerDocument;
        let changed = false;
        for (const token of root.querySelectorAll('[data-chat-emote]')) {
            if (names && !names.has(token.dataset.chatEmote)) continue;
            const image = token.querySelector('img');
            const url = getUrl(token.dataset.chatEmote);
            if (!image || !url || image.getAttribute('src') === url) continue;
            token.dataset.state = 'loading';
            image.hidden = false;
            const fallback = token.querySelector('.chat-image-fallback');
            if (fallback) fallback.hidden = true;
            token.querySelectorAll('a').forEach(link => link.setAttribute('href', url));
            image.setAttribute('src', url);
            changed = true;
        }
        for (const run of [...root.querySelectorAll('[data-chat-text]')]) {
            const words = run.textContent.split(/(\s+)/);
            if (!words.some(word => (!names || names.has(word.toLowerCase())) && getUrl(word))) continue;
            const fragment = document.createDocumentFragment();
            let plain = '';
            const flush = () => {
                if (!plain) return;
                if (plain.trim()) {
                    const next = document.createElement('span');
                    next.setAttribute('data-chat-text', '');
                    next.textContent = plain;
                    fragment.append(next);
                } else fragment.append(document.createTextNode(plain));
                plain = '';
            };
            for (const word of words) {
                const url = (!names || names.has(word.toLowerCase())) && getUrl(word);
                if (!url) { plain += word; continue; }
                flush();
                const template = document.createElement('template');
                template.innerHTML = renderImage(url, word);
                fragment.append(template.content);
            }
            flush();
            run.replaceWith(fragment);
            changed = true;
        }
        return changed;
    }

    function updateBadges(root, getUrl) {
        if (!root) return false;
        const document = root.ownerDocument;
        let changed = false;
        for (const group of root.querySelectorAll('[data-chat-badges]')) {
            let cursor = group.firstElementChild;
            for (const badge of group.dataset.chatBadges.split(',')) {
                const url = getUrl(badge);
                if (!url) continue;
                let image = [...group.children].find(child => child.dataset.chatBadge === badge);
                if (!image) {
                    image = document.createElement('img');
                    image.className = 'badge';
                    image.dataset.chatBadge = badge;
                    image.referrerPolicy = 'no-referrer';
                }
                if (image.getAttribute('src') !== url) { image.setAttribute('src', url); changed = true; }
                if (image !== cursor) { group.insertBefore(image, cursor); changed = true; }
                cursor = image.nextElementSibling;
            }
            while (cursor) { const next = cursor.nextElementSibling; cursor.remove(); cursor = next; changed = true; }
        }
        return changed;
    }

    return { Batcher, textRunHtml, updateEmotes, updateBadges };
});
