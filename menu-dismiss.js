(function (root) {
    'use strict';
    const CHANNEL = 'umininn-menu-interaction';
    const VERSION = 1;
    const GESTURES = ['pointerdown', 'mousedown', 'touchstart', 'contextmenu', 'wheel', 'keydown'];
    const TOKEN = /^[a-f0-9]{32,128}$/;

    function envelope(type, fields) { return { channel: CHANNEL, version: VERSION, type, ...fields }; }
    function message(value, type) {
        return value && typeof value === 'object' && !Array.isArray(value) &&
            value.channel === CHANNEL && value.version === VERSION && value.type === type;
    }
    function officialChat(win, value) {
        try {
            const url = new win.URL(value, win.location.href);
            return url.protocol === 'https:' && url.hostname === 'www.twitch.tv' &&
                !url.username && !url.password && (!url.port || url.port === '443') &&
                /^\/embed\/[a-z0-9_]+\/chat\/?$/i.test(url.pathname) ? url : null;
        } catch (_) { return null; }
    }
    function randomToken(win) {
        try {
            const bytes = new Uint8Array(16);
            win.crypto.getRandomValues(bytes);
            return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
        } catch (_) { return null; }
    }
    function contains(owner, node) {
        if (!owner || !node) return false;
        try {
            for (let current = node; current; current = current.parentNode || current.host || current.getRootNode?.()?.host) {
                if (owner === current || current.nodeType && owner.contains(current)) return true;
            }
        } catch (_) { /* A foreign WindowProxy is not an owned DOM node. */ }
        return false;
    }
    function frameElement(node) { return node?.nodeType === 1 && node.tagName === 'IFRAME'; }
    function framesIn(document) {
        const frames = [], roots = [];
        function collect(tree) {
            roots.push(tree);
            frames.push(...tree.querySelectorAll('iframe'));
            // Open shadow roots can contain embedded settings or players too.
            for (const element of tree.querySelectorAll('*')) if (element.shadowRoot) collect(element.shadowRoot);
        }
        collect(document);
        return { frames, roots };
    }

    function observe(options = {}) {
        const win = options.window || root.window || root;
        const doc = win.document;
        const owners = Array.from(options.inside || []).filter(Boolean);
        const bindings = new Map();
        let disposed = false, focusTimer = null, scanTimer = null, relay = null;
        const noop = { dispose() {} };
        if (!doc || typeof options.onOutside !== 'function') return noop;

        function isInside(node) { return owners.some(owner => contains(owner, node)); }
        function eventInside(event, binding) {
            const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
            if (owners.some(owner => path.includes(owner) || path.some(node => contains(owner, node)))) return true;
            // Events inside an iframe do not include its embedding elements in
            // composedPath. An iframe belonging to this menu is still inside.
            return binding.frames.some(frame => isInside(frame));
        }
        function outside() {
            if (disposed) return;
            dispose();
            options.onOutside();
        }
        function bindingCurrent(binding) {
            let document = doc;
            try {
                if (win.document !== doc) return false;
                for (const frame of binding.frames) {
                    if (!frame.isConnected || frame.ownerDocument !== document) return false;
                    document = frame.contentWindow.document;
                }
                return document === binding.document && binding.window.document === binding.document;
            } catch (_) { return false; }
        }
        function onGesture(binding, event) {
            if (!disposed && event.isTrusted === true && bindingCurrent(binding) && !eventInside(event, binding)) outside();
        }
        function changedFrames(mutations) {
            return mutations.some(mutation => {
                if (mutation.type === 'attributes') return frameElement(mutation.target);
                return [...mutation.addedNodes, ...mutation.removedNodes].some(node =>
                    frameElement(node) || node.nodeType === 1 && (node.shadowRoot || node.querySelector?.('iframe')));
            });
        }
        function scheduleScan() {
            if (disposed || scanTimer !== null) return;
            scanTimer = win.setTimeout(() => { scanTimer = null; scan(); }, 0);
        }
        function removeBinding(binding) {
            // A WindowProxy can become foreign between load and reconciliation.
            // Keep the original method, and still clean observers if the old
            // browsing context no longer allows access to its event target.
            for (const type of GESTURES) {
                try { binding.removeEventListener(type, binding.gesture, true); } catch (_) {}
            }
            binding.document.removeEventListener('load', binding.load, true);
            binding.observer?.disconnect();
            bindings.delete(binding.window);
        }
        function bind(frameWindow, document, frames) {
            let binding = bindings.get(frameWindow);
            if (binding && binding.document !== document) { removeBinding(binding); binding = null; }
            if (binding) { binding.frames = frames; return binding; }
            binding = { window: frameWindow, document, frames, observer: null,
                removeEventListener: frameWindow.removeEventListener.bind(frameWindow) };
            binding.gesture = event => onGesture(binding, event);
            binding.load = event => {
                if (!frameElement(event.target)) return;
                if (event.target === relay?.frame) clearRelay();
                scheduleScan();
            };
            for (const type of GESTURES) frameWindow.addEventListener(type, binding.gesture, { capture: true, passive: true });
            document.addEventListener('load', binding.load, true);
            const Observer = win.MutationObserver;
            if (typeof Observer === 'function') {
                binding.observer = new Observer(mutations => { if (changedFrames(mutations)) scheduleScan(); });
            }
            bindings.set(frameWindow, binding);
            return binding;
        }
        function scan() {
            if (disposed) return;
            const seen = new Set();
            function visit(frameWindow, frames) {
                if (seen.has(frameWindow)) return;
                let document;
                try { document = frameWindow.document; if (!document?.documentElement) return; }
                catch (_) { return; }
                seen.add(frameWindow);
                const binding = bind(frameWindow, document, frames);
                const embedded = framesIn(document);
                if (binding.observer) {
                    binding.observer.disconnect();
                    for (const tree of embedded.roots) binding.observer.observe(tree, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcdoc'] });
                }
                for (const frame of embedded.frames) {
                    try { if (frame.contentWindow) visit(frame.contentWindow, [...frames, frame]); }
                    catch (_) { /* Foreign documents use focus or their scoped notifier. */ }
                }
            }
            visit(win, []);
            for (const binding of [...bindings.values()]) if (!seen.has(binding.window)) removeBinding(binding);
            syncRelay();
        }
        function post(record, type) {
            try {
                record.source.postMessage(envelope(type, { id: record.id, token: record.token, href: record.href }), record.origin);
            } catch (_) { /* The chat may have navigated while the menu closed. */ }
        }
        function clearRelay() {
            const previous = relay;
            relay = null;
            if (previous) post(previous, 'unwatch');
        }
        function chatTarget() {
            const frame = doc.getElementById('chat_embed');
            if (!frameElement(frame) || !frame.isConnected || isInside(frame)) return null;
            const url = officialChat(win, frame.getAttribute('src') || '');
            return url && frame.contentWindow ? { frame, source: frame.contentWindow, href: url.href, origin: url.origin } : null;
        }
        function currentRelay(record) {
            const current = chatTarget();
            return current && current.frame === record.frame && current.source === record.source && current.href === record.href && current.origin === record.origin;
        }
        function syncRelay() {
            const target = chatTarget();
            if (relay && (!target || !currentRelay(relay))) clearRelay();
            if (!target || relay) return;
            const id = randomToken(win), token = randomToken(win);
            if (!id || !token) return;
            relay = { ...target, id, token };
            post(relay, 'watch');
        }
        function onMessage(event) {
            if (disposed) return;
            const value = event.data;
            if (message(value, 'ready')) {
                const target = chatTarget();
                if (!target || event.source !== target.source || event.origin !== target.origin || value.href !== target.href) return;
                syncRelay();
                if (relay) post(relay, 'watch');
                return;
            }
            const record = relay;
            if (!message(value, 'interaction') || !record || !currentRelay(record) ||
                event.source !== record.source || event.origin !== record.origin ||
                value.id !== record.id || value.token !== record.token || value.href !== record.href) return;
            outside();
        }
        function onPlayerInteraction(event) {
            const frame = event.target;
            if (!disposed && frameElement(frame) && frame.ownerDocument === doc && frame.isConnected && !isInside(frame)) outside();
        }
        function checkFocus() {
            focusTimer = null;
            if (disposed) return;
            if (!doc.hidden && doc.hasFocus()) {
                let active = doc.activeElement;
                while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
                if (active?.matches?.('iframe,video,audio') && !isInside(active)) { outside(); return; }
            }
            focusTimer = win.setTimeout(checkFocus, 200);
        }
        function onBlur() {
            if (disposed) return;
            if (focusTimer !== null) win.clearTimeout(focusTimer);
            focusTimer = win.setTimeout(checkFocus, 0);
        }
        function dispose() {
            if (disposed) return;
            disposed = true;
            if (focusTimer !== null) win.clearTimeout(focusTimer);
            if (scanTimer !== null) win.clearTimeout(scanTimer);
            focusTimer = scanTimer = null;
            clearRelay();
            for (const binding of [...bindings.values()]) removeBinding(binding);
            win.removeEventListener('message', onMessage);
            win.removeEventListener('blur', onBlur, true);
            win.removeEventListener('pagehide', dispose);
            doc.removeEventListener('umininn-player-interaction', onPlayerInteraction);
        }
        win.addEventListener('message', onMessage);
        win.addEventListener('blur', onBlur, true);
        win.addEventListener('pagehide', dispose);
        doc.addEventListener('umininn-player-interaction', onPlayerInteraction);
        scan();
        focusTimer = win.setTimeout(checkFocus, 200);
        return { dispose };
    }

    function startFrameNotifier(options = {}) {
        const win = options.window || root.window || root;
        const parent = win.parent;
        const parentOrigin = options.parentOrigin;
        const watches = new Map();
        let disposed = false;
        const noop = { dispose() {} };
        if (!parent || parent === win || !officialChat(win, win.location.href)) return noop;
        try { if (new win.URL(parentOrigin).origin !== parentOrigin || parentOrigin === 'null') return noop; }
        catch (_) { return noop; }
        function send(type, fields) {
            if (!disposed && win.parent === parent) {
                try { parent.postMessage(envelope(type, fields), parentOrigin); } catch (_) {}
            }
        }
        function ready() { send('ready', { href: win.location.href }); }
        function onMessage(event) {
            if (disposed || event.source !== parent || event.origin !== parentOrigin || win.parent !== parent) return;
            const value = event.data;
            if ((!message(value, 'watch') && !message(value, 'unwatch')) || typeof value.id !== 'string' || typeof value.token !== 'string' || !TOKEN.test(value.id) || !TOKEN.test(value.token) ||
                value.href !== win.location.href || !officialChat(win, value.href)) return;
            if (value.type === 'watch') {
                if (watches.size < 128 || watches.has(value.id)) watches.set(value.id, { token: value.token, href: value.href });
            } else if (watches.get(value.id)?.token === value.token) watches.delete(value.id);
        }
        function onGesture(event) {
            if (disposed || event.isTrusted !== true || !officialChat(win, win.location.href)) return;
            for (const [id, watch] of watches) if (watch.href === win.location.href) send('interaction', { id, ...watch });
        }
        function onPageHide(event) {
            watches.clear();
            if (!event.persisted) dispose();
        }
        function onPageShow(event) { if (event.persisted) ready(); }
        function dispose() {
            if (disposed) return;
            disposed = true;
            watches.clear();
            win.removeEventListener('message', onMessage);
            win.removeEventListener('pagehide', onPageHide);
            win.removeEventListener('pageshow', onPageShow);
            for (const type of GESTURES) win.removeEventListener(type, onGesture, true);
        }
        win.addEventListener('message', onMessage);
        win.addEventListener('pagehide', onPageHide);
        win.addEventListener('pageshow', onPageShow);
        for (const type of GESTURES) win.addEventListener(type, onGesture, { capture: true, passive: true });
        ready();
        return { dispose };
    }

    const api = Object.freeze({ observe, startFrameNotifier });
    root.UmininnMenuDismiss = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
