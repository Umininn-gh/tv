/* Shared channel recovery and persistence for the main page and admin page. */
(function (root) {
    'use strict';

    const CUSTOM_KEY = 'customChannels1';
    const LEGACY_KEY = 'customChannels';
    const MIGRATION_KEY = 'customChannels1LegacyImported';
    const CACHE_KEY = 'umininnChannelListCache';
    const REMOVED_KEY = 'umininnRemovedChannels';
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

    const api = { platformKey, normalizeChannel, channelKey, mergeChannels, parseChannelText, readCustomChannels, saveCustomChannels, forgetChannel, restoreChannel, loadChannels };
    root.ChannelList = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
