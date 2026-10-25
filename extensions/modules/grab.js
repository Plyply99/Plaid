// Grab-based mouse resize and swap: grab lifecycle, live resize loop,
// boundary enforcement, slot re-assert, and safe moves. Methods are attached
// to TilingWMExtension.prototype in extension.js.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

// --- Grab-Based Mouse Resize & Swap ---

export function _connectGrabSignals() {
    this._addSignal(global.display, global.display.connect('grab-op-begin', (_d, metaWindow, grabOp) => {
        if (metaWindow && this._gappedMaxSet && this._gappedMaxSet.has(metaWindow)) {
            this._debugLog('float maximize: drag exits gapped mode');
            this._gappedMaxSet.delete(metaWindow);
            this._floatMaxRects.delete(metaWindow);
        }
        if (!this._settings || !this._settings.get_boolean('mouse-resize')) return;
        if (!this._settings.get_boolean('enabled')) return;
        this._handleGrabBegin(metaWindow, grabOp);
    }));
    this._addSignal(global.display, global.display.connect('grab-op-end', (_d, metaWindow, grabOp) => {
        this._handleGrabEnd(metaWindow, grabOp);
    }));
    this._addSignal(global.display, global.display.connect('restacked', () => {
        this._syncBlurStacking();
        try { this._reassertFloatingTransients(); } catch (_e) {}
    }));
}

export function _computeGrabGraceThreshold() {
    try {
        const [px, py] = global.get_pointer();
        // get_monitor_at_point() does not exist on Meta.Display in
        // GNOME 50/51 — the old call threw (swallowed) and the grace
        // was pinned at 10px on every monitor. Find the monitor by
        // geometry containment instead.
        let mon = null;
        const n = global.display.get_n_monitors();
        for (let i = 0; i < n; i++) {
            const g = global.display.get_monitor_geometry(i);
            if (px >= g.x && px < g.x + g.width && py >= g.y && py < g.y + g.height) {
                mon = g;
                break;
            }
        }
        if (!mon)
            mon = global.display.get_monitor_geometry(global.display.get_primary_monitor());
        const minDim = Math.min(mon.width, mon.height);
        return Math.max(10, Math.min(30, Math.round(minDim / 100)));
    } catch (_e) {
        return 10;
    }
}

export function _handleGrabBegin(metaWindow, grabOp) {
    if (!metaWindow || metaWindow.get_window_type() !== Meta.WindowType.NORMAL) return;
    if (metaWindow.is_skip_taskbar()) return;
    const ws = metaWindow.get_workspace();
    if (!ws || ws !== global.workspace_manager.get_active_workspace()) return;

    const frame = metaWindow.get_frame_rect();
    const buffer = metaWindow.get_buffer_rect();
    if (!frame || frame.width === 0 || frame.height === 0 || !buffer) return;

    this._grabOp = grabOp;

    // Capture the pointer for every tracked grab — the move-grab path
    // (e.g. SSD titlebar clicks) must compare against the real click
    // position, not the constructor's zeroed coords.
    const [startX, startY] = global.get_pointer();
    this._grabStartX = startX;
    this._grabStartY = startY;
    this._grabGrace = this._computeGrabGraceThreshold();

    if (this._isResizeGrab(grabOp)) {
        this._grabWindow = metaWindow;
        const effect = this._windowMasks?.get(metaWindow);
        if (effect)
            effect.setBorderWidth(0);
    }

    const wmClass = metaWindow.get_wm_class_instance() || '?';
    this._debugLog(`GRAB_BEGIN win=${wmClass} rect=${JSON.stringify(frame)} grabOp=${grabOp} ` +
        `isResize=${this._isResizeGrab(grabOp)} isMove=${this._isMoveGrab(grabOp)} float=${this._isFloating(metaWindow)}`);

    if (this._isResizeGrab(grabOp) && !this._isFloating(metaWindow)) {
        const direction = (grabOp >> 12) & 0xF;
        this._grabWidthSign = (direction & 1) ? -1 : (direction & 2) ? 1 : 0;
        this._grabHeightSign = (direction & 8) ? -1 : (direction & 4) ? 1 : 0;
        const tree = this._bspGetTree(ws);
        this._grabResizeNodeW = null;
        this._grabResizeNodeH = null;
        this._grabInitialRatioW = 0;
        this._grabInitialRatioH = 0;

        if (tree) {
            const path = [];
            this._bspFindPath(tree, metaWindow, path);
            for (let i = path.length - 1; i >= 0; i--) {
                if (path[i].direction === 'h' && this._grabWidthSign !== 0 && !this._grabResizeNodeW) {
                    this._grabResizeNodeW = path[i];
                    this._grabInitialRatioW = path[i].ratio;
                    if (!this._bspFindPath(path[i].first, metaWindow, []))
                        this._grabWidthSign = -this._grabWidthSign;
                }
                if (path[i].direction === 'v' && this._grabHeightSign !== 0 && !this._grabResizeNodeH) {
                    this._grabResizeNodeH = path[i];
                    this._grabInitialRatioH = path[i].ratio;
                    if (!this._bspFindPath(path[i].first, metaWindow, []))
                        this._grabHeightSign = -this._grabHeightSign;
                }
            }
        }

        this._grabInitialMasterRatio = this._getMasterRatio(ws);
        const sr = this._getStackRatios(ws);
        this._grabInitialStackRatios = new Map(sr);

        this._startGrabLoop(metaWindow, 'resize');
        this._disconnectGrabBoundaryHooks();
        this._grabSizeChangedId = metaWindow.connect('size-changed', () =>
            this._enforceGrabBoundary(metaWindow));
        this._grabPositionChangedId = metaWindow.connect('position-changed', () =>
            this._enforceGrabBoundary(metaWindow));
    } else if (this._isMoveGrab(grabOp) && !this._isFloating(metaWindow)) {
        this._startGrabLoop(metaWindow, 'move');
    } else {
        this._grabOp = null;
        this._grabWindow = null;
    }
}

export function _handleGrabEnd(metaWindow, grabOp) {
    const wasTracking = this._grabOp !== null;

    if (wasTracking && metaWindow && !this._isFloating(metaWindow)) {
        const ws = metaWindow.get_workspace();
        if (ws) {
            if (this._isMoveGrab(grabOp)) {
                // Click-vs-drag guard: a titlebar click on a decorated
                // window starts a move grab with no real movement — only
                // reposition when the pointer actually travelled.
                try {
                    const [ex, ey] = global.get_pointer();
                    const dx = ex - this._grabStartX;
                    const dy = ey - this._grabStartY;
                    const grace = this._grabGrace ?? 10;
                    if (Math.hypot(dx, dy) >= grace)
                        this._repositionWindow(metaWindow, ws);
                } catch (_e) {}
            }
            this._retileWorkspace(ws);
            try { metaWindow.raise(); } catch (_e) {}
        }
    }

    if (wasTracking && metaWindow)
        this._kickMaskNow(metaWindow);

    if (wasTracking && metaWindow) {
        const wmClass = metaWindow.get_wm_class_instance() || '?';
        const ws = metaWindow.get_workspace();
        if (ws) {
            const tree = this._bspGetTree(ws);
            const treeWins = tree ? this._bspCollectWindows(tree) : [];
            const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
            this._debugLog(`GRAB_END win=${wmClass} treeWins=[${treeWins.map(w => w.get_wm_class_instance() || '?').join(',')}] ` +
                `tiled=[${tiled.map(w => w.get_wm_class_instance() || '?').join(',')}]`);
        }
    }

    this._hideDropPreview();
    this._stopLiveResizeLoop();
    this._disconnectGrabBoundaryHooks();
    this._grabOp = null;
    this._grabWindow = null;
    this._grabInitialStackRatios = null;
    this._startBorderAnimation();
}

export function _isResizeGrab(grabOp) {
    // MetaGrabOp is bitfield-encoded (identical on mutter 18 and 51):
    // WINDOW_BASE=1, direction in bits 12-15 (W=1,E=2,S=4,N=8).
    // Resize ops have direction bits; move ops have none.
    if (grabOp === Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN) return true;
    if (grabOp === Meta.GrabOp.NONE) return false;
    const direction = (grabOp >> 12) & 0xF;
    return (grabOp & 1) !== 0 && direction !== 0;
}

export function _isMoveGrab(grabOp) {
    if (grabOp === Meta.GrabOp.NONE) return false;
    if (grabOp === Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN) return false;
    const direction = (grabOp >> 12) & 0xF;
    return (grabOp & 1) !== 0 && direction === 0;
}

export function _startGrabLoop(metaWindow, mode) {
    this._stopLiveResizeLoop();

    const ws = metaWindow.get_workspace();

    this._liveResizeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
        if (!this._settings || !metaWindow || !this._grabOp) {
            this._liveResizeId = 0;
            return GLib.SOURCE_REMOVE;
        }
        const frame = metaWindow.get_frame_rect();
        if (frame.width === 0 || frame.height === 0) return GLib.SOURCE_CONTINUE;

        if (mode === 'resize') {
            const [curX, curY] = global.get_pointer();
            const dx = curX - this._grabStartX;
            const dy = curY - this._grabStartY;

            const gap = this._settings.get_int('inside-gap');
            const monitor = global.display.get_primary_monitor();
            const workArea = ws.get_work_area_for_monitor(monitor);
            if (!workArea) return GLib.SOURCE_CONTINUE;

            const layout = this._getWorkspaceLayout(ws);
            if (layout === 'dwindle') {
                const tree = this._bspGetTree(ws);
                if (tree) {
                    const area = this._outsideArea(workArea);
                    if (!area) return GLib.SOURCE_CONTINUE;
                    const areaX = area.x;
                    const areaY = area.y;
                    const areaW = area.w;
                    const areaH = area.h;

                    this._treeMinSizes(tree, gap);
                    if (this._grabResizeNodeW) {
                        const axis = this._grabResizeNodeW._w;
                        if (axis - gap > 0) {
                            const axisSize = axis - gap;
                            const minW1 = this._grabResizeNodeW.first?._minW || 0;
                            const minW2 = this._grabResizeNodeW.second?._minW || 0;
                            const minRatio = minW1 / axisSize;
                            const maxRatio = 1 - minW2 / axisSize;
                            const lo = maxRatio <= minRatio
                                ? (minW1 + minW2 > 0 ? minW1 / (minW1 + minW2) : 0.15) : minRatio;
                            const hi = maxRatio <= minRatio ? lo : maxRatio;
                            const raw = this._grabInitialRatioW + (dx * this._grabWidthSign) / axisSize;
                            if (Number.isFinite(raw))
                                this._grabResizeNodeW.ratio = Math.max(lo, Math.min(hi, raw));
                        }
                    }
                    if (this._grabResizeNodeH) {
                        const axis = this._grabResizeNodeH._h;
                        if (axis - gap > 0) {
                            const axisSize = axis - gap;
                            const minH1 = this._grabResizeNodeH.first?._minH || 0;
                            const minH2 = this._grabResizeNodeH.second?._minH || 0;
                            const minRatio = minH1 / axisSize;
                            const maxRatio = 1 - minH2 / axisSize;
                            const lo = maxRatio <= minRatio
                                ? (minH1 + minH2 > 0 ? minH1 / (minH1 + minH2) : 0.15) : minRatio;
                            const hi = maxRatio <= minRatio ? lo : maxRatio;
                            const raw = this._grabInitialRatioH + (dy * this._grabHeightSign) / axisSize;
                            if (Number.isFinite(raw))
                                this._grabResizeNodeH.ratio = Math.max(lo, Math.min(hi, raw));
                        }
                    }
                    this._bspTagGeometry(tree, areaX, areaY, areaW, areaH, gap);
                }
            } else if (layout === 'master-stack' || layout === 'centered-master-stack') {
                const area = this._outsideArea(workArea);
                if (!area) return GLib.SOURCE_CONTINUE;
                const areaW = area.w;
                const areaH = area.h;

                if (this._grabWidthSign !== 0) {
                    const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
                    const idx = tiled.indexOf(metaWindow);
                    this._debugLog(`MS_RESIZE dx=${dx} dy=${dy} wSign=${this._grabWidthSign} hSign=${this._grabHeightSign} ` +
                        `idx=${idx} numTiled=${tiled.length} initMasterRatio=${this._grabInitialMasterRatio.toFixed(3)}`);
                    let sign = this._grabWidthSign;
                    if (idx > 0) sign = -sign;
                    const masterDenom = layout === 'centered-master-stack' ? areaW - gap * 2 : areaW - gap;
                    if (masterDenom > 0) {
                        let ratioDelta = (dx * sign) / masterDenom;
                        if (layout === 'centered-master-stack' && idx > 0)
                            ratioDelta *= 2;
                        const newRatio = this._grabInitialMasterRatio + ratioDelta;
                        const masterMin = tiled.length > 0 ? (this._getWindowMinSize(tiled[0]).w || 0) : 0;
                        let stackMinW = 0;
                        for (let i = 1; i < tiled.length; i++)
                            stackMinW = Math.max(stackMinW, this._getWindowMinSize(tiled[i]).w || 0);
                        let lo = masterMin / masterDenom;
                        let hi = 1 - stackMinW / masterDenom;
                        if (layout === 'centered-master-stack') {
                            const numStack = tiled.length - 1;
                            const leftCount = Math.ceil(numStack / 2);
                            let leftMinW = 0;
                            let rightMinW = 0;
                            for (let i = 1; i < tiled.length; i++) {
                                const m = this._getWindowMinSize(tiled[i]).w || 0;
                                if (i <= leftCount) leftMinW = Math.max(leftMinW, m);
                                else rightMinW = Math.max(rightMinW, m);
                            }
                            hi = 1 - 2 * Math.max(leftMinW, rightMinW) / masterDenom;
                        }
                        if (hi <= lo) { lo = 0.5; hi = 0.5; }
                        if (Number.isFinite(newRatio))
                            this._masterRatios.set(this._wsIndex(ws), Math.max(lo, Math.min(hi, newRatio)));
                    }
                }
                if (this._grabHeightSign !== 0) {
                    const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
                    const idx = tiled.indexOf(metaWindow);
                    if (idx > 0 && this._grabInitialStackRatios) {
                        this._debugLog(`MS_HEIGHT idx=${idx} dy=${dy} hSign=${this._grabHeightSign} ` +
                            `initStackRatios=[${[...this._grabInitialStackRatios.entries()].map(([k,v])=>`${k}:${v.toFixed(2)}`).join(',')}]`);
                        const numStack = tiled.length - 1;
                        const gapTotal = gap * (numStack - 1);
                        const totalStackH = areaH - gapTotal;
                        if (totalStackH > 0 && numStack > 1) {
                            const stackRatios = this._getStackRatios(ws);
                            const draggedStackIdx = idx - 1;
                            const pixelDelta = dy * this._grabHeightSign;
                            const otherDelta = -pixelDelta / (numStack - 1);
                            let initTotal = 0;
                            for (let j = 0; j < numStack; j++)
                                initTotal += this._grabInitialStackRatios.has(j)
                                    ? this._grabInitialStackRatios.get(j) : 1.0;
                            const newHeights = [];
                            for (let j = 0; j < numStack; j++) {
                                const initW = this._grabInitialStackRatios.has(j)
                                    ? this._grabInitialStackRatios.get(j) : 1.0;
                                const initH = totalStackH * initW / initTotal;
                                const delta = j === draggedStackIdx ? pixelDelta : otherDelta;
                                const minH = tiled.length > j + 1
                                    ? (this._getWindowMinSize(tiled[j + 1]).h || 0) : 0;
                                newHeights.push(Math.max(minH, initH + delta));
                            }
                            const newTotalH = newHeights.reduce((a, b) => a + b, 0);
                            if (newTotalH > 0) {
                                for (let j = 0; j < numStack; j++) {
                                    const newW = newHeights[j] / newTotalH * numStack;
                                    stackRatios.set(j, Math.max(0.1, newW));
                                }
                            }
                        } else if (totalStackH > 0) {
                            const initialWeight = this._grabInitialStackRatios.has(idx - 1)
                                ? this._grabInitialStackRatios.get(idx - 1) : 1.0;
                            const minH = tiled.length > idx
                                ? (this._getWindowMinSize(tiled[idx]).h || 0) : 0;
                            const minWeight = totalStackH > 0 ? minH / totalStackH * numStack : 0.1;
                            const newWeight = Math.max(Math.max(0.1, minWeight),
                                initialWeight + (dy * this._grabHeightSign) / totalStackH * numStack);
                            const stackRatios = this._getStackRatios(ws);
                            stackRatios.set(idx - 1, newWeight);
                            this._scheduleSaveLayouts();
                        }
                    }
                }
            }

            this._moveTiledExcept(metaWindow);
            this._enforceGrabBoundary(metaWindow);
            this._updateBordersDuringGrab();
        } else if (mode === 'move') {
            this._updateMoveDragPreview(metaWindow);
        }

        return GLib.SOURCE_CONTINUE;
    });
}

export function _stopLiveResizeLoop() {
    if (this._liveResizeId) {
        GLib.source_remove(this._liveResizeId);
        this._liveResizeId = 0;
    }
}

export function _moveTiledExcept(skipWindow) {
    const ws = skipWindow.get_workspace();
    if (!ws) return;
    const gap = this._settings.get_int('inside-gap');
    const monitor = global.display.get_primary_monitor();
    const workArea = ws.get_work_area_for_monitor(monitor);
    if (!workArea) return;

    const layout = this._getWorkspaceLayout(ws);
    if (layout === 'floating') return;
    if (layout === 'dwindle') {
        const tree = this._bspGetTree(ws);
        if (!tree) return;
        const treeWins = this._bspCollectWindows(tree);
        if (!treeWins.includes(skipWindow)) return;
        const area = this._outsideArea(workArea);
        if (!area) return;
        this._bspLayout(tree, area.x, area.y, area.w, area.h, gap, skipWindow);
    } else {
        const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
        if (tiled.length <= 1) return;
        if (layout === 'centered-master-stack')
            this._retileCenteredMasterStack(ws, tiled, skipWindow);
        else
            this._retileMasterStack(ws, tiled, skipWindow);
    }
}

export function _windowSlotRect(win, ws, layout, workArea, insideGap) {
    if (!this._isValidWorkArea(workArea)) return null;
    if (layout === 'floating') return null;
    // A single tiled window's slot IS its placement rect — the layouts
    // place the lone window via _singleWindowRect (the work area inset
    // by the per-edge outside-gap-* settings). The slot must agree
    // EXACTLY or the re-assert/verification machinery sees a phantom mismatch
    // (or, for dwindle, no slot at all — the BSP tree is never built
    // for a single window, so the tree branch returned null and every
    // settle re-assert silently no-oped while the window sat off-slot).
    if (this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w)).length === 1)
        return this._singleWindowRect(workArea);
    const area = this._outsideArea(workArea);
    if (!area) return null;
    const { x: areaX, y: areaY, w: areaW, h: areaH } = area;
    const gap = insideGap;
    if (areaW <= 0 || areaH <= 0) return null;

    if (layout === 'dwindle') {
        const tree = this._bspGetTree(ws);
        if (!tree) return null;
        const leaf = this._bspFindLeaf(tree, win);
        if (!leaf || leaf._w === undefined) return null;
        const r = { x: leaf._x, y: leaf._y, w: leaf._w, h: leaf._h };
        if (!(r.w > 0) || !(r.h > 0) || !Number.isFinite(r.x + r.y + r.w + r.h)) return null;
        // Insurance: never report a slot narrower than the window's
        // minimum — the layout clamps, so verdicts must agree.
        const min = this._getWindowMinSize(win);
        if (min.w > 0 && r.w < min.w) r.w = Math.min(min.w, areaW);
        if (min.h > 0 && r.h < min.h) r.h = Math.min(min.h, areaH);
        return r;
    }

    const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
    const idx = tiled.indexOf(win);
    if (idx === -1) return null;

    const masterRatio = this._getMasterRatio(ws);
    const numStack = tiled.length - 1;
    const stackRatios = this._getStackRatios(ws);

    let masterX, masterW, stackX, stackW, stackIdx, colCount, colWeights;
    if (layout === 'centered-master-stack') {
        masterW = Math.floor((areaW - gap * 2) * masterRatio);
        masterX = areaX + Math.floor((areaW - masterW) / 2);
        if (idx === 0) {
            const r = { x: masterX, y: areaY, w: masterW, h: areaH };
            return this._minClampSlot(r, win, areaW, areaH);
        }
        const leftCount = Math.ceil(numStack / 2);
        const stackIdxIn = idx - 1;
        if (stackIdxIn < leftCount) {
            stackX = areaX;
            stackW = masterX - areaX - gap;
            stackIdx = stackIdxIn;
            colCount = leftCount;
        } else {
            stackX = masterX + masterW + gap;
            stackW = areaX + areaW - stackX;
            stackIdx = stackIdxIn - leftCount;
            colCount = numStack - leftCount;
        }
        colWeights = [];
        for (let i = 0; i < colCount; i++)
            colWeights.push(stackRatios.has(stackIdxIn - stackIdx + i) ? stackRatios.get(stackIdxIn - stackIdx + i) : 1.0);
    } else {
        masterW = Math.floor((areaW - gap) * masterRatio);
        masterX = areaX;
        if (idx === 0) {
            const r = { x: areaX, y: areaY, w: masterW, h: areaH };
            return this._minClampSlot(r, win, areaW, areaH);
        }
        stackX = areaX + masterW + gap;
        stackW = areaW - masterW - gap;
        stackIdx = idx - 1;
        colCount = numStack;
        colWeights = [];
        for (let i = 0; i < colCount; i++)
            colWeights.push(stackRatios.has(i) ? stackRatios.get(i) : 1.0);
    }

    if (stackW <= 0 || colCount === 0) return null;
    const totalWeight = colWeights.reduce((a, b) => a + b, 0);
    if (!(totalWeight > 0) || !Number.isFinite(totalWeight)) return null;
    const totalColH = areaH - gap * (colCount - 1);
    let y = areaY;
    for (let i = 0; i < colCount; i++) {
        const isLast = i === colCount - 1;
        const h = isLast
            ? (areaY + areaH - y)
            : Math.floor(totalColH * colWeights[i] / totalWeight);
        if (i === stackIdx) {
            const r = { x: stackX, y, w: stackW, h };
            if (!(r.w > 0) || !(r.h > 0) || !Number.isFinite(r.x + r.y + r.w + r.h)) return null;
            return this._minClampSlot(r, win, areaW, areaH);
        }
        y += h + gap;
    }
    return null;
}

export function _enforceGrabBoundary(win) {
    try {
        if (!this._settings || !this._grabOp || !win) return;
        const ws = win.get_workspace();
        if (!ws) return;
        const gap = this._settings.get_int('inside-gap');
        const monitor = global.display.get_primary_monitor();
        let workArea = null;
        try { workArea = ws.get_work_area_for_monitor(monitor); } catch (_e) {}
        if (!workArea || workArea.width === 0) return;
        const layout = this._getWorkspaceLayout(ws);
        const boundary = this._windowSlotRect(win, ws, layout, workArea, gap);
        if (!boundary) return;
        const f = win.get_frame_rect();
        if (f.width === 0 || f.height === 0) return;
        let nx = f.x, ny = f.y, nw = f.width, nh = f.height;
        const wOut = this._grabWidthSign > 0
            ? (f.x + f.width > boundary.x + boundary.w + 1)
            : this._grabWidthSign < 0
                ? (f.x < boundary.x - 1 || f.x + f.width > boundary.x + boundary.w + 1)
                : false;
        const hOut = this._grabHeightSign > 0
            ? (f.y + f.height > boundary.y + boundary.h + 1)
            : this._grabHeightSign < 0
                ? (f.y < boundary.y - 1 || f.y + f.height > boundary.y + boundary.h + 1)
                : false;
        if (wOut) { nx = boundary.x; nw = boundary.w; }
        if (hOut) { ny = boundary.y; nh = boundary.h; }
        if (wOut || hOut)
            this._safeMove(win, nx, ny, nw, nh);
    } catch (_e) {}
}

export function _disconnectGrabBoundaryHooks() {
    const win = this._grabWindow;
    if (this._grabSizeChangedId) {
        if (win) {
            win.disconnect(this._grabSizeChangedId);
        }
        this._grabSizeChangedId = 0;
    }
    if (this._grabPositionChangedId) {
        if (win) {
            win.disconnect(this._grabPositionChangedId);
        }
        this._grabPositionChangedId = 0;
    }
}

export function _maybeReassertSlot(win, tol = 16, mode = 'retile') {
    if (!this._settings) return;
    if (!this._settings.get_boolean('enabled')) return;
    if (this._grabOp) return;
    if (!win || win.is_fullscreen() || win.minimized) return;
    if (this._isFloating(win)) return;
    if (!this._windowWorkspaces.has(win)) return;
    // Timestamp gate: size-changed fires per move/resize step and the
    // full slot computation is O(n²) per retile — skip re-checks for the
    // same window within 250ms (the retile verify covers the rest).
    // NOTE: the gate is only READ here — the timestamp is recorded
    // AFTER the animating block below, so a retile-mode call that only
    // queues (and does no work) no longer refreshes the gate and starve
    // a direct correction queued behind it. Consecutive acting calls
    // stay debounced (the client-fight protection).
    const now = Date.now();
    if (this._slotReassertTimes) {
        const last = this._slotReassertTimes.get(win);
        if (last && now - last < 250) return;
    }
    if (this._animating) {
        // Direct mode must NOT queue: the settle re-assert of a freshly
        // placed window can be starved by other workspaces' retile
        // animation churn (ws1's constant 1s animations) — the queued
        // ws drains into another animated retile that re-loses the
        // client-resize race. A direct re-place is safe mid-animation
        // (it only moves one window; it does not touch the retile
        // machinery).
        if (mode === 'direct') {
            // fall through to the direct check below
        } else {
            const ws = win.get_workspace();
            if (ws && this._queuedAnimWorkspaces) this._queuedAnimWorkspaces.add(ws);
            return;
        }
    }
    if (this._slotReassertTimes) this._slotReassertTimes.set(win, now);
    const ws = win.get_workspace();
    if (!ws) return;
    const gap = this._settings.get_int('inside-gap');
    const monitor = global.display.get_primary_monitor();
    let workArea = null;
    try { workArea = ws.get_work_area_for_monitor(monitor); } catch (_e) {}
    if (!workArea || workArea.width === 0) return;
    const layout = this._getWorkspaceLayout(ws);
    if (layout === 'floating') return;
    const slot = this._windowSlotRect(win, ws, layout, workArea, gap);
    if (!slot) return;
    const f = win.get_frame_rect();
    if (f.width === 0 || f.height === 0) return;
    let off = Math.abs(f.width - slot.w) > tol || Math.abs(f.height - slot.h) > tol ||
        Math.abs(f.x - slot.x) > tol || Math.abs(f.y - slot.y) > tol;
    if (!off && win.get_client_type() !== Meta.WindowClientType.X11) {
        // Surface divergence: a Wayland client (Firefox's session
        // restore) can re-commit its buffer at a SMALLER size after the
        // placement while the compositor keeps the FRAME at the placed
        // geometry — the frame rect then lies about the visible window
        // (every frame-based check passes, the content renders short).
        // A healthy Wayland buffer ≥ frame (shadow margins); buffer <
        // frame = the client shrank its surface → treat as off-slot.
        // (X11 SSD frames legitimately exceed the buffer — excluded.)
        const buffer = win.get_buffer_rect();
        if (buffer.width > 0 && (buffer.width < f.width || buffer.height < f.height)) {
            // Strike bound: the frame is ALREADY in slot here (this
            // branch only runs when the frame check passed), so the
            // correction below is a fresh configure of the identical
            // rect — the Firefox-restore client obeys it (surface
            // heals → counter resets), but a client that structurally
            // never fills its frame (pascube (GTK3): committing a
            // surface 37px shorter than the frame, top
            // inset only, from first placement) makes every re-place a
            // no-op: without the bound the settle window burns ~12
            // futile moves + log lines fighting a fight it cannot win.
            const strikes = (win._plaidSurfaceStrikes || 0) + 1;
            win._plaidSurfaceStrikes = strikes;
            if (strikes > 3) {
                if (strikes === 4)
                    this._debugLog(`surface divergence: accepting client geometry for ${win.get_wm_class_instance() || '?'} ` +
                        `frame=(${f.x},${f.y},${f.width},${f.height}) buffer=(${buffer.x},${buffer.y},${buffer.width},${buffer.height})`);
                return;
            }
            this._debugLog(`slot re-assert (surface): ${win.get_wm_class_instance() || '?'} frame=(${f.x},${f.y},${f.width},${f.height}) ` +
                `buffer=(${buffer.x},${buffer.y},${buffer.width},${buffer.height}) slot=(${slot.x},${slot.y},${slot.w},${slot.h}) (strike ${strikes}/3)`);
            off = true;
        } else {
            // Surface (re)covered the frame — forget past strikes so a
            // later genuine shrink (Firefox restore round 2) gets a
            // fresh correction budget.
            win._plaidSurfaceStrikes = 0;
        }
    }
    if (off) {
        if (mode === 'direct') {
            // Direct re-place: forces a fresh configure the client must
            // obey (the maximize-keybind path) — silent, unanimated, no
            // verify/float machinery, so it cannot re-lose the race.
            this._debugLog(`slot re-assert: ${win.get_wm_class_instance() || '?'} frame=(${f.x},${f.y},${f.width},${f.height}) slot=(${slot.x},${slot.y},${slot.w},${slot.h})`);
            try {
                win.move_resize_frame(true, slot.x, slot.y, slot.w, slot.h);
                this._scheduleBorders();
            } catch (_e) {}
        } else {
            this._debugLog(`slot re-assert: ${win.get_wm_class_instance() || '?'} frame=(${f.x},${f.y},${f.width},${f.height}) slot=(${slot.x},${slot.y},${slot.w},${slot.h})`);
            this._scheduleRetile(ws);
        }
    }
}

export function _safeMove(win, x, y, w, h) {
    if (!win || win.is_fullscreen() || !win.get_workspace()) return;
    if (!(w > 0) || !(h > 0)) return;
    if (!Number.isFinite(x + y + w + h)) return;
    if (this._animTargets) {
        this._animTargets.set(win, { x, y, w, h });
        return;
    }
    try {
        const actor = win.get_compositor_private();
        if (actor) actor.remove_all_transitions();
        win.move_resize_frame(true, x, y, w, h);
    } catch (e) {
        log(`[plaid] _safeMove FAILED: ${win.get_wm_class_instance() || '?'} to ${x},${y} ${w}x${h}: ${e.message}`);
    }
}

// --- Pick Mode ---
export const grabMethods = {
    _connectGrabSignals,
    _computeGrabGraceThreshold,
    _handleGrabBegin,
    _handleGrabEnd,
    _isResizeGrab,
    _isMoveGrab,
    _startGrabLoop,
    _stopLiveResizeLoop,
    _moveTiledExcept,
    _windowSlotRect,
    _enforceGrabBoundary,
    _disconnectGrabBoundaryHooks,
    _maybeReassertSlot,
    _safeMove,
};
