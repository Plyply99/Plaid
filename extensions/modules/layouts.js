// Workspace retile orchestration and the master-stack / dwindle layout
// implementation. Methods are attached to TilingWMExtension.prototype in
// extension.js.

export function _retileAll() {
    if (!this._settings) return;
    for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
        const w = global.workspace_manager.get_workspace_by_index(i);
        this._scheduleRetile(w);
    }
    this._scheduleBorders();
}

export function _retileWorkspace(workspace) {
    if (!this._settings) return;
    this._scheduleRetile(workspace);
}

export function _doRetileWorkspace(workspace) {
    if (!this._settings) return;
    if (!this._settings.get_boolean('enabled')) {
        return;
    }
    if (this._grabOp) return;
    const tiledWindows = this._getWindowsForWorkspace(workspace)
        .filter(w => !this._isFloating(w));
    if (tiledWindows.length === 0) {
        return;
    }
    // Work-area guard: at login/monitor reconfig mutter can return a
    // degenerate rect (a (5,4,1,1) garbage work area drove a
    // false 1x1-slot retile that floated Firefox). Bail — the
    // monitors-changed handler re-retiles once monitors settle, and the
    // settle/re-assert machinery covers the gap.
    const monIdx = global.display.get_primary_monitor();
    let workArea = null;
    try { workArea = workspace.get_work_area_for_monitor(monIdx); } catch (_e) {}
    if (!this._isValidWorkArea(workArea)) {
        this._debugLog(`retile: skipped ws=${this._wsIndex(workspace)} (work area not ready)`);
        return;
    }
    this._debugLog(`retile: ws=${this._wsIndex(workspace)} tiled=[${tiledWindows.map(w => w.get_wm_class_instance() || '?').join(',')}] ` +
        `layout=${this._getWorkspaceLayout(workspace)} animTime=${this._getAnimationTime().toFixed(2)} animating=${this._animating}`);

    if (this._getAnimationTime() > 0 && !this._grabOp) {
        this._animRetile(workspace, tiledWindows);
        return;
    }
    // NOTE: the instant (non-animated) retile branch that once lived
    // here was DEAD CODE — _getAnimationTime() floors at 0.1 by design
    // (never gate placement on St.Settings.enable_animations), so the
    // animated path above is the only one that runs. The dead branch
    // (direct retile + the _verifyRetileLandings check) was deleted; the
    // animated path's completion (dec()) covers the _newWindowSet cleanup,
    // the borders refresh, and the debounced layout save.
}

// --- Animation ---



export function _getMasterRatio(ws) {
    const idx = this._wsIndex(ws);
    if (!this._masterRatios.has(idx)) {
        let ratio = 0.5;
        if (this._persistedMasterByIndex) {
            const rule = this._persistedMasterByIndex.get(idx);
            if (rule !== undefined) ratio = rule;
        }
        this._masterRatios.set(idx, ratio);
    }
    return this._masterRatios.get(idx);
}

export function _getStackRatios(ws) {
    const idx = this._wsIndex(ws);
    if (!this._stackRatios.has(idx)) {
        const map = new Map();
        if (this._persistedStackByIndex) {
            const rule = this._persistedStackByIndex.get(idx);
            if (rule) {
                for (const [k, v] of rule)
                    map.set(k, v);
            }
        }
        this._stackRatios.set(idx, map);
    }
    return this._stackRatios.get(idx);
}

export function _clampMasterStackRatios(ws, tiledWindows, areaW, gap, centered) {
    if (!tiledWindows || tiledWindows.length < 2) return;
    const masterMin = this._getWindowMinSize(tiledWindows[0]).w || 0;
    let stackMinW = 0;
    for (let i = 1; i < tiledWindows.length; i++)
        stackMinW = Math.max(stackMinW, this._getWindowMinSize(tiledWindows[i]).w || 0);
    const basis = centered ? areaW - gap * 2 : areaW - gap;
    if (basis <= 0) return;
    let lo = masterMin / basis;
    let hi = 1 - stackMinW / basis;
    if (centered) {
        // The stack splits into two side columns, each roughly half the
        // remaining width — a window in one column needs double the
        // headroom the flat bound assumes.
        const numStack = tiledWindows.length - 1;
        const leftCount = Math.ceil(numStack / 2);
        let leftMinW = 0;
        let rightMinW = 0;
        for (let i = 1; i < tiledWindows.length; i++) {
            const m = this._getWindowMinSize(tiledWindows[i]).w || 0;
            if (i <= leftCount) leftMinW = Math.max(leftMinW, m);
            else rightMinW = Math.max(rightMinW, m);
        }
        hi = 1 - 2 * Math.max(leftMinW, rightMinW) / basis;
    }
    const ratio = this._getMasterRatio(ws);
    let clamped;
    if (hi <= lo) {
        const need = masterMin + stackMinW;
        // A master window without a min-size hint would clamp to
        // 0 / stackMinW = 0 here (a zero-width master pane that the
        // landing verify can never satisfy) — fall back to a sane
        // 50/50 split instead.
        clamped = (need > 0 && masterMin > 0) ? masterMin / need : 0.5;
    } else {
        clamped = Math.max(lo, Math.min(hi, ratio));
    }
    this._masterRatios.set(this._wsIndex(ws), clamped);
    this._scheduleSaveLayouts();
}

export function _retileMasterStack(workspace, tiledWindows, skipWindow = null) {
    const gap = this._settings.get_int('inside-gap');
    const monitor = global.display.get_primary_monitor();
    const workArea = workspace.get_work_area_for_monitor(monitor);
    if (!workArea) return;

    const numWindows = tiledWindows.length;

    if (numWindows === 1) {
        const rect = this._singleWindowRect(workArea);
        if (rect)
            this._moveWindow(tiledWindows[0], rect.x, rect.y, rect.w, rect.h);
        return;
    }

    const area = this._outsideArea(workArea);
    if (!area) return;
    const areaX = area.x;
    const areaY = area.y;
    const areaW = area.w;
    const areaH = area.h;
    this._clampMasterStackRatios(workspace, tiledWindows, areaW, gap, false);
    const masterRatio = this._getMasterRatio(workspace);
    const masterW = Math.floor((areaW - gap) * masterRatio);
    const stackW = areaW - masterW - gap;
    const numStack = numWindows - 1;

    if (tiledWindows[0] !== skipWindow)
        this._moveWindow(tiledWindows[0], areaX, areaY, masterW, areaH);

    const stackRatios = this._getStackRatios(workspace);
    const weights = [];
    let totalWeight = 0;
    for (let i = 0; i < numStack; i++) {
        const w = stackRatios.has(i) ? stackRatios.get(i) : 1.0;
        weights.push(w);
        totalWeight += w;
    }

    const totalStackH = areaH - gap * (numStack - 1);

    if (skipWindow && numStack > 1) {
        const draggedIdx = tiledWindows.indexOf(skipWindow) - 1;
        if (draggedIdx >= 0) {
            const draggedH = skipWindow.get_frame_rect().height;
            const availableForOthers = areaH - draggedH - gap * (numStack - 1);
            if (availableForOthers > 0) {
                let otherWeightSum = 0;
                for (let i = 0; i < numStack; i++) {
                    if (i !== draggedIdx) otherWeightSum += weights[i];
                }
                const scale = otherWeightSum > 0 ? availableForOthers / otherWeightSum : 1;
                let y = areaY;
                for (let i = 0; i < numStack; i++) {
                    const isLast = i === numStack - 1;
                    const win = tiledWindows[i + 1];
                    let h;
                    if (i === draggedIdx) {
                        h = draggedH;
                    } else if (isLast) {
                        h = Math.max(10, areaY + areaH - y);
                    } else {
                        h = Math.max(this._getWindowMinSize(win).h || 0, Math.floor(weights[i] * scale));
                        if (y + h > areaY + areaH) h = Math.max(10, areaY + areaH - y);
                    }
                    if (win !== skipWindow)
                        this._moveWindow(win, areaX + masterW + gap, y, stackW, h);
                    else
                        this._moveWindow(win, areaX + masterW + gap, y, stackW, draggedH);
                    if (!isLast) y += h + gap;
                }
                return;
            }
        }
    }

    let y = areaY;
    for (let i = 0; i < numStack; i++) {
        const isLast = i === numStack - 1;
        const win = tiledWindows[i + 1];
        const minH = this._getWindowMinSize(win).h || 0;
        let h = isLast
            ? Math.max(10, areaY + areaH - y)
            : Math.max(minH, Math.floor(totalStackH * weights[i] / totalWeight));
        if (!isLast && y + h > areaY + areaH) h = Math.max(10, areaY + areaH - y);
        if (win !== skipWindow)
            this._moveWindow(win, areaX + masterW + gap, y, stackW, h);
        else
            this._moveWindow(win, areaX + masterW + gap, y, stackW, win.get_frame_rect().height);
        if (!isLast) {
            if (win === skipWindow) {
                const frame = win.get_frame_rect();
                y += frame.height + gap;
            } else {
                y += h + gap;
            }
        }
    }
}

export function _retileCenteredMasterStack(workspace, tiledWindows, skipWindow = null) {
    const gap = this._settings.get_int('inside-gap');
    const monitor = global.display.get_primary_monitor();
    const workArea = workspace.get_work_area_for_monitor(monitor);
    if (!workArea) return;

    const numWindows = tiledWindows.length;

    if (numWindows === 1) {
        const rect = this._singleWindowRect(workArea);
        if (rect)
            this._moveWindow(tiledWindows[0], rect.x, rect.y, rect.w, rect.h);
        return;
    }

    const area = this._outsideArea(workArea);
    if (!area) return;
    const areaX = area.x;
    const areaY = area.y;
    const areaW = area.w;
    const areaH = area.h;
    this._clampMasterStackRatios(workspace, tiledWindows, areaW, gap, true);
    const numStack = numWindows - 1;
    const leftCount = Math.ceil(numStack / 2);
    const rightCount = numStack - leftCount;

    let masterX, masterW;
    if (skipWindow && numStack > 0) {
        if (tiledWindows[0] === skipWindow) {
            const frame = skipWindow.get_frame_rect();
            masterX = frame.x;
            masterW = frame.width;
            const effectiveRatio = masterW / (areaW - gap * 2);
            this._masterRatios.set(this._wsIndex(workspace), Math.max(0.15, Math.min(0.85, effectiveRatio)));
        } else {
            const masterRatio = this._getMasterRatio(workspace);
            masterW = Math.floor((areaW - gap * 2) * masterRatio);
            masterX = areaX + Math.floor((areaW - masterW) / 2);
        }
    } else {
        const masterRatio = this._getMasterRatio(workspace);
        masterW = Math.floor((areaW - gap * 2) * masterRatio);
        masterX = areaX + Math.floor((areaW - masterW) / 2);
    }
    const leftStackW = masterX - areaX - gap;
    const rightStackX = masterX + masterW + gap;
    const rightStackW = areaX + areaW - rightStackX;

    if (tiledWindows[0] !== skipWindow)
        this._moveWindow(tiledWindows[0], masterX, areaY, masterW, areaH);

    const stackRatios = this._getStackRatios(workspace);
    const leftWeights = [];
    let leftTotal = 0;
    for (let i = 0; i < leftCount; i++) {
        const w = stackRatios.has(i) ? stackRatios.get(i) : 1.0;
        leftWeights.push(w);
        leftTotal += w;
    }
    const rightWeights = [];
    let rightTotal = 0;
    for (let i = 0; i < rightCount; i++) {
        const w = stackRatios.has(leftCount + i) ? stackRatios.get(leftCount + i) : 1.0;
        rightWeights.push(w);
        rightTotal += w;
    }

    const _layoutStack = (stackWindows, stackWeights, stackTotal, x, w) => {
        if (stackWindows.length === 0) return;
        const count = stackWindows.length;
        const totalStackH = areaH - gap * (count - 1);
        if (skipWindow && stackWindows.includes(skipWindow) && count > 1) {
            const draggedIdx = stackWindows.indexOf(skipWindow);
            const draggedH = skipWindow.get_frame_rect().height;
            const availableForOthers = areaH - draggedH - gap * (count - 1);
            if (availableForOthers > 0) {
                let otherWeightSum = 0;
                for (let i = 0; i < count; i++) {
                    if (i !== draggedIdx) otherWeightSum += stackWeights[i];
                }
                const scale = otherWeightSum > 0 ? availableForOthers / otherWeightSum : 1;
                let y = areaY;
                for (let i = 0; i < count; i++) {
                    const isLast = i === count - 1;
                    const win = stackWindows[i];
                    let h;
                    if (i === draggedIdx) {
                        h = draggedH;
                    } else if (isLast) {
                        h = Math.max(10, areaY + areaH - y);
                    } else {
                        h = Math.max(this._getWindowMinSize(win).h || 0, Math.floor(stackWeights[i] * scale));
                        if (y + h > areaY + areaH) h = Math.max(10, areaY + areaH - y);
                    }
                    if (win !== skipWindow)
                        this._moveWindow(win, x, y, w, h);
                    else
                        this._moveWindow(win, x, y, w, draggedH);
                    if (!isLast) y += h + gap;
                }
                return;
            }
        }
        let y = areaY;
        for (let i = 0; i < count; i++) {
            const isLast = i === count - 1;
            const win = stackWindows[i];
            const minH = this._getWindowMinSize(win).h || 0;
            let h = isLast
                ? Math.max(10, areaY + areaH - y)
                : Math.max(minH, Math.floor(totalStackH * stackWeights[i] / stackTotal));
            if (!isLast && y + h > areaY + areaH) h = Math.max(10, areaY + areaH - y);
            if (win !== skipWindow)
                this._moveWindow(win, x, y, w, h);
            else
                this._moveWindow(win, x, y, w, win.get_frame_rect().height);
            if (!isLast) {
                if (win === skipWindow) {
                    const frame = win.get_frame_rect();
                    y += frame.height + gap;
                } else {
                    y += h + gap;
                }
            }
        }
    };

    if (leftStackW > 0 && leftCount > 0) {
        const leftWins = tiledWindows.slice(1, 1 + leftCount);
        _layoutStack(leftWins, leftWeights, leftTotal, areaX, leftStackW);
    }

    if (rightStackW > 0 && rightCount > 0) {
        const rightWins = tiledWindows.slice(1 + leftCount);
        _layoutStack(rightWins, rightWeights, rightTotal, rightStackX, rightStackW);
    }
}

export function _swapMasterStackWindows(winA, winB) {
    const ws = winA.get_workspace();
    if (!ws) return;
    const order = this._getWorkspaceOrder(ws);
    const idxA = order.indexOf(winA);
    const idxB = order.indexOf(winB);
    if (idxA !== -1 && idxB !== -1) {
        order[idxA] = winB;
        order[idxB] = winA;
    }
    const frameA = winA.get_frame_rect();
    const frameB = winB.get_frame_rect();
    try {
        winA.move_resize_frame(true, frameB.x, frameB.y, frameB.width, frameB.height);
        winB.move_resize_frame(true, frameA.x, frameA.y, frameA.width, frameA.height);
    } catch (e) {
        log(`[plaid] swap move_resize failed: ${e.message}`);
    }
}

export function _resizeMasterStack(focused, workspace, axis, delta) {
    const tiledWindows = this._getWindowsForWorkspace(workspace)
        .filter(w => !this._isFloating(w));
    const numStack = tiledWindows.length - 1;
    if (numStack === 0) return;

    const monitor = global.display.get_primary_monitor();
    const workArea = workspace.get_work_area_for_monitor(monitor);
    if (!workArea) return;
    const gap = this._settings.get_int('inside-gap');
    const area = this._outsideArea(workArea);
    if (!area) return;
    const areaW = area.w;
    const layout = this._getWorkspaceLayout(workspace);
    const masterDenom = layout === 'centered-master-stack' ? areaW - gap * 2 : areaW - gap;

    if (axis === 'width') {
        const currentRatio = this._getMasterRatio(workspace);
        const currentMasterW = masterDenom * currentRatio;
        // grow/shrink is relative to the FOCUSED window: a stack window
        // needs the master column to move the OPPOSITE way, and in the
        // centered layout the master width is split between two side
        // columns, so each side moves by half — the mouse-resize path
        // applies the same sign + 2x rules.
        const idx = tiledWindows.indexOf(focused);
        let signedDelta = idx > 0 ? -delta : delta;
        if (layout === 'centered-master-stack' && idx > 0)
            signedDelta *= 2;
        const newMasterW = currentMasterW + signedDelta;
        const minMaster = 100;
        const maxMaster = masterDenom - numStack * 100;
        if (maxMaster >= minMaster) {
            const clamped = Math.max(minMaster, Math.min(maxMaster, newMasterW));
            this._masterRatios.set(this._wsIndex(workspace), clamped / masterDenom);
        }
    } else {
        const idx = tiledWindows.indexOf(focused);
        if (idx === 0) return;
        const stackIdx = idx - 1;
        const stackRatios = this._getStackRatios(workspace);
        const currentWeight = stackRatios.has(stackIdx) ? stackRatios.get(stackIdx) : 1.0;
        const newWeight = Math.max(0.1, currentWeight + delta * 0.005);
        stackRatios.set(stackIdx, newWeight);
        this._scheduleSaveLayouts();
    }
}

export function _computeMasterStackDropTarget(ws, px, py) {
    const gap = this._settings.get_int('inside-gap');
    const monitor = global.display.get_primary_monitor();
    const workArea = ws.get_work_area_for_monitor(monitor);
    if (!workArea) return -1;

    const area = this._outsideArea(workArea);
    if (!area) return -1;
    const areaX = area.x;
    const areaY = area.y;
    const areaW = area.w;
    const areaH = area.h;

    // Drop zones live inside the outside-gapped area — a pointer in the
    // outside-gap strip selects nothing.
    if (px < areaX || px > areaX + areaW || py < areaY || py > areaY + areaH)
        return -1;

    const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
    if (tiled.length === 0) return -1;

    const numStack = tiled.length - 1;

    if (numStack === 0) return 0;

    const masterRatio = this._getMasterRatio(ws);
    const layout = this._getWorkspaceLayout(ws);

    if (layout === 'centered-master-stack') {
        const masterW = Math.floor((areaW - gap * 2) * masterRatio);
        const masterX = areaX + Math.floor((areaW - masterW) / 2);
        const leftStackW = masterX - areaX - gap;
        const rightStackX = masterX + masterW + gap;

        if (px >= masterX && px <= masterX + masterW)
            return 0;

        const leftCount = Math.ceil(numStack / 2);
        const rightCount = numStack - leftCount;
        const stackRatios = this._getStackRatios(ws);

        if (px < masterX && leftStackW > 0 && leftCount > 0) {
            const weights = [];
            let totalWeight = 0;
            for (let i = 0; i < leftCount; i++) {
                const w = stackRatios.has(i) ? stackRatios.get(i) : 1.0;
                weights.push(w);
                totalWeight += w;
            }
            let y = areaY;
            for (let i = 0; i < leftCount; i++) {
                const isLast = i === leftCount - 1;
                const h = isLast
                    ? (areaY + areaH - y)
                    : Math.floor((areaH - gap * (leftCount - 1)) * weights[i] / totalWeight);
                if (py <= y + h + (isLast ? 0 : gap / 2))
                    return 1 + i;
                y += h + gap;
            }
            // Drop below the last left-column window targets the LAST
            // column window (the drop lands at the column's bottom) —
            // the old first-window fallback was inconsistent with the
            // right column and the flat stack.
            return leftCount;
        }

        if (px > masterX + masterW && rightStackX > 0 && rightCount > 0) {
            const weights = [];
            let totalWeight = 0;
            for (let i = 0; i < rightCount; i++) {
                const w = stackRatios.has(leftCount + i) ? stackRatios.get(leftCount + i) : 1.0;
                weights.push(w);
                totalWeight += w;
            }
            let y = areaY;
            for (let i = 0; i < rightCount; i++) {
                const isLast = i === rightCount - 1;
                const h = isLast
                    ? (areaY + areaH - y)
                    : Math.floor((areaH - gap * (rightCount - 1)) * weights[i] / totalWeight);
                if (py <= y + h + (isLast ? 0 : gap / 2))
                    return 1 + leftCount + i;
                y += h + gap;
            }
            // Same as the left column: below the column = its LAST
            // window (the flat-stack semantics).
            return 1 + leftCount + rightCount - 1;
        }
    } else {
        const masterW = Math.floor((areaW - gap) * masterRatio);
        const stackW = areaW - masterW - gap;
        const stackX = areaX + masterW + gap;

        if (px >= areaX && px <= areaX + masterW)
            return 0;

        if (px >= stackX && px <= stackX + stackW) {
            const stackRatios = this._getStackRatios(ws);
            const weights = [];
            let totalWeight = 0;
            for (let i = 0; i < numStack; i++) {
                const w = stackRatios.has(i) ? stackRatios.get(i) : 1.0;
                weights.push(w);
                totalWeight += w;
            }
            let y = areaY;
            for (let i = 0; i < numStack; i++) {
                const isLast = i === numStack - 1;
                const h = isLast
                    ? (areaY + areaH - y)
                    : Math.floor((areaH - gap * (numStack - 1)) * weights[i] / totalWeight);
                if (py <= y + h + (isLast ? 0 : gap / 2))
                    return i + 1;
                y += h + gap;
            }
            return tiled.length - 1;
        }
    }

    return -1;
}

export function _retileDwindle(workspace, tiledWindows) {
    const gap = this._settings.get_int('inside-gap');
    const monitor = global.display.get_primary_monitor();
    const workArea = workspace.get_work_area_for_monitor(monitor);
    if (!workArea) return;

    if (tiledWindows.length === 1) {
        const rect = this._singleWindowRect(workArea);
        if (rect)
            this._moveWindow(tiledWindows[0], rect.x, rect.y, rect.w, rect.h);
        return;
    }

    let tree = this._bspGetTree(workspace);
    const area = this._outsideArea(workArea);
    if (!area) return;
    const areaX = area.x;
    const areaY = area.y;
    const areaW = area.w;
    const areaH = area.h;

    if (tree) {
        const treeWins = this._bspCollectWindows(tree);
        for (const tw of treeWins) {
            if (!tiledWindows.includes(tw)) {
                tree = this._bspRemove(tree, tw);
            }
        }
        let currentWins = this._bspCollectWindows(tree);
        for (const win of tiledWindows) {
            if (!currentWins.includes(win)) {
                tree = this._bspInsert(tree, win, areaX, areaY, areaW, areaH, gap);
                currentWins = this._bspCollectWindows(tree);
            }
        }
        this._bspTrees.set(workspace, tree);
    } else {
        tree = null;
        for (const win of tiledWindows) {
            if (tree) {
                tree = this._bspInsert(tree, win, areaX, areaY, areaW, areaH, gap);
            } else {
                tree = this._bspMakeLeaf(win);
            }
        }
        this._bspTrees.set(workspace, tree);
    }

    // Restore saved split ratios ONLY when the window set changed
    // (fresh session build, a window opened, or one closed). A plain
    // retile after a manual resize has the same leaf signature → no
    // reconcile → live ratios are never stomped; the resize itself
    // already scheduled a save (retiles are the save trigger), so the
    // saved shape stays current for the next window-set change.
    if (tree && this._dwindleLeafSigs) {
        const sig = tiledWindows.map(w => w.get_id()).join(',');
        if (this._dwindleLeafSigs.get(workspace) !== sig) {
            this._dwindleLeafSigs.set(workspace, sig);
            const savedShape = this._persistedDwindleByIndex &&
                this._persistedDwindleByIndex.get(this._wsIndex(workspace));
            if (savedShape && this._reconcileTreeRatios(savedShape, tree))
                this._debugLog(`dwindle: restored saved split ratios (ws=${this._wsIndex(workspace)}, windows=${tiledWindows.length})`);
        }
    }

    this._treeMinSizes(tree, gap);
    this._clampTreeToMinSizes(tree, areaW, areaH, gap);
    this._bspLayout(tree, areaX, areaY, areaW, areaH, gap);
}
export const layoutMethods = {
    _retileAll,
    _retileWorkspace,
    _doRetileWorkspace,
    _getMasterRatio,
    _getStackRatios,
    _clampMasterStackRatios,
    _retileMasterStack,
    _retileCenteredMasterStack,
    _swapMasterStackWindows,
    _resizeMasterStack,
    _computeMasterStackDropTarget,
    _retileDwindle,
};
