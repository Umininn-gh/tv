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

    const neighborAxes = {
        up: ['row', 'column', true], down: ['row', 'column', false],
        left: ['column', 'row', true], right: ['column', 'row', false]
    };
    const validCell = item => item && Number.isInteger(item.row) && item.row >= 0 &&
        Number.isInteger(item.column) && item.column >= 0 && Number.isInteger(item.span) && item.span > 0;
    const compareCells = (a, b) => a.row - b.row || a.column - b.column ||
        (String(a.key) < String(b.key) ? -1 : String(a.key) > String(b.key) ? 1 : 0);

    function neighbors(layout, key, direction) {
        if (!Object.hasOwn(neighborAxes, direction) || !Array.isArray(layout?.items)) return [];
        const source = layout.items.find(item => item?.key === key && validCell(item));
        if (!source) return [];
        const [axis, cross, backwards] = neighborAxes[direction];
        return layout.items.filter(target => validCell(target) && target.key !== key && (backwards ?
            target[axis] + target.span === source[axis] : target[axis] === source[axis] + source.span) &&
            target[cross] < source[cross] + source.span && target[cross] + target.span > source[cross])
            // Top/bottom edges run left to right; left/right edges run top to bottom.
            .sort((a, b) => a[cross] - b[cross] || compareCells(a, b));
    }

    function neighbor(layout, key, direction) {
        const targets = neighbors(layout, key, direction);
        if (!targets.length) return null;
        const source = layout.items.find(item => item?.key === key && validCell(item));
        const [, cross] = neighborAxes[direction];
        let selected = null, bestDistance = Infinity;
        for (const target of targets) {
            const start = Math.max(source[cross], target[cross]);
            const end = Math.min(source[cross] + source.span, target[cross] + target.span);
            // Preserve the nearest-neighbor helper for keyboard navigation.
            // Doubled midpoints make even-sized side ties deterministic.
            const distance = Math.abs(start + end - (source[cross] * 2 + source.span));
            if (!selected || distance < bestDistance || (distance === bestDistance && compareCells(target, selected) < 0)) {
                selected = target;
                bestDistance = distance;
            }
        }
        return selected;
    }

    function step(layout, key, direction, targetKey) {
        const targets = neighbors(layout, key, direction);
        const target = targetKey === undefined ? neighbor(layout, key, direction) :
            targets.find(item => item.key === targetKey);
        if (!target || !Number.isInteger(layout.columns) || layout.columns < 1 ||
            !Number.isInteger(layout.rows) || layout.rows < 1 || layout.items.some(item =>
                !validCell(item) || item.column + item.span > layout.columns || item.row + item.span > layout.rows)) return layout;
        const source = layout.items.find(item => item.key === key);
        const enlarged = layout.items.filter(item => item.span > 1);
        if (enlarged.length > 1 || new Set(layout.items.map(item => item.key)).size !== layout.items.length) return layout;
        const focus = enlarged[0];
        let nextFocus = focus;
        let desired;
        if (focus && (source.key === focus.key || target.key === focus.key)) {
            const [axis, , backwards] = neighborAxes[direction];
            // When a small tile points at the focus, the focus moves towards
            // that tile: one cell opposite to the small tile's arrow.
            const delta = (backwards ? -1 : 1) * (source.key === focus.key ? 1 : -1);
            nextFocus = { ...focus, [axis]: focus[axis] + delta };
            if (nextFocus.row < 0 || nextFocus.column < 0 ||
                nextFocus.row + nextFocus.span > layout.rows ||
                nextFocus.column + nextFocus.span > layout.columns) return layout;
            const displaced = new Set();
            desired = layout.items.map(item => {
                if (item.key === focus.key) return nextFocus;
                const entering = item.row >= nextFocus.row && item.row < nextFocus.row + nextFocus.span &&
                    item.column >= nextFocus.column && item.column < nextFocus.column + nextFocus.span;
                // Move the whole entering strip to the freed strip, retaining
                // each small tile's position along the shared edge.
                if (entering) displaced.add(item.key);
                return entering ? { ...item, [axis]: item[axis] - delta * focus.span } : item;
            });
            const slots = new Map(build({ keys: layout.items.map(item => item.key),
                columns: layout.columns, focus: nextFocus }).items.filter(item => item.span === 1)
                .sort(compareCells).map(item => [`${item.row}:${item.column}`, { row: item.row, column: item.column }]));
            const assigned = new Map([[focus.key, nextFocus]]);
            const ordinary = desired.filter(item => item.key !== focus.key).sort(compareCells);
            function pin(item) {
                const position = `${item.row}:${item.column}`;
                if (!slots.has(position)) return;
                assigned.set(item.key, item);
                slots.delete(position);
            }
            // A partial last row can change which cells are representable by
            // dense packing. Preserve every unaffected tile that still fits
            // before assigning the displaced strip and filling remaining holes.
            ordinary.filter(item => !displaced.has(item.key)).forEach(pin);
            ordinary.filter(item => displaced.has(item.key)).forEach(pin);
            const remaining = [...slots.values()];
            let index = 0;
            for (const item of ordinary) if (!assigned.has(item.key)) {
                assigned.set(item.key, { ...item, ...remaining[index++] });
            }
            desired = [...assigned.values()];
        } else {
            desired = layout.items.map(item => item.key === source.key ? { ...target, key: source.key } :
                item.key === target.key ? { ...source, key: target.key } : item);
        }
        // Rebuilding from assigned visual order keeps the existing saved schema.
        const next = build({ keys: desired.sort(compareCells).map(item => item.key),
            columns: layout.columns, focus: nextFocus });
        return next.rows <= layout.rows ? next : layout;
    }

    function relocate(layout, sourceKey, targetKey) {
        if (!Array.isArray(layout?.items) || sourceKey === targetKey ||
            !Number.isInteger(layout.columns) || layout.columns < 1 ||
            !Number.isInteger(layout.rows) || layout.rows < 1 || layout.items.some(item =>
                !validCell(item) || item.column + item.span > layout.columns || item.row + item.span > layout.rows) ||
            new Set(layout.items.map(item => item.key)).size !== layout.items.length) return layout;
        const source = layout.items.find(item => item.key === sourceKey);
        const target = layout.items.find(item => item.key === targetKey);
        const enlarged = layout.items.filter(item => item.span > 1);
        if (!source || !target || enlarged.length !== 1) return layout;
        const focus = enlarged[0];
        if (source.key !== focus.key && target.key !== focus.key) return layout;
        const other = source.key === focus.key ? target : source;
        const nextFocus = { ...focus, row: Math.min(other.row, layout.rows - focus.span),
            column: Math.min(other.column, layout.columns - focus.span) };
        if (nextFocus.row === focus.row && nextFocus.column === focus.column) return layout;
        const contains = (area, item) => item.row >= area.row && item.row < area.row + area.span &&
            item.column >= area.column && item.column < area.column + area.span;
        const ordinary = layout.items.filter(item => item.key !== focus.key).sort(compareCells);
        const slots = new Map(build({ keys: layout.items.map(item => item.key),
            columns: layout.columns, focus: nextFocus }).items.filter(item => item.span === 1)
            .sort(compareCells).map(item => [`${item.row}:${item.column}`, { row: item.row, column: item.column }]));
        const assigned = new Map([[focus.key, nextFocus]]);
        function assign(item, position) {
            if (!position) return;
            assigned.set(item.key, { ...item, row: position.row, column: position.column });
            slots.delete(`${position.row}:${position.column}`);
        }
        // Keep every unaffected original position that the canonical layout can
        // still represent before assigning any tile covered by the new focus.
        ordinary.filter(item => !contains(nextFocus, item)).forEach(item =>
            assign(item, slots.get(`${item.row}:${item.column}`)));
        const freed = [...slots.values()].filter(position => contains(focus, position));
        let index = 0;
        function takeFreed() {
            while (index < freed.length) {
                const position = freed[index++];
                if (slots.has(`${position.row}:${position.column}`)) return position;
            }
            return undefined;
        }
        // The selected small tile takes the former focus anchor when that cell
        // was actually freed; the other covered tiles follow in visual order.
        assign(other, slots.get(`${focus.row}:${focus.column}`) || takeFreed());
        for (const item of ordinary) if (contains(nextFocus, item) && !assigned.has(item.key)) assign(item, takeFreed());
        const remaining = [...slots.values()];
        index = 0;
        for (const item of ordinary) if (!assigned.has(item.key)) assign(item, remaining[index++]);
        const next = build({ keys: [...assigned.values()].sort(compareCells).map(item => item.key),
            columns: layout.columns, focus: nextFocus });
        return next.rows <= layout.rows ? next : layout;
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

    const api = { build, grow, shrink, resize, swap, neighbor, neighbors, step, relocate, choose };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PlayerGeometry = api;
})(typeof globalThis === 'object' ? globalThis : this);
