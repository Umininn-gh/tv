(function (root) {
    'use strict';
    const CHANNEL = 'umininn-tv-player';
    const VERSION = 1;
    const PLAYER_HOSTS = Object.freeze([
        'player.twitch.tv', 'player.kick.com', 'ok.ru', 'www.youtube.com', 'youtube.com',
        'www.youtube-nocookie.com', 'youtube-nocookie.com', 'player.angelthump.com',
        'goodgame.ru', 'player.goodgame.ru'
    ]);
    const SITE_MATCHES = Object.freeze([
        'https://umininn-gh.github.io/tv/', 'https://umininn-gh.github.io/tv/?*',
        'https://umininn-gh.github.io/tv/index.html*', 'https://umininn-gh.github.io/tv/admin.html*',
        ...['localhost', '127.0.0.1'].flatMap(host => [
            `http://${host}/`, `http://${host}/?*`, `http://${host}/index.html*`,
            `http://${host}/admin.html*`, `http://${host}/work/extension-site-*.html*`
        ])
    ]);
    const PLAYER_MATCHES = Object.freeze([
        ...PLAYER_HOSTS.map(host => `https://${host}/*`),
        ...['localhost', '127.0.0.1'].map(host => `http://${host}/work/extension-media-*.html*`)
    ]);
    const ACTIONS = Object.freeze(['getState', 'setVolume', 'setMuted', 'recover']);
    function parse(value) {
        try { return new URL(value); } catch (_) { return null; }
    }
    function local(url) { return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname); }
    function isSiteUrl(value) {
        const url = parse(value);
        if (!url || url.username || url.password) return false;
        if (url.protocol === 'https:' && url.hostname === 'umininn-gh.github.io' && (!url.port || url.port === '443')) {
            return ['/tv/', '/tv/index.html', '/tv/admin.html'].includes(url.pathname);
        }
        return local(url) && (['/', '/index.html', '/admin.html'].includes(url.pathname) ||
            /^\/work\/extension-site-[a-zA-Z0-9_-]+\.html$/.test(url.pathname));
    }
    function isSiteOrigin(value) {
        const url = parse(value);
        return Boolean(url && !url.username && !url.password && (local(url) ||
            url.protocol === 'https:' && url.hostname === 'umininn-gh.github.io' && (!url.port || url.port === '443')));
    }
    function isPlayerUrl(value) {
        const url = parse(value);
        if (!url || url.username || url.password) return false;
        return url.protocol === 'https:' && (!url.port || url.port === '443') && PLAYER_HOSTS.includes(url.hostname) ||
            local(url) && /^\/work\/extension-media-[a-zA-Z0-9_-]+\.html$/.test(url.pathname);
    }
    function isEnvelope(message, type) {
        return Boolean(message && typeof message === 'object' && message.channel === CHANNEL &&
            message.version === VERSION && (!type || message.type === type));
    }
    const api = Object.freeze({ CHANNEL, VERSION, ACTIONS, SITE_MATCHES, PLAYER_MATCHES, PLAYER_HOSTS,
        isSiteUrl, isSiteOrigin, isPlayerUrl, isEnvelope });
    root.UmininnConfig = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
