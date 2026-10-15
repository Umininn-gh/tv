const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {
    RELEASE_VERSION, FILENAME, META_FILENAME, SITE_MATCHES, SOURCE_FILES, renderUserscript, buildUserscript
} = require('../tools/build-player-userscript.cjs');

const root = path.resolve(__dirname, '..');
const configSource = fs.readFileSync(path.join(root, 'browser-extension', 'shared', 'config.js'), 'utf8');
const expectedPlayers = [
    'player.twitch.tv', 'player.kick.com', 'ok.ru', 'www.youtube.com', 'youtube.com',
    'www.youtube-nocookie.com', 'youtube-nocookie.com', 'player.angelthump.com', 'goodgame.ru', 'player.goodgame.ru'
].map(host => 'https://' + host + '/*');

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'umininn-userscript-package-'));
    t.after(() => {
        const resolved = path.resolve(directory);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('umininn-userscript-package-'));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    for (const file of SOURCE_FILES) {
        const filename = path.join(directory, ...file.split('/'));
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        let source = '/* Fixture: ' + file + ' 繁體字 🎥 */\nmodule.exports = { source: ' + JSON.stringify(file) + ' };\n';
        if (file === SOURCE_FILES[0]) source = configSource;
        if (file === 'userscript/bootstrap.js') source = 'window.started = Object.keys(scope).filter(key => key.startsWith("Umininn"));\n';
        fs.writeFileSync(filename, source);
    }
    fs.writeFileSync(path.join(directory, 'userscript', 'private-not-packaged.js'), 'SECRET_FIXTURE');
    return { root: directory, output: path.join(directory, 'outputs', 'player-userscript'), distribution: path.join(directory, 'userscript', FILENAME) };
}

function parseHeader(script) {
    assert.ok(script.startsWith('// ==UserScript==\n'));
    const end = script.indexOf('// ==/UserScript==\n');
    assert.ok(end > 0);
    const fields = new Map();
    for (const line of script.slice(0, end).split('\n')) {
        const match = /^\/\/ @(\S+)\s+(.*)$/.exec(line);
        if (match) fields.set(match[1], [...(fields.get(match[1]) || []), match[2]]);
    }
    return fields;
}

test('installable header has production site/player matches and minimum sandbox settings', t => {
    const context = fixture(t);
    const header = parseHeader(renderUserscript({ projectRoot: context.root }));
    assert.deepEqual(header.get('name'), ['Umininn TV 播放器控制（Userscript）']);
    assert.deepEqual(header.get('version'), [RELEASE_VERSION]);
    assert.deepEqual(header.get('namespace'), ['https://umininn-gh.github.io/tv/']);
    assert.deepEqual(header.get('homepageURL'), ['https://umininn-gh.github.io/tv/']);
    assert.deepEqual(header.get('match'), [...SITE_MATCHES, ...expectedPlayers]);
    assert.deepEqual(header.get('run-at'), ['document-idle']);
    assert.deepEqual(header.get('sandbox'), ['DOM']);
    assert.deepEqual(header.get('inject-into'), ['content']);
    for (const key of ['grant', 'require', 'resource', 'connect', 'noframes', 'updateURL', 'downloadURL']) assert.equal(header.has(key), false, key);
    assert.ok(header.get('match').every(match => match.startsWith('https://') && !/localhost|127\.0\.0\.1|<all_urls>/.test(match)));
});

test('bundle is deterministic, self-contained and keeps module exports private', t => {
    const context = fixture(t);
    const rendered = renderUserscript({ projectRoot: context.root });
    assert.equal(renderUserscript({ projectRoot: context.root }), rendered);
    assert.doesNotThrow(() => new vm.Script(rendered));
    assert.equal(rendered.includes('SECRET_FIXTURE'), false);
    assert.equal(/\beval\s*\(|\bnew\s+Function\b|\bunsafeWindow\b|@require/.test(rendered), false);
    for (const file of SOURCE_FILES) assert.ok(rendered.includes('// Source: ' + file), file);
    assert.equal(rendered.includes('browser-extension/background.js'), false);
    assert.equal(rendered.includes('browser-extension/frame-client.js'), false);
    const window = { setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {} };
    Object.defineProperties(window, {
        chrome: { get() { throw new Error('Must not access extension runtime'); } },
        browser: { get() { throw new Error('Must not access extension runtime'); } }
    });
    const sandbox = { window, document: {}, location: { href: 'https://umininn-gh.github.io/tv/' }, URL };
    vm.runInNewContext(rendered, sandbox);
    assert.deepEqual(Array.from(window.started), ['UmininnConfig', 'UmininnMedia', 'UmininnRecovery', 'UmininnTwitch', 'UmininnSite', 'UmininnUserscript']);
    for (const property of window.started) {
        assert.equal(Object.hasOwn(sandbox, property), false, property);
        assert.equal(Object.hasOwn(window, property), false, property);
    }
    assert.equal(Object.hasOwn(sandbox, 'module'), false);
    assert.equal(Object.hasOwn(sandbox, 'scope'), false);
});

test('build emits identical install file and tracked distribution plus header-only metadata', t => {
    const context = fixture(t);
    const result = buildUserscript({ projectRoot: context.root });
    assert.equal(result.version, RELEASE_VERSION);
    assert.equal(result.files, SOURCE_FILES.length);
    assert.equal(result.distributionPath, context.distribution);
    assert.deepEqual(fs.readdirSync(context.output).sort(), [META_FILENAME, FILENAME].sort());
    const first = fs.readFileSync(result.scriptPath);
    assert.deepEqual(fs.readFileSync(result.distributionPath), first);
    assert.equal(result.bytes, first.length);
    const meta = fs.readFileSync(result.metaPath, 'utf8');
    assert.ok(meta.endsWith('// ==/UserScript==\n'));
    assert.deepEqual(parseHeader(meta), parseHeader(first.toString('utf8')));
    assert.equal(meta.includes('(function'), false);
    buildUserscript({ projectRoot: context.root });
    assert.deepEqual(fs.readFileSync(result.scriptPath), first);
    assert.deepEqual(fs.readFileSync(result.distributionPath), first);
});

test('missing or invalid source aborts before writing distribution or output', t => {
    const context = fixture(t);
    const filename = path.join(context.root, 'userscript', 'transport.js');
    fs.unlinkSync(filename);
    assert.throws(() => buildUserscript({ projectRoot: context.root }), /ENOENT/);
    assert.equal(fs.existsSync(context.output), false);
    assert.equal(fs.existsSync(context.distribution), false);
    fs.writeFileSync(filename, 'function broken(');
    assert.throws(() => buildUserscript({ projectRoot: context.root }), SyntaxError);
    assert.equal(fs.existsSync(context.output), false);
    assert.equal(fs.existsSync(context.distribution), false);
});

test('metadata generation rejects broadened production matching rules', t => {
    const context = fixture(t);
    const filename = path.join(context.root, ...SOURCE_FILES[0].split('/'));
    fs.writeFileSync(filename, configSource.replace('https://umininn-gh.github.io/tv/?*', 'https://umininn-gh.github.io/*'));
    assert.throws(() => buildUserscript({ projectRoot: context.root }), /scope/);
    assert.equal(fs.existsSync(context.output), false);
    fs.writeFileSync(filename, configSource.replace('...PLAYER_HOSTS.map(host => `https://${host}/*`)', "'https://*/*'"));
    assert.throws(() => buildUserscript({ projectRoot: context.root }), /player match/);
    assert.equal(fs.existsSync(context.output), false);
});

test('unexpected output and unsafe destinations cannot overwrite earlier files', t => {
    const context = fixture(t);
    const result = buildUserscript({ projectRoot: context.root });
    const first = fs.readFileSync(result.distributionPath);
    fs.writeFileSync(path.join(context.output, 'private-file.txt'), 'Preserve');
    fs.appendFileSync(path.join(context.root, 'userscript', 'transport.js'), '\nvoid "changed source";');
    assert.throws(() => buildUserscript({ projectRoot: context.root }), /Unexpected output file/);
    assert.deepEqual(fs.readFileSync(result.distributionPath), first);
    for (const outputRoot of [context.root, path.dirname(context.root), path.join(context.root, 'userscript'), path.join(context.root, 'browser-extension', 'bundle')]) {
        assert.throws(() => buildUserscript({ projectRoot: context.root, outputRoot }), /separate from source/);
    }
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

test('build rejects linked project sources and output ancestors', t => {
    const context = fixture(t);
    const linkedProject = path.join(context.root, 'linked-project');
    if (!directoryLink(t, context.root, linkedProject)) return;
    assert.throws(() => buildUserscript({ projectRoot: linkedProject }), /symbolic-link/);
    assert.equal(fs.existsSync(context.output), false);
    fs.unlinkSync(linkedProject);
    const redirected = path.join(context.root, 'redirected');
    fs.mkdirSync(redirected);
    if (!directoryLink(t, redirected, path.join(context.root, 'outputs'))) return;
    assert.throws(() => buildUserscript({ projectRoot: context.root }), /symbolic-link/);
    assert.equal(fs.existsSync(context.distribution), false);
    assert.deepEqual(fs.readdirSync(redirected), []);
});

test('checked-in installable script exactly matches the current sources', () => {
    const rendered = renderUserscript({ projectRoot: root });
    const shipped = fs.readFileSync(path.join(root, 'userscript', FILENAME), 'utf8');
    assert.equal(shipped, rendered);
});
