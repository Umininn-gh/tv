/* Hide AngelThump's Patreon banner and settle its initial controls without changing media. */
(function (root) {
    'use strict';
    const STYLE_ID = 'umininn-angelthump-logo-style';
    const SELECTOR = [
        'https://patreon.com/join/angelthump', 'https://patreon.com/join/angelthump/',
        'https://www.patreon.com/join/angelthump', 'https://www.patreon.com/join/angelthump/'
    ].map(href => `a[href="${href}"]`).join(',\n');

    function createLogoController(options = {}) {
        const doc = options.document;
        const win = doc?.defaultView;
        const noop = { dispose() {} };
        if (!win || !win.parent || win.parent === win) return noop;
        let url;
        try { url = new URL(options.location?.href || options.location || win.location.href); }
        catch (_) { return noop; }
        if (url.protocol !== 'https:' || url.hostname !== 'player.angelthump.com' || url.pathname !== '/' ||
            url.username || url.password || url.port && url.port !== '443') return noop;
        const container = doc.head || doc.documentElement;
        if (!container || doc.getElementById(STYLE_ID)) return noop;
        // CSS also covers late React mounts, without observing or polling video state.
        const style = doc.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `${SELECTOR} { display: none !important; }`;
        container.appendChild(style);
        let disposed = false, initialChecked = false, keyboardUsed = false, needsKeyboardReveal = false;

        function playerFor(video) {
            const surface = video?.parentElement;
            return video?.tagName === 'VIDEO' && surface?.tagName === 'DIV' &&
                surface.getAttribute('tabindex') === '-1' ? surface : null;
        }
        function sendMouse(surface, type) {
            // React synthesizes onMouseLeave from mouseout, rather than mouseleave.
            surface.dispatchEvent(new win.MouseEvent(type, { bubbles: true, relatedTarget: null }));
        }
        function settleInitial(video) {
            if (disposed || initialChecked || !video || video.paused || video.ended || video.readyState < 2) return;
            const surface = playerFor(video);
            if (!surface) return;
            initialChecked = true;
            doc.removeEventListener?.('playing', onPlaying, true);
            const focused = doc.activeElement;
            // The platform focuses this wrapper on mount. Only descendant focus
            // represents an active control; do not blur or steal either focus.
            if (keyboardUsed || surface.matches(':hover') || focused && focused !== surface && surface.contains(focused) ||
                surface.querySelector('[role="menu"], [role="menuitem"]')) return;
            sendMouse(surface, 'mouseout');
            needsKeyboardReveal = true;
        }
        function onPlaying(event) { settleInitial(event.target); }
        function onKeyDown(event) {
            if (disposed || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
            for (const video of doc.querySelectorAll?.('video') || []) {
                const surface = playerFor(video);
                if (!surface || !surface.contains(event.target) && !(event.key === 'Tab' && event.target === doc.body)) continue;
                keyboardUsed = true;
                // React commits mousemove updates asynchronously. The first Tab
                // after our initial hide reveals controls without escaping the
                // player; the next Tab keeps native focus navigation.
                const revealWithTab = needsKeyboardReveal && event.key === 'Tab' &&
                    (event.target === surface || event.target === doc.body);
                needsKeyboardReveal = false;
                if (revealWithTab) event.preventDefault();
                // Reveal through the platform's handler so its normal idle timer
                // and all playback shortcuts continue to work.
                sendMouse(surface, 'mousemove');
                break;
            }
        }
        doc.addEventListener?.('playing', onPlaying, true);
        doc.addEventListener?.('keydown', onKeyDown, true);
        for (const video of doc.querySelectorAll?.('video') || []) {
            settleInitial(video);
            if (initialChecked) break;
        }
        return { dispose() {
            if (disposed) return;
            disposed = true;
            doc.removeEventListener?.('playing', onPlaying, true);
            doc.removeEventListener?.('keydown', onKeyDown, true);
            style.remove();
        } };
    }

    const api = { createLogoController };
    root.UmininnAngelThump = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
