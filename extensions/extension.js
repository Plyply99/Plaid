import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ModalDialog } from 'resource:///org/gnome/shell/ui/modalDialog.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

export default class TilingWMExtension extends Extension {
    enable() {
        this._destroyed = false;
        this._settings = this.getSettings();
        this._floatingClasses = new Set(this._settings.get_strv('float-windows'));
        this._floatingTitles = new Set(this._settings.get_strv('float-titles'));
        this._windowBorders = new Map();
        this._workspaceOrders = new Map();
        this._windowWorkspaces = new Map();
        this._masterRatios = new Map();
        this._stackRatios = new Map();
        this._bspTrees = new Map();
        this._lastFocusedPerWorkspace = new Map();
        this._signals = [];
        this._pendingRetileIds = new Map();
        this._pendingBorderId = 0;
        this._keyboardFocusChange = false;
        this._grabOp = null;
        this._grabStartX = 0;
        this._grabStartY = 0;
        this._grabWidthSign = 0;
        this._grabHeightSign = 0;
        this._grabResizeNodeW = null;
        this._grabResizeNodeH = null;
        this._grabInitialRatioW = 0;
        this._grabInitialRatioH = 0;
        this._grabInitialMasterRatio = 0;
        this._grabInitialStackRatios = null;
        this._liveResizeId = 0;
        this._swapTarget = null;
        this._lastSwapTarget = null;
        this._dropPreview = null;

        this._disableMutterDefaults();
        this._dropOverlay = new St.Widget({
            reactive: false,
            visible: true,
        });
        Main.layoutManager.uiGroup.add_child(this._dropOverlay);
        this._connectSignals();
        this._registerKeybindings();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._destroyed) return false;
            this._updateDropOverlaySize();
            for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
                const ws = global.workspace_manager.get_workspace_by_index(i);
                for (const win of ws.list_windows()) {
                    if (this._shouldManage(win)) {
                        this._addWindow(win);
                    }
                }
            }
            this._retileAll();
            return false;
        });
    }

    disable() {
        this._destroyed = true;
        if (this._pickFocusId) {
            try { global.display.disconnect(this._pickFocusId); } catch (_e) {}
            this._pickFocusId = null;
        }
        for (const id of (this._pendingRetileIds || new Map()).values())
            GLib.source_remove(id);
        if (this._pendingBorderId) GLib.source_remove(this._pendingBorderId);
        this._stopLiveResizeLoop();
        this._disconnectGrabSignals();
        this._restoreMutterDefaults();
        this._removeAllBorders();
        this._hideDropPreview();
        if (this._dropOverlay) {
            this._dropOverlay.destroy();
            this._dropOverlay = null;
        }
        this._disconnectSignals();
        this._destroyFloatPickDialog();
        this._removeKeybindings();
        this._settings = null;
        this._floatingClasses = null;
        this._floatingTitles = null;
        this._windowBorders = null;
        this._workspaceOrders = null;
        this._windowWorkspaces = null;
        this._masterRatios = null;
        this._stackRatios = null;
        this._bspTrees = null;
        this._lastFocusedPerWorkspace = null;
        this._signals = null;
        this._swapTarget = null;
        this._lastSwapTarget = null;
        this._grabInitialMasterRatio = 0;
        this._grabInitialStackRatios = null;
    }

    _disableMutterDefaults() {
        this._mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
        this._savedAutoMaximize = this._mutterSettings.get_boolean('auto-maximize');
        this._savedEdgeTiling = this._mutterSettings.get_boolean('edge-tiling');
        this._mutterSettings.set_boolean('auto-maximize', false);
        this._mutterSettings.set_boolean('edge-tiling', false);

        this._mutterKeybindings = new Gio.Settings({ schema_id: 'org.gnome.mutter.keybindings' });
        this._savedToggleTiledLeft = this._mutterKeybindings.get_value('toggle-tiled-left');
        this._savedToggleTiledRight = this._mutterKeybindings.get_value('toggle-tiled-right');
        this._mutterKeybindings.set_value('toggle-tiled-left', new GLib.Variant('as', []));
        this._mutterKeybindings.set_value('toggle-tiled-right', new GLib.Variant('as', []));
    }

    _restoreMutterDefaults() {
        if (this._mutterSettings) {
            this._mutterSettings.set_boolean('auto-maximize', this._savedAutoMaximize);
            this._mutterSettings.set_boolean('edge-tiling', this._savedEdgeTiling);
            this._mutterSettings = null;
        }
        if (this._mutterKeybindings) {
            this._mutterKeybindings.set_value('toggle-tiled-left', this._savedToggleTiledLeft);
            this._mutterKeybindings.set_value('toggle-tiled-right', this._savedToggleTiledRight);
            this._mutterKeybindings = null;
        }
    }

    _connectSignals() {
        this._addSignal(global.display, global.display.connect('window-created', (_d, win) => {
            if (this._shouldManage(win)) {
                this._addWindow(win);
                const doRetile = () => {
                    if (this._destroyed) return;
                    const ws = win.get_workspace();
                    if (ws) this._retileWorkspace(ws);
                };
                const actor = win.get_compositor_private();
                if (actor) {
                    const firstFrameId = actor.connect('first-frame', () => {
                        actor.disconnect(firstFrameId);
                        doRetile();
                        this._cursorWarpDeferred(win);
                    });
                } else {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        doRetile();
                        this._cursorWarpDeferred(win);
                        return false;
                    });
                }
            } else if (this._isFloating(win)) {
                const doRaise = () => {
                    if (this._destroyed) return;
                    const ws = win.get_workspace();
                    if (ws) this._raiseFloatingWindows(ws);
                };
                const actor = win.get_compositor_private();
                if (actor) {
                    const firstFrameId = actor.connect('first-frame', () => {
                        actor.disconnect(firstFrameId);
                        doRaise();
                    });
                } else {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        doRaise();
                        return false;
                    });
                }
            }
        }));
        this._addSignal(global.display, global.display.connect('notify::focus-window', () => {
            this._updateBorders();
            const win = global.display.focus_window;
            if (win) {
                const ws = win.get_workspace();
                if (ws) this._lastFocusedPerWorkspace.set(ws, win);
            }
            if (this._settings.get_boolean('follow-focus') && this._keyboardFocusChange) {
                this._keyboardFocusChange = false;
                if (win) this._moveCursorToWindow(win);
            }
        }));
        this._addSignal(Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => {
            this._updateDropOverlaySize();
            this._retileAll();
        }));
        this._addSignal(global.workspace_manager, global.workspace_manager.connect('workspace-added', (_m, index) => {
            const ws = global.workspace_manager.get_workspace_by_index(index);
            this._workspaceOrders.set(ws, []);
        }));
        this._addSignal(global.workspace_manager, global.workspace_manager.connect('workspace-removed', () => {
            for (const [workspace] of this._workspaceOrders) {
                let valid = false;
                for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
                    if (global.workspace_manager.get_workspace_by_index(i) === workspace) {
                        valid = true;
                        break;
                    }
                }
                if (!valid) {
                    this._workspaceOrders.delete(workspace);
                    this._masterRatios.delete(workspace);
                    this._stackRatios.delete(workspace);
                    this._bspTrees.delete(workspace);
                    this._lastFocusedPerWorkspace.delete(workspace);
                }
            }
        }));
        this._addSignal(global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', () => {
            if (this._destroyed || !this._settings.get_boolean('enabled')) return;
            const ws = global.workspace_manager.get_active_workspace();
            if (!ws) return;
            const windows = this._getWindowsForWorkspace(ws);
            if (windows.length === 0) return;
            let target = this._lastFocusedPerWorkspace.get(ws);
            if (!target || !windows.includes(target)) {
                target = windows[0];
            }
            this._keyboardFocusChange = true;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (this._destroyed) return false;
                try { target.activate(global.get_current_time()); } catch (_e) {}
                this._keyboardFocusChange = false;
                return false;
            });
        }));
        this._addSignal(this._settings, this._settings.connect('changed::float-windows', () => {
            this._floatingClasses = new Set(this._settings.get_strv('float-windows'));
            this._retileAll();
        }));
        this._addSignal(this._settings, this._settings.connect('changed::float-titles', () => {
            this._floatingTitles = new Set(this._settings.get_strv('float-titles'));
            this._retileAll();
        }));
        this._addSignal(this._settings, this._settings.connect('changed::gap', () => this._retileAll()));
        this._addSignal(this._settings, this._settings.connect('changed::single-gap', () => this._retileAll()));
        this._addSignal(this._settings, this._settings.connect('changed::layout', () => {
            this._bspTrees.clear();
            this._masterRatios.clear();
            this._stackRatios.clear();
            this._retileAll();
        }));
        this._addSignal(this._settings, this._settings.connect('changed::dwindle-ratio', () => this._retileAll()));
        this._addSignal(this._settings, this._settings.connect('changed::master-ratio', () => this._retileAll()));
        this._addSignal(this._settings, this._settings.connect('changed::active-border-width', () => this._updateBorders()));
        this._addSignal(this._settings, this._settings.connect('changed::active-border-color', () => this._updateBorders()));
        this._addSignal(this._settings, this._settings.connect('changed::inactive-border-width', () => this._updateBorders()));
        this._addSignal(this._settings, this._settings.connect('changed::inactive-border-color', () => this._updateBorders()));
        this._addSignal(this._settings, this._settings.connect('changed::border-radius', () => this._updateBorders()));
        this._addSignal(this._settings, this._settings.connect('changed::pick-mode', () => {
            if (this._settings.get_boolean('pick-mode')) {
                this._startPickMode();
            }
        }));

        this._connectGrabSignals();

    }

    _addSignal(emitter, id) {
        this._signals.push({ emitter, id });
    }

    _disconnectSignals() {
        if (this._signals) {
            for (const { emitter, id } of this._signals) {
                try { emitter.disconnect(id); } catch (_e) {}
            }
            this._signals = [];
        }
        for (const [actor, sigIds] of this._actorSignals || []) {
            for (const { emitter, id } of sigIds) {
                try { emitter.disconnect(id); } catch (_e) {}
            }
        }
        this._actorSignals = null;
        for (const id of this._pendingRetileIds.values())
            GLib.source_remove(id);
        this._pendingRetileIds.clear();
        if (this._pendingBorderId) {
            GLib.source_remove(this._pendingBorderId);
            this._pendingBorderId = 0;
        }
    }

    _scheduleRetile(workspace) {
        if (this._destroyed || !workspace) return;
        if (this._pendingRetileIds.has(workspace))
            GLib.source_remove(this._pendingRetileIds.get(workspace));
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._pendingRetileIds.delete(workspace);
            if (this._destroyed) return false;
            this._doRetileWorkspace(workspace);
            return false;
        });
        this._pendingRetileIds.set(workspace, id);
    }

    _scheduleBorders() {
        if (this._destroyed) return;
        if (this._pendingBorderId)
            GLib.source_remove(this._pendingBorderId);
        this._pendingBorderId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._pendingBorderId = 0;
            if (this._destroyed) return false;
            this._doUpdateBorders();
            return false;
        });
    }

    _shouldManage(win) {
        const wms = win.get_wm_class_instance();
        const title = win.get_title();
        if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
        if (win.is_skip_taskbar()) return false;
        if (wms && this._floatingClasses.has(wms.toLowerCase())) return false;
        if (title && this._floatingTitles.has(title)) return false;
        return true;
    }

    _moveCursorToWindow(win) {
        try {
            const frame = win.get_frame_rect();
            if (frame.width === 0 || frame.height === 0) return false;
            const centerX = frame.x + frame.width / 2;
            const centerY = frame.y + frame.height / 2;
            const backend = Clutter.get_default_backend();
            const seat = backend.get_default_seat();
            seat.warp_pointer(centerX, centerY);
            return true;
        } catch (e) {
            log(`[plaid] _moveCursorToWindow failed: ${e.message}`);
            return false;
        }
    }

    _warpCursor(win, winX, winY, relX, relY) {
        try {
            const frame = win.get_frame_rect();
            if (frame.width === 0 || frame.height === 0) return;
            const clampedRelX = Math.max(0, Math.min(frame.width - 1, relX));
            const clampedRelY = Math.max(0, Math.min(frame.height - 1, relY));
            const warpX = winX + clampedRelX;
            const warpY = winY + clampedRelY;
            const backend = Clutter.get_default_backend();
            const seat = backend.get_default_seat();
            seat.warp_pointer(warpX, warpY);
        } catch (e) {
            log(`[plaid] _warpCursor failed: ${e.message}`);
        }
    }

    _cursorWarpDeferred(win) {
        if (this._destroyed) return;
        let prevFrame = null;
        let retries = 0;
        const MAX_RETRIES = 6;
        const tryWarp = () => {
            if (this._destroyed || retries >= MAX_RETRIES) return false;
            retries++;
            if (!win || !win.get_workspace()) return false;
            const frame = win.get_frame_rect();
            if (frame.width === 0 || frame.height === 0) return true;
            if (prevFrame && frame.x === prevFrame.x && frame.y === prevFrame.y &&
                frame.width === prevFrame.w && frame.height === prevFrame.h) {
                this._moveCursorToWindow(win);
                return false;
            }
            prevFrame = { x: frame.x, y: frame.y, w: frame.width, h: frame.height };
            return true;
        };
        if (tryWarp()) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, tryWarp);
        }
    }

    _isFloating(win) {
        const wms = win.get_wm_class_instance();
        if (wms && this._floatingClasses.has(wms.toLowerCase())) return true;
        const title = win.get_title();
        if (title && this._floatingTitles.has(title)) return true;
        if (win.is_fullscreen()) return true;
        if (win.get_window_type() !== Meta.WindowType.NORMAL) return true;
        if (win.is_skip_taskbar()) return true;
        if (win.get_transient_for()) return true;
        return false;
    }

    _getWorkspaceOrder(workspace) {
        if (!this._workspaceOrders.has(workspace))
            this._workspaceOrders.set(workspace, []);
        return this._workspaceOrders.get(workspace);
    }

    _addWindow(win) {
        if (!this._settings) return;
        if (this._windowWorkspaces.has(win)) return;
        const ws = win.get_workspace();
        this._windowWorkspaces.set(win, ws);
        this._connectWindowSignals(win);
        if (ws) {
            const order = this._getWorkspaceOrder(ws);
            if (!order.includes(win)) {
                order.push(win);
            }
            if (!this._isFloating(win)) {
                const layout = this._settings.get_string('layout');
                if (layout === 'dwindle')
                    this._bspInsertForWorkspace(ws, win);
            }
        }
    }

    _removeWindow(win) {
        if (!this._settings) return;
        const ws = this._windowWorkspaces.get(win) || win.get_workspace();
        const wmClass = win.get_wm_class_instance() || '?';
        log(`[plaid] REMOVE_WINDOW: ${wmClass} ws=${ws}`);
        this._windowWorkspaces.delete(win);
        this._disconnectWindowSignals(win);
        this._removeBorder(win);
        for (const [workspace, lastWin] of this._lastFocusedPerWorkspace) {
            if (lastWin === win) this._lastFocusedPerWorkspace.delete(workspace);
        }
        if (ws) {
            const order = this._getWorkspaceOrder(ws);
            const idx = order.indexOf(win);
            if (idx !== -1) order.splice(idx, 1);
            const layout = this._settings.get_string('layout');
            if (layout === 'dwindle') {
                const tree = this._bspGetTree(ws);
                if (tree) this._bspTrees.set(ws, this._bspRemove(tree, win));
            }
            this._retileWorkspace(ws);
        }
    }

    _connectWindowSignals(win) {
        const actor = win.get_compositor_private();
        if (actor && !this._actorSignals)
            this._actorSignals = new Map();
        if (!actor) return;
        if (this._actorSignals.has(actor)) return;
        const sigIds = [];
        sigIds.push({ emitter: win, id: win.connect('position-changed', () => {
            this._updateBorders();
        }) });
        sigIds.push({ emitter: win, id: win.connect('size-changed', () => this._updateBorders()) });
        sigIds.push({ emitter: win, id: win.connect('unmanaged', () => this._removeWindow(win)) });
        sigIds.push({ emitter: actor, id: actor.connect('destroy', () => this._removeWindow(win)) });
        sigIds.push({ emitter: win, id: win.connect('workspace-changed', () => {
            const oldWs = this._windowWorkspaces.get(win);
            if (oldWs) {
                const order = this._getWorkspaceOrder(oldWs);
                const idx = order.indexOf(win);
                if (idx !== -1) order.splice(idx, 1);
                this._retileWorkspace(oldWs);
            }
            const newWs = win.get_workspace();
            if (newWs) {
                const order = this._getWorkspaceOrder(newWs);
                if (!order.includes(win)) order.push(win);
                this._windowWorkspaces.set(win, newWs);
                this._retileWorkspace(newWs);
            }
        }) });
        sigIds.push({ emitter: win, id: win.connect('notify::minimized', () => {
            const ws = win.get_workspace();
            if (ws) this._retileWorkspace(ws);
        }) });
        sigIds.push({ emitter: win, id: win.connect('notify::maximized-horizontally', () => {
            if (win.maximized_horizontally) {
                win.unmaximize(Meta.MaximizeFlags.BOTH);
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (this._destroyed) return false;
                    const ws = win.get_workspace();
                    if (ws) this._retileWorkspace(ws);
                    return false;
                });
            }
        }) });
        this._actorSignals.set(actor, sigIds);
    }

    _disconnectWindowSignals(win) {
        const actor = win.get_compositor_private();
        if (!actor || !this._actorSignals) return;
        const sigIds = this._actorSignals.get(actor);
        if (sigIds) {
            for (const { emitter, id } of sigIds) {
                try { emitter.disconnect(id); } catch (_e) {}
            }
            this._actorSignals.delete(actor);
        }
    }

    _getWindowsForWorkspace(workspace) {
        const order = this._getWorkspaceOrder(workspace);
        return order.filter(w =>
            w.get_window_type() === Meta.WindowType.NORMAL &&
            !w.is_skip_taskbar() &&
            !w.minimized
        );
    }

    _raiseFloatingWindows(workspace) {
        if (!workspace) return;
        const tiled = this._getWindowsForWorkspace(workspace)
            .filter(w => !this._isFloating(w));
        const windows = workspace.list_windows();
        for (const win of windows) {
            if (!tiled.includes(win)) {
                try { win.make_above(); } catch (_e) {}
            }
        }
        for (const win of tiled) {
            try { win.unmake_above(); } catch (_e) {}
        }
    }

    _retileAll() {
        if (!this._settings || this._destroyed) return;
        for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
            const w = global.workspace_manager.get_workspace_by_index(i);
            this._scheduleRetile(w);
        }
        this._scheduleBorders();
    }

    _retileWorkspace(workspace) {
        if (!this._settings || this._destroyed) return;
        this._scheduleRetile(workspace);
    }

    _doRetileWorkspace(workspace) {
        if (!this._settings) return;
        if (!this._settings.get_boolean('enabled')) {
            this._raiseFloatingWindows(workspace);
            return;
        }
        const tiledWindows = this._getWindowsForWorkspace(workspace)
            .filter(w => !this._isFloating(w));
        if (tiledWindows.length === 0) {
            this._raiseFloatingWindows(workspace);
            return;
        }

        const layout = this._settings.get_string('layout');
        if (layout === 'dwindle')
            this._retileDwindle(workspace, tiledWindows);
        else if (layout === 'centered-master-stack')
            this._retileCenteredMasterStack(workspace, tiledWindows);
        else
            this._retileMasterStack(workspace, tiledWindows);

        this._doUpdateBorders();
        this._raiseFloatingWindows(workspace);
    }

    // --- Master-Stack Helpers ---

    _getMasterRatio(ws) {
        if (!this._masterRatios.has(ws))
            this._masterRatios.set(ws, 0.5);
        return this._masterRatios.get(ws);
    }

    _getStackRatios(ws) {
        if (!this._stackRatios.has(ws))
            this._stackRatios.set(ws, new Map());
        return this._stackRatios.get(ws);
    }

    _retileMasterStack(workspace, tiledWindows, skipWindow = null) {
        const gap = this._settings.get_int('gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        if (!workArea) return;

        const numWindows = tiledWindows.length;
        const singleGap = this._settings.get_int('single-gap');

        if (numWindows === 1) {
            this._moveWindow(tiledWindows[0],
                workArea.x + singleGap, workArea.y + singleGap,
                workArea.width - singleGap * 2, workArea.height - singleGap * 2);
            return;
        }

        const areaX = workArea.x + gap;
        const areaY = workArea.y + gap;
        const areaW = workArea.width - gap * 2;
        const areaH = workArea.height - gap * 2;
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
                            h = areaY + areaH - y;
                        } else {
                            h = Math.floor(weights[i] * scale);
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
            const h = isLast
                ? (areaY + areaH - y)
                : Math.floor(totalStackH * weights[i] / totalWeight);
            const win = tiledWindows[i + 1];
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

    _retileCenteredMasterStack(workspace, tiledWindows, skipWindow = null) {
        const gap = this._settings.get_int('gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        if (!workArea) return;

        const numWindows = tiledWindows.length;
        const singleGap = this._settings.get_int('single-gap');

        if (numWindows === 1) {
            this._moveWindow(tiledWindows[0],
                workArea.x + singleGap, workArea.y + singleGap,
                workArea.width - singleGap * 2, workArea.height - singleGap * 2);
            return;
        }

        const areaX = workArea.x + gap;
        const areaY = workArea.y + gap;
        const areaW = workArea.width - gap * 2;
        const areaH = workArea.height - gap * 2;
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
                this._masterRatios.set(workspace, Math.max(0.15, Math.min(0.85, effectiveRatio)));
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
                            h = areaY + areaH - y;
                        } else {
                            h = Math.floor(stackWeights[i] * scale);
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
                const h = isLast
                    ? (areaY + areaH - y)
                    : Math.floor(totalStackH * stackWeights[i] / stackTotal);
                const win = stackWindows[i];
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

    _swapMasterStackWindows(winA, winB) {
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
            winA.move_resize_frame(false, frameB.x, frameB.y, frameB.width, frameB.height);
            winB.move_resize_frame(false, frameA.x, frameA.y, frameA.width, frameA.height);
        } catch (e) {
            log(`[plaid] swap move_resize failed: ${e.message}`);
        }
    }

    _resizeMasterStack(focused, workspace, axis, delta) {
        const tiledWindows = this._getWindowsForWorkspace(workspace)
            .filter(w => !this._isFloating(w));
        const numStack = tiledWindows.length - 1;
        if (numStack === 0) return;

        const monitor = global.display.get_primary_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        if (!workArea) return;
        const gap = this._settings.get_int('gap');
        const areaW = workArea.width - gap * 2;
        const layout = this._settings.get_string('layout');
        const masterDenom = layout === 'centered-master-stack' ? areaW - gap * 2 : areaW - gap;

        if (axis === 'width') {
            const currentRatio = this._getMasterRatio(workspace);
            const currentMasterW = masterDenom * currentRatio;
            const newMasterW = currentMasterW + delta;
            const minMaster = 100;
            const maxMaster = masterDenom - numStack * 100;
            if (maxMaster >= minMaster) {
                const clamped = Math.max(minMaster, Math.min(maxMaster, newMasterW));
                this._masterRatios.set(workspace, clamped / masterDenom);
            }
        } else {
            const idx = tiledWindows.indexOf(focused);
            if (idx === 0) return;
            const stackIdx = idx - 1;
            const stackRatios = this._getStackRatios(workspace);
            const currentWeight = stackRatios.has(stackIdx) ? stackRatios.get(stackIdx) : 1.0;
            const newWeight = Math.max(0.1, currentWeight + delta * 0.005);
            stackRatios.set(stackIdx, newWeight);
        }
    }

    _computeMasterStackDropTarget(ws, px, py) {
        const gap = this._settings.get_int('gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return -1;

        if (px < workArea.x || px > workArea.x + workArea.width ||
            py < workArea.y || py > workArea.y + workArea.height)
            return -1;

        const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
        if (tiled.length === 0) return -1;

        const areaX = workArea.x + gap;
        const areaY = workArea.y + gap;
        const areaW = workArea.width - gap * 2;
        const areaH = workArea.height - gap * 2;
        const numStack = tiled.length - 1;

        if (numStack === 0) return 0;

        const masterRatio = this._getMasterRatio(ws);
        const layout = this._settings.get_string('layout');

        if (layout === 'centered-master-stack') {
            const masterW = Math.floor((areaW - gap * 2) * masterRatio);
            const masterX = areaX + Math.floor((areaW - masterW) / 2);
            const leftStackW = masterX - areaX - gap;
            const rightStackX = masterX + masterW + gap;

            if (px >= masterX && px <= masterX + masterW)
                return 0;

            const leftCount = Math.ceil(numStack / 2);
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
                return 1;
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
                return 1 + leftCount;
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

    // --- BSP Tree ---

    _bspGetTree(workspace) {
        if (!this._bspTrees.has(workspace))
            this._bspTrees.set(workspace, null);
        return this._bspTrees.get(workspace);
    }

    _bspMakeLeaf(win) {
        return { type: 'leaf', window: win };
    }

    _bspMakeSplit(dir, ratio, first, second) {
        return { type: 'split', direction: dir, ratio, first, second };
    }

    _bspInsert(node, win, x, y, w, h, gap) {
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

    _bspRemove(node, win) {
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

    _bspCollectWindows(node) {
        if (!node) return [];
        if (node.type === 'empty') return [];
        if (node.type === 'leaf') return [node.window];
        return [...this._bspCollectWindows(node.first), ...this._bspCollectWindows(node.second)];
    }

    _bspLayout(node, x, y, w, h, gap, skipWindow) {
        if (!node) return;
        if (node.type === 'empty') return;
        if (node.type === 'leaf') {
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
        if (isH) {
            this._bspLayout(node.first, x, y, split, h, gap, skipWindow);
            this._bspLayout(node.second, x + split + gap, y, secondSize, h, gap, skipWindow);
        } else {
            this._bspLayout(node.first, x, y, w, split, gap, skipWindow);
            this._bspLayout(node.second, x, y + split + gap, w, secondSize, gap, skipWindow);
        }
    }

    _bspFindPath(node, win, path) {
        if (!node) return false;
        if (node.type === 'leaf') return node.window === win;
        path.push(node);
        if (this._bspFindPath(node.first, win, path)) return true;
        if (this._bspFindPath(node.second, win, path)) return true;
        path.pop();
        return false;
    }

    _bspSwapWindows(node, winA, winB) {
        if (!node) return;
        if (node.type === 'leaf') {
            if (node.window === winA) node.window = winB;
            else if (node.window === winB) node.window = winA;
            return;
        }
        this._bspSwapWindows(node.first, winA, winB);
        this._bspSwapWindows(node.second, winA, winB);
    }

    _bspFindLeafAtPoint(node, x, y, w, h, px, py, gap) {
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

    _bspReplaceLeaf(node, targetLeaf, newWin, gap) {
        if (!node) return null;
        if (node.type === 'empty') {
            if (node === targetLeaf)
                return this._bspMakeLeaf(newWin);
            return node;
        }
        if (node.type === 'leaf') {
            if (node === targetLeaf) {
                const dir = ((node._w || 0) >= (node._h || 0)) ? 'h' : 'v';
                const ratio = this._settings.get_double('dwindle-ratio');
                return this._bspMakeSplit(dir, ratio, node, this._bspMakeLeaf(newWin));
            }
            return node;
        }
        node.first = this._bspReplaceLeaf(node.first, targetLeaf, newWin, gap);
        node.second = this._bspReplaceLeaf(node.second, targetLeaf, newWin, gap);
        return node;
    }

    _bspTagGeometry(node, x, y, w, h, gap) {
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

    _bspInsertForWorkspace(ws, win) {
        const gap = this._settings.get_int('gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return;
        let tree = this._bspGetTree(ws);

        if (tree) {
            const existing = this._bspCollectWindows(tree);
            if (existing.includes(win)) return;
        }

        const areaX = workArea.x + gap;
        const areaY = workArea.y + gap;
        const areaW = workArea.width - gap * 2;
        const areaH = workArea.height - gap * 2;

        if (tree) {
            const [px, py] = global.get_pointer();
            this._bspTagGeometry(tree, areaX, areaY, areaW, areaH, gap);
            const target = this._bspFindLeafAtPoint(tree, areaX, areaY, areaW, areaH, px, py, gap);
            if (target) {
                tree = this._bspReplaceLeaf(tree, target, win, gap);
            } else {
                tree = this._bspInsert(tree, win, areaX, areaY, areaW, areaH, gap);
            }
        } else {
            tree = this._bspInsert(tree, win, areaX, areaY, areaW, areaH, gap);
        }
        this._bspTrees.set(ws, tree);
    }

    _retileDwindle(workspace, tiledWindows) {
        const gap = this._settings.get_int('gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        if (!workArea) return;

        if (tiledWindows.length === 1) {
            const singleGap = this._settings.get_int('single-gap');
            this._moveWindow(
                tiledWindows[0],
                workArea.x + singleGap,
                workArea.y + singleGap,
                workArea.width - singleGap * 2,
                workArea.height - singleGap * 2
            );
            return;
        }

        let tree = this._bspGetTree(workspace);
        const areaX = workArea.x + gap;
        const areaY = workArea.y + gap;
        const areaW = workArea.width - gap * 2;
        const areaH = workArea.height - gap * 2;

        if (tree) {
            const treeWins = this._bspCollectWindows(tree);
            for (const tw of treeWins) {
                if (!tiledWindows.includes(tw)) {
                    tree = this._bspRemove(tree, tw);
                }
            }
            const [px, py] = global.get_pointer();
            for (const win of tiledWindows) {
                const currentWins = this._bspCollectWindows(tree);
                if (!currentWins.includes(win)) {
                    this._bspTagGeometry(tree, areaX, areaY, areaW, areaH, gap);
                    const target = this._bspFindLeafAtPoint(tree, areaX, areaY, areaW, areaH, px, py, gap);
                    if (target) {
                        tree = this._bspReplaceLeaf(tree, target, win, gap);
                    } else {
                        tree = this._bspInsert(tree, win, areaX, areaY, areaW, areaH, gap);
                    }
                }
            }
            this._bspTrees.set(workspace, tree);
        } else {
            const [px, py] = global.get_pointer();
            tree = null;
            for (const win of tiledWindows) {
                if (tree) {
                    this._bspTagGeometry(tree, areaX, areaY, areaW, areaH, gap);
                    const target = this._bspFindLeafAtPoint(tree, areaX, areaY, areaW, areaH, px, py, gap);
                    if (target) {
                        tree = this._bspReplaceLeaf(tree, target, win, gap);
                    } else {
                        tree = this._bspInsert(tree, win, areaX, areaY, areaW, areaH, gap);
                    }
                } else {
                    tree = this._bspMakeLeaf(win);
                }
            }
            this._bspTrees.set(workspace, tree);
        }

        this._bspLayout(tree, workArea.x + gap, workArea.y + gap, workArea.width - gap * 2, workArea.height - gap * 2, gap);
    }

    _moveWindow(win, x, y, w, h) {
        if (!win || win.is_fullscreen()) return;
        if (!win.get_workspace()) return;
        const rect = win.get_frame_rect();
        if (rect.width === 0 || rect.height === 0) return;
        try {
            const actor = win.get_compositor_private();
            if (actor) actor.remove_all_transitions();
            win.move_resize_frame(false, x, y, w, h);
        } catch (e) {
            log(`[plaid] _moveWindow failed: ${e.message}`);
        }
    }

    _updateBorders() {
        if (!this._settings || this._destroyed) return;
        this._scheduleBorders();
    }

    _doUpdateBorders() {
        if (!this._settings) return;
        this._removeAllBorders();
        if (!this._settings.get_boolean('enabled')) return;

        const focusWindow = global.display.focus_window;

        const activeWidth = this._settings.get_int('active-border-width');
        const activeColor = (this._settings.get_strv('active-border-color') || [])[0] || '#3584e4';
        const inactiveWidth = this._settings.get_int('inactive-border-width');
        const inactiveColor = (this._settings.get_strv('inactive-border-color') || [])[0] || '#555555';
        const borderRadius = this._settings.get_int('border-radius');

        const ws = global.workspace_manager.get_active_workspace();
        if (!ws) return;

        const windows = this._getWindowsForWorkspace(ws);
        for (const win of windows) {
            if (win.is_fullscreen()) continue;
            if (this._grabOp && win === this._getActiveWindow()) continue;
            const actor = win.get_compositor_private();
            if (!actor) continue;
            const frame = win.get_frame_rect();
            if (frame.width === 0 || frame.height === 0) continue;

            const isFocused = win === focusWindow;
            const borderWidth = isFocused ? activeWidth : inactiveWidth;
            const borderColor = isFocused ? activeColor : inactiveColor;

            if (borderWidth === 0) continue;

            const buffer = win.get_buffer_rect();
            const offsetX = frame.x - buffer.x;
            const offsetY = frame.y - buffer.y;

            const border = new St.Widget({
                name: 'tiling-border',
                x: offsetX - borderWidth,
                y: offsetY - borderWidth,
                width: frame.width + borderWidth * 2,
                height: frame.height + borderWidth * 2,
                style: `border: ${borderWidth}px solid ${borderColor}; border-radius: ${borderRadius}px; box-sizing: border-box;`,
                reactive: false,
                visible: true,
            });
            actor.add_child(border);
            this._windowBorders.set(win, border);
        }

        this._raiseFloatingWindows(ws);
    }

    _updateBordersDuringGrab() {
        if (!this._settings || !this._settings.get_boolean('enabled')) return;
        const ws = global.workspace_manager.get_active_workspace();
        if (!ws) return;
        const focusWindow = global.display.focus_window;
        const activeWidth = this._settings.get_int('active-border-width');
        const inactiveWidth = this._settings.get_int('inactive-border-width');

        for (const [win, border] of this._windowBorders.entries()) {
            if (!win.get_compositor_private()) {
                this._removeBorder(win);
                continue;
            }
            const frame = win.get_frame_rect();
            if (frame.width === 0 || frame.height === 0) continue;
            const buffer = win.get_buffer_rect();
            const offsetX = frame.x - buffer.x;
            const offsetY = frame.y - buffer.y;
            const bw = win === focusWindow ? activeWidth : inactiveWidth;
            border.set_position(offsetX - bw, offsetY - bw);
            border.set_size(frame.width + bw * 2, frame.height + bw * 2);
        }
    }

    _removeAllBorders() {
        for (const border of this._windowBorders.values()) {
            try { border.destroy(); } catch (_e) {}
        }
        this._windowBorders.clear();
    }

    _removeBorder(win) {
        const border = this._windowBorders.get(win);
        if (border) {
            try { border.destroy(); } catch (_e) {}
            this._windowBorders.delete(win);
        }
    }

    _updateDropOverlaySize() {
        const monitors = global.display.get_n_monitors();
        let maxX = 0, maxY = 0;
        for (let i = 0; i < monitors; i++) {
            const geom = global.display.get_monitor_geometry(i);
            maxX = Math.max(maxX, geom.x + geom.width);
            maxY = Math.max(maxY, geom.y + geom.height);
        }
        if (this._dropOverlay) {
            this._dropOverlay.set_position(0, 0);
            this._dropOverlay.set_size(maxX, maxY);
        }
    }

    // --- Keybindings ---

    _registerKeybindings() {
        const bindings = [
            { key: 'move-focus-left', fn: () => this._moveFocus('left') },
            { key: 'move-focus-right', fn: () => this._moveFocus('right') },
            { key: 'move-focus-up', fn: () => this._moveFocus('up') },
            { key: 'move-focus-down', fn: () => this._moveFocus('down') },
            { key: 'swap-left', fn: () => this._swapWindow('left') },
            { key: 'swap-right', fn: () => this._swapWindow('right') },
            { key: 'swap-up', fn: () => this._swapWindow('up') },
            { key: 'swap-down', fn: () => this._swapWindow('down') },
            { key: 'resize-shrink-width', fn: () => this._resizeWindow('shrink', 'width') },
            { key: 'resize-grow-width', fn: () => this._resizeWindow('grow', 'width') },
            { key: 'resize-shrink-height', fn: () => this._resizeWindow('shrink', 'height') },
            { key: 'resize-grow-height', fn: () => this._resizeWindow('grow', 'height') },
            { key: 'toggle-float', fn: () => this._toggleFloat() },
            { key: 'toggle-tiling', fn: () => this._toggleTiling() },
            { key: 'pick-float-window', fn: () => this._handlePickFloat() },
        ];

        for (const { key, fn } of bindings) {
            Main.wm.addKeybinding(
                key,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL,
                fn
            );
        }
    }

    _removeKeybindings() {
        const keys = [
            'move-focus-left', 'move-focus-right', 'move-focus-up', 'move-focus-down',
            'swap-left', 'swap-right', 'swap-up', 'swap-down',
            'resize-shrink-width', 'resize-grow-width', 'resize-shrink-height', 'resize-grow-height',
            'toggle-float', 'toggle-tiling', 'pick-float-window',
        ];
        for (const key of keys) {
            Main.wm.removeKeybinding(key);
        }
    }

    _getActiveWindow() {
        return global.display.focus_window;
    }

    _getDirectionVector(direction) {
        switch (direction) {
            case 'left': return { dx: -1, dy: 0 };
            case 'right': return { dx: 1, dy: 0 };
            case 'up': return { dx: 0, dy: -1 };
            case 'down': return { dx: 0, dy: 1 };
        }
        return { dx: 0, dy: 0 };
    }

    _getWindowCenter(win) {
        const frame = win.get_frame_rect();
        return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
    }

    _moveFocus(direction) {
        const focused = this._getActiveWindow();
        if (!focused) return;
        const ws = focused.get_workspace();
        if (!ws) return;

        const windows = this._getWindowsForWorkspace(ws)
            .filter(w => !this._isFloating(w));
        if (windows.length <= 1) return;

        const focusedCenter = this._getWindowCenter(focused);
        const dir = this._getDirectionVector(direction);

        let bestWindow = null;
        let bestScore = -Infinity;

        for (const win of windows) {
            if (win === focused) continue;
            const center = this._getWindowCenter(win);
            const diffX = center.x - focusedCenter.x;
            const diffY = center.y - focusedCenter.y;
            const dot = diffX * dir.dx + diffY * dir.dy;
            if (dot > 0) {
                const distance = Math.sqrt(diffX * diffX + diffY * diffY);
                const score = dot / (distance + 1);
                if (score > bestScore) {
                    bestScore = score;
                    bestWindow = win;
                }
            }
        }

        if (bestWindow) {
            this._keyboardFocusChange = true;
            bestWindow.activate(global.get_current_time());
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._keyboardFocusChange = false;
                return false;
            });
        }
    }

    _swapWindow(direction) {
        const focused = this._getActiveWindow();
        if (!focused) return;
        if (this._isFloating(focused)) {
            this._moveFloating(focused, direction);
            return;
        }
        const ws = focused.get_workspace();
        if (!ws) return;

        const windows = this._getWindowsForWorkspace(ws)
            .filter(w => !this._isFloating(w));
        if (windows.length <= 1) return;

        const focusedCenter = this._getWindowCenter(focused);
        const dir = this._getDirectionVector(direction);

        let bestWindow = null;
        let bestScore = -Infinity;

        for (const win of windows) {
            if (win === focused) continue;
            const center = this._getWindowCenter(win);
            const diffX = center.x - focusedCenter.x;
            const diffY = center.y - focusedCenter.y;
            const dot = diffX * dir.dx + diffY * dir.dy;
            if (dot > 0) {
                const distance = Math.sqrt(diffX * diffX + diffY * diffY);
                const score = dot / (distance + 1);
                if (score > bestScore) {
                    bestScore = score;
                    bestWindow = win;
                }
            }
        }

        if (!bestWindow) return;

        const layout = this._settings.get_string('layout');
        if (layout === 'dwindle') {
            const tree = this._bspGetTree(ws);
            if (tree) {
                this._bspSwapWindows(tree, focused, bestWindow);
            }
        } else {
            this._swapMasterStackWindows(focused, bestWindow);
        }
        this._retileWorkspace(ws);
        this._keyboardFocusChange = true;
        focused.activate(global.get_current_time());
        this._cursorWarpDeferred(focused);
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._keyboardFocusChange = false;
            return false;
        });
    }

    _resizeWindow(action, axis) {
        const focused = this._getActiveWindow();
        if (!focused) return;

        const amount = this._settings.get_int('resize-amount');
        const delta = action === 'grow' ? amount : -amount;

        if (this._isFloating(focused)) {
            this._resizeFloating(focused, axis, delta);
            return;
        }

        const ws = focused.get_workspace();
        if (!ws) return;

        const tiledWindows = this._getWindowsForWorkspace(ws)
            .filter(w => !this._isFloating(w));
        const idx = tiledWindows.indexOf(focused);
        if (idx === -1 || tiledWindows.length <= 1) return;

        const layout = this._settings.get_string('layout');
        if (layout === 'dwindle')
            this._resizeDwindle(focused, ws, axis, delta);
        else
            this._resizeMasterStack(focused, ws, axis, delta);

        this._retileWorkspace(ws);
    }

    _resizeFloating(win, axis, delta) {
        const frame = win.get_frame_rect();
        if (frame.width === 0 || frame.height === 0) return;
        let x = frame.x;
        let y = frame.y;
        let w = frame.width;
        let h = frame.height;
        if (axis === 'width') {
            w = Math.max(100, w + delta);
        } else {
            h = Math.max(100, h + delta);
        }
        this._moveWindow(win, x, y, w, h);
    }

    _moveFloating(win, direction) {
        const amount = this._settings.get_int('resize-amount');
        const frame = win.get_frame_rect();
        if (frame.width === 0 || frame.height === 0) return;

        const [curX, curY] = global.get_pointer();
        const relX = curX - frame.x;
        const relY = curY - frame.y;

        let x = frame.x;
        let y = frame.y;
        switch (direction) {
            case 'left': x -= amount; break;
            case 'right': x += amount; break;
            case 'up': y -= amount; break;
            case 'down': y += amount; break;
        }
        this._moveWindow(win, x, y, frame.width, frame.height);
        this._warpCursor(win, x, y, relX, relY);
    }

    _resizeDwindle(focused, workspace, axis, delta) {
        const tree = this._bspGetTree(workspace);
        if (!tree) return;

        const targetIsHorizontal = axis === 'width';
        const path = [];
        this._bspFindPath(tree, focused, path);

        for (let i = path.length - 1; i >= 0; i--) {
            if ((path[i].direction === 'h') === targetIsHorizontal) {
                const monitor = global.display.get_primary_monitor();
                const workArea = workspace.get_work_area_for_monitor(monitor);
                if (!workArea) return;
                const axisSize = targetIsHorizontal ? workArea.width : workArea.height;
                path[i].ratio = Math.max(0.15, Math.min(0.85, path[i].ratio + delta / axisSize));
                return;
            }
        }
    }

    _toggleFloat() {
        const focused = this._getActiveWindow();
        if (!focused) return;

        const wms = focused.get_wm_class_instance();
        if (!wms) return;

        const lower = wms.toLowerCase();
        const current = new Set(this._settings.get_strv('float-windows'));
        const wasFloating = current.has(lower);

        if (wasFloating) {
            current.delete(lower);
        } else {
            current.add(lower);
        }

        this._settings.set_strv('float-windows', [...current]);
        const ws = focused.get_workspace();
        if (!ws) return;

        if (wasFloating) {
            const layout = this._settings.get_string('layout');
            if (layout === 'dwindle')
                this._bspInsertForWorkspace(ws, focused);
        } else {
            const layout = this._settings.get_string('layout');
            if (layout === 'dwindle') {
                const tree = this._bspGetTree(ws);
                if (tree)
                    this._bspTrees.set(ws, this._bspRemove(tree, focused));
            }
        }

        this._keyboardFocusChange = true;
        this._retileWorkspace(ws);
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._keyboardFocusChange = false;
            return false;
        });
    }

    _toggleTiling() {
        const enabled = this._settings.get_boolean('enabled');
        this._settings.set_boolean('enabled', !enabled);

        if (enabled) {
            this._removeAllBorders();
            this._bspTrees.clear();
            this._masterRatios.clear();
            this._stackRatios.clear();
        } else {
            this._keyboardFocusChange = true;
            this._retileAll();
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._keyboardFocusChange = false;
                return false;
            });
        }
    }

    // --- Grab-Based Mouse Resize & Swap ---

    _connectGrabSignals() {
        this._addSignal(global.display, global.display.connect('grab-op-begin', (_d, metaWindow, grabOp) => {
            if (this._destroyed || !this._settings || !this._settings.get_boolean('mouse-resize')) return;
            if (!this._settings.get_boolean('enabled')) return;
            this._handleGrabBegin(metaWindow, grabOp);
        }));
        this._addSignal(global.display, global.display.connect('grab-op-end', (_d, metaWindow, grabOp) => {
            this._handleGrabEnd(metaWindow, grabOp);
        }));
    }

    _disconnectGrabSignals() {
        this._stopLiveResizeLoop();
    }

    _handleGrabBegin(metaWindow, grabOp) {
        if (!metaWindow || metaWindow.get_window_type() !== Meta.WindowType.NORMAL) return;
        if (metaWindow.is_skip_taskbar()) return;
        const ws = metaWindow.get_workspace();
        if (!ws || ws !== global.workspace_manager.get_active_workspace()) return;

        const [px, py] = global.get_pointer();
        const frame = metaWindow.get_frame_rect();
        const buffer = metaWindow.get_buffer_rect();
        if (!frame || !buffer) return;

        this._grabOp = grabOp;
        this._swapTarget = null;

        const wmClass = metaWindow.get_wm_class_instance() || '?';
        log(`[plaid] GRAB_BEGIN win=${wmClass} rect=${JSON.stringify(frame)} grabOp=${grabOp} isResize=${this._isResizeGrab(grabOp)} isMove=${this._isMoveGrab(grabOp)} float=${this._isFloating(metaWindow)}`);

        if (this._isResizeGrab(grabOp) && !this._isFloating(metaWindow)) {
            const [startX, startY] = global.get_pointer();
            this._grabStartX = startX;
            this._grabStartY = startY;
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
        } else if (this._isMoveGrab(grabOp) && !this._isFloating(metaWindow)) {
            this._startGrabLoop(metaWindow, 'move');
        } else {
            this._grabOp = null;
        }
    }

    _handleGrabEnd(metaWindow, grabOp) {
        const wasTracking = this._grabOp !== null;

        if (wasTracking && metaWindow && !this._isFloating(metaWindow)) {
            const ws = metaWindow.get_workspace();
            if (ws) {
                if (this._isMoveGrab(grabOp)) {
                    this._repositionWindow(metaWindow, ws);
                }
                this._retileWorkspace(ws);
                try { metaWindow.raise(); } catch (_e) {}
            }
        }

        if (wasTracking && metaWindow) {
            const wmClass = metaWindow.get_wm_class_instance() || '?';
            const ws = metaWindow.get_workspace();
            if (ws) {
                const tree = this._bspGetTree(ws);
                const treeWins = tree ? this._bspCollectWindows(tree) : [];
                const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
                log(`[plaid] GRAB_END win=${wmClass} treeWins=[${treeWins.map(w => w.get_wm_class_instance() || '?').join(',')}] tiled=[${tiled.map(w => w.get_wm_class_instance() || '?').join(',')}]`);
            }
        }

        this._hideDropPreview();
        this._stopLiveResizeLoop();
        this._grabOp = null;
        this._swapTarget = null;
        this._lastSwapTarget = null;
        this._grabInitialStackRatios = null;
    }

    _isResizeGrab(grabOp) {
        // GNOME 50: MetaGrabOp is bitfield-encoded.
        // WINDOW_BASE=1, direction in bits 12-15 (W=1,E=2,S=4,N=8).
        // Resize ops have direction bits; move ops have none.
        if (grabOp === Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN) return true;
        if (grabOp === Meta.GrabOp.NONE) return false;
        const direction = (grabOp >> 12) & 0xF;
        return (grabOp & 1) !== 0 && direction !== 0;
    }

    _isMoveGrab(grabOp) {
        if (grabOp === Meta.GrabOp.NONE) return false;
        if (grabOp === Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN) return false;
        const direction = (grabOp >> 12) & 0xF;
        return (grabOp & 1) !== 0 && direction === 0;
    }

    _startGrabLoop(metaWindow, mode) {
        this._stopLiveResizeLoop();

        const ws = metaWindow.get_workspace();

        this._liveResizeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (this._destroyed || !metaWindow || !this._grabOp) {
                this._liveResizeId = 0;
                return GLib.SOURCE_REMOVE;
            }

            const frame = metaWindow.get_frame_rect();
            if (frame.width === 0 || frame.height === 0) return GLib.SOURCE_CONTINUE;

            if (mode === 'resize') {
                const [curX, curY] = global.get_pointer();
                const dx = curX - this._grabStartX;
                const dy = curY - this._grabStartY;

                const gap = this._settings.get_int('gap');
                const monitor = global.display.get_primary_monitor();
                const workArea = ws.get_work_area_for_monitor(monitor);
                if (!workArea) return GLib.SOURCE_CONTINUE;

                const layout = this._settings.get_string('layout');
                if (layout === 'dwindle') {
                    const tree = this._bspGetTree(ws);
                    if (tree) {
                        const areaX = workArea.x + gap;
                        const areaY = workArea.y + gap;
                        const areaW = workArea.width - gap * 2;
                        const areaH = workArea.height - gap * 2;
                        this._bspTagGeometry(tree, areaX, areaY, areaW, areaH, gap);

                        if (this._grabResizeNodeW) {
                            const axis = this._grabResizeNodeW._w;
                            if (axis > 0) {
                                this._grabResizeNodeW.ratio = Math.max(0.15, Math.min(0.85,
                                    this._grabInitialRatioW + (dx * this._grabWidthSign) / (axis - gap)));
                            }
                        }
                        if (this._grabResizeNodeH) {
                            const axis = this._grabResizeNodeH._h;
                            if (axis > 0) {
                                this._grabResizeNodeH.ratio = Math.max(0.15, Math.min(0.85,
                                    this._grabInitialRatioH + (dy * this._grabHeightSign) / (axis - gap)));
                            }
                        }
                    }
                } else {
                    const areaW = workArea.width - gap * 2;
                    const areaH = workArea.height - gap * 2;

                    if (this._grabWidthSign !== 0) {
                        const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
                        const idx = tiled.indexOf(metaWindow);
                        log(`[plaid] MS_RESIZE dx=${dx} dy=${dy} wSign=${this._grabWidthSign} hSign=${this._grabHeightSign} idx=${idx} numTiled=${tiled.length} initMasterRatio=${this._grabInitialMasterRatio.toFixed(3)}`);
                        let sign = this._grabWidthSign;
                        if (idx > 0) sign = -sign;
                        const masterDenom = layout === 'centered-master-stack' ? areaW - gap * 2 : areaW - gap;
                        if (masterDenom > 0) {
                            let ratioDelta = (dx * sign) / masterDenom;
                            if (layout === 'centered-master-stack' && idx > 0)
                                ratioDelta *= 2;
                            const newRatio = this._grabInitialMasterRatio + ratioDelta;
                            this._masterRatios.set(ws, Math.max(0.15, Math.min(0.85, newRatio)));
                        }
                    }
                    if (this._grabHeightSign !== 0) {
                        const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
                        const idx = tiled.indexOf(metaWindow);
                        if (idx > 0 && this._grabInitialStackRatios) {
                            log(`[plaid] MS_HEIGHT idx=${idx} dy=${dy} hSign=${this._grabHeightSign} initStackRatios=[${[...this._grabInitialStackRatios.entries()].map(([k,v])=>`${k}:${v.toFixed(2)}`).join(',')}]`);
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
                                    newHeights.push(Math.max(10, initH + delta));
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
                                const newWeight = Math.max(0.1,
                                    initialWeight + (dy * this._grabHeightSign) / totalStackH * numStack);
                                const stackRatios = this._getStackRatios(ws);
                                stackRatios.set(idx - 1, newWeight);
                            }
                        }
                    }
                }

                this._moveTiledExcept(metaWindow);
                this._updateBordersDuringGrab();
            } else if (mode === 'move') {
                this._updateMoveDragPreview(metaWindow);
            }

            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopLiveResizeLoop() {
        if (this._liveResizeId) {
            GLib.source_remove(this._liveResizeId);
            this._liveResizeId = 0;
        }
    }

    _moveTiledExcept(skipWindow) {
        const ws = skipWindow.get_workspace();
        if (!ws) return;
        const gap = this._settings.get_int('gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return;

        const layout = this._settings.get_string('layout');
        if (layout === 'dwindle') {
            const tree = this._bspGetTree(ws);
            if (!tree) return;
            const treeWins = this._bspCollectWindows(tree);
            if (!treeWins.includes(skipWindow)) return;
            this._bspLayout(tree, workArea.x + gap, workArea.y + gap, workArea.width - gap * 2, workArea.height - gap * 2, gap, skipWindow);
        } else {
            const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
            if (tiled.length <= 1) return;
            if (layout === 'centered-master-stack')
                this._retileCenteredMasterStack(ws, tiled, skipWindow);
            else
                this._retileMasterStack(ws, tiled, skipWindow);
        }
    }

    _safeMove(win, x, y, w, h) {
        if (!win || win.is_fullscreen() || !win.get_workspace()) return;
        const frame = win.get_frame_rect();
        try {
            const actor = win.get_compositor_private();
            if (actor) actor.remove_all_transitions();
            win.move_resize_frame(false, x, y, w, h);
        } catch (e) {
            log(`[plaid] _safeMove FAILED: ${win.get_wm_class_instance() || '?'} to ${x},${y} ${w}x${h}: ${e.message}`);
        }
    }

    _swapInLayout(winA, winB) {
        if (!winA || !winB) return;
        const ws = winA.get_workspace();
        if (!ws) return;
        const layout = this._settings.get_string('layout');
        if (layout === 'dwindle') {
            const tree = this._bspGetTree(ws);
            if (tree) this._bspSwapWindows(tree, winA, winB);
        } else {
            this._swapMasterStackWindows(winA, winB);
        }
    }

    _performSwap(winA, winB) {
        this._swapInLayout(winA, winB);
    }

    _checkSwapTarget(metaWindow) {
        if (!this._isMoveGrab(this._grabOp)) return;
        const ws = metaWindow.get_workspace();
        const [px, py] = global.get_pointer();
        const target = global.display.get_window_at_position(px, py);
        if (target && target !== metaWindow && target.get_workspace() === ws &&
            this._shouldManage(target) && !this._isFloating(target)) {
            this._swapTarget = target;
        } else {
            this._swapTarget = null;
        }
    }

    // --- Pick Mode ---

    _startPickMode() {
        if (this._pickFocusId) {
            try { global.display.disconnect(this._pickFocusId); } catch (_e) {}
            this._pickFocusId = null;
        }
        this._pickFocusId = global.display.connect('notify::focus-window', () => {
            const win = global.display.focus_window;
            if (!win) return;
            if (this._pickFocusId) {
                try { global.display.disconnect(this._pickFocusId); } catch (_e) {}
                this._pickFocusId = null;
            }
            const cls = win.get_wm_class_instance() || '';
            const title = win.get_title() || '';
            this._settings.set_string('pick-mode-class', cls);
            this._settings.set_string('pick-mode-title', title);
            this._settings.set_boolean('pick-mode', false);
        });
    }

    _handlePickFloat() {
        const win = global.display.focus_window;
        if (!win) {
            Main.notify(_('No window is focused'));
            return;
        }

        const cls = win.get_wm_class_instance() || '';
        const title = win.get_title() || '';

        if (!cls && !title) {
            Main.notify(_('Could not identify the focused window'));
            return;
        }

        this._showFloatPickDialog(cls, title);
    }

    _showFloatPickDialog(cls, title) {
        this._destroyFloatPickDialog();
        const dialog = new ModalDialog();
        this._pickDialog = dialog;

        const content = new St.BoxLayout({ vertical: true, style: 'spacing: 12px;' });

        const header = new St.Label({
            text: _('Add Floating Window'),
            style: 'font-weight: bold; font-size: 14px;',
        });
        content.add_child(header);

        const subtitle = new St.Label({
            text: _('How should this window be identified?'),
        });
        content.add_child(subtitle);

        dialog.contentLayout.add_child(content);

        const buttons = [];

        if (cls) {
            buttons.push({
                label: _('By class: %s').replace('%s', cls),
                action: () => {
                    this._addFloatEntry('float-windows', cls.toLowerCase());
                    dialog.close();
                },
                key: Clutter.KEY_c,
            });
        }

        if (title) {
            buttons.push({
                label: _('By title: %s').replace('%s', title),
                action: () => {
                    this._addFloatEntry('float-titles', title);
                    dialog.close();
                },
                key: Clutter.KEY_t,
            });
        }

        buttons.push({
            label: _('Cancel'),
            action: () => dialog.close(),
            key: Clutter.KEY_Escape,
        });

        dialog.setButtons(buttons);
        dialog.open();
    }

    _addFloatEntry(key, value) {
        const current = new Set(this._settings.get_strv(key));
        current.add(value);
        this._settings.set_strv(key, [...current]);

        if (key === 'float-windows') {
            this._floatingClasses = new Set(this._settings.get_strv('float-windows'));
        } else {
            this._floatingTitles = new Set(this._settings.get_strv('float-titles'));
        }

        if (value.length > 40)
            value = value.substring(0, 37) + '...';
        Main.notify(_('Added "%s" to float list').replace('%s', value));
    }

    _destroyFloatPickDialog() {
        if (this._pickDialog) {
            try { this._pickDialog.close(); } catch (_e) {}
            this._pickDialog = null;
        }
    }

    // --- Drag & Drop Repositioning ---

    _updateMoveDragPreview(metaWindow) {
        if (!metaWindow || !this._settings) return;
        const ws = metaWindow.get_workspace();
        if (!ws) return;

        const [px, py] = global.get_pointer();
        const tiledWindows = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
        if (tiledWindows.length <= 1) {
            this._hideDropPreview();
            return;
        }

        const layout = this._settings.get_string('layout');
        if (layout === 'dwindle') {
            const leaf = this._computeDwindleDropTarget(ws, px, py);
            if (leaf && leaf.type === 'leaf') {
                this._showDropPreview(leaf._x, leaf._y, leaf._w, leaf._h);
            } else {
                this._hideDropPreview();
            }
        } else {
            const targetIdx = this._computeMasterStackDropTarget(ws, px, py);
            if (targetIdx >= 0) {
                this._showMasterStackPreview(ws, targetIdx);
            } else {
                this._hideDropPreview();
            }
        }
    }

    _showMasterStackPreview(ws, targetIdx) {
        const gap = this._settings.get_int('gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return;

        const areaX = workArea.x + gap;
        const areaY = workArea.y + gap;
        const areaW = workArea.width - gap * 2;
        const areaH = workArea.height - gap * 2;
        const masterRatio = this._getMasterRatio(ws);
        const layout = this._settings.get_string('layout');

        let rx, ry;
        let rw, rh;

        if (targetIdx === 0) {
            if (layout === 'centered-master-stack') {
                const masterW = Math.floor((areaW - gap * 2) * masterRatio);
                rx = areaX + Math.floor((areaW - masterW) / 2);
                rw = masterW;
            } else {
                rw = Math.floor((areaW - gap) * masterRatio);
                rx = areaX;
            }
            ry = areaY;
            rh = areaH;
        } else {
            if (layout === 'centered-master-stack') {
                const leftCount = Math.ceil((this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w)).length - 1) / 2);
                const masterW = Math.floor((areaW - gap * 2) * masterRatio);
                const masterX = areaX + Math.floor((areaW - masterW) / 2);
                if (targetIdx <= leftCount) {
                    rx = areaX;
                    rw = masterX - areaX - gap;
                } else {
                    rx = masterX + masterW + gap;
                    rw = areaX + areaW - rx;
                }
            } else {
                const masterW = Math.floor((areaW - gap) * masterRatio);
                rx = areaX + masterW + gap;
                rw = areaW - masterW - gap;
            }
            ry = areaY;
            rh = areaH;
        }

        this._showDropPreview(rx, ry, rw, rh);
    }

    _computeDwindleDropTarget(ws, px, py) {
        const tree = this._bspGetTree(ws);
        if (!tree) return null;

        const gap = this._settings.get_int('gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return null;

        if (px < workArea.x || px > workArea.x + workArea.width ||
            py < workArea.y || py > workArea.y + workArea.height)
            return null;

        const ax = workArea.x + gap;
        const ay = workArea.y + gap;
        const aw = workArea.width - gap * 2;
        const ah = workArea.height - gap * 2;

        this._bspTagGeometry(tree, ax, ay, aw, ah, gap);
        return this._bspFindLeafAtPoint(tree, ax, ay, aw, ah, px, py, gap);
    }

    _showDropPreview(x, y, w, h) {
        if (w <= 0 || h <= 0) {
            this._hideDropPreview();
            return;
        }
        if (!this._dropPreview) {
            this._dropPreview = new St.Widget({
                style: 'background-color: rgba(53, 132, 228, 0.15); border: 2px solid #3584e4;',
                reactive: false,
                visible: true,
            });
            this._dropOverlay.add_child(this._dropPreview);
        }
        this._dropPreview.set_position(x, y);
        this._dropPreview.set_size(w, h);
    }

    _hideDropPreview() {
        if (this._dropPreview) {
            this._dropPreview.destroy();
            this._dropPreview = null;
        }
    }

    _repositionWindow(window, ws) {
        if (!window || !ws || !this._settings) return;
        const [px, py] = global.get_pointer();
        const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
        if (tiled.length <= 1) return;

        const layout = this._settings.get_string('layout');
        if (layout === 'dwindle') {
            const targetLeaf = this._computeDwindleDropTarget(ws, px, py);
            if (!targetLeaf || targetLeaf.type !== 'leaf') return;

            const tree = this._bspGetTree(ws);
            if (!tree) return;

            const gap = this._settings.get_int('gap');
            let newTree = this._bspRemove(tree, window);
            if (newTree.type === 'empty') newTree = null;

            if (newTree && targetLeaf.window !== window) {
                newTree = this._bspReplaceLeaf(newTree, targetLeaf, window, gap);
            }
            this._bspTrees.set(ws, newTree);
        } else {
            const targetIdx = this._computeMasterStackDropTarget(ws, px, py);
            if (targetIdx < 0) return;

            const order = this._getWorkspaceOrder(ws);
            const currentIdx = order.indexOf(window);
            if (currentIdx === -1 || currentIdx === targetIdx) return;

            order.splice(currentIdx, 1);
            const adjusted = targetIdx > currentIdx ? targetIdx - 1 : targetIdx;
            order.splice(adjusted, 0, window);
            const tiledOnly = order.filter(w =>
                !this._isFloating(w) &&
                w.get_window_type() === Meta.WindowType.NORMAL &&
                !w.is_skip_taskbar() &&
                !w.minimized
            );
            if (layout === 'centered-master-stack')
                this._retileCenteredMasterStack(ws, tiledOnly);
            else
                this._retileMasterStack(ws, tiledOnly);
        }
    }

}
