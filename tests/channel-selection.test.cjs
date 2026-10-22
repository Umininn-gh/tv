'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ChannelList = require('../channel-list.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'tv-app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const selectionStart = source.indexOf('function updateChannelOptionLabel(');
const selectionEnd = source.indexOf('(function initPlayerPositionEditor()', selectionStart);
const statusStart = source.indexOf('function applyStatusClass(');
const statusEnd = source.indexOf('function updateButtonStatus(', statusStart);
assert.ok(selectionStart > 0 && selectionEnd > selectionStart && statusEnd > statusStart,
    'reviewed production selection and status seams must exist');

// This small DOM models native checkbox state as input.checked. It deliberately
// does not emulate label clicks or keyboard activation: the real browser checks
// cover those default actions, hit testing and CSS. No platform/network is used.
class Element {
    constructor(tagName, document) {
        this.tagName = tagName.toUpperCase();
        this.ownerDocument = document;
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this.attributes = new Map();
        this.listeners = new Map();
        this.style = {};
        this.className = '';
        this.id = '';
        this.value = '';
        this.type = '';
        this.checked = false;
        this.hidden = false;
        this.scrollTop = 0;
        this.detaches = 0;
        this._text = '';
    }
    get classList() {
        const element = this;
        const read = () => element.className.split(/\s+/).filter(Boolean);
        return {
            contains: name => read().includes(name),
            add(...names) { element.className = [...new Set([...read(), ...names])].join(' '); },
            remove(...names) { element.className = read().filter(name => !names.includes(name)).join(' '); },
            toggle(name, force) {
                const enabled = force === undefined ? !read().includes(name) : Boolean(force);
                this[enabled ? 'add' : 'remove'](name); return enabled;
            }
        };
    }
    get firstChild() { return this.children[0] || null; }
    get firstElementChild() { return this.firstChild; }
    get childNodes() { return this.children; }
    get parentElement() { return this.parentNode; }
    get nextSibling() {
        if (!this.parentNode) return null;
        return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null;
    }
    get nextElementSibling() { return this.nextSibling; }
    get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected); }
    get htmlFor() { return this.attributes.get('for') || ''; }
    set htmlFor(value) { this.attributes.set('for', String(value)); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get innerText() { return this.textContent; }
    set innerText(value) { this.textContent = value; }
    setAttribute(name, value) {
        value = String(value); this.attributes.set(name, value);
        if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
        else if (name === 'class') this.className = value;
        else if (name === 'checked') this.checked = true;
        else if (name === 'hidden') this.hidden = true;
        else if (['id', 'type', 'value', 'title'].includes(name)) this[name] = value;
    }
    getAttribute(name) {
        if (name === 'class') return this.className;
        if (['id', 'type', 'value', 'title'].includes(name)) return this[name] ?? null;
        return this.attributes.get(name) ?? null;
    }
    removeAttribute(name) { this.attributes.delete(name); if (name === 'hidden') this.hidden = false; }
    appendChild(child) { return this.insertBefore(child, null); }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    insertBefore(child, before) {
        if (child.tagName === '#FRAGMENT') {
            [...child.children].forEach(item => this.insertBefore(item, before)); return child;
        }
        if (child === before) return child;
        if (child.parentNode) child.parentNode.removeChild(child);
        const index = before ? this.children.indexOf(before) : this.children.length;
        if (index < 0) throw new Error('insertBefore target is not a child');
        this.children.splice(index, 0, child); child.parentNode = this; return child;
    }
    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index < 0) throw new Error('removeChild target is not a child');
        this.children.splice(index, 1); child.parentNode = null; child.detaches++; return child;
    }
    remove() { this.parentNode?.removeChild(this); }
    replaceChildren(...children) { [...this.children].forEach(child => this.removeChild(child)); this._text = ''; this.append(...children); }
    contains(other) { return this === other || this.children.some(child => child.contains(other)); }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }
    dispatchEvent(event) {
        if (!event.target) event.target = this;
        event.currentTarget = this;
        for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
        if (event.bubbles !== false) this.parentNode?.dispatchEvent(event);
        return true;
    }
    focus() { this.ownerDocument.activeElement = this; }
    matches(selector) {
        if (selector.startsWith('#')) return this.id === selector.slice(1);
        if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
        if (selector === 'input:checked') return this.tagName === 'INPUT' && this.checked;
        const input = /^input(?:\[type=["']?checkbox["']?\])?$/.test(selector);
        if (input) return this.tagName === 'INPUT' && (!selector.includes('[') || this.type === 'checkbox');
        return this.tagName.toLowerCase() === selector;
    }
    closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
    querySelectorAll(selector) {
        const parts = selector.trim().split(/\s+/);
        const result = [];
        const visit = node => {
            for (const child of node.children) {
                if (child.matches(parts.at(-1)) && (parts.length === 1 ||
                    child.parentNode?.closest(parts.slice(0, -1).join(' ')))) result.push(child);
                visit(child);
            }
        };
        visit(this); return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function fixture(initialChannels, { active = [], statuses = {}, hideOffline = false } = {}) {
    const document = {
        activeElement: null,
        createElement(tag) { return new Element(tag, this); },
        createDocumentFragment() { return new Element('#fragment', this); },
        getElementById(id) { return this.body.querySelector('#' + id); },
        querySelectorAll(selector) { return this.body.querySelectorAll(selector); },
        querySelector(selector) { return this.body.querySelector(selector); }
    };
    document.body = document.createElement('body');
    const mount = (tag, id, parent = document.body) => {
        const node = document.createElement(tag); node.id = id; parent.appendChild(node); return node;
    };
    const panel = mount('div', 'channel-selection'); panel.style.display = 'none';
    const container = mount('div', 'channel-options', panel);
    const summary = mount('p', 'channel-selection-summary', panel);
    mount('p', 'channel-selection-help', panel);
    const toggle = mount('input', 'toggleNotLive'); toggle.type = 'checkbox'; toggle.checked = hideOffline;
    const context = vm.createContext({ document, ChannelList, console,
        channels: initialChannels.map(channel => ({ ...channel })),
        activePlayers: new Map(active.map(channel => [ChannelList.channelKey(channel), { channel }])),
        channelStatuses: { ...statuses }, channelOptionControls: new Map(), channelOptionSequence: 0,
        platformIcon: platform => ({ twitch: 'T', m3u8: 'M', kick: 'K' })[platform] || '?',
        escapeHtml: value => String(value).replace(/[&<>"']/g, character =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]),
        setChannelSelectionVisible(visible) { panel.style.display = visible ? 'block' : 'none'; },
        getComputedStyle(element) { return { display: element.hidden ? 'none' : element.style.display || 'block' }; },
        statusRefreshCount: 0, updateButtonStatus() {}, updateMenuButtonStatus() {},
        // This fixture checks selection state; layout audio is covered separately.
        guardPlayerAudioLayout: action => action
    });
    vm.runInContext(source.slice(statusStart, statusEnd) + '\n' + source.slice(selectionStart, selectionEnd) +
        '\nfunction fetchAllStatuses(){statusRefreshCount++;return Promise.resolve([]);}', context);
    const run = script => vm.runInContext(script, context);
    const controls = () => container.children.map(cell => ({ cell,
        input: cell.querySelector('input'), label: cell.querySelector('label') }));
    function choose(control, checked) {
        control.input.checked = checked;
        control.input.dispatchEvent({ type: 'change', bubbles: true });
    }
    return { document, panel, container, summary, toggle, context, run, controls, choose,
        generate: options => context.generateChannelOptions(options),
        setChannels(channels) { context.channels = channels.map(channel => ({ ...channel })); },
        setStatus(channel, status) {
            context.channelStatuses[channel.platform + '_' + channel.id] = status;
            context.updateChannelOptionLabel(channel);
        }
    };
}

const channel = (id, name = id, platform = 'twitch') => ({ id, name, platform });

test('different accepted channel IDs cannot share a checkbox or label target', () => {
    const first = channel('https://example.test/a-b.m3u8', 'First', 'm3u8');
    const second = channel('https://example.test/a_b.m3u8', 'Second', 'm3u8');
    assert.notEqual(ChannelList.channelKey(first), ChannelList.channelKey(second));
    const f = fixture([first, second]); f.generate();
    const [a, b] = f.controls();
    assert.notEqual(a.input.id, b.input.id);
    assert.equal(f.document.getElementById(a.label.htmlFor), a.input);
    assert.equal(f.document.getElementById(b.label.htmlFor), b.input);
    f.choose(a, true); f.setStatus(first, 'live'); f.setStatus(second, 'not-live');
    assert.equal(a.input.checked, true); assert.equal(b.input.checked, false);
    assert.ok(a.label.classList.contains('live')); assert.ok(b.label.classList.contains('not-live'));
});

test('a shared-list refresh retains unchecked active players, DOM nodes, focus and scroll', () => {
    const a = channel('alpha'), b = channel('beta');
    const f = fixture([a, b], { active: [a, b] }); f.generate();
    const before = f.controls(); assert.deepEqual(before.map(row => row.input.checked), [true, true]);
    f.choose(before[0], false); before[0].input.focus(); f.panel.scrollTop = 173;
    f.generate({ preserveSelection: true }); const after = f.controls();
    assert.deepEqual(after.map(row => row.input.checked), [false, true]);
    for (let index = 0; index < before.length; index++) {
        assert.equal(after[index].cell, before[index].cell);
        assert.equal(after[index].input, before[index].input);
        assert.equal(after[index].label, before[index].label);
        assert.equal(after[index].cell.detaches, 0, 'stable cells must stay attached during pointer activation');
    }
    assert.equal(f.document.activeElement, before[0].input); assert.equal(f.panel.scrollTop, 173);
});

test('refresh reconciles removed/new/renamed channels without reviving unchecked choices', () => {
    const a = channel('alpha'), b = channel('beta'), c = channel('gamma');
    const f = fixture([a, b], { active: [b, c] }); f.generate();
    const [oldA, oldB] = f.controls(); f.choose(oldB, false);
    const renamed = { ...b, name: 'Beta & updated <台>' };
    f.setChannels([renamed, c]); f.generate({ preserveSelection: true });
    const [newB, newC] = f.controls();
    assert.equal(oldA.cell.isConnected, false); assert.equal(newB.cell, oldB.cell);
    assert.equal(newB.cell.detaches, 0, 'removing a preceding channel must not detach an unchanged tile');
    assert.equal(newB.input.checked, false); assert.equal(newB.input.dataset.name, renamed.name);
    assert.equal(newB.label.title, renamed.name);
    assert.equal(newB.label.querySelector('.channel-option-name').textContent, renamed.name);
    assert.equal(newC.input.value, c.id); assert.equal(newC.input.checked, true);
    assert.match(f.summary.textContent, /已選\s*1\s*\/\s*2\s*台/);
    f.setStatus(a, 'live'); assert.equal(f.controls().length, 2, 'late removed-channel status cannot recreate a tile');
});

test('reordering preserves each channel choice and its own control identity', () => {
    const a = channel('alpha'), b = channel('beta'), c = channel('gamma');
    const f = fixture([a, b, c]); f.generate(); const before = f.controls();
    f.choose(before[0], true); f.choose(before[2], true);
    f.setChannels([c, a, b]); f.generate({ preserveSelection: true }); const after = f.controls();
    assert.deepEqual(after.map(row => row.input.value), ['gamma', 'alpha', 'beta']);
    assert.deepEqual(after.map(row => row.input.checked), [true, true, false]);
    assert.equal(after[0].input, before[2].input); assert.equal(after[1].input, before[0].input);
});

test('status results and hide-offline changes leave the user selection intact', () => {
    const a = channel('alpha'), b = channel('beta'); const f = fixture([a, b]); f.generate();
    const [first, second] = f.controls(); f.choose(first, true);
    for (const status of ['live', 'not-live', 'unknown', 'unknown2']) {
        f.setStatus(a, status); f.setStatus(b, status);
        assert.equal(first.input.checked, true); assert.equal(second.input.checked, false);
        assert.ok(first.label.classList.contains(status));
    }
    f.toggle.checked = true; f.setStatus(a, 'not-live');
    assert.match(f.summary.textContent, /已選\s*1\s*\/\s*2\s*台/);
    assert.match(f.summary.textContent, /1\s*台已隱藏/);
    f.toggle.checked = false; f.run('updateChannelSelectionSummary()');
    assert.doesNotMatch(f.summary.textContent, /已隱藏/); assert.equal(first.input.checked, true);
});

test('all/clear handles visible, unknown and hidden selected channels and reports the count', () => {
    const rows = ['live', 'not-live', 'unknown', 'unknown2'].map((status, index) => channel('row' + index));
    const statuses = Object.fromEntries(rows.map((row, index) => ['twitch_' + row.id,
        ['live', 'not-live', 'unknown', 'unknown2'][index]]));
    const f = fixture(rows, { statuses }); f.generate();
    f.run('selectAllChannelSelection()');
    assert.deepEqual(f.controls().map(row => row.input.checked), [true, true, true, true]);
    assert.match(f.summary.textContent, /已選\s*4\s*\/\s*4\s*台/);
    f.toggle.checked = true; f.run('selectAllChannelSelection()');
    assert.deepEqual(f.controls().map(row => row.input.checked), [true, false, true, true]);
    f.choose(f.controls()[1], true); assert.match(f.summary.textContent, /1\s*台已隱藏/);
    f.run('clearAllChannelSelection()');
    assert.ok(f.controls().every(row => row.input.checked === false));
    assert.match(f.summary.textContent, /已選\s*0\s*\/\s*4\s*台/); assert.doesNotMatch(f.summary.textContent, /已隱藏/);
});

test('online-only uses confirmed live status and does not mistake green unknown state for selection', () => {
    const rows = ['live', 'not-live', 'unknown', 'unknown2'].map((status, index) => channel('row' + index));
    const f = fixture(rows, { statuses: Object.fromEntries(rows.map((row, index) =>
        ['twitch_' + row.id, ['live', 'not-live', 'unknown', 'unknown2'][index]])) });
    f.generate(); f.run('selectAllChannelSelection();checkAllLiveChannels()');
    assert.deepEqual(f.controls().map(row => row.input.checked), [true, false, false, false]);
    assert.match(f.summary.textContent, /已選\s*1\s*\/\s*4\s*台/);
});

for (const method of ['selectAllChannelSelection', 'checkAllLiveChannels']) {
    test(`${method}: one native deselection survives a pending status response and list refresh`, async () => {
        const rows = ['alpha', 'beta', 'gamma'].map(id => channel(id, id, 'kick'));
        const f = fixture(rows, { active: [rows[0]],
            statuses: Object.fromEntries(rows.map(row => ['kick_' + row.id, 'live'])) });
        f.generate();
        assert.deepEqual(f.controls().map(row => row.input.checked), [true, false, false]);
        f.run(method + '()');
        const before = f.controls();
        assert.deepEqual(before.map(row => row.input.checked), [true, true, true]);

        // Complete an actual production fetchStatus() after native deselection,
        // so a late async status response cannot silently reapply bulk selection.
        let deliverStatus;
        const response = new Promise(resolve => { deliverStatus = resolve; });
        f.context.getPlatform = () => ({ status: () => response });
        f.context.statusScheduler = { run: (_key, operation) => operation(undefined) };
        const pending = f.context.fetchStatus(rows[0], { force: true });
        f.choose(before[0], false);
        assert.deepEqual(before.map(row => row.input.checked), [false, true, true]);
        deliverStatus('not-live'); await pending;
        assert.equal(before[0].label.classList.contains('not-live'), true);
        assert.deepEqual(before.map(row => row.input.checked), [false, true, true]);
        assert.equal(f.context.activePlayers.has(ChannelList.channelKey(rows[0])), true);

        f.generate({ preserveSelection: true });
        const after = f.controls();
        assert.deepEqual(after.map(row => row.input.checked), [false, true, true]);
        assert.equal(after[0].input, before[0].input);
        assert.equal(after[0].cell.detaches, 0);
        assert.match(f.summary.textContent, /已選\s*2\s*\/\s*3\s*台/);
    });
}

test('native change events refresh the summary without reversing checkbox state', () => {
    const f = fixture([channel('alpha')]); f.generate(); const [control] = f.controls();
    f.choose(control, true); assert.equal(control.input.checked, true);
    assert.match(f.summary.textContent, /已選\s*1\s*\/\s*1\s*台/);
    f.choose(control, false); assert.equal(control.input.checked, false);
    assert.match(f.summary.textContent, /已選\s*0\s*\/\s*1\s*台/);
});

test('empty lists and repeated refreshes leave no stale controls or selected count', () => {
    const f = fixture([channel('alpha')]); f.generate(); f.run('selectAllChannelSelection()');
    f.setChannels([]); f.generate({ preserveSelection: true });
    f.run('selectAllChannelSelection();checkAllLiveChannels();clearAllChannelSelection()');
    assert.equal(f.controls().length, 0); assert.match(f.summary.textContent, /已選\s*0\s*\/\s*0\s*台/);
    f.generate({ preserveSelection: true }); assert.equal(f.controls().length, 0);
});

test('pressed channel labels do not shrink away from the click point', () => {
    const rule = html.match(/#channel-options\s+\.channel-option-label:active\s*\{([^}]*)\}/);
    assert.ok(rule, 'the press feedback rule remains present');
    assert.doesNotMatch(rule[1], /transform\s*:/, 'geometry-changing press feedback loses held edge clicks');
    assert.match(html, /id="channel-selection-summary"/);
    assert.match(html, /id="channel-selection-help"/);
});
