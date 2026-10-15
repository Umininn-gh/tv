const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { TARGETS, SOURCE_FILES, buildAll, createZip, crc32 } = require('../tools/build-player-extension.cjs');

const root = path.resolve(__dirname, '..');
const sourceRoot = path.join(root, 'browser-extension');
const manifests = Object.fromEntries(TARGETS.map(target => [target, JSON.parse(fs.readFileSync(path.join(sourceRoot, 'manifests', target + '.json'), 'utf8'))]));
const mediaHosts = ['player.twitch.tv', 'player.kick.com', 'ok.ru', 'www.youtube.com', 'youtube.com', 'www.youtube-nocookie.com', 'youtube-nocookie.com', 'player.angelthump.com', 'goodgame.ru', 'player.goodgame.ru'];
const externalMatches = mediaHosts.map(host => 'https://' + host + '/*');
const mediaMatches = [...externalMatches, ...['localhost', '127.0.0.1'].map(host => 'http://' + host + '/work/extension-media-*.html*')];
const siteMatches = [
    'https://umininn-gh.github.io/tv/', 'https://umininn-gh.github.io/tv/?*', 'https://umininn-gh.github.io/tv/index.html*', 'https://umininn-gh.github.io/tv/admin.html*',
    ...['localhost', '127.0.0.1'].flatMap(host => ['/', '/?*', '/index.html*', '/admin.html*', '/work/extension-site-*.html*'].map(value => 'http://' + host + value))
];
const sorted = values => [...values].sort();

function fixture(t) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'umininn-extension-package-'));
    t.after(() => {
        const resolved = path.resolve(tmp);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('umininn-extension-package-'));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    const extension = path.join(tmp, 'browser-extension');
    fs.mkdirSync(path.join(extension, 'manifests'), { recursive: true });
    for (const target of TARGETS) fs.writeFileSync(path.join(extension, 'manifests', target + '.json'), JSON.stringify(manifests[target], null, 2) + '\n');
    for (const file of SOURCE_FILES) {
        const destination = path.join(extension, ...file.split('/'));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, file.endsWith('.js') ? '// Fixture: ' + file + '\nvoid "繁體字 🎥";\n' : 'Fixture: ' + file + '\n繁體字 🎥\n');
    }
    fs.writeFileSync(path.join(extension, 'private-not-packaged.txt'), 'Private fixture');
    return { tmp, extension, output: path.join(tmp, 'outputs', 'player-extension') };
}

// Parse the central directory and local records independently of the writer.
function unzip(bytes) {
    const end = bytes.length - 22;
    assert.equal(bytes.readUInt32LE(end), 0x06054B50);
    assert.equal(bytes.readUInt16LE(end + 20), 0);
    const count = bytes.readUInt16LE(end + 10);
    const directoryLength = bytes.readUInt32LE(end + 12);
    let cursor = bytes.readUInt32LE(end + 16);
    assert.equal(cursor + directoryLength, end);
    const files = new Map();
    for (let index = 0; index < count; index++) {
        assert.equal(bytes.readUInt32LE(cursor), 0x02014B50);
        assert.equal(bytes.readUInt16LE(cursor + 8), 0x0800);
        assert.equal(bytes.readUInt16LE(cursor + 10), 8);
        const checksum = bytes.readUInt32LE(cursor + 16);
        const compressedSize = bytes.readUInt32LE(cursor + 20);
        const uncompressedSize = bytes.readUInt32LE(cursor + 24);
        const filenameLength = bytes.readUInt16LE(cursor + 28);
        const extraLength = bytes.readUInt16LE(cursor + 30);
        const commentLength = bytes.readUInt16LE(cursor + 32);
        const localOffset = bytes.readUInt32LE(cursor + 42);
        const filename = bytes.subarray(cursor + 46, cursor + 46 + filenameLength).toString('utf8');
        assert.equal(bytes.readUInt32LE(localOffset), 0x04034B50);
        const localNameLength = bytes.readUInt16LE(localOffset + 26);
        const localExtraLength = bytes.readUInt16LE(localOffset + 28);
        assert.equal(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8'), filename);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const contents = zlib.inflateRawSync(bytes.subarray(start, start + compressedSize));
        assert.equal(contents.length, uncompressedSize);
        assert.equal(crc32(contents), checksum);
        assert.equal(files.has(filename), false);
        files.set(filename, contents);
        cursor += 46 + filenameLength + extraLength + commentLength;
    }
    assert.equal(cursor, end);
    return files;
}

test('each Manifest V3 grants only fixed site/player origins and no extra API permissions', () => {
    for (const manifest of Object.values(manifests)) {
        assert.equal(manifest.manifest_version, 3);
        assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
        assert.deepEqual(manifest.permissions || [], []);
        assert.deepEqual(manifest.optional_permissions || [], []);
        assert.deepEqual(manifest.optional_host_permissions || [], []);
        assert.deepEqual(sorted(manifest.host_permissions), sorted(['https://umininn-gh.github.io/*', 'http://localhost/*', 'http://127.0.0.1/*', ...externalMatches]));
        assert.equal(manifest.host_permissions.includes('<all_urls>'), false);
        assert.equal(manifest.web_accessible_resources, undefined);
        assert.equal(manifest.externally_connectable, undefined);
        assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'none'; connect-src 'none'");
        assert.equal(manifest.action.default_popup, 'popup.html');
    }
});

test('top-site media controller and external-frame controller never inject twice into the site', () => {
    for (const manifest of Object.values(manifests)) {
        assert.equal(manifest.content_scripts.length, 2);
        const [site, media] = manifest.content_scripts;
        assert.deepEqual(sorted(site.matches), sorted(siteMatches));
        assert.deepEqual(site.js, ['shared/config.js', 'shared/media-controller.js', 'shared/player-recovery.js', 'site-ui.js']);
        assert.equal(site.all_frames, false);
        assert.deepEqual(sorted(media.matches), sorted(mediaMatches));
        assert.deepEqual(media.js, ['shared/config.js', 'shared/media-controller.js', 'shared/twitch-controller.js', 'frame-client.js']);
        assert.equal(media.all_frames, true);
        assert.ok(media.matches.every(match => !site.matches.includes(match)));
        for (const entry of [site, media]) {
            assert.equal(entry.run_at, 'document_idle');
            assert.equal(entry.match_about_blank || false, false);
            assert.equal(entry.match_origin_as_fallback || false, false);
            assert.equal(entry.world || 'ISOLATED', 'ISOLATED');
        }
    }
});

test('background modes and Firefox identity match the target browser', () => {
    assert.deepEqual(manifests.chrome.background, { service_worker: 'background.js' });
    assert.deepEqual(manifests.edge.background, { service_worker: 'background.js' });
    assert.equal(manifests.chrome.minimum_chrome_version, '109');
    assert.equal(manifests.edge.minimum_chrome_version, '109');
    assert.deepEqual(manifests.firefox.background, { scripts: ['shared/config.js', 'background.js'] });
    assert.equal(manifests.chrome.browser_specific_settings, undefined);
    assert.equal(manifests.edge.browser_specific_settings, undefined);
    assert.equal(manifests.firefox.browser_specific_settings.gecko.id, 'player-controls@umininn.local');
    assert.equal(manifests.firefox.browser_specific_settings.gecko.strict_min_version, '140.0');
    assert.deepEqual(manifests.firefox.browser_specific_settings.gecko.data_collection_permissions, { required: ['none'] });
});

test('ZIP CRC matches the standard vector and rejects ambiguous archive paths', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
    for (const name of ['../escape.js', '/escape.js', 'a/../escape.js', 'a\\escape.js', './file.js', 'a//file.js']) {
        assert.throws(() => createZip([[name, Buffer.from('x')]]), /Unsafe/);
    }
    assert.throws(() => createZip([['x.js', 'x'], ['x.js', 'y']]), /duplicate/);
});

test('all three folders and ZIPs contain exactly the allowlist, byte-for-byte, with a root manifest', t => {
    const context = fixture(t);
    const results = buildAll({ projectRoot: context.tmp });
    assert.deepEqual(results.map(result => result.target), TARGETS);
    for (const result of results) {
        const archive = unzip(fs.readFileSync(result.zipPath));
        assert.deepEqual(sorted(archive.keys()), sorted(['manifest.json', ...SOURCE_FILES]));
        assert.equal(result.files, SOURCE_FILES.length + 1);
        for (const [file, contents] of archive) {
            const source = file === 'manifest.json' ? path.join(context.extension, 'manifests', result.target + '.json') : path.join(context.extension, ...file.split('/'));
            assert.deepEqual(contents, fs.readFileSync(source));
            assert.deepEqual(contents, fs.readFileSync(path.join(result.directory, ...file.split('/'))));
        }
    }
    const first = results.map(result => fs.readFileSync(result.zipPath));
    const repeated = buildAll({ projectRoot: context.tmp });
    repeated.forEach((result, index) => assert.deepEqual(fs.readFileSync(result.zipPath), first[index]));
});

test('missing runtime source produces no partially built output', t => {
    const context = fixture(t);
    fs.unlinkSync(path.join(context.extension, 'frame-client.js'));
    assert.throws(() => buildAll({ projectRoot: context.tmp }), /ENOENT/);
    assert.equal(fs.existsSync(context.output), false);
});

test('invalid JavaScript or an unpackaged manifest resource aborts before output', t => {
    const context = fixture(t);
    fs.writeFileSync(path.join(context.extension, 'frame-client.js'), 'function broken(');
    assert.throws(() => buildAll({ projectRoot: context.tmp }), SyntaxError);
    assert.equal(fs.existsSync(context.output), false);
    fs.writeFileSync(path.join(context.extension, 'frame-client.js'), 'void 0;');
    const manifest = { ...manifests.chrome, action: { default_popup: 'missing.html' } };
    fs.writeFileSync(path.join(context.extension, 'manifests', 'chrome.json'), JSON.stringify(manifest));
    assert.throws(() => buildAll({ projectRoot: context.tmp }), /unpackaged/);
    assert.equal(fs.existsSync(context.output), false);
});

test('unexpected files in existing output abort before overwriting any package', t => {
    const context = fixture(t);
    const [chrome] = buildAll({ projectRoot: context.tmp });
    const original = fs.readFileSync(chrome.zipPath);
    fs.writeFileSync(path.join(context.output, 'edge', 'untracked-code.js'), 'Do not include');
    fs.writeFileSync(path.join(context.extension, 'site-ui.js'), 'void "changed source";');
    assert.throws(() => buildAll({ projectRoot: context.tmp }), /Unexpected output file/);
    assert.deepEqual(fs.readFileSync(chrome.zipPath), original);
});

test('shared config and manifests declare the same site and external-player scopes', () => {
    const config = require('../browser-extension/shared/config.js');
    for (const manifest of Object.values(manifests)) {
        assert.deepEqual(sorted(manifest.content_scripts[0].matches), sorted(config.SITE_MATCHES));
        assert.deepEqual(sorted(manifest.content_scripts[1].matches), sorted(config.PLAYER_MATCHES));
    }
});
