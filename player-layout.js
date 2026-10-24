/* Fit every player inside the available pane without touching its media. */
(function (root) {
    'use strict';

    const ASPECT = 16 / 9;
    const SWITCH_GAIN = 0.06;
    const RESIZE_DELAY = 180;
    const ASPECT_RESIZE_BAND = 0.15;

    // Compare the rendered cells by identity. Calculation scores, object order
    // and other bookkeeping do not make an otherwise identical grid change.
    function compare(previous, next) {
        const before = new Map((previous?.items || []).map(item => [item.key, item]));
        const after = new Map((next?.items || []).map(item => [item.key, item]));
        const changedKeys = [];
        for (const [key, item] of after) {
            const old = before.get(key);
            if (!old || item.row !== old.row || item.column !== old.column || item.span !== old.span) changedKeys.push(key);
        }
        const removedKeys = [...before.keys()].filter(key => !after.has(key));
        const columnsChanged = previous?.columns !== next?.columns;
        const rowsChanged = previous?.rows !== next?.rows;
        const cellsChanged = changedKeys.length > 0 || removedKeys.length > 0 ||
            Boolean(previous?.items) !== Boolean(next?.items);
        const deferredChanged = Boolean(previous?.deferredFocus) !== Boolean(next?.deferredFocus);
        return { columnsChanged, rowsChanged, cellsChanged, deferredChanged, changedKeys, removedKeys,
            topologyChanged: columnsChanged || rowsChanged || cellsChanged,
            changed: columnsChanged || rowsChanged || cellsChanged || deferredChanged };
    }

    // The live grid has one owner. CSS is a projection of these cells, never an
    // input to ordering. Desired focus/pending intent are kept separately from
    // committed cells so a hidden pane can retain its saved enlarged anchor.
    function createState({ buildGeometry } = {}) {
        if (typeof buildGeometry !== 'function') throw new TypeError('buildGeometry is required');
        const keysOnly = keys => [...new Set(Array.isArray(keys) ? keys.filter(key => typeof key === 'string') : [])];
        const copy = value => {
            if (Array.isArray(value)) return Object.freeze(value.map(copy));
            if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(
                Object.entries(value).map(([key, item]) => [key, copy(item)])));
            return value;
        };
        let state = copy({ order: [], preferredOrder: [], focus: null, pending: null,
            geometry: { ...buildGeometry({ keys: [], columns: 1 }), count: 0 } });
        const patch = value => { state = Object.freeze({ ...state, ...value }); };
        function commit(next) {
            const cells = next?.items ? next : { ...next,
                ...buildGeometry({ keys: state.order, columns: next?.columns || 1 }) };
            const geometry = copy({ ...cells, count: cells.items.length });
            const order = Object.freeze([...geometry.items].sort((a, b) => a.row - b.row || a.column - b.column)
                .map(item => item.key));
            const focus = geometry.items.find(item => item.span > 1);
            patch({ geometry, order, ...(!geometry.deferredFocus && focus ? { focus } : {}) });
            return geometry;
        }
        function setOrder(keys) {
            const order = Object.freeze(keysOnly(keys));
            // Reordering keeps the adopted tracks. Choosing different tracks is
            // still the existing layout algorithm's responsibility.
            const focus = order.length > 1 ? state.geometry.items.find(item => item.span > 1) : null;
            const geometry = copy({ ...state.geometry,
                ...buildGeometry({ keys: order, columns: state.geometry.columns, focus }), count: order.length });
            const visualOrder = Object.freeze([...geometry.items].sort((a, b) => a.row - b.row || a.column - b.column)
                .map(item => item.key));
            patch({ order: visualOrder, geometry });
            return visualOrder;
        }
        function setPreferredOrder(keys) { patch({ preferredOrder: Object.freeze(keysOnly(keys).slice(0, 256)) }); }
        return Object.freeze({
            get order() { return state.order; },
            get preferredOrder() { return state.preferredOrder; },
            get focus() { return state.focus; },
            get pending() { return state.pending; },
            get geometry() { return state.geometry; },
            get enlargedGeometry() { return state.geometry.items.some(item => item.span > 1) ? state.geometry : null; },
            setOrder,
            setPreferredOrder,
            rememberOrder() { setPreferredOrder([...state.order, ...state.preferredOrder.filter(key => !state.order.includes(key))]); },
            setFocus(value) { patch({ focus: value ? copy(value) : null }); },
            setPending(value) { patch({ pending: value ? copy(value) : null }); },
            commit
        });
    }

    // Decide what an input means before the page commits it. These rules only
    // describe cells: they never update the state, DOM, storage or player sound.
    function createOperations({ geometry } = {}) {
        if (!geometry || ['build', 'swap', 'neighbors', 'step', 'relocate', 'choose']
            .some(name => typeof geometry[name] !== 'function')) throw new TypeError('geometry operations are required');
        const visualKeys = layout => [...layout.items].sort((a, b) => a.row - b.row || a.column - b.column)
            .map(item => item.key);
        const none = (layout, reason = 'invalid', extra = {}) => ({ kind: 'none', next: layout, reason, ...extra });
        function pair(layout, sourceKey, targetKey) {
            if (!Array.isArray(layout?.items) || sourceKey === targetKey) return null;
            const source = layout.items.find(item => item.key === sourceKey);
            const target = layout.items.find(item => item.key === targetKey);
            return source && target ? { source, target } : null;
        }
        function exchange(layout, sourceKey, targetKey) {
            if (!pair(layout, sourceKey, targetKey)) return none(layout);
            const keys = visualKeys(layout);
            const sourceIndex = keys.indexOf(sourceKey), targetIndex = keys.indexOf(targetKey);
            [keys[sourceIndex], keys[targetIndex]] = [keys[targetIndex], keys[sourceIndex]];
            const enlarged = layout.items.some(item => item.span > 1);
            const pending = enlarged ? geometry.swap(layout, sourceKey, targetKey) : null;
            const focus = pending?.items.find(item => item.span > 1) || null;
            // The visual order, rather than geometry.items' insertion order, is
            // the established direct-exchange contract (including large tiles).
            const next = geometry.build({ keys, columns: pending?.columns || layout.columns, focus });
            return { kind: 'exchange', keys, next, pending, focus, enlarged };
        }
        function step(layout, sourceKey, direction, targetKey) {
            const items = pair(layout, sourceKey, targetKey);
            if (!items || !geometry.neighbors(layout, sourceKey, direction).some(item => item.key === targetKey))
                return none(layout, 'not-adjacent');
            if (items.source.span === 1 && items.target.span === 1) return exchange(layout, sourceKey, targetKey);
            const next = geometry.step(layout, sourceKey, direction, targetKey);
            if (next === layout) return none(layout, 'step-blocked');
            const reverse = { up: 'down', down: 'up', left: 'right', right: 'left' };
            return { kind: 'step', next,
                focusKey: items.source.span > 1 ? sourceKey : targetKey,
                focusDirection: items.source.span > 1 ? direction : reverse[direction] };
        }
        function target(layout, sourceKey, targetKey, { direction = null } = {}) {
            const items = pair(layout, sourceKey, targetKey);
            if (!items) return none(layout);
            if (items.source.span === 1 && items.target.span === 1) return exchange(layout, sourceKey, targetKey);
            const edge = ['up', 'down', 'left', 'right'].find(value =>
                geometry.neighbors(layout, sourceKey, value).some(item => item.key === targetKey));
            // Keyboard movement of a large tile requires a touching edge. A
            // pointer destination can instead request a remote bounded placement.
            if (direction && direction !== edge) return none(layout, 'not-adjacent');
            if (edge) return step(layout, sourceKey, edge, targetKey);
            const next = geometry.relocate(layout, sourceKey, targetKey);
            const focusKey = items.source.span > 1 ? sourceKey : targetKey;
            return next === layout ? none(layout, 'target-blocked', { focusKey }) : { kind: 'relocate', next, focusKey };
        }
        function reflow({ keys, focus, pending }, options) {
            focus = keys.includes(focus?.key) && keys.length > 1 ? focus : null;
            if (!focus) {
                if (pending?.intent === 'bookmark') {
                    const columns = Math.max(1, Math.min(keys.length || 1, pending.columns));
                    return { next: { count: keys.length, columns, rows: Math.max(1, Math.ceil(keys.length / columns)), area: 0 },
                        pending: options.width > 0 && options.height > 0 ? null : pending };
                }
                return { next: choose(options), pending: null };
            }
            if (!(options.width > 0 && options.height > 0)) {
                // Hidden panes preserve the saved anchor and the pending intent.
                const columns = Math.max(focus.span, Math.min(Math.max(pending?.columns || 0,
                    options.previous?.columns || 0, focus.column + focus.span), focus.span + keys.length - 1));
                return { next: { ...geometry.build({ keys, columns, focus }), count: keys.length, deferredFocus: true }, pending };
            }
            let next;
            if (pending?.intent === 'bookmark' || pending?.intent === 'drag') {
                // Bookmarks restore their tracks; a drag has already chosen its
                // tracks and opposite corner in the preview.
                next = geometry.build({ keys, columns: pending.columns, focus });
            } else if (pending?.intent === 'size' || pending?.intent === 'restore') {
                next = geometry.choose({ ...options, keys, focus, force: true });
            } else if (pending) {
                const columns = Math.max(focus.span, Math.min(pending.columns, focus.span + keys.length - 1));
                next = geometry.build({ keys, columns, focus });
            } else if (options.preserveColumns && options.previous?.columns >= focus.span && options.previous.columns <= 768) {
                next = geometry.build({ keys, columns: options.previous.columns, focus });
            } else next = geometry.choose({ ...options, keys, focus });
            return { next: { ...next, count: keys.length }, pending: null };
        }
        return Object.freeze({ exchange, step, target, reflow });
    }

    function choose({ count, width, height, columnGap = 0, rowGap = 0, previous, force = false,
        preserveColumns = false }) {
        count = Number.isFinite(Number(count)) ? Math.max(0, Math.floor(Number(count))) : 0;
        if (!count) return { count: 0, columns: 1, rows: 1, area: 0 };
        const measure = columns => {
            const rows = Math.max(1, Math.ceil(count / columns));
            const cellWidth = Math.max(0, (width - columnGap * (columns - 1)) / columns);
            const cellHeight = Math.max(0, (height - rowGap * (rows - 1)) / rows);
            const videoWidth = Math.min(cellWidth, cellHeight * ASPECT);
            return { count, columns, rows, area: videoWidth * videoWidth / ASPECT };
        };
        const oldColumns = previous?.columns;
        const validPrevious = Number.isInteger(oldColumns) && oldColumns >= 1 && oldColumns <= Math.max(1, count);
        // A hidden/zero-sized pane cannot provide a useful measurement yet.
        if (!(width > 0 && height > 0)) {
            const columns = validPrevious ? oldColumns : Math.max(1, Math.ceil(Math.sqrt(count)));
            return { count, columns, rows: Math.ceil(count / columns), area: 0 };
        }
        if (validPrevious && preserveColumns) return measure(oldColumns);
        let best = measure(1);
        for (let columns = 2; columns <= count; columns++) {
            const candidate = measure(columns);
            const difference = candidate.area - best.area;
            if (difference > 0.01 || (Math.abs(difference) <= 0.01 &&
                candidate.columns * candidate.rows < best.columns * best.rows)) best = candidate;
        }
        if (!force && validPrevious) {
            const current = measure(oldColumns);
            if (best.area <= current.area * (1 + SWITCH_GAIN)) return current;
        }
        return best;
    }

    function observe(pane, { getCount, getTrackCount = getCount, calculate = choose,
        stabilizeResize = false, getResizeStability = () => false, onChange = () => {},
        onCommit = next => next, runUpdate: optionsRunUpdate }) {
        const view = pane.ownerDocument?.defaultView;
        let current = null;
        let timer = null;
        let suspended = false;
        let disposed = false;
        let lastColumnGap;
        let lastRowGap;
        let reference = null;
        let aspectReference = null;
        let pendingForce = false;
        let lastXLimit, lastYLimit;
        const observer = view?.ResizeObserver ? new view.ResizeObserver(schedule) : null;

        function clearPending() {
            if (timer !== null) view.clearTimeout(timer);
            timer = null;
        }
        function measure({ force = false } = {}, applyLimits = false) {
            if (disposed) return;
            if (suspended) { pendingForce ||= force; return; }
            const style = view?.getComputedStyle(pane);
            const number = value => parseFloat(value) || 0;
            const width = Math.max(0, (pane.clientWidth || 0) - number(style?.paddingLeft) - number(style?.paddingRight));
            const height = Math.max(0, (pane.clientHeight || 0) - number(style?.paddingTop) - number(style?.paddingBottom));
            const gap = (value, dimension) => String(value).endsWith('%') ? number(value) * dimension / 100 : number(value);
            const count = getCount();
            // Gaps must also fit when many players share an extremely thin pane.
            // CSS retains the normal em-based gap whenever there is enough room.
            const tracks = Math.max(1, getTrackCount());
            const xLimit = width / (2 * tracks), yLimit = height / (2 * tracks);
            const oldColumnGap = gap(style?.columnGap, width), oldRowGap = gap(style?.rowGap, height);
            // A capped gap can grow to an unknown CSS value. Capture audio
            // before changing that cap, then read its exact computed value.
            const uncertainGap = !applyLimits && ((lastXLimit !== undefined && xLimit > lastXLimit && oldColumnGap >= lastXLimit) ||
                (lastYLimit !== undefined && yLimit > lastYLimit && oldRowGap >= lastYLimit));
            if (applyLimits) {
                writeLimit('--player-grid-gap-x-limit', xLimit, lastXLimit);
                writeLimit('--player-grid-gap-y-limit', yLimit, lastYLimit);
            }
            const fittedStyle = applyLimits ? view?.getComputedStyle(pane) : style;
            const columnGap = applyLimits ? gap(fittedStyle?.columnGap, width) : Math.min(oldColumnGap, xLimit);
            const rowGap = applyLimits ? gap(fittedStyle?.rowGap, height) : Math.min(oldRowGap, yLimit);
            const usable = width > 0 && height > 0;
            const validPrevious = Number.isInteger(current?.columns) && current.columns > 0;
            const withinBand = (value, original) => Math.abs(value - original) <=
                Math.max(2, Math.min(32, original * .05));
            const small = usable && reference && withinBand(width, reference.width) && withinBand(height, reference.height);
            const computedForce = Boolean(force || count !== current?.count || pendingForce);
            const stableAspect = Boolean(getResizeStability());
            const anchor = aspectReference || (usable ? { width, height } : null);
            const similarAspect = usable && anchor && Math.abs((width / height) /
                (anchor.width / anchor.height) - 1) <= ASPECT_RESIZE_BAND + Number.EPSILON;
            // Hidden panes still process logical changes; defer choosing tracks
            // for those changes until there is a useful measurement again.
            const calculation = { count, width, height, columnGap, rowGap, previous: current,
                force: computedForce,
                preserveColumns: validPrevious && (!usable || (!computedForce &&
                    (stableAspect ? Boolean(similarAspect) : Boolean(stabilizeResize && small)))) };
            const next = calculate(calculation), difference = compare(current, next);
            const gapsChanged = columnGap !== lastColumnGap || rowGap !== lastRowGap;
            const columns = `repeat(${next.columns}, minmax(0px, 1fr))`, rows = `repeat(${next.rows}, minmax(0px, 1fr))`;
            const repaired = pane.style.gridTemplateColumns !== columns || pane.style.gridTemplateRows !== rows;
            return { width, height, xLimit, yLimit, columnGap, rowGap, usable, small, computedForce, stableAspect,
                calculation, next, difference, gapsChanged, requiresLayout: difference.topologyChanged || gapsChanged || uncertainGap || repaired };
        }
        function writeLimit(name, value, previous) {
            const text = `${value}px`;
            if (pane.style.getPropertyValue ? pane.style.getPropertyValue(name) !== text : previous !== value)
                pane.style.setProperty?.(name, text);
        }
        function update(options = {}) {
            clearPending();
            if (typeof optionsRunUpdate !== 'function') return applyUpdate(options);
            const planned = measure(options);
            if (!planned) return;
            if (planned.requiresLayout)
                return optionsRunUpdate(() => applyUpdate(options), () => Boolean(measure(options)?.requiresLayout));
            return applyUpdate(options, planned);
        }
        function applyUpdate(options, prepared) {
            // Deferred audio capture may outlive a resize, selection change or
            // pagehide. Re-read the latest state instead of applying its preview.
            const plan = prepared || measure(options, true);
            if (!plan) return;
            if (prepared) {
                writeLimit('--player-grid-gap-x-limit', plan.xLimit, lastXLimit);
                writeLimit('--player-grid-gap-y-limit', plan.yLimit, lastYLimit);
            }
            const { width, height, xLimit, yLimit, columnGap, rowGap, usable, small, computedForce,
                stableAspect, calculation, difference, gapsChanged } = plan;
            const next = onCommit(plan.next, calculation) || plan.next;
            const { topologyChanged } = difference;
            if (!usable && computedForce) pendingForce = true;
            if (usable) {
                if (!reference || computedForce || !small) reference = { width, height };
                // Anchor to the adopted logical layout, not each measurement:
                // proportional scaling and cumulative small drags must not re-arm it.
                if (stableAspect && (!aspectReference || computedForce || topologyChanged))
                    aspectReference = { width, height };
                pendingForce = false;
            }
            if (!stableAspect) aspectReference = null;
            const changed = difference.changed || gapsChanged;
            current = next;
            lastColumnGap = columnGap;
            lastRowGap = rowGap;
            lastXLimit = xLimit; lastYLimit = yLimit;
            const columns = `repeat(${next.columns}, minmax(0px, 1fr))`, rows = `repeat(${next.rows}, minmax(0px, 1fr))`;
            const repaired = pane.style.gridTemplateColumns !== columns || pane.style.gridTemplateRows !== rows;
            if (pane.style.gridTemplateColumns !== columns) pane.style.gridTemplateColumns = columns;
            if (pane.style.gridTemplateRows !== rows) pane.style.gridTemplateRows = rows;
            if (changed || repaired) onChange(next);
            return changed || repaired;
        }
        function schedule() {
            if (disposed || suspended) return;
            clearPending();
            timer = view.setTimeout(() => { timer = null; update(); }, RESIZE_DELAY);
        }
        function suspend() {
            suspended = true;
            clearPending();
            observer?.disconnect();
        }
        function resume() {
            if (disposed) return;
            suspended = false;
            observer?.observe(pane);
            update();
        }
        observer?.observe(pane);
        // ResizeObserver also covers chat-divider changes without a window resize.
        if (!observer) view?.addEventListener('resize', schedule);
        view?.addEventListener('pagehide', suspend);
        view?.addEventListener('pageshow', resume);
        return {
            update,
            // Direct exchanges already project the current tracks. Keep the
            // observer's comparison baseline aligned without resetting resize
            // stability or starting a second audio transaction on its next tick.
            adopt(next) { if (!disposed) current = next; },
            getColumns: () => current?.columns || 1,
            destroy() {
                disposed = true;
                clearPending();
                observer?.disconnect();
                view?.removeEventListener('resize', schedule);
                view?.removeEventListener('pagehide', suspend);
                view?.removeEventListener('pageshow', resume);
            }
        };
    }

    const api = { choose, observe, createState, createOperations, compare };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PlayerLayout = api;
})(typeof globalThis === 'object' ? globalThis : this);
