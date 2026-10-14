/* Size-aware quality for the supported Twitch embed API. */
(function (root) {
    'use strict';

    const SDK_URL = 'https://player.twitch.tv/js/embed/v1.js';
    const SDK_TIMEOUT_MS = 10000;
    const RESIZE_DELAY_MS = 400;
    const METADATA_RETRIES_MS = [500, 1500, 3500];
    const HEALTH_INTERVAL_MS = 5000;
    const STARTUP_GRACE_MS = 15000;
    let sdkRequest = null;
    let nextPlayerId = 0;

    function normalizeTwitchQualities(qualities) {
        if (!Array.isArray(qualities)) return [];
        const seen = new Set();
        return qualities.flatMap(quality => {
            const value = typeof quality === 'string' ? { group: quality, name: quality } : quality;
            if (!value || typeof value !== 'object') return [];
            const group = typeof value.group === 'string' ? value.group : '';
            if (!group || seen.has(group)) return [];
            seen.add(group);
            const name = typeof value.name === 'string' ? value.name : group;
            const match = /(?:^|\s)(\d{2,4})p(?:(\d{2,3}))?/i.exec(name) || /^(\d{2,4})p(?:(\d{2,3}))?/i.exec(group);
            const height = Number(value.height) > 0 ? Number(value.height) : match ? Number(match[1]) : 0;
            const width = Number(value.width) > 0 ? Number(value.width) : height * 16 / 9;
            const fps = Number(value.framerate) > 0 ? Number(value.framerate) : match && match[2] ? Number(match[2]) : 30;
            const bitrate = Number(value.bitrate || value.bandwidth) > 0 ? Number(value.bitrate || value.bandwidth) : Infinity;
            return [{ group, name, width, height, fps, bitrate, source: group === 'chunked' || /\bsource\b/i.test(name) }];
        });
    }

    function chooseTwitchQuality(qualities, width, height) {
        const normalized = normalizeTwitchQualities(qualities);
        const auto = normalized.some(quality => quality.group === 'auto') ? 'auto' : null;
        // Fixed selections disable network ABR. Do not take over without a way back.
        if (!auto) return null;
        // The SDK also lists audio-only and an unknown-size source rendition.
        const videos = normalized.filter(quality => quality.group !== 'auto' && quality.group !== 'audio_only' && quality.height > 0 && quality.width > 0);
        if (!(width > 0 && height > 0) || videos.length < 2 && !normalized.some(quality => quality.source && !quality.height)) return auto;
        if (!videos.length) return auto;
        const displayWidth = Math.min(width, height * 16 / 9);
        const displayHeight = Math.min(height, width * 9 / 16);
        const compare = (a, b) => a.width * a.height - b.width * b.height || a.fps - b.fps || a.bitrate - b.bitrate;
        videos.sort(compare);
        const sufficient = videos.find(quality => quality.width >= displayWidth - 1 && quality.height >= displayHeight - 1);
        if (sufficient) return sufficient.group;
        // An unlabelled source may be larger than the known transcodes. Let Auto decide.
        if (normalized.some(quality => quality.source && !quality.height)) return auto;
        const largestArea = videos[videos.length - 1].width * videos[videos.length - 1].height;
        return videos.find(quality => quality.width * quality.height === largestArea).group;
    }

    function loadTwitchSdk() {
        if (root.Twitch && typeof root.Twitch.Player === 'function') return Promise.resolve(root.Twitch);
        if (sdkRequest) return sdkRequest;
        const request = new Promise((resolve, reject) => {
            const script = root.document.createElement('script');
            let finished = false;
            const finish = error => {
                if (finished) return;
                finished = true;
                root.clearTimeout(timer);
                script.onload = null;
                script.onerror = null;
                if (error) { script.remove(); reject(error); }
                else resolve(root.Twitch);
            };
            const timer = root.setTimeout(() => finish(new Error('Twitch SDK timed out')), SDK_TIMEOUT_MS);
            script.async = true;
            script.src = SDK_URL;
            script.onload = () => finish(root.Twitch && typeof root.Twitch.Player === 'function' ? null : new Error('Twitch SDK unavailable'));
            script.onerror = () => finish(new Error('Twitch SDK unavailable'));
            try { (root.document.head || root.document.documentElement).appendChild(script); }
            catch (error) { finish(error); }
        });
        sdkRequest = request;
        request.catch(() => { if (sdkRequest === request) sdkRequest = null; });
        return request;
    }

    function createTwitchPlayer(wrapper, options) {
        let started = false;
        let disposed = false;
        let ready = false;
        let player = null;
        let fallback = null;
        let observer = null;
        let resizeTimer = null;
        let healthTimer = null;
        let retries = [];
        let desiredMuted = Boolean(options.muted);
        let mutedDirty = false;
        let lastRequested = null;
        let lastMulti = null;
        let lastSize = null;
        let recoverySize = null;
        let networkAuto = false;
        let emptyBufferSamples = 0;
        let fixedSince = 0;
        let hasPlayed = false;
        let playbackPaused = false;
        let playbackStartedAt = 0;
        let forceQualityRequest = false;
        let ownQualitySwitch = false;
        let qualitySwitchTimer = null;
        let autoGroupSeen = false;
        const subscriptions = [];
        const doc = wrapper.ownerDocument || root.document;
        wrapper.dataset.streamQualityMode = 'loading';
        wrapper.dataset.streamQuality = 'auto';

        function isMultiView() {
            try { return Boolean(options.isMultiView && options.isMultiView()); }
            catch (_) { return false; }
        }

        function isFullscreen() {
            const element = doc.fullscreenElement || doc.webkitFullscreenElement;
            return Boolean(element && (element === wrapper || wrapper.contains(element)));
        }

        function stopHealthChecks() {
            if (healthTimer !== null) root.clearTimeout(healthTimer);
            healthTimer = null;
            emptyBufferSamples = 0;
        }

        function clearRetries() {
            retries.forEach(timer => root.clearTimeout(timer));
            retries = [];
        }

        function finishQualitySwitch() {
            ownQualitySwitch = false;
            if (qualitySwitchTimer !== null) root.clearTimeout(qualitySwitchTimer);
            qualitySwitchTimer = null;
        }

        function beginQualitySwitch() {
            finishQualitySwitch();
            ownQualitySwitch = true;
            // A paused/offline player may never emit PLAYING for a quality change.
            qualitySwitchTimer = root.setTimeout(finishQualitySwitch, 10000);
        }

        function publicCall(method, ...args) {
            try { return player && typeof player[method] === 'function' ? player[method](...args) : undefined; }
            catch (_) { return undefined; }
        }

        function checkHealth() {
            healthTimer = null;
            if (disposed || !ready || !hasPlayed || playbackPaused || !wrapper.isConnected || !isMultiView() || isFullscreen() || networkAuto || !lastRequested || lastRequested === 'auto') return;
            const stats = publicCall('getPlaybackStats');
            const buffer = stats && stats.bufferSize;
            const paused = publicCall('isPaused');
            const ended = publicCall('getEnded');
            const fps = stats && stats.fps;
            const rate = stats && stats.playbackRate;
            const validFps = typeof fps === 'number' && Number.isFinite(fps) && fps >= 0;
            const validRate = typeof rate === 'number' && Number.isFinite(rate) && rate >= 0;
            const healthyPlayback = validFps && fps > 0 || validRate && rate > 0;
            const stalledPlayback = !healthyPlayback && (validFps && fps === 0 || validRate && rate === 0);
            // Low-latency playback can report an empty buffer while decoding normally.
            // A waiting autoplay prompt also has zeroed stats, so require PLAYING first.
            if (paused || ended || !stalledPlayback || Date.now() - Math.max(fixedSince, playbackStartedAt) < STARTUP_GRACE_MS || typeof buffer !== 'number' || !Number.isFinite(buffer) || buffer < 0) emptyBufferSamples = 0;
            else emptyBufferSamples = buffer <= 0.01 ? emptyBufferSamples + 1 : 0;
            if (emptyBufferSamples >= 3) {
                networkAuto = true;
                recoverySize = lastSize;
                evaluate();
                return;
            }
            healthTimer = root.setTimeout(checkHealth, HEALTH_INTERVAL_MS);
        }

        function ensureHealthChecks() {
            if (hasPlayed && !playbackPaused && healthTimer === null) healthTimer = root.setTimeout(checkHealth, HEALTH_INTERVAL_MS);
        }

        function meaningfulSizeChange(a, b) {
            return Boolean(a && b && (Math.abs(a.width - b.width) > Math.max(40, a.width * 0.12) || Math.abs(a.height - b.height) > Math.max(40, a.height * 0.12)));
        }

        function evaluate() {
            if (disposed || !ready || !player || !wrapper.isConnected) return false;
            const multi = isMultiView();
            const fullscreen = isFullscreen();
            const rect = wrapper.getBoundingClientRect();
            const size = { width: rect.width, height: rect.height };
            if (lastMulti !== null && multi !== lastMulti || networkAuto && meaningfulSizeChange(recoverySize, size)) {
                networkAuto = false;
                recoverySize = null;
            }
            lastMulti = multi;
            lastSize = size;
            const qualities = publicCall('getQualities');
            const normalized = normalizeTwitchQualities(qualities);
            const hasAuto = normalized.some(quality => quality.group === 'auto');
            autoGroupSeen = autoGroupSeen || hasAuto;
            // The cached rendition list can disappear during a reconnect. Auto remains
            // a supported group once the player has advertised it, so it is safe to retreat.
            const selectable = autoGroupSeen && !hasAuto ? (Array.isArray(qualities) ? qualities : []).concat('auto') : qualities;
            const wanted = multi && !fullscreen && !networkAuto
                ? autoGroupSeen ? chooseTwitchQuality(selectable, size.width, size.height) || 'auto' : null
                : autoGroupSeen ? 'auto' : null;
            wrapper.dataset.streamQualityMode = networkAuto && multi && !fullscreen ? 'network-auto' : wanted && wanted !== 'auto' ? 'size' : 'auto';
            wrapper.dataset.streamQualityTarget = String(Math.round(Math.min(size.height, size.width * 9 / 16)));
            if (wanted && wanted !== lastRequested) {
                const current = publicCall('getQuality');
                const sendRequest = forceQualityRequest || current !== wanted;
                // Commit the request cache before calling into the SDK: public event
                // callbacks can run synchronously from setQuality in some players.
                lastRequested = wanted;
                forceQualityRequest = false;
                fixedSince = Date.now();
                emptyBufferSamples = 0;
                try {
                    if (sendRequest && typeof player.setQuality === 'function') {
                        // Twitch can emit PAUSE/PLAYING from this call, including before
                        // it returns. Those events are not a user's pause/resume action.
                        beginQualitySwitch();
                        player.setQuality(wanted);
                    }
                } catch (_) {
                    lastRequested = null;
                    forceQualityRequest = true;
                    finishQualitySwitch();
                    stopHealthChecks();
                    return false;
                }
            }
            wrapper.dataset.streamQuality = wanted || publicCall('getQuality') || 'auto';
            if (wanted && wanted !== 'auto' && multi && !fullscreen && !networkAuto) ensureHealthChecks();
            else stopHealthChecks();
            // READY can expose only Auto before the stream's rendition list arrives.
            return normalized.some(quality => quality.group !== 'auto' && quality.group !== 'audio_only' && quality.height > 0);
        }

        function scheduleResize() {
            if (disposed) return;
            if (resizeTimer !== null) root.clearTimeout(resizeTimer);
            resizeTimer = root.setTimeout(() => { resizeTimer = null; evaluate(); }, RESIZE_DELAY_MS);
        }

        function refreshMetadata() {
            if (disposed || !ready) return;
            clearRetries();
            if (evaluate()) return;
            retries = METADATA_RETRIES_MS.map(delay => root.setTimeout(() => {
                if (!disposed && evaluate()) clearRetries();
            }, delay));
        }

        function styleIframe(iframe) {
            if (!iframe) return;
            iframe.style.width = '100%';
            iframe.style.height = '100%';
            iframe.style.border = '0';
            iframe.style.display = 'block';
        }

        function fallbackUrl() {
            try {
                const url = new URL(options.fallbackUrl || `https://player.twitch.tv/?channel=${encodeURIComponent(options.channel)}&parent=${encodeURIComponent(options.parent || root.location.hostname || 'localhost')}`);
                url.searchParams.set('muted', String(desiredMuted));
                return url.href;
            } catch (_) { return options.fallbackUrl; }
        }

        function mountFallback() {
            if (disposed || !wrapper.isConnected) return;
            // Constructor errors may have left a partial iframe behind.
            wrapper.querySelectorAll('iframe').forEach(iframe => { iframe.src = 'about:blank'; iframe.remove(); });
            fallback = doc.createElement('iframe');
            fallback.src = fallbackUrl();
            fallback.allow = 'autoplay; fullscreen; encrypted-media';
            fallback.allowFullscreen = true;
            fallback.title = 'Twitch';
            styleIframe(fallback);
            wrapper.appendChild(fallback);
            wrapper.dataset.streamQualityMode = 'platform-auto';
            wrapper.dataset.streamQuality = 'auto';
        }

        async function start() {
            if (started || disposed || !wrapper.isConnected) return;
            started = true;
            if (!wrapper.id) wrapper.id = `twitch-quality-player-${++nextPlayerId}`;
            let sdk;
            try { sdk = await loadTwitchSdk(); }
            catch (_) { mountFallback(); return; }
            if (disposed || !wrapper.isConnected) return;
            try {
                player = new sdk.Player(wrapper, {
                    width: '100%', height: '100%', channel: options.channel,
                    parent: Array.isArray(options.parent) ? options.parent : [options.parent || root.location.hostname || 'localhost'],
                    autoplay: true, muted: desiredMuted
                });
                styleIframe(wrapper.querySelector('iframe'));
                const onReady = () => {
                    if (disposed) return;
                    ready = true;
                    if (mutedDirty) { publicCall('setMuted', desiredMuted); mutedDirty = false; }
                    refreshMetadata();
                };
                const onOnline = () => {
                    if (disposed) return;
                    // A fresh broadcast can reset Twitch to Auto without changing its size.
                    lastRequested = null;
                    emptyBufferSamples = 0;
                    fixedSince = Date.now();
                    hasPlayed = false;
                    playbackPaused = false;
                    playbackStartedAt = 0;
                    forceQualityRequest = true;
                    stopHealthChecks();
                    refreshMetadata();
                };
                const onPlaying = () => {
                    if (disposed) return;
                    if (ownQualitySwitch) {
                        // A quality request made while genuinely paused may have no
                        // PLAYING completion. If the user's resume resets Twitch to
                        // Auto, this is that resume rather than our switch completing.
                        const resumedFromAuto = playbackPaused && lastRequested && lastRequested !== 'auto' && publicCall('getQuality') === 'auto';
                        finishQualitySwitch();
                        if (!resumedFromAuto) {
                            if (!playbackPaused && !hasPlayed) {
                                hasPlayed = true;
                                playbackStartedAt = Date.now();
                            }
                            if (!playbackPaused && lastRequested && lastRequested !== 'auto' && isMultiView() && !isFullscreen() && !networkAuto) ensureHealthChecks();
                            return;
                        }
                    }
                    if (playbackPaused) {
                        hasPlayed = true;
                        playbackPaused = false;
                        playbackStartedAt = Date.now();
                        lastRequested = null;
                        // The SDK's cached getQuality may lag its PLAYING event.
                        forceQualityRequest = true;
                    } else if (!hasPlayed) {
                        hasPlayed = true;
                        playbackStartedAt = Date.now();
                        lastRequested = null;
                    }
                    refreshMetadata();
                };
                const onPause = () => {
                    if (disposed || ownQualitySwitch) return;
                    playbackPaused = true;
                    stopHealthChecks();
                };
                for (const [event, callback] of [[sdk.Player.READY, onReady], [sdk.Player.PLAYING, onPlaying], [sdk.Player.ONLINE, onOnline], [sdk.Player.PAUSE, onPause]]) {
                    if (event && typeof player.addEventListener === 'function') {
                        player.addEventListener(event, callback);
                        subscriptions.push([event, callback]);
                    }
                }
                if (typeof root.ResizeObserver === 'function') {
                    observer = new root.ResizeObserver(scheduleResize);
                    observer.observe(wrapper);
                }
                root.addEventListener('resize', scheduleResize);
                doc.addEventListener('fullscreenchange', scheduleResize);
                doc.addEventListener('webkitfullscreenchange', scheduleResize);
            } catch (_) {
                releaseSdk();
                mountFallback();
            }
        }

        function setMuted(value) {
            const muted = Boolean(value);
            if (disposed || desiredMuted === muted) return;
            desiredMuted = muted;
            if (ready) publicCall('setMuted', muted);
            else mutedDirty = true;
            if (fallback) fallback.src = fallbackUrl();
        }

        function releaseSdk() {
            if (observer) observer.disconnect();
            observer = null;
            root.removeEventListener('resize', scheduleResize);
            doc.removeEventListener('fullscreenchange', scheduleResize);
            doc.removeEventListener('webkitfullscreenchange', scheduleResize);
            if (resizeTimer !== null) root.clearTimeout(resizeTimer);
            resizeTimer = null;
            clearRetries();
            finishQualitySwitch();
            stopHealthChecks();
            for (const [event, callback] of subscriptions) publicCall('removeEventListener', event, callback);
            subscriptions.length = 0;
            // The current SDK exposes destroy, but our own cleanup does not depend on it.
            publicCall('destroy');
            player = null;
            ready = false;
        }

        function dispose() {
            if (disposed) return;
            disposed = true;
            releaseSdk();
            wrapper.querySelectorAll('iframe').forEach(iframe => { iframe.src = 'about:blank'; iframe.remove(); });
            fallback = null;
        }

        return { start, setMuted, refresh: scheduleResize, dispose };
    }

    const api = { createTwitchPlayer, chooseTwitchQuality, normalizeTwitchQualities };
    root.StreamQuality = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
