'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { renderUserscript } = require('../tools/build-player-userscript.cjs');
const root = path.resolve(__dirname, '..');
const legacy = { 'menu-dismiss.js': 'menu-dismiss.js', 'layout-bookmarks.js': 'layout-bookmarks.js',
    'topbar-menu.js': 'topbar-menu.js', 'tv-app.js': 'tv-app.js', 'admin.html': 'admin.html' };
const resolveSource = file => fs.existsSync(path.join(root, file)) ? path.join(root, file) : path.join(root, legacy[file] || file);
const read = file => fs.readFileSync(resolveSource(file), 'utf8');
const menuApi = require(resolveSource('menu-dismiss.js'));

function settings(seconds = 2, corner = 1) {
    const context = vm.createContext({ module: { exports: {} } });
    const source = read('menu-dismiss.js');
    assert.ok(source.includes('const MENU_IDLE_TIMEOUT_SECONDS = 30;'));
    assert.ok(source.includes('const CORNER_ENLARGE_IDLE_TIMEOUT_SECONDS = 10;'));
    vm.runInContext(source.replace('const MENU_IDLE_TIMEOUT_SECONDS = 30;', `const MENU_IDLE_TIMEOUT_SECONDS = ${seconds};`)
        .replace('const CORNER_ENLARGE_IDLE_TIMEOUT_SECONDS = 10;', `const CORNER_ENLARGE_IDLE_TIMEOUT_SECONDS = ${corner};`), context);
    return context.module.exports;
}
function reviewedFunction(source, name) {
    const match = new RegExp('function ' + name + '\\([^)]*\\)\\s*\\{').exec(source);
    assert.ok(match, 'production timer function exists: ' + name);
    let index = match.index + match[0].length, depth = 1;
    for (; index < source.length && depth; index++) {
        if (source[index] === '{') depth++;
        if (source[index] === '}') depth--;
    }
    assert.equal(depth, 0);
    return source.slice(match.index, index);
}
function clock() {
    let now = 0, sequence = 0;
    const timers = new Map();
    return {
        setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { at: now + delay, callback }); return id; },
        clearTimeout(id) { timers.delete(id); },
        advance(ms) {
            const until = now + ms;
            for (;;) {
                const pending = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
                if (!pending) break;
                now = pending[1].at; timers.delete(pending[0]); pending[1].callback();
            }
            now = until;
        },
        count: () => timers.size
    };
}

test('the web and generated userscript share one frozen timing API with distinct menu and corner values', () => {
    assert.equal(menuApi.MENU_IDLE_TIMEOUT_SECONDS, 30);
    assert.equal(menuApi.CORNER_ENLARGE_IDLE_TIMEOUT_SECONDS, 10);
    assert.equal(Object.isFrozen(menuApi), true);
    const bundle = renderUserscript();
    assert.equal(bundle.split('const MENU_IDLE_TIMEOUT_SECONDS = 30;').length - 1, 1);
    assert.equal(bundle.split('const CORNER_ENLARGE_IDLE_TIMEOUT_SECONDS = 10;').length - 1, 1);
    const marker = '// Source: ' + path.relative(root, resolveSource('menu-dismiss.js')).split(path.sep).join('/');
    assert.ok(bundle.indexOf(marker) >= 0 && bundle.indexOf(marker) < bundle.indexOf('// Source: browser-extension/site-ui.js'));
});

for (const consumer of ['bookmarks', 'toolbar', 'playback controls', 'alternate selection']) {
    test(`changing the canonical menu value to two seconds changes ${consumer} without changing that consumer`, () => {
        const api = settings(), timer = clock();
        const context = vm.createContext({ root: { UmininnMenuDismiss: api }, view: timer, win: timer,
            window: { UmininnMenuDismiss: api }, menuTiming: api, options: {}, menuDismiss: api,
            opened: true, visible: true, idleTimer: null, timer: null, disposed: false, closed: 0,
            panel: { hidden: false, contains() { return false; } }, panelShadow: { activeElement: null }, toggle: { focus() {} },
            setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout });
        vm.runInContext('function close(){closed++;opened=false;} function setOpen(open){panel.hidden=!open;closed++;} function setChannelSelectionVisible(open){visible=open;closed++;}', context);
        let source, name, supporting = '';
        if (consumer === 'bookmarks') { source = read('layout-bookmarks.js'); name = 'resetIdle'; }
        if (consumer === 'toolbar') { source = read('topbar-menu.js'); name = 'armIdle'; supporting = reviewedFunction(source, 'clearIdle'); }
        if (consumer === 'playback controls') {
            source = read('browser-extension/site-ui.js'); name = 'armIdleTimer';
            supporting = source.match(/const menuIdleTimeoutSeconds = [^;]+;/)[0] + '\n' + reviewedFunction(source, 'clearIdleTimer');
        }
        if (consumer === 'alternate selection') {
            source = read('admin.html').split('const channelSelectionIdleTimer =')[1]; name = 'reset';
        }
        vm.runInContext(supporting + '\n' + reviewedFunction(source, name) + '\n' + name + '();', context);
        timer.advance(1999); assert.equal(context.closed, 0);
        timer.advance(1); assert.equal(context.closed, 1); assert.equal(timer.count(), 0);
    });
}

test('legacy native playback packages without the timing module keep their existing thirty-second timeout', () => {
    const source = read('browser-extension/site-ui.js'), timer = clock();
    const context = vm.createContext({ menuDismiss: undefined, win: timer, idleTimer: null, disposed: false, closed: 0,
        panel: { hidden: false, contains() { return false; } }, panelShadow: { activeElement: null }, toggle: { focus() {} },
        setOpen() { context.closed++; } });
    vm.runInContext(source.match(/const menuIdleTimeoutSeconds = [^;]+;/)[0] + '\n' + reviewedFunction(source, 'clearIdleTimer') + '\n' + reviewedFunction(source, 'armIdleTimer') + '\narmIdleTimer();', context);
    timer.advance(29999); assert.equal(context.closed, 0);
    timer.advance(1); assert.equal(context.closed, 1);
});

for (const [page, filename] of [['main', 'tv-app.js'], ['alternate', 'admin.html']]) {
test(`${page} phone channel menu uses canonical timing and ignores background mutations or synthetic activity`, () => {
    const source = read(filename), start = source.indexOf('(function initChannelMenuIdle()');
    const end = source.indexOf('})();', start);
    assert.ok(start >= 0 && end > start);
    const timer = clock(), listeners = new Map(), lifecycle = new Map();
    const menu = { hidden: false, style: { display: 'none' }, addEventListener(type, callback) { listeners.set(type, callback); } };
    let sync;
    const context = vm.createContext({
        window: { UmininnMenuDismiss: settings(), addEventListener(type, callback) { lifecycle.set(type, callback); } },
        document: { getElementById: () => menu, body: { style: { overflow: 'auto' } } },
        getComputedStyle: node => node.style, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout,
        MutationObserver: class { constructor(callback) { sync = callback; } observe() {} }
    });
    const alias = source.match(/^const PLAYER_OVERLAY_TIMEOUT_SECONDS = [^;]+;/m)?.[0] || '';
    vm.runInContext(alias + '\n' + source.slice(start, end + '})();'.length), context);
    assert.equal(timer.count(), 0);
    menu.style.display = 'block'; sync(); timer.advance(1500);
    sync(); listeners.get('pointermove')({ isTrusted: false }); timer.advance(499);
    assert.equal(menu.style.display, 'block'); timer.advance(1); assert.equal(menu.style.display, 'none');
    menu.style.display = 'block'; sync(); timer.advance(1500);
    listeners.get('wheel')({ isTrusted: true }); timer.advance(1999); assert.equal(menu.style.display, 'block');
    timer.advance(1); assert.equal(menu.style.display, 'none');
    menu.style.display = 'block'; sync(); lifecycle.get('pagehide')(); assert.equal(timer.count(), 0);
    assert.equal(menu.style.display, 'none'); assert.equal(context.document.body.style.overflow, 'auto');
});
}
