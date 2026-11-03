'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const site = 'https://umininn-gh.github.io/tv/';
const app = fs.readFileSync(path.join(root, 'tv-app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function actualFunction(name) {
    const match = app.match(new RegExp('^function ' + name + '\\([^]*?\\n}', 'm'));
    assert.ok(match, 'production function exists: ' + name);return match[0];
}
function actualChatInitializer() {
    const start = app.indexOf('(function initChatToggle()'), end = app.indexOf('\n})();', start);
    assert.ok(start >= 0 && end > start, 'production chat-toggle initializer exists');
    return app.slice(start, end + '\n})();'.length);
}
function localTarget(value, base = site) {
    const url = new URL(value, base);assert.equal(url.origin, new URL(site).origin);
    assert.ok(url.pathname.startsWith('/tv/'), 'navigation stays inside the deployed site');
    let file = path.resolve(root, decodeURIComponent(url.pathname.slice('/tv/'.length)));
    assert.ok(file === root || file.startsWith(root + path.sep), 'target stays inside the deployment directory');
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    assert.ok(fs.existsSync(file) && fs.statSync(file).isFile(), 'deployed navigation target exists: ' + url.href);
    return { url, file };
}
function chatFixture(saved = null) {
    class Node {
        constructor() { this.children = [];this.listeners = new Map();this.hidden = false;this.checked = false; }
        appendChild(node) { return this.insertBefore(node, null); }
        insertBefore(node, next) {
            if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
            const index = next ? this.children.indexOf(next) : this.children.length;
            this.children.splice(index, 0, node);node.parentNode = this;return node;
        }
        get firstChild() { return this.children[0] || null; }
        addEventListener(type, listener) { this.listeners.set(type, listener); }
        emit(type) { this.listeners.get(type)?.({ target: this }); }
    }
    const toggle = new Node(), frame = new Node(), control = new Node(), home = new Node(), auth = new Node(), login = new Node();
    home.appendChild(control);auth.appendChild(login);
    const initial = html.match(/<iframe\b[^>]*\bid="chat_embed"[^>]*\bsrc="([^"]+)"/);
    assert.ok(initial, 'the deployed main page contains its chat iframe');
    let source = new URL(initial[1], site).href;
    Object.defineProperty(frame, 'src', { get: () => source, set: value => { source = new URL(value, site).href; } });
    Object.defineProperty(frame, 'contentDocument', { get() {
        if (new URL(source).origin !== new URL(site).origin) throw new Error('Cross-origin document');
        return { getElementById: id => id === 'auth-area' ? auth : null };
    } });
    const nodes = { chatToggle: toggle, chat_embed: frame, chatToggleWrapper: control, 'chat-mode-home': home };
    const storage = new Map(saved === null ? [] : [['chatToggleState', saved]]);
    vm.runInNewContext(actualChatInitializer(), { document: { getElementById: id => nodes[id] }, window: {}, URL,
        parent: new URL(site).hostname, location: { href: site },
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) } });
    return { toggle, frame, control, home, auth, login, storage, initial: initial[1] };
}

test('the actual chat initializer preserves the deployed test3 page and its existing login control', () => {
    const f = chatFixture();assert.equal(new URL(f.initial, site).pathname, '/tv/test3.html');
    assert.equal(new URL(f.frame.src).pathname, '/tv/test3.html', 'initialization cannot replace working HTML with a missing migrated directory');
    localTarget(f.frame.src);assert.equal(f.toggle.checked, false);
    assert.equal(f.control.parentNode, f.auth);assert.equal(f.auth.children[1], f.login);assert.equal(f.home.hidden, true);
});

test('the actual toggle switches to official Twitch and back to the same deployed local chat target', () => {
    const f = chatFixture();f.toggle.checked = true;f.toggle.emit('change');f.frame.emit('load');
    const official = new URL(f.frame.src);assert.equal(official.origin, 'https://www.twitch.tv');
    assert.equal(official.pathname, '/embed/whitewing940920/chat');assert.equal(official.searchParams.get('parent'), 'umininn-gh.github.io');
    assert.equal(f.control.parentNode, f.home);assert.equal(f.storage.get('chatToggleState'), 'true');
    f.toggle.checked = false;f.toggle.emit('change');assert.equal(new URL(f.frame.src).pathname, '/tv/test3.html');localTarget(f.frame.src);
    f.frame.emit('load');assert.equal(f.control.parentNode, f.auth);assert.equal(f.auth.children[1], f.login);assert.equal(f.storage.get('chatToggleState'), 'false');
});

test('a remembered official-chat setting still returns to the existing custom-chat file', () => {
    const f = chatFixture('true');assert.equal(f.toggle.checked, true);assert.equal(new URL(f.frame.src).hostname, 'www.twitch.tv');
    f.toggle.checked = false;f.toggle.emit('change');assert.equal(new URL(f.frame.src).pathname, '/tv/test3.html');localTarget(f.frame.src);
});

test('actual manager and userscript navigation resolves to deployed pages and their local viewer assets', () => {
    const opened = [], context = vm.createContext({ window: { open: (...args) => opened.push(args) } });
    vm.runInContext(['showChannelManager', 'showPopup', 'showUserscript'].map(actualFunction).join('\n'), context);
    for (const section of ['', 'channels', 'manage', 'health']) {
        context.section = section;vm.runInContext('showChannelManager(section)', context);
        const [target, name] = opened.pop(), resolved = localTarget(target);
        assert.equal(resolved.url.pathname, '/tv/channel-manager.html');assert.equal(resolved.url.hash, section ? '#' + section : '');assert.equal(name, 'umininn-channel-manager');
    }
    vm.runInContext('showPopup()', context);assert.equal(localTarget(opened.pop()[0]).url.hash, '#manage');
    vm.runInContext('showUserscript()', context);const [target, name] = opened.pop(), viewer = localTarget(target);
    assert.equal(viewer.url.pathname, '/tv/userscript/');assert.equal(name, 'umininn-userscript');
    for (const match of fs.readFileSync(viewer.file, 'utf8').matchAll(/\b(?:src|href)="([^"]+)"/g)) {
        const url = new URL(match[1], viewer.url);if (url.origin === viewer.url.origin) localTarget(url.href);
    }
});
