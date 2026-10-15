(function (root) {
    'use strict';
    const config = root.UmininnConfig;
    const runtime = (root.browser || root.chrome)?.runtime;
    if (!config || !runtime || !root.UmininnMedia || !config.isPlayerUrl(root.location.href)) return;
    if (root.__umininnFrameClientInstalled) return;
    root.__umininnFrameClientInstalled = true;
    const random = new Uint8Array(24);
    root.crypto.getRandomValues(random);
    const token = Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('');
    const nativeController = root.UmininnMedia.createMediaController({ document: root.document });
    const controller = root.UmininnTwitch?.createTwitchController({
        document: root.document, location: root.location, mediaController: nativeController
    }) || nativeController;
    let disposed = false;
    let identity = null;
    let identifying = null;
    let reportTimer = null;
    let parentOrigin = null;
    let lastResult = controller.getState();
    function send(message) {
        return new Promise((resolve, reject) => {
            try {
                if (root.browser) Promise.resolve(runtime.sendMessage(message)).then(resolve, reject);
                else runtime.sendMessage(message, response => {
                    const error = runtime.lastError;
                    if (error) reject(new Error(error.message)); else resolve(response);
                });
            } catch (error) { reject(error); }
        });
    }
    function envelope(type, extra) { return { channel: config.CHANNEL, version: config.VERSION, type, ...extra }; }
    function announce() {
        if (disposed || !identity || root.parent === root) return;
        const message = envelope('frame:ready', { token, frameId: identity.frameId, documentId: identity.documentId, result: lastResult });
        // No channel/source URL is disclosed. A strict parent source/origin check is
        // required before it can use this per-document capability token.
        root.parent.postMessage(message, parentOrigin || '*');
    }
    function identify() {
        if (disposed) return Promise.resolve();
        if (identifying) return identifying;
        identifying = send(envelope('frame:identify')).then(response => {
            if (!disposed && response?.ok && Number.isInteger(response.frameId)) {
                identity = { frameId: response.frameId, documentId: response.documentId };
                announce();
            }
        }).catch(() => {}).finally(() => { identifying = null; });
        return identifying;
    }
    function report(result) {
        lastResult = result;
        if (disposed || reportTimer !== null) return;
        reportTimer = root.setTimeout(() => {
            reportTimer = null;
            if (identity) announce(); else identify();
        }, 100);
    }
    function onParentMessage(event) {
        if (disposed || event.source !== root.parent || !config.isSiteOrigin(event.origin) || !config.isEnvelope(event.data, 'frame:probe')) return;
        parentOrigin = event.origin;
        lastResult = controller.getState();
        identify();
    }
    function onCommand(message, sender, respond) {
        if (disposed || sender?.id !== runtime.id || !config.isEnvelope(message, 'frame:command') || message.token !== token) return false;
        const command = message.command;
        if (!command || !config.ACTIONS.includes(command.action)) {
            respond({ ok: false, code: 'INVALID_ACTION', message: '不支援此操作', state: controller.getState().state });
            return false;
        }
        Promise.resolve(controller.execute(command)).then(result => { lastResult = result; announce(); respond(result); }, () => {
            respond({ ok: false, code: 'CONTROL_FAILED', message: '未能控制此播放器', state: controller.getState().state });
        });
        return true;
    }
    const unsubscribe = controller.subscribe(report);
    root.addEventListener('message', onParentMessage);
    runtime.onMessage.addListener(onCommand);
    root.addEventListener('pagehide', event => {
        if (event.persisted) return;
        disposed = true;
        if (reportTimer !== null) root.clearTimeout(reportTimer);
        unsubscribe();
        controller.dispose();
        runtime.onMessage.removeListener(onCommand);
        root.removeEventListener('message', onParentMessage);
    });
    identify();
})(globalThis);
