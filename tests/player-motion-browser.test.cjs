'use strict';

// Real Web Animations, native media loading and routed cross-origin documents.
// Platform SDKs and the public network are deliberately outside this fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const enabled = process.env.UMININN_BROWSER_TESTS === '1';
const engine = process.env.UMININN_BROWSER_ENGINE || 'chromium';
const root = process.env.UMININN_MOTION_ASSET_ROOT || path.resolve(__dirname, '..');
const sourceFile = fs.existsSync(path.join(root, 'site/assets/js/player-motion.js'))
    ? path.join(root, 'site/assets/js/player-motion.js') : path.join(root, 'player-motion.js');
const origin = 'https://motion-fixture.invalid', frameOrigin = 'https://motion-frame.invalid';
const browserCase = { skip: !enabled, timeout: 30000 };
let browser, source;

function wav() {
    const rate = 8000, data = Buffer.alloc(rate * 2 * 2), result = Buffer.alloc(44 + data.length);
    result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8);
    result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
    result.writeUInt32LE(rate, 24); result.writeUInt32LE(rate * 2, 28);
    result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write('data', 36);
    result.writeUInt32LE(data.length, 40); data.copy(result, 44); return result;
}
test.before(async () => {
    if (!enabled) return;
    let playwright;
    try { playwright = require('playwright'); }
    catch (_) { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
    source = fs.readFileSync(sourceFile, 'utf8');
    const executablePath = process.env.UMININN_BROWSER_EXECUTABLE;
    browser = await playwright[engine].launch({ headless: true, ...(executablePath ? { executablePath } : {}),
        ...(engine === 'firefox' ? { firefoxUserPrefs: { 'media.autoplay.default': 0 } } : { args: ['--autoplay-policy=no-user-gesture-required'] }) });
    console.log(`Player motion fixture: ${engine} ${browser.version()} (real WAAPI/media; isolated network).`);
});
test.after(async () => { await browser?.close(); });

async function fixture(t, options = {}) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 850 }, serviceWorkers: 'block', ...options });
    t.after(() => context.close());
    const gates = new Map(), requested = new Set(), navigations = new Map(), errors = [];
    const hold = routePath => {
        let release; const promise = new Promise(resolve => { release = resolve; });
        gates.set(routePath, promise); return release;
    };
    await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        requested.add(url.pathname);
        if (request.isNavigationRequest()) navigations.set(url.href, (navigations.get(url.href) || 0) + 1);
        if (gates.has(url.pathname)) await gates.get(url.pathname);
        if (url.origin === origin && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><style>
            body{margin:0;background:#111;color:#fff;font:14px system-ui}#wrapper{position:relative;margin:30px;width:900px;height:580px}
            #pane{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:12px;width:900px;height:550px;overflow:hidden}
            #pane>*{box-sizing:border-box;width:100%;height:100%;min-width:0;min-height:0;border:0;background:#253b4b;border-radius:8px;object-fit:contain}
            #pane>div iframe{width:100%;height:100%;border:0}.overlay{position:absolute;inset:0;pointer-events:none}.overlay>div{position:absolute;box-sizing:border-box}
            #player-position-editor{pointer-events:none}#outside{position:absolute;top:700px}
            </style></head><body><div id="wrapper"><div id="pane"></div>
            <div class="overlay" id="player-window-controls"></div><div class="overlay" id="player-name-overlay"></div>
            <div class="overlay" id="player-position-editor"></div></div><button id="outside">Outside</button></body></html>` });
        if (url.origin === frameOrigin) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="margin:0;background:#394a60;color:white">Loaded foreign player<button>Play</button></body>' });
        if (url.origin === origin && url.pathname.endsWith('.wav')) return route.fulfill({ contentType: 'audio/wav', body: wav() });
        return route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(7000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/', { waitUntil: 'load' });
    await page.addScriptTag({ content: source });
    await page.evaluate(({ frameOrigin }) => {
        window.motionCalls = []; window.items = new Map(); window.allowMotion = true; window.settled = 0;
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (keyframes, options) {
            const animation = animate.call(this, keyframes, options);
            motionCalls.push({ id: this.id, element: this, animation,
                frames: animation.effect.getKeyframes(), timing: animation.effect.getTiming(),
                initialRect: (() => { const r = this.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })() });
            return animation;
        };
        window.pane = document.getElementById('pane');
        window.rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
        window.addItem = (key, kind = 'div', settings = {}) => {
            const element = document.createElement(kind === 'twitch' ? 'div' : kind);
            element.id = key; element.dataset.channelKey = key; element.dataset.channelName = key;
            const index = settings.index ?? items.size;
            element.style.gridArea = `${Math.floor(index / 3) + 1} / ${index % 3 + 1} / span 1 / span 1`;
            let resource = null;
            if (kind === 'video') {
                element.muted = true; element.volume = .37; element.loop = true; element.preload = 'auto';
                if (settings.src) element.src = settings.src;
                resource = { video: element, element, disposed: false, failed: false };
            } else if (kind === 'iframe') {
                element.loading = 'lazy'; element.allow = 'autoplay'; element.src = settings.src || frameOrigin + '/normal';
            } else if (kind === 'twitch') {
                element.className = 'twitch-wrapper'; element.dataset.streamPlaybackState = settings.state || 'loading';
                resource = { element, twitch: {}, disposed: false, failed: false };
            }
            const item = { key, element, channel: { name: key, id: key, platform: kind === 'twitch' ? 'twitch' : kind === 'iframe' ? 'at' : 'm3u8' }, resource };
            items.set(key, item); pane.appendChild(element); return item;
        };
        window.projectOverlays = () => {
            for (const [id, cls] of [['player-window-controls', 'player-window-cell'], ['player-name-overlay', 'player-name-cell'], ['player-position-editor', 'player-position-cell']]) {
                const layer = document.getElementById(id);
                for (const item of items.values()) {
                    let cell = layer.querySelector(`[data-player-key="${item.key}"]`);
                    if (!cell) { cell = document.createElement('div'); cell.id = id + '-' + item.key; cell.className = cls; cell.dataset.playerKey = item.key; layer.appendChild(cell); }
                    cell.style.cssText = `left:${item.element.offsetLeft}px;top:${item.element.offsetTop}px;width:${item.element.offsetWidth}px;height:${item.element.offsetHeight}px`;
                }
            }
        };
        window.motion = PlayerMotion.create({ pane, getItems: () => [...items.values()], canAnimate: () => allowMotion,
            onSettled: () => { settled++; } });
        window.swap = (a, b) => motion.run(() => {
            const first = items.get(a).element, second = items.get(b).element;
            const area = first.style.gridArea; first.style.gridArea = second.style.gridArea; second.style.gridArea = area; projectOverlays();
        });
        window.calls = id => motionCalls.filter(call => call.id === id).map(call => ({ id: call.id, frames: call.frames, timing: call.timing }));
        window.finishMotion = () => { for (const animation of document.getAnimations()) { try { animation.finish(); } catch (_) {} } };
        addItem('a'); addItem('b'); addItem('c'); projectOverlays(); motion.refresh();
    }, { frameOrigin });
    await frames(page);
    t.after(async () => { assert.deepEqual(errors, [], 'motion and cleanup must not throw uncaught page errors'); });
    return { page, context, hold, requested, navigations };
}
async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function settle(page) { await page.evaluate(() => finishMotion()); await frames(page); }
function near(a, b, label, tolerance = 1.5) { assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} != ${b}`); }

test('FLIP uses the old visible rectangle and final committed grid; companion overlays move with the same key', browserCase, async t => {
    const { page } = await fixture(t);
    const old = await page.evaluate(() => rect(items.get('a').element));
    await page.evaluate(() => swap('a', 'b')); await frames(page);
    const sample = await page.evaluate(() => {
        const element = items.get('a').element;
        const own = element.getAnimations();
        for (const animation of own) { animation.pause(); animation.currentTime = 0; }
        return { visible: rect(element), final: { x: 30 + element.offsetLeft, y: 30 + element.offsetTop },
            own: calls('a'), overlays: ['player-window-controls', 'player-name-overlay', 'player-position-editor'].map(id => calls(id + '-a')) };
    });
    assert.equal(sample.own.length, 1); assert.equal(sample.own[0].timing.duration, 240);
    near(sample.visible.x, old.x, 'first animation frame x'); near(sample.visible.y, old.y, 'first animation frame y');
    assert.ok(Math.abs(sample.final.x - old.x) > 100, 'the real grid has already reached the destination');
    for (const call of sample.overlays) assert.equal(call.length, 1, 'keyed overlays share the motion');
    await settle(page);
    const end = await page.evaluate(() => ({ rect: rect(items.get('a').element), count: items.get('a').element.getAnimations().length }));
    near(end.rect.x, sample.final.x, 'final x'); assert.equal(end.count, 0);
});

test('no-op projection does not create animations or cancel an animation already running', browserCase, async t => {
    const { page } = await fixture(t);
    await page.evaluate(() => motion.run(() => projectOverlays())); await frames(page);
    assert.equal(await page.evaluate(() => motionCalls.length), 0);
    await page.evaluate(() => swap('a', 'b')); await frames(page);
    const result = await page.evaluate(() => {
        const current = items.get('a').element.getAnimations()[0], count = motionCalls.length;
        motion.run(() => projectOverlays());
        return { count, after: motionCalls.length, same: items.get('a').element.getAnimations().includes(current), state: current.playState };
    });
    assert.equal(result.after, result.count); assert.equal(result.same, true); assert.notEqual(result.state, 'idle');
});

test('a rapid second move retargets from the visible intermediate rectangle without queued hops', browserCase, async t => {
    const { page } = await fixture(t);
    await page.evaluate(() => swap('a', 'b')); await frames(page);
    const before = await page.evaluate(() => { const visible = rect(items.get('a').element); swap('a', 'c'); return visible; });
    await frames(page);
    const result = await page.evaluate(() => {
        const element = items.get('a').element, animations = element.getAnimations();
        for (const animation of animations) { animation.pause(); animation.currentTime = 0; }
        return { rect: rect(element), active: animations.length, calls: calls('a').length };
    });
    assert.equal(result.active, 1); assert.equal(result.calls, 2);
    near(result.rect.x, before.x, 'retarget starts at current x'); near(result.rect.y, before.y, 'retarget starts at current y');
    await settle(page);
});

test('new native media stays full-size while loading and grows once only after decoded data is available', browserCase, async t => {
    const f = await fixture(t), release = f.hold('/delayed.wav');
    await f.page.evaluate(() => { const item = addItem('native', 'video', { src: '/delayed.wav', index: 3 }); motion.enter(item); });
    await f.page.waitForFunction(() => document.getElementById('native').networkState === 2);
    const waiting = await f.page.evaluate(() => { const el = items.get('native').element, style = getComputedStyle(el); return { rect: rect(el), display: style.display, visibility: style.visibility, calls: calls('native').length, ready: el.readyState }; });
    assert.equal(waiting.calls, 0); assert.equal(waiting.ready, 0); assert.ok(waiting.rect.width > 200);
    assert.notEqual(waiting.display, 'none'); assert.notEqual(waiting.visibility, 'hidden');
    release(); await f.page.waitForFunction(() => document.getElementById('native').readyState >= 2 && calls('native').length === 1);
    const call = await f.page.evaluate(() => calls('native')[0]); assert.equal(call.timing.duration, 220);
    await settle(f.page); await f.page.evaluate(() => { const el = items.get('native').element; el.dispatchEvent(new Event('loadeddata')); el.dispatchEvent(new Event('playing')); motion.refresh(); });
    await frames(f.page); assert.equal(await f.page.evaluate(() => calls('native').length), 1);
});

test('late readiness from a removed or replaced instance cannot animate the new same-key player', browserCase, async t => {
    const f = await fixture(t), release = f.hold('/old.wav');
    await f.page.evaluate(() => {
        const old = addItem('retry', 'video', { src: '/old.wav', index: 3 }); window.oldRetry = old;
        motion.enter(old); old.element.remove();
        const next = addItem('retry', 'video', { src: '/new.wav', index: 3 }); next.element.id = 'retry-current'; motion.enter(next); motion.refresh();
    });
    await f.page.waitForFunction(() => document.getElementById('retry-current').readyState >= 2);
    release(); await frames(f.page); await settle(f.page);
    assert.equal(await f.page.evaluate(() => calls('retry').length), 0, 'stale old element never enters');
    assert.equal(await f.page.evaluate(() => calls('retry-current').length), 1, 'the current instance enters only once');
});

test('a lazy cross-origin player is measurable while waiting and iframe document readiness is handled once', browserCase, async t => {
    const f = await fixture(t), release = f.hold('/held-frame');
    await f.page.evaluate(frameOrigin => { const item = addItem('foreign', 'iframe', { src: frameOrigin + '/held-frame', index: 3 }); motion.enter(item); }, frameOrigin);
    const waiting = await f.page.evaluate(() => ({ rect: rect(items.get('foreign').element), calls: calls('foreign').length, hidden: items.get('foreign').element.hidden }));
    assert.ok(waiting.rect.width > 200); assert.equal(waiting.calls, 0); assert.equal(waiting.hidden, false);
    release(); await f.page.waitForFunction(() => calls('foreign').length === 1); await settle(f.page);
    await f.page.evaluate(() => { items.get('foreign').element.dispatchEvent(new Event('load')); motion.refresh(); }); await frames(f.page);
    assert.equal(await f.page.evaluate(() => calls('foreign').length), 1);
    assert.equal(f.navigations.get(frameOrigin + '/held-frame'), 1, 'animation never reloads a foreign frame');
});

test('Twitch waits for video output, while a paused or blocked player remains usable without a hidden waiting loop', browserCase, async t => {
    const { page } = await fixture(t);
    await page.evaluate(() => { const item = addItem('twitch', 'twitch', { index: 3 }); motion.enter(item); });
    await frames(page); assert.equal(await page.evaluate(() => calls('twitch').length), 0, 'loading/SDK readiness is not video output');
    await page.evaluate(() => { items.get('twitch').element.dataset.streamPlaybackState = 'playing'; });
    await page.waitForFunction(() => calls('twitch').length === 1); await settle(page);
    await page.evaluate(() => { const item = addItem('blocked', 'twitch', { index: 4, state: 'blocked' }); motion.enter(item); });
    await frames(page);
    const blocked = await page.evaluate(() => { const el = items.get('blocked').element; return { rect: rect(el), hidden: el.hidden, visibility: getComputedStyle(el).visibility }; });
    assert.ok(blocked.rect.width > 200); assert.equal(blocked.hidden, false); assert.notEqual(blocked.visibility, 'hidden');
});

test('YouTube uses SDK readiness and notices an iframe replaced inside its stable wrapper', browserCase, async t => {
    const { page } = await fixture(t);
    await page.evaluate(() => {
        const item = addItem('youtube', 'div', { index: 3 });
        item.channel.platform = 'youtube'; item.resource = { element: item.element, youtube: {} };
        const frame = document.createElement('iframe'); frame.dataset.embedAudioState = 'loading'; item.element.appendChild(frame);
        motion.enter(item);
    });
    await frames(page); assert.equal(await page.evaluate(() => calls('youtube').length), 0);
    await page.evaluate(() => {
        const next = document.createElement('iframe'); next.dataset.embedAudioState = 'ready';
        items.get('youtube').element.querySelector('iframe').replaceWith(next);
    });
    await page.waitForFunction(() => calls('youtube').length === 1); await settle(page);
    assert.equal(await page.evaluate(() => calls('youtube').length), 1);
});

test('bare Twitch and YouTube fallbacks use the actual iframe document load rather than an absent SDK signal', browserCase, async t => {
    const f = await fixture(t);
    for (const [index, platform] of ['twitch', 'youtube'].entries()) {
        const route = '/fallback-' + platform, release = f.hold(route);
        await f.page.evaluate(({ platform, frameOrigin, route, index }) => {
            const item = addItem('fallback-' + platform, 'iframe', { src: frameOrigin + route, index: index + 3 });
            item.channel.platform = platform; motion.enter(item);
        }, { platform, frameOrigin, route, index });
        await frames(f.page); assert.equal(await f.page.evaluate(id => calls(id).length, 'fallback-' + platform), 0);
        release(); await f.page.waitForFunction(id => calls(id).length === 1, 'fallback-' + platform); await settle(f.page);
    }
});

test('a Twitch SDK failure binds the later fallback iframe without waiting for the expired SDK', browserCase, async t => {
    const f = await fixture(t), release = f.hold('/twitch-sdk-fallback');
    await f.page.evaluate(() => { const item = addItem('sdk-fallback', 'twitch', { index: 3 }); motion.enter(item); });
    await f.page.evaluate(frameOrigin => {
        const el = items.get('sdk-fallback').element; el.dataset.streamQualityMode = 'platform-auto';
        const frame = document.createElement('iframe'); frame.src = frameOrigin + '/twitch-sdk-fallback'; el.appendChild(frame);
    }, frameOrigin);
    await frames(f.page); assert.equal(await f.page.evaluate(() => calls('sdk-fallback').length), 0);
    release(); await f.page.waitForFunction(() => calls('sdk-fallback').length === 1); await settle(f.page);
});

test('loading readiness has a finite expiry; late events cannot replay an expired enter animation', browserCase, async t => {
    const { page } = await fixture(t);
    await page.clock.install();
    await page.evaluate(() => { const item = addItem('never-ready', 'video', { index: 3 }); motion.enter(item); });
    await page.clock.fastForward(16000);
    await page.evaluate(() => { const item = items.get('never-ready'); item.element.src = '/late.wav'; });
    await page.waitForFunction(() => items.get('never-ready').element.readyState >= 2);
    assert.equal(await page.evaluate(() => calls('never-ready').length), 0);
    assert.equal(await page.evaluate(() => items.get('never-ready').element.hidden), false);
});

test('exit uses bounded inert visual ghosts and never keeps playable iframe or video copies', browserCase, async t => {
    const { page } = await fixture(t);
    const before = await page.evaluate(() => rect(items.get('a').element));
    await page.evaluate(() => { const item = items.get('a'); motion.leave(item); items.delete('a'); item.element.remove(); });
    const ghost = await page.evaluate(() => {
        const candidates = [...document.querySelectorAll('[data-player-motion-ghost]')];
        return { count: candidates.length, live: candidates.reduce((sum, el) => sum + el.querySelectorAll('iframe,video,audio').length, 0),
            visible: candidates[0] && motionCalls.find(call => call.element === candidates[0])?.initialRect, pointer: candidates[0] && getComputedStyle(candidates[0]).pointerEvents,
            original: document.getElementById('a') !== null };
    });
    assert.equal(ghost.count, 1); assert.equal(ghost.live, 0); assert.equal(ghost.original, false);
    assert.equal(ghost.pointer, 'none'); near(ghost.visible.x, before.x, 'exit x', 4); near(ghost.visible.y, before.y, 'exit y', 4);
    await page.evaluate(() => { for (let i = 0; i < 20; i++) { const item = addItem('remove-' + i, 'div', { index: i % 6 }); motion.leave(item); items.delete(item.key); item.element.remove(); } });
    const ghostCount = await page.locator('[data-player-motion-ghost]').count();
    assert.ok(ghostCount >= 20, 'each removed tile gets a lightweight shrinking visual');
    assert.ok(ghostCount <= 64, 'large bookmark replacement has a finite ghost budget');
    assert.equal(await page.locator('[data-player-motion-ghost] iframe,[data-player-motion-ghost] video,[data-player-motion-ghost] audio').count(), 0);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('canvas[data-player-motion-ghost],[data-player-motion-ghost] canvas')].every(canvas => canvas.width <= 640 && canvas.height <= 360)), true);
    assert.ok(await page.locator('canvas[data-player-motion-ghost],[data-player-motion-ghost] canvas').count() <= 8, 'pixel snapshots have a separate bounded budget');
    await settle(page); assert.equal(await page.locator('[data-player-motion-ghost]').count(), 0);
});

test('decoded video produces a bounded nonempty still frame; snapshot failure falls back to a shrinking label', browserCase, async t => {
    const { page } = await fixture(t);
    const result = await page.evaluate(async () => {
        const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
        const context = canvas.getContext('2d'); context.fillStyle = '#e53040'; context.fillRect(0, 0, canvas.width, canvas.height);
        const stream = canvas.captureStream(30);
        const drawing = setInterval(() => context.fillRect(0, 0, canvas.width, canvas.height), 16);
        const presented = video => new Promise(resolve => video.requestVideoFrameCallback(resolve));
        try {
            const first = addItem('decoded', 'video', { index: 3 }); first.element.srcObject = stream;
            await first.element.play(); await presented(first.element);
            const decoded = first.element.videoWidth > 0 && first.element.videoHeight > 0;
            motion.leave(first); first.element.pause(); first.element.remove(); items.delete(first.key);
            const ghost = document.querySelector('canvas[data-player-motion-ghost]');
            const rgba = ghost && Array.from(ghost.getContext('2d').getImageData(Math.floor(ghost.width / 2), Math.floor(ghost.height / 2), 1, 1).data);
            const snapshot = ghost && { width: ghost.width, height: ghost.height, rgba };
            const second = addItem('snapshot-denied', 'video', { index: 4 }); second.element.srcObject = stream;
            await second.element.play(); await presented(second.element);
            const original = HTMLCanvasElement.prototype.getContext;
            try { HTMLCanvasElement.prototype.getContext = () => { throw new Error('Controlled snapshot failure'); }; motion.leave(second); }
            finally { HTMLCanvasElement.prototype.getContext = original; second.element.pause(); second.element.remove(); items.delete(second.key); }
            const label = [...document.querySelectorAll('div[data-player-motion-ghost]')].find(el => el.textContent === 'snapshot-denied');
            return { decoded, snapshot, fallback: Boolean(label), fallbackAnimated: Boolean(label?.getAnimations().length), mediaCopies: document.querySelectorAll('[data-player-motion-ghost] video,[data-player-motion-ghost] iframe').length };
        } finally { clearInterval(drawing); stream.getTracks().forEach(track => track.stop()); }
    });
    assert.equal(result.decoded, true); assert.ok(result.snapshot);
    assert.ok(result.snapshot.width > 0 && result.snapshot.height > 0 && result.snapshot.width <= 640 && result.snapshot.height <= 360);
    assert.ok(result.snapshot.rgba[0] > 100 && result.snapshot.rgba[3] === 255, 'snapshot contains the decoded red video frame: ' + JSON.stringify(result));
    assert.equal(result.fallback, true); assert.equal(result.fallbackAnimated, true); assert.equal(result.mediaCopies, 0);
    await settle(page);
});

test('reduced motion cancels active motion immediately and applies later layouts without animations', browserCase, async t => {
    const { page } = await fixture(t);
    await page.evaluate(() => swap('a', 'b')); await frames(page);
    assert.ok(await page.evaluate(() => document.getAnimations().length) > 0);
    await page.emulateMedia({ reducedMotion: 'reduce' }); await frames(page);
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
    const count = await page.evaluate(() => motionCalls.length);
    await page.evaluate(() => { swap('a', 'c'); const item = addItem('instant', 'div', { index: 3 }); motion.enter(item); motion.leave(item); item.element.remove(); items.delete(item.key); });
    await frames(page); assert.equal(await page.evaluate(() => motionCalls.length), count);
    assert.equal(await page.locator('[data-player-motion-ghost]').count(), 0);
});

test('zero-size panes and gesture suspension commit layout without NaN effects or deferred replays', browserCase, async t => {
    const { page } = await fixture(t);
    await page.evaluate(() => { pane.style.display = 'none'; swap('a', 'b'); }); await frames(page);
    assert.equal(await page.evaluate(() => motionCalls.length), 0);
    await page.evaluate(() => { pane.style.display = 'grid'; motion.refresh(); allowMotion = false; swap('a', 'c'); }); await frames(page);
    assert.equal(await page.evaluate(() => motionCalls.length), 0);
    await page.evaluate(() => { allowMotion = true; motion.refresh(); }); await frames(page);
    assert.equal(await page.evaluate(() => motionCalls.length), 0, 'resuming does not replay stale motion');
    await page.evaluate(() => swap('a', 'b')); await frames(page);
    assert.ok(await page.evaluate(() => motionCalls.length) > 0);
    assert.equal(await page.evaluate(() => motionCalls.some(call => JSON.stringify(call.frames).includes('NaN'))), false);
});

test('page lifecycle and fullscreen cancel effects; destroyed controllers cannot animate or retain ghosts', browserCase, async t => {
    const { page } = await fixture(t);
    await page.evaluate(() => swap('a', 'b')); await frames(page);
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))); await frames(page);
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
    const count = await page.evaluate(() => motionCalls.length);
    await page.evaluate(() => swap('a', 'c')); await frames(page);
    assert.equal(await page.evaluate(() => motionCalls.length), count, 'hidden lifecycle cannot restart effects');
    await page.evaluate(() => { dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => pane }); document.dispatchEvent(new Event('fullscreenchange')); swap('a', 'b'); }); await frames(page);
    assert.equal(await page.evaluate(() => motionCalls.length), count, 'fullscreen does not animate embedded layout');
    await page.evaluate(() => { delete document.fullscreenElement; document.dispatchEvent(new Event('fullscreenchange')); motion.destroy(); swap('a', 'c'); const item = addItem('retired'); motion.enter(item); motion.leave(item); });
    await frames(page); assert.equal(await page.evaluate(() => motionCalls.length), count);
    assert.equal(await page.locator('[data-player-motion-ghost]').count(), 0);
});

test('entering fullscreen during an active move clears every player and overlay effect immediately', browserCase, async t => {
    const { page } = await fixture(t);
    await page.evaluate(() => swap('a', 'b')); await frames(page);
    assert.ok(await page.evaluate(() => document.getAnimations().length) > 0);
    await page.evaluate(() => {
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => pane });
        document.dispatchEvent(new Event('fullscreenchange'));
    });
    await frames(page);
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
    assert.equal(await page.locator('[data-player-motion]').count(), 0);
});

test('a trusted pointerdown cancels moving geometry so the held gesture targets the committed cells', browserCase, async t => {
    const { page } = await fixture(t);
    await page.evaluate(() => swap('a', 'b')); await frames(page);
    assert.ok(await page.evaluate(() => document.getAnimations().length) > 0);
    await page.mouse.move(200, 150); await page.mouse.down();
    await frames(page);
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
    await page.mouse.up(); await frames(page);
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0, 'release does not restart an old route');
});

test('moving retained real media and foreign players changes no sources, mute, volume or playback intent', browserCase, async t => {
    const f = await fixture(t);
    await f.page.evaluate(frameOrigin => {
        const native = addItem('playing', 'video', { src: '/normal.wav', index: 3 });
        const foreign = addItem('stable-frame', 'iframe', { src: frameOrigin + '/stable', index: 4 });
        window.savedNative = native.element; window.savedFrame = foreign.element;
    }, frameOrigin);
    await f.page.waitForFunction(() => savedNative.readyState >= 2 && document.getElementById('stable-frame').contentWindow);
    await f.page.evaluate(async () => { await savedNative.play(); savedNative.muted = false; savedNative.volume = .37; window.savedWindow = savedFrame.contentWindow; window.startTime = savedNative.currentTime; });
    await f.page.evaluate(() => { swap('playing', 'a'); }); await frames(f.page); await settle(f.page);
    const result = await f.page.evaluate(() => ({ videoSame: items.get('playing').element === savedNative,
        frameSame: items.get('stable-frame').element === savedFrame && savedFrame.contentWindow === savedWindow,
        paused: savedNative.paused, muted: savedNative.muted, volume: savedNative.volume,
        nativeSource: savedNative.getAttribute('src'), frameSource: savedFrame.getAttribute('src'), progressed: savedNative.currentTime >= startTime }));
    assert.equal(result.videoSame, true); assert.equal(result.frameSame, true); assert.equal(result.paused, false);
    assert.equal(result.muted, false); assert.equal(result.volume, .37); assert.equal(result.progressed, true);
    assert.equal(result.nativeSource, '/normal.wav'); assert.equal(result.frameSource, frameOrigin + '/stable');
    assert.equal(f.navigations.get(frameOrigin + '/stable'), 1);
});
