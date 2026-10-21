'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const reorganizedFiles = {
    'test3.html': 'site/chat/index.html',
    'chat-message-format.js': 'site/assets/js/chat-message-format.js',
    'chat-message-store.js': 'site/assets/js/chat-message-store.js',
    'chat-resource-refresh.js': 'site/assets/js/chat-resource-refresh.js',
    'site-paths.js': 'site/assets/js/site-paths.js',
    'jquery-3.3.1.min.js': 'archive/legacy-root/jquery-3.3.1.min.js'
};

function resolveChatFile(name) {
    const legacy = path.join(root, name);
    if (fs.existsSync(legacy)) return legacy;
    const relocated = reorganizedFiles[name] && path.join(root, reorganizedFiles[name]);
    if (relocated && fs.existsSync(relocated)) return relocated;
    throw new Error(`Chat test source was not found: ${name}`);
}

module.exports = { resolveChatFile };
