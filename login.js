/* A convenience gate for a public static site, not server-side authorization. */
(() => {
    'use strict';

    const config = window.TV_LOGIN_CONFIG;
    const screen = document.getElementById('login-screen');
    const form = document.getElementById('login-form');
    const passwordInput = document.getElementById('login-password');
    const submit = document.getElementById('login-submit');
    const toggle = document.getElementById('toggle-password');
    const status = document.getElementById('login-status');
    let starting = false;
    let needsReload = false;
    const scriptRequests = new Map();

    if (!config || !/^[a-f0-9]{64}$/.test(config.passwordHash) || !config.passwordSalt || !config.storageKey) {
        status.textContent = '登入設定未能載入，請重新整理頁面。';
        return;
    }

    function readSession() {
        try { return sessionStorage.getItem(config.storageKey); }
        catch { return null; }
    }

    function saveSession() {
        try { sessionStorage.setItem(config.storageKey, config.passwordHash); }
        catch { /* Login still works when browser storage is unavailable. */ }
    }

    function clearSession() {
        try { sessionStorage.removeItem(config.storageKey); }
        catch { /* Reload also clears any in-memory login state. */ }
    }

    function loadScript(src, type, isReady = () => true) {
        const key = `${type || 'classic'}:${src}`;
        if (scriptRequests.has(key)) return scriptRequests.get(key);
        const request = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            if (type) script.type = type;
            script.onload = () => {
                script.onload = script.onerror = null;
                if (isReady()) resolve();
                else {
                    script.remove();
                    reject(new Error('Could not initialize ' + src));
                }
            };
            script.onerror = () => {
                script.onload = script.onerror = null;
                script.remove();
                reject(new Error('Could not load ' + src));
            };
            document.head.appendChild(script);
        });
        scriptRequests.set(key, request);
        // Concurrent players share the download; a failed request can be retried.
        request.catch(() => { if (scriptRequests.get(key) === request) scriptRequests.delete(key); });
        return request;
    }
    window.TVScriptLoader = { load: loadScript };

    function setBusy(busy) {
        passwordInput.disabled = busy;
        submit.disabled = busy;
        toggle.disabled = busy;
        submit.textContent = busy ? '登入中…' : '登入';
        form.setAttribute('aria-busy', String(busy));
    }

    async function startApp() {
        if (starting) return;
        starting = true;
        setBusy(true);
        status.textContent = '正在載入直播台…';
        let mountedNodes = [];
        try {
            // Relative local assets work at /tv/ and at a Cloudflare Pages root.
            const template = document.getElementById('tv-app-template');
            const fragment = template.content.cloneNode(true);
            mountedNodes = Array.from(fragment.childNodes);
            document.body.appendChild(fragment);
            needsReload = true;
            await loadScript('./channel-list.js');
            await loadScript('./stream-performance.js');
            await loadScript('./player-geometry.js?v=20261025-focus-swap');
            await loadScript('./player-layout.js?v=20261025-focus-swap');
            await loadScript('./player-lifecycle.js?v=20261024-layout-layers-phase4');
            await loadScript('./player-audio-bridge.js?v=20261024-layout-layers-phase4');
            await loadScript('./stream-quality.js?v=20261016-twitch-auto-init').catch(error => console.warn('畫質調節暫時未能載入，沿用平台播放器。', error));
            await loadScript('./embed-audio.js').catch(error => console.warn('YouTube 聲音同步暫時未能載入，請使用播放器聲音控制。', error));
            await loadScript('./menu-dismiss.js?v=20261023-scroll-menu-dismiss');
            await loadScript('./topbar-menu.js?v=20261023-responsive-toolbar');
            await loadScript('./layout-bookmarks.js?v=20261024-bookmarks-delete-all');
            await loadScript('./shared-bookmarks.js?v=20261024-bookmarks-delete-all');
            await loadScript('./tv-app.js?v=20261025-focus-swap');
            if (!window.tvAppReady || typeof window.tvAppReady.then !== 'function') {
                throw new Error('TV application did not initialize');
            }
            await window.tvAppReady;
            saveSession();
            passwordInput.value = '';
            screen.remove();
            template.remove();
            document.body.classList.remove('login-locked');
            // Announcements are optional and must never delay or reject viewing.
            // The shared loader also prevents duplicate listener registration.
            void loadScript('./jquery-3.6.0.min.js', 'module')
                .catch(error => console.warn('公告暫時未能載入。', error));
        } catch (error) {
            window.topbarOptionsMenu?.dispose();
            window.topbarOptionsMenu = null;
            mountedNodes.forEach(node => node.remove());
            clearSession();
            starting = false;
            setBusy(false);
            status.textContent = needsReload ? '網站載入失敗，請重新載入頁面再試。' : '網站載入失敗，請檢查網絡後再試。';
            if (needsReload) {
                submit.textContent = '重新載入';
                form.noValidate = true;
            }
            passwordInput.focus();
            console.error(error);
        }
    }

    toggle.addEventListener('click', () => {
        const visible = passwordInput.type === 'password';
        passwordInput.type = visible ? 'text' : 'password';
        toggle.textContent = visible ? '隱藏' : '顯示';
        toggle.setAttribute('aria-label', visible ? '隱藏密碼' : '顯示密碼');
        toggle.setAttribute('aria-pressed', String(visible));
    });

    passwordInput.addEventListener('input', () => {
        passwordInput.removeAttribute('aria-invalid');
        status.textContent = '';
    });

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (needsReload && !starting) {
            window.location.reload();
            return;
        }
        if (starting || submit.disabled) return;
        setBusy(true);
        status.textContent = '';
        try {
            const data = new TextEncoder().encode(config.passwordSalt + ':' + passwordInput.value);
            const digest = await crypto.subtle.digest('SHA-256', data);
            const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
            if (hash !== config.passwordHash) {
                setBusy(false);
                status.textContent = '密碼不正確，請再試一次。';
                passwordInput.setAttribute('aria-invalid', 'true');
                passwordInput.select();
                return;
            }
            await startApp();
        } catch (error) {
            setBusy(false);
            status.textContent = '無法驗證密碼，請用 HTTPS 網址開啟網站。';
            console.error(error);
        }
    });

    document.addEventListener('click', event => {
        if (event.target.closest('#logout-btn')) {
            clearSession();
            window.location.reload();
        }
    });

    if (readSession() === config.passwordHash) {
        void startApp();
    } else {
        setBusy(false);
        passwordInput.focus();
    }
})();
