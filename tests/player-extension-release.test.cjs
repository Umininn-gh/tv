const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { TARGETS, SOURCE_FILES, RELEASE_SOURCE_FILES, RELEASE_VERSION, buildAll, buildRelease, crc32 } = require('../tools/build-player-extension.cjs');

const projectRoot = path.resolve(__dirname, '..');
const sourceManifests = Object.fromEntries(TARGETS.map(target => [target,
    JSON.parse(fs.readFileSync(path.join(projectRoot, 'browser-extension', 'manifests', target + '.json'), 'utf8'))]));
const productionPlayers = [
    'player.twitch.tv', 'player.kick.com', 'ok.ru', 'www.youtube.com', 'youtube.com',
    'www.youtube-nocookie.com', 'youtube-nocookie.com', 'player.angelthump.com', 'goodgame.ru', 'player.goodgame.ru'
].map(host => 'https://' + host + '/*');
const productionSites = [
    'https://umininn-gh.github.io/tv/', 'https://umininn-gh.github.io/tv/?*',
    'https://umininn-gh.github.io/tv/index.html*', 'https://umininn-gh.github.io/tv/admin.html*'
];
const sorted = values => [...values].sort();

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'umininn-extension-release-'));
    t.after(() => {
        const resolved = path.resolve(root);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('umininn-extension-release-'));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    const source = path.join(root, 'browser-extension');
    fs.mkdirSync(path.join(source, 'manifests'), { recursive: true });
    for (const target of TARGETS) fs.writeFileSync(path.join(source, 'manifests', target + '.json'), JSON.stringify(sourceManifests[target]) + '\n');
    for (const file of RELEASE_SOURCE_FILES) {
        const destination = path.join(source, ...file.split('/'));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, file.endsWith('.js') ? 'void "繁體字 🎥";\n' : Buffer.from('Asset bytes: ' + file + '\n繁體字 🎥\n'));
    }
    fs.writeFileSync(path.join(source, 'private-key.pem'), 'Must never be packaged');
    return { root, source, output: path.join(root, 'outputs', 'player-extension-release') };
}

function unpack(bytes) {
    const end = bytes.length - 22;
    assert.equal(bytes.readUInt32LE(end), 0x06054B50);
    const count = bytes.readUInt16LE(end + 10);
    let cursor = bytes.readUInt32LE(end + 16);
    assert.equal(cursor + bytes.readUInt32LE(end + 12), end);
    const entries = new Map();
    for (let index = 0; index < count; index++) {
        assert.equal(bytes.readUInt32LE(cursor), 0x02014B50);
        assert.equal(bytes.readUInt16LE(cursor + 8), 0x0800);
        assert.equal(bytes.readUInt16LE(cursor + 10), 8);
        const nameLength = bytes.readUInt16LE(cursor + 28);
        const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
        const offset = bytes.readUInt32LE(cursor + 42);
        assert.equal(bytes.readUInt32LE(offset), 0x04034B50);
        assert.equal(bytes.readUInt16LE(offset + 26), nameLength);
        assert.equal(bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'), name);
        const compressedSize = bytes.readUInt32LE(cursor + 20);
        const start = offset + 30 + nameLength + bytes.readUInt16LE(offset + 28);
        const contents = zlib.inflateRawSync(bytes.subarray(start, start + compressedSize));
        assert.equal(contents.length, bytes.readUInt32LE(cursor + 24));
        assert.equal(crc32(contents), bytes.readUInt32LE(cursor + 16));
        assert.equal(entries.has(name), false);
        entries.set(name, contents);
        cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    }
    assert.equal(cursor, end);
    return entries;
}

test('release packages have stable metadata, fixed production scope and all icon resources', t => {
    const context = fixture(t);
    const results = buildRelease({ projectRoot: context.root });
    assert.equal(RELEASE_VERSION, '1.0.0');
    assert.deepEqual(results.map(result => result.target), TARGETS);
    for (const result of results) {
        assert.equal(path.dirname(result.directory), context.output);
        const manifest = JSON.parse(fs.readFileSync(path.join(result.directory, 'manifest.json'), 'utf8'));
        assert.equal(manifest.version, '1.0.0');
        assert.doesNotMatch(manifest.name + manifest.description, /測試|beta|localhost|127\.0\.0\.1/i);
        assert.deepEqual(sorted(manifest.host_permissions), sorted(['https://umininn-gh.github.io/*', ...productionPlayers]));
        assert.deepEqual(sorted(manifest.content_scripts[0].matches), sorted(productionSites));
        assert.deepEqual(sorted(manifest.content_scripts[1].matches), sorted(productionPlayers));
        assert.deepEqual(manifest.background, sourceManifests[result.target].background);
        assert.deepEqual(manifest.browser_specific_settings, sourceManifests[result.target].browser_specific_settings);
        assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'none'; connect-src 'none'");
        assert.deepEqual(manifest.permissions || [], []);
        for (const size of [16, 32, 48, 128]) {
            assert.equal(manifest.icons[size], 'icons/icon' + size + '.png');
            assert.equal(manifest.action.default_icon[size], manifest.icons[size]);
            assert.equal(fs.existsSync(path.join(result.directory, manifest.icons[size])), true);
        }
    }
    assert.equal(results[2].signed, false);
    assert.equal(path.basename(results[2].xpiPath), 'firefox-unsigned.xpi');
    assert.deepEqual(fs.readFileSync(results[2].xpiPath), fs.readFileSync(results[2].zipPath));
});

test('release archives contain only allowlisted bytes and are reproducible', t => {
    const context = fixture(t);
    const results = buildRelease({ projectRoot: context.root });
    const firstArchives = results.map(result => fs.readFileSync(result.zipPath));
    for (const result of results) {
        const entries = unpack(fs.readFileSync(result.zipPath));
        assert.deepEqual(sorted(entries.keys()), sorted(['manifest.json', ...RELEASE_SOURCE_FILES]));
        assert.equal(result.files, RELEASE_SOURCE_FILES.length + 1);
        for (const [file, bytes] of entries) {
            assert.deepEqual(bytes, fs.readFileSync(path.join(result.directory, ...file.split('/'))));
            if (file !== 'manifest.json') {
                const source = file === 'README.zh-HK.md' ? 'RELEASE.zh-HK.md' : file;
                assert.deepEqual(bytes, fs.readFileSync(path.join(context.source, ...source.split('/'))));
            }
        }
    }
    buildRelease({ projectRoot: context.root }).forEach((result, index) => assert.deepEqual(fs.readFileSync(result.zipPath), firstArchives[index]));
});

test('development build retains its source manifests, local testing scope and original file allowlist', t => {
    const context = fixture(t);
    for (const result of buildAll({ projectRoot: context.root })) {
        const entries = unpack(fs.readFileSync(result.zipPath));
        assert.deepEqual(sorted(entries.keys()), sorted(['manifest.json', ...SOURCE_FILES]));
        assert.deepEqual(entries.get('manifest.json'), fs.readFileSync(path.join(context.source, 'manifests', result.target + '.json')));
        const manifest = JSON.parse(entries.get('manifest.json'));
        assert.ok(manifest.host_permissions.includes('http://localhost/*'));
        assert.ok(manifest.content_scripts.some(script => script.matches.some(match => match.startsWith('http://127.0.0.1/'))));
    }
});

test('missing release resources and malformed source abort before any output', t => {
    const context = fixture(t);
    const icon = path.join(context.source, 'icons', 'icon128.png');
    const bytes = fs.readFileSync(icon);
    fs.unlinkSync(icon);
    assert.throws(() => buildRelease({ projectRoot: context.root }), /ENOENT/);
    assert.equal(fs.existsSync(context.output), false);
    fs.writeFileSync(icon, bytes);
    fs.writeFileSync(path.join(context.source, 'site-ui.js'), 'function broken(');
    assert.throws(() => buildRelease({ projectRoot: context.root }), SyntaxError);
    assert.equal(fs.existsSync(context.output), false);
});

test('release rejects broadened permissions, unexpected origins and missing manifest resources', t => {
    const context = fixture(t);
    const manifestPath = path.join(context.source, 'manifests', 'edge.json');
    for (const mutate of [
        manifest => { manifest.host_permissions.push('https://unexpected.example/*'); },
        manifest => { manifest.content_scripts[0].matches.push('https://umininn-gh.github.io/*'); },
        manifest => { manifest.permissions = ['tabs']; },
        manifest => { manifest.action.default_popup = 'not-packaged.html'; }
    ]) {
        const manifest = structuredClone(sourceManifests.edge);
        mutate(manifest);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        assert.throws(() => buildRelease({ projectRoot: context.root }), /scope|unpackaged/);
        assert.equal(fs.existsSync(context.output), false);
    }
});

test('unexpected release output aborts before overwriting any browser package', t => {
    const context = fixture(t);
    const [chrome] = buildRelease({ projectRoot: context.root });
    const original = fs.readFileSync(chrome.zipPath);
    fs.writeFileSync(path.join(context.output, 'firefox', 'stale-script.js'), 'stale code');
    fs.writeFileSync(path.join(context.source, 'site-ui.js'), 'void "new source";');
    assert.throws(() => buildRelease({ projectRoot: context.root }), /Unexpected output file/);
    assert.deepEqual(fs.readFileSync(chrome.zipPath), original);
});

function directoryLink(t, target, link) {
    try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
        if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
        t.skip('Directory symlinks are unavailable: ' + error.code);
        return false;
    }
    return true;
}

test('release rejects a source directory link before reading or writing a package', t => {
    const context = fixture(t);
    const linkedProject = path.join(context.root, 'linked-project');
    if (!directoryLink(t, context.root, linkedProject)) return;
    assert.throws(() => buildRelease({ projectRoot: linkedProject }), /symbolic-link/);
    assert.equal(fs.existsSync(context.output), false);
});

test('release rejects linked output ancestors and linked nested output folders', t => {
    const context = fixture(t);
    const redirected = path.join(context.root, 'redirected');
    fs.mkdirSync(redirected);
    const parent = path.join(context.root, 'outputs');
    if (!directoryLink(t, redirected, parent)) return;
    assert.throws(() => buildRelease({ projectRoot: context.root }), /symbolic-link/);
    assert.deepEqual(fs.readdirSync(redirected), []);
    fs.unlinkSync(parent);
    const [chrome] = buildRelease({ projectRoot: context.root });
    const original = fs.readFileSync(chrome.zipPath);
    const iconDirectory = path.join(context.output, 'edge', 'icons');
    for (const icon of fs.readdirSync(iconDirectory)) fs.unlinkSync(path.join(iconDirectory, icon));
    fs.rmdirSync(iconDirectory);
    if (!directoryLink(t, redirected, iconDirectory)) return;
    assert.throws(() => buildRelease({ projectRoot: context.root }), /symbolic link/);
    assert.deepEqual(fs.readFileSync(chrome.zipPath), original);
    assert.deepEqual(fs.readdirSync(redirected), []);
});
