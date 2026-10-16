/* Hide only AngelThump's Patreon banner; leave its player and controls intact. */
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
        return { dispose() { style.remove(); } };
    }

    const api = { createLogoController };
    root.UmininnAngelThump = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
