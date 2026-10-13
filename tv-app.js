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
 
function fetchViaProxy(targetUrl, mode = 'quest') {
    const proxy = getNextProxy();
    const url = (mode === 'quest')
        ? `${proxy}/?quest=${encodeURIComponent(targetUrl)}`
        : `${proxy}/${targetUrl}`;
    return fetch(url);
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
        type: 'iframe',
        buildUrl: (ch, muted) =>
            `https://player.twitch.tv/?channel=${ch.id}&parent=${encodeURIComponent(parent)}&muted=${muted}`,
        status: async (ch) => {
            const resp = await fetch(`https://api.twitch.tv/helix/streams?user_login=${ch.id}`, {
                headers: { "Authorization": `Bearer ${TWITCH_TOKEN}`, "Client-Id": TWITCH_CLIENT_ID }
            });
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
        status: async (ch) => {
            const resp = await fetch(`https://kick.com/api/v2/channels/${ch.id}`);
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
            `https://ok.ru/videoembed/${ch.id}?nochat=1&autoplay=1${muted ? '&muted=1' : ''}`,
        aliases: ['okru'],
        status: async (ch) => {
            // ★ 透過代理池輪詢
            const resp = await fetchViaProxy(`https://ok.ru/videoembed/${ch.id}`, 'raw');
            const html = await resp.text();
            console.log(`[OK Check Raw Text]`, JSON.stringify(html));
            const upperText = html.toUpperCase();
            const isOkLive = upperText.includes('STATUS:"ONLINE"') ||
                             upperText.includes('"STATUS":"ONLINE"') ||
                             /\bLIVE\b/.test(upperText);
            console.log(`[OK Check Final Result] ${ch.id}:`, isOkLive ? 'live' : 'not-live');
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
        status: async (ch) => {
            const resp = await fetch(`https://api.angelthump.com/v2/streams/${ch.id}`);
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
        type: 'iframe',
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
        status: async (ch) => {
            const resp = await fetch(`https://r.jina.ai/${ch.id}`);
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
        status: async (ch) => {
            // ★ 透過代理池輪詢
            const resp = await fetchViaProxy(`https://api.vaughnsoft.net/v1/stream/vl/${ch.id}`, 'quest');
            if (!resp.ok) return 'not-live';
            const data = await resp.json();
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
            const proxy = getNextGoshProxy();   // ★ 輪詢
            const resp = await fetch(`${proxy}/?channelId=${ch.id}`);
            const data = await resp.json();
            return data.isLive === true ? 'live' : 'not-live';
        } catch (e) {
            console.warn('[Gosh status error]', e);
            return 'unknown';
        }
    },
    getStreamUrl: async (ch) => {
        const proxy = getNextGoshProxy();       // ★ 輪詢
        const resp = await fetch(`${proxy}/?channelId=${ch.id}`);
        const data = await resp.json();
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
        status: async (ch) => {
            try {
                const username = ch.ggUsername || ch.id;
                const api = `https://goodgame.ru/api/4/users/${encodeURIComponent(username)}/stream`;
                // ★ 透過代理池輪詢
                const resp = await fetchViaProxy(api, 'quest');
                if (!resp.ok) return 'not-live';
                const data = await resp.json();
                if (!data || !data.id) return 'not-live';
                if (data.status === true || data.online === true) return 'live';
                return 'not-live';
            } catch (e) {
                console.warn('[GoodGame status error]', e);
                return 'unknown';
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
const RENDERERS = {
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

        // 建立一個非同步函式來處理具有時效性的動態網址
        const initPlayer = async () => {
            let streamUrl = channel.id; // 預設使用頻道 ID 作為網址（相容舊有 m3u8 平台）
            
            // 如果該平台有定義 getStreamUrl (例如 gosh)，就動態獲取最新的網址
            if (p.getStreamUrl) {
                try {
                    streamUrl = await p.getStreamUrl(channel);
                    if (!streamUrl) throw new Error("無法獲取 m3u8 網址");
                } catch (e) {
                    console.warn('[HLS getStreamUrl error]', e);
                    video.replaceWith(buildErrorDiv('⚠️ 直播主已離線'));
                    return; 
                }
            }

            // 網址取得後，才開始初始化 hls.js 或原生播放
            if (Hls.isSupported()) {
                const hls = new Hls(HLS_CONFIG);
                hls.loadSource(streamUrl);
                hls.attachMedia(video);
                hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
                currentHLSInstances.push(hls);
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = streamUrl;
            } else {
                video.replaceWith(buildErrorDiv('⚠️ 瀏覽器不支援 HLS'));
            }
        };

        // 呼叫執行
        initPlayer();
        return video;
    },

    flv(channel, p, muted, wrapperClass) {
        if (!(typeof flvjs !== 'undefined' && flvjs.isSupported())) {
            return buildErrorDiv('⚠️ 瀏覽器不支援 FLV.js，無法播放 .flv 格式');
        }
        const video = document.createElement('video');
        video.className = `hls-video-element ${wrapperClass}`;
        video.controls = true;
        video.autoplay = true;
        video.muted = muted;
        video.playsInline = true;
        const flvPlayer = flvjs.createPlayer({
            type: 'flv',
            url: p.buildUrl(channel, muted),
            isLive: true,
            cors: true
        });
        flvPlayer.attachMediaElement(video);
        flvPlayer.load();
        flvPlayer.play().catch(() => {});
        currentFLVInstances.push(flvPlayer);
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
let currentHLSInstances = [];
let currentFLVInstances = [];
let currentDisplayChannel = null;
const parent = location.hostname || "localhost";

/* ★ 記錄上一次 ch1.txt 的原始內容，用來偵測是否有更新 */
let _lastCh1TxtRaw = null;

const HLS_CONFIG = {
    enableWorker: true,
    capLevelToPlayerSize: true,
    maxBufferLength: 15,
    maxMaxBufferLength: 30
};

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
function destroyAllHLSInstances() {
    if (currentHLSInstances.length) {
        currentHLSInstances.forEach(instance => {
            if (instance && typeof instance.destroy === 'function') instance.destroy();
        });
        currentHLSInstances = [];
    }
    if (currentFLVInstances.length) {
        currentFLVInstances.forEach(instance => {
            if (instance) {
                try {
                    instance.pause();
                    instance.unload();
                    instance.detachMediaElement();
                    instance.destroy();
                } catch (e) { console.warn(e); }
            }
        });
        currentFLVInstances = [];
    }
}

function renderChannelElement(channel, muted, wrapperClass) {
    const p = getPlatform(channel.platform);
    if (!p) return buildErrorDiv(`⚠️ 未知平台: ${channel.platform}`);
    const renderer = RENDERERS[p.type] || RENDERERS.iframe;
    return renderer(channel, p, muted, wrapperClass);
}

/* ------------------------ 單台觀看 ------------------------ */
function displaySingleChannel(channel) {
    const container = document.getElementById("multi-stream-container");
    if (!container) return;
    destroyAllHLSInstances();
    container.innerHTML = "";
    container.style.gridTemplateColumns = "1fr";
    container.style.gridTemplateRows = "1fr";

    if (!channel) {
        container.innerHTML = `<div style="color:var(--label-2); text-align:center; padding:2rem;">未選擇頻道</div>`;
        currentDisplayChannel = null;
        return;
    }
    currentDisplayChannel = channel;
    const el = renderChannelElement(channel, false, "full-screen-video");
    container.appendChild(el);
}

/* ------------------------ 多台觀看 ------------------------ */
function watchSelectedChannels() {
    const selectionDiv = document.getElementById("channel-selection");
    if (selectionDiv) selectionDiv.style.display = "none";
    const container = document.getElementById("multi-stream-container");
    if (!container) return;
    destroyAllHLSInstances();
    container.innerHTML = "";

    const checkboxes = document.querySelectorAll("#channel-options input:checked");
    const selected = Array.from(checkboxes).map(cb => ({
        id: cb.value, platform: cb.dataset.platform, name: cb.dataset.name || ""
    }));
    const fullSelected = selected
        .map(sel => channels.find(ch => ch.id === sel.id && ch.platform === sel.platform))
        .filter(Boolean);

    if (fullSelected.length === 0) {
        container.innerHTML = `<div style="color:var(--label-2); text-align:center; padding:2rem;">未選擇任何頻道</div>`;
        return;
    }

    const isMuted = fullSelected.length > 1;
    const isOnlyOne = fullSelected.length === 1;
    const count = fullSelected.length;
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    container.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

    const frag = document.createDocumentFragment();
    fullSelected.forEach(ch => {
        const wrapperClass = isOnlyOne ? "full-screen-video" : "video";
        frag.appendChild(renderChannelElement(ch, isMuted, wrapperClass));
    });
    container.appendChild(frag);
}

/* =============== 頻道儲存 / 載入 =============== */
function saveChannelsToStorage() {
    let customChannels = channels.filter(ch => !ch._fromAPI && !ch._fromTxt);
    customChannels = customChannels.map(ch => {
        const { _fromAPI, _fromTxt, ...cleanCh } = ch;
        return cleanCh;
    });
    localStorage.setItem("customChannels1", JSON.stringify(customChannels));
}

async function loadTwitchCredentials() {
    try {
        const resp = await fetch('https://chicktv.github.io/tv/token.txt');
        const data = await resp.text();
        const lines = data.split('\n').map(l => l.trim());
        if (lines.length >= 2) {
            TWITCH_TOKEN = lines[0];
            TWITCH_CLIENT_ID = lines[1];
        }
    } catch (e) { console.warn(e); }
}

/* ★ 修改版：可接收外部已抓好的 ch1.txt 內容，避免重複 fetch */
async function loadChannelsFromUrl(providedTxtRaw) {
    let txtChannels = [], apiChannelsTemp = [];

    try {
        let data;
        if (typeof providedTxtRaw === 'string') {
            // 外部已經抓好傳進來（輪詢用）
            data = providedTxtRaw;
        } else {
            // 首次載入：加時間戳 + no-store 避免拿到舊快取
            const resp = await fetch(
                `https://chicktv.github.io/tv/ch1.txt?t=${Date.now()}`,
                { cache: 'no-store' }
            );
            if (resp.ok) data = await resp.text();
        }

        if (typeof data === 'string') {
            _lastCh1TxtRaw = data;   // ★ 記錄這次內容
            txtChannels = data.split('\n').filter(l => l.trim()).map(line => {
                const parts = line.split(',').map(p => p.trim());
                if (parts.length === 3) {
                    return { name: parts[0], id: parts[1], platform: parts[2].toLowerCase(), _fromTxt: true };
                }
                if (parts.length >= 4) {
                    return {
                        name: parts[0],
                        id: parts[1],
                        platform: parts[2].toLowerCase(),
                        ggUsername: parts[3] || undefined,
                        _fromTxt: true
                    };
                }
                return null;
            }).filter(Boolean);
        }
    } catch (e) {}

    try {
        // ★ 透過代理池輪詢
        const resp = await fetchViaProxy(
            'https://live.sk-knower.com/skgamerversion_api.php?page=whitewing918',
            'quest'
        );
        const data = await resp.json();
        if (data.channels) {
            apiChannelsTemp = data.channels.map(item => {
                const platform = resolvePlatform(item.platform);
                if (!platform) return null;
                return {
                    name: (item.displayname || item.details || "Unknown").trim(),
                    id: String(item.details).trim(),
                    platform,
                    _fromAPI: true
                };
            }).filter(Boolean);
        }
    } catch (e) {}

    const stored = JSON.parse(localStorage.getItem("customChannels1") || "[]");
    let allRaw = [...apiChannelsTemp, ...txtChannels, ...stored];

    const seen = new Map();
    for (const ch of allRaw) {
        const key = `${(ch.name || "").trim().toLowerCase()}|${(ch.platform || "").toLowerCase()}`;
        if (!seen.has(key)) seen.set(key, ch);
        else if (ch._fromAPI && !seen.get(key)._fromAPI) seen.set(key, ch);
    }
    channels = Array.from(seen.values());
    saveChannelsToStorage();
    generateButtons();
}

/* ============ ★ ch1.txt 自動偵測更新（不用 F5） ============ */
async function pollCh1TxtForUpdates() {
    try {
        const resp = await fetch(
            `https://chicktv.github.io/tv/ch1.txt?t=${Date.now()}`,
            { cache: 'no-store' }
        );
        if (!resp.ok) return;
        const raw = await resp.text();

        // 首次輪詢：只記錄，不做事（避免剛載入就被判定成「變化」）
        if (_lastCh1TxtRaw === null) { _lastCh1TxtRaw = raw; return; }

        // 內容沒變 → 直接結束
        if (raw === _lastCh1TxtRaw) return;

        console.log('[ch1.txt] 偵測到更新，重新載入頻道');
        _lastCh1TxtRaw = raw;

        // 重新載入（保留目前播放中的影片，不會被中斷）
        await loadChannelsFromUrl(raw);

        // 若目前正在播放的頻道被刪掉了 → 停止播放
        if (currentDisplayChannel) {
            const stillExists = channels.some(ch =>
                ch.id === currentDisplayChannel.id &&
                ch.platform === currentDisplayChannel.platform
            );
            if (!stillExists) displaySingleChannel(null);
        }

        // 如果看更台面板 / 手機頻道選單是開著的，順便重繪
        const sel = document.getElementById('channel-selection');
        if (sel && sel.style.display !== 'none') generateChannelOptions();

        const menu = document.getElementById('channel-menu');
        if (menu && menu.style.display === 'block') {
            toggleChannelMenu();                       // 先關
            setTimeout(() => toggleChannelMenu(), 0);  // 再開，重建列表
        }
    } catch (e) {
        console.warn('[ch1.txt poll]', e);
    }
}

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
    const statusKey = `${channel.platform}_${channel.id}`;
    const idSafe = statusKey.replace(/[^a-zA-Z0-9]/g, '_');
    const label = document.getElementById(`status-label-${idSafe}`);
    if (!label) return;
    label.className = "channel-option-label";
    applyStatusClass(label, channelStatuses[statusKey] || 'unknown');
}

function updateUIForChannel(channel) {
    updateButtonStatus(channel);
    updateMenuButtonStatus(channel);
    updateChannelOptionLabel(channel);
}

async function fetchStatus(channel) {
    if (!channel || !channel.id) return;
    const statusKey = `${channel.platform}_${channel.id}`;
    const p = getPlatform(channel.platform);
    if (!p) return;

    let status = 'unknown';
    try {
        status = p.status ? await p.status(channel) : 'unknown';
        if (!['live', 'not-live', 'unknown', 'unknown2'].includes(status)) status = 'unknown';
    } catch (e) {
        console.warn(`[status error] ${channel.platform}/${channel.id}`, e);
        status = 'unknown';
    }
    channelStatuses[statusKey] = status;
    updateUIForChannel(channel);
}

function fetchAllStatuses() {
    if (TWITCH_TOKEN && TWITCH_CLIENT_ID) channels.forEach(ch => fetchStatus(ch));
}

function generateChannelOptions() {
    const container = document.getElementById("channel-options");
    if (!container) return;
    container.innerHTML = "";
    const frag = document.createDocumentFragment();

    channels.forEach(ch => {
        const statusKey = `${ch.platform}_${ch.id}`;
        const idSafe = statusKey.replace(/[^a-zA-Z0-9]/g, '_');
        const icon = platformIcon(ch.platform);

        const cell = document.createElement("div");
        cell.className = "channel-option-cell";
        cell.innerHTML = `
            <input type="checkbox"
                   value="${escapeHtml(ch.id)}"
                   data-platform="${ch.platform}"
                   data-name="${escapeHtml(ch.name)}"
                   id="chk_${idSafe}">
            <label class="channel-option-label"
                   id="status-label-${idSafe}"
                   for="chk_${idSafe}"
                   title="${escapeHtml(ch.name)}">
                <span class="channel-option-icon">${icon}</span>
                <span class="channel-option-name">${escapeHtml(ch.name)}</span>
            </label>`;
        frag.appendChild(cell);
    });
    container.appendChild(frag);
    channels.forEach(ch => updateChannelOptionLabel(ch));
	fetchAllStatuses();
}

function checkAllLiveChannels() {
    channels.forEach(ch => {
        const statusKey = `${ch.platform}_${ch.id}`;
        const status = channelStatuses[statusKey] || 'unknown';
        const idSafe = statusKey.replace(/[^a-zA-Z0-9]/g, '_');
        const chk = document.getElementById(`chk_${idSafe}`);
        if (chk) chk.checked = (status === 'live');
    });
}

function clearAllChannelSelection() {
    document.querySelectorAll("#channel-options input[type='checkbox']").forEach(chk => {
        chk.checked = true;
    });
}

function toggleChannelSelection() {
    const div = document.getElementById("channel-selection");
    if (div.style.display === "none") {
        generateChannelOptions();
        div.style.display = "block";
    } else div.style.display = "none";
}

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
    return String(str).replace(/[&<>]/g, function (m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
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
    const newChannels = channels.filter(ch =>
        !toDelete.some(del => del.name === ch.name && del.id === ch.id && del.platform === ch.platform)
    );
    if (newChannels.length === channels.length) return;
    channels = newChannels;
    saveChannelsToStorage();
    generateButtons();

    if (currentDisplayChannel && !channels.some(ch => ch.id === currentDisplayChannel.id && ch.platform === currentDisplayChannel.platform)) {
        displaySingleChannel(null);
    }
    const selectionDiv = document.getElementById("channel-selection");
    if (selectionDiv && selectionDiv.style.display !== "none") generateChannelOptions();
    if (document.getElementById('channel-menu').style.display === 'block') {
        toggleChannelMenu();
        setTimeout(() => toggleChannelMenu(), 100);
    }
    fetchAllStatuses();
    closeDeleteModal();
}
window.editClick = function () { openDeleteModal(); };

function showPopup() {
    window.open("https://chicktv01.vercel.app", "_blank", "width=800,height=600");
}

/* 隱藏離線開關 */
(function initHideNotLiveToggle() {
    fetchAllStatuses();
    const toggle = document.getElementById('toggleNotLive');
    let styleEl = null;
    function apply(shouldHide) {
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'dynamic-hide-notlive';
            document.head.appendChild(styleEl);
        }
        styleEl.textContent = shouldHide
            ? `.not-live { display: none !important; } .button-wrapper:has(.not-live) { display: none !important; }`
            : '';
    }
    const saved = localStorage.getItem('hideNotLiveToggle');
    toggle.checked = saved === 'true';
    apply(toggle.checked);
    toggle.addEventListener('change', (e) => {
        apply(e.target.checked);
        localStorage.setItem('hideNotLiveToggle', e.target.checked);
    });
})();

/* 聊天切換 Toggle (紫色) & 記憶用戶最後選擇 */
(function initChatToggle() {
    const toggle = document.getElementById('chatToggle');
    const iframe = document.getElementById('chat_embed');
    if (!toggle || !iframe) return;

    function applyChatState(isAltChat) {
        if (isAltChat) {
            iframe.src = `https://www.twitch.tv/embed/whitewing940920/chat?darkpopout&parent=${encodeURIComponent(parent)}`;
        } else {
            iframe.src = './test3.html';
        }
    }
    const savedState = localStorage.getItem('chatToggleState');
    const isChecked = savedState === 'true';
    toggle.checked = isChecked;
    if (savedState !== null) applyChatState(isChecked);

    toggle.addEventListener('change', (e) => {
        const checked = e.target.checked;
        applyChatState(checked);
        localStorage.setItem('chatToggleState', checked);
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
    const ce = document.getElementById('chat_embed');
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
    const saved = parseFloat(localStorage.getItem(STORAGE_KEY));
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
        localStorage.setItem(STORAGE_KEY, String(currentRatio));
    }

    // ★ 只在 resizer 上監聽 pointerdown，其餘掛在 document
    resizer.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointermove',   onPointerMove);
    document.addEventListener('pointerup',     endDrag);
    document.addEventListener('pointercancel', endDrag);

    // 雙擊還原預設比例
    resizer.addEventListener('dblclick', () => {
	
        applyRatio(DEFAULT_RATIO);
        localStorage.setItem(STORAGE_KEY, String(currentRatio));
		
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

document.getElementById('addChannelBtn').onclick = () =>
    document.getElementById('addChannelModal').classList.add('active');

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

    channels.push({ name, id, platform, ...extra });
    saveChannelsToStorage();
    generateButtons();
    document.getElementById('addChannelModal').classList.remove('active');
    fetchAllStatuses();
};
document.getElementById('cancelAddChannel').onclick = () =>
    document.getElementById('addChannelModal').classList.remove('active');
document.getElementById('addChannelModal').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-mask')) document.getElementById('addChannelModal').classList.remove('active');
});

document.getElementById('delChannelBtn').onclick = openDeleteModal;
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
    setInterval(fetchAllStatuses, 300000);

    // ★ ch1.txt 內容偵測：每 60 秒一次（可自行調整）
    setInterval(pollCh1TxtForUpdates, 1080000);
    // 分頁重新回到前景時也檢查一次，手機切回來能馬上同步
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) pollCh1TxtForUpdates();
    });
}

window.tvAppReady = initializeTvApp();
