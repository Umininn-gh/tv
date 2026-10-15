/* Public repository location only. Authentication is supplied for each request. */
(function (root) {
    'use strict';
    const config = Object.freeze({ owner: 'Umininn-gh', repo: 'tv', branch: 'main', path: 'ch1.txt' });
    root.TV_CHANNEL_SYNC_CONFIG = config;
    if (typeof module === 'object' && module.exports) module.exports = config;
})(globalThis);
