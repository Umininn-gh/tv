/* Shared channel recovery and persistence for the main page and admin page. */
(function (root) {
    'use strict';

    const CUSTOM_KEY = 'customChannels1';
    const LEGACY_KEY = 'customChannels';
    const MIGRATION_KEY = 'customChannels1LegacyImported';
    const CACHE_KEY = 'umininnChannelListCache';
    const REMOVED_KEY = 'umininnRemovedChannels';
    const SHARED_CACHE_KEY = 'umininnSharedChannelCache';
    const SHARED_UPDATE_KEY = 'umininnSharedChannelUpdate';
    const PLATFORMS = new Set(['twitch', 'kick', 'ok', 'at', 'm3u8', 'youtube', 'bs', 'vaughn', 'gosh', 'goodgame']);
    const CASE_INSENSITIVE_IDS = new Set(['twitch', 'kick', 'at', 'vaughn', 'gosh']);
    const ALIASES = { vl: 'kick', okru: 'ok', angelthump: 'at' };
    // Confirmed unavailable on 2026-10-14; evidence and distinctions are in channel-validation.json.
    // This affects the loaded list only: saved originals, backups and user tombstones remain intact.
    const CONFIRMED_UNAVAILABLE_2026_10_14 = new Set([
        'kick|wing36747', 'kick|no25no25', 'kick|cobra-and-godzilla', 'kick|cobra2024',
        'kick|godzilla-cobra-2027', 'kick|godzilla-god-2077', 'kick|kww291603', 'kick|no52no52',
        'kick|peterpig8964', 'kick|wing3674', 'kick|wingchihappy1', 'kick|wingwhite383', 'kick|wwhite1852',
        'twitch|no25no2501', 'twitch|1', 'twitch|alancml', 'twitch|godzilla_2025',
        'twitch|mingpig930_2', 'twitch|wing36747', 'twitch|ww291603', 'twitch|yaubotai2',
        'ok|3849262800563', 'ok|9013975129715', 'ok|9770604043891', 'ok|9784642182771'
    ]);

    function platformKey(value) {
        const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
        return ALIASES[key] || key;
    }

    function canonicalChannelId(id, platform) {
        if (!/^https?:\/\//i.test(id)) return id;
        let url;
        try { url = new URL(id); } catch (error) { return id; }
        if (url.username || url.password || url.port) return id;
        if (platform === 'twitch' && ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'].includes(url.hostname)) {
            const match = url.pathname.match(/^\/([a-zA-Z0-9_]+)\/?$/);
            if (match) return match[1];
        }
        if (platform === 'youtube') {
            if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname) && /^\/watch\/?$/.test(url.pathname)) {
                const videoId = url.searchParams.get('v');
                if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) return videoId;
            }
            if (['youtu.be', 'www.youtu.be'].includes(url.hostname)) {
                const match = url.pathname.match(/^\/([a-zA-Z0-9_-]{11})\/?$/);
                if (match) return match[1];
            }
        }
        return id;
    }

    function normalizeChannel(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const platform = platformKey(value.platform);
        if (!PLATFORMS.has(platform) || !['string', 'number'].includes(typeof value.id)) return null;
        let id = String(value.id).trim();
        const name = typeof value.name === 'string' ? value.name.trim() : '';
        if (!id || !name) return null;
        id = canonicalChannelId(id, platform);
        if (CASE_INSENSITIVE_IDS.has(platform) && !/^https?:\/\//i.test(id)) id = id.toLowerCase();
        const channel = { name, id, platform };
        // The historical CSV can have authentication fields after column 3.
        // Only GoodGame's public username belongs in the channel object.
        if (platform === 'goodgame' && typeof value.ggUsername === 'string' && /^[\w.-]{1,80}$/.test(value.ggUsername.trim())) {
            channel.ggUsername = value.ggUsername.trim();
        }
        if (value._fromTxt) channel._fromTxt = true;
        if (value._fromAPI) channel._fromAPI = true;
        return channel;
    }

    function channelKey(channel) {
        const normalized = normalizeChannel(channel);
        return normalized ? `${normalized.platform}|${normalized.id}` : '';
    }

    function mergeChannels(...groups) {
        const seen = new Map();
        for (const group of groups) {
            if (!Array.isArray(group)) continue;
            for (const value of group) {
                const channel = normalizeChannel(value);
                if (!channel) continue;
                const key = channelKey(channel);
                if (!seen.has(key)) seen.set(key, channel);
            }
        }
        return Array.from(seen.values());
    }

    function parseChannelText(text) {
        if (typeof text !== 'string') throw new Error('Invalid channel list');
        const channels = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => {
            if (!line.trim() || line.trim().startsWith('#')) return null;
            const [name, id, platform, ggUsername] = line.split(',').map(part => part.trim());
            return normalizeChannel({ name, id, platform, ggUsername, _fromTxt: true });
        }).filter(Boolean);
        if (text.trim() && !channels.length && !text.split(/\r?\n/).every(line => !line.trim() || line.trim().startsWith('#'))) {
            throw new Error('Channel list has no valid channels');
        }
        return mergeChannels(channels);
    }

    function readRaw(storage, key) {
        try { return storage.getItem(key); } catch (error) { return null; }
    }

    function writeRaw(storage, key, value) {
        try { storage.setItem(key, value); return true; } catch (error) { return false; }
    }

    function preserveStoredValue(storage, key, raw) {
        const firstKey = key + 'RecoveryBackup';
        const first = readRaw(storage, firstKey);
        if (first === raw) return true;
        if (first === null) return writeRaw(storage, firstKey, raw);
        // Keep the initial recovery copy while retaining a later changed value.
        const latestKey = key + 'RecoveryBackupLatest';
        return readRaw(storage, latestKey) === raw || writeRaw(storage, latestKey, raw);
    }

    function readArray(storage, key) {
        const raw = readRaw(storage, key);
        if (raw === null) return [];
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) throw new Error('Invalid stored channel list');
            return parsed;
        } catch (error) {
            // Preserve the original value before allowing a later explicit edit.
            preserveStoredValue(storage, key, raw);
            return [];
        }
    }

    function cleanCustomChannels(channels) {
        return mergeChannels(channels.filter(channel => channel && !channel._fromTxt && !channel._fromAPI)).map(channel => {
            const { _fromTxt, _fromAPI, ...clean } = channel;
            return clean;
        });
    }

    function readCustomChannels(storage) {
        const current = cleanCustomChannels(readArray(storage, CUSTOM_KEY));
        if (readRaw(storage, MIGRATION_KEY) === 'true') return current;
        const legacy = readArray(storage, LEGACY_KEY).map(value => {
            if (!value || typeof value !== 'object') return value;
            const { _fromTxt, _fromAPI, isDefault, ...clean } = value;
            return clean;
        });
        const merged = mergeChannels(current, legacy);
        const original = readRaw(storage, CUSTOM_KEY);
        if (original !== null && !preserveStoredValue(storage, CUSTOM_KEY, original)) return merged;
        if (writeRaw(storage, CUSTOM_KEY, JSON.stringify(merged))) writeRaw(storage, MIGRATION_KEY, 'true');
        return merged;
    }

    function saveCustomChannels(storage, channels) {
        const original = readRaw(storage, CUSTOM_KEY);
        let valid = true;
        if (original !== null) {
            try { valid = Array.isArray(JSON.parse(original)); } catch (error) { valid = false; }
        }
        if (original !== null && (!valid || readRaw(storage, MIGRATION_KEY) !== 'true') && !preserveStoredValue(storage, CUSTOM_KEY, original)) {
            return false;
        }
        return writeRaw(storage, CUSTOM_KEY, JSON.stringify(cleanCustomChannels(channels)));
    }

    function removedKeys(storage) {
        return new Set(readArray(storage, REMOVED_KEY).filter(value => typeof value === 'string').map(value => {
            const separator = value.indexOf('|');
            if (separator === -1) return value;
            return channelKey({ name: 'Removed channel', platform: value.slice(0, separator), id: value.slice(separator + 1) }) || value;
        }));
    }

    function forgetChannel(storage, channel) {
        const key = channelKey(channel);
        if (!key) return;
        const removed = removedKeys(storage);
        removed.add(key);
        writeRaw(storage, REMOVED_KEY, JSON.stringify(Array.from(removed)));
    }

    function restoreChannel(storage, channel) {
        const removed = removedKeys(storage);
        removed.delete(channelKey(channel));
        writeRaw(storage, REMOVED_KEY, JSON.stringify(Array.from(removed)));
    }

    async function loadChannels(storage, fetcher, providedText) {
        const custom = readCustomChannels(storage);
        let defaults = mergeChannels(readArray(storage, CACHE_KEY)).map(channel => ({ ...channel, _fromTxt: true }));
        let raw = null;
        try {
            let text = providedText;
            if (typeof text !== 'string') {
                const response = await fetcher(`./ch1.txt?t=${Date.now()}`, { cache: 'no-store' });
                if (!response.ok) throw new Error('Channel list unavailable');
                text = await response.text();
            }
            defaults = parseChannelText(text);
            raw = text;
            writeRaw(storage, CACHE_KEY, JSON.stringify(defaults));
        } catch (error) {
            console.warn('Unable to refresh channels; keeping saved channels and the last valid list.');
        }
        const removed = removedKeys(storage);
        return { channels: mergeChannels(custom, defaults).filter(channel => {
            const key = channelKey(channel);
            return !removed.has(key) && !CONFIRMED_UNAVAILABLE_2026_10_14.has(key);
        }), raw };
    }

    function readObject(storage, key) {
        try {
            const value = JSON.parse(readRaw(storage, key));
            return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
        } catch (error) { return null; }
    }

    // A successful GitHub save can precede the Pages deployment. Remember exactly
    // which old file versions may still be served, rather than replacing a newer
    // deployment with an arbitrary long-lived browser copy.
    function publishSharedSnapshot(storage, raw, previousRaw, additionalOldVersions = []) {
        parseChannelText(raw);
        const pending = readObject(storage, SHARED_UPDATE_KEY);
        const cached = readObject(storage, SHARED_CACHE_KEY);
        const oldVersions = [previousRaw, cached && cached.raw, ...additionalOldVersions];
        if (pending && typeof pending.raw === 'string') {
            oldVersions.push(pending.raw, ...(Array.isArray(pending.oldVersions) ? pending.oldVersions : []));
        }
        const update = {
            raw,
            oldVersions: [...new Set(oldVersions.filter(value => typeof value === 'string' && value !== raw))].slice(0, 32)
        };
        if (!writeRaw(storage, SHARED_UPDATE_KEY, JSON.stringify(update))) return false;
        return true;
    }

    async function loadSharedChannels(storage, fetcher, providedText) {
        const pendingBeforeRequest = readRaw(storage, SHARED_UPDATE_KEY);
        let raw = null;
        let refreshed = false;
        try {
            raw = providedText;
            if (typeof raw !== 'string') {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 15000);
                try {
                    const response = await fetcher(`./ch1.txt?t=${Date.now()}`, { cache: 'no-store', signal: controller.signal });
                    if (!response.ok) throw new Error('Channel list unavailable');
                    raw = await response.text();
                } finally { clearTimeout(timer); }
            }
            parseChannelText(raw);
            refreshed = true;
        } catch (error) {
            const cached = readObject(storage, SHARED_CACHE_KEY);
            raw = cached && typeof cached.raw === 'string' ? cached.raw : null;
        }

        // Read after the network await so a save in another tab wins over an
        // older response already in flight. Private legacy storage is untouched.
        const pendingAfterRequest = readRaw(storage, SHARED_UPDATE_KEY);
        const pending = readObject(storage, SHARED_UPDATE_KEY);
        if (!pending && pendingBeforeRequest !== pendingAfterRequest) {
            const currentCache = readObject(storage, SHARED_CACHE_KEY);
            if (currentCache && typeof currentCache.raw === 'string') {
                try { parseChannelText(currentCache.raw); raw = currentCache.raw; } catch (error) { /* Retain the valid network result. */ }
            }
        }
        if (pending && typeof pending.raw === 'string') {
            try {
                parseChannelText(pending.raw);
                if (pendingBeforeRequest !== pendingAfterRequest) {
                    raw = pending.raw;
                } else if (refreshed && raw === pending.raw) {
                    writeRaw(storage, SHARED_UPDATE_KEY, 'null');
                } else if (raw === null || raw === pending.raw || (Array.isArray(pending.oldVersions) && pending.oldVersions.includes(raw))) {
                    raw = pending.raw;
                } else if (refreshed) {
                    // A different valid deployment superseded our saved version.
                    writeRaw(storage, SHARED_UPDATE_KEY, 'null');
                }
            } catch (error) { /* Ignore a malformed browser cache. */ }
        }
        let channels = [];
        if (typeof raw === 'string') {
            try {
                channels = parseChannelText(raw);
                writeRaw(storage, SHARED_CACHE_KEY, JSON.stringify({ raw }));
            } catch (error) { raw = null; }
        }
        return { channels, raw, refreshed };
    }

    const api = { platformKey, normalizeChannel, channelKey, mergeChannels, parseChannelText, readCustomChannels, saveCustomChannels, forgetChannel, restoreChannel, loadChannels,
        loadSharedChannels, publishSharedSnapshot, sharedUpdateKey: SHARED_UPDATE_KEY };
    root.ChannelList = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
