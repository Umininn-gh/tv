(function (root) {
    'use strict';
    const api = root.browser || root.chrome;
    const version = api?.runtime?.getManifest?.()?.version;
    const label = root.document.getElementById('extension-version');
    if (label && typeof version === 'string') label.textContent = (version.startsWith('0.') ? '測試版 ' : '版本 ') + version;
})(globalThis);
