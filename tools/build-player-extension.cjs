#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const vm = require('node:vm');

const TARGETS = Object.freeze(['chrome', 'edge', 'firefox']);
const SOURCE_FILES = Object.freeze([
    'shared/config.js', 'shared/media-controller.js', 'shared/player-recovery.js', 'shared/twitch-controller.js', 'frame-client.js', 'site-ui.js',
    'background.js', 'popup.html', 'popup.js', 'popup.css', 'README.zh-HK.md', 'PRIVACY.zh-HK.html', 'RELEASE.zh-HK.md'
]);
const RELEASE_VERSION = '1.0.0';
const RELEASE_ICONS = Object.freeze(Object.fromEntries([16, 32, 48, 128].map(size => [size, 'icons/icon' + size + '.png'])));
const RELEASE_SOURCE_FILES = Object.freeze([...SOURCE_FILES, ...Object.values(RELEASE_ICONS)]);
const RELEASE_SITE_MATCHES = Object.freeze([
    'https://umininn-gh.github.io/tv/', 'https://umininn-gh.github.io/tv/?*',
    'https://umininn-gh.github.io/tv/index.html*', 'https://umininn-gh.github.io/tv/admin.html*'
]);
const RELEASE_PLAYER_MATCHES = Object.freeze([
    'player.twitch.tv', 'player.kick.com', 'ok.ru', 'www.youtube.com', 'youtube.com',
    'www.youtube-nocookie.com', 'youtube-nocookie.com', 'player.angelthump.com',
    'goodgame.ru', 'player.goodgame.ru'
].map(host => 'https://' + host + '/*'));
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ value >>> 1 : value >>> 1;
    return value >>> 0;
});

function crc32(bytes) {
    let value = 0xFFFFFFFF;
    for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xFF] ^ value >>> 8;
    return (value ^ 0xFFFFFFFF) >>> 0;
}

// A small deterministic ZIP writer: no executable dependencies, extra file fields or timestamps.
function createZip(entries) {
    const localRecords = [];
    const centralRecords = [];
    let offset = 0;
    const seen = new Set();
    for (const [name, contents] of entries) {
        if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..') || seen.has(name)) {
            throw new Error('Unsafe or duplicate ZIP path: ' + name);
        }
        seen.add(name);
        const filename = Buffer.from(name, 'utf8');
        const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
        const compressed = zlib.deflateRawSync(data, { level: 9 });
        const checksum = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034B50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6); // UTF-8 names.
        local.writeUInt16LE(8, 8); // DEFLATE.
        local.writeUInt16LE(0x0021, 12); // 1980-01-01, identical across builds.
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(filename.length, 26);
        localRecords.push(local, filename, compressed);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014B50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt16LE(0x0021, 14);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(filename.length, 28);
        central.writeUInt32LE(offset, 42);
        centralRecords.push(central, filename);
        offset += local.length + filename.length + compressed.length;
    }
    const centralDirectory = Buffer.concat(centralRecords);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054B50, 0);
    end.writeUInt16LE(seen.size, 8);
    end.writeUInt16LE(seen.size, 10);
    end.writeUInt32LE(centralDirectory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...localRecords, centralDirectory, end]);
}

function assertNoSymlinkAncestors(filename) {
    let current = path.resolve(filename);
    while (true) {
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Unsafe symbolic-link path: ' + current);
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
}

function regularFile(filename) {
    assertNoSymlinkAncestors(filename);
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular source file: ' + filename);
    return fs.readFileSync(filename);
}

function assertSafeDestination(directory, allowedFiles) {
    assertNoSymlinkAncestors(directory);
    if (!fs.existsSync(directory)) return;
    if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory()) throw new Error('Unsafe output directory: ' + directory);
    function visit(current, prefix = '') {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const relative = prefix + entry.name;
            if (entry.isSymbolicLink()) throw new Error('Output contains a symbolic link: ' + relative);
            if (entry.isDirectory() && [...allowedFiles].some(file => file.startsWith(relative + '/'))) visit(path.join(current, entry.name), relative + '/');
            else if (!entry.isFile() || !allowedFiles.has(relative)) throw new Error('Unexpected output file; choose an empty output folder: ' + relative);
        }
    }
    visit(directory);
}

function sameValues(actual, expected) {
    return Array.isArray(actual) && actual.length === expected.length &&
        [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function releaseManifest(manifest, target) {
    const isLocal = match => /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(match);
    manifest.name = 'Umininn TV 播放器控制';
    manifest.version = RELEASE_VERSION;
    manifest.description = '在 Umininn TV 控制已授權播放器的音量、靜音及恢復播放。';
    manifest.icons = { ...RELEASE_ICONS };
    manifest.action = { ...manifest.action, default_icon: { ...RELEASE_ICONS } };
    manifest.host_permissions = (manifest.host_permissions || []).filter(match => !isLocal(match));
    for (const script of manifest.content_scripts || []) script.matches = (script.matches || []).filter(match => !isLocal(match));
    if (!sameValues(manifest.host_permissions, ['https://umininn-gh.github.io/*', ...RELEASE_PLAYER_MATCHES]) ||
        manifest.content_scripts?.length !== 2 ||
        !sameValues(manifest.content_scripts[0].matches, RELEASE_SITE_MATCHES) ||
        !sameValues(manifest.content_scripts[1].matches, RELEASE_PLAYER_MATCHES) ||
        ['permissions', 'optional_permissions', 'optional_host_permissions'].some(key => (manifest[key] || []).length) ||
        manifest.web_accessible_resources || manifest.externally_connectable) {
        throw new Error('Unexpected production permission or content-script scope: ' + target);
    }
    return manifest;
}

function buildPackages(options, release) {
    const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, '..'));
    const sourceRoot = path.join(projectRoot, 'browser-extension');
    const outputRoot = path.resolve(options.outputRoot || path.join(projectRoot, 'outputs', release ? 'player-extension-release' : 'player-extension'));
    const sourceFiles = release ? RELEASE_SOURCE_FILES : SOURCE_FILES;
    // Load every source before writing, so an incomplete checkout produces no partial package.
    const sources = sourceFiles.map(file => {
        // The package entrypoint documents its own channel; development instructions stay in the checkout.
        const source = release && file === 'README.zh-HK.md' ? 'RELEASE.zh-HK.md' : file;
        return [file, regularFile(path.join(sourceRoot, ...source.split('/')))];
    });
    for (const [file, bytes] of sources) {
        if (file.endsWith('.js')) new vm.Script(bytes.toString('utf8'), { filename: file });
    }
    const packages = TARGETS.map(target => {
        let manifestBytes = regularFile(path.join(sourceRoot, 'manifests', target + '.json'));
        const manifest = JSON.parse(manifestBytes.toString('utf8'));
        if (manifest.manifest_version !== 3) throw new Error('Expected Manifest V3: ' + target);
        if (release) manifestBytes = Buffer.from(JSON.stringify(releaseManifest(manifest, target), null, 2) + '\n');
        const referenced = [manifest.action?.default_popup, manifest.background?.service_worker,
            ...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {}),
            ...(manifest.background?.scripts || []), ...(manifest.content_scripts || []).flatMap(entry => [...(entry.js || []), ...(entry.css || [])])].filter(Boolean);
        if (referenced.some(file => !sourceFiles.includes(file))) throw new Error('Manifest references an unpackaged file: ' + target);
        return { target, entries: [['manifest.json', manifestBytes], ...sources] };
    });
    assertNoSymlinkAncestors(outputRoot);
    const allowedFiles = new Set(['manifest.json', ...sourceFiles]);
    if (release) {
        const allowedOutputFiles = new Set([
            ...TARGETS.flatMap(target => [...allowedFiles].map(file => target + '/' + file)),
            ...TARGETS.map(target => target + '.zip'), 'firefox-unsigned.xpi'
        ]);
        assertSafeDestination(outputRoot, allowedOutputFiles);
    }
    for (const { target } of packages) {
        assertSafeDestination(path.join(outputRoot, target), allowedFiles);
        const zipPath = path.join(outputRoot, target + '.zip');
        if (fs.existsSync(zipPath) && (!fs.lstatSync(zipPath).isFile() || fs.lstatSync(zipPath).isSymbolicLink())) throw new Error('Unsafe ZIP destination: ' + zipPath);
    }
    return packages.map(({ target, entries }) => {
        const directory = path.join(outputRoot, target);
        for (const [file, bytes] of entries) {
            const destination = path.join(directory, ...file.split('/'));
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, bytes);
        }
        const zipPath = path.join(outputRoot, target + '.zip');
        const zipBytes = createZip(entries);
        fs.writeFileSync(zipPath, zipBytes);
        const result = { target, directory, zipPath, files: entries.length, bytes: zipBytes.length };
        if (release && target === 'firefox') {
            result.xpiPath = path.join(outputRoot, 'firefox-unsigned.xpi');
            result.signed = false;
            fs.writeFileSync(result.xpiPath, zipBytes);
        }
        return result;
    });
}

function buildAll(options = {}) { return buildPackages(options, false); }
function buildRelease(options = {}) { return buildPackages(options, true); }

if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        if (args.some(arg => arg !== '--release') || args.length > 1) throw new Error('Usage: node tools/build-player-extension.cjs [--release]');
        console.log(JSON.stringify(args.includes('--release') ? buildRelease() : buildAll(), null, 2));
    }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { TARGETS, SOURCE_FILES, RELEASE_SOURCE_FILES, RELEASE_VERSION, buildAll, buildRelease, createZip, crc32 };
