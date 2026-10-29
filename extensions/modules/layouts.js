// Workspace retile orchestration and the master-stack / dwindle layout
// implementation. Methods live on this subsystem class.







// --- Animation ---


export class Layouts {
    constructor(core) {
        this.core = core;
    }

    retileAll() {
        if (!this.core._settings) return;
        for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
            const w = global.workspace_manager.get_workspace_by_index(i);
            this.core.signals.scheduleRetile(w);
        }
        this.core.signals.scheduleBorders();
    }

    retileWorkspace(workspace) {
        if (!this.core._settings) return;
        this.core.signals.scheduleRetile(workspace);
    }

    doRetileWorkspace(workspace) {
        if (!this.core._settings || this.core._shuttingDown) return;
        if (!this.core._settings.get_boolean('enabled')) {
            return;
        }
        if (this.core._grabOp) return;
        const tiledWindows = this.core.windows.getWindowsForWorkspace(workspace)
            .filter(w => !this.core.windows.isFloating(w));
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
        { workArea = workspace.get_work_area_for_monitor(monIdx); }
        if (!this.core.geometry.isValidWorkArea(workArea)) {
            this.core.debugLog(`retile: skipped ws=${this.core.geometry.wsIndex(workspace)} (work area not ready)`);
            return;
        }
        this.core.debugLog(`retile: ws=${this.core.geometry.wsIndex(workspace)} tiled=[${tiledWindows.map(w => w.get_wm_class_instance() || '?').join(',')}] ` +
            `layout=${this.core.windows.getWorkspaceLayout(workspace)} animTime=${this.core.placement.getAnimationTime().toFixed(2)} animating=${this.core._animating}`);

        if (this.core.placement.getAnimationTime() > 0 && !this.core._grabOp) {
            this.core.placement.animRetile(workspace, tiledWindows);
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

    getMasterRatio(ws) {
        const idx = this.core.geometry.wsIndex(ws);
        if (!this.core._masterRatios.has(idx)) {
            let ratio = 0.5;
            if (this.core._persistedMasterByIndex) {
                const rule = this.core._persistedMasterByIndex.get(idx);
                if (rule !== undefined) ratio = rule;
            }
            this.core._masterRatios.set(idx, ratio);
        }
        return this.core._masterRatios.get(idx);
    }

    getStackRatios(ws) {
        const idx = this.core.geometry.wsIndex(ws);
        if (!this.core._stackRatios.has(idx)) {
            const map = new Map();
            if (this.core._persistedStackByIndex) {
                const rule = this.core._persistedStackByIndex.get(idx);
                if (rule) {
                    for (const [k, v] of rule)
                        map.set(k, v);
                }
            }
            this.core._stackRatios.set(idx, map);
        }
        return this.core._stackRatios.get(idx);
    }

    clampMasterStackRatios(ws, tiledWindows, areaW, gap, centered) {
        if (!tiledWindows || tiledWindows.length < 2) return;
        const masterMin = this.core.bsp.getWindowMinSize(tiledWindows[0]).w || 0;
        let stackMinW = 0;
        for (let i = 1; i < tiledWindows.length; i++)
            stackMinW = Math.max(stackMinW, this.core.bsp.getWindowMinSize(tiledWindows[i]).w || 0);
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
                const m = this.core.bsp.getWindowMinSize(tiledWindows[i]).w || 0;
                if (i <= leftCount) leftMinW = Math.max(leftMinW, m);
                else rightMinW = Math.max(rightMinW, m);
            }
            hi = 1 - 2 * Math.max(leftMinW, rightMinW) / basis;
        }
        const ratio = this.getMasterRatio(ws);
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
        this.core._masterRatios.set(this.core.geometry.wsIndex(ws), clamped);
        this.core.persistence.scheduleSaveLayouts();
    }

    retileMasterStack(workspace, tiledWindows, skipWindow = null) {
        const gap = this.core._settings.get_int('inside-gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        if (!workArea) return;

        const numWindows = tiledWindows.length;

        if (numWindows === 1) {
            const rect = this.core.geometry.singleWindowRect(workArea);
            if (rect)
                this.core.windows.moveWindow(tiledWindows[0], rect.x, rect.y, rect.w, rect.h);
            return;
        }

        const area = this.core.geometry.outsideArea(workArea);
        if (!area) return;
        const areaX = area.x;
        const areaY = area.y;
        const areaW = area.w;
        const areaH = area.h;
        this.clampMasterStackRatios(workspace, tiledWindows, areaW, gap, false);
        const masterRatio = this.getMasterRatio(workspace);
        const masterW = Math.floor((areaW - gap) * masterRatio);
        const stackW = areaW - masterW - gap;
        const numStack = numWindows - 1;

        if (tiledWindows[0] !== skipWindow)
            this.core.windows.moveWindow(tiledWindows[0], areaX, areaY, masterW, areaH);

        const stackRatios = this.getStackRatios(workspace);
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
                            h = Math.max(this.core.bsp.getWindowMinSize(win).h || 0, Math.floor(weights[i] * scale));
                            if (y + h > areaY + areaH) h = Math.max(10, areaY + areaH - y);
                        }
                        if (win !== skipWindow)
                            this.core.windows.moveWindow(win, areaX + masterW + gap, y, stackW, h);
                        else
                            this.core.windows.moveWindow(win, areaX + masterW + gap, y, stackW, draggedH);
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
            const minH = this.core.bsp.getWindowMinSize(win).h || 0;
            let h = isLast
                ? Math.max(10, areaY + areaH - y)
                : Math.max(minH, Math.floor(totalStackH * weights[i] / totalWeight));
            if (!isLast && y + h > areaY + areaH) h = Math.max(10, areaY + areaH - y);
            if (win !== skipWindow)
                this.core.windows.moveWindow(win, areaX + masterW + gap, y, stackW, h);
            else
                this.core.windows.moveWindow(win, areaX + masterW + gap, y, stackW, win.get_frame_rect().height);
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

    retileCenteredMasterStack(workspace, tiledWindows, skipWindow = null) {
        const gap = this.core._settings.get_int('inside-gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        if (!workArea) return;

        const numWindows = tiledWindows.length;

        if (numWindows === 1) {
            const rect = this.core.geometry.singleWindowRect(workArea);
            if (rect)
                this.core.windows.moveWindow(tiledWindows[0], rect.x, rect.y, rect.w, rect.h);
            return;
        }

        const area = this.core.geometry.outsideArea(workArea);
        if (!area) return;
        const areaX = area.x;
        const areaY = area.y;
        const areaW = area.w;
        const areaH = area.h;
        this.clampMasterStackRatios(workspace, tiledWindows, areaW, gap, true);
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
                this.core._masterRatios.set(this.core.geometry.wsIndex(workspace), Math.max(0.15, Math.min(0.85, effectiveRatio)));
            } else {
                const masterRatio = this.getMasterRatio(workspace);
                masterW = Math.floor((areaW - gap * 2) * masterRatio);
                masterX = areaX + Math.floor((areaW - masterW) / 2);
            }
        } else {
            const masterRatio = this.getMasterRatio(workspace);
            masterW = Math.floor((areaW - gap * 2) * masterRatio);
            masterX = areaX + Math.floor((areaW - masterW) / 2);
        }
        const leftStackW = masterX - areaX - gap;
        const rightStackX = masterX + masterW + gap;
        const rightStackW = areaX + areaW - rightStackX;

        if (tiledWindows[0] !== skipWindow)
            this.core.windows.moveWindow(tiledWindows[0], masterX, areaY, masterW, areaH);

        const stackRatios = this.getStackRatios(workspace);
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
                            h = Math.max(this.core.bsp.getWindowMinSize(win).h || 0, Math.floor(stackWeights[i] * scale));
                            if (y + h > areaY + areaH) h = Math.max(10, areaY + areaH - y);
                        }
                        if (win !== skipWindow)
                            this.core.windows.moveWindow(win, x, y, w, h);
                        else
                            this.core.windows.moveWindow(win, x, y, w, draggedH);
                        if (!isLast) y += h + gap;
                    }
                    return;
                }
            }
            let y = areaY;
            for (let i = 0; i < count; i++) {
                const isLast = i === count - 1;
                const win = stackWindows[i];
                const minH = this.core.bsp.getWindowMinSize(win).h || 0;
                let h = isLast
                    ? Math.max(10, areaY + areaH - y)
                    : Math.max(minH, Math.floor(totalStackH * stackWeights[i] / stackTotal));
                if (!isLast && y + h > areaY + areaH) h = Math.max(10, areaY + areaH - y);
                if (win !== skipWindow)
                    this.core.windows.moveWindow(win, x, y, w, h);
                else
                    this.core.windows.moveWindow(win, x, y, w, win.get_frame_rect().height);
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

    swapMasterStackWindows(winA, winB) {
        const ws = winA.get_workspace();
        if (!ws) return;
        const order = this.core.windows.getWorkspaceOrder(ws);
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
            this.core.debugLog(`swap move_resize failed: ${e.message}`);
        }
    }

    resizeMasterStack(focused, workspace, axis, delta) {
        const tiledWindows = this.core.windows.getWindowsForWorkspace(workspace)
            .filter(w => !this.core.windows.isFloating(w));
        const numStack = tiledWindows.length - 1;
        if (numStack === 0) return;

        const monitor = global.display.get_primary_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        if (!workArea) return;
        const gap = this.core._settings.get_int('inside-gap');
        const area = this.core.geometry.outsideArea(workArea);
        if (!area) return;
        const areaW = area.w;
        const layout = this.core.windows.getWorkspaceLayout(workspace);
        const masterDenom = layout === 'centered-master-stack' ? areaW - gap * 2 : areaW - gap;

        if (axis === 'width') {
            const currentRatio = this.getMasterRatio(workspace);
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
                this.core._masterRatios.set(this.core.geometry.wsIndex(workspace), clamped / masterDenom);
            }
        } else {
            const idx = tiledWindows.indexOf(focused);
            if (idx === 0) return;
            const stackIdx = idx - 1;
            const stackRatios = this.getStackRatios(workspace);
            const currentWeight = stackRatios.has(stackIdx) ? stackRatios.get(stackIdx) : 1.0;
            const newWeight = Math.max(0.1, currentWeight + delta * 0.005);
            stackRatios.set(stackIdx, newWeight);
            this.core.persistence.scheduleSaveLayouts();
        }
    }

    computeMasterStackDropTarget(ws, px, py) {
        const gap = this.core._settings.get_int('inside-gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return -1;

        const area = this.core.geometry.outsideArea(workArea);
        if (!area) return -1;
        const areaX = area.x;
        const areaY = area.y;
        const areaW = area.w;
        const areaH = area.h;

        // Drop zones live inside the outside-gapped area — a pointer in the
        // outside-gap strip selects nothing.
        if (px < areaX || px > areaX + areaW || py < areaY || py > areaY + areaH)
            return -1;

        const tiled = this.core.windows.getWindowsForWorkspace(ws).filter(w => !this.core.windows.isFloating(w));
        if (tiled.length === 0) return -1;

        const numStack = tiled.length - 1;

        if (numStack === 0) return 0;

        const masterRatio = this.getMasterRatio(ws);
        const layout = this.core.windows.getWorkspaceLayout(ws);

        if (layout === 'centered-master-stack') {
            const masterW = Math.floor((areaW - gap * 2) * masterRatio);
            const masterX = areaX + Math.floor((areaW - masterW) / 2);
            const leftStackW = masterX - areaX - gap;
            const rightStackX = masterX + masterW + gap;

            if (px >= masterX && px <= masterX + masterW)
                return 0;

            const leftCount = Math.ceil(numStack / 2);
            const rightCount = numStack - leftCount;
            const stackRatios = this.getStackRatios(ws);

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
                const stackRatios = this.getStackRatios(ws);
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

    retileDwindle(workspace, tiledWindows) {
        const gap = this.core._settings.get_int('inside-gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        if (!workArea) return;

        if (tiledWindows.length === 1) {
            const rect = this.core.geometry.singleWindowRect(workArea);
            if (rect)
                this.core.windows.moveWindow(tiledWindows[0], rect.x, rect.y, rect.w, rect.h);
            return;
        }

        let tree = this.core.bsp.bspGetTree(workspace);
        const area = this.core.geometry.outsideArea(workArea);
        if (!area) return;
        const areaX = area.x;
        const areaY = area.y;
        const areaW = area.w;
        const areaH = area.h;

        if (tree) {
            const treeWins = this.core.bsp.bspCollectWindows(tree);
            for (const tw of treeWins) {
                if (!tiledWindows.includes(tw)) {
                    tree = this.core.bsp.bspRemove(tree, tw);
                }
            }
            let currentWins = this.core.bsp.bspCollectWindows(tree);
            for (const win of tiledWindows) {
                if (!currentWins.includes(win)) {
                    tree = this.core.bsp.bspInsert(tree, win, areaX, areaY, areaW, areaH, gap);
                    currentWins = this.core.bsp.bspCollectWindows(tree);
                }
            }
            this.core._bspTrees.set(workspace, tree);
        } else {
            tree = null;
            for (const win of tiledWindows) {
                if (tree) {
                    tree = this.core.bsp.bspInsert(tree, win, areaX, areaY, areaW, areaH, gap);
                } else {
                    tree = this.core.bsp.bspMakeLeaf(win);
                }
            }
            this.core._bspTrees.set(workspace, tree);
        }

        // Restore saved split ratios ONLY when the window set changed
        // (fresh session build, a window opened, or one closed). A plain
        // retile after a manual resize has the same leaf signature → no
        // reconcile → live ratios are never stomped; the resize itself
        // already scheduled a save (retiles are the save trigger), so the
        // saved shape stays current for the next window-set change.
        if (tree && this.core._dwindleLeafSigs) {
            const sig = tiledWindows.map(w => w.get_id()).join(',');
            if (this.core._dwindleLeafSigs.get(workspace) !== sig) {
                this.core._dwindleLeafSigs.set(workspace, sig);
                const savedShape = this.core._persistedDwindleByIndex &&
                    this.core._persistedDwindleByIndex.get(this.core.geometry.wsIndex(workspace));
                if (savedShape && this.core.bsp.reconcileTreeRatios(savedShape, tree))
                    this.core.debugLog(`dwindle: restored saved split ratios (ws=${this.core.geometry.wsIndex(workspace)}, windows=${tiledWindows.length})`);
            }
        }

        this.core.bsp.treeMinSizes(tree, gap);
        this.core.bsp.clampTreeToMinSizes(tree, areaW, areaH, gap);
        this.core.bsp.bspLayout(tree, areaX, areaY, areaW, areaH, gap);
    }

}
