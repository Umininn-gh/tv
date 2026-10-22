// Bundled after the shared factories. All exports stay inside the bundle closure.
(function () {
    'use strict';
    const win = window;
    const doc = document;
    const base = scope.UmininnConfig;
    const channel = 'umininn-tv-userscript';
    const version = 1;
    function parse(value) { try { return new URL(value); } catch (_) { return null; } }
    function secure(url) { return url && url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443'); }
    const config = Object.freeze({
        ...base, CHANNEL: channel, VERSION: version,
        DISPLAY_VERSION: scope.userscriptVersion,
        PERMISSION_HINT: '腳本管理器的網站權限',
        isSiteUrl(value) {
            const url = parse(value);
            return Boolean(secure(url) && url.hostname === 'umininn-gh.github.io' &&
                ['/tv/', '/tv/index.html', '/tv/admin.html'].includes(url.pathname));
        },
        isSiteOrigin(value) {
            const url = parse(value);
            return Boolean(secure(url) && url.hostname === 'umininn-gh.github.io');
        },
        isPlayerUrl(value) {
            const url = parse(value);
            return Boolean(secure(url) && base.PLAYER_HOSTS.includes(url.hostname));
        },
        isEnvelope(message, type) {
            return Boolean(message && typeof message === 'object' && message.channel === channel &&
                message.version === version && (!type || message.type === type));
        }
    });
    const site = win.top === win && config.isSiteUrl(win.location.href);
    const frame = win.parent !== win && config.isPlayerUrl(win.location.href);
    if (!site && !frame) return;
    const marker = 'data-umininn-player-userscript';
    if (!doc.documentElement || doc.documentElement.hasAttribute(marker)) return;
    // Only one script installation owns a document, including while login mounts.
    if (site && doc.getElementById('umininn-player-control-host')) return;
    doc.documentElement.setAttribute(marker, scope.userscriptVersion);
    let client = null;
    let controller = null;
    if (site) {
        client = scope.UmininnUserscript.createSiteTransport({ window: win, config });
        controller = scope.UmininnSite.createSiteController({ window: win, document: doc,
            config, runtime: client, media: scope.UmininnMedia, recovery: scope.UmininnRecovery, layoutAudio: scope.UmininnLayoutAudio });
        controller.start();
    } else {
        client = scope.UmininnUserscript.createFrameClient({ window: win, config,
            media: scope.UmininnMedia, twitch: scope.UmininnTwitch, angelthump: scope.UmininnAngelThump });
    }
    function onPageHide(event) {
        if (event.persisted) return;
        controller?.dispose();
        client?.dispose();
        doc.documentElement.removeAttribute(marker);
        win.removeEventListener('pagehide', onPageHide);
        win.removeEventListener('pageshow', onPageShow);
    }
    function onPageShow(event) {
        if (event.persisted) controller?.scan();
    }
    win.addEventListener('pagehide', onPageHide);
    win.addEventListener('pageshow', onPageShow);
})(/* private scope */);
