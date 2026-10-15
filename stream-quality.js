/* Size-aware quality for the supported Twitch embed API. */
(function (root) {
    'use strict';

    const SDK_URL = 'https://player.twitch.tv/js/embed/v1.js';
    const SDK_TIMEOUT_MS = 10000;
    const RESIZE_DELAY_MS = 400;
    const METADATA_RETRIES_MS = [500, 1500, 3500];
    const HEALTH_INTERVAL_MS = 5000;
    const STARTUP_GRACE_MS = 15000;
    const CONTEXT_SETTLE_MS = 2000;
    // Twitch initializes embed visibility through a delayed observer. READY can
    // precede that observation, and a play command sent earlier is discarded.
    const STARTUP_PLAY_DELAY_MS = 2000;
    const STARTUP_FOLLOWUP_DELAY_MS = 8000;
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
        let ownQualitySwitch = false;
        let qualitySwitchTimer = null;
        let autoGroupSeen = false;
        let contextSuspended = false;
        let contextSettling = false;
        let contextTimer = null;
        let resumeEligible = false;
        let contextPauseObserved = false;
        let automaticResumeAttempted = false;
        let playbackBlocked = false;
        let recoveryAuto = false;
        let recoveryAutoSize = null;
        let recoveryAutoMulti = null;
        let verifyAfterContext = false;
        let startupPlayAttempted = false;
        let startupTimer = null;
        let startupFollowupTimer = null;
        const subscriptions = [];
        const doc = wrapper.ownerDocument || root.document;
        wrapper.dataset.streamQualityMode = 'loading';
        wrapper.dataset.streamQuality = 'auto';
        wrapper.dataset.streamPlaybackBlocked = 'false';
        wrapper.dataset.streamPlaybackState = 'loading';

        function setPlaybackState(state) {
            wrapper.dataset.streamPlaybackState = state;
        }

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

        function contextUnavailable(size = lastSize) {
            if (doc.hidden === true || doc.visibilityState === 'hidden') return true;
            const fullscreen = doc.fullscreenElement || doc.webkitFullscreenElement;
            if (fullscreen && fullscreen !== wrapper && !wrapper.contains(fullscreen) && !(typeof fullscreen.contains === 'function' && fullscreen.contains(wrapper))) return true;
            return Boolean(size && !(size.width > 0 && size.height > 0));
        }

        function readPlayerSize() {
            const iframe = wrapper.querySelector('iframe');
            if (iframe && typeof iframe.getBoundingClientRect === 'function') {
                try {
                    const rect = iframe.getBoundingClientRect();
                    if (rect && Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width >= 0 && rect.height >= 0) return { width: rect.width, height: rect.height };
                } catch (_) {}
            }
            const rect = wrapper.getBoundingClientRect();
            return { width: rect.width, height: rect.height };
        }

        function setMode(mode) {
            wrapper.dataset.streamQualityMode = playbackBlocked ? 'playback-blocked' : mode;
            wrapper.dataset.streamPlaybackBlocked = String(playbackBlocked);
        }

        function cancelResize() {
            if (resizeTimer !== null) root.clearTimeout(resizeTimer);
            resizeTimer = null;
        }

        function cancelStartup() {
            if (startupTimer !== null) root.clearTimeout(startupTimer);
            startupTimer = null;
            if (startupFollowupTimer !== null) root.clearTimeout(startupFollowupTimer);
            startupFollowupTimer = null;
        }

        function startupFollowupVisible() {
            if (contextUnavailable() || contextSuspended || contextSettling) return false;
            const iframe = wrapper.querySelector('iframe');
            if (!iframe || typeof iframe.getBoundingClientRect !== 'function') return false;
            try {
                if (typeof iframe.checkVisibility === 'function' && !iframe.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
                const rect = iframe.getBoundingClientRect();
                if (!(rect.width >= 400 && rect.height >= 300)) return false;
                const viewportWidth = root.innerWidth || doc.documentElement && doc.documentElement.clientWidth;
                const viewportHeight = root.innerHeight || doc.documentElement && doc.documentElement.clientHeight;
                if (!(viewportWidth > 0 && viewportHeight > 0) || ![rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)) return false;
                let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
                let right = Math.min(viewportWidth, rect.right), bottom = Math.min(viewportHeight, rect.bottom);
                if (typeof root.getComputedStyle === 'function') {
                    for (let ancestor = iframe.parentElement; ancestor; ancestor = ancestor.parentElement) {
                        const style = root.getComputedStyle(ancestor);
                        const clipX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
                        const clipY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
                        if (!clipX && !clipY) continue;
                        const clip = ancestor.getBoundingClientRect();
                        if (clipX) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
                        if (clipY) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
                    }
                }
                return Math.max(0, right - left) * Math.max(0, bottom - top) >= rect.width * rect.height * 0.5;
            } catch (_) { return false; }
        }

        function scheduleStartupFollowup() {
            if (disposed || hasPlayed || playbackPaused || playbackBlocked || contextSuspended || contextSettling) return;
            startupFollowupTimer = root.setTimeout(() => {
                startupFollowupTimer = null;
                if (disposed || !ready || hasPlayed || playbackPaused || playbackBlocked || !wrapper.isConnected || !startupFollowupVisible()) return;
                // This is one check for an unconfirmed startup, not a pause or
                // network diagnosis. A cached isPaused=false does not confirm
                // that video started; only the first PLAYING cancels the check.
                if (publicCall('getEnded') !== false) return;
                requestPlay();
            }, STARTUP_FOLLOWUP_DELAY_MS);
        }

        function scheduleStartupPlayback() {
            if (disposed || !ready || hasPlayed || playbackPaused || playbackBlocked || startupPlayAttempted || startupTimer !== null || contextSuspended || contextSettling || contextUnavailable()) return;
            startupTimer = root.setTimeout(() => {
                startupTimer = null;
                if (disposed || !ready || hasPlayed || playbackPaused || playbackBlocked || startupPlayAttempted || !wrapper.isConnected || contextUnavailable() || contextSuspended || contextSettling) return;
                startupPlayAttempted = true;
                if (requestPlay()) scheduleStartupFollowup();
            }, STARTUP_PLAY_DELAY_MS);
        }

        function suspendContext() {
            if (!contextSuspended) {
                // A user PAUSE can arrive during our quality-switch guard. Consult
                // the current public state too; unknown/paused is not resume consent.
                resumeEligible = hasPlayed && !playbackPaused && !playbackBlocked && publicCall('isPaused') === false;
                contextPauseObserved = false;
                automaticResumeAttempted = false;
            }
            contextSuspended = true;
            contextSettling = false;
            if (contextTimer !== null) root.clearTimeout(contextTimer);
            contextTimer = null;
            cancelResize();
            cancelStartup();
            clearRetries();
            stopHealthChecks();
            finishQualitySwitch();
            setMode('paused-context');
        }

        function markPlaybackBlocked() {
            if (disposed) return;
            setPlaybackState('blocked');
            playbackBlocked = true;
            cancelStartup();
            automaticResumeAttempted = true;
            resumeEligible = false;
            stopHealthChecks();
            setMode('playback-blocked');
        }

        function requestPlay() {
            if (!player || typeof player.play !== 'function') return false;
            try {
                const result = player.play();
                if (result && typeof result.catch === 'function') result.catch(markPlaybackBlocked);
                return true;
            } catch (_) { markPlaybackBlocked(); return false; }
        }

        function settleContext() {
            if (contextSettling || disposed) return;
            contextSettling = true;
            setMode('recovering');
            contextTimer = root.setTimeout(() => {
                contextTimer = null;
                if (disposed || !wrapper.isConnected) return;
                lastSize = readPlayerSize();
                if (contextUnavailable(lastSize)) { suspendContext(); return; }
                contextSettling = false;
                emptyBufferSamples = 0;
                fixedSince = Date.now();
                playbackStartedAt = Date.now();
                const actuallyPaused = publicCall('isPaused') === true;
                if (resumeEligible && contextPauseObserved && !playbackPaused && !playbackBlocked && !automaticResumeAttempted && actuallyPaused) {
                    automaticResumeAttempted = true;
                    requestPlay();
                }
                resumeEligible = false;
                contextPauseObserved = false;
                verifyAfterContext = !playbackPaused && !recoveryAuto && !networkAuto;
                refreshMetadata();
                scheduleStartupPlayback();
            }, CONTEXT_SETTLE_MS);
        }

        function updateContext(size) {
            if (disposed) return true;
            if (size) lastSize = size;
            if (contextUnavailable(size || lastSize)) { suspendContext(); return true; }
            if (contextSuspended) {
                contextSuspended = false;
                settleContext();
            }
            return contextSettling;
        }

        function contextChanged() {
            if (disposed || !wrapper.isConnected) return;
            if (!updateContext(readPlayerSize())) scheduleResize();
        }

        function checkHealth() {
            healthTimer = null;
            if (disposed) return;
            if (contextUnavailable()) { suspendContext(); return; }
            if (contextSuspended || contextSettling) return;
            if (disposed || !ready || !hasPlayed || playbackPaused || !wrapper.isConnected || !isMultiView() || isFullscreen() || networkAuto || !lastRequested || lastRequested === 'auto') return;
            const stats = publicCall('getPlaybackStats');
            const buffer = stats && stats.bufferSize;
            const paused = publicCall('isPaused');
            const ended = publicCall('getEnded');
            const knownCurrentRendition = normalizeTwitchQualities(publicCall('getQualities')).find(quality => quality.group === lastRequested && quality.width > 0 && quality.height > 0);
            const nativeResolution = stats && typeof stats.videoResolution === 'string' ? /^(\d+)x(\d+)$/.exec(stats.videoResolution) : null;
            const normalRendition = knownCurrentRendition && publicCall('getQuality') === lastRequested && nativeResolution && Number(nativeResolution[1]) === Math.round(knownCurrentRendition.width) && Number(nativeResolution[2]) === Math.round(knownCurrentRendition.height);
            const fps = stats && stats.fps;
            const rate = stats && stats.playbackRate;
            const validFps = typeof fps === 'number' && Number.isFinite(fps) && fps >= 0;
            const validRate = typeof rate === 'number' && Number.isFinite(rate) && rate >= 0;
            const healthyPlayback = validFps && fps > 0 || validRate && rate > 0;
            const stalledPlayback = !healthyPlayback && (validFps && fps === 0 || validRate && rate === 0);
            // Low-latency playback can report an empty buffer while decoding normally.
            // A waiting autoplay prompt also has zeroed stats, so require PLAYING first.
            if (paused || ended || !normalRendition || !stalledPlayback || Date.now() - Math.max(fixedSince, playbackStartedAt) < STARTUP_GRACE_MS || typeof buffer !== 'number' || !Number.isFinite(buffer) || buffer < 0) emptyBufferSamples = 0;
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
            if (!contextSuspended && !contextSettling && !contextUnavailable() && !playbackBlocked && hasPlayed && !playbackPaused && healthTimer === null) healthTimer = root.setTimeout(checkHealth, HEALTH_INTERVAL_MS);
        }

        function meaningfulSizeChange(a, b) {
            return Boolean(a && b && (Math.abs(a.width - b.width) > Math.max(40, a.width * 0.12) || Math.abs(a.height - b.height) > Math.max(40, a.height * 0.12)));
        }

        function evaluate() {
            if (disposed || !ready || !player || !wrapper.isConnected) return false;
            const multi = isMultiView();
            const fullscreen = isFullscreen();
            const size = readPlayerSize();
            if (updateContext(size)) return false;
            if (lastMulti !== null && multi !== lastMulti || networkAuto && meaningfulSizeChange(recoverySize, size)) {
                networkAuto = false;
                recoverySize = null;
            }
            lastMulti = multi;
            lastSize = size;
            if (recoveryAuto && (multi !== recoveryAutoMulti || meaningfulSizeChange(recoveryAutoSize, size))) {
                recoveryAuto = false;
                recoveryAutoSize = null;
            }
            const qualities = publicCall('getQualities');
            const normalized = normalizeTwitchQualities(qualities);
            const hasAuto = normalized.some(quality => quality.group === 'auto');
            autoGroupSeen = autoGroupSeen || hasAuto;
            // The cached rendition list can disappear during a reconnect. Auto remains
            // a supported group once the player has advertised it, so it is safe to retreat.
            const selectable = autoGroupSeen && !hasAuto ? (Array.isArray(qualities) ? qualities : []).concat('auto') : qualities;
            const hasVideoMetadata = normalized.some(quality => quality.group !== 'auto' && quality.group !== 'audio_only' && quality.height > 0);
            if (!hasPlayed && !recoveryAuto) {
                // Let Twitch's own autoplay/ad initialization finish before any
                // rendition change. READY is API readiness, not video playback.
                setMode('starting');
                wrapper.dataset.streamQualityTarget = String(Math.round(Math.min(size.height, size.width * 9 / 16)));
                return true;
            }
            if (verifyAfterContext && hasVideoMetadata && !playbackPaused && publicCall('isPaused') === false && !recoveryAuto && !networkAuto) {
                const current = publicCall('getQuality');
                if (current === 'auto' || normalized.some(quality => quality.group === current && quality.height > 0)) {
                    // The hidden Twitch player may reset to Auto. Reconcile once
                    // after settling; ordinary PLAYING/ONLINE cannot repeat this.
                    verifyAfterContext = false;
                    lastRequested = null;
                }
            }
            const pendingMetadata = multi && !fullscreen && !networkAuto && !recoveryAuto && !hasVideoMetadata && lastRequested && lastRequested !== 'auto';
            const wanted = pendingMetadata ? lastRequested : multi && !fullscreen && !networkAuto && !recoveryAuto
                ? autoGroupSeen ? chooseTwitchQuality(selectable, size.width, size.height) || 'auto' : null
                : autoGroupSeen ? 'auto' : null;
            setMode(recoveryAuto ? 'recovery-auto' : networkAuto && multi && !fullscreen ? 'network-auto' : pendingMetadata ? 'waiting-quality' : wanted && wanted !== 'auto' ? 'size' : 'auto');
            wrapper.dataset.streamQualityTarget = String(Math.round(Math.min(size.height, size.width * 9 / 16)));
            if (wanted && wanted !== lastRequested) {
                const current = publicCall('getQuality');
                const sendRequest = current !== wanted;
                // Commit the request cache before calling into the SDK: public event
                // callbacks can run synchronously from setQuality in some players.
                lastRequested = wanted;
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
                    finishQualitySwitch();
                    stopHealthChecks();
                    return false;
                }
            }
            wrapper.dataset.streamQuality = wanted || publicCall('getQuality') || 'auto';
            if (!pendingMetadata && wanted && wanted !== 'auto' && multi && !fullscreen && !networkAuto && !recoveryAuto) ensureHealthChecks();
            else stopHealthChecks();
            // READY can expose only Auto before the stream's rendition list arrives.
            return hasVideoMetadata;
        }

        function scheduleResize() {
            if (disposed) return;
            if (contextUnavailable()) { suspendContext(); return; }
            if (contextSuspended || contextSettling) return;
            if (resizeTimer !== null) root.clearTimeout(resizeTimer);
            resizeTimer = root.setTimeout(() => { resizeTimer = null; evaluate(); }, RESIZE_DELAY_MS);
        }

        function refreshMetadata() {
            if (disposed || !ready) return;
            if (contextUnavailable()) { suspendContext(); return; }
            if (contextSuspended || contextSettling) return;
            clearRetries();
            if (evaluate() || contextSuspended || contextSettling) return;
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
            setPlaybackState('unknown');
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
                    scheduleStartupPlayback();
                };
                const onOnline = () => {
                    if (disposed) return;
                    if (contextUnavailable()) { suspendContext(); return; }
                    if (contextSuspended || contextSettling) return;
                    // ONLINE is not a reason to repeatedly resend the same fixed
                    // rendition, or to erase the user's existing pause intent.
                    emptyBufferSamples = 0;
                    fixedSince = Date.now();
                    playbackStartedAt = 0;
                    stopHealthChecks();
                    refreshMetadata();
                    scheduleStartupPlayback();
                };
                const onPlaying = () => {
                    if (disposed) return;
                    // Only PLAYING confirms video output; play()/READY/ONLINE do
                    // not. Keep recovery visible if a quality callback arrives
                    // after the public state has already paused or ended.
                    setPlaybackState(publicCall('getEnded') === true ? 'ended' : publicCall('isPaused') === true ? 'paused' : 'playing');
                    cancelStartup();
                    if (contextUnavailable()) { suspendContext(); return; }
                    if (contextSuspended || contextSettling) {
                        hasPlayed = true;
                        playbackPaused = false;
                        resumeEligible = false;
                        playbackBlocked = false;
                        wrapper.dataset.streamPlaybackBlocked = 'false';
                        return;
                    }
                    if (ownQualitySwitch) {
                        finishQualitySwitch();
                        if (!playbackPaused && !hasPlayed) {
                            hasPlayed = true;
                            playbackStartedAt = Date.now();
                        }
                        if (!playbackPaused && lastRequested && lastRequested !== 'auto' && isMultiView() && !isFullscreen() && !networkAuto && !recoveryAuto) ensureHealthChecks();
                        return;
                    }
                    if (!hasPlayed || playbackPaused) playbackStartedAt = Date.now();
                    hasPlayed = true;
                    playbackPaused = false;
                    playbackBlocked = false;
                    wrapper.dataset.streamPlaybackBlocked = 'false';
                    refreshMetadata();
                };
                const onPause = () => {
                    if (disposed) return;
                    // UI state still changes when the quality/context guards
                    // deliberately preserve the existing playback intent.
                    setPlaybackState('paused');
                    if (contextUnavailable()) {
                        suspendContext();
                        contextPauseObserved = true;
                        return;
                    }
                    if (ownQualitySwitch) return;
                    playbackPaused = true;
                    resumeEligible = false;
                    cancelStartup();
                    stopHealthChecks();
                };
                const onOffline = () => { if (!disposed) setPlaybackState('offline'); };
                const onEnded = () => { if (!disposed) setPlaybackState('ended'); };
                for (const [event, callback] of [[sdk.Player.READY, onReady], [sdk.Player.PLAYING, onPlaying], [sdk.Player.ONLINE, onOnline], [sdk.Player.PAUSE, onPause], [sdk.Player.PLAYBACK_BLOCKED, markPlaybackBlocked], [sdk.Player.OFFLINE, onOffline], [sdk.Player.ENDED, onEnded]]) {
                    if (event && typeof player.addEventListener === 'function') {
                        player.addEventListener(event, callback);
                        subscriptions.push([event, callback]);
                    }
                }
                if (typeof root.ResizeObserver === 'function') {
                    observer = new root.ResizeObserver(contextChanged);
                    observer.observe(wrapper);
                }
                root.addEventListener('resize', contextChanged);
                doc.addEventListener('fullscreenchange', contextChanged);
                doc.addEventListener('webkitfullscreenchange', contextChanged);
                doc.addEventListener('visibilitychange', contextChanged);
            } catch (_) {
                releaseSdk();
                mountFallback();
            }
        }

        function setMuted(value, force = false) {
            const muted = Boolean(value);
            if (disposed || !force && desiredMuted === muted) return;
            desiredMuted = muted;
            if (ready) publicCall('setMuted', muted);
            else mutedDirty = true;
            if (fallback) fallback.src = fallbackUrl();
        }

        function recover() {
            if (disposed || !ready || !player || fallback || !wrapper.isConnected || typeof player.play !== 'function') return false;
            const size = readPlayerSize();
            if (contextUnavailable(size)) return false;
            setPlaybackState('recovering');
            if (contextTimer !== null) root.clearTimeout(contextTimer);
            contextTimer = null;
            contextSuspended = false;
            contextSettling = false;
            cancelResize();
            clearRetries();
            cancelStartup();
            stopHealthChecks();
            finishQualitySwitch();
            recoveryAuto = true;
            verifyAfterContext = false;
            recoveryAutoSize = size;
            recoveryAutoMulti = isMultiView();
            lastSize = size;
            networkAuto = false;
            playbackPaused = false;
            playbackBlocked = false;
            resumeEligible = false;
            automaticResumeAttempted = true;
            emptyBufferSamples = 0;
            if (autoGroupSeen) {
                const current = publicCall('getQuality');
                lastRequested = 'auto';
                wrapper.dataset.streamQuality = 'auto';
                if (current !== 'auto' && typeof player.setQuality === 'function') {
                    try { beginQualitySwitch(); player.setQuality('auto'); }
                    catch (_) { finishQualitySwitch(); }
                }
            }
            setMode('recovery-auto');
            return requestPlay();
        }

        function releaseSdk() {
            if (observer) observer.disconnect();
            observer = null;
            root.removeEventListener('resize', contextChanged);
            doc.removeEventListener('fullscreenchange', contextChanged);
            doc.removeEventListener('webkitfullscreenchange', contextChanged);
            doc.removeEventListener('visibilitychange', contextChanged);
            cancelResize();
            if (contextTimer !== null) root.clearTimeout(contextTimer);
            contextTimer = null;
            clearRetries();
            cancelStartup();
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

        return { start, setMuted, refresh: contextChanged, recover, dispose };
    }

    const api = { createTwitchPlayer, chooseTwitchQuality, normalizeTwitchQualities };
    root.StreamQuality = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
