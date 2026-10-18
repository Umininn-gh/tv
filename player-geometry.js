/* Logical player cells. One player can occupy a square of multiple cells. */
(function (root) {
    'use strict';

    const ASPECT = 16 / 9;
    const SWITCH_GAIN = 0.06;
    const FOCUS_SWITCH_GAIN = 0.18;
    const integer = (value, minimum = 0) => Number.isFinite(Number(value)) ?
        Math.max(minimum, Math.floor(Number(value))) : minimum;
    const uniqueKeys = keys => Array.isArray(keys) ? [...new Set(keys)] : [];

    function getFocus(keys, focus) {
        if (!focus || !keys.includes(focus.key) || integer(focus.span, 1) < 2) return null;
        return { key: focus.key, span: integer(focus.span, 1),
            row: integer(focus.row), column: integer(focus.column) };
    }

    function build({ keys, columns = 1, focus } = {}) {
        keys = uniqueKeys(keys);
        focus = getFocus(keys, focus);
        columns = Math.max(integer(columns, 1), focus?.span || 1);
        if (focus) focus.column = Math.min(focus.column, columns - focus.span);
        const area = keys.length + (focus ? focus.span * focus.span - 1 : 0);
        let rows = Math.max(1, Math.ceil(area / columns), focus ? focus.row + focus.span : 0);
        let next = 0;
        const items = keys.map(key => {
            if (key === focus?.key) return { ...focus };
            let row = Math.floor(next / columns), column = next % columns;
            // Skip the reserved square a row at a time, without a large matrix.
            while (focus && row >= focus.row && row < focus.row + focus.span &&
                column >= focus.column && column < focus.column + focus.span) {
                next += focus.column + focus.span - column;
                row = Math.floor(next / columns);
                column = next % columns;
            }
            next++;
            rows = Math.max(rows, row + 1);
            return { key, row, column, span: 1 };
        });
        return { columns, rows, items };
    }

    function grow(layout, key) {
        const current = layout?.items?.find(item => item.key === key);
        if (!current) return layout;
        const span = integer(current.span, 1) + 1;
        const columns = Math.max(integer(layout.columns, 1), span);
        const oldColumn = integer(current.column);
        const column = oldColumn + span <= columns ? oldColumn : Math.max(0, oldColumn - 1);
        const keys = [...layout.items].sort((a, b) => a.row - b.row || a.column - b.column)
            .map(item => item.key);
        return build({ keys, columns,
            focus: { key, span, row: Math.max(0, integer(current.row) - 1), column } });
    }

    function shrink(layout, key) {
        const current = layout?.items?.find(item => item.key === key);
        if (!current || !(current.span > 1)) return layout;
        const keys = [...layout.items].sort((a, b) => a.row - b.row || a.column - b.column)
            .map(item => item.key);
        const span = integer(current.span, 1) - 1;
        const columns = Math.min(integer(layout.columns, 1), Math.max(span, span + keys.length - 1));
        // Keep the square's origin; release its bottom/right edges into the grid.
        // Visual order also keeps recent moves when the last extra cells vanish.
        const next = build({ keys, columns, focus: span > 1 ? { ...current, span } : null });
        const usedColumns = next.items.reduce((maximum, item) => Math.max(maximum, item.column + item.span), 1);
        if (usedColumns === next.columns) return next;
        // Remove only wholly empty columns on the right; every cell stays put.
        const rows = next.items.reduce((maximum, item) => Math.max(maximum, item.row + item.span), 1);
        return { ...next, columns: usedColumns, rows };
    }

    function resize(layout, key, span, corner = 'se') {
        const current = layout?.items?.find(item => item.key === key);
        if (!current) return layout;
        span = Math.min(256, integer(span, 1));
        if (!['nw', 'ne', 'sw', 'se'].includes(corner)) corner = 'se';
        const keys = [...layout.items].sort((a, b) => a.row - b.row || a.column - b.column)
            .map(item => item.key);
        if (span === 1) return build({ keys,
            columns: Math.min(768, integer(layout.columns, 1), Math.max(1, keys.length)) });

        const delta = integer(current.span, 1) - span;
        // Match the persisted UI schema, including repeated opposite-corner drags.
        const row = Math.min(512, Math.max(0, integer(current.row) + (corner[0] === 'n' ? delta : 0)));
        const column = Math.min(512, Math.max(0, integer(current.column) + (corner[1] === 'w' ? delta : 0)));
        // Keep the opposite corner whenever it fits. Retaining existing columns
        // also preserves a right-hand anchor when a west handle shrinks a square.
        const columns = Math.min(768, Math.max(integer(layout.columns, 1), column + span));
        return build({ keys, columns, focus: { key, span, row, column } });
    }

    function swap(layout, source, target) {
        const keys = layout?.items?.map(item => item.key) || [];
        const sourceIndex = keys.indexOf(source), targetIndex = keys.indexOf(target);
        if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return layout;
        const focus = layout.items.find(item => item.span > 1);
        let nextFocus = focus && { ...focus };
        if (focus && (focus.key === source || focus.key === target)) {
            const destination = layout.items[focus.key === source ? targetIndex : sourceIndex];
            nextFocus.row = destination.row;
            nextFocus.column = destination.column;
        }
        [keys[sourceIndex], keys[targetIndex]] = [keys[targetIndex], keys[sourceIndex]];
        return build({ keys, columns: layout.columns, focus: nextFocus });
    }

    function choose({ keys, width, height, columnGap = 0, rowGap = 0, previous,
        focus, force = false, preserveAnchor = false } = {}) {
        keys = uniqueKeys(keys);
        if (!keys.length) return { ...build(), area: 0 };
        focus = getFocus(keys, focus);
        const span = focus?.span || 1;
        const minimum = preserveAnchor && focus ? focus.column + span : span;
        // Beyond this width all ordinary players already fit beside the square.
        const maximum = Math.max(minimum, span + keys.length - 1);
        const occupiedArea = keys.length + span * span - 1;
        const oldColumns = previous?.columns;
        const validPrevious = Number.isInteger(oldColumns) && oldColumns >= minimum && oldColumns <= maximum;
        const nonnegative = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
        width = nonnegative(width); height = nonnegative(height);
        columnGap = nonnegative(columnGap); rowGap = nonnegative(rowGap);
        if (!(width > 0 && height > 0)) {
            const columns = validPrevious ? oldColumns : Math.max(minimum, Math.ceil(Math.sqrt(occupiedArea)));
            return { ...build({ keys, columns, focus }), area: 0 };
        }
        function measure(columns) {
            const rows = Math.max(1, Math.ceil(occupiedArea / columns), focus ? focus.row + focus.span : 0);
            const cellWidth = Math.max(0, (width - columnGap * (columns - 1)) / columns);
            const cellHeight = Math.max(0, (height - rowGap * (rows - 1)) / rows);
            const videoWidth = Math.min(cellWidth, cellHeight * ASPECT);
            return { columns, rows, area: videoWidth * videoWidth / ASPECT };
        }
        let best = measure(minimum);
        for (let columns = minimum + 1; columns <= maximum; columns++) {
            const candidate = measure(columns);
            const difference = candidate.area - best.area;
            if (difference > 0.01 || (Math.abs(difference) <= 0.01 &&
                candidate.columns * candidate.rows < best.columns * best.rows)) best = candidate;
        }
        if (!force && validPrevious) {
            const current = measure(oldColumns);
            const gain = focus ? FOCUS_SWITCH_GAIN : SWITCH_GAIN;
            if (best.area <= current.area * (1 + gain)) best = current;
        }
        return { ...build({ keys, columns: best.columns, focus }), area: best.area };
    }

    const api = { build, grow, shrink, resize, swap, choose };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PlayerGeometry = api;
})(typeof globalThis === 'object' ? globalThis : this);
