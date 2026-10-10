// Plaid — BSP/dwindle tree operations, min-size math, and directional search.
//
// Instance methods attached to TilingWMExtension.prototype in extension.js.
// `this` (settings, _bspTrees, _dwindleLeafSigs, …) and call sites are unchanged.

export function _bspGetTree(workspace) {
    if (!this._bspTrees.has(workspace))
        this._bspTrees.set(workspace, null);
    return this._bspTrees.get(workspace);
}

export function _bspMakeLeaf(win) {
    return { type: 'leaf', window: win };
}

export function _bspMakeSplit(dir, ratio, first, second) {
    return { type: 'split', direction: dir, ratio, first, second };
}

export function _bspInsert(node, win, x, y, w, h, gap) {
    if (!node) return this._bspMakeLeaf(win);
    if (node.type === 'empty') return this._bspMakeLeaf(win);
    if (node.type === 'leaf') {
        const dir = w >= h ? 'h' : 'v';
        const ratio = this._settings.get_double('dwindle-ratio');
        return this._bspMakeSplit(dir, ratio, node, this._bspMakeLeaf(win));
    }
    const isH = node.direction === 'h';
    const axisSize = isH ? w : h;
    const split = Math.floor((axisSize - gap) * node.ratio);
    const secondSize = axisSize - split - gap;
    if (isH)
        node.second = this._bspInsert(node.second, win, x + split + gap, y, secondSize, h, gap);
    else
        node.second = this._bspInsert(node.second, win, x, y + split + gap, w, secondSize, gap);
    return node;
}

export function _bspRemove(node, win) {
    if (!node) return { type: 'empty' };
    if (node.type === 'empty') return node;
    if (node.type === 'leaf') {
        return node.window === win ? { type: 'empty' } : node;
    }
    node.first = this._bspRemove(node.first, win);
    node.second = this._bspRemove(node.second, win);
    if (node.first.type === 'empty' && node.second.type === 'empty')
        return { type: 'empty' };
    if (node.first.type === 'empty') return node.second;
    if (node.second.type === 'empty') return node.first;
    return node;
}

export function _bspCollectWindows(node) {
    if (!node) return [];
    if (node.type === 'empty') return [];
    if (node.type === 'leaf') return [node.window];
    return [...this._bspCollectWindows(node.first), ...this._bspCollectWindows(node.second)];
}

export function _bspLayout(node, x, y, w, h, gap, skipWindow) {
    if (!node) return;
    if (node.type === 'empty') return;
    if (node.type === 'leaf') {
        node._x = x;
        node._y = y;
        node._w = w;
        node._h = h;
        if (node.window !== skipWindow) {
            this._safeMove(node.window, x, y, w, h);
        } else {
            const frame = node.window.get_frame_rect();
            this._safeMove(node.window, x, y, frame.width, frame.height);
        }
        return;
    }
    const isH = node.direction === 'h';
    const firstEmpty = !node.first || node.first.type === 'empty';
    const secondEmpty = !node.second || node.second.type === 'empty';
    if (firstEmpty && secondEmpty) return;
    if (firstEmpty) {
        this._bspLayout(node.second, x, y, w, h, gap, skipWindow);
        return;
    }
    if (secondEmpty) {
        this._bspLayout(node.first, x, y, w, h, gap, skipWindow);
        return;
    }
    const axisSize = isH ? w : h;
    const split = Math.floor((axisSize - gap) * node.ratio);
    const secondSize = axisSize - split - gap;
    if (split < 0 || secondSize < 0) return;
    if (isH) {
        this._bspLayout(node.first, x, y, split, h, gap, skipWindow);
        this._bspLayout(node.second, x + split + gap, y, secondSize, h, gap, skipWindow);
    } else {
        this._bspLayout(node.first, x, y, w, split, gap, skipWindow);
        this._bspLayout(node.second, x, y + split + gap, w, secondSize, gap, skipWindow);
    }
}

export function _bspFindPath(node, win, path) {
    if (!node) return false;
    if (node.type === 'leaf') return node.window === win;
    path.push(node);
    if (this._bspFindPath(node.first, win, path)) return true;
    if (this._bspFindPath(node.second, win, path)) return true;
    path.pop();
    return false;
}

export function _bspFindLeaf(node, win) {
    if (!node) return null;
    if (node.type === 'leaf') return node.window === win ? node : null;
    return this._bspFindLeaf(node.first, win) || this._bspFindLeaf(node.second, win);
}

export function _bspSwapWindows(node, winA, winB) {
    if (!node) return;
    if (node.type === 'leaf') {
        if (node.window === winA) node.window = winB;
        else if (node.window === winB) node.window = winA;
        return;
    }
    this._bspSwapWindows(node.first, winA, winB);
    this._bspSwapWindows(node.second, winA, winB);
}

export function _bspFindLeafAtPoint(node, x, y, w, h, px, py, gap) {
    if (!node) return null;
    if (node.type === 'empty') return node;
    if (node.type === 'leaf') return node;
    const isH = node.direction === 'h';
    const axisSize = isH ? w : h;
    const split = Math.floor((axisSize - gap) * node.ratio);
    const secondSize = axisSize - split - gap;
    if (isH) {
        if (px < x + split + gap)
            return this._bspFindLeafAtPoint(node.first, x, y, split, h, px, py, gap);
        else
            return this._bspFindLeafAtPoint(node.second, x + split + gap, y, secondSize, h, px, py, gap);
    } else {
        if (py < y + split + gap)
            return this._bspFindLeafAtPoint(node.first, x, y, w, split, px, py, gap);
        else
            return this._bspFindLeafAtPoint(node.second, x, y + split + gap, w, secondSize, px, py, gap);
    }
}

export function _bspReplaceLeaf(node, targetLeaf, newWin, preferredRatio = null) {
    if (!node) return null;
    if (node.type === 'empty') {
        if (node === targetLeaf)
            return this._bspMakeLeaf(newWin);
        return node;
    }
    if (node.type === 'leaf') {
        if (node === targetLeaf) {
            const dir = ((node._w || 0) >= (node._h || 0)) ? 'h' : 'v';
            const ratio = (preferredRatio && preferredRatio > 0 && preferredRatio < 1)
                ? preferredRatio
                : this._settings.get_double('dwindle-ratio');
            return this._bspMakeSplit(dir, ratio, node, this._bspMakeLeaf(newWin));
        }
        return node;
    }
    node.first = this._bspReplaceLeaf(node.first, targetLeaf, newWin, preferredRatio);
    node.second = this._bspReplaceLeaf(node.second, targetLeaf, newWin, preferredRatio);
    return node;
}

export function _bspTagGeometry(node, x, y, w, h, gap) {
    if (!node) return;
    node._x = x;
    node._y = y;
    node._w = w;
    node._h = h;
    if (node.type === 'empty' || node.type === 'leaf') return;
    const isH = node.direction === 'h';
    const axisSize = isH ? w : h;
    const split = Math.floor((axisSize - gap) * node.ratio);
    const secondSize = axisSize - split - gap;
    if (isH) {
        this._bspTagGeometry(node.first, x, y, split, h, gap);
        this._bspTagGeometry(node.second, x + split + gap, y, secondSize, h, gap);
    } else {
        this._bspTagGeometry(node.first, x, y, w, split, gap);
        this._bspTagGeometry(node.second, x, y + split + gap, w, secondSize, gap);
    }
}

export function _bspInsertForWorkspace(ws, win) {
    const gap = this._settings.get_int('inside-gap');
    const monitor = global.display.get_primary_monitor();
    const workArea = ws.get_work_area_for_monitor(monitor);
    if (!workArea) return;
    let tree = this._bspGetTree(ws);

    if (tree) {
        const existing = this._bspCollectWindows(tree);
        if (existing.includes(win)) return;
    }

    const area = this._outsideArea(workArea);
    if (!area) return;
    const areaX = area.x;
    const areaY = area.y;
    const areaW = area.w;
    const areaH = area.h;

    if (tree) {
        const [px, py] = global.get_pointer();
        this._bspTagGeometry(tree, areaX, areaY, areaW, areaH, gap);
        // Leaf-pick only when the pointer is INSIDE the tiling area —
        // a pointer on a secondary monitor (or over a panel) used to be
        // resolved against the primary gapped area to an ARBITRARY leaf
        // (the top-left-most), landing the new window in a slot
        // unrelated to where the user works; the append-at-end fallback
        // matches the plain new-window behavior instead
        // (2026-10-04 audit).
        const inside = px >= areaX && px < areaX + areaW &&
            py >= areaY && py < areaY + areaH;
        const target = inside
            ? this._bspFindLeafAtPoint(tree, areaX, areaY, areaW, areaH, px, py, gap)
            : null;
        if (target) {
            tree = this._bspReplaceLeaf(tree, target, win);
        } else {
            tree = this._bspInsert(tree, win, areaX, areaY, areaW, areaH, gap);
        }
    } else {
        tree = this._bspInsert(tree, win, areaX, areaY, areaW, areaH, gap);
    }
    this._bspTrees.set(ws, tree);
}

export function _parseMinSizeOverrides(entries) {
    const map = new Map();
    for (const entry of entries || []) {
        const m = /^(.+?):(\d+)x(\d+)$/.exec(entry);
        if (m) map.set(m[1].toLowerCase(), { w: parseInt(m[2], 10), h: parseInt(m[3], 10) });
    }
    return map;
}

export function _getWindowMinSize(win) {
    let entry = null;
    for (const c of this._winClassCandidates(win)) {
        entry = this._minSizeOverrides?.get(c);
        if (entry) break;
    }
    if (!entry) {
        const title = (win.get_title() || '').toLowerCase();
        entry = this._minSizeOverrides?.get(title);
    }
    if (entry) return { w: entry.w, h: entry.h };
    try {
        const [mw, mh] = win.get_min_size();
        const w = Number.isFinite(mw) ? mw : 0;
        const h = Number.isFinite(mh) ? mh : 0;
        if (w > 0 || h > 0) return { w, h };
    } catch (_e) {}
    return { w: 0, h: 0 };
}

export function _treeMinSizes(node) {
    if (!node || node.type === 'empty') return { w: 0, h: 0 };
    if (node.type === 'leaf') {
        const min = node.window ? this._getWindowMinSize(node.window) : { w: 0, h: 0 };
        node._minW = min.w;
        node._minH = min.h;
        return min;
    }
    const a = this._treeMinSizes(node.first);
    const b = this._treeMinSizes(node.second);
    // 'h' = children side by side (widths ADD, heights max); 'v' =
    // children stacked (heights ADD, widths max). The formulas were
    // INVERTED (2026-10-04 audit — the journal diag tree showed a
    // nested v-split with _minH 673 instead of 540+673=1213 and a root
    // _minH 1483 instead of 810): every nested split understated its
    // minimum, so _clampTreeToMinSizes partitioned slots smaller than
    // the windows can take → landing-verify failures → bend/give-up
    // floats.
    if (node.direction === 'h') {
        node._minW = a.w + b.w;
        node._minH = Math.max(a.h, b.h);
    } else {
        node._minW = Math.max(a.w, b.w);
        node._minH = a.h + b.h;
    }
    return { w: node._minW, h: node._minH };
}

export function _clampTreeToMinSizes(node, areaW, areaH, gap) {
    if (!node || node.type !== 'split') return;
    this._clampTreeToMinSizes(node.first, areaW, areaH, gap);
    this._clampTreeToMinSizes(node.second, areaW, areaH, gap);
    if (node.direction === 'h') {
        const minW1 = node.first?._minW || 0;
        const minW2 = node.second?._minW || 0;
        const axisSize = areaW - gap;
        if (axisSize > 0) {
            const minRatio = minW1 / axisSize;
            const maxRatio = 1 - minW2 / axisSize;
            if (maxRatio <= minRatio) {
                const need = minW1 + minW2;
                node.ratio = need > 0 ? minW1 / need : 0.5;
            } else {
                node.ratio = Math.max(minRatio, Math.min(maxRatio, node.ratio));
            }
        }
    } else {
        const minH1 = node.first?._minH || 0;
        const minH2 = node.second?._minH || 0;
        const axisSize = areaH - gap;
        if (axisSize > 0) {
            const minRatio = minH1 / axisSize;
            const maxRatio = 1 - minH2 / axisSize;
            if (maxRatio <= minRatio) {
                const need = minH1 + minH2;
                node.ratio = need > 0 ? minH1 / need : 0.5;
            } else {
                node.ratio = Math.max(minRatio, Math.min(maxRatio, node.ratio));
            }
        }
    }
}

export function _adjustForConstraints(node, parent, isFirst, x, y, w, h, gap, parentAxis) {
    if (!node) return false;
    if (node.type === 'leaf') {
        if (!parent || !node.window) return false;
        const f = node.window.get_frame_rect();
        if (f.width === 0 || f.height === 0) return false;
        // parentAxis is the PARENT split's usable span (its w/h minus the
        // inner gap), passed down by the recursion. The ratio lives on
        // the parent, so the bend math must be sized against that full
        // span. The old code used the leaf's OWN allocated slot as the
        // axis — `1 - frame/ownSlot` for a second child goes negative
        // whenever the frame exceeds its (too-small) slot, clamping the
        // ratio to 0.05 (and a stale mid-animation first-child frame
        // clamps it to 0.95): the 2026-10-02 goverlay/emacs oscillation
        // that produced 95px slots and a give-up float.
        const axisSize = parentAxis;
        if (axisSize <= 0) return false;
        // "Changed" means the RATIO moved, not that the frame exceeded
        // its slot: a frame over the slot with the ratio already clamped
        // at a bound (0.05/0.95) is a no-op the caller must not log or
        // persist (the frame exceeded its slot but nothing bent).
        const before = parent.ratio;
        if (parent.direction === 'h' && f.width > node._w + 1) {
            if (isFirst) {
                parent.ratio = Math.min(0.95, Math.max(parent.ratio, f.width / axisSize));
            } else {
                parent.ratio = Math.max(0.05, Math.min(parent.ratio, 1 - f.width / axisSize));
            }
        } else if (parent.direction === 'v' && f.height > node._h + 1) {
            if (isFirst) {
                parent.ratio = Math.min(0.95, Math.max(parent.ratio, f.height / axisSize));
            } else {
                parent.ratio = Math.max(0.05, Math.min(parent.ratio, 1 - f.height / axisSize));
            }
        }
        return parent.ratio !== before;
    }
    if (node.type !== 'split') return false;
    const isH = node.direction === 'h';
    const axisSize = isH ? w : h;
    const split = Math.floor((axisSize - gap) * node.ratio);
    const secondSize = axisSize - split - gap;
    const childAxis = axisSize - gap;
    let changed = false;
    if (isH) {
        changed = this._adjustForConstraints(node.first, node, true, x, y, split, h, gap, childAxis) || changed;
        changed = this._adjustForConstraints(node.second, node, false, x + split + gap, y, secondSize, h, gap, childAxis) || changed;
    } else {
        changed = this._adjustForConstraints(node.first, node, true, x, y, w, split, gap, childAxis) || changed;
        changed = this._adjustForConstraints(node.second, node, false, x, y + split + gap, w, secondSize, gap, childAxis) || changed;
    }
    return changed;
}

export function _dwindleShapeToString(node) {
    // Prefix encoding: l=leaf, e=empty, split = dir+ratio(child,child)
    // e.g. "h0.8480(l,l)" — one ':' per entry (the index separator).
    if (!node || node.type === 'empty') return 'e';
    if (node.type === 'leaf') return 'l';
    if (node.type !== 'split') return 'e';
    const ratio = Number.isFinite(node.ratio) ? node.ratio : 0.5;
    // Clamp before toFixed(4): a ratio ≥ 0.99995 serializes to "1.0000"
    // (and ≤ 0.00005 to "0.0000") which _dwindleShapeFromString REJECTS
    // (ratio must be strictly between 0 and 1) — the whole entry was
    // silently dropped from the written strv, losing the saved shape
    // (2026-10-04 audit).
    const r = Math.min(0.9999, Math.max(0.0001, ratio));
    return `${node.direction === 'v' ? 'v' : 'h'}${r.toFixed(4)}` +
        `(${this._dwindleShapeToString(node.first)},${this._dwindleShapeToString(node.second)})`;
}

export function _dwindleShapeFromString(str) {
    // Minimal recursive-descent parser for the encoding above. Leaves
    // are PLACEHOLDERS ({type:'leaf'} with no window) — only split
    // nodes' direction+ratio are ever consumed (by reconcile).
    if (typeof str !== 'string' || str.length === 0) return null;
    let i = 0;
    const parseNode = () => {
        if (i >= str.length) return null;
        const c = str[i];
        if (c === 'l') { i++; return { type: 'leaf' }; }
        if (c === 'e') { i++; return { type: 'empty' }; }
        if (c !== 'h' && c !== 'v') return null;
        const dir = c;
        i++;
        const start = i;
        while (i < str.length && /[0-9.]/.test(str[i])) i++;
        const ratio = parseFloat(str.substring(start, i));
        if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return null;
        if (str[i] !== '(') return null;
        i++;
        const first = parseNode();
        if (!first || str[i] !== ',') return null;
        i++;
        const second = parseNode();
        if (!second || str[i] !== ')') return null;
        i++;
        return { type: 'split', direction: dir, ratio, first, second };
    };
    try {
        const node = parseNode();
        return node && i === str.length ? node : null;
    } catch (_e) {
        return null;
    }
}

export function _reconcileTreeRatios(saved, live) {
    // Copy saved split ratios into the LIVE tree wherever the two
    // structures correspond (same direction down the path). A direction
    // mismatch means this branch's history diverged (different window
    // aspect / insert order) — stop descending there and keep the live
    // ratios. Never touches leaves. Returns true when anything changed.
    if (!saved || !live) return false;
    if (saved.type !== 'split' || live.type !== 'split') return false;
    if (saved.direction !== live.direction) return false;
    let changed = false;
    const r = Number(saved.ratio);
    if (Number.isFinite(r) && r > 0.02 && r < 0.98 &&
        Math.abs(live.ratio - r) > 0.0005) {
        live.ratio = r;
        changed = true;
    }
    changed = this._reconcileTreeRatios(saved.first, live.first) || changed;
    changed = this._reconcileTreeRatios(saved.second, live.second) || changed;
    return changed;
}

export function _findDirectionalTarget(win, direction, windows) {
    const f = win.get_frame_rect();
    let best = null;
    // bestOverlap starts at 0 (not -1): the acceptance test requires
    // overlap > bestOverlap + 5, so the OLD -1 made the first candidate
    // need overlap > 4 — tall narrow panes sharing only a few pixels of
    // edge were unnavigable by the focus/swap keybinds even when they
    // were the only neighbor in that direction (2026-10-04 audit).
    let bestOverlap = 0;
    let bestDist = Infinity;
    let bestPerp = Infinity;
    let bestHeight = -1;

    for (const w of windows) {
        if (w === win) continue;
        const r = w.get_frame_rect();
        if (r.width === 0 || r.height === 0) continue;

        let overlap, dist, perp;
        switch (direction) {
            case 'left':
                if (r.x + r.width > f.x) continue;
                overlap = Math.min(f.y + f.height, r.y + r.height) - Math.max(f.y, r.y);
                dist = f.x - (r.x + r.width);
                perp = Math.abs((f.y + f.height / 2) - (r.y + r.height / 2));
                break;
            case 'right':
                if (r.x < f.x + f.width) continue;
                overlap = Math.min(f.y + f.height, r.y + r.height) - Math.max(f.y, r.y);
                dist = r.x - (f.x + f.width);
                perp = Math.abs((f.y + f.height / 2) - (r.y + r.height / 2));
                break;
            case 'up':
                if (r.y + r.height > f.y) continue;
                overlap = Math.min(f.x + f.width, r.x + r.width) - Math.max(f.x, r.x);
                dist = f.y - (r.y + r.height);
                perp = Math.abs((f.x + f.width / 2) - (r.x + r.width / 2));
                break;
            case 'down':
                if (r.y < f.y + f.height) continue;
                overlap = Math.min(f.x + f.width, r.x + r.width) - Math.max(f.x, r.x);
                dist = r.y - (f.y + f.height);
                perp = Math.abs((f.x + f.width / 2) - (r.x + r.width / 2));
                break;
            default:
                return null;
        }
        if (overlap <= 0) continue;

        const sameHeight = Math.abs(r.height - bestHeight) <= 5;
        const overlapTie = Math.abs(overlap - bestOverlap) <= 5;
        const distTie = Math.abs(dist - bestDist) <= 5;
        if (overlap > bestOverlap + 5 ||
            (overlapTie && dist < bestDist - 5) ||
            (overlapTie && distTie &&
             ((!sameHeight && r.height > bestHeight) ||
              (sameHeight && perp < bestPerp)))) {
            bestOverlap = overlap;
            bestDist = dist;
            bestPerp = perp;
            bestHeight = r.height;
            best = w;
        }
    }
    return best;
}

export const bspMethods = {
    _bspGetTree,
    _bspMakeLeaf,
    _bspMakeSplit,
    _bspInsert,
    _bspRemove,
    _bspCollectWindows,
    _bspLayout,
    _bspFindPath,
    _bspFindLeaf,
    _bspSwapWindows,
    _bspFindLeafAtPoint,
    _bspReplaceLeaf,
    _bspTagGeometry,
    _bspInsertForWorkspace,
    _parseMinSizeOverrides,
    _getWindowMinSize,
    _treeMinSizes,
    _clampTreeToMinSizes,
    _adjustForConstraints,
    _dwindleShapeToString,
    _dwindleShapeFromString,
    _reconcileTreeRatios,
    _findDirectionalTarget,
};
