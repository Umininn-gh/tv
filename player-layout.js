/* Fit every player inside the available pane without touching its media. */
(function (root) {
    'use strict';

    const ASPECT = 16 / 9;
    const SWITCH_GAIN = 0.06;
    const RESIZE_DELAY = 180;
    const ASPECT_RESIZE_BAND = 0.15;

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
        stabilizeResize = false, getResizeStability = () => false, onChange = () => {} }) {
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
        const observer = view?.ResizeObserver ? new view.ResizeObserver(schedule) : null;

        function clearPending() {
            if (timer !== null) view.clearTimeout(timer);
            timer = null;
        }
        function update({ force = false } = {}) {
            if (disposed) return;
            if (suspended) { pendingForce ||= force; return; }
            clearPending();
            const style = view?.getComputedStyle(pane);
            const number = value => parseFloat(value) || 0;
            const width = Math.max(0, (pane.clientWidth || 0) - number(style?.paddingLeft) - number(style?.paddingRight));
            const height = Math.max(0, (pane.clientHeight || 0) - number(style?.paddingTop) - number(style?.paddingBottom));
            const gap = (value, dimension) => String(value).endsWith('%') ? number(value) * dimension / 100 : number(value);
            const count = getCount();
            // Gaps must also fit when many players share an extremely thin pane.
            // CSS retains the normal em-based gap whenever there is enough room.
            const tracks = Math.max(1, getTrackCount());
            pane.style.setProperty?.('--player-grid-gap-x-limit', `${width / (2 * tracks)}px`);
            pane.style.setProperty?.('--player-grid-gap-y-limit', `${height / (2 * tracks)}px`);
            const fittedStyle = view?.getComputedStyle(pane);
            const columnGap = gap(fittedStyle?.columnGap, width);
            const rowGap = gap(fittedStyle?.rowGap, height);
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
            if (!usable && computedForce) pendingForce = true;
            const next = calculate({ count, width, height, columnGap, rowGap, previous: current,
                force: computedForce,
                preserveColumns: validPrevious && (!usable || (!computedForce &&
                    (stableAspect ? Boolean(similarAspect) : Boolean(stabilizeResize && small)))) });
            const topologyChanged = next.columns !== current?.columns || next.rows !== current?.rows ||
                JSON.stringify(next.items) !== JSON.stringify(current?.items);
            if (usable) {
                if (!reference || computedForce || !small) reference = { width, height };
                // Anchor to the adopted logical layout, not each measurement:
                // proportional scaling and cumulative small drags must not re-arm it.
                if (stableAspect && (!aspectReference || computedForce || topologyChanged))
                    aspectReference = { width, height };
                pendingForce = false;
            }
            if (!stableAspect) aspectReference = null;
            const changed = topologyChanged ||
                Boolean(next.deferredFocus) !== Boolean(current?.deferredFocus) ||
                columnGap !== lastColumnGap || rowGap !== lastRowGap;
            current = next;
            lastColumnGap = columnGap;
            lastRowGap = rowGap;
            if (!changed) return;
            pane.style.gridTemplateColumns = `repeat(${next.columns}, minmax(0, 1fr))`;
            pane.style.gridTemplateRows = `repeat(${next.rows}, minmax(0, 1fr))`;
            onChange(next);
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

    const api = { choose, observe };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PlayerLayout = api;
})(typeof globalThis === 'object' ? globalThis : this);
