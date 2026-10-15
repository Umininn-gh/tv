const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'browser-extension', 'site-ui.js'), 'utf8');

function runBootstrap({ firefox = false, top = true, trusted = true, mounted = false, runtime = true } = {}) {
    const observed = [];
    const events = [];
    const checkedUrls = [];
    const document = {
        documentElement: {},
        getElementById(id) { return mounted && id === 'umininn-player-control-host' ? {} : null; }
    };
    const window = {
        document,
        location: { href: 'https://umininn-gh.github.io/tv/' },
        MutationObserver: class {
            observe(element, options) { observed.push({ element, options }); }
            disconnect() {}
        },
        addEventListener(type, listener) { events.push({ type, listener }); },
        removeEventListener() {}
    };
    window.window = window;
    window.top = top ? window : {};
    document.defaultView = window;
    // Firefox keeps extension-owned exports on a sandbox whose prototype is Window.
    const sandbox = firefox ? Object.create(window) : { ...window };
    sandbox.UmininnConfig = { isSiteUrl(url) { checkedUrls.push(url); return trusted; } };
    sandbox.UmininnMedia = {};
    if (runtime) sandbox.browser = { runtime: { sendMessage: () => Promise.resolve({ ok: true }) } };
    const context = vm.createContext(sandbox);
    if (!firefox) vm.runInContext('window = globalThis; top = ' + (top ? 'globalThis' : '{}') + ';', context);
    const distinctGlobal = vm.runInContext('globalThis !== window', context);
    vm.runInContext(source, context, { filename: 'site-ui.js' });
    return { observed, events, checkedUrls, document, window, distinctGlobal };
}

test('Firefox sandbox starts the UI while extension config/media/runtime remain outside Window', () => {
    const result = runBootstrap({ firefox: true });
    assert.equal(result.distinctGlobal, true);
    assert.equal(result.window.UmininnConfig, undefined);
    assert.equal(result.window.UmininnMedia, undefined);
    assert.equal(result.window.browser, undefined);
    assert.equal(result.observed.length, 1, 'UI should wait for the login-gated website DOM');
    assert.equal(result.observed[0].element, result.document.documentElement);
    assert.deepEqual(result.checkedUrls, ['https://umininn-gh.github.io/tv/']);
    assert.deepEqual(result.events.map(event => event.type), ['pagehide']);
});

test('Chrome-style global Window still starts the UI', () => {
    const result = runBootstrap();
    assert.equal(result.distinctGlobal, false);
    assert.equal(result.observed.length, 1);
    assert.deepEqual(result.events.map(event => event.type), ['pagehide']);
});

test('subframes do not bootstrap the site UI in either browser model', () => {
    for (const firefox of [false, true]) {
        const result = runBootstrap({ firefox, top: false });
        assert.equal(result.observed.length, 0);
        assert.equal(result.events.length, 0);
    }
});

test('untrusted pages, missing extension runtime and an existing UI do not start another controller', () => {
    for (const firefox of [false, true]) for (const options of [{ trusted: false }, { runtime: false }, { mounted: true }]) {
        const result = runBootstrap({ firefox, ...options });
        assert.equal(result.observed.length, 0);
        assert.equal(result.events.length, 0);
    }
});
