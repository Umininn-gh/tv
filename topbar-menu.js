(function (root) {
    'use strict';

    const CONTROL_IDS = ['hideNotLiveToggle', 'channel-actions', 'logout-btn', 'toggle-all-audio',
        'global-audio-feedback', 'more-channels-btn', 'layout-bookmarks-btn', 'umininn-player-control-host'];
    const ACTIVITY = ['pointerdown', 'pointerup', 'click', 'keydown', 'keyup', 'input', 'change', 'wheel', 'touchstart', 'touchend'];
    const COMPACT_WIDTH = 768;
    const EXIT_MARGIN = 48;
    const MIN_CHANNEL_WIDTH = 128;

    function create(options = {}) {
        const win = options.window || root.window || root;
        const doc = options.document || win.document;
        const records = new Map();
        const shadowObservers = new Map();
        const commandCloseTimers = new Set();
        const listeners = [];
        let bar, container, input, strip, trigger, panel, tasksButton, tasksPanel;
        let started = false, disposed = false, compact = false, opened = false;
        let updateFrame = null, idleTimer = null, blurTimer = null, outsideObserver = null;
        let resizeObserver = null, inputObserver = null, panelObserver = null, bodyObserver = null, rootObserver = null;
        let openGeneration = 0, taskSignature = '', canvas = null, context = null;
        let panelAnchorHost = null;
        let observedContent = null;
        const originalTrigger = {};

        function on(owner, type, handler, settings) {
            owner?.addEventListener(type, handler, settings);
            listeners.push(() => owner?.removeEventListener(type, handler, settings));
        }
        function frame(callback) {
            return typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame(callback) : win.setTimeout(callback, 0);
        }
        function cancelFrame(id) {
            if (typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(id);
            else win.clearTimeout(id);
        }
        function schedule() {
            if (!started || disposed || updateFrame !== null) return;
            updateFrame = frame(() => { updateFrame = null; refresh(); });
        }
        function contentSnapshot() {
            return CONTROL_IDS.map(id => {
                const node = doc.getElementById(id);
                if (!node) return [null, ''];
                const options = node.tagName === 'SELECT' ? [...node.options].map(option =>
                    [option.value, option.label || option.textContent, option.hidden, option.disabled]) : null;
                const shadowButtons = node.shadowRoot ? [...node.shadowRoot.children].filter(child => child.tagName === 'BUTTON')
                    .map(button => [button.textContent, button.hidden, button.disabled]) : null;
                return [node, JSON.stringify([node.textContent, node.hidden, node.disabled, options, shadowButtons])];
            });
        }
        function onContentMutation() {
            const next = contentSnapshot();
            if (observedContent && next.every((entry, index) => entry[0] === observedContent[index][0] && entry[1] === observedContent[index][1])) return;
            observedContent = next;
            schedule();
        }
        function clearIdle() {
            if (idleTimer !== null) win.clearTimeout(idleTimer);
            idleTimer = null;
        }
        function armIdle() {
            clearIdle();
            if (opened) idleTimer = win.setTimeout(() => { idleTimer = null; close(true); }, 30000);
        }
        function inside(owner, node) {
            if (!owner || !node) return false;
            try {
                for (let current = node; current; current = current.parentNode || current.host || current.getRootNode?.()?.host) {
                    if (owner === current || current.nodeType && owner.contains(current)) return true;
                }
            } catch (_) { /* A WindowProxy is not a DOM node. */ }
            return false;
        }
        function eventInside(event) {
            const path = event.composedPath?.() || [event.target];
            return path.some(node => inside(panel, node) || inside(trigger, node));
        }
        function viewport() {
            const visual = win.visualViewport;
            return { top: visual?.offsetTop || 0,
                height: Math.min(win.innerHeight || 1, (visual?.height || win.innerHeight || 1) + (visual?.offsetTop || 0)) };
        }
        function position() {
            if (!started || disposed) return;
            const view = viewport();
            const bottom = Math.round(bar.getBoundingClientRect().bottom + 6);
            const top = Math.min(Math.max(view.top + 4, bottom), Math.max(view.top + 4, view.height - 48));
            panel.style.top = `${top}px`;
            panel.style.maxHeight = `${Math.max(1, view.height - top - 8)}px`;
            positionPlayerPanel();
        }
        function positionPlayerPanel() {
            const host = doc.getElementById('umininn-player-panel-host');
            if (panelAnchorHost && panelAnchorHost !== host) {
                panelAnchorHost.removeAttribute('data-topbar-menu-anchor');
                panelAnchorHost.style.removeProperty('--topbar-menu-anchor-top');
                panelAnchorHost.style.removeProperty('--topbar-menu-anchor-height');
            }
            panelAnchorHost = host || null;
            if (!host?.shadowRoot) return;
            if (!host.shadowRoot.querySelector('style[data-topbar-menu-panel-style]')) {
                const style = doc.createElement('style');
                style.setAttribute('data-topbar-menu-panel-style', '');
                style.textContent = ':host([data-topbar-menu-anchor]) #panel{top:var(--topbar-menu-anchor-top)!important;max-height:var(--topbar-menu-anchor-height)!important}';
                host.shadowRoot.appendChild(style);
            }
            const active = compact && doc.documentElement.hasAttribute('data-umininn-player-controls-open');
            host.toggleAttribute('data-topbar-menu-anchor', active);
            if (!active) {
                host.style.removeProperty('--topbar-menu-anchor-top');
                host.style.removeProperty('--topbar-menu-anchor-height');
                return;
            }
            const view = viewport();
            const top = Math.min(Math.max(view.top + 8, Math.round(trigger.getBoundingClientRect().bottom + 8)), Math.max(view.top + 8, view.height - 90));
            host.style.setProperty('--topbar-menu-anchor-top', `${top}px`);
            host.style.setProperty('--topbar-menu-anchor-height', `${Math.max(1, view.height - top - 12)}px`);
        }
        function setTasksOpen(value, focusFirst = false) {
            const next = Boolean(value && compact && opened && !tasksButton.disabled);
            tasksButton.setAttribute('aria-expanded', String(next));
            tasksPanel.hidden = !next;
            if (next && focusFirst) tasksPanel.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
        }
        function focusAfterClose(restoreFocus) {
            if (!inside(panel, doc.activeElement)) return;
            if (restoreFocus && compact && trigger.isConnected) { trigger.focus({ preventScroll: true }); return; }
            // The selected command may have opened another panel while its
            // trigger is about to become hidden. Preserve its usable focus.
            const selection = doc.getElementById('channel-selection');
            if (selection && !selection.hidden && win.getComputedStyle(selection).display !== 'none') {
                if (!selection.hasAttribute('tabindex')) selection.setAttribute('tabindex', '-1');
                selection.focus({ preventScroll: true });
            } else if (compact && trigger.isConnected) trigger.focus({ preventScroll: true });
        }
        function close(restoreFocus = false) {
            if (!started) return;
            openGeneration++;
            clearIdle();
            for (const timer of commandCloseTimers) win.clearTimeout(timer);
            commandCloseTimers.clear();
            outsideObserver?.dispose();
            outsideObserver = null;
            const wasOpen = opened;
            opened = false;
            setTasksOpen(false);
            trigger.setAttribute('aria-expanded', 'false');
            panel.removeAttribute('data-open');
            panel.hidden = true;
            if (wasOpen) focusAfterClose(restoreFocus);
        }
        function open(focusFirst = false) {
            if (!started || disposed || !compact) return;
            if (opened) { if (focusFirst) firstFocusable()?.focus({ preventScroll: true }); return; }
            opened = true;
            openGeneration++;
            panel.hidden = false;
            panel.setAttribute('data-open', 'true');
            trigger.setAttribute('aria-expanded', 'true');
            position();
            const dismiss = options.menuDismiss || root.UmininnMenuDismiss || win.UmininnMenuDismiss;
            if (dismiss?.observe) outsideObserver = dismiss.observe({ window: win, inside: [panel, trigger], onOutside: () => close(false) });
            armIdle();
            if (focusFirst) firstFocusable()?.focus({ preventScroll: true });
        }
        function firstFocusable() {
            const nodes = panel.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]');
            return [...nodes].find(node => !node.hidden && !node.closest('[hidden]') && win.getComputedStyle(node).display !== 'none');
        }
        function onTriggerClick() { if (opened) close(false); else open(false); }
        function onTriggerKey(event) {
            if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
            event.preventDefault();
            open(true);
        }
        function onKey(event) {
            if (!opened || event.defaultPrevented) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                if (!tasksPanel.hidden) {
                    setTasksOpen(false);
                    tasksButton.focus({ preventScroll: true });
                } else close(true);
            } else if (event.key === 'ArrowRight' && event.target === tasksButton) {
                event.preventDefault();
                setTasksOpen(true, true);
            } else if (event.key === 'ArrowLeft' && inside(tasksPanel, event.target)) {
                event.preventDefault();
                setTasksOpen(false);
                tasksButton.focus({ preventScroll: true });
            }
        }
        function closeAfterCommand() {
            const generation = openGeneration;
            win.queueMicrotask(() => { if (opened && generation === openGeneration) close(false); });
        }
        function isPanelCommand(event) {
            const path = event.composedPath?.() || [event.target];
            if (!path.some(node => inside(panel, node))) return false;
            if (path.includes(tasksButton) || path.some(node => inside(tasksPanel, node)) ||
                path.some(node => inside(doc.getElementById('hideNotLiveToggle'), node))) return false;
            return path.some(node => node?.tagName === 'BUTTON');
        }
        function onPanelClick(event) { if (opened && isPanelCommand(event)) closeAfterCommand(); }
        function onCommandCapture(event) {
            if (!opened || event.isTrusted !== true || !isPanelCommand(event)) return;
            // The userscript intercepts the original global-mute click at
            // document capture. A window listener sees it first, but defers
            // closing until the original synchronous click handlers finish.
            const generation = openGeneration;
            const timer = win.setTimeout(() => {
                commandCloseTimers.delete(timer);
                if (opened && generation === openGeneration) close(false);
            }, 0);
            commandCloseTimers.add(timer);
        }
        function onPanelActivity(event) { if (opened && event.isTrusted === true) armIdle(); }
        function onFocusIn(event) {
            // During a native label/shadow-button focus transfer, focusout can
            // briefly expose BODY between pointerdown and click. Closing there
            // would swallow the click. A settled focusin identifies the actual
            // destination without timers or intercepting the original command.
            if (opened && event.isTrusted === true && event.target !== doc.body &&
                event.target !== doc.documentElement && !eventInside(event)) close(false);
        }
        function onOutside(event) {
            if (opened && event.isTrusted === true && !eventInside(event)) close(false);
        }
        function onBlur() {
            if (blurTimer !== null) win.clearTimeout(blurTimer);
            blurTimer = win.setTimeout(() => {
                blurTimer = null;
                if (opened && !doc.hasFocus()) close(false);
            }, 0);
        }
        function createTasks() {
            tasksButton = doc.createElement('button');
            tasksButton.id = 'topbar-tasks-btn';
            tasksButton.type = 'button';
            tasksButton.className = 'topbar-menu-row';
            const logo = doc.createElement('img');
            const nativeTasks = doc.getElementById('channel-actions');
            const background = nativeTasks ? win.getComputedStyle(nativeTasks).backgroundImage : '';
            const source = background.match(/url\(["']?([^"')]+)["']?\)/)?.[1] || doc.querySelector('link[rel~="icon"]')?.href;
            if (source) logo.src = source;
            logo.alt = '';
            const title = doc.createElement('span');
            title.textContent = '台務';
            tasksButton.append(logo, title);
            tasksButton.setAttribute('aria-expanded', 'false');
            tasksButton.setAttribute('aria-controls', 'topbar-tasks-panel');
            tasksPanel = doc.createElement('div');
            tasksPanel.id = 'topbar-tasks-panel';
            tasksPanel.setAttribute('role', 'group');
            tasksPanel.setAttribute('aria-label', '台務選項');
            tasksPanel.hidden = true;
            on(tasksButton, 'click', () => setTasksOpen(tasksPanel.hidden));
            on(tasksPanel, 'click', event => {
                const button = event.target.closest?.('button[data-topbar-task]');
                const select = records.get('channel-actions')?.node;
                if (!button || button.disabled || !select || select.disabled) return;
                const option = [...select.options].find(item => item.value === button.getAttribute('data-topbar-task'));
                if (!option || option.disabled || option.hidden) return;
                select.value = option.value;
                select.dispatchEvent(new win.Event('change', { bubbles: true }));
                closeAfterCommand();
            });
        }
        function syncTasks() {
            const record = records.get('channel-actions');
            const select = record?.node;
            const options = select ? [...select.options].filter(option => option.value && !option.hidden) : [];
            const signature = JSON.stringify([Boolean(select?.disabled), options.map(option => [option.value, option.label || option.textContent, option.disabled])]);
            const disabled = !select || select.disabled;
            const hidden = !select || record.hidden;
            if (tasksButton.disabled !== disabled) tasksButton.disabled = disabled;
            if (tasksButton.hidden !== hidden) tasksButton.hidden = hidden;
            if ((disabled || hidden) && !tasksPanel.hidden) setTasksOpen(false);
            if (signature === taskSignature) return;
            const focused = tasksPanel.contains(doc.activeElement) ? doc.activeElement.getAttribute('data-topbar-task') : null;
            taskSignature = signature;
            tasksPanel.replaceChildren();
            for (const option of options) {
                const button = doc.createElement('button');
                button.type = 'button';
                button.textContent = option.label || option.textContent;
                button.disabled = option.disabled;
                button.setAttribute('data-topbar-task', option.value);
                tasksPanel.appendChild(button);
                if (focused === option.value && !button.disabled) button.focus({ preventScroll: true });
            }
        }
        function enhanceShadow(host) {
            const shadow = host.shadowRoot;
            if (!shadow) return;
            if (!shadow.querySelector('style[data-topbar-menu-style]')) {
                const style = doc.createElement('style');
                style.setAttribute('data-topbar-menu-style', '');
                style.textContent = ':host([data-topbar-menu-compact]){display:flex!important;height:auto!important;min-height:0!important;flex-direction:column!important;align-items:stretch!important;gap:4px!important;width:100%}:host([data-topbar-menu-compact])>button{height:auto!important;min-height:32px!important;width:100%!important;text-align:left!important;font-size:13px!important;padding:7px 10px!important;line-height:1.35!important}';
                shadow.appendChild(style);
            }
            if (!shadowObservers.has(host) && typeof win.MutationObserver === 'function') {
                const observer = new win.MutationObserver(onContentMutation);
                observer.observe(shadow, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'disabled'] });
                shadowObservers.set(host, observer);
            }
        }
        function collect() {
            for (const id of CONTROL_IDS) {
                const current = doc.getElementById(id);
                const previous = records.get(id);
                if (previous && previous.node !== current) {
                    previous.anchor.remove();
                    shadowObservers.get(previous.node)?.disconnect();
                    shadowObservers.delete(previous.node);
                    resizeObserver?.unobserve(previous.node);
                    records.delete(id);
                }
                if (!current || current.parentNode !== input && current.parentNode !== panel) continue;
                if (!records.has(id)) {
                    const anchor = doc.createComment(`topbar:${id}`);
                    if (current.parentNode === input) input.insertBefore(anchor, current);
                    else input.appendChild(anchor);
                    records.set(id, { node: current, anchor, width: 0, hidden: current.hidden,
                        hadRowClass: current.classList.contains('topbar-menu-row') });
                    resizeObserver?.observe(current);
                }
                if (id === 'umininn-player-control-host') enhanceShadow(current);
            }
        }
        function textWidth(node, text) {
            if (!context) {
                canvas = canvas || doc.createElement('canvas');
                context = canvas.getContext('2d');
            }
            const style = win.getComputedStyle(node);
            if (context) context.font = style.font || `${style.fontSize} ${style.fontFamily}`;
            return (context?.measureText(text || '').width || String(text || '').length * 8) +
                (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0) +
                (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
        }
        function controlWidth(record) {
            const node = record.node;
            if (!compact) {
                const width = node.getBoundingClientRect().width;
                if (width > 0) record.width = width;
                return width;
            }
            if (node.id === 'channel-actions') return record.hidden ? 0 : record.width || 165;
            if (node.hidden) return 0;
            if (node.id === 'umininn-player-control-host' && node.shadowRoot) {
                const buttons = [...node.shadowRoot.children].filter(item => item.tagName === 'BUTTON' && !item.hidden);
                // The compact stylesheet stretches these buttons. Measure their
                // text rather than treating the dropdown's width as toolbar width.
                return buttons.reduce((sum, button) => sum + textWidth(button, button.textContent), 0) + Math.max(0, buttons.length - 1) * 4;
            }
            return record.width || textWidth(node, node.textContent) + (node.id === 'hideNotLiveToggle' ? 36 : 0);
        }
        function requiredWidth() {
            const widths = [...records.values()].map(controlWidth).filter(value => value > 0);
            const style = win.getComputedStyle(input);
            const gap = parseFloat(style.columnGap || style.gap) || 0;
            return widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gap +
                (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0) + MIN_CHANNEL_WIDTH +
                (parseFloat(win.getComputedStyle(container).columnGap) || 0);
        }
        function arrangeCompact() {
            const ordered = [];
            for (const id of CONTROL_IDS) {
                const record = records.get(id);
                if (!record) continue;
                record.node.classList.add('topbar-menu-row');
                if (id === 'channel-actions') {
                    if (!record.node.hidden) record.node.hidden = true;
                    ordered.push(tasksButton, tasksPanel);
                }
                if (id === 'umininn-player-control-host') record.node.setAttribute('data-topbar-menu-compact', '');
                ordered.push(record.node);
            }
            let cursor = panel.firstChild;
            for (const node of ordered) {
                if (node === cursor) cursor = cursor.nextSibling;
                else panel.insertBefore(node, cursor);
            }
        }
        function restoreControls() {
            for (const record of records.values()) {
                if (record.anchor.parentNode === input) input.insertBefore(record.node, record.anchor.nextSibling);
                if (record.node.id === 'channel-actions') record.node.hidden = record.hidden;
                if (!record.hadRowClass) record.node.classList.remove('topbar-menu-row');
                record.node.removeAttribute('data-topbar-menu-compact');
            }
        }
        function deepActiveElement() {
            let active = doc.activeElement;
            while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
            return active;
        }
        function focusAfterTransition(next, previousFocus) {
            const record = [...records.values()].find(value => inside(value.node, previousFocus));
            const fromTask = inside(tasksPanel, previousFocus) || inside(tasksButton, previousFocus);
            if (!record && !fromTask && previousFocus !== trigger) return;
            if (next) { trigger.focus({ preventScroll: true }); return; }
            let destination = fromTask ? records.get('channel-actions')?.node : previousFocus;
            if (!destination?.isConnected || destination === trigger || destination.closest?.('[hidden]') ||
                win.getComputedStyle(destination).display === 'none' || destination.disabled) {
                destination = [...records.values()].map(value => value.node).find(node =>
                    node.matches('button,select') && !node.hidden && !node.disabled && win.getComputedStyle(node).display !== 'none');
            }
            destination?.focus?.({ preventScroll: true });
        }
        function refresh() {
            if (!started || disposed) return false;
            if (!bar.isConnected || !input.isConnected || !trigger.isConnected || !panel.isConnected) { dispose(); return false; }
            collect();
            syncTasks();
            const needed = requiredWidth();
            const width = win.innerWidth || doc.documentElement.clientWidth;
            const available = container.clientWidth || container.getBoundingClientRect().width;
            const next = width <= COMPACT_WIDTH || available < needed + (compact ? EXIT_MARGIN : 0);
            if (next !== compact) {
                const previousFocus = deepActiveElement();
                close(false);
                compact = next;
                bar.setAttribute('data-options-compact', String(compact));
                trigger.hidden = !compact;
                if (compact) arrangeCompact();
                else restoreControls();
                focusAfterTransition(compact, previousFocus);
            } else if (compact) arrangeCompact();
            position();
            observedContent = contentSnapshot();
            return compact;
        }
        function start() {
            if (disposed) return false;
            if (started) { refresh(); return true; }
            if (!doc) return false;
            bar = doc.getElementById('top-bar');
            input = doc.getElementById('input-container');
            strip = doc.getElementById('channel-strip');
            trigger = doc.getElementById('topbar-options-btn');
            panel = doc.getElementById('topbar-options-panel');
            container = bar?.querySelector('.top-container');
            if (!bar || !container || !input || !strip || !trigger || !panel) return false;
            started = true;
            for (const name of ['hidden', 'aria-expanded', 'aria-controls']) originalTrigger[name] = trigger.getAttribute(name);
            if (panel.parentNode !== doc.body) doc.body.appendChild(panel);
            trigger.setAttribute('aria-controls', panel.id);
            trigger.setAttribute('aria-expanded', 'false');
            panel.hidden = true;
            createTasks();
            on(trigger, 'click', onTriggerClick);
            on(trigger, 'keydown', onTriggerKey);
            on(doc, 'keydown', onKey);
            on(panel, 'click', onPanelClick);
            on(win, 'click', onCommandCapture, true);
            on(doc, 'focusin', onFocusIn, true);
            for (const type of ACTIVITY) on(panel, type, onPanelActivity, { capture: true, passive: true });
            // This covers non-frame documents even if the shared dismiss helper
            // is temporarily unavailable during incremental script loading.
            on(doc, 'pointerdown', onOutside, { capture: true, passive: true });
            on(doc, 'wheel', onOutside, { capture: true, passive: true });
            on(win, 'blur', onBlur, true);
            on(win, 'resize', schedule, { passive: true });
            on(win.visualViewport, 'resize', schedule, { passive: true });
            on(win.visualViewport, 'scroll', schedule, { passive: true });
            on(win, 'pagehide', () => close(false));
            on(win, 'pageshow', schedule);
            if (typeof win.ResizeObserver === 'function') {
                resizeObserver = new win.ResizeObserver(schedule);
                for (const node of [bar, container, input, strip]) resizeObserver.observe(node);
            }
            if (typeof win.MutationObserver === 'function') {
                inputObserver = new win.MutationObserver(onContentMutation);
                panelObserver = new win.MutationObserver(onContentMutation);
                const settings = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'label'] };
                inputObserver.observe(input, settings);
                panelObserver.observe(panel, settings);
                bodyObserver = new win.MutationObserver(schedule);
                bodyObserver.observe(doc.body, { childList: true });
                rootObserver = new win.MutationObserver(positionPlayerPanel);
                rootObserver.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-umininn-player-controls-open'] });
            }
            refresh();
            return true;
        }
        function dispose() {
            if (disposed) return;
            if (started) close(false);
            disposed = true;
            if (updateFrame !== null) cancelFrame(updateFrame);
            if (blurTimer !== null) win.clearTimeout(blurTimer);
            updateFrame = blurTimer = null;
            for (const observer of [resizeObserver, inputObserver, panelObserver, bodyObserver, rootObserver]) observer?.disconnect();
            for (const observer of shadowObservers.values()) observer.disconnect();
            shadowObservers.clear();
            for (const cleanup of listeners.splice(0)) cleanup();
            if (started) {
                restoreControls();
                for (const record of records.values()) record.anchor.remove();
                records.clear();
                tasksButton.remove();
                tasksPanel.remove();
                bar.removeAttribute('data-options-compact');
                for (const [name, value] of Object.entries(originalTrigger)) {
                    if (value === null) trigger.removeAttribute(name);
                    else trigger.setAttribute(name, value);
                }
                panelAnchorHost?.removeAttribute('data-topbar-menu-anchor');
                panelAnchorHost?.style.removeProperty('--topbar-menu-anchor-top');
                panelAnchorHost?.style.removeProperty('--topbar-menu-anchor-height');
            }
            started = false;
        }
        return { start, refresh, dispose, open, close,
            get compact() { return compact; }, get opened() { return opened; } };
    }

    const api = { create };
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.UmininnTopbarMenu = api;
})(typeof globalThis === 'object' ? globalThis : this);
