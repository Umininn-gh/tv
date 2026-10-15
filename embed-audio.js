/* Audio controls for an existing iframe through the official YouTube API. */
(function (root) {
    'use strict';

    const SDK_URL = 'https://www.youtube.com/iframe_api';
    const TIMEOUT_MS = 10000;
    let sdkRequest = null;

    function loadYouTubeSdk() {
        if (root.YT && typeof root.YT.Player === 'function') return Promise.resolve(root.YT);
        if (sdkRequest) return sdkRequest;
        const request = new Promise((resolve, reject) => {
            const script = root.document.createElement('script');
            const previous = root.onYouTubeIframeAPIReady;
            let finished = false;
            const finish = error => {
                if (finished) return;
                finished = true;
                root.clearTimeout(timer);
                script.onload = null;
                script.onerror = null;
                if (root.onYouTubeIframeAPIReady === onReady) root.onYouTubeIframeAPIReady = previous;
                if (error) { script.remove(); reject(error); }
                else resolve(root.YT);
            };
            const onReady = function (...args) {
                try { if (typeof previous === 'function') previous.apply(root, args); } catch (_) {}
                finish(root.YT && typeof root.YT.Player === 'function' ? null : new Error('YouTube API unavailable'));
            };
            const timer = root.setTimeout(() => finish(new Error('YouTube API timed out')), TIMEOUT_MS);
            root.onYouTubeIframeAPIReady = onReady;
            script.async = true;
            script.src = SDK_URL;
            script.onerror = () => finish(new Error('YouTube API unavailable'));
            try { (root.document.head || root.document.documentElement).appendChild(script); }
            catch (error) { finish(error); }
        });
        sdkRequest = request;
        request.catch(() => { if (sdkRequest === request) sdkRequest = null; });
        return request;
    }

    function createYouTubeController(initialIframe, options = {}) {
        let iframe = initialIframe;
        let player = null;
        let startPromise = null;
        let readyTimer = null;
        let disposed = false;
        let unavailable = false;
        let ready = false;
        let desiredMuted = Boolean(options.muted);
        let lastApplied = null;

        function setState(value) {
            if (iframe.dataset) iframe.dataset.embedAudioState = value;
        }
        function clearReadyTimer() {
            if (readyTimer !== null) root.clearTimeout(readyTimer);
            readyTimer = null;
        }
        function fail(error) {
            if (disposed || unavailable) return;
            unavailable = true;
            ready = false;
            clearReadyTimer();
            setState('unavailable');
            try { options.onError?.(error); } catch (_) {}
        }
        function updateIframe() {
            try {
                const current = player && typeof player.getIframe === 'function' ? player.getIframe() : null;
                if (current && current !== iframe) {
                    iframe = current;
                    options.onIframe?.(iframe);
                }
            } catch (_) {}
        }
        function applyMuted(force) {
            if (disposed || unavailable || !ready || !player) return false;
            if (!force && lastApplied === desiredMuted) return true;
            const method = desiredMuted ? 'mute' : 'unMute';
            try {
                if (typeof player[method] !== 'function') throw new Error('YouTube audio control unavailable');
                player[method]();
                lastApplied = desiredMuted;
                return true;
            } catch (error) { fail(error); return false; }
        }
        function start() {
            if (disposed || unavailable || !iframe.isConnected) return Promise.resolve(false);
            if (startPromise) return startPromise;
            startPromise = (async () => {
                let sdk;
                try { sdk = await loadYouTubeSdk(); }
                catch (error) { fail(error); return false; }
                if (disposed || !iframe.isConnected) return false;
                try {
                    player = new sdk.Player(iframe, {
                        events: {
                            onReady(event) {
                                if (disposed || unavailable) return;
                                if (event && event.target) player = event.target;
                                ready = true;
                                clearReadyTimer();
                                updateIframe();
                                setState('ready');
                                applyMuted(true);
                            },
                            onError(event) { fail(new Error('YouTube audio control unavailable: ' + (event && event.data))); }
                        }
                    });
                    updateIframe();
                    if (unavailable) return false;
                    if (!ready) readyTimer = root.setTimeout(() => fail(new Error('YouTube player readiness timed out')), TIMEOUT_MS);
                    return true;
                } catch (error) { fail(error); return false; }
            })();
            return startPromise;
        }
        function setMuted(value, force = false) {
            if (disposed || unavailable) return false;
            const changed = desiredMuted !== Boolean(value);
            desiredMuted = Boolean(value);
            return ready ? applyMuted(force || changed) : true;
        }
        function dispose() {
            if (disposed) return;
            disposed = true;
            clearReadyTimer();
            try { player?.destroy?.(); } catch (_) {}
            player = null;
            ready = false;
            setState('disposed');
        }
        setState('loading');
        return { start, setMuted, dispose };
    }

    const api = { createYouTubeController };
    root.EmbedAudio = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
