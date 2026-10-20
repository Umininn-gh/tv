'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
function readPage(migrated, legacy) {
    const target = path.join(root, migrated);
    return fs.readFileSync(fs.existsSync(target) ? target : path.join(root, legacy), 'utf8');
}
const pages = [
    ['main viewing page', readPage('site/assets/js/tv-app.js', 'tv-app.js')],
    ['alternate viewing page', readPage('site/player/index.html', 'admin.html')]
];

function fixture(source) {
    const start = source.indexOf('const channelSelectionIdleTimer =');
    const visibleStart = source.indexOf('function setChannelSelectionVisible(', start);
    const visibleFunction = source.slice(visibleStart).match(/^function setChannelSelectionVisible\(visible\) \{[\s\S]*?\n[ \t]*\}/);
    assert.ok(start >= 0 && visibleStart > start && visibleFunction, 'production idle timer seam exists');
    const end = visibleStart + visibleFunction[0].length;
    const panelListeners = new Map(), windowListeners = new Map(), timers = new Map();
    let now = 0, nextId = 0, applied = 0, overlayVisible = false;
    const panel = {
        style: { display: 'none' },
        addEventListener(type, callback) { panelListeners.set(type, callback); }
    };
    const context = vm.createContext({
        document: { getElementById(id) { return id === 'channel-selection' ? panel : null; } },
        window: { addEventListener(type, callback) { windowListeners.set(type, callback); } },
        playerNameOverlay: { setVisible(value) { overlayVisible = value; } },
        layoutBookmarkMenu: null,
        setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { at: now + delay, callback }); return id; },
        clearTimeout(id) { timers.delete(id); },
        Date: { now() { return now; } },
        watchSelectedChannels() { applied++; }
    });
    const timeoutSetting = source.match(/^const PLAYER_OVERLAY_TIMEOUT_SECONDS = \d+;/m)?.[0] || '';
    vm.runInContext(timeoutSetting + '\n' + source.slice(start, end), context);
    function advance(milliseconds) {
        const until = now + milliseconds;
        while (true) {
            const pending = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
            if (!pending) break;
            now = pending[1].at;
            timers.delete(pending[0]);
            pending[1].callback();
        }
        now = until;
    }
    return {
        panel, advance, context,
        visible: () => panel.style.display !== 'none',
        overlayVisible: () => overlayVisible,
        applied: () => applied,
        pending: () => timers.size,
        show: () => context.setChannelSelectionVisible(true),
        hide: () => context.setChannelSelectionVisible(false),
        activity(type, options = {}) { panelListeners.get(type)?.({ type, isTrusted: true, ...options }); },
        lifecycle(type) { windowListeners.get(type)?.({ type }); }
    };
}

for (const [name, source] of pages) {
    test(`${name}: closes after 30 seconds without applying draft selection`, () => {
        const f = fixture(source); f.show(); f.advance(29999);
        assert.equal(f.visible(), true); f.advance(1);
        assert.equal(f.visible(), false); assert.equal(f.pending(), 0); assert.equal(f.applied(), 0);
        assert.equal(f.overlayVisible(), false, 'main player names hide with selection');
    });

    test(`${name}: every supported user operation restarts the complete 30 seconds`, () => {
        for (const type of ['pointermove', 'pointerdown', 'pointerup', 'click', 'keydown', 'keyup',
            'input', 'change', 'wheel', 'touchstart', 'touchmove', 'touchend']) {
            const f = fixture(source); f.show(); f.advance(29000); f.activity(type);
            f.advance(29999); assert.equal(f.visible(), true, type);
            f.advance(1); assert.equal(f.visible(), false, type);
        }
    });

    test(`${name}: stationary hover, synthetic activity and background scroll do not extend inactivity`, () => {
        const f = fixture(source); f.show(); f.advance(29000);
        f.activity('pointerenter'); f.activity('focus');
        for (const type of ['pointermove', 'click', 'input', 'change', 'wheel']) f.activity(type, { isTrusted: false });
        f.activity('scroll');
        f.advance(1000); assert.equal(f.visible(), false); assert.equal(f.applied(), 0);
    });

    test(`${name}: a scroll gesture resets activity but background scrolling immediately afterwards does not`, () => {
        const f = fixture(source); f.show(); f.advance(29000); f.activity('wheel');
        f.advance(1000); f.activity('scroll');
        f.advance(28999); assert.equal(f.visible(), true);
        f.advance(1); assert.equal(f.visible(), false, 'close exactly 30 seconds after the wheel, not the background scroll');
    });

    test(`${name}: closing cancels old timers and reopening starts fresh`, () => {
        const f = fixture(source); f.show(); f.advance(29000); f.hide();
        assert.equal(f.pending(), 0); f.activity('click'); assert.equal(f.pending(), 0);
        f.advance(10000); f.show(); f.advance(29999); assert.equal(f.visible(), true);
        f.advance(1); assert.equal(f.visible(), false);
    });

    test(`${name}: pagehide closes and cleans timer; page restore starts closed`, () => {
        const f = fixture(source); f.show(); f.advance(10000); f.lifecycle('pagehide');
        assert.equal(f.visible(), false); assert.equal(f.pending(), 0);
        f.lifecycle('pageshow'); f.advance(30000); assert.equal(f.visible(), false);
        f.show(); f.advance(29999); assert.equal(f.visible(), true); f.advance(1); assert.equal(f.visible(), false);
    });
}
