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
        const data = await getGoshMetadata(ch);
        return data.isLive ? 'live' : 'not-live';
    },
    getStreamUrl: async (ch) => {
        const data = await getGoshMetadata(ch);
        if (!data.isLive) throw new Error('主播目前未開播');
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
                // A synchronous fatal SDK event may already have retired it.
                if (resource.disposed || resource.failed || resource.hls !== hls || !video.isConnected) return;
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
    d.dataset.umininnPlayerPlaceholder = 'error';
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
const playerResources = new WeakMap();
// Playback owns connected instances; layout only owns cells and projects CSS.
const playerRegistry = PlayerLifecycle.create({
    render: renderChannelElement,
    getResource: element => playerResources.get(element),
    dispose: disposePlayerResource,
    prepareReplace: preparePlayerPresentationReplace
});
const activePlayers = playerRegistry.entries;
const PLAYER_POSITION_STORAGE_KEY = 'playerPositionOrder';
const PLAYER_ENLARGEMENT_STORAGE_KEY = 'playerEnlargementLayout';
const PLAYER_FOCUS_SWAP_STORAGE_KEY = 'playerFocusSwapMemory';
// Shared duration for the viewing page's temporary menus and editing overlays.
const PLAYER_OVERLAY_TIMEOUT_SECONDS = 30;
const playerLayoutState = PlayerLayout.createState({ buildGeometry: PlayerGeometry.build });
const playerLayoutOperations = PlayerLayout.createOperations({ geometry: PlayerGeometry });
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
    const id = typeof channel?.id === 'string' ? channel.id.trim().toLowerCase() : '';
    const unavailable = () => new Error('Gosh 直播資料暫時未能取得');
    if (!/^[a-z0-9_][a-z0-9_-]{0,79}$/.test(id)) return Promise.reject(unavailable());

    function validated(data) {
        if (!data || typeof data !== 'object' || Array.isArray(data) ||
            typeof data.isLive !== 'boolean' || data.error || data.errors || data.success === false) throw unavailable();
        for (const key of ['status', 'statusCode', 'code']) {
            const value = data[key];
            if (value !== undefined && value !== null &&
                (Number(value) >= 400 || /(?:error|failed|forbidden|unauthori[sz]ed)/i.test(String(value)))) throw unavailable();
        }
        const identity = data.channelId ?? data.cid;
        if (identity !== undefined && String(identity).toLowerCase() !== id) throw unavailable();
        if (!data.isLive) return { isLive: false, m3u8Url: '' };
        if (typeof data.m3u8Url !== 'string' || data.m3u8Url.length > 8192) throw unavailable();
        let url;
        try { url = new URL(data.m3u8Url); } catch (_) { throw unavailable(); }
        const host = url.hostname;
        if (url.protocol !== 'https:' || url.username || url.password || url.port || !/\.m3u8$/i.test(url.pathname) ||
            !host.includes('.') || host.startsWith('[') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) throw unavailable();
        if (/^\d+(?:\.\d+){3}$/.test(host)) {
            const [a, b] = host.split('.').map(Number);
            if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
                (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
                (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))) throw unavailable();
        }
        return { isLive: true, m3u8Url: url.href };
    }

    async function readMetadata(response) {
        const maximum = 64 * 1024;
        if (!response || !response.ok || Number(response.headers?.get('content-length')) > maximum) throw unavailable();
        let body = '';
        if (response.body && typeof response.body.getReader === 'function') {
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8', { fatal: true });
            let bytes = 0;
            try {
                while (true) {
                    const part = await reader.read();
                    if (part.done) break;
                    bytes += part.value.byteLength;
                    if (bytes > maximum) { reader.cancel().catch(() => {}); throw unavailable(); }
                    body += decoder.decode(part.value, { stream: true });
                }
                body += decoder.decode();
            } finally { try { reader.releaseLock(); } catch (_) {} }
        } else {
            body = await response.text();
            if (new TextEncoder().encode(body).byteLength > maximum) throw unavailable();
        }
        let data;
        try { data = JSON.parse(body); } catch (_) { throw unavailable(); }
        return validated(data);
    }

    return goshMetadataRequests.run(id, async () => {
        const first = getNextGoshProxy();
        const workers = [first, ...GOSH_PROXY_LIST.filter(proxy => proxy !== first)].slice(0, 2);
        const metadataUrl = 'https://skknower.com/api/userlive/gosh?cid=' + encodeURIComponent(id);
        // Only public channel metadata goes to these fixed proxies. The returned
        // temporary playback URL stays in memory and is fetched directly by HLS.
        const urls = PROXY_LIST.slice(0, 2).map(proxy => proxy + '/?quest=' + encodeURIComponent(metadataUrl)).concat(
            workers.map(proxy => proxy + '/?channelId=' + encodeURIComponent(id)));
        for (const url of urls) {
            try {
                return await StreamPerformance.withRequestTimeout(async signal => {
                    const response = await fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store',
                        redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal });
                    return readMetadata(response);
                }, { timeoutMs: 4500 });
            } catch (_) { /* A transport or provider error is not an offline finding. */ }
        }
        throw unavailable();
    });
}

function preparePlayerPresentationReplace(entry, current) {
    // Every owned presentation replacement retires its old native routes, not
    // only error UIs. Unconfirmed media stay attached and under sound control.
    const routes = new Set(), roots = new Set();
    if (entry.resource?.video) routes.add(entry.resource.video);
    function collect(container, depth = 0) {
        if (!container || roots.has(container)) return;
        if (depth >= 16) throw new Error('Native media inventory is incomplete');
        roots.add(container);
        if (['VIDEO', 'AUDIO'].includes(String(container.tagName).toUpperCase())) routes.add(container);
        for (const media of container.querySelectorAll?.('video,audio') || []) routes.add(media);
        for (const node of [container, ...(container.querySelectorAll?.('*') || [])]) {
            const tag = String(node.tagName).toUpperCase();
            if (['IFRAME', 'OBJECT', 'EMBED'].includes(tag) || tag.includes('-') && !node.shadowRoot)
                throw new Error('The current presentation contains an unconfirmed media route');
            if (node.shadowRoot) collect(node.shadowRoot, depth + 1);
        }
    }
    try { collect(current.element); } catch (_) { return false; }
    for (const media of routes) {
        try { media.muted = true; } catch (_) {}
        try { media.pause(); } catch (_) {}
        if (!playerRegistry.isCurrent(current)) return false;
        try { if (media.muted !== true) return false; } catch (_) { return false; }
    }
    return playerRegistry.isCurrent(current);
}

function replacePlayerWithError(resource, message) {
    if (resource.disposed || resource.errorShown || !resource.element.isConnected) return;
    const lease = playerRegistry.leaseForResource(resource);
    if (!lease) return;
    const error = buildErrorDiv(message);
    for (const token of ['video', 'full-screen-video'])
        error.classList.toggle(token, lease.element.classList.contains(token));
    if (!playerRegistry.replaceElement(lease, error)) {
        if (playerRegistry.isCurrent(lease)) lease.entry.failed = resource.failed = true;
        return;
    }
    lease.entry.failed = true;
    resource.failed = true;
    resource.errorShown = true;
    // Overlay refreshes must not interrupt the provider's fatal-error cleanup.
    for (const refresh of [projectPlayerLayout, () => playerNameOverlay?.refresh(),
        () => playerWindowControls?.refresh(), () => playerPositionEditor?.refresh()]) {
        try { refresh(); } catch (_) {}
    }
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
    const lease = playerRegistry.lease(entry);
    return lease ? playerRegistry.remove(lease.key, entry) : false;
}

function disposePlayerResource(entry) {
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
    playerRegistry.clear();
    playerLayoutState.setOrder([]);
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
    return playerRegistry.element(entry);
}

function projectPlayerLayout() {
    const geometry = playerLayoutState.geometry;
    const positions = new Map(geometry.items.map(item => [item.key, item]));
    let changed = false;
    playerLayoutState.order.forEach((key, index) => {
        const entry = activePlayers.get(key);
        if (!entry) return;
        const element = getPlayerElement(entry);
        const item = positions.get(key);
        const order = String(index), area = item ? playerGridArea(item) : '';
        if (element.style.order !== order) { element.style.order = order; changed = true; }
        if (element.style.gridArea !== area) { element.style.gridArea = area; changed = true; }
    });
    return changed;
}

function updatePlayerLayout({ force = false } = {}) {
    const pane = document.getElementById('multi-stream-container');
    if (!pane) return;
    if (!playerGrid) playerGrid = PlayerLayout.observe(pane, {
        runUpdate: (action, requiresLayout) => withPlayerAudioLayout(action, { requiresLayout }),
        stabilizeResize: true,
        getResizeStability: () => activePlayers.size > 1 && activePlayers.has(playerLayoutState.focus?.key),
        getCount: () => activePlayers.size,
        getTrackCount: () => {
            const focus = activePlayers.size > 1 && activePlayers.has(playerLayoutState.focus?.key) ? playerLayoutState.focus : null;
            return Math.max(activePlayers.size + (focus?.span || 1) - 1, focus ? focus.row + focus.span : 1,
                focus ? Math.max(playerLayoutState.pending?.columns || 0, playerLayoutState.enlargedGeometry?.columns || 0) : 1);
        },
        calculate(options) {
            return calculatePlayerLayout(options, false);
        },
        onCommit(next, options) {
            return playerLayoutState.commit(calculatePlayerLayout(options));
        },
        onChange() {
            projectPlayerLayout();
            if (playerLayoutState.enlargedGeometry) savePlayerEnlargement();
            playerPositionEditor?.layoutChanged?.();
            playerNameOverlay?.refresh();
            playerWindowControls?.refresh();
        }
    });
    const previousFocus = playerLayoutState.enlargedGeometry?.items.find(item => item.span > 1);
    const activeFocus = activePlayers.size > 1 && activePlayers.has(playerLayoutState.focus?.key) ? playerLayoutState.focus : null;
    const contextChanged = previousFocus?.key !== activeFocus?.key || previousFocus?.span !== activeFocus?.span;
    const result = playerGrid.update({ force: force || contextChanged || playerLayoutState.pending?.intent === 'bookmark' });
    // A retry may replace one player while keeping exactly the same geometry.
    if (projectPlayerLayout()) playerWindowControls?.refresh();
    return result;
}

function calculatePlayerLayout(options, commit = true) {
    const plan = playerLayoutOperations.reflow({ keys: getPlayerPositionKeys(),
        focus: playerLayoutState.focus, pending: playerLayoutState.pending }, options);
    if (commit) playerLayoutState.setPending(plan.pending);
    return plan.next.items ? plan.next : { ...plan.next,
        ...PlayerGeometry.build({ keys: getPlayerPositionKeys(), columns: plan.next.columns }) };
}

function playerGridArea(item) {
    return `${item.row + 1} / ${item.column + 1} / span ${item.span} / span ${item.span}`;
}

function getCurrentPlayerGeometry() {
    return playerLayoutState.geometry;
}

function savePlayerEnlargement() {
    try {
        if (!playerLayoutState.focus) localStorage.removeItem(PLAYER_ENLARGEMENT_STORAGE_KEY);
        else localStorage.setItem(PLAYER_ENLARGEMENT_STORAGE_KEY, JSON.stringify({
            version: 1, columns: playerLayoutState.pending?.columns || playerLayoutState.enlargedGeometry?.columns || 1, focus: playerLayoutState.focus
        }));
    } catch (_) {}
}

function applyPlayerSize(next, { optimize = true, growthAnchor } = {}) {
    const nextFocus = next.items.find(item => item.span > 1) || null;
    const sameFocus = nextFocus?.key === playerLayoutState.focus?.key && nextFocus?.row === playerLayoutState.focus?.row &&
        nextFocus?.column === playerLayoutState.focus?.column && nextFocus?.span === playerLayoutState.focus?.span;
    if (!optimize && !PlayerLayout.compare(playerLayoutState.geometry, next).changed &&
        !playerLayoutState.geometry.deferredFocus && !playerLayoutState.pending && sameFocus) return false;
    // Capture the reflowed order before the final shrink returns to normal tracks.
    playerLayoutState.commit(next);
    playerLayoutState.setFocus(next.items.find(item => item.span > 1) || null);
    playerLayoutState.setPending(playerLayoutState.focus || (optimize && growthAnchor?.span === 1) ? { ...next, intent: optimize ? 'size' : 'drag',
        ...(optimize && growthAnchor ? { growthAnchor } : {}) } : null);
    updatePlayerLayout({ force: true });
    playerLayoutState.rememberOrder();
    try { localStorage.setItem(PLAYER_POSITION_STORAGE_KEY, JSON.stringify(playerLayoutState.preferredOrder)); } catch (_) {}
    savePlayerEnlargement();
    playerPositionEditor?.refresh();
    playerNameOverlay?.refresh();
    return true;
}

function enlargePlayer(key) {
    if (activePlayers.size < 2 || !activePlayers.has(key)) return false;
    if (playerLayoutState.focus?.key === key && playerLayoutState.focus.span >= 256) return false;
    const plan = playerLayoutOperations.grow(getCurrentPlayerGeometry(), key);
    return applyPlayerSize(plan.next, { growthAnchor: plan.growthAnchor });
}

function shrinkPlayer(key) {
    if (activePlayers.size < 2 || !activePlayers.has(key)) return false;
    const current = playerLayoutState.enlargedGeometry?.items.find(item => item.key === key);
    if (!current || current.span <= 1) return false;
    const plan = playerLayoutOperations.shrink(playerLayoutState.enlargedGeometry, key);
    return plan.kind !== 'none' && applyPlayerSize(plan.next, { growthAnchor: plan.growthAnchor });
}

function closePlayer(key) {
    const pane = document.getElementById('multi-stream-container');
    const entry = activePlayers.get(key);
    const initial = key === 'initial-player' && !activePlayers.size && pane?.querySelector('#MyFrame');
    if (!entry && !initial) return false;
    const muted = getGlobalMuted();
    if (entry) disposePlayer(entry);
    else initial.remove();
    playerLayoutState.setOrder(playerLayoutState.order.filter(value => activePlayers.has(value)));
    // A close must not re-render retained players or apply the 2-to-1 audio rule.
    if (globalMutedPreference === null && activePlayers.size && muted !== getGlobalMuted()) globalMutedPreference = muted;
    if (playerLayoutState.focus?.key === key || activePlayers.size < 2) {
        playerLayoutState.setFocus(null);
        playerLayoutState.setPending(null);
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
    return [...playerLayoutState.order];
}

function swapPlayerPositions(sourceKey, targetKey) {
    return applyPlayerPlacement(playerLayoutOperations.exchange(getCurrentPlayerGeometry(), sourceKey, targetKey));
}

function swapPlayerWithFocus(key) {
    if (!activePlayers.has(key)) return false;
    const layout = getCurrentPlayerGeometry();
    const signature = value => JSON.stringify([value.columns, value.rows, [...value.items]
        .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
        .map(item => [item.key, item.row, item.column, item.span])]);
    let memory = null;
    try {
        const saved = JSON.parse(localStorage.getItem(PLAYER_FOCUS_SWAP_STORAGE_KEY));
        if (saved?.version === 1 && activePlayers.has(saved.large) && activePlayers.has(saved.small) &&
            saved.layout === signature(layout)) memory = saved;
    } catch (_) {}
    const plan = playerLayoutOperations.swapFocus(layout, key, memory);
    if (plan.kind === 'none' || !activePlayers.has(plan.sourceKey)) return false;
    // Apply the final occupants once, including an optional previous-pair undo.
    // Connected players and the large rectangle never move through an interim state.
    playerLayoutState.commit(plan.next);
    playerLayoutState.setFocus(plan.focus);
    playerLayoutState.setPending(null);
    projectPlayerLayout();
    playerGrid?.adopt(playerLayoutState.geometry);
    playerLayoutState.rememberOrder();
    try { localStorage.setItem(PLAYER_POSITION_STORAGE_KEY, JSON.stringify(playerLayoutState.preferredOrder)); } catch (_) {}
    savePlayerEnlargement();
    try {
        if (!plan.memory) localStorage.removeItem(PLAYER_FOCUS_SWAP_STORAGE_KEY);
        else localStorage.setItem(PLAYER_FOCUS_SWAP_STORAGE_KEY, JSON.stringify({
            version: 1, ...plan.memory, layout: signature(playerLayoutState.geometry)
        }));
    } catch (_) {}
    playerPositionEditor?.refresh();
    playerNameOverlay?.refresh();
    playerWindowControls?.refresh();
    return true;
}

function applyPlayerPlacement(plan) {
    if (plan.kind === 'none') return false;
    if (plan.kind !== 'exchange') return applyPlayerSize(plan.next, { optimize: false });
    if (plan.enlarged) {
        playerLayoutState.setPending(plan.pending);
        playerLayoutState.setFocus(plan.focus);
        playerLayoutState.commit(plan.next);
    } else playerLayoutState.setOrder(plan.keys);
    // Project cells without moving connected iframe nodes or restarting playback.
    projectPlayerLayout();
    if (playerLayoutState.pending) { updatePlayerLayout({ force: true }); savePlayerEnlargement(); }
    else playerGrid?.adopt(playerLayoutState.geometry);
    playerLayoutState.rememberOrder();
    try { localStorage.setItem(PLAYER_POSITION_STORAGE_KEY, JSON.stringify(playerLayoutState.preferredOrder)); } catch (_) {}
    playerPositionEditor?.refresh();
    playerNameOverlay?.refresh();
    playerWindowControls?.refresh();
    return true;
}

function movePlayerDirection(key, direction, targetKey) {
    if (!activePlayers.has(key) || !activePlayers.has(targetKey)) return false;
    return applyPlayerPlacement(playerLayoutOperations.step(getCurrentPlayerGeometry(), key, direction, targetKey));
}

function resetPlayerPositions() {
    playerLayoutState.setPreferredOrder([]);
    const hadEnlargement = Boolean(playerLayoutState.focus);
    const hadVisibleEnlargement = Boolean(playerLayoutState.enlargedGeometry);
    playerLayoutState.setFocus(null);
    playerLayoutState.setPending(null);
    try { localStorage.removeItem(PLAYER_POSITION_STORAGE_KEY); } catch (_) {}
    if (hadEnlargement) savePlayerEnlargement();
    const defaultRanks = new Map(channels.map((channel, index) => [ChannelList.channelKey(channel), index]));
    const keys = getPlayerPositionKeys();
    keys.sort((a, b) => (defaultRanks.get(a) ?? Infinity) - (defaultRanks.get(b) ?? Infinity));
    // Keep each live player connected, including players showing a playback error.
    const next = { ...PlayerGeometry.build({ keys, columns: playerLayoutState.geometry.columns }), count: keys.length };
    const changed = PlayerLayout.compare(playerLayoutState.geometry, next).changed;
    playerLayoutState.commit(next);
    updatePlayerLayout({ force: hadVisibleEnlargement });
    if (changed) { playerPositionEditor?.refresh(); playerNameOverlay?.refresh(); }
}

function syncActivePlayers(requested, emptyMessage = '未選擇頻道') {
    const container = document.getElementById("multi-stream-container");
    if (!container) return;
    const selected = ChannelList.mergeChannels(requested);
    const preferredRanks = new Map(playerLayoutState.preferredOrder.map((key, index) => [key, index]));
    selected.sort((a, b) => (preferredRanks.get(ChannelList.channelKey(a)) ?? Infinity) -
        (preferredRanks.get(ChannelList.channelKey(b)) ?? Infinity));
    const desired = new Set(selected.map(ChannelList.channelKey));
    const previousFocus = playerLayoutState.enlargedGeometry?.items.find(item => item.span > 1);
    const selectedFocus = selected.length > 1 && desired.has(playerLayoutState.focus?.key) ? playerLayoutState.focus : null;
    const layoutContextChanged = previousFocus?.key !== selectedFocus?.key || previousFocus?.span !== selectedFocus?.span;
    const previousGeometry = playerLayoutState.geometry;
    let presentationChanged = false;
    for (const [key, entry] of activePlayers) {
        if (!desired.has(key)) { disposePlayer(entry); presentationChanged = true; }
    }
    playerLayoutState.setOrder(selected.map(ChannelList.channelKey));
    const layoutChanged = PlayerLayout.compare(previousGeometry, playerLayoutState.geometry).changed;
    // Remove the initial placeholder without disconnecting retained players.
    const retained = new Set(Array.from(activePlayers.values(), entry => entry.resource ? entry.resource.element : entry.element));
    const emptyNode = !selected.length && container.children.length === 1 &&
        container.firstElementChild?.textContent === emptyMessage ? container.firstElementChild : null;
    for (const child of Array.from(container.children)) {
        if (!retained.has(child) && child !== emptyNode) { child.remove(); presentationChanged = true; }
    }
    const count = selected.length;
    const muted = getGlobalMuted(count);
    const preserveAudio = playerLayoutAudioAvailable();
    currentDisplayChannel = count === 1 ? selected[0] : null;
    updateGlobalAudioButton();
    if (!count) {
        if (!emptyNode) container.innerHTML = `<div style="color:var(--label-2); text-align:center; padding:2rem;">${emptyMessage}</div>`;
        updatePlayerLayout({ force: layoutContextChanged });
        if (layoutChanged || presentationChanged) { playerPositionEditor?.refresh(); playerNameOverlay?.refresh(); }
        return;
    }
    const unsyncedAudio = [];
    selected.forEach((channel, index) => {
        const key = ChannelList.channelKey(channel);
        const hasUrlAudioControl = ['twitch', 'kick', 'ok', 'youtube'].includes(channel.platform);
        const initialMuted = preserveAudio ? true : muted;
        const { entry, created } = playerRegistry.ensure(key, channel, {
            muted: initialMuted,
            wrapperClass: count === 1 ? 'full-screen-video' : 'video',
            reusable: current => getPlayerElement(current).isConnected && !current.failed && !current.resource?.failed &&
                (preserveAudio || current.resource || current.muted === muted || !hasUrlAudioControl),
            failed: (element, resource) => !resource && ['hls', 'flv'].includes(getPlatform(channel.platform)?.type)
        });
        if (!entry) return;
        if (created) {
            presentationChanged = true;
            container.appendChild(getPlayerElement(entry));
            if (globalMutedPreference !== null && !entry.resource && !entry.failed && !['twitch', 'kick', 'ok'].includes(channel.platform)) unsyncedAudio.push(channel.name);
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
        if (visible.dataset.channelName !== (channel.name || '')) { visible.dataset.channelName = channel.name || ''; presentationChanged = true; }
        if (visible.dataset.channelKey !== key) { visible.dataset.channelKey = key; presentationChanged = true; }
        if (visible.classList.contains('full-screen-video') !== (count === 1)) { visible.classList.toggle('full-screen-video', count === 1); presentationChanged = true; }
        if (visible.classList.contains('video') !== (count > 1)) { visible.classList.toggle('video', count > 1); presentationChanged = true; }
    });
    activePlayers.forEach(entry => entry.resource?.twitch?.refresh());
    updatePlayerLayout({ force: layoutContextChanged });
    updateGlobalAudioButton();
    if (unsyncedAudio.length) showGlobalAudioFeedback({ muted, unsupported: unsyncedAudio, reloaded: 0 });
    if (layoutChanged || presentationChanged) {
        playerPositionEditor?.refresh();
        playerNameOverlay?.refresh();
        playerWindowControls?.refresh();
    }
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
    let outsideObserver = null;
    let visible = false;
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
    window.addEventListener('pagehide', () => setChannelSelectionVisible(false));
    return {
        setVisible(next) {
            next = Boolean(panel && next);
            if (next === visible) return;
            visible = next;
            outsideObserver?.dispose();
            outsideObserver = null;
            // Some browsers do not focus pointer-activated buttons. Keep focus
            // in this page so even another click in the same foreign player
            // creates a detectable focus transition after each opening.
            if (visible) document.getElementById('more-channels-btn')?.focus({ preventScroll: true });
            if (visible) outsideObserver = window.UmininnMenuDismiss.observe({ window,
                inside: [panel, document.getElementById('more-channels-btn')],
                onOutside: () => setChannelSelectionVisible(false) });
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

// The bridge owns audio transactions and their lifecycle. Geometry operations
// remain synchronous and never call platform sound/playback APIs themselves.
const playerAudioBridge = PlayerAudioBridge.create({
    document, window,
    getPane: () => document.getElementById('multi-stream-container'),
    available: playerLayoutAudioAvailable,
    getIntent: () => document.documentElement.getAttribute('data-umininn-player-audio-intent'),
    isFocusCurrent: focus => playerRegistry.isCurrent(focus.lease || focus.entry) &&
        getPlayerElement(focus.entry) === focus.target && playerLayoutState.focus?.key === focus.key
});
function playerLayoutAudioAvailable() {
    return document.documentElement.hasAttribute('data-umininn-player-userscript') &&
        document.documentElement.hasAttribute('data-umininn-player-layout-audio-ready');
}
function playerBookmarkAudioAvailable() {
    return playerLayoutAudioAvailable() && document.documentElement.hasAttribute('data-umininn-player-bookmark-audio-ready');
}
function readPlayerBookmarkAudio(keys) { return playerAudioBridge.captureBookmark(keys); }
function withPlayerAudioLayout(action, options = {}) { return playerAudioBridge.run(action, options); }
function guardPlayerAudioLayout(action, requiresLayout) { return playerAudioBridge.guard(action, requiresLayout); }
applyPlayerSize = guardPlayerAudioLayout(applyPlayerSize, (next, { optimize = true } = {}) =>
    optimize || PlayerLayout.compare(getCurrentPlayerGeometry(), next).changed);
enlargePlayer = guardPlayerAudioLayout(enlargePlayer, key => activePlayers.size > 1 && activePlayers.has(key) &&
    !(playerLayoutState.focus?.key === key && playerLayoutState.focus.span >= 256));
shrinkPlayer = guardPlayerAudioLayout(shrinkPlayer, key => activePlayers.size > 1 && activePlayers.has(key) &&
    playerLayoutState.enlargedGeometry?.items.some(item => item.key === key && item.span > 1));
closePlayer = guardPlayerAudioLayout(closePlayer, key => activePlayers.has(key) ||
    key === 'initial-player' && !activePlayers.size && Boolean(document.getElementById('multi-stream-container')?.querySelector('#MyFrame')));
swapPlayerPositions = guardPlayerAudioLayout(swapPlayerPositions, (source, target) =>
    PlayerLayout.compare(getCurrentPlayerGeometry(), playerLayoutOperations.exchange(getCurrentPlayerGeometry(), source, target).next).changed);
swapPlayerWithFocus = guardPlayerAudioLayout(swapPlayerWithFocus, key => activePlayers.has(key) &&
    playerLayoutOperations.swapFocus(getCurrentPlayerGeometry(), key).kind !== 'none');
movePlayerDirection = guardPlayerAudioLayout(movePlayerDirection, (key, direction, target) =>
    activePlayers.has(key) && activePlayers.has(target) &&
    PlayerLayout.compare(getCurrentPlayerGeometry(), playerLayoutOperations.step(getCurrentPlayerGeometry(), key, direction, target).next).changed);
resetPlayerPositions = guardPlayerAudioLayout(resetPlayerPositions, () => {
    if (playerLayoutState.enlargedGeometry) return true;
    const ranks = new Map(channels.map((channel, index) => [ChannelList.channelKey(channel), index]));
    const keys = getPlayerPositionKeys().sort((a, b) => (ranks.get(a) ?? Infinity) - (ranks.get(b) ?? Infinity));
    return PlayerLayout.compare(getCurrentPlayerGeometry(), PlayerGeometry.build({ keys, columns: playerLayoutState.geometry.columns })).changed;
});
syncActivePlayers = guardPlayerAudioLayout(syncActivePlayers, requested => {
    const selected = ChannelList.mergeChannels(requested);
    const ranks = new Map(playerLayoutState.preferredOrder.map((key, index) => [key, index]));
    selected.sort((a, b) => (ranks.get(ChannelList.channelKey(a)) ?? Infinity) - (ranks.get(ChannelList.channelKey(b)) ?? Infinity));
    const keys = selected.map(ChannelList.channelKey);
    if (keys.length !== activePlayers.size || keys.some(key => {
        const entry = activePlayers.get(key);
        return !entry || !getPlayerElement(entry).isConnected || entry.failed || entry.resource?.failed;
    })) return true;
    const focus = keys.length > 1 ? playerLayoutState.enlargedGeometry?.items.find(item => item.span > 1) : null;
    return PlayerLayout.compare(getCurrentPlayerGeometry(), PlayerGeometry.build({ keys, columns: playerLayoutState.geometry.columns, focus })).changed;
});

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
    const snapshot = {
        channels: keys.map(key => ({ key, name: activePlayers.get(key).channel.name })),
        columns: geometry.columns,
        focus: focus ? { key: focus.key, row: focus.row, column: focus.column, span: focus.span } : null,
        aspectRatio: pane?.clientWidth > 0 && pane?.clientHeight > 0 ? pane.clientWidth / pane.clientHeight : 16 / 9
    };
    if (!playerBookmarkAudioAvailable()) return snapshot;
    // Geometry is frozen at the click, before cross-origin state reads await.
    return readPlayerBookmarkAudio(keys).then(audio => ({ ...snapshot,
        audio: LayoutBookmarks.normalizeSnapshot({ ...snapshot, audio }).audio }));
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
    playerLayoutState.setPreferredOrder(keys.concat(playerLayoutState.preferredOrder.filter(key => !keys.includes(key))).slice(0, 256));
    playerLayoutState.setFocus(keys.length > 1 && keys.includes(snapshot.focus?.key) ? { ...snapshot.focus } : null);
    const columns = playerLayoutState.focus ? snapshot.columns : Math.min(snapshot.columns, keys.length);
    playerLayoutState.setPending({ columns, intent: 'bookmark' });
    // Restore the snapshot's exact ordering before reconciling retained players;
    // a previous enlarged anchor must not reorder a normal bookmark's cells.
    playerLayoutState.commit({ ...PlayerGeometry.build({ keys, columns, focus: playerLayoutState.focus }), count: keys.length });
    syncActivePlayers(selected);
    try { localStorage.setItem(PLAYER_POSITION_STORAGE_KEY, JSON.stringify(playerLayoutState.preferredOrder)); } catch (_) {}
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

{
    const applyLayout = applyPlayerBookmark;
    applyPlayerBookmark = value => {
        const snapshot = LayoutBookmarks.normalizeSnapshot(value);
        let bookmarkAudio, audioIntent;
        if (snapshot.audio && playerBookmarkAudioAvailable()) {
            const available = new Set(channels.map(channel => ChannelList.channelKey(channel)));
            if (!snapshot.channels.some(channel => available.has(channel.key)))
                throw new Error('這個書籤的台已從頻道列表移除；目前播放保持不變。');
            bookmarkAudio = snapshot.audio;
            audioIntent = playerAudioBridge.bookmarkIntent();
        }
        return withPlayerAudioLayout(() => applyLayout(snapshot), { bookmarkAudio, audioIntent,
            requiresLayout() {
                const available = new Map(channels.map(channel => [ChannelList.channelKey(channel), channel]));
                const selected = snapshot.channels.map(item => available.get(item.key)).filter(Boolean);
                const keys = selected.map(ChannelList.channelKey);
                if (keys.length !== activePlayers.size || keys.some(key => {
                    const entry = activePlayers.get(key);
                    return !entry || !getPlayerElement(entry).isConnected || entry.failed || entry.resource?.failed;
                })) return true;
                const focus = keys.length > 1 && keys.includes(snapshot.focus?.key) ? snapshot.focus : null;
                return PlayerLayout.compare(getCurrentPlayerGeometry(), PlayerGeometry.build({ keys,
                    columns: focus ? snapshot.columns : Math.min(snapshot.columns, keys.length), focus })).changed;
            }
        });
    };
}

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
        if (Array.isArray(saved)) playerLayoutState.setPreferredOrder([...new Set(saved.filter(key => typeof key === 'string'))].slice(0, 256));
    } catch (_) {}
    try {
        const saved = JSON.parse(localStorage.getItem(PLAYER_ENLARGEMENT_STORAGE_KEY));
        const focus = saved?.focus;
        if (saved?.version === 1 && typeof focus?.key === 'string' &&
            Number.isInteger(focus.span) && focus.span >= 2 && focus.span <= 256 &&
            Number.isInteger(focus.row) && focus.row >= 0 && focus.row <= 512 &&
            Number.isInteger(focus.column) && focus.column >= 0 && focus.column <= 512 &&
            Number.isInteger(saved.columns) && saved.columns >= focus.span && saved.columns <= 768) {
            playerLayoutState.setFocus({ key: focus.key, span: focus.span, row: focus.row, column: focus.column });
            playerLayoutState.setPending({ columns: saved.columns, intent: 'restore' });
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
        const columns = playerLayoutState.geometry.columns;
        const rows = playerLayoutState.geometry.rows;
        const cellWidth = (pane.clientWidth - (parseFloat(style.columnGap) || 0) * (columns - 1)) / columns;
        const cellHeight = (pane.clientHeight - (parseFloat(style.rowGap) || 0) * (rows - 1)) / rows;
        const cellSize = Math.max(0, Math.min(cellWidth, cellHeight));
        layer.style.setProperty('--player-position-cell-size', `${cellSize}px`);
        // Browsers round nonzero borders up to a physical pixel in tiny tracks.
        layer.style.setProperty('--player-position-cell-border', `${cellSize < 4 ? 0 : Math.min(2, cellSize / 16)}px`);
        const positions = new Map(playerLayoutState.geometry.items.map(item => [item.key, item]));
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
        const focus = !startButton.disabled && playerLayoutState.enlargedGeometry?.items.find(item => item.span > 1);
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
        const sizes = new Map(playerLayoutState.geometry.items.map(item => [item.key, item.span]));
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
            const plan = playerLayoutOperations.target(getCurrentPlayerGeometry(), source, target, { direction });
            const applied = applyPlayerPlacement(plan);
            if (applied && plan.kind === 'exchange') announcement.textContent = `${sourceName} 與 ${targetName} 已交換位置`;
            else if (applied && plan.kind === 'step') {
                const labels = { up: '上', down: '下', left: '左', right: '右' };
                announcement.textContent = `${activePlayers.get(plan.focusKey).channel.name} 已向${labels[plan.focusDirection]}平移一格`;
            } else if (applied && plan.kind === 'relocate')
                announcement.textContent = `${activePlayers.get(plan.focusKey).channel.name} 已搬到指定區域`;
            else if (plan.reason === 'target-blocked') announcement.textContent = '大格已在可容納的目標位置';
        }, { requiresLayout: () => activePlayers.has(source) && activePlayers.has(target) &&
            PlayerLayout.compare(getCurrentPlayerGeometry(), playerLayoutOperations.target(getCurrentPlayerGeometry(), source, target, { direction }).next).changed });
    }

    function open(nextMode) {
        if (activePlayers.size < 2) return;
        moveReturnFocus = null;
        completionPointers.clear();
        setChannelSelectionVisible(false);
        mode = nextMode;
        layer.dataset.mode = mode;
        const help = mode === 'enlarge' ? '拖拉四角預覽，放開後自動分格；也可點格放大或按「縮小一格」；Esc 取消拖拉／完成' : '拖曳或點選目標；相鄰一步，跨格到位；方向鍵逐格，Esc 完成';
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
        }, { requiresLayout: () => resetPlayerPositions.requiresLayout?.() ?? true });
    }
    resetButton?.addEventListener('click', resetPositions);
    editorResetButton.addEventListener('click', resetPositions);
    shrinkButton.addEventListener('click', () => {
        void withPlayerAudioLayout(() => {
            if (!opened || mode !== 'enlarge') return;
            const focus = playerLayoutState.enlargedGeometry?.items.find(item => item.span > 1);
            if (!focus) return;
            const name = activePlayers.get(focus.key).channel.name;
            if (shrinkPlayer(focus.key)) announcement.textContent = `${name} 已縮小至 ${focus.span - 1}×${focus.span - 1}${focus.span === 2 ? '，已達最小單位，保留目前排列' : ''}`;
        }, { requiresLayout: () => opened && mode === 'enlarge' && Boolean(playerLayoutState.enlargedGeometry) });
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
                if (enlargePlayer(key)) announcement.textContent = `${activePlayers.get(key).channel.name} 已放大至 ${playerLayoutState.focus.span}×${playerLayoutState.focus.span}`;
                else announcement.textContent = '已達放大上限';
            }, { requiresLayout: () => opened && mode === 'enlarge' && (enlargePlayer.requiresLayout?.(key) ?? true) });
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
        if (playerLayoutState.enlargedGeometry || mode === 'enlarge') {
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
        const columns = playerLayoutState.geometry.columns;
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
        // Every sizing mode uses the same operation/fit engine. The drag frame
        // keeps its starting screen-space corner; only release applies the fit.
        const plan = playerLayoutOperations.previewSize(gesture.base, gesture.key, span, gesture.corner, gesture.measure);
        gesture.next = plan.kind === 'none' ? null : plan.next;
        if (!gesture.next) {
            resizePreview.hidden = true;
            layer.classList.remove('position-resizing');
            return;
        }
        const rect = plan.preview;
        resizePreview.style.left = `${rect.left}px`;
        resizePreview.style.top = `${rect.top}px`;
        resizePreview.style.width = `${rect.width}px`;
        resizePreview.style.height = `${rect.height}px`;
        resizePreview.textContent = `${activePlayers.get(gesture.key)?.channel.name || ''} · ${plan.span}×${plan.span}（放開後自動分格）`;
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
                }, { requiresLayout() {
                    const current = getCurrentPlayerGeometry(), bounds = pane.getBoundingClientRect();
                    return opened && mode === 'enlarge' && activePlayers.has(gesture.key) &&
                        pane.clientWidth === gesture.measure.width && pane.clientHeight === gesture.measure.height &&
                        bounds.left === gesture.bounds.left && bounds.top === gesture.bounds.top &&
                        !PlayerLayout.compare(current, gesture.base).changed && PlayerLayout.compare(current, next).changed;
                } });
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
    const bookmarkPanel = document.getElementById('layout-bookmarks');
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
            (visible || bookmarkPanel && !bookmarkPanel.hidden && getComputedStyle(bookmarkPanel).display !== 'none' ||
                document.documentElement.hasAttribute('data-umininn-player-controls-open'));
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
    if (bookmarkPanel) visibilityObserver.observe(bookmarkPanel, { attributes: true, attributeFilter: ['style', 'hidden', 'class'] });
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
        const enlarged = geometry.items.find(item => item.span > 1 && activePlayers.has(item.key));
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
                const swapFocus = document.createElement('button');
                swapFocus.type = 'button';
                swapFocus.className = 'player-window-swap-focus';
                swapFocus.dataset.playerAction = 'swap-focus';
                swapFocus.textContent = '⇄';
                swapFocus.hidden = true;
                node.appendChild(swapFocus);
                buttons.swapFocus = swapFocus;
                node.addEventListener('pointerenter', scheduleHover);
                node.addEventListener('pointerleave', scheduleHover);
                cell = { node, bar, buttons, directionButtons: new Map(), element: null };
                cells.set(key, cell);
            }
            bind(cell, element);
            cell.bar.setAttribute('aria-label', `${name} 播放器控制`);
            const span = playerLayoutState.enlargedGeometry?.items.find(item => item.key === key)?.span || 1;
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
            const canSwapFocus = Boolean(enlarged && enlarged.key !== key && geometryItems.get(key)?.span === 1);
            const swapHadFocus = document.activeElement === cell.buttons.swapFocus;
            cell.buttons.swapFocus.hidden = !canSwapFocus;
            const swapLabel = playerLayoutAudioAvailable() && document.documentElement.hasAttribute('data-umininn-player-unified-audio-ready') ?
                `與大格互換，並只開此台聲音（100%）：${name}` : `與大格互換：${name}`;
            cell.buttons.swapFocus.title = swapLabel;
            cell.buttons.swapFocus.setAttribute('aria-label', swapLabel);
            cell.buttons.swapFocus.style.left = `calc(var(--player-corner-size, 18px) * ${cell.buttons.audio ? 2 : 1} + ${cell.buttons.audio ? 9 : 6}px)`;
            if (!canSwapFocus && swapHadFocus) (cell.buttons.audio || cell.buttons.move).focus({ preventScroll: true });
            // Keep the left shortcuts and the right toolbar distinct even
            // when a small window leaves very little room in a tile.
            const toolbarCount = span > 1 ? 3 : 2;
            const leftCount = 1 + Number(Boolean(cell.buttons.audio)) + Number(canSwapFocus);
            const leftWidthGaps = 3 * (leftCount - 1);
            const cornerSize = leftCount > 1 ? Math.max(1, Math.min(18,
                Math.floor((rect.width - 9 - leftWidthGaps) / (toolbarCount + leftCount)), Math.floor((rect.height - 10) / 2))) : 18;
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
                            const overlapsCorner = center < (leftCount > 1 ? leftCount * cornerSize + leftWidthGaps + 10 : 28) || center > rect.width - (toolbarCount * cornerSize + 10);
                            button.style.top = `${inset(rect.height, overlapsCorner)}px`;
                        } else button.style.bottom = `${inset(rect.height, center < 28 || center > rect.width - 28)}px`;
                    } else {
                        let center = (start + end) / 2 - rect.top;
                        const inward = center < 28 || center > rect.height - 28;
                        if (leftCount > 1 && center - size / 2 < cornerSize + 4) {
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
        if (!button || blocked() || button.disabled || button.hidden) return;
        event.preventDefault(); event.stopPropagation();
        const key = button.closest('.player-window-cell').dataset.playerKey;
        if (button.dataset.playerAction === 'close') {
            // Reflow can move another close button under a double-click.
            if (event.detail > 1) return;
            await closePlayer(key);
        } else if (button.dataset.playerAction === 'enlarge') {
            const entry = activePlayers.get(key);
            if (!entry || activePlayers.size < 2 || playerLayoutState.focus?.key === key && playerLayoutState.focus.span >= 256) return;
            const target = getPlayerElement(entry);
            const focus = playerAudioBridge.beginFocus(key, entry, target);
            if (focus) focus.lease = playerRegistry.lease(entry);
            await withPlayerAudioLayout(() => enlargePlayer(key), { focus });
        }
        else if (button.dataset.playerAction === 'swap-focus') {
            // Ignore a second click landing on the old main tile after the
            // first exchange. Independently selected targets may still queue.
            if (event.detail > 1) return;
            const entry = activePlayers.get(key);
            if (!entry || playerLayoutOperations.swapFocus(getCurrentPlayerGeometry(), key).kind === 'none') return;
            const target = getPlayerElement(entry), lease = playerRegistry.lease(entry);
            const focus = playerAudioBridge.beginFocus(key, entry, target);
            if (focus) focus.lease = lease;
            await withPlayerAudioLayout(() => {
                if (!playerRegistry.isCurrent(lease) || getPlayerElement(entry) !== target) return false;
                // A repeated activation may have queued while this was still a
                // small tile. Keep its latest audio intent if the earlier swap
                // already put the same live player into the large slot.
                return swapPlayerWithFocus(key) || Boolean(playerLayoutState.enlargedGeometry?.items
                    .some(item => item.key === key && item.span > 1));
            }, { focus });
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
            attributeFilter: ['data-umininn-player-userscript', 'data-umininn-player-audio-focus-ready',
                'data-umininn-player-unified-audio-ready', 'data-umininn-player-layout-audio-ready'] });
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

(function initTopbarOptions() {
    if (!window.UmininnTopbarMenu?.create) return;
    window.topbarOptionsMenu?.dispose();
    window.topbarOptionsMenu = window.UmininnTopbarMenu.create({ window, document });
    window.topbarOptionsMenu.start();
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
