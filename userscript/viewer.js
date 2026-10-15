(function () {
    'use strict';

    const sourceField = document.getElementById('userscript-source');
    const copyButton = document.getElementById('copy-userscript');
    const retryButton = document.getElementById('retry-userscript');
    const status = document.getElementById('viewer-status');
    let source = '';

    function setStatus(message, state) {
        status.textContent = message;
        status.dataset.state = state || '';
    }

    async function loadSource() {
        source = '';
        sourceField.value = '';
        sourceField.placeholder = '載入中…';
        sourceField.setAttribute('aria-busy', 'true');
        copyButton.disabled = true;
        retryButton.hidden = true;
        setStatus('正在載入腳本…');

        try {
            const response = await fetch('./umininn-tv-player.user.js', { cache: 'no-store' });
            if (!response.ok) throw new Error('Unable to load userscript');
            const text = await response.text();
            const metadata = text.match(/^\uFEFF?\/\/\s*==UserScript==\r?\n([\s\S]*?)\/\/\s*==\/UserScript==(?=\r?\n|$)/);
            if (!metadata || !/^\/\/\s*@name\s+\S/m.test(metadata[1])) {
                throw new Error('Invalid userscript');
            }
            source = text;
            sourceField.value = source;
            copyButton.disabled = false;
            setStatus('已載入，可複製全部內容。');
        } catch (error) {
            sourceField.placeholder = '無法載入腳本';
            retryButton.hidden = false;
            setStatus('無法載入腳本，請重新載入。', 'error');
        } finally {
            sourceField.setAttribute('aria-busy', 'false');
        }
    }

    async function copySource() {
        if (!source) return;
        copyButton.disabled = true;

        try {
            if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
                throw new Error('Clipboard API unavailable');
            }
            await navigator.clipboard.writeText(source);
            setStatus('已複製全部內容。');
        } catch (error) {
            sourceField.focus();
            sourceField.select();
            sourceField.setSelectionRange(0, sourceField.value.length);
            let copied = false;
            try {
                copied = document.execCommand('copy');
            } catch (copyError) {
                // Keep the entire script selected for manual copying.
            }
            if (copied) {
                setStatus('已複製全部內容。');
            } else {
                setStatus('已選取全部內容，請按 Ctrl+C（Mac：⌘C）複製。');
            }
        } finally {
            copyButton.disabled = false;
        }
    }

    copyButton.addEventListener('click', copySource);
    retryButton.addEventListener('click', loadSource);
    loadSource();
}());
