/* =====================================================================================
   ★★★  代理池 (PROXY POOL)  ★★★
   -------------------------------------------------------------------------------------
   多個 Cloudflare Worker 代理輪流使用，避免單一代理超限額。
   新增代理只需往 PROXY_LIST 加網址即可。
   ===================================================================================== */
const PROXY_LIST = [
    'https://young-cloud-e59f.chicktv001.workers.dev',
    'https://wispy-sound-ef1a.for-api.workers.dev'
];
let _proxyIndex = 0;

function getNextProxy() {
    const proxy = PROXY_LIST[_proxyIndex];
    _proxyIndex = (_proxyIndex + 1) % PROXY_LIST.length;
    return proxy;
}

/**
 * 通用：透過代理池輪詢發送請求
 * @param {string} targetUrl  要代理的目標網址
 * @param {'quest'|'raw'} mode 'quest' → 用 ?quest= 拼接；'raw' → 直接接在後面
 */
 const GOSH_PROXY_LIST = [
    'https://gosh.chicktv02.workers.dev',
    'https://dry-wildflower-371d.forgosh.workers.dev'
];
let _goshProxyIndex = 0;

function getNextGoshProxy() {
    const proxy = GOSH_PROXY_LIST[_goshProxyIndex];
    _goshProxyIndex = (_goshProxyIndex + 1) % GOSH_PROXY_LIST.length;
    return proxy;
}
 
function fetchViaProxy(targetUrl, mode = 'quest', signal) {
    const proxy = getNextProxy();
    const url = (mode === 'quest')
        ? `${proxy}/?quest=${encodeURIComponent(targetUrl)}`
        : `${proxy}/${targetUrl}`;
    return fetch(url, { signal });
}

/* =====================================================================================
   ★★★  平台註冊表 (PLATFORM REGISTRY)  ★★★
   -------------------------------------------------------------------------------------
   想新增一個平台？只需要在下面 PLATFORMS 加一個 key 就好，其他程式都不用改。

   每個平台可以填的欄位：
     label          選單上顯示的名稱
     icon           按鈕前面的小圖示
     type           播放器型別，可選：
                      'iframe'       → 一般 iframe (buildUrl 回傳網址)
                      'scaledIframe' → Kick 那種「欺騙大播放器」的縮放 iframe
                      'hls'          → 用 hls.js 播 .m3u8 (id 直接當網址)
                      'flv'          → 用 flv.js 播 .flv   (buildUrl 回傳網址)
     buildUrl(ch, muted) → 回傳播放網址 (iframe / flv 需要)
     allow          iframe 的 allow 屬性 (可選)
     referrerPolicy iframe 的 referrerpolicy (可選)
     aliases        API 回傳的舊平台名稱，例如 ['vl'] 會被對應到 kick
     status(ch)     async 函式，回傳 'live' | 'not-live' | 'unknown' | 'unknown2'
                    ('unknown2' 表示「有開台但無法偵測」→ 亮綠燈)
     idPlaceholder  加台視窗中「頻道ID」欄位的提示文字

   新增範例：
     myplatform: {
         label: 'MyPlatform',
         icon: 'Ⓜ',
         type: 'iframe',
         buildUrl: (ch, muted) => `https://myplatform.com/embed/${ch.id}?mute=${muted ? 1 : 0}`,
         status: async (ch) => {
             const r = await fetch(`https://api.myplatform.com/${ch.id}`);
             const d = await r.json();
             return d.live ? 'live' : 'not-live';
         },
         idPlaceholder: 'MyPlatform 頻道 ID'
     }
   ===================================================================================== */
const PLATFORMS = {
    twitch: {
        label: 'Twitch',
        icon: 'Ⓣ',
        type: 'twitch',
        buildUrl: (ch, muted) =>
            `https://player.twitch.tv/?channel=${ch.id}&parent=${encodeURIComponent(parent)}&muted=${muted}`,
        status: async (ch, signal) => {
            const resp = await fetch(`https://api.twitch.tv/helix/streams?user_login=${ch.id}`, {
                headers: { "Authorization": `Bearer ${TWITCH_TOKEN}`, "Client-Id": TWITCH_CLIENT_ID }, signal
            });
            if (!resp.ok) throw new Error('Twitch status unavailable');
            const data = await resp.json();
            return (data.data && data.data.length > 0) ? 'live' : 'not-live';
        },
        idPlaceholder: 'Twitch 頻道名稱 (英文小寫)'
    },

    kick: {
        label: 'Kick',
        icon: 'Ⓚ',
        type: 'scaledIframe',
        buildUrl: (ch, muted) => `https://player.kick.com/${ch.id}?muted=${muted}&autoplay=true`,
        aliases: ['vl'],
        status: async (ch, signal) => {
            const resp = await fetch(`https://kick.com/api/v2/channels/${ch.id}`, { signal });
            const data = await resp.json();
            return (data.livestream && data.livestream.is_live === true) ? 'live' : 'not-live';
        },
        idPlaceholder: 'Kick 頻道名稱 (例: xqc)'
    },

    ok: {
        label: 'OK.ru',
        icon: 'ⓞ',
        type: 'iframe',
        buildUrl: (ch, muted) =>
            `https://ok.ru/videoembed/${ch.id}?nochat=1&autoplay=1&silent=${muted ? 1 : 0}`,
        aliases: ['okru'],
        status: async (ch, signal) => {
            // ★ 透過代理池輪詢
            const resp = await fetchViaProxy(`https://ok.ru/videoembed/${ch.id}`, 'raw', signal);
            const html = await resp.text();
            const upperText = html.toUpperCase();
            const isOkLive = upperText.includes('STATUS:"ONLINE"') ||
                             upperText.includes('"STATUS":"ONLINE"') ||
                             /\bLIVE\b/.test(upperText);
            return isOkLive ? 'live' : 'not-live';
        },
        idPlaceholder: 'OK.ru 影片 ID (例: 10268974521971)'
    },

    at: {
        label: 'AngelThump',
        icon: 'Ⓐ',
        type: 'iframe',
        buildUrl: (ch, muted) =>
            `https://player.angelthump.com/?channel=${ch.id}${muted ? '&muted=true' : ''}`,
        status: async (ch, signal) => {
            const resp = await fetch(`https://api.angelthump.com/v2/streams/${ch.id}`, { signal });
            if (!resp.ok) return 'not-live';
            const data = await resp.json();
            return data.type === 'live' ? 'live' : 'not-live';
        },
        idPlaceholder: 'AngelThump 頻道名稱'
    },

    m3u8: {
        label: 'M3U8 (HLS)',
        icon: 'Ⓜ',
        type: 'hls',
        status: async () => 'live',
        idPlaceholder: '完整 .m3u8 網址'
    },

    youtube: {
        label: 'YouTube Live',
        icon: 'ⓨ',
        type: 'youtube',
        allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture",
        referrerPolicy: "strict-origin-when-cross-origin",
        buildUrl: (ch, muted) => {
            const muteVal = muted ? "1" : "0";
            const isChannelId = ch.id.startsWith("UC") || ch.id.startsWith("HC") || ch.id.includes("channel");
            return isChannelId
                ? `https://www.youtube.com/embed/live_stream?channel=${ch.id}&autoplay=1&mute=${muteVal}`
                : `https://www.youtube.com/embed/${ch.id}?autoplay=1&mute=${muteVal}`;
        },
        status: async () => 'unknown2',
        idPlaceholder: 'YouTube 頻道 ID (UC...) 或影片 ID'
    },

    bs: {
        label: 'BeamStream (BS)',
        icon: 'Ⓑ',
        type: 'iframe',
        buildUrl: (ch) => ch.id,
        status: async (ch, signal) => {
            const resp = await fetch(`https://r.jina.ai/${ch.id}`, { signal });
            const text = await resp.text();
            if (text.includes("Channel is offline")) return 'not-live';
            if (text.includes("Live")) return 'live';
            return 'unknown';
        },
        idPlaceholder: 'BeamStream 完整 embed 網址'
    },

    vaughn: {
        label: 'Vaughn',
        icon: 'ⓥ',
        type: 'flv',
        buildUrl: (ch, muted) => {
            const originalUrl = `https://stream-cdn-iad3.vaughnsoft.net/play/live_${ch.id}.flv`;
            return `https://cold-frost-3328.chicktv02.workers.dev/?url=${encodeURIComponent(originalUrl)}`;
        },
        status: async (ch, signal) => {
            // ★ 透過代理池輪詢
            const resp = await fetchViaProxy(`https://api.vaughnsoft.net/v1/stream/vl/${ch.id}`, 'quest', signal);
            if (!resp.ok) throw new Error('Vaughn status unavailable');
            const data = await resp.json();
            if (!data || typeof data.live !== 'boolean') throw new Error('Vaughn status unavailable');
            return data.live === true ? 'live' : 'not-live';
        },
        idPlaceholder: 'Vaughn 頻道 ID'
    },
	
	gosh: {
    label: 'Gosh',
    icon: 'Ⓖ',
    type: 'hls',
    status: async (ch) => {
        try {
            const data = await getGoshMetadata(ch);
            return data.isLive === true ? 'live' : 'not-live';
        } catch (e) {
            console.warn('[Gosh status error]', e);
            throw e;
        }
    },
    getStreamUrl: async (ch) => {
        const data = await getGoshMetadata(ch);
        return data.m3u8Url;
    },
    idPlaceholder: 'Gosh 頻道 ID (例: meidingdang0)'
},
	
    goodgame: {
        label: 'GoodGame',
        icon: 'Ⓖ',
        type: 'iframe',
        buildUrl: (ch, muted) =>
            `https://goodgame.ru/player?${ch.id}${muted ? '&muted=1' : ''}`,
        status: async (ch, signal) => {
            try {
                const username = ch.ggUsername || ch.id;
                const api = `https://goodgame.ru/api/4/users/${encodeURIComponent(username)}/stream`;
                // ★ 透過代理池輪詢
                const resp = await fetchViaProxy(api, 'quest', signal);
                if (!resp.ok) throw new Error('GoodGame status unavailable');
                const data = await resp.json();
                if (!data || !data.id) return 'not-live';
                if (data.status === true || data.online === true) return 'live';
                return 'not-live';
            } catch (e) {
                console.warn('[GoodGame status error]', e);
                throw e;
            }
        },
        idPlaceholder: 'GoodGame 頻道名 (例: Pomi)',
        async resolveId(input) {
            const api = `https://goodgame.ru/api/4/users/${encodeURIComponent(input)}/stream`;
            // ★ 透過代理池輪詢
            const resp = await fetchViaProxy(api, 'quest');
            if (!resp.ok) throw new Error('無法連接 GoodGame API');
            const data = await resp.json();
            if (!data || !data.id) throw new Error('找不到該頻道');
            return {
                id: String(data.id),
                ggUsername: data.channelkey || data.streamkey || input
            };
        }
    }
};

/* -------------------------------------------------------------------------------------
   播放器渲染器 (依 type 分派)
   ------------------------------------------------------------------------------------- */
async function loadPlaybackLibrary(name, src) {
    if (globalThis[name]) return globalThis[name];
    if (!window.TVScriptLoader?.load) throw new Error('Playback script loader unavailable');
    await window.TVScriptLoader.load(src, undefined, () => Boolean(globalThis[name]));
    if (!globalThis[name]) throw new Error(name + ' did not initialize');
    return globalThis[name];
}

const RENDERERS = {
    youtube(channel, p, muted, wrapperClass) {
        if (typeof EmbedAudio === 'undefined') return RENDERERS.iframe(channel, p, muted, wrapperClass);
        const wrapper = document.createElement('div');
        wrapper.className = `${wrapperClass} youtube-wrapper`;
        const iframe = RENDERERS.iframe(channel, p, muted, 'youtube-iframe');
        const url = new URL(iframe.src);
        url.searchParams.set('enablejsapi', '1');
        url.searchParams.set('origin', location.origin || `https://${parent}`);
        iframe.src = url.href;
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.border = '0';
        iframe.style.display = 'block';
        wrapper.appendChild(iframe);
        const youtube = EmbedAudio.createYouTubeController(iframe, {
            muted,
            onIframe(frame) {
                frame.style.width = '100%';
                frame.style.height = '100%';
                frame.style.border = '0';
                frame.style.display = 'block';
            },
            onError() {
                if (globalMutedPreference !== null && wrapper.isConnected) showGlobalAudioFeedback({ unsupported: [channel.name], reloaded: 0 });
            }
        });
        const resource = { element: wrapper, video: null, disposed: false, failed: false, hls: null, flv: null, youtube };
        playerResources.set(wrapper, resource);
        queueMicrotask(() => {
            if (!resource.disposed && wrapper.isConnected) youtube.start();
        });
        return wrapper;
    },
    twitch(channel, p, muted, wrapperClass) {
        if (typeof StreamQuality === 'undefined') return RENDERERS.iframe(channel, p, muted, wrapperClass);
        const wrapper = document.createElement('div');
        wrapper.className = `${wrapperClass} twitch-wrapper`;
        const twitch = StreamQuality.createTwitchPlayer(wrapper, {
            channel: channel.id, parent, muted,
            sizeAwareQuality: false,
            isMultiView: () => activePlayers.size > 1,
            fallbackUrl: p.buildUrl(channel, muted)
        });
        const resource = { element: wrapper, video: null, disposed: false, failed: false, hls: null, flv: null, twitch };
        playerResources.set(wrapper, resource);
        queueMicrotask(async () => {
            if (resource.disposed || !wrapper.isConnected) return;
            await twitch.start();
            if (resource.disposed || !wrapper.isConnected || typeof twitch.recover !== 'function' || wrapper.dataset.streamQualityMode === 'platform-auto') return;
            const recoverButton = document.createElement('button');
            recoverButton.type = 'button';
            recoverButton.className = 'twitch-recover-button';
            recoverButton.textContent = '↻ 恢復播放';
            recoverButton.title = '嘗試恢復 Twitch 播放';
            recoverButton.addEventListener('click', () => {
                recoverButton.textContent = twitch.recover() ? '↻ 恢復播放' : '稍後再試';
            });
            wrapper.appendChild(recoverButton);
            twitch.refresh();
        });
        return wrapper;
    },

    iframe(channel, p, muted, wrapperClass) {
        const iframe = document.createElement('iframe');
        iframe.className = wrapperClass;
        iframe.src = p.buildUrl(channel, muted);
        iframe.allowFullscreen = true;
        iframe.loading = 'lazy';
        iframe.allow = p.allow || "autoplay; fullscreen; encrypted-media";
        if (p.referrerPolicy) iframe.referrerPolicy = p.referrerPolicy;
        return iframe;
    },

    scaledIframe(channel, p, muted, wrapperClass) {
        const wrapper = document.createElement('div');
        wrapper.className = `${wrapperClass} kick-wrapper`;
        const iframe = document.createElement('iframe');
        iframe.className = 'kick-iframe';
        iframe.src = p.buildUrl(channel, muted);
        iframe.allowFullscreen = true;
        iframe.loading = 'lazy';
        iframe.allow = p.allow || "autoplay; fullscreen; encrypted-media";
        wrapper.appendChild(iframe);
        return wrapper;
    },

    hls(channel, p, muted, wrapperClass) {
        const video = document.createElement('video');
        video.className = `hls-video-element ${wrapperClass}`;
        video.controls = true;
        video.autoplay = true;
        video.muted = muted;
        video.playsInline = true;
        const resource = { video, element: video, disposed: false, failed: false, hls: null, flv: null };
        playerResources.set(video, resource);
        let nativeStreamUrl = null;
        video.addEventListener('error', () => {
            if (resource.disposed || !video.isConnected) return;
            // A browser may advertise native HLS but reject this particular
            // stream. Keep the existing hls.js path as a one-time fallback.
            if (nativeStreamUrl) {
                const streamUrl = nativeStreamUrl;
                nativeStreamUrl = null;
                video.pause();
                video.removeAttribute('src');
                video.load();
                void initHls(streamUrl);
            } else { resource.failed = true; video.pause(); }
        });

        const initHls = async streamUrl => {
            try {
                const HlsPlayer = await loadPlaybackLibrary('Hls', 'https://cdn.jsdelivr.net/npm/hls.js@latest');
                if (resource.disposed || !video.isConnected) return;
                if (!HlsPlayer.isSupported()) {
                    replacePlayerWithError(resource, '⚠️ 瀏覽器不支援 HLS');
                    return;
                }
                const hls = new HlsPlayer(HLS_CONFIG);
                resource.hls = hls;
                currentHLSInstances.push(hls);
                hls.on(HlsPlayer.Events.MANIFEST_PARSED, () => {
                    if (!resource.disposed && resource.hls === hls && video.isConnected) video.play().catch(() => {});
                });
                hls.on(HlsPlayer.Events.ERROR, (event, data) => {
                    if (data && data.fatal && !resource.disposed && resource.hls === hls) {
                        replacePlayerWithError(resource, '⚠️ 無法播放直播，請再試一次');
                        currentHLSInstances = currentHLSInstances.filter(instance => instance !== hls);
                        resource.hls = null;
                        try { hls.destroy(); } catch (error) {}
                    }
                });
                hls.loadSource(streamUrl);
                hls.attachMedia(video);
            } catch (error) {
                if (resource.hls) {
                    const hls = resource.hls;
                    resource.hls = null;
                    currentHLSInstances = currentHLSInstances.filter(instance => instance !== hls);
                    try { hls.destroy(); } catch (_) {}
                }
                if (resource.disposed || !video.isConnected) return;
                console.warn('[HLS initialization error]', error);
                replacePlayerWithError(resource, '⚠️ 播放器載入失敗，請重新選台再試');
            }
        };

        // 建立一個非同步函式來處理具有時效性的動態網址
        const initPlayer = async () => {
            if (resource.disposed || !video.isConnected) return;
            let streamUrl = channel.id; // 預設使用頻道 ID 作為網址（相容舊有 m3u8 平台）
            
            // 如果該平台有定義 getStreamUrl (例如 gosh)，就動態獲取最新的網址
            if (p.getStreamUrl) {
                try {
                    streamUrl = await p.getStreamUrl(channel);
                    if (resource.disposed || !video.isConnected) return;
                    if (!streamUrl) throw new Error("無法獲取 m3u8 網址");
                } catch (e) {
                    if (resource.disposed || !video.isConnected) return;
                    console.warn('[HLS getStreamUrl error]', e);
                    replacePlayerWithError(resource, '⚠️ 直播主已離線');
                    return; 
                }
            }

            // Native HLS needs no library download (notably on iOS/Safari).
            if (video.canPlayType?.('application/vnd.apple.mpegurl')) {
                nativeStreamUrl = streamUrl;
                video.src = streamUrl;
            } else await initHls(streamUrl);
        };

        // 呼叫執行
        queueMicrotask(initPlayer);
        return video;
    },

    flv(channel, p, muted, wrapperClass) {
        const video = document.createElement('video');
        video.className = `hls-video-element ${wrapperClass}`;
        video.controls = true;
        video.autoplay = true;
        video.muted = muted;
        video.playsInline = true;
        const resource = { video, element: video, disposed: false, failed: false, hls: null, flv: null };
        playerResources.set(video, resource);
        video.addEventListener('error', () => {
            if (!resource.disposed) { resource.failed = true; video.pause(); }
        });
        queueMicrotask(async () => {
            if (resource.disposed || !video.isConnected) return;
            try {
                const FlvPlayer = await loadPlaybackLibrary('flvjs', './flv.min.js');
                if (resource.disposed || !video.isConnected) return;
                if (!FlvPlayer.isSupported()) {
                    replacePlayerWithError(resource, '⚠️ 瀏覽器不支援 FLV.js，無法播放 .flv 格式');
                    return;
                }
                const flvPlayer = FlvPlayer.createPlayer({
                    type: 'flv', url: p.buildUrl(channel, video.muted), isLive: true, cors: true
                });
                resource.flv = flvPlayer;
                currentFLVInstances.push(flvPlayer);
                flvPlayer.on(FlvPlayer.Events.ERROR, () => {
                    if (resource.disposed || resource.flv !== flvPlayer) return;
                    replacePlayerWithError(resource, '⚠️ 無法播放直播，請再試一次');
                    resource.flv = null;
                    currentFLVInstances = currentFLVInstances.filter(instance => instance !== flvPlayer);
                    for (const method of ['pause', 'unload', 'detachMediaElement', 'destroy']) {
                        try { flvPlayer[method](); } catch (error) {}
                    }
                    try { video.pause(); video.removeAttribute('src'); video.load(); } catch (error) {}
                });
                flvPlayer.attachMediaElement(video);
                if (resource.flv !== flvPlayer || resource.disposed) return;
                flvPlayer.load();
                if (resource.flv !== flvPlayer || resource.disposed) return;
                Promise.resolve(flvPlayer.play()).catch(() => {});
            } catch (error) {
                if (resource.flv) {
                    const flv = resource.flv;
                    resource.flv = null;
                    currentFLVInstances = currentFLVInstances.filter(instance => instance !== flv);
                    for (const method of ['pause', 'unload', 'detachMediaElement', 'destroy']) {
                        try { flv[method](); } catch (_) {}
                    }
                }
                if (resource.disposed || !video.isConnected) return;
                console.warn('[FLV initialization error]', error);
                replacePlayerWithError(resource, '⚠️ 播放器載入失敗，請重新選台再試');
            }
        });
        return video;
    }
};

function buildErrorDiv(msg) {
    const d = document.createElement('div');
    d.style.cssText = 'color:var(--red);display:flex;align-items:center;justify-content:center;width:100%;height:100%;';
    d.textContent = msg;
    return d;
}

/* ======================== 全域變數 ======================== */
let TWITCH_TOKEN = "";
let TWITCH_CLIENT_ID = "";
let channels = [];
let channelStatuses = {};
const channelOptionControls = new Map();
let channelOptionSequence = 0;
let currentHLSInstances = [];
let currentFLVInstances = [];
let currentDisplayChannel = null;
const activePlayers = new Map();
const playerResources = new WeakMap();
const PLAYER_POSITION_STORAGE_KEY = 'playerPositionOrder';
const PLAYER_ENLARGEMENT_STORAGE_KEY = 'playerEnlargementLayout';
// Shared duration for the viewing page's temporary menus and editing overlays.
const PLAYER_OVERLAY_TIMEOUT_SECONDS = 30;
let preferredPlayerOrder = [];
let enlargedPlayerFocus = null;
let playerGeometry = null;
let pendingPlayerGeometry = null;
let playerPositionEditor = null;
let playerNameOverlay = null;
let playerWindowControls = null;
let playerGrid = null;
let layoutBookmarkMenu = null;
let layoutBookmarkFeedbackTimer = null;
let globalMutedPreference = null;
let globalAudioFeedbackTimer = null;
const statusScheduler = StreamPerformance.createStatusScheduler({ maxConcurrent: 4, cacheMs: 30000 });
const goshMetadataRequests = StreamPerformance.createInFlightCoalescer();
const parent = location.hostname || "localhost";

function getGlobalMuted(count = activePlayers.size) {
    return globalMutedPreference === null ? count > 1 : globalMutedPreference;
}

function acceptPlayerAudioPreference(event) {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin ||
        !data || data.channel !== 'umininn-tv-player' || data.version !== 1 ||
        data.type !== 'site:audio-preference' || typeof data.muted !== 'boolean') return;
    // The extension has already applied audio in each authorized frame. Record
    // only the preference so changing the selection cannot undo it or reload a frame.
    globalMutedPreference = data.muted;
    activePlayers.forEach(entry => { entry.muted = data.muted; });
}
if (typeof window !== 'undefined') window.addEventListener('message', acceptPlayerAudioPreference);

function updateGlobalAudioButton() {
    const button = document.getElementById('toggle-all-audio');
    if (!button || button.tagName !== 'BUTTON') return;
    const muted = getGlobalMuted();
    button.textContent = muted ? '🔊 全部開聲' : '🔇 全部靜音';
    button.setAttribute('aria-pressed', String(muted));
}

function getFrameAudioUrl(frame, channel, muted) {
    if (!frame || !frame.src) return null;
    try {
        const url = new URL(frame.src, location.href);
        if (channel.platform === 'kick' && url.hostname === 'player.kick.com' ||
            channel.platform === 'twitch' && url.hostname === 'player.twitch.tv') {
            url.searchParams.set('muted', String(muted));
        } else if (channel.platform === 'ok' && url.hostname === 'ok.ru') {
            url.searchParams.delete('muted');
            url.searchParams.set('silent', muted ? '1' : '0');
        } else return null;
        return url.href;
    } catch (_) { return null; }
}

function showGlobalAudioFeedback(result) {
    const output = document.getElementById('global-audio-feedback');
    if (!output || output.id !== 'global-audio-feedback') return;
    const messages = [];
    if (result.unsupported.length) messages.push(`${result.unsupported.length} 台需手動調聲`);
    if (result.reloaded) messages.push(`${result.reloaded} 台重載`);
    output.textContent = messages.join('；');
    output.title = result.unsupported.length ? `${result.unsupported.join('、')} 暫不支援同步聲音，請在播放器內調整。` : '部分外站播放器已重新載入以切換聲音。';
    output.hidden = !messages.length;
    if (globalAudioFeedbackTimer !== null) clearTimeout(globalAudioFeedbackTimer);
    if (!output.hidden) globalAudioFeedbackTimer = setTimeout(() => { output.hidden = true; globalAudioFeedbackTimer = null; }, 6000);
}

function toggleAllAudio() {
    const muted = !getGlobalMuted();
    globalMutedPreference = muted;
    const result = { muted, reloaded: 0, unsupported: [] };
    function apply(entry) {
        const resource = entry.resource;
        if (entry.failed || resource?.disposed || resource?.failed) return;
        try {
            if (resource?.video) resource.video.muted = muted;
            else if (resource?.twitch) {
                resource.twitch.setMuted(muted, true);
                if (resource.element.dataset?.streamQualityMode === 'platform-auto') result.reloaded++;
            } else if (resource?.youtube) {
                if (resource.youtube.setMuted(muted, true) === false) { result.unsupported.push(entry.channel.name); return; }
            } else {
                const element = resource ? resource.element : entry.element;
                const frame = element.tagName === 'IFRAME' ? element : element.querySelector?.('iframe') || Array.from(element.children).find(child => child.tagName === 'IFRAME');
                const url = getFrameAudioUrl(frame, entry.channel, muted);
                if (!url) { result.unsupported.push(entry.channel.name || entry.channel.platform); return; }
                // These platforms expose audio only as an embed URL option.
                frame.src = url;
                result.reloaded++;
            }
            entry.muted = muted;
        } catch (_) { result.unsupported.push(entry.channel.name || entry.channel.platform); }
    }
    activePlayers.forEach(apply);
    if (!activePlayers.size) {
        const initial = document.getElementById('MyFrame');
        if (initial?.tagName === 'IFRAME' && initial.isConnected) apply({ element: initial, channel: { platform: 'ok', name: 'OK.ru' } });
    }
    updateGlobalAudioButton();
    showGlobalAudioFeedback(result);
    return result;
}

let channelReloadPromise = null;
let channelReloadQueued = false;

const HLS_CONFIG = {
    enableWorker: true,
    capLevelToPlayerSize: true,
    maxBufferLength: 15,
    maxMaxBufferLength: 30
};

function getGoshMetadata(channel) {
    return goshMetadataRequests.run(channel.id, () => StreamPerformance.withRequestTimeout(async signal => {
        const proxy = getNextGoshProxy();
        const response = await fetch(`${proxy}/?channelId=${encodeURIComponent(channel.id)}`, { signal });
        if (!response.ok) throw new Error('Gosh channel unavailable');
        return response.json();
    }));
}

function replacePlayerWithError(resource, message) {
    if (resource.disposed || resource.errorShown || !resource.element.isConnected) return;
    const error = buildErrorDiv(message);
    error.style.order = resource.element.style.order;
    error.style.gridArea = resource.element.style.gridArea;
    resource.element.replaceWith(error);
    resource.element = error;
    resource.failed = true;
    resource.errorShown = true;
}

/* ======================== 平台工具函式 ======================== */
function getPlatform(key) {
    if (!key) return null;
    return PLATFORMS[String(key).toLowerCase()] || null;
}

function platformIcon(key) {
    const p = getPlatform(key);
    return p ? p.icon : '📺';
}

function platformLabel(key) {
    const p = getPlatform(key);
    return p ? p.label : (key || '未知');
}

function resolvePlatform(raw) {
    if (!raw) return null;
    const lower = String(raw).toLowerCase();
    if (PLATFORMS[lower]) return lower;
    for (const [key, p] of Object.entries(PLATFORMS)) {
        if (p.aliases && p.aliases.includes(lower)) return key;
    }
    return null;
}

/* ------------------------ 核心播放銷毀 ------------------------ */
function disposePlayer(entry) {
    const resource = entry.resource;
    const element = resource ? resource.element : entry.element;
    if (resource) {
        resource.disposed = true;
        try { resource.twitch?.dispose(); } catch (error) {}
        try { resource.youtube?.dispose(); } catch (error) {}
        if (resource.video) { try { resource.video.pause(); } catch (error) {} }
        if (resource.hls) {
            const hls = resource.hls;
            resource.hls = null;
            currentHLSInstances = currentHLSInstances.filter(instance => instance !== hls);
            try { hls.destroy(); } catch (error) {}
        }
        if (resource.flv) {
            const flv = resource.flv;
            resource.flv = null;
            for (const method of ['pause', 'unload', 'detachMediaElement', 'destroy']) {
                try { flv[method](); } catch (error) {}
            }
            currentFLVInstances = currentFLVInstances.filter(instance => instance !== flv);
        }
        if (resource.video) { try { resource.video.removeAttribute('src'); resource.video.load(); } catch (error) {} }
    }
    element.remove();
}

function destroyAllHLSInstances() {
    playerPositionEditor?.close(false);
    activePlayers.forEach(disposePlayer);
    activePlayers.clear();
    currentHLSInstances.forEach(instance => { try { instance.destroy(); } catch (error) {} });
    currentFLVInstances.forEach(instance => { try { instance.destroy(); } catch (error) {} });
    currentHLSInstances = [];
    currentFLVInstances = [];
    updateGlobalAudioButton();
}

function renderChannelElement(channel, muted, wrapperClass) {
    const p = getPlatform(channel.platform);
    if (!p) return buildErrorDiv(`⚠️ 未知平台: ${channel.platform}`);
    const renderer = RENDERERS[p.type] || RENDERERS.iframe;
    return renderer(channel, p, muted, wrapperClass);
}

/* ------------------------ 單台觀看 ------------------------ */
function getPlayerElement(entry) {
    return entry.resource ? entry.resource.element : entry.element;
}

function updatePlayerLayout({ force = false } = {}) {
    const pane = document.getElementById('multi-stream-container');
    if (!pane) return;
    if (!playerGrid) playerGrid = PlayerLayout.observe(pane, {
        runUpdate: action => withPlayerAudioLayout(action),
        stabilizeResize: true,
        getResizeStability: () => activePlayers.size > 1 && activePlayers.has(enlargedPlayerFocus?.key),
        getCount: () => activePlayers.size,
        getTrackCount: () => {
            const focus = activePlayers.size > 1 && activePlayers.has(enlargedPlayerFocus?.key) ? enlargedPlayerFocus : null;
            return Math.max(activePlayers.size + (focus?.span || 1) - 1, focus ? focus.row + focus.span : 1,
                focus ? Math.max(pendingPlayerGeometry?.columns || 0, playerGeometry?.columns || 0) : 1);
        },
        calculate(options) {
            const keys = getPlayerPositionKeys();
            const focus = keys.includes(enlargedPlayerFocus?.key) && keys.length > 1 ? enlargedPlayerFocus : null;
            if (!focus) {
                if (pendingPlayerGeometry?.intent === 'bookmark') {
                    const columns = Math.max(1, Math.min(keys.length || 1, pendingPlayerGeometry.columns));
                    // Apply the saved grid once, then keep the existing resize
                    // stability rules. Hidden panes retain the restore intent.
                    if (options.width > 0 && options.height > 0) pendingPlayerGeometry = null;
                    return { count: keys.length, columns, rows: Math.max(1, Math.ceil(keys.length / columns)), area: 0 };
                }
                pendingPlayerGeometry = null;
                return PlayerLayout.choose(options);
            }
            if (!(options.width > 0 && options.height > 0)) {
                // A hidden fallback grid must not overwrite the saved anchor.
                // Keep pending size/restore intent until there is a real pane.
                const columns = Math.max(focus.span, Math.min(Math.max(pendingPlayerGeometry?.columns || 0,
                    options.previous?.columns || 0, focus.column + focus.span), focus.span + keys.length - 1));
                return { ...PlayerGeometry.build({ keys, columns, focus }), count: keys.length, deferredFocus: true };
            }
            let next;
            if (pendingPlayerGeometry?.intent === 'bookmark') {
                next = PlayerGeometry.build({ keys, columns: pendingPlayerGeometry.columns, focus });
                pendingPlayerGeometry = null;
            } else if (pendingPlayerGeometry?.intent === 'size' || pendingPlayerGeometry?.intent === 'restore') {
                // Explicit sizing and reopening settle on the best grid immediately.
                pendingPlayerGeometry = null;
                next = PlayerGeometry.choose({ ...options, keys, focus, force: true });
            } else if (pendingPlayerGeometry?.intent === 'drag') {
                // The preview already chose these tracks and the opposite corner.
                next = PlayerGeometry.build({ keys, columns: pendingPlayerGeometry.columns, focus });
                pendingPlayerGeometry = null;
            } else if (pendingPlayerGeometry) {
                // A saved grid may have come from a much larger selection.
                const columns = Math.max(focus.span, Math.min(pendingPlayerGeometry.columns, focus.span + keys.length - 1));
                next = PlayerGeometry.build({ keys, columns, focus });
                pendingPlayerGeometry = null;
            } else if (options.preserveColumns && options.previous?.columns >= focus.span &&
                options.previous.columns <= 768) {
                next = PlayerGeometry.build({ keys, columns: options.previous.columns, focus });
            } else next = PlayerGeometry.choose({ ...options, keys, focus });
            return { ...next, count: keys.length };
        },
        onChange(next) {
            playerGeometry = next.items ? next : null;
            if (playerGeometry) {
                if (!next.deferredFocus) enlargedPlayerFocus = playerGeometry.items.find(item => item.span > 1) || enlargedPlayerFocus;
                const visual = [...next.items].sort((a, b) => a.row - b.row || a.column - b.column);
                visual.forEach((item, index) => {
                    const element = getPlayerElement(activePlayers.get(item.key));
                    element.style.order = String(index);
                    element.style.gridArea = playerGridArea(item);
                });
                savePlayerEnlargement();
            } else activePlayers.forEach(entry => { getPlayerElement(entry).style.gridArea = ''; });
            playerPositionEditor?.layoutChanged?.();
            playerNameOverlay?.refresh();
            playerWindowControls?.refresh();
        }
    });
    const previousFocus = playerGeometry?.items.find(item => item.span > 1);
    const activeFocus = activePlayers.size > 1 && activePlayers.has(enlargedPlayerFocus?.key) ? enlargedPlayerFocus : null;
    const contextChanged = previousFocus?.key !== activeFocus?.key || previousFocus?.span !== activeFocus?.span;
    playerGrid.update({ force: force || contextChanged || pendingPlayerGeometry?.intent === 'bookmark' });
    // A retry may replace one player while keeping exactly the same geometry.
    if (playerGeometry) playerGeometry.items.forEach(item => {
        const entry = activePlayers.get(item.key);
        if (entry) getPlayerElement(entry).style.gridArea = playerGridArea(item);
    });
    playerWindowControls?.refresh();
}

function playerGridArea(item) {
    return `${item.row + 1} / ${item.column + 1} / span ${item.span} / span ${item.span}`;
}

function getCurrentPlayerGeometry() {
    return playerGeometry || PlayerGeometry.build({ keys: getPlayerPositionKeys(), columns: playerGrid?.getColumns() || 1 });
}

function savePlayerEnlargement() {
    try {
        if (!enlargedPlayerFocus) localStorage.removeItem(PLAYER_ENLARGEMENT_STORAGE_KEY);
        else localStorage.setItem(PLAYER_ENLARGEMENT_STORAGE_KEY, JSON.stringify({
            version: 1, columns: pendingPlayerGeometry?.columns || playerGeometry?.columns || 1, focus: enlargedPlayerFocus
        }));
    } catch (_) {}
}

function applyPlayerSize(next, { optimize = true } = {}) {
    // Capture the reflowed order before the final shrink returns to normal tracks.
    [...next.items].sort((a, b) => a.row - b.row || a.column - b.column).forEach((item, index) => {
        getPlayerElement(activePlayers.get(item.key)).style.order = String(index);
    });
    enlargedPlayerFocus = next.items.find(item => item.span > 1) || null;
    pendingPlayerGeometry = enlargedPlayerFocus ? { ...next, intent: optimize ? 'size' : 'drag' } : null;
    updatePlayerLayout({ force: true });
    const keys = getPlayerPositionKeys();
    preferredPlayerOrder = keys.concat(preferredPlayerOrder.filter(saved => !keys.includes(saved))).slice(0, 256);
    try { localStorage.setItem(PLAYER_POSITION_STORAGE_KEY, JSON.stringify(preferredPlayerOrder)); } catch (_) {}
    savePlayerEnlargement();
    playerPositionEditor?.refresh();
    playerNameOverlay?.refresh();
    return true;
}

function enlargePlayer(key) {
    if (activePlayers.size < 2 || !activePlayers.has(key)) return false;
    if (enlargedPlayerFocus?.key === key && enlargedPlayerFocus.span >= 256) return false;
    return applyPlayerSize(PlayerGeometry.grow(getCurrentPlayerGeometry(), key));
}

function shrinkPlayer(key) {
    if (activePlayers.size < 2 || !activePlayers.has(key)) return false;
    const current = playerGeometry?.items.find(item => item.key === key);
    if (!current || current.span <= 1) return false;
    return applyPlayerSize(PlayerGeometry.shrink(playerGeometry, key));
}

function closePlayer(key) {
    const pane = document.getElementById('multi-stream-container');
    const entry = activePlayers.get(key);
    const initial = key === 'initial-player' && !activePlayers.size && pane?.querySelector('#MyFrame');
    if (!entry && !initial) return false;
    const muted = getGlobalMuted();
    if (entry) { disposePlayer(entry); activePlayers.delete(key); }
    else initial.remove();
    // A close must not re-render retained players or apply the 2-to-1 audio rule.
    if (globalMutedPreference === null && activePlayers.size && muted !== getGlobalMuted()) globalMutedPreference = muted;
    if (enlargedPlayerFocus?.key === key || activePlayers.size < 2) {
        enlargedPlayerFocus = null;
        pendingPlayerGeometry = null;
        savePlayerEnlargement();
    }
    currentDisplayChannel = activePlayers.size === 1 ? activePlayers.values().next().value.channel : null;
    activePlayers.forEach(retained => {
        const element = getPlayerElement(retained);
        element.classList.toggle('full-screen-video', activePlayers.size === 1);
        element.classList.toggle('video', activePlayers.size > 1);
    });
    for (const input of document.querySelectorAll('#channel-options input[type="checkbox"]')) {
        if (ChannelList.channelKey({ id: input.value, platform: input.dataset.platform, name: input.dataset.name || 'channel' }) === key) {
            input.checked = false;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }
    if (!activePlayers.size && pane) {
        const message = document.createElement('div');
        message.style.cssText = 'color:var(--label-2);text-align:center;padding:2rem';
        message.textContent = '未選擇任何頻道';
        pane.replaceChildren(message);
    }
    updatePlayerLayout();
    updateGlobalAudioButton();
    playerPositionEditor?.refresh();
    playerNameOverlay?.refresh();
    playerWindowControls?.refresh();
    return true;
}

function getPlayerPositionKeys() {
    return Array.from(activePlayers.keys()).sort((a, b) =>
        Number(getPlayerElement(activePlayers.get(a)).style.order) -
        Number(getPlayerElement(activePlayers.get(b)).style.order));
}

function swapPlayerPositions(sourceKey, targetKey) {
    const keys = getPlayerPositionKeys();
    const sourceIndex = keys.indexOf(sourceKey);
    const targetIndex = keys.indexOf(targetKey);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return false;
    [keys[sourceIndex], keys[targetIndex]] = [keys[targetIndex], keys[sourceIndex]];
    if (playerGeometry) {
        pendingPlayerGeometry = PlayerGeometry.swap(playerGeometry, sourceKey, targetKey);
        enlargedPlayerFocus = pendingPlayerGeometry.items.find(item => item.span > 1);
    }
    // Change only CSS order: moving connected iframe nodes would restart playback.
    keys.forEach((key, index) => { getPlayerElement(activePlayers.get(key)).style.order = String(index); });
    if (pendingPlayerGeometry) { updatePlayerLayout({ force: true }); savePlayerEnlargement(); }
    const visualKeys = getPlayerPositionKeys();
    preferredPlayerOrder = visualKeys.concat(preferredPlayerOrder.filter(key => !visualKeys.includes(key))).slice(0, 256);
    try { localStorage.setItem(PLAYER_POSITION_STORAGE_KEY, JSON.stringify(preferredPlayerOrder)); } catch (_) {}
    playerPositionEditor?.refresh();
    playerNameOverlay?.refresh();
    playerWindowControls?.refresh();
    return true;
}

function movePlayerDirection(key, direction, targetKey) {
    const layout = getCurrentPlayerGeometry();
    const source = layout.items.find(item => item.key === key);
    const target = PlayerGeometry.neighbors(layout, key, direction).find(item => item.key === targetKey);
    if (!source || !target || !activePlayers.has(key) || !activePlayers.has(targetKey)) return false;
    if (source.span === 1 && target.span === 1) return swapPlayerPositions(key, targetKey);
    const next = PlayerGeometry.step(layout, key, direction, targetKey);
    if (next === layout) return false;
    // Apply the chosen tracks and order directly; never reparent live media.
    return applyPlayerSize(next, { optimize: false });
}

function resetPlayerPositions() {
    preferredPlayerOrder = [];
    const hadEnlargement = Boolean(enlargedPlayerFocus);
    enlargedPlayerFocus = null;
    pendingPlayerGeometry = null;
    try { localStorage.removeItem(PLAYER_POSITION_STORAGE_KEY); } catch (_) {}
    if (hadEnlargement) savePlayerEnlargement();
    const defaultRanks = new Map(channels.map((channel, index) => [ChannelList.channelKey(channel), index]));
    const keys = getPlayerPositionKeys();
    keys.sort((a, b) => (defaultRanks.get(a) ?? Infinity) - (defaultRanks.get(b) ?? Infinity));
    // Keep each live player connected, including players showing a playback error.
    keys.forEach((key, index) => { getPlayerElement(activePlayers.get(key)).style.order = String(index); });
    updatePlayerLayout();
    playerPositionEditor?.refresh();
    playerNameOverlay?.refresh();
}

function syncActivePlayers(requested, emptyMessage = '未選擇頻道') {
    const container = document.getElementById("multi-stream-container");
    if (!container) return;
    const selected = ChannelList.mergeChannels(requested);
    const preferredRanks = new Map(preferredPlayerOrder.map((key, index) => [key, index]));
    selected.sort((a, b) => (preferredRanks.get(ChannelList.channelKey(a)) ?? Infinity) -
        (preferredRanks.get(ChannelList.channelKey(b)) ?? Infinity));
    const desired = new Set(selected.map(ChannelList.channelKey));
    for (const [key, entry] of activePlayers) {
        if (!desired.has(key)) { disposePlayer(entry); activePlayers.delete(key); }
    }
    // Remove the initial placeholder without disconnecting retained players.
    const retained = new Set(Array.from(activePlayers.values(), entry => entry.resource ? entry.resource.element : entry.element));
    for (const child of Array.from(container.children)) {
        if (!retained.has(child)) child.remove();
    }
    const count = selected.length;
    const muted = getGlobalMuted(count);
    const preserveAudio = playerLayoutAudioAvailable();
    currentDisplayChannel = count === 1 ? selected[0] : null;
    updateGlobalAudioButton();
    if (!count) {
        container.innerHTML = `<div style="color:var(--label-2); text-align:center; padding:2rem;">${emptyMessage}</div>`;
        updatePlayerLayout();
        playerPositionEditor?.refresh();
        playerNameOverlay?.refresh();
        return;
    }
    const unsyncedAudio = [];
    selected.forEach((channel, index) => {
        const key = ChannelList.channelKey(channel);
        let entry = activePlayers.get(key);
        const nativePlayer = entry && entry.resource;
        const element = entry && (nativePlayer ? nativePlayer.element : entry.element);
        const hasUrlAudioControl = ['twitch', 'kick', 'ok', 'youtube'].includes(channel.platform);
        const reusable = entry && element.isConnected && !entry.failed && !(nativePlayer && nativePlayer.failed) && (preserveAudio || nativePlayer || entry.muted === muted || !hasUrlAudioControl);
        if (!reusable) {
            if (entry) disposePlayer(entry);
            const initialMuted = preserveAudio ? true : muted;
            const rendered = renderChannelElement(channel, initialMuted, count === 1 ? 'full-screen-video' : 'video');
            const resource = playerResources.get(rendered);
            const type = getPlatform(channel.platform)?.type;
            entry = { channel, element: rendered, resource, muted: initialMuted, failed: !resource && (type === 'hls' || type === 'flv') };
            activePlayers.set(key, entry);
            container.appendChild(rendered);
            if (globalMutedPreference !== null && !resource && !entry.failed && !['twitch', 'kick', 'ok'].includes(channel.platform)) unsyncedAudio.push(channel.name);
        } else {
            // Preserve manual mute, volume and pause changes within the same mode.
            if (!preserveAudio && entry.resource && entry.muted !== muted) {
                if (entry.resource.video) entry.resource.video.muted = muted;
                else entry.resource.twitch?.setMuted(muted);
                if (entry.resource.youtube) entry.resource.youtube.setMuted(muted);
            }
            if (!preserveAudio) entry.muted = muted;
            entry.channel = channel;
        }
        const visible = entry.resource ? entry.resource.element : entry.element;
        visible.dataset.channelName = channel.name || '';
        visible.dataset.channelKey = key;
        visible.classList.toggle('full-screen-video', count === 1);
        visible.classList.toggle('video', count > 1);
        // Moving an iframe in the DOM can restart it; CSS order keeps it connected.
        visible.style.order = String(index);
    });
    activePlayers.forEach(entry => entry.resource?.twitch?.refresh());
    updatePlayerLayout();
    updateGlobalAudioButton();
    if (unsyncedAudio.length) showGlobalAudioFeedback({ muted, unsupported: unsyncedAudio, reloaded: 0 });
    playerPositionEditor?.refresh();
    playerNameOverlay?.refresh();
}

function pruneActivePlayers() {
    if (!activePlayers.size) { playerNameOverlay?.refresh(); return; }
    const available = new Map(channels.map(channel => [ChannelList.channelKey(channel), channel]));
    activePlayers.forEach((entry, key) => {
        if (available.has(key)) {
            entry.channel = available.get(key);
            getPlayerElement(entry).dataset.channelName = entry.channel.name || '';
            getPlayerElement(entry).dataset.channelKey = key;
        }
    });
    if (currentDisplayChannel) currentDisplayChannel = available.get(ChannelList.channelKey(currentDisplayChannel)) || null;
    const remaining = getPlayerPositionKeys().map(key => available.get(key)).filter(Boolean);
    if (remaining.length !== activePlayers.size) syncActivePlayers(remaining);
    else { playerNameOverlay?.refresh(); playerWindowControls?.refresh(); }
}

function displaySingleChannel(channel) {
    syncActivePlayers(channel ? [channel] : []);
}

/* ------------------------ 多台觀看 ------------------------ */
function watchSelectedChannels() {
    setChannelSelectionVisible(false);
    const checkboxes = document.querySelectorAll("#channel-options input:checked");
    const selected = Array.from(checkboxes).map(cb => ({
        id: cb.value, platform: cb.dataset.platform, name: cb.dataset.name || ""
    }));
    const fullSelected = selected
        .map(sel => channels.find(ch => ch.id === sel.id && ch.platform === sel.platform))
        .filter(Boolean);

    syncActivePlayers(fullSelected, '未選擇任何頻道');
}

const channelSelectionIdleTimer = (() => {
    const panel = document.getElementById('channel-selection');
    let timer = null;
    let frameFocusTimer = null;
    let visible = false;
    function clearFrameFocusTimer() {
        if (frameFocusTimer !== null) clearTimeout(frameFocusTimer);
        frameFocusTimer = null;
    }
    function watchPlayerFrameFocus(delay = 200) {
        clearFrameFocusTimer();
        if (!visible) return;
        frameFocusTimer = setTimeout(() => {
            frameFocusTimer = null;
            const frame = document.activeElement;
            if (!document.hidden && document.hasFocus() && frame?.matches?.('iframe,video,audio') &&
                (document.getElementById('multi-stream-container')?.contains(frame) ||
                    frame === document.getElementById('chat_embed'))) setChannelSelectionVisible(false);
            else watchPlayerFrameFocus();
        }, delay);
    }
    function reset() {
        if (timer !== null) clearTimeout(timer);
        timer = visible ? setTimeout(() => setChannelSelectionVisible(false), PLAYER_OVERLAY_TIMEOUT_SECONDS * 1000) : null;
    }
    function onActivity(event) {
        if (!visible || event.isTrusted !== true) return;
        // Count the input gesture, never scroll itself: script-written scrollTop
        // can also generate trusted scroll events during a background refresh.
        reset();
    }
    for (const type of ['pointermove', 'pointerdown', 'pointerup', 'click', 'keydown', 'keyup',
        'input', 'change', 'wheel', 'touchstart', 'touchmove', 'touchend']) {
        panel?.addEventListener(type, onActivity, { capture: true, passive: true });
    }
    document.addEventListener('pointerdown', event => {
        if (!visible) return;
        const button = document.getElementById('more-channels-btn');
        const path = event.composedPath?.() || [];
        if (path.includes(panel) || path.includes(button) || panel?.contains(event.target) || button?.contains(event.target)) return;
        setChannelSelectionVisible(false);
    }, { capture: true, passive: true });
    document.addEventListener('umininn-player-interaction', event => {
        if (visible && event.target?.tagName === 'IFRAME' &&
            document.getElementById('multi-stream-container')?.contains(event.target)) setChannelSelectionVisible(false);
    });
    // Foreign documents and native media controls can consume pointer events.
    // Firefox may omit the focus event entirely for a foreign document. A
    // single activeElement check while this menu is open covers that case.
    // Chat input also dismisses the menu; tab/app switches and unrelated frames do not.
    window.addEventListener('blur', () => watchPlayerFrameFocus(0), true);
    window.addEventListener('pagehide', () => setChannelSelectionVisible(false));
    return {
        setVisible(next) {
            next = Boolean(panel && next);
            if (next === visible) return;
            visible = next;
            clearFrameFocusTimer();
            // Some browsers do not focus pointer-activated buttons. Keep focus
            // in this page so even another click in the same foreign player
            // creates a detectable focus transition after each opening.
            if (visible) document.getElementById('more-channels-btn')?.focus({ preventScroll: true });
            watchPlayerFrameFocus();
            reset();
        }
    };
})();

function setChannelSelectionVisible(visible) {
    if (visible) layoutBookmarkMenu?.close(false);
    const panel = document.getElementById('channel-selection');
    if (panel) panel.style.display = visible ? 'block' : 'none';
    playerNameOverlay?.setVisible(visible);
    channelSelectionIdleTimer.setVisible(visible);
}

// Layout mutations share one preparation/commit/restore transaction. The
// userscript reads foreign players before this page changes their layout;
// callbacks stay synchronous inside the transaction, including nested calls.
let playerAudioLayoutDepth = 0, playerAudioLayoutSequence = 0;
let playerAudioLayoutBatch = null;
const playerAudioLayoutQueue = [];
function playerLayoutAudioAvailable() {
    return document.documentElement.hasAttribute('data-umininn-player-userscript') &&
        document.documentElement.hasAttribute('data-umininn-player-layout-audio-ready');
}
function withPlayerAudioLayout(action) {
    if (playerAudioLayoutDepth || !playerLayoutAudioAvailable()) return action();
    return new Promise((resolve, reject) => {
        playerAudioLayoutQueue.push({ action, resolve, reject });
        startPlayerAudioLayout();
    });
}
function startPlayerAudioLayout() {
    if (playerAudioLayoutBatch || !playerAudioLayoutQueue.length) return;
    const pane = document.getElementById('multi-stream-container');
    const batch = playerAudioLayoutBatch = { pane, ticket: String(++playerAudioLayoutSequence), phase: 'prepare', results: [] };
    if (!pane || !playerLayoutAudioAvailable()) { commitPlayerAudioLayout(batch, false); return; }
    pane.setAttribute('data-umininn-layout-audio-ticket', batch.ticket);
    batch.timer = setTimeout(() => commitPlayerAudioLayout(batch, false), 6500);
    pane.dispatchEvent(new Event('umininn-player-layout-before', { bubbles: true }));
}
function commitPlayerAudioLayout(batch, restore) {
    if (playerAudioLayoutBatch !== batch || batch.phase !== 'prepare') return;
    clearTimeout(batch.timer);
    batch.phase = 'commit';
    if (!restore) batch.pane?.dispatchEvent(new Event('umininn-player-layout-abort', { bubbles: true }));
    playerAudioLayoutDepth++;
    try {
        for (const request of playerAudioLayoutQueue.splice(0)) {
            try { batch.results.push({ request, value: request.action() }); }
            catch (error) { batch.results.push({ request, error }); }
        }
    } finally { playerAudioLayoutDepth--; }
    batch.phase = 'restore';
    if (!restore) { finishPlayerAudioLayout(batch); return; }
    batch.timer = setTimeout(() => {
        batch.pane.dispatchEvent(new Event('umininn-player-layout-abort', { bubbles: true }));
        finishPlayerAudioLayout(batch);
    }, 10000);
    batch.pane.dispatchEvent(new Event('umininn-player-layout-after', { bubbles: true }));
}
function finishPlayerAudioLayout(batch) {
    if (playerAudioLayoutBatch !== batch) return;
    clearTimeout(batch.timer);
    if (batch.pane?.getAttribute('data-umininn-layout-audio-ticket') === batch.ticket) {
        batch.pane.removeAttribute('data-umininn-layout-audio-ticket');
        batch.pane.removeAttribute('data-umininn-layout-audio-ack');
    }
    playerAudioLayoutBatch = null;
    for (const { request, value, error } of batch.results) {
        if (error) request.reject(error); else request.resolve(value);
    }
    if (playerAudioLayoutQueue.length) queueMicrotask(startPlayerAudioLayout);
}
document.addEventListener('umininn-player-layout-ready', event => {
    const batch = playerAudioLayoutBatch;
    if (batch && event.target === batch.pane && batch.pane.getAttribute('data-umininn-layout-audio-ack') === batch.ticket)
        commitPlayerAudioLayout(batch, true);
});
document.addEventListener('umininn-player-layout-restored', event => {
    const batch = playerAudioLayoutBatch;
    if (batch?.phase === 'restore' && event.target === batch.pane && batch.pane.getAttribute('data-umininn-layout-audio-ack') === batch.ticket)
        finishPlayerAudioLayout(batch);
});
window.addEventListener('pagehide', () => {
    const batch = playerAudioLayoutBatch;
    if (batch) {
        batch.pane?.dispatchEvent(new Event('umininn-player-layout-abort', { bubbles: true }));
        for (const { request } of batch.results) request.resolve(false);
        batch.results = [];
        finishPlayerAudioLayout(batch);
    }
    for (const request of playerAudioLayoutQueue.splice(0)) request.resolve(false);
});
function guardPlayerAudioLayout(action) {
    return function (...args) { return withPlayerAudioLayout(() => action.apply(this, args)); };
}
updatePlayerLayout = guardPlayerAudioLayout(updatePlayerLayout);
applyPlayerSize = guardPlayerAudioLayout(applyPlayerSize);
enlargePlayer = guardPlayerAudioLayout(enlargePlayer);
shrinkPlayer = guardPlayerAudioLayout(shrinkPlayer);
closePlayer = guardPlayerAudioLayout(closePlayer);
swapPlayerPositions = guardPlayerAudioLayout(swapPlayerPositions);
movePlayerDirection = guardPlayerAudioLayout(movePlayerDirection);
resetPlayerPositions = guardPlayerAudioLayout(resetPlayerPositions);
syncActivePlayers = guardPlayerAudioLayout(syncActivePlayers);

/* =============== 頻道儲存 / 載入 =============== */
function saveChannelsToStorage() {
    ChannelList.saveCustomChannels(localStorage, channels);
}

async function loadTwitchCredentials() {
    try {
        const resp = await fetch('./token.txt', { cache: 'no-store' });
        if (!resp.ok) return;
        const data = await resp.text();
        const lines = data.split('\n').map(l => l.trim());
        if (lines.length >= 2) {
            TWITCH_TOKEN = lines[0];
            TWITCH_CLIENT_ID = lines[1];
        }
    } catch (e) { console.warn(e); }
}

/* The manager and both viewing pages share the published channel file. */
async function loadChannelsFromUrl(providedTxtRaw) {
    const loaded = await ChannelList.loadSharedChannels(localStorage, fetch, providedTxtRaw);
    if (loaded.raw === null || JSON.stringify(loaded.channels) === JSON.stringify(channels)) return;
    channels = loaded.channels;
    pruneActivePlayers();
    generateButtons();
    const selection = document.getElementById('channel-selection');
    if (selection && selection.style.display !== 'none') generateChannelOptions({ preserveSelection: true });
    const menu = document.getElementById('channel-menu');
    if (menu && menu.style.display === 'block') {
        const scrollTop = menu.scrollTop;
        toggleChannelMenu();
        toggleChannelMenu();
        menu.scrollTop = scrollTop;
    }
}

/* Serialize refreshes so an old in-flight response cannot undo a newer edit. */
function pollCh1TxtForUpdates() {
    channelReloadQueued = true;
    if (channelReloadPromise) return channelReloadPromise;
    channelReloadPromise = (async () => {
        do {
            channelReloadQueued = false;
            await loadChannelsFromUrl();
        } while (channelReloadQueued);
    })().catch(error => console.warn('[channel sync]', error)).finally(() => { channelReloadPromise = null; });
    return channelReloadPromise;
}

/* Keep the channel scrollbar exactly 3px tall, independently of native UI. */
(function initChannelScrollbar() {
    const list = document.getElementById('lists');
    const scrollbar = document.getElementById('channel-scrollbar');
    if (!list || !scrollbar) return;
    let pending = false;
    let drag = null;
    let suppressIconClick = false;

    function metrics() {
        const width = list.clientWidth;
        const maximum = Math.max(0, list.scrollWidth - width);
        const thumb = Math.min(width, Math.max(24, width * width / Math.max(width, list.scrollWidth, 1)));
        return { width, maximum, thumb };
    }

    function endDrag(event) {
        if (!drag || event && event.pointerId !== drag.id) return;
        const previous = drag;
        drag = null;
        if (previous.surface === list && previous.moved) list.classList.remove('is-dragging');
        if (previous.surface !== list || previous.moved) {
            try { previous.surface.releasePointerCapture(previous.id); } catch (_) {}
        }
    }

    function update() {
        pending = false;
        const { width, maximum, thumb } = metrics();
        if (drag && (width !== drag.width || maximum !== drag.maximum)) {
            if (drag.surface === list) suppressIconClick = true;
            endDrag();
        }
        scrollbar.max = String(maximum);
        scrollbar.value = String(Math.max(0, Math.min(maximum, list.scrollLeft)));
        scrollbar.disabled = width <= 0 || maximum <= 0;
        scrollbar.style.setProperty('--channel-scroll-thumb', `${thumb}px`);
    }

    function schedule() {
        if (pending) return;
        pending = true;
        requestAnimationFrame(update);
    }

    // Treat the entire track as a relative drag surface. Cancel the native
    // range press, which would otherwise jump the thumb to the pointer first.
    scrollbar.addEventListener('pointerdown', event => {
        if (scrollbar.disabled || event.button !== 0) return;
        event.preventDefault();
        if (drag || event.isPrimary === false) return;
        const { width, maximum, thumb } = metrics();
        if (width <= 0 || maximum <= 0) { schedule(); return; }
        drag = { surface: scrollbar, id: event.pointerId, x: event.clientX, width, maximum,
            travel: Math.max(1, scrollbar.getBoundingClientRect().width - thumb) };
        scrollbar.focus({ preventScroll: true });
        try { scrollbar.setPointerCapture(event.pointerId); } catch (_) {}
    });
    list.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.isPrimary === false) return;
        if (drag) { event.preventDefault(); return; }
        suppressIconClick = false;
        const { width, maximum } = metrics();
        if (width <= 0) return;
        // Keep native button focus/click until horizontal movement exceeds 6px.
        drag = { surface: list, id: event.pointerId, x: event.clientX, y: event.clientY,
            width, maximum, moved: false };
    });
    document.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.id) return;
        if (event.pointerType === 'mouse' && !(event.buttons & 1)) { endDrag(); return; }
        const { width, maximum } = metrics();
        const icons = drag.surface === list;
        if (width !== drag.width || maximum !== drag.maximum || !icons && scrollbar.disabled) {
            if (icons) suppressIconClick = true;
            endDrag(); schedule(); return;
        }
        if (icons && !drag.moved) {
            const x = Math.abs(event.clientX - drag.x), y = Math.abs(event.clientY - drag.y);
            if (y > 6 && y > x) { suppressIconClick = true; endDrag(); return; }
            if (x <= 6) return;
            drag.moved = true;
            suppressIconClick = true;
            list.classList.add('is-dragging');
            try { list.setPointerCapture(event.pointerId); } catch (_) {}
        }
        event.preventDefault();
        const delta = event.clientX - drag.x;
        drag.x = event.clientX;
        list.scrollLeft = Math.max(0, Math.min(maximum, list.scrollLeft + (icons ? -delta : delta * maximum / drag.travel)));
        scrollbar.value = String(list.scrollLeft);
    });
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
    scrollbar.addEventListener('lostpointercapture', endDrag);
    list.addEventListener('lostpointercapture', event => { if (event.target === list) endDrag(event); });
    list.addEventListener('dragstart', event => event.preventDefault());
    list.addEventListener('click', event => {
        if (!suppressIconClick || event.detail === 0) return;
        suppressIconClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
    }, true);
    window.addEventListener('blur', () => endDrag());
    scrollbar.addEventListener('click', event => event.preventDefault());
    // Pointer defaults are replaced above; native range keyboard input remains.
    scrollbar.addEventListener('input', () => { list.scrollLeft = Number(scrollbar.value); });
    list.addEventListener('scroll', schedule, { passive: true });
    document.getElementById('toggleNotLive')?.addEventListener('change', schedule);
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(list);
    const contentObserver = new MutationObserver(schedule);
    contentObserver.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    schedule();
})();

/* =============== UI 按鈕生成 =============== */
function generateButtons() {
    const container = document.getElementById("lists");
    if (!container) return;
    container.innerHTML = "";
    if (window.innerWidth > 768) {
        const frag = document.createDocumentFragment();
        channels.forEach(channel => addButton(channel, frag));
        container.appendChild(frag);
    }
    fetchAllStatuses();
}

function addButton(channel, parentNode) {
    const btn = document.createElement("button");
    const statusKey = `${channel.platform}_${channel.id}`;
    const safeId = statusKey.replace(/[^a-zA-Z0-9]/g, '_');
    btn.className = "status-button";
    btn.id = `btn-${safeId}`;

    const status = channelStatuses[statusKey] || 'unknown';
    applyStatusClass(btn, status);

    btn.innerText = `${platformIcon(channel.platform)}${channel.name}`;
    btn.onclick = () => { displaySingleChannel(channel); };

    const wrapper = document.createElement("div");
    wrapper.className = "button-wrapper";
    wrapper.appendChild(btn);
    parentNode.appendChild(wrapper);
}

function applyStatusClass(el, status) {
    el.classList.remove('live', 'not-live', 'unknown2', 'unknown');
    if (status === 'live') el.classList.add('live');
    else if (status === 'not-live') el.classList.add('not-live');
    else if (status === 'unknown2') el.classList.add('unknown2');
    else el.classList.add('unknown');
}

function updateButtonStatus(channel) {
    const statusKey = `${channel.platform}_${channel.id}`;
    const safeId = statusKey.replace(/[^a-zA-Z0-9]/g, '_');
    const btn = document.getElementById(`btn-${safeId}`);
    if (!btn) return;
    btn.className = "status-button";
    applyStatusClass(btn, channelStatuses[statusKey] || 'unknown');
}

function updateMenuButtonStatus(channel) {
    const statusKey = `${channel.platform}_${channel.id}`;
    const safeId = statusKey.replace(/[^a-zA-Z0-9]/g, '_');
    const menuBtn = document.getElementById(`menu-btn-${safeId}`);
    if (!menuBtn) return;
    const status = channelStatuses[statusKey] || 'unknown';
    menuBtn.className = "menu-status-button status-button";
    applyStatusClass(menuBtn, status);

    const statusInd = document.getElementById(`menu-status-${safeId}`);
    if (statusInd) {
        statusInd.className = 'status-indicator';
        if (status === 'live') statusInd.classList.add('status-live');
        else if (status === 'not-live') statusInd.classList.add('status-not-live');
        else statusInd.classList.add('status-unknown');
    }
}

function updateChannelOptionLabel(channel) {
    const control = channelOptionControls.get(ChannelList.channelKey(channel));
    if (!control) return;
    applyStatusClass(control.label, channelStatuses[`${channel.platform}_${channel.id}`] || 'unknown');
    updateChannelSelectionSummary();
}

function updateUIForChannel(channel) {
    updateButtonStatus(channel);
    updateMenuButtonStatus(channel);
    updateChannelOptionLabel(channel);
}

async function fetchStatus(channel, { force = false } = {}) {
    if (!channel || !channel.id) return;
    const statusKey = `${channel.platform}_${channel.id}`;
    const p = getPlatform(channel.platform);
    if (!p) return;

    let status;
    try {
        status = await statusScheduler.run(statusKey, async signal => {
            let value = 'unknown';
            if (channel.platform !== 'twitch' || (TWITCH_TOKEN && TWITCH_CLIENT_ID)) {
                value = p.status ? await p.status(channel, signal) : 'unknown';
            }
            return ['live', 'not-live', 'unknown', 'unknown2'].includes(value) ? value : 'unknown';
        }, { force });
    } catch (e) {
        console.warn(`[status error] ${channel.platform}/${channel.id}`, e);
        status = 'unknown';
    }
    if (channelStatuses[statusKey] !== status) {
        channelStatuses[statusKey] = status;
        updateUIForChannel(channel);
    }
    return status;
}

function fetchAllStatuses(options) {
    return Promise.all(channels.map(ch => fetchStatus(ch, options)));
}

function updateChannelSelectionSummary() {
    const summary = document.getElementById('channel-selection-summary');
    if (!summary) return;
    const inputs = Array.from(document.querySelectorAll('#channel-options input[type="checkbox"]'));
    const selected = inputs.filter(input => input.checked);
    const hideOffline = Boolean(document.getElementById('toggleNotLive')?.checked);
    const hidden = hideOffline ? selected.filter(input => channelStatuses[`${input.dataset.platform}_${input.value}`] === 'not-live').length : 0;
    summary.textContent = '已選 ' + selected.length + ' / ' + inputs.length + ' 台' + (hidden ? '（其中 ' + hidden + ' 台已隱藏）' : '');
}

function createChannelOptionControl() {
    const cell = document.createElement('div');
    cell.className = 'channel-option-cell';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = 'channel-choice-' + (++channelOptionSequence);
    input.addEventListener('change', updateChannelSelectionSummary);
    const label = document.createElement('label');
    label.className = 'channel-option-label';
    label.htmlFor = input.id;
    const icon = document.createElement('span');
    icon.className = 'channel-option-icon';
    const name = document.createElement('span');
    name.className = 'channel-option-name';
    label.appendChild(icon);
    label.appendChild(name);
    cell.appendChild(input);
    cell.appendChild(label);
    return { cell, input, label, icon, name };
}

function generateChannelOptions({ preserveSelection = false } = {}) {
    const container = document.getElementById('channel-options');
    if (!container) return;
    const panel = document.getElementById('channel-selection');
    const scrollTop = panel ? panel.scrollTop : 0;
    const available = new Set(channels.map(channel => ChannelList.channelKey(channel)));
    for (const [key, control] of channelOptionControls) {
        if (!available.has(key)) { control.cell.remove(); channelOptionControls.delete(key); }
    }
    const seen = new Set();
    let next = container.firstElementChild;
    for (const channel of channels) {
        const key = ChannelList.channelKey(channel);
        if (seen.has(key)) continue;
        seen.add(key);
        let control = channelOptionControls.get(key);
        const retained = Boolean(control && control.cell.parentNode === container);
        if (!retained) {
            control = createChannelOptionControl();
            channelOptionControls.set(key, control);
        }
        const { cell, input, label, icon, name } = control;
        input.value = channel.id;
        input.dataset.platform = channel.platform;
        input.dataset.name = channel.name;
        if (!preserveSelection || !retained) input.checked = activePlayers.has(key);
        label.title = channel.name;
        icon.textContent = platformIcon(channel.platform);
        name.textContent = channel.name;
        applyStatusClass(label, channelStatuses[`${channel.platform}_${channel.id}`] || 'unknown');
        // Keep unchanged controls connected: a background list refresh must not
        // replace the checkbox or label between pointer-down and pointer-up.
        if (cell !== next) container.insertBefore(cell, next);
        else next = next.nextElementSibling;
    }
    if (preserveSelection && panel) panel.scrollTop = scrollTop;
    updateChannelSelectionSummary();
    fetchAllStatuses();
}

function checkAllLiveChannels() {
    document.querySelectorAll('#channel-options input[type="checkbox"]').forEach(input => {
        input.checked = channelStatuses[`${input.dataset.platform}_${input.value}`] === 'live';
    });
    updateChannelSelectionSummary();
}

function selectAllChannelSelection() {
    const hideOffline = Boolean(document.getElementById('toggleNotLive')?.checked);
    document.querySelectorAll('#channel-options input[type="checkbox"]').forEach(input => {
        const status = channelStatuses[`${input.dataset.platform}_${input.value}`] || 'unknown';
        input.checked = !hideOffline || status !== 'not-live';
    });
    updateChannelSelectionSummary();
}

function clearAllChannelSelection() {
    document.querySelectorAll('#channel-options input[type="checkbox"]').forEach(input => { input.checked = false; });
    updateChannelSelectionSummary();
}

function toggleChannelSelection() {
    const div = document.getElementById("channel-selection");
    if (div.style.display === "none") {
        generateChannelOptions();
        setChannelSelectionVisible(true);
    } else setChannelSelectionVisible(false);
}

/* ------------------------ 台佈局書籤 ------------------------ */
function capturePlayerBookmark() {
    const keys = getPlayerPositionKeys();
    if (!keys.length) throw new Error('先在「看更台」選台並開始觀看，再儲存佈局。');
    const pane = document.getElementById('multi-stream-container');
    const geometry = getCurrentPlayerGeometry();
    const focus = geometry.items.find(item => item.span > 1);
    return {
        channels: keys.map(key => ({ key, name: activePlayers.get(key).channel.name })),
        columns: geometry.columns,
        focus: focus ? { key: focus.key, row: focus.row, column: focus.column, span: focus.span } : null,
        aspectRatio: pane?.clientWidth > 0 && pane?.clientHeight > 0 ? pane.clientWidth / pane.clientHeight : 16 / 9
    };
}

function showLayoutBookmarkFeedback(message) {
    const output = document.getElementById('layout-bookmark-feedback');
    if (!output) return;
    if (layoutBookmarkFeedbackTimer !== null) clearTimeout(layoutBookmarkFeedbackTimer);
    output.textContent = message;
    output.hidden = false;
    layoutBookmarkFeedbackTimer = setTimeout(() => {
        output.hidden = true;
        layoutBookmarkFeedbackTimer = null;
    }, 6000);
}

function applyPlayerBookmark(value) {
    const snapshot = LayoutBookmarks.normalizeSnapshot(value);
    if (!snapshot) throw new Error('這個書籤的佈局資料無效。');
    const available = new Map(channels.map(channel => [ChannelList.channelKey(channel), channel]));
    const selected = snapshot.channels.map(item => available.get(item.key)).filter(Boolean);
    if (!selected.length) throw new Error('這個書籤的台已從頻道列表移除；目前播放保持不變。');
    playerPositionEditor?.close(false);
    setChannelSelectionVisible(false);
    // A layout bookmark changes placement and selection, keeping existing
    // players' sound preference even when switching between one and many.
    if (activePlayers.size) globalMutedPreference = getGlobalMuted();
    const keys = selected.map(ChannelList.channelKey);
    preferredPlayerOrder = keys.concat(preferredPlayerOrder.filter(key => !keys.includes(key))).slice(0, 256);
    enlargedPlayerFocus = keys.length > 1 && keys.includes(snapshot.focus?.key) ? { ...snapshot.focus } : null;
    const columns = enlargedPlayerFocus ? snapshot.columns : Math.min(snapshot.columns, keys.length);
    pendingPlayerGeometry = { columns, intent: 'bookmark' };
    syncActivePlayers(selected);
    try { localStorage.setItem(PLAYER_POSITION_STORAGE_KEY, JSON.stringify(preferredPlayerOrder)); } catch (_) {}
    savePlayerEnlargement();
    const selectedKeys = new Set(keys);
    for (const input of document.querySelectorAll('#channel-options input[type="checkbox"]')) {
        input.checked = selectedKeys.has(ChannelList.channelKey({ id: input.value, platform: input.dataset.platform, name: input.dataset.name || 'channel' }));
    }
    updateChannelSelectionSummary();
    const missing = snapshot.channels.length - selected.length;
    showLayoutBookmarkFeedback(`已套用佈局：${selected.length} 台${missing ? `；已略過 ${missing} 個已移除的台` : ''}。`);
    document.getElementById('multi-stream-container')?.dispatchEvent(new Event('umininn-player-bookmark-restored', { bubbles: true }));
    return { applied: selected.length, missing };
}

applyPlayerBookmark = guardPlayerAudioLayout(applyPlayerBookmark);

(function initLayoutBookmarks() {
    const button = document.getElementById('layout-bookmarks-btn');
    const panel = document.getElementById('layout-bookmarks');
    if (!button || !panel || typeof LayoutBookmarks === 'undefined') return;
    let cacheStorage;
    try { cacheStorage = localStorage; } catch (_) {}
    const store = typeof SharedBookmarks !== 'undefined' ? SharedBookmarks.createStore({
        transport: SharedBookmarks.createTransport(), cacheStorage
    }) : undefined;
    layoutBookmarkMenu = LayoutBookmarks.mount({
        button, panel, store, capture: capturePlayerBookmark, apply: applyPlayerBookmark,
        beforeOpen() {
            setChannelSelectionVisible(false);
            playerPositionEditor?.close(false);
        }
    });
})();

/* ------------------------ 看更台：播放器搬位模式 ------------------------ */
(function initPlayerPositionEditor() {
    const pane = document.getElementById('multi-stream-container');
    const wrapper = document.getElementById('multi-stream-container-wrapper');
    const startButton = document.getElementById('adjust-player-positions');
    const enlargeButton = document.getElementById('enlarge-player');
    const resetButton = document.getElementById('reset-player-positions');
    if (!pane || !wrapper || !startButton) return;
    try {
        const saved = JSON.parse(localStorage.getItem(PLAYER_POSITION_STORAGE_KEY));
        if (Array.isArray(saved)) preferredPlayerOrder = [...new Set(saved.filter(key => typeof key === 'string'))].slice(0, 256);
    } catch (_) {}
    try {
        const saved = JSON.parse(localStorage.getItem(PLAYER_ENLARGEMENT_STORAGE_KEY));
        const focus = saved?.focus;
        if (saved?.version === 1 && typeof focus?.key === 'string' &&
            Number.isInteger(focus.span) && focus.span >= 2 && focus.span <= 256 &&
            Number.isInteger(focus.row) && focus.row >= 0 && focus.row <= 512 &&
            Number.isInteger(focus.column) && focus.column >= 0 && focus.column <= 512 &&
            Number.isInteger(saved.columns) && saved.columns >= focus.span && saved.columns <= 768) {
            enlargedPlayerFocus = { key: focus.key, span: focus.span, row: focus.row, column: focus.column };
            pendingPlayerGeometry = { columns: saved.columns, intent: 'restore' };
        }
    } catch (_) {}

    const layer = document.createElement('div');
    layer.id = 'player-position-editor';
    layer.hidden = true;
    layer.dataset.toolbarPosition = 'top';
    layer.innerHTML = `<div class="player-position-cells"></div>
        <div class="player-resize-preview" aria-hidden="true" hidden></div>
        <div class="player-position-toolbar"><span class="player-position-instructions">拖曳或點選目標；相鄰一步，跨格到位；方向鍵逐格，Esc 完成</span>
        <button class="player-position-shrink" type="button" hidden disabled>－ 縮小一格</button>
        <button class="player-position-toolbar-toggle" type="button" title="將操作列移到播放區底部">↓ 移到底部</button>
        <button class="player-position-reset" type="button" title="還原全部播放器的大小及排列">↺ 重設佈局</button>
        <button class="player-position-done" type="button">✅ 完成搬位</button></div>
        <p class="player-position-announcement" role="status" aria-live="polite"></p>`;
    // A sibling overlay leaves every iframe/video connected in its original parent.
    wrapper.appendChild(layer);
    const cells = layer.querySelector('.player-position-cells');
    const resizePreview = layer.querySelector('.player-resize-preview');
    const doneButton = layer.querySelector('.player-position-done');
    const editorResetButton = layer.querySelector('.player-position-reset');
    const shrinkButton = layer.querySelector('.player-position-shrink');
    const toolbarToggle = layer.querySelector('.player-position-toolbar-toggle');
    const announcement = layer.querySelector('[role="status"]');
    const instructions = layer.querySelector('.player-position-instructions');
    let opened = false;
    let mode = 'move';
    let pickedKey = null;
    let drag = null;
    let dropKey = null;
    let suppressClick = false;
    let layoutFrame = null;
    let layoutSignature = null;
    let resizeDrag = null;
    let previewFrame = null;
    let moveReturnFocus = null;
    let completionTimer = null;
    let completionDeadline = 0;
    const completionPointers = new Set();
    const buttons = new Map();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleLayout) : null;

    function resetCompletion() {
        if (completionTimer !== null) clearTimeout(completionTimer);
        completionTimer = null;
        if (!opened) { completionDeadline = 0; return; }
        completionDeadline = Date.now() + PLAYER_OVERLAY_TIMEOUT_SECONDS * 1000;
        // A held pointer is an ongoing operation, including a long drag or
        // toolbar press. Start the full idle interval when it is released.
        if (!completionPointers.size)
            completionTimer = setTimeout(autoComplete, PLAYER_OVERLAY_TIMEOUT_SECONDS * 1000);
    }
    layer.addEventListener('pointerdown', event => {
        if (!opened || !event.isTrusted || !event.isPrimary || event.button !== 0) return;
        completionPointers.add(event.pointerId);
        resetCompletion();
    }, true);
    for (const type of ['click', 'keydown']) layer.addEventListener(type, event => {
        if (opened && event.isTrusted) resetCompletion();
    }, true);
    function finishPointerActivity(event) {
        if (!opened || !event.isTrusted || !completionPointers.has(event.pointerId)) return;
        if (event.type === 'pointermove' && (event.buttons & 1)) return;
        completionPointers.delete(event.pointerId);
        if (event.type === 'pointermove') cancelPointer();
        resetCompletion();
    }
    for (const type of ['pointerup', 'pointercancel', 'pointermove'])
        document.addEventListener(type, finishPointerActivity, true);
    function finishHeldActivity() {
        const held = completionPointers.size > 0;
        completionPointers.clear();
        cancelPointer();
        if (held && opened) resetCompletion();
    }

    function updateHighlights() {
        buttons.forEach((button, key) => {
            button.classList.toggle('position-picked', key === pickedKey);
            button.classList.toggle('position-target', key === dropKey);
            button.classList.toggle('position-dragging', Boolean(drag?.moved && key === drag.key));
            button.setAttribute('aria-pressed', String(key === pickedKey));
        });
    }

    function cancelPointer() {
        const previous = drag;
        const previousResize = resizeDrag;
        drag = null;
        resizeDrag = null;
        dropKey = null;
        if (previewFrame !== null) cancelAnimationFrame(previewFrame);
        previewFrame = null;
        resizePreview.hidden = true;
        layer.classList.remove('position-resizing');
        // A canceled gesture may still be followed by a native click. The next
        // pointerdown or keyboard activation starts a fresh, independent action.
        if (previousResize) suppressClick = true;
        if (previous) {
            try { previous.button.releasePointerCapture(previous.id); } catch (_) {}
        }
        if (previousResize) {
            try { previousResize.button.releasePointerCapture(previousResize.id); } catch (_) {}
        }
        updateHighlights();
    }

    function layout() {
        if (!opened) return;
        const bounds = pane.getBoundingClientRect();
        const parentBounds = wrapper.getBoundingClientRect();
        const style = getComputedStyle(pane);
        const signature = [bounds.left, bounds.top, pane.clientWidth, pane.clientHeight,
            parentBounds.left, parentBounds.top, style.gridTemplateColumns, style.gridTemplateRows, style.gap].join('|');
        if (layoutSignature !== null && signature !== layoutSignature) cancelPointer();
        layoutSignature = signature;
        layer.style.left = `${bounds.left - parentBounds.left + pane.clientLeft}px`;
        layer.style.top = `${bounds.top - parentBounds.top + pane.clientTop}px`;
        layer.style.width = `${pane.clientWidth}px`;
        layer.style.height = `${pane.clientHeight}px`;
        cells.style.gridTemplateColumns = style.gridTemplateColumns;
        cells.style.gridTemplateRows = style.gridTemplateRows;
        cells.style.gap = style.gap;
        const columns = playerGeometry?.columns || playerGrid?.getColumns() || 1;
        const rows = playerGeometry?.rows || Math.max(1, Math.ceil(activePlayers.size / columns));
        const cellWidth = (pane.clientWidth - (parseFloat(style.columnGap) || 0) * (columns - 1)) / columns;
        const cellHeight = (pane.clientHeight - (parseFloat(style.rowGap) || 0) * (rows - 1)) / rows;
        const cellSize = Math.max(0, Math.min(cellWidth, cellHeight));
        layer.style.setProperty('--player-position-cell-size', `${cellSize}px`);
        // Browsers round nonzero borders up to a physical pixel in tiny tracks.
        layer.style.setProperty('--player-position-cell-border', `${cellSize < 4 ? 0 : Math.min(2, cellSize / 16)}px`);
        const positions = new Map((playerGeometry?.items || []).map(item => [item.key, item]));
        buttons.forEach((button, key) => {
            button.style.gridArea = positions.has(key) ? playerGridArea(positions.get(key)) : '';
        });
    }

    function scheduleLayout() {
        if (!opened || layoutFrame !== null) return;
        layoutFrame = requestAnimationFrame(() => {
            layoutFrame = null;
            layout();
        });
    }

    function onViewportResize() {
        cancelPointer();
        scheduleLayout();
    }

    function close(restoreFocus = true) {
        if (completionTimer !== null) clearTimeout(completionTimer);
        completionTimer = null;
        completionDeadline = 0;
        completionPointers.clear();
        if (!opened) return;
        opened = false;
        pickedKey = null;
        cancelPointer();
        observer?.disconnect();
        window.removeEventListener('resize', onViewportResize);
        if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
        layoutFrame = null;
        layer.hidden = true;
        startButton.setAttribute('aria-expanded', 'false');
        enlargeButton?.setAttribute('aria-expanded', 'false');
        const returnButton = moveReturnFocus;
        moveReturnFocus = null;
        if (restoreFocus) {
            if (returnButton?.isConnected && !returnButton.disabled) {
                playerWindowControls?.refresh();
                requestAnimationFrame(() => {
                    if (!opened && returnButton.isConnected && !returnButton.disabled) returnButton.focus({ preventScroll: true });
                });
            } else document.getElementById('more-channels-btn')?.focus();
        }
    }

    function refresh() {
        startButton.disabled = activePlayers.size < 2;
        if (enlargeButton) enlargeButton.disabled = startButton.disabled;
        const focus = !startButton.disabled && playerGeometry?.items.find(item => item.span > 1);
        shrinkButton.hidden = mode !== 'enlarge';
        shrinkButton.disabled = !focus;
        shrinkButton.title = focus ? `將 ${activePlayers.get(focus.key).channel.name} 由 ${focus.span}×${focus.span} 縮小至 ${focus.span - 1}×${focus.span - 1}` : '最小為 1×1；先點選播放器放大';
        shrinkButton.setAttribute('aria-label', focus ? `縮小一格：${activePlayers.get(focus.key).channel.name}，${focus.span}×${focus.span} 至 ${focus.span - 1}×${focus.span - 1}` : '縮小一格，最小為 1×1');
        if (startButton.disabled) { close(); return; }
        if (!opened) return;
        const focusKey = document.activeElement?.dataset.playerKey;
        cancelPointer();
        pickedKey = null;
        buttons.clear();
        cells.replaceChildren();
        const sizes = new Map((playerGeometry?.items || []).map(item => [item.key, item.span]));
        getPlayerPositionKeys().forEach((key, index) => {
            const entry = activePlayers.get(key);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'player-position-cell';
            button.dataset.playerKey = key;
            const span = sizes.get(key) || 1;
            button.setAttribute('aria-label', `第 ${index + 1} 格：${entry.channel.name}，${span}×${span}，${mode === 'enlarge' ? '點選放大一格，或拖拉四角調整大小' : span > 1 ? '拖曳或點選目標；相鄰移一格，跨格直接搬位' : '拖曳或點選搬位'}`);
            const number = document.createElement('span');
            number.className = 'player-position-number';
            number.textContent = mode === 'enlarge' ? `＋ ${span}×${span} → ${span + 1}×${span + 1}` : `↔ 第 ${index + 1} 格${span > 1 ? ` · ${span}×${span}` : ''}`;
            const name = document.createElement('span');
            name.className = 'player-position-name';
            name.textContent = `${platformIcon(entry.channel.platform)} ${entry.channel.name}`;
            button.append(number, name);
            if (mode === 'enlarge') {
                for (const [corner, title] of [['nw', '左上'], ['ne', '右上'], ['sw', '左下'], ['se', '右下']]) {
                    const handle = document.createElement('span');
                    handle.className = 'player-resize-handle';
                    handle.dataset.resizeCorner = corner;
                    handle.title = `拖拉${title}角調整大小，放開套用`;
                    handle.setAttribute('aria-hidden', 'true');
                    button.appendChild(handle);
                }
            }
            cells.appendChild(button);
            buttons.set(key, button);
        });
        updateHighlights();
        layout();
        if (focusKey) buttons.get(focusKey)?.focus({ preventScroll: true });
    }

    function exchange(source, target, direction = null) {
        return withPlayerAudioLayout(() => {
            if (!activePlayers.has(source) || !activePlayers.has(target)) return false;
            const sourceName = activePlayers.get(source)?.channel.name;
            const targetName = activePlayers.get(target)?.channel.name;
            const geometry = getCurrentPlayerGeometry();
            const sourceItem = geometry.items.find(item => item.key === source);
            const targetItem = geometry.items.find(item => item.key === target);
            if (sourceItem && targetItem && (sourceItem.span > 1 || targetItem.span > 1)) {
                const edgeDirection = ['up', 'down', 'left', 'right'].find(value =>
                    PlayerGeometry.neighbors(geometry, source, value).some(item => item.key === target));
                // Keyboard arrows only step across a touching edge. Explicit
                // pointer destinations may also request a bounded remote placement.
                if (direction && direction !== edgeDirection) return;
                if (edgeDirection) {
                    const reverse = { up: 'down', down: 'up', left: 'right', right: 'left' };
                    const labels = { up: '上', down: '下', left: '左', right: '右' };
                    const focusDirection = sourceItem.span > 1 ? edgeDirection : reverse[edgeDirection];
                    if (movePlayerDirection(source, edgeDirection, target))
                        announcement.textContent = `${sourceItem.span > 1 ? sourceName : targetName} 已向${labels[focusDirection]}平移一格`;
                    return;
                }
                const next = PlayerGeometry.relocate(geometry, source, target);
                if (next !== geometry && applyPlayerSize(next, { optimize: false }))
                    announcement.textContent = `${sourceItem.span > 1 ? sourceName : targetName} 已搬到指定區域`;
                else announcement.textContent = '大格已在可容納的目標位置';
                return;
            }
            if (swapPlayerPositions(source, target)) announcement.textContent = `${sourceName} 與 ${targetName} 已交換位置`;
        });
    }

    function open(nextMode) {
        if (activePlayers.size < 2) return;
        moveReturnFocus = null;
        completionPointers.clear();
        setChannelSelectionVisible(false);
        mode = nextMode;
        layer.dataset.mode = mode;
        const help = mode === 'enlarge' ? '拖拉四角預覽，放開套用；也可點格放大或按「縮小一格」；Esc 取消拖拉／完成' : '拖曳或點選目標；相鄰一步，跨格到位；方向鍵逐格，Esc 完成';
        instructions.textContent = `${help}；閒置 ${PLAYER_OVERLAY_TIMEOUT_SECONDS} 秒後自動完成`;
        doneButton.textContent = mode === 'enlarge' ? '✅ 完成放大' : '✅ 完成搬位';
        opened = true;
        layer.hidden = false;
        startButton.setAttribute('aria-expanded', String(mode === 'move'));
        enlargeButton?.setAttribute('aria-expanded', String(mode === 'enlarge'));
        refresh();
        observer?.observe(pane);
        observer?.observe(wrapper);
        window.addEventListener('resize', onViewportResize);
        buttons.values().next().value?.focus({ preventScroll: true });
        resetCompletion();
    }
    function autoComplete() {
        if (completionTimer !== null) clearTimeout(completionTimer);
        completionTimer = null;
        if (!opened || completionPointers.size) return;
        const remaining = completionDeadline - Date.now();
        if (remaining > 0) {
            completionTimer = setTimeout(autoComplete, remaining);
            return;
        }
        close(!document.hidden && layer.contains(document.activeElement));
    }
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && completionPointers.size) finishHeldActivity();
        // Background throttling must honour the last interaction's deadline.
        if (opened && !document.hidden && !completionPointers.size && Date.now() >= completionDeadline) autoComplete();
    });
    for (const button of [startButton, enlargeButton]) {
        button?.setAttribute('aria-controls', layer.id);
        button?.setAttribute('aria-expanded', 'false');
    }
    startButton.addEventListener('click', () => open('move'));
    enlargeButton?.addEventListener('click', () => open('enlarge'));
    function resetPositions() {
        return withPlayerAudioLayout(() => {
            resetPlayerPositions();
            announcement.textContent = '已還原播放器大小及頻道列表的預設次序';
        });
    }
    resetButton?.addEventListener('click', resetPositions);
    editorResetButton.addEventListener('click', resetPositions);
    shrinkButton.addEventListener('click', () => {
        void withPlayerAudioLayout(() => {
            if (!opened || mode !== 'enlarge') return;
            const focus = playerGeometry?.items.find(item => item.span > 1);
            if (!focus) return;
            const name = activePlayers.get(focus.key).channel.name;
            if (shrinkPlayer(focus.key)) announcement.textContent = `${name} 已縮小至 ${focus.span - 1}×${focus.span - 1}${focus.span === 2 ? '，已達最小單位，保留目前排列' : ''}`;
        });
    });
    doneButton.addEventListener('click', () => close());
    toolbarToggle.addEventListener('click', () => {
        cancelPointer();
        const bottom = layer.dataset.toolbarPosition !== 'bottom';
        layer.dataset.toolbarPosition = bottom ? 'bottom' : 'top';
        toolbarToggle.textContent = bottom ? '↑ 移到頂部' : '↓ 移到底部';
        toolbarToggle.title = `將操作列移到播放區${bottom ? '頂部' : '底部'}`;
        announcement.textContent = `操作列已移到播放區${bottom ? '底部' : '頂部'}`;
    });
    document.addEventListener('keydown', event => {
        if (opened && event.key === 'Escape') {
            event.preventDefault();
            if (resizeDrag) { cancelPointer(); announcement.textContent = '已取消這次大小調整'; }
            else close();
        }
    });
    cells.addEventListener('click', event => {
        const button = event.target.closest('.player-position-cell');
        if (!button || !opened) return;
        if (suppressClick || event.target.closest('.player-resize-handle')) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        const key = button.dataset.playerKey;
        if (mode === 'enlarge') {
            void withPlayerAudioLayout(() => {
                if (!opened || mode !== 'enlarge' || !activePlayers.has(key)) return;
                if (enlargePlayer(key)) announcement.textContent = `${activePlayers.get(key).channel.name} 已放大至 ${enlargedPlayerFocus.span}×${enlargedPlayerFocus.span}`;
                else announcement.textContent = '已達放大上限';
            });
            return;
        }
        if (pickedKey && pickedKey !== key) exchange(pickedKey, key);
        else {
            pickedKey = pickedKey === key ? null : key;
            updateHighlights();
            announcement.textContent = pickedKey ? '已選取，請點選另一格交換位置' : '已取消選取';
        }
    });
    cells.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            if (resizeDrag) { event.preventDefault(); return; }
            suppressClick = false;
        }
        const button = event.target.closest('.player-position-cell');
        if (!button || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        if (playerGeometry || mode === 'enlarge') {
            const geometry = getCurrentPlayerGeometry();
            const source = geometry.items.find(item => item.key === button.dataset.playerKey);
            if (!source) return;
            const direction = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[event.key];
            const adjacent = PlayerGeometry.neighbor(geometry, source.key, direction);
            if (mode === 'move' && source.span > 1) {
                if (adjacent) exchange(source.key, adjacent.key, direction);
                return;
            }
            const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';
            const backwards = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
            const axis = vertical ? 'row' : 'column';
            const cross = vertical ? 'column' : 'row';
            const candidates = geometry.items.filter(item => item !== source && (backwards ?
                item[axis] + item.span <= source[axis] : item[axis] >= source[axis] + source.span));
            const distance = item => {
                const gap = backwards ? source[axis] - item[axis] - item.span : item[axis] - source[axis] - source.span;
                const overlap = item[cross] < source[cross] + source.span && item[cross] + item.span > source[cross];
                return (overlap ? 0 : 1000000) + gap * 1000 + Math.abs(item[cross] + item.span / 2 - source[cross] - source.span / 2);
            };
            candidates.sort((a, b) => distance(a) - distance(b));
            if (candidates[0]) {
                if (mode === 'enlarge') buttons.get(candidates[0].key)?.focus({ preventScroll: true });
                else if (candidates[0].span <= 1 || adjacent?.key === candidates[0].key)
                    exchange(source.key, candidates[0].key, direction);
            }
            return;
        }
        const keys = getPlayerPositionKeys();
        const index = keys.indexOf(button.dataset.playerKey);
        const columns = playerGrid?.getColumns() || 1;
        const column = index % columns;
        let target = index;
        if (event.key === 'ArrowLeft' && column > 0) target--;
        if (event.key === 'ArrowRight' && column < columns - 1) target++;
        if (event.key === 'ArrowUp') target -= columns;
        if (event.key === 'ArrowDown') target += columns;
        if (target >= 0 && target < keys.length) exchange(keys[index], keys[target]);
    });

    function updateResizePreview() {
        const gesture = resizeDrag;
        if (!gesture?.moved) return;
        const dx = (gesture.lastX - gesture.x) * (gesture.corner.includes('w') ? -1 : 1) / gesture.pitchX;
        const dy = (gesture.lastY - gesture.y) * (gesture.corner.includes('n') ? -1 : 1) / gesture.pitchY;
        // Use the starting tracks throughout the gesture; reflowing the preview
        // must not feed back into the pointer-to-size calculation.
        const delta = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
        const span = Math.max(1, Math.min(256, Math.round(gesture.item.span + delta)));
        if (gesture.span === span) return;
        gesture.span = span;
        const next = PlayerGeometry.resize(gesture.base, gesture.key, span, gesture.corner);
        if (span === 1) {
            const keys = [...next.items].sort((a, b) => a.row - b.row || a.column - b.column).map(item => item.key);
            const normal = PlayerLayout.choose({ ...gesture.measure, count: keys.length, force: true });
            gesture.next = PlayerGeometry.build({ keys, columns: normal.columns });
        } else {
            const keys = [...next.items].sort((a, b) => a.row - b.row || a.column - b.column).map(item => item.key);
            gesture.next = PlayerGeometry.choose({ ...gesture.measure, keys,
                focus: next.items.find(item => item.span > 1), force: true, preserveAnchor: true });
        }
        const item = gesture.next.items.find(value => value.key === gesture.key);
        // Match the gap caps used by the real layout, even for very large spans.
        const tracks = Math.max(activePlayers.size + span - 1, item.row + span, gesture.next.columns);
        const gapX = Math.min(gesture.measure.columnGap, gesture.measure.width / (2 * tracks));
        const gapY = Math.min(gesture.measure.rowGap, gesture.measure.height / (2 * tracks));
        const cellWidth = Math.max(0, (gesture.measure.width - gapX * (gesture.next.columns - 1)) / gesture.next.columns);
        const cellHeight = Math.max(0, (gesture.measure.height - gapY * (gesture.next.rows - 1)) / gesture.next.rows);
        resizePreview.style.left = `${item.column * (cellWidth + gapX)}px`;
        resizePreview.style.top = `${item.row * (cellHeight + gapY)}px`;
        resizePreview.style.width = `${cellWidth * span + gapX * (span - 1)}px`;
        resizePreview.style.height = `${cellHeight * span + gapY * (span - 1)}px`;
        resizePreview.textContent = `${activePlayers.get(gesture.key)?.channel.name || ''} · ${span}×${span}（放開套用）`;
        resizePreview.hidden = false;
        layer.classList.add('position-resizing');
    }

    function queueResizePreview(event) {
        resizeDrag.lastX = event.clientX;
        resizeDrag.lastY = event.clientY;
        if (!resizeDrag.moved && Math.hypot(event.clientX - resizeDrag.x, event.clientY - resizeDrag.y) < 6) return;
        resizeDrag.moved = true;
        if (previewFrame === null) previewFrame = requestAnimationFrame(() => {
            previewFrame = null;
            updateResizePreview();
        });
    }

    function resizeBoundsUnchanged() {
        const bounds = pane.getBoundingClientRect();
        return resizeDrag && pane.clientWidth === resizeDrag.measure.width && pane.clientHeight === resizeDrag.measure.height &&
            bounds.left === resizeDrag.bounds.left && bounds.top === resizeDrag.bounds.top;
    }

    cells.addEventListener('pointerdown', event => {
        const button = event.target.closest('.player-position-cell');
        if (!button || !opened || drag || resizeDrag || !event.isPrimary || event.button !== 0) return;
        suppressClick = false;
        if (mode === 'enlarge') {
            const handle = event.target.closest('.player-resize-handle');
            if (!handle) return;
            event.preventDefault();
            button.focus({ preventScroll: true });
            const base = getCurrentPlayerGeometry();
            const item = base.items.find(value => value.key === button.dataset.playerKey);
            const style = getComputedStyle(pane);
            const measure = { width: pane.clientWidth, height: pane.clientHeight,
                columnGap: parseFloat(style.columnGap) || 0, rowGap: parseFloat(style.rowGap) || 0 };
            if (!item || !(measure.width > 0 && measure.height > 0)) return;
            resizeDrag = { key: item.key, item, base, button, id: event.pointerId,
                pointerType: event.pointerType, bounds: pane.getBoundingClientRect(),
                corner: handle.dataset.resizeCorner, x: event.clientX, y: event.clientY,
                lastX: event.clientX, lastY: event.clientY, moved: false, span: null, next: null, measure,
                pitchX: (measure.width + measure.columnGap) / base.columns,
                pitchY: (measure.height + measure.rowGap) / base.rows };
            suppressClick = true;
            try { button.setPointerCapture(event.pointerId); } catch (_) { cancelPointer(); }
            return;
        }
        button.focus({ preventScroll: true });
        drag = { key: button.dataset.playerKey, button, id: event.pointerId,
            x: event.clientX, y: event.clientY, moved: false,
            bounds: Array.from(buttons, ([key, cell]) => ({ key, rect: cell.getBoundingClientRect() })) };
        try { button.setPointerCapture(event.pointerId); } catch (_) {}
    });
    function targetAt(event) {
        return drag?.bounds.find(({ rect }) => event.clientX >= rect.left && event.clientX <= rect.right &&
            event.clientY >= rect.top && event.clientY <= rect.bottom)?.key || null;
    }
    document.addEventListener('pointermove', event => {
        if (resizeDrag && event.pointerId === resizeDrag.id) {
            if (!resizeBoundsUnchanged() || (resizeDrag.pointerType === 'mouse' && !(event.buttons & 1))) {
                cancelPointer();
                return;
            }
            if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) queueResizePreview(event);
            event.preventDefault();
            return;
        }
        if (!drag || event.pointerId !== drag.id) return;
        if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
        drag.moved = true;
        pickedKey = null;
        const target = targetAt(event);
        if (dropKey !== target || !drag.highlighted) {
            dropKey = target;
            drag.highlighted = true;
            updateHighlights();
        }
        event.preventDefault();
    }, { passive: false });
    document.addEventListener('pointerup', event => {
        if (resizeDrag && event.pointerId === resizeDrag.id) {
            if (!resizeBoundsUnchanged() || (resizeDrag.pointerType === 'mouse' && event.button !== 0)) {
                cancelPointer();
                return;
            }
            queueResizePreview(event);
            updateResizePreview();
            const gesture = resizeDrag;
            const next = gesture.moved && gesture.span !== gesture.item.span ? gesture.next : null;
            cancelPointer();
            if (next && activePlayers.size > 1 && activePlayers.has(gesture.key)) {
                void withPlayerAudioLayout(() => {
                    const current = getCurrentPlayerGeometry(), bounds = pane.getBoundingClientRect();
                    if (!opened || mode !== 'enlarge' || !activePlayers.has(gesture.key) ||
                        pane.clientWidth !== gesture.measure.width || pane.clientHeight !== gesture.measure.height ||
                        bounds.left !== gesture.bounds.left || bounds.top !== gesture.bounds.top ||
                        current.columns !== gesture.base.columns || JSON.stringify(current.items) !== JSON.stringify(gesture.base.items)) return;
                    applyPlayerSize(next, { optimize: false });
                    announcement.textContent = `${activePlayers.get(gesture.key).channel.name} 已調整至 ${gesture.span}×${gesture.span}`;
                });
            }
            event.preventDefault();
            return;
        }
        if (!drag || event.pointerId !== drag.id) return;
        const source = drag.key;
        const target = targetAt(event);
        const moved = drag.moved;
        cancelPointer();
        if (moved) {
            suppressClick = true;
            setTimeout(() => { suppressClick = false; }, 0);
            if (target && target !== source) exchange(source, target);
        }
    });
    document.addEventListener('pointercancel', event => {
        if (event.pointerId === drag?.id || event.pointerId === resizeDrag?.id) cancelPointer();
    });
    cells.addEventListener('lostpointercapture', event => {
        if (event.pointerId === drag?.id || event.pointerId === resizeDrag?.id) cancelPointer();
    });
    window.addEventListener('blur', finishHeldActivity);
    window.addEventListener('pagehide', () => close(false));
    function openMove(key, returnButton) {
        if (activePlayers.size < 2 || !activePlayers.has(key)) return false;
        open('move');
        moveReturnFocus = returnButton;
        pickedKey = key;
        updateHighlights();
        buttons.get(key)?.focus({ preventScroll: true });
        announcement.textContent = `已選取 ${activePlayers.get(key).channel.name}，請拖曳或點選另一格交換位置`;
        return true;
    }
    playerPositionEditor = { refresh, close, openMove, layoutChanged: scheduleLayout };
    refresh();
})();

/* Names and selection highlights share a sibling layer above embedded media.
   Positioned iframe descendants can cover an outline on the player itself. */
(function initPlayerNameOverlay() {
    const pane = document.getElementById('multi-stream-container');
    const wrapper = document.getElementById('multi-stream-container-wrapper');
    const panel = document.getElementById('channel-selection');
    if (!pane || !wrapper || !panel) return;
    const layer = document.createElement('div');
    layer.id = 'player-name-overlay';
    layer.hidden = true;
    layer.setAttribute('aria-hidden', 'true');
    wrapper.appendChild(layer);
    const labels = new Map();
    const observed = new Set();
    let opened = false, suspended = false;
    let frame = null;
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    const mutations = new MutationObserver(schedule);

    function render() {
        if (!opened) return;
        // Measure the layer's coordinate space after restoring it from hidden.
        layer.hidden = false;
        const items = Array.from(activePlayers, ([key, entry]) => ({ key, name: entry.channel.name, element: getPlayerElement(entry) }));
        // The initial OK player predates a channel selection and is outside the map.
        const initial = !items.length && pane.querySelector('#MyFrame');
        if (initial) {
            let name = '目前播放器';
            try {
                const path = new URL(initial.src).pathname;
                name = channels.find(channel => channel.platform === 'ok' &&
                    new URL(PLATFORMS.ok.buildUrl(channel, false)).pathname === path)?.name || name;
            } catch (_) {}
            items.push({ key: 'initial-player', name, element: initial });
        }
        const bounds = layer.getBoundingClientRect();
        const scaleX = bounds.width && layer.offsetWidth ? bounds.width / layer.offsetWidth : 1;
        const scaleY = bounds.height && layer.offsetHeight ? bounds.height / layer.offsetHeight : 1;
        const paneBounds = pane.getBoundingClientRect();
        layer.style.clipPath = `inset(${Math.max(0, (paneBounds.top - bounds.top) / scaleY)}px ${Math.max(0, (bounds.right - paneBounds.right) / scaleX)}px ${Math.max(0, (bounds.bottom - paneBounds.bottom) / scaleY)}px ${Math.max(0, (paneBounds.left - bounds.left) / scaleX)}px round ${getComputedStyle(pane).borderRadius})`;
        const visible = items.filter(item => item.element.isConnected && item.element.getClientRects().length &&
            !['hidden', 'collapse'].includes(getComputedStyle(item.element).visibility))
            .map(item => ({ ...item, rect: item.element.getBoundingClientRect() }))
            .filter(item => item.rect.width > 0 && item.rect.height > 0);
        const keys = new Set(visible.map(item => item.key));
        for (const [key, cell] of labels) if (!keys.has(key)) { cell.remove(); labels.delete(key); }
        const elements = new Set([pane, wrapper, ...visible.map(item => item.element)]);
        for (const element of observed) if (!elements.has(element)) { observer?.unobserve(element); observed.delete(element); }
        for (const element of elements) if (!observed.has(element)) { observer?.observe(element); observed.add(element); }
        for (const { key, name, element, rect } of visible) {
            let cell = labels.get(key);
            if (!cell) {
                cell = document.createElement('div');
                cell.className = 'player-name-cell';
                cell.dataset.playerKey = key;
                const badge = document.createElement('span');
                badge.className = 'player-name-label';
                cell.appendChild(badge);
                layer.appendChild(cell);
                labels.set(key, cell);
            }
            if (cell.firstChild.textContent !== name) cell.firstChild.textContent = name;
            // Each menu paints only its own marker; closing either menu leaves
            // the other menu's independent highlight intact.
            cell.toggleAttribute('data-player-highlighted', element.hasAttribute('data-umininn-selection-highlight'));
            cell.style.left = `${(rect.left - bounds.left) / scaleX}px`;
            cell.style.top = `${(rect.top - bounds.top) / scaleY}px`;
            cell.style.width = `${rect.width / scaleX}px`;
            cell.style.height = `${rect.height / scaleY}px`;
        }
        layer.hidden = !visible.length;
    }
    function schedule() {
        if (!opened || frame !== null) return;
        frame = requestAnimationFrame(() => { frame = null; render(); });
    }
    function setVisible(visible) {
        visible = !suspended && !document.hidden && !document.fullscreenElement &&
            (visible || document.documentElement.hasAttribute('data-umininn-player-controls-open'));
        if (visible === opened) { if (visible) schedule(); return; }
        opened = visible;
        if (visible) {
            render();
            // Detect async error/retry replacements without inspecting iframe contents.
            mutations.observe(pane, { childList: true, subtree: true, attributes: true,
                attributeFilter: ['style', 'class', 'hidden', 'data-channel-name', 'data-umininn-selection-highlight'] });
            window.addEventListener('resize', schedule);
            window.addEventListener('scroll', schedule, true);
        } else {
            layer.hidden = true;
            observer?.disconnect();
            observed.clear();
            mutations.disconnect();
            window.removeEventListener('resize', schedule);
            window.removeEventListener('scroll', schedule, true);
            if (frame !== null) cancelAnimationFrame(frame);
            frame = null;
        }
    }
    function syncVisibility() {
        setVisible(!panel.hidden && getComputedStyle(panel).display !== 'none');
    }
    // Also cover future menu visibility changes outside the shared open/close helper.
    const visibilityObserver = new MutationObserver(syncVisibility);
    visibilityObserver.observe(panel, { attributes: true, attributeFilter: ['style', 'hidden', 'class'] });
    visibilityObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-umininn-player-controls-open'] });
    playerNameOverlay = { setVisible, refresh: schedule };
    document.addEventListener('visibilitychange', syncVisibility);
    document.addEventListener('fullscreenchange', syncVisibility);
    window.addEventListener('pagehide', () => { suspended = true; setVisible(false); });
    window.addEventListener('pageshow', () => { suspended = false; syncVisibility(); });
    syncVisibility();
})();

/* Match selection cards to live tile elements, independent of names or order.
   Each menu owns its own marker so closing one cannot clear the other. */
(function initPlayerMenuHover() {
    const pane = document.getElementById('multi-stream-container');
    const panel = document.getElementById('channel-selection');
    const options = document.getElementById('channel-options');
    if (!pane || !panel || !options) return;
    const ownAttribute = 'data-umininn-selection-highlight';
    const controlsAttribute = 'data-umininn-controls-highlight';
    const bindings = new Set();
    let items = new Map(), cards = new Map();
    let opened = false, suspended = false, touchPointer = false, frame = null;
    let revealedKey = null, cardOrder = '';
    const mutations = new MutationObserver(schedule);
    const resizes = typeof ResizeObserver === 'function' ? new ResizeObserver(resized) : null;
    function marked(node, active) {
        if (active) {
            if (node.getAttribute('data-player-highlighted') !== 'true') node.setAttribute('data-player-highlighted', 'true');
        } else node.removeAttribute('data-player-highlighted');
    }
    function pointer(event) {
        touchPointer = event.pointerType === 'touch';
        schedule();
    }
    function windowPointer(event) {
        if (event.target.closest?.('#player-window-controls .player-window-cell')) pointer(event);
    }
    function unbind(node) {
        node.removeEventListener('pointerenter', pointer);
        node.removeEventListener('pointerleave', pointer);
        node.removeEventListener('pointermove', pointer);
    }
    function revealCard(key) {
        if (key === null) { revealedKey = null; return; }
        if (key === revealedKey) return;
        const cell = [...cards].find(([cell, candidate]) => candidate === key && cell.getClientRects().length)?.[0];
        if (!cell || !panel.clientHeight) return;
        const bounds = panel.getBoundingClientRect(), rect = cell.getBoundingClientRect();
        const top = bounds.top + panel.clientTop, bottom = top + panel.clientHeight;
        let delta = 0;
        if (rect.height > panel.clientHeight) {
            if (rect.top > top) delta = rect.top - top;
            else if (rect.bottom < bottom) delta = rect.bottom - bottom;
        } else if (rect.top < top) delta = rect.top - top;
        else if (rect.bottom > bottom) delta = rect.bottom - bottom;
        revealedKey = key;
        // Scroll this menu alone, once per physical player entry. scrollIntoView
        // could also move the document; repeated correction would fight the user.
        if (Math.abs(delta) > .5) panel.scrollTop += delta;
    }
    function render() {
        if (!opened) return;
        const nextItems = new Map();
        for (const [key, entry] of activePlayers) {
            const element = getPlayerElement(entry);
            if (element?.isConnected && element.parentElement === pane) nextItems.set(element, key);
        }
        const initial = !nextItems.size && pane.querySelector('#MyFrame');
        if (initial) {
            let key = null;
            try {
                const source = new URL(initial.src, location.href);
                const channel = channels.find(channel => {
                    if (channel.platform !== 'ok') return false;
                    const candidate = new URL(PLATFORMS.ok.buildUrl(channel, false), location.href);
                    return source.origin === candidate.origin && source.pathname === candidate.pathname;
                });
                if (channel) key = ChannelList.channelKey(channel);
            } catch (_) {}
            nextItems.set(initial, key);
        }
        const nextCards = new Map();
        for (const [key, control] of channelOptionControls) {
            if (control.cell.parentElement === options) nextCards.set(control.cell, key);
        }
        for (const element of items.keys()) if (!nextItems.has(element)) element.removeAttribute(ownAttribute);
        for (const cell of cards.keys()) if (!nextCards.has(cell)) marked(cell, false);
        items = nextItems; cards = nextCards;
        const nextOrder = JSON.stringify([...options.children].filter(cell => cards.has(cell)).map(cell => cards.get(cell)));
        if (nextOrder !== cardOrder) { cardOrder = nextOrder; revealedKey = null; }
        const nodes = new Set([...items.keys(), ...cards.keys()]);
        for (const node of bindings) if (!nodes.has(node)) { unbind(node); bindings.delete(node); }
        for (const node of nodes) if (!bindings.has(node)) {
            bindings.add(node);
            node.addEventListener('pointerenter', pointer);
            node.addEventListener('pointerleave', pointer);
            node.addEventListener('pointermove', pointer);
        }
        // Touch browsers can retain a synthetic :hover after a tap.
        const hover = !touchPointer && (!window.matchMedia || window.matchMedia('(any-hover: hover)').matches);
        const hoveredKeys = new Set([...cards].filter(([cell]) => hover && cell.matches(':hover')).map(([, key]) => key));
        const hoveredWindows = new Set(Array.from(pane.parentElement.querySelectorAll('#player-window-controls .player-window-cell'))
            .filter(cell => hover && cell.matches(':hover')).map(cell => cell.dataset.playerKey));
        const highlightedKeys = new Set();
        let directKey = null;
        for (const [element, key] of items) {
            const physicalHover = hover && (element.matches(':hover') || hoveredWindows.has(element === initial ? 'initial-player' : key));
            const ownHover = physicalHover || hover && key !== null && hoveredKeys.has(key);
            if (physicalHover) directKey = key;
            element.toggleAttribute(ownAttribute, ownHover);
            if (key !== null && (ownHover || element.hasAttribute(controlsAttribute))) highlightedKeys.add(key);
        }
        for (const [cell, key] of cards) marked(cell, highlightedKeys.has(key));
        revealCard(directKey);
    }
    function schedule() {
        if (!opened || frame !== null) return;
        frame = requestAnimationFrame(() => { frame = null; render(); });
    }
    function resized() { revealedKey = null; schedule(); }
    function clear() {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        mutations.disconnect(); resizes?.disconnect();
        window.removeEventListener('resize', resized);
        window.removeEventListener('scroll', schedule, true);
        document.removeEventListener('pointerover', windowPointer, true);
        document.removeEventListener('pointerout', windowPointer, true);
        for (const node of bindings) unbind(node);
        bindings.clear();
        for (const element of items.keys()) element.removeAttribute(ownAttribute);
        for (const cell of cards.keys()) marked(cell, false);
        items.clear(); cards.clear();
        revealedKey = null; cardOrder = '';
    }
    function syncVisibility() {
        const visible = !suspended && !document.hidden && !document.fullscreenElement && !panel.hidden && getComputedStyle(panel).display !== 'none';
        if (visible === opened) { if (visible) schedule(); return; }
        opened = visible;
        if (!opened) { clear(); return; }
        touchPointer = false;
        mutations.observe(pane, { childList: true, subtree: true, attributes: true,
            attributeFilter: ['style', 'class', 'data-channel-name', controlsAttribute] });
        mutations.observe(options, { childList: true, subtree: true, attributes: true,
            attributeFilter: ['style', 'class', 'value', 'data-platform'] });
        resizes?.observe(pane);
        resizes?.observe(panel);
        window.addEventListener('resize', resized);
        window.addEventListener('scroll', schedule, true);
        document.addEventListener('pointerover', windowPointer, true);
        document.addEventListener('pointerout', windowPointer, true);
        render();
    }
    const visibility = new MutationObserver(syncVisibility);
    visibility.observe(panel, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    document.addEventListener('visibilitychange', syncVisibility);
    document.addEventListener('fullscreenchange', syncVisibility);
    window.addEventListener('pagehide', () => { suspended = true; opened = false; clear(); });
    window.addEventListener('pageshow', () => { suspended = false; syncVisibility(); });
    syncVisibility();
})();

/* Window controls are a sibling overlay: never wrap or move a live iframe. */
(function initPlayerWindowControls() {
    const pane = document.getElementById('multi-stream-container');
    const wrapper = document.getElementById('multi-stream-container-wrapper');
    if (!pane || !wrapper) return;
    const editor = document.getElementById('player-position-editor');
    const layer = document.createElement('div');
    layer.id = 'player-window-controls';
    layer.hidden = true;
    wrapper.appendChild(layer);
    const cells = new Map();
    const observed = new Set();
    let frame = null;
    let hoverFrame = null;
    let suspended = false;
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    const mutations = new MutationObserver(schedule);
    const modeObserver = new MutationObserver(schedule);
    const icons = {
        shrink: '<path d="M2 9.5h8"/>',
        enlarge: '<rect x="2.5" y="2.5" width="7" height="7"/>',
        close: '<path d="m2.5 2.5 7 7m0-7-7 7"/>'
    };
    const labels = { shrink: '縮小一格', enlarge: '放大一級', close: '關閉' };
    const directions = { up: '上', down: '下', left: '左', right: '右' };
    const triangles = {
        up: 'M6 2 11 10H1Z', down: 'M1 2H11L6 10Z',
        left: 'M2 6 10 1V11Z', right: 'M2 1 10 6 2 11Z'
    };

    function blocked() {
        return suspended || Boolean(document.fullscreenElement || document.webkitFullscreenElement) || Boolean(editor && !editor.hidden);
    }
    function audioFocusAvailable() {
        return document.documentElement.hasAttribute('data-umininn-player-userscript') &&
            document.documentElement.hasAttribute('data-umininn-player-audio-focus-ready');
    }
    function updateHover() {
        for (const cell of cells.values()) {
            cell.node.dataset.hovered = String(!blocked() && (cell.element.matches(':hover') || cell.node.matches(':hover')));
        }
    }
    function scheduleHover() {
        if (hoverFrame !== null) return;
        hoverFrame = requestAnimationFrame(() => { hoverFrame = null; updateHover(); });
    }
    function unbind(cell) {
        cell.element.removeEventListener('pointerenter', scheduleHover);
        cell.element.removeEventListener('pointerleave', scheduleHover);
    }
    function bind(cell, element) {
        if (cell.element === element) return;
        if (cell.element) unbind(cell);
        cell.element = element;
        // Events on the outer iframe work without reading its foreign document.
        element.addEventListener('pointerenter', scheduleHover);
        element.addEventListener('pointerleave', scheduleHover);
    }
    function render() {
        const items = Array.from(activePlayers, ([key, entry]) => ({ key, name: entry.channel.name, element: getPlayerElement(entry) }));
        const initial = !items.length && pane.querySelector('#MyFrame');
        if (initial) items.push({ key: 'initial-player', name: '目前播放器', element: initial });
        const visible = items.filter(item => item.element.isConnected);
        const keys = new Set(visible.map(item => item.key));
        for (const [key, cell] of cells) if (!keys.has(key)) {
            unbind(cell); cell.node.remove(); cells.delete(key);
        }
        const elements = new Set([pane, wrapper, ...visible.map(item => item.element)]);
        for (const element of observed) if (!elements.has(element)) { observer?.unobserve(element); observed.delete(element); }
        for (const element of elements) if (!observed.has(element)) { observer?.observe(element); observed.add(element); }
        const bounds = wrapper.getBoundingClientRect();
        const geometry = getCurrentPlayerGeometry();
        const geometryItems = new Map(geometry.items.map(item => [item.key, item]));
        const rectangles = new Map(visible.map(item => [item.key, item.element.getBoundingClientRect()]));
        for (const { key, name, element } of visible) {
            let cell = cells.get(key);
            if (!cell) {
                const node = document.createElement('div');
                node.className = 'player-window-cell';
                node.dataset.playerKey = key;
                const bar = document.createElement('div');
                bar.className = 'player-window-buttons';
                bar.setAttribute('role', 'group');
                const buttons = {};
                for (const action of ['shrink', 'enlarge', 'close']) {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.dataset.playerAction = action;
                    button.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">${icons[action]}</svg>`;
                    bar.appendChild(button); buttons[action] = button;
                }
                node.appendChild(bar); layer.appendChild(node);
                const move = document.createElement('button');
                move.type = 'button';
                move.className = 'player-window-move';
                move.dataset.playerAction = 'move';
                move.textContent = '✜';
                node.appendChild(move);
                buttons.move = move;
                node.addEventListener('pointerenter', scheduleHover);
                node.addEventListener('pointerleave', scheduleHover);
                cell = { node, bar, buttons, directionButtons: new Map(), element: null };
                cells.set(key, cell);
            }
            bind(cell, element);
            cell.bar.setAttribute('aria-label', `${name} 播放器控制`);
            const span = playerGeometry?.items.find(item => item.key === key)?.span || 1;
            cell.buttons.shrink.hidden = span <= 1;
            cell.buttons.enlarge.disabled = activePlayers.size < 2 || span >= 256;
            for (const action of ['shrink', 'enlarge', 'close']) {
                cell.buttons[action].title = `${labels[action]}：${name}`;
                cell.buttons[action].setAttribute('aria-label', `${labels[action]}：${name}`);
            }
            if (cell.buttons.enlarge.disabled) cell.buttons.enlarge.title = activePlayers.size < 2 ? '至少觀看兩台才可放大' : '已達最大格數';
            const rect = rectangles.get(key);
            cell.buttons.move.disabled = activePlayers.size < 2 || !activePlayers.has(key);
            cell.buttons.move.title = cell.buttons.move.disabled ? '至少觀看兩台才可搬位' : `進入搬位模式：${name}`;
            cell.buttons.move.setAttribute('aria-label', `進入搬位模式：${name}`);
            if (audioFocusAvailable() && activePlayers.has(key)) {
                if (!cell.buttons.audio) {
                    const audio = document.createElement('button');
                    audio.type = 'button';
                    audio.className = 'player-window-audio';
                    audio.dataset.playerAction = 'audio-focus';
                    audio.textContent = '🔊';
                    cell.buttons.move.after(audio);
                    cell.buttons.audio = audio;
                }
                const label = `只開此台聲音（100%）：${name}`;
                cell.buttons.audio.title = label;
                cell.buttons.audio.setAttribute('aria-label', label);
            } else if (cell.buttons.audio) {
                const focused = document.activeElement === cell.buttons.audio;
                cell.buttons.audio.remove();
                delete cell.buttons.audio;
                if (focused) cell.buttons.move.focus({ preventScroll: true });
            }
            // Keep the two left shortcuts and the right toolbar distinct even
            // when a small window leaves very little room in a tile.
            const toolbarCount = span > 1 ? 3 : 2;
            const cornerSize = cell.buttons.audio ? Math.max(1, Math.min(18,
                Math.floor((rect.width - 12) / (toolbarCount + 2)), Math.floor((rect.height - 10) / 2))) : 18;
            cell.node.style.setProperty('--player-corner-size', `${cornerSize}px`);
            cell.node.style.setProperty('--player-corner-font', `${Math.min(14, cornerSize)}px`);
            cell.node.style.setProperty('--player-corner-padding', cornerSize < 18 ? '1px' : '3px');
            const source = geometryItems.get(key);
            const targets = new Set();
            for (const [direction, label] of Object.entries(directions)) {
                for (const neighbor of source ? PlayerGeometry.neighbors(geometry, key, direction) : []) {
                    const target = activePlayers.get(neighbor.key);
                    const targetRect = rectangles.get(neighbor.key);
                    if (!target || !targetRect) continue;
                    const identity = `${direction}:${neighbor.key}`;
                    targets.add(identity);
                    let button = cell.directionButtons.get(identity);
                    if (!button) {
                        button = document.createElement('button');
                        button.type = 'button';
                        button.className = `player-direction-button player-direction-${direction}`;
                        button.dataset.playerAction = `swap-${direction}`;
                        button.dataset.targetKey = neighbor.key;
                        button.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="${triangles[direction]}"/></svg>`;
                        cell.node.appendChild(button);
                        cell.directionButtons.set(identity, button);
                    }
                    const oppositeLabels = { up: '下', down: '上', left: '右', right: '左' };
                    const description = source.span > 1 ? `向${label}平移一格：${name}（鄰格：${target.channel.name}）` :
                        neighbor.span > 1 ? `將「${target.channel.name}」向${oppositeLabels[direction]}平移一格（靠近 ${name}）` :
                        `與${label}方「${target.channel.name}」交換位置：${name}`;
                    button.title = description;
                    button.setAttribute('aria-label', description);
                    const vertical = direction === 'up' || direction === 'down';
                    const start = vertical ? Math.max(rect.left, targetRect.left) : Math.max(rect.top, targetRect.top);
                    const end = vertical ? Math.min(rect.right, targetRect.right) : Math.min(rect.bottom, targetRect.bottom);
                    const size = Math.max(1, Math.min(14, end - start - 2, rect.width / 2 - 2, rect.height / 2 - 2));
                    button.style.width = `${size}px`;
                    button.style.height = `${size}px`;
                    // Even a compact enlarged cell must keep opposite arrows
                    // apart. Never shift an arrow beyond its half of the cell.
                    const inset = (dimension, inward) => Math.max(0, Math.min(inward ? 23 : 3, (dimension - 2 * size - 2) / 2));
                    if (vertical) {
                        const center = (start + end) / 2 - rect.left;
                        button.style.left = `${center}px`;
                        // Keep the arrow aligned with its target, moving inward
                        // only when its hit area would overlap a corner control.
                        if (direction === 'up') {
                            const overlapsCorner = center < (cell.buttons.audio ? 2 * cornerSize + 13 : 28) || center > rect.width - (toolbarCount * cornerSize + 10);
                            button.style.top = `${inset(rect.height, overlapsCorner)}px`;
                        } else button.style.bottom = `${inset(rect.height, center < 28 || center > rect.width - 28)}px`;
                    } else {
                        let center = (start + end) / 2 - rect.top;
                        const inward = center < 28 || center > rect.height - 28;
                        if (cell.buttons.audio && center - size / 2 < cornerSize + 4) {
                            center = Math.min(rect.height - size / 2 - 3, cornerSize + 4 + size / 2);
                        }
                        button.style.top = `${center}px`;
                        button.style[direction] = `${inset(rect.width, inward)}px`;
                    }
                }
            }
            for (const [identity, button] of cell.directionButtons) if (!targets.has(identity)) {
                const focused = document.activeElement === button;
                button.remove(); cell.directionButtons.delete(identity);
                if (focused) cell.buttons.move.focus({ preventScroll: true });
            }
            cell.node.style.left = `${rect.left - bounds.left - wrapper.clientLeft + wrapper.scrollLeft}px`;
            cell.node.style.top = `${rect.top - bounds.top - wrapper.clientTop + wrapper.scrollTop}px`;
            cell.node.style.width = `${rect.width}px`;
            cell.node.style.height = `${rect.height}px`;
        }
        layer.hidden = blocked() || !visible.length;
        updateHover();
    }
    function schedule() {
        if (suspended || frame !== null) return;
        frame = requestAnimationFrame(() => { frame = null; render(); });
    }
    layer.addEventListener('click', async event => {
        const button = event.target.closest('button[data-player-action]');
        if (!button || blocked() || button.disabled) return;
        event.preventDefault(); event.stopPropagation();
        const key = button.closest('.player-window-cell').dataset.playerKey;
        if (button.dataset.playerAction === 'close') {
            // Reflow can move another close button under a double-click.
            if (event.detail > 1) return;
            await closePlayer(key);
        } else if (button.dataset.playerAction === 'enlarge') {
            await enlargePlayer(key);
        }
        else if (button.dataset.playerAction === 'audio-focus') {
            if (!audioFocusAvailable() || !activePlayers.has(key)) return;
            getPlayerElement(activePlayers.get(key))?.dispatchEvent(
                new Event('umininn-player-audio-focus', { bubbles: true }));
        }
        else if (button.dataset.playerAction === 'shrink') await shrinkPlayer(key);
        else if (button.dataset.playerAction === 'move') playerPositionEditor?.openMove(key, button);
        else if (button.dataset.playerAction.startsWith('swap-')) {
            if (event.detail > 1) return;
            const direction = button.dataset.playerAction.slice(5);
            const neighbor = PlayerGeometry.neighbors(getCurrentPlayerGeometry(), key, direction)
                .find(item => item.key === button.dataset.targetKey);
            if (!neighbor || !activePlayers.has(neighbor.key)) { render(); return; }
            await movePlayerDirection(key, direction, neighbor.key);
            render();
            // Follow the moved player without reparenting its media element.
            const next = cells.get(key)?.directionButtons.get(`${direction}:${neighbor.key}`);
            const target = next || cells.get(key)?.buttons.move;
            if (event.detail === 0) target?.focus({ preventScroll: true });
            return;
        }
        render();
    });
    function observe() {
        mutations.observe(pane, { childList: true, subtree: true });
        modeObserver.observe(document.documentElement, { attributes: true,
            attributeFilter: ['data-umininn-player-userscript', 'data-umininn-player-audio-focus-ready'] });
        if (editor) modeObserver.observe(editor, { attributes: true, attributeFilter: ['hidden'] });
        window.addEventListener('resize', schedule);
        wrapper.addEventListener('scroll', schedule, { passive: true });
    }
    window.addEventListener('pagehide', () => {
        suspended = true; layer.hidden = true;
        observer?.disconnect(); observed.clear(); mutations.disconnect(); modeObserver.disconnect();
        window.removeEventListener('resize', schedule); wrapper.removeEventListener('scroll', schedule);
        if (frame !== null) cancelAnimationFrame(frame);
        if (hoverFrame !== null) cancelAnimationFrame(hoverFrame);
        frame = hoverFrame = null;
    });
    window.addEventListener('pageshow', () => { suspended = false; observe(); render(); });
    document.addEventListener('fullscreenchange', schedule);
    document.addEventListener('webkitfullscreenchange', schedule);
    playerWindowControls = { refresh: schedule };
    observe(); render();
})();

function toggleChannelMenu() {
    const menu = document.getElementById("channel-menu");
    if (menu.style.display === "none" || getComputedStyle(menu).display === "none") {
        document.getElementById("channel-count").textContent = channels.length;
        const list = document.getElementById("menu-channel-list");
        list.innerHTML = "";
        const frag = document.createDocumentFragment();
        channels.forEach(ch => {
            const statusKey = `${ch.platform}_${ch.id}`;
            const safeId = statusKey.replace(/[^a-zA-Z0-9]/g, '_');
            const btn = document.createElement("button");
            btn.className = "menu-status-button status-button";
            btn.id = `menu-btn-${safeId}`;
            const span = document.createElement("span");
            span.className = "status-indicator";
            span.id = `menu-status-${safeId}`;
            btn.appendChild(span);
            btn.appendChild(document.createTextNode(` ${platformIcon(ch.platform)}${escapeHtml(ch.name)}`));
            btn.onclick = () => { displaySingleChannel(ch); toggleChannelMenu(); };
            frag.appendChild(btn);
        });
        list.appendChild(frag);
        channels.forEach(ch => updateMenuButtonStatus(ch));
        menu.style.display = "block";
        document.body.style.overflow = "hidden";
    } else {
        menu.style.display = "none";
        document.body.style.overflow = "auto";
    }
}

function openDeleteModal() {
    const modal = document.getElementById('deleteChannelModal');
    if (!modal) return;
    renderDeleteChannelList();
    modal.classList.add('active');
}
function closeDeleteModal() {
    document.getElementById('deleteChannelModal')?.classList.remove('active');
}
function renderDeleteChannelList() {
    const container = document.getElementById('deleteChannelListContainer');
    if (!container) return;
    if (!channels.length) {
        container.innerHTML = '<div style="color:var(--label-2); text-align:center; padding:20px;">📭 沒有任何頻道可刪除</div>';
        return;
    }
    container.innerHTML = '';
    const frag = document.createDocumentFragment();
    channels.forEach((ch, idx) => {
        const statusKey = `${ch.platform}_${ch.id}`;
        const status = channelStatuses[statusKey] || 'unknown';
        let statusColor = '#636366';
        if (status === 'live') statusColor = 'var(--green)';
        else if (status === 'not-live') statusColor = 'var(--red)';
        const icon = platformIcon(ch.platform);
        const div = document.createElement('div');
        div.className = 'channel-item-delete';
        div.innerHTML = `
            <input type="checkbox" class="delete-channel-cb" data-idx="${idx}" data-name="${escapeHtml(ch.name)}" data-platform="${ch.platform}" data-id="${escapeHtml(ch.id)}">
            <div class="channel-info">
                <span class="del-status-bullet" style="background: ${statusColor};"></span>
                <span class="del-channel-name">${icon} ${escapeHtml(ch.name)}</span>
                <span class="del-channel-meta">${escapeHtml(platformLabel(ch.platform))}</span>
                <span style="font-size:0.65rem; color:var(--label-2);">${escapeHtml(String(ch.id).substring(0,28))}</span>
            </div>
        `;
        frag.appendChild(div);
    });
    container.appendChild(frag);

    const selectAllCb = document.getElementById('deleteSelectAll');
    if (selectAllCb) {
        selectAllCb.checked = false;
        selectAllCb.onchange = (e) => {
            document.querySelectorAll('#deleteChannelListContainer .delete-channel-cb').forEach(cb => cb.checked = e.target.checked);
        };
    }
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        if (m === '"') return '&quot;';
        return '&#39;';
        return m;
    });
}

function confirmDeleteChannels() {
    const selected = document.querySelectorAll('#deleteChannelListContainer .delete-channel-cb:checked');
    if (selected.length === 0) { alert("⚠️ 請至少選擇一個要刪除的頻道"); return; }
    const toDelete = [];
    selected.forEach(cb => {
        toDelete.push({ name: cb.dataset.name, id: cb.dataset.id, platform: cb.dataset.platform });
    });
    toDelete.forEach(channel => ChannelList.forgetChannel(localStorage, channel));
    const newChannels = channels.filter(ch =>
        !toDelete.some(del => del.name === ch.name && del.id === ch.id && del.platform === ch.platform)
    );
    if (newChannels.length === channels.length) return;
    channels = newChannels;
    pruneActivePlayers();
    saveChannelsToStorage();
    generateButtons();

    if (currentDisplayChannel && !channels.some(ch => ch.id === currentDisplayChannel.id && ch.platform === currentDisplayChannel.platform)) {
        displaySingleChannel(null);
    }
    const selectionDiv = document.getElementById("channel-selection");
    if (selectionDiv && selectionDiv.style.display !== "none") generateChannelOptions({ preserveSelection: true });
    if (document.getElementById('channel-menu').style.display === 'block') {
        toggleChannelMenu();
        setTimeout(() => toggleChannelMenu(), 100);
    }
    closeDeleteModal();
}
window.editClick = function () { showChannelManager('channels'); };

function showPopup() {
    showChannelManager('manage');
}

function showChannelManager(section = '') {
    window.open('./channel-manager.html' + (section ? '#' + section : ''), 'umininn-channel-manager', 'width=800,height=800,noopener');
}

function showUserscript() {
    window.open('./userscript/', 'umininn-userscript', 'width=860,height=680,noopener');
}

/* 隱藏離線開關 */
(function initHideNotLiveToggle() {
    const toggle = document.getElementById('toggleNotLive');
    let styleEl = null;
    function apply(shouldHide) {
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'dynamic-hide-notlive';
            document.head.appendChild(styleEl);
        }
        styleEl.textContent = shouldHide
            ? `.not-live { display: none !important; } .button-wrapper:has(.not-live), #channel-options > .channel-option-cell:has(.channel-option-label.not-live) { display: none !important; }`
            : '';
    }
    const saved = localStorage.getItem('hideNotLiveToggle');
    toggle.checked = saved === 'true';
    apply(toggle.checked);
    toggle.addEventListener('change', (e) => {
        apply(e.target.checked);
        updateChannelSelectionSummary();
        localStorage.setItem('hideNotLiveToggle', e.target.checked);
    });
})();

/* 聊天切換 Toggle (紫色) & 記憶用戶最後選擇 */
(function initChatToggle() {
    const toggle = document.getElementById('chatToggle');
    const iframe = document.getElementById('chat_embed');
    const control = document.getElementById('chatToggleWrapper');
    const home = document.getElementById('chat-mode-home');
    if (!toggle || !iframe || !control || !home) return;

    function returnControl() {
        home.appendChild(control);
        home.hidden = false;
    }
    function placeControl() {
        if (toggle.checked) return;
        try {
            const auth = iframe.contentDocument?.getElementById('auth-area');
            if (!auth) { returnControl(); return; }
            // Moving only our control keeps the chat's login button, handlers,
            // active connection and login state in their original document.
            auth.insertBefore(control, auth.firstChild);
            home.hidden = true;
        } catch (_) { returnControl(); }
    }

    function applyChatState(isAltChat) {
        // Rescue the same control before navigating away from its document.
        returnControl();
        if (isAltChat) {
            iframe.src = `https://www.twitch.tv/embed/whitewing940920/chat?darkpopout&parent=${encodeURIComponent(parent)}`;
        } else {
            const custom = new URL(('./test3.html') + '?v=20261021-chat-resources', location.href).href;
            if (iframe.src !== custom) iframe.src = custom;
            else placeControl();
        }
    }
    iframe.addEventListener('load', placeControl);
    let savedState = null;
    try { savedState = localStorage.getItem('chatToggleState'); } catch (_) {}
    const isChecked = savedState === 'true';
    toggle.checked = isChecked;
    applyChatState(isChecked);

    toggle.addEventListener('change', (e) => {
        const checked = e.target.checked;
        applyChatState(checked);
        try { localStorage.setItem('chatToggleState', checked); } catch (_) {}
    });
})();

/* ======================== 手機模式：自由調整 影片 / 聊天 大小 ========================
   ★ 修正重點：
   1. pointermove / pointerup / pointercancel 改掛在 document 上，
      避免 iOS Safari 的 setPointerCapture 失效導致事件斷線。
   2. onPointerMove 加入 PAD 提前量，手指不用真的貼到螢幕頂端也能推到極限。
   ================================================================================= */
(function initMobileResizer() {
    const wrapper   = document.getElementById('multi-stream-container-wrapper');
    const videoPane = document.getElementById('multi-stream-container');
    const resizer   = document.getElementById('mobile-resizer');
    if (!wrapper || !videoPane || !resizer) return;

    const STORAGE_KEY   = 'mobileVideoChatRatio';
    const DEFAULT_RATIO = 4 / 7;   // 對應原本的 flex 4 : 3
    const MIN_RATIO     = 0.02;    // 影片最小高度比例（= chat 最大 98%）
    const MAX_RATIO     = 0.98;    // 影片最大高度比例（= chat 最小 2%）
    const PAD           = 48;      // 手指提前量（px）：上下各留 48px 緩衝

    const clamp = r => Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));
    let currentRatio = DEFAULT_RATIO;

   function applyRatio(ratio) {
    currentRatio = clamp(ratio);

    // CSS 變數只在手機模式下被消費，桌面無影響
    wrapper.style.setProperty('--video-flex', String(currentRatio));
    wrapper.style.setProperty('--chat-flex',  String(1 - currentRatio));

    const isMobile = window.innerWidth <= 768;
    const vp = document.getElementById('multi-stream-container');
    const ce = document.getElementById('chat-panel') || document.getElementById('chat_embed');
    if (!vp || !ce) return;

    if (isMobile) {
        // ★ 只在手機模式打 inline style
        vp.style.setProperty('flex',      `${currentRatio} 1 0`, 'important');
        vp.style.setProperty('min-height', '0',                'important');
        vp.style.setProperty('height',     'auto',             'important');
        ce.style.setProperty('flex',      `${1 - currentRatio} 1 0`, 'important');
        ce.style.setProperty('min-height', '0',                'important');
        ce.style.setProperty('height',     'auto',             'important');
    } else {
        // ★ 桌面模式：清掉所有 inline style，交還給 CSS
        vp.style.removeProperty('flex');
        vp.style.removeProperty('min-height');
        vp.style.removeProperty('height');
        ce.style.removeProperty('flex');
        ce.style.removeProperty('min-height');
        ce.style.removeProperty('height');
    }
}

    // 還原上次拖曳的比例
    let saved = NaN;
    try { saved = parseFloat(localStorage.getItem(STORAGE_KEY)); } catch (_) {}
    applyRatio(Number.isFinite(saved) ? saved : DEFAULT_RATIO);

    let dragging  = false;
    let pointerId = null;

    function onPointerDown(e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        dragging  = true;
        pointerId = e.pointerId;
        resizer.classList.add('dragging');
        wrapper.classList.add('resizing');
        try { resizer.setPointerCapture(pointerId); } catch (_) {}
        e.preventDefault();
    }

    function onPointerMove(e) {
        if (!dragging || e.pointerId !== pointerId) return;

        const rect = wrapper.getBoundingClientRect();
        const cs   = getComputedStyle(wrapper);
        const padTop    = parseFloat(cs.paddingTop)    || 0;
        const padBottom = parseFloat(cs.paddingBottom) || 0;
        const resizerH  = resizer.offsetHeight || 0;

        const top    = rect.top + padTop;
        const usable = rect.height - padTop - padBottom - resizerH;
        if (usable <= 0) return;

        // ★ 提前量：手指不用真的貼到頂 / 底，也能推到 0 / 1
        const ratio = (e.clientY - (top - PAD)) / (usable + PAD * 2);

        applyRatio(ratio);
        e.preventDefault();
    }

    function endDrag(e) {
        if (!dragging) return;
        if (e && e.pointerId !== undefined && e.pointerId !== pointerId) return;
        dragging = false;
        resizer.classList.remove('dragging');
        wrapper.classList.remove('resizing');
        if (pointerId !== null) {
            try { resizer.releasePointerCapture(pointerId); } catch (_) {}
        }
        pointerId = null;
        try { localStorage.setItem(STORAGE_KEY, String(currentRatio)); } catch (_) {}
    }

    // ★ 只在 resizer 上監聽 pointerdown，其餘掛在 document
    resizer.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointermove',   onPointerMove);
    document.addEventListener('pointerup',     endDrag);
    document.addEventListener('pointercancel', endDrag);

    // 雙擊還原預設比例
    resizer.addEventListener('dblclick', () => {
	
        applyRatio(DEFAULT_RATIO);
        try { localStorage.setItem(STORAGE_KEY, String(currentRatio)); } catch (_) {}
		
    });
	 window.addEventListener('resize', () => {
        applyRatio(currentRatio);
    });
})();

/* 加台模態窗 */
function buildPlatformOptions() {
    const sel = document.getElementById('modal-channel-platform');
    if (!sel) return;
    sel.innerHTML = '';
    Object.entries(PLATFORMS).forEach(([key, p]) => {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = p.label;
        sel.appendChild(opt);
    });
    updateIdPlaceholder();
    sel.addEventListener('change', updateIdPlaceholder);
}

function updateIdPlaceholder() {
    const sel = document.getElementById('modal-channel-platform');
    const idInput = document.getElementById('modal-channel-id');
    if (!sel || !idInput) return;
    const p = PLATFORMS[sel.value];
    idInput.placeholder = (p && p.idPlaceholder) ? p.idPlaceholder : '頻道ID / 影片ID / M3U8網址 / 完整Embed網址';
}

(function initChannelActions() {
    const menu = document.getElementById('channel-actions');
    if (!menu) return;
    menu.addEventListener('change', () => {
        const action = menu.value;
        menu.value = '';
        if (action === 'manage') showPopup();
        else if (['new', 'channels', 'sklive', 'health'].includes(action)) showChannelManager(action);
        else if (action === 'userscript') showUserscript();
    });
})();

document.getElementById('confirmAddChannel').onclick = async () => {
    const name = document.getElementById('modal-channel-name').value.trim();
    let id = document.getElementById('modal-channel-id').value.trim();
    const platform = document.getElementById('modal-channel-platform').value.toLowerCase();

    if (!name || !id) return alert("請完整填寫名稱及ID");

    const p = getPlatform(platform);
    if (!p) return alert("⚠️ 未知的平台類型");

    let extra = {};
    if (typeof p.resolveId === 'function') {
        try {
            const resolved = await p.resolveId(id);
            id = resolved.id;
            extra = resolved;
        } catch (e) {
            return alert('⚠️ ' + e.message);
        }
    }

    const newChannel = { name, id, platform, ...extra };
    ChannelList.restoreChannel(localStorage, newChannel);
    channels = ChannelList.mergeChannels([newChannel], channels);
    saveChannelsToStorage();
    generateButtons();
    document.getElementById('addChannelModal').classList.remove('active');
};
document.getElementById('cancelAddChannel').onclick = () =>
    document.getElementById('addChannelModal').classList.remove('active');
document.getElementById('addChannelModal').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-mask')) document.getElementById('addChannelModal').classList.remove('active');
});

document.getElementById('confirmDeleteChannels').onclick = confirmDeleteChannels;
document.getElementById('cancelDeleteModal').onclick = closeDeleteModal;
document.getElementById('deleteChannelModal')?.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-mask')) closeDeleteModal();
});

/* ======================== 啟動 ======================== */
async function initializeTvApp() {
    buildPlatformOptions();
    await loadTwitchCredentials();
    await loadChannelsFromUrl();

    // 狀態檢查：原本的 5 分鐘
    setInterval(() => fetchAllStatuses({ force: true }), 300000);

    setInterval(pollCh1TxtForUpdates, 60000);
    // 分頁重新回到前景時也檢查一次，手機切回來能馬上同步
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) pollCh1TxtForUpdates();
    });
    window.addEventListener('focus', pollCh1TxtForUpdates);
    window.addEventListener('storage', event => {
        if (event.storageArea && event.storageArea !== localStorage) return;
        if (event.key === ChannelList.sharedUpdateKey || event.key === null) pollCh1TxtForUpdates();
    });
}

window.tvAppReady = initializeTvApp();
window.addEventListener('pagehide', event => {
    if (!event.persisted) destroyAllHLSInstances();
});
