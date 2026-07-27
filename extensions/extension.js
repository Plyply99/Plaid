import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
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
        this._bspTrees = new Map();
        this._stackRatios = new Map();
        this._signals = [];
        this._pendingRetileIds = new Map();
        this._pendingBorderId = 0;
        this._mouseOp = null;
        this._stagePressId = 0;
        this._stageReleaseId = 0;
        this._stageMotionId = 0;
        this._keyboardFocusChange = false;

        this._disableMutterDefaults();
        this._borderContainer = new St.Widget({
            name: 'tiling-wm-borders',
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            reactive: false,
            visible: true,
        });
        Main.layoutManager.uiGroup.add_child(this._borderContainer);
        this._connectSignals();
        this._registerKeybindings();
        this._updateBorderContainer();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._destroyed) return false;
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
        this._disconnectStageEvents();
        this._restoreMutterDefaults();
        this._removeAllBorders();
        if (this._borderContainer) {
            this._borderContainer.destroy();
            this._borderContainer = null;
        }
        this._disconnectSignals();
        this._removeKeybindings();
        this._settings = null;
        this._floatingClasses = null;
        this._floatingTitles = null;
        this._windowBorders = null;
        this._workspaceOrders = null;
        this._windowWorkspaces = null;
        this._masterRatios = null;
        this._bspTrees = null;
        this._stackRatios = null;
        this._signals = null;
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
            }
        }));
        this._addSignal(global.display, global.display.connect('notify::focus-window', () => {
            this._updateBorders();
            if (this._settings.get_boolean('follow-focus') && this._keyboardFocusChange) {
                this._keyboardFocusChange = false;
                const win = global.display.focus_window;
                if (win) this._moveCursorToWindow(win);
            }
        }));
        this._addSignal(Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => {
            this._updateBorderContainer();
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
                    this._bspTrees.delete(workspace);
                    this._stackRatios.delete(workspace);
                }
            }
        }));
        this._addSignal(global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', () => {
            if (this._destroyed || !this._settings.get_boolean('enabled')) return;
            const ws = global.workspace_manager.get_active_workspace();
            if (!ws) return;
            const windows = this._getWindowsForWorkspace(ws);
            if (windows.length > 0) {
                this._keyboardFocusChange = true;
                windows[0].activate(global.get_current_time());
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._keyboardFocusChange = false;
                    return false;
                });
            }
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
        this._addSignal(this._settings, this._settings.connect('changed::layout', () => this._retileAll()));
        this._addSignal(this._settings, this._settings.connect('changed::dwindle-ratio', () => this._retileAll()));
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

        this._connectMouseEvents();

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
            log(`[tiling-wm] _moveCursorToWindow failed: ${e.message}`);
            return false;
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
        if (win.is_above()) return true;
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
            const layout = this._settings.get_string('layout');
            if (layout === 'dwindle' && !this._isFloating(win)) {
                this._bspInsertForWorkspace(ws, win);
            }
        }
    }

    _removeWindow(win) {
        if (!this._settings) return;
        const ws = this._windowWorkspaces.get(win) || win.get_workspace();
        this._windowWorkspaces.delete(win);
        this._disconnectWindowSignals(win);
        this._removeBorder(win);
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
            if (this._mouseOp && this._mouseOp.active && this._mouseOp.type === 'resize' && this._mouseOp.window === win) {
                try {
                    win.move_resize_frame(false, this._mouseOp.frozenX, this._mouseOp.frozenY, this._mouseOp.origFrame.w, this._mouseOp.origFrame.h);
                } catch (_e) {}
                return;
            }
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
        if (!this._settings.get_boolean('enabled')) return;
        const tiledWindows = this._getWindowsForWorkspace(workspace)
            .filter(w => !this._isFloating(w));
        if (tiledWindows.length === 0) return;

        const layout = this._settings.get_string('layout');
        if (layout === 'dwindle') {
            this._retileDwindle(workspace, tiledWindows);
        } else {
            this._retileMasterStack(workspace, tiledWindows);
        }

        this._doUpdateBorders();
    }

    _getMasterRatio(workspace) {
        if (!this._masterRatios.has(workspace))
            this._masterRatios.set(workspace, 0.5);
        return this._masterRatios.get(workspace);
    }

    _getStackRatios(workspace) {
        if (!this._stackRatios.has(workspace))
            this._stackRatios.set(workspace, new Map());
        return this._stackRatios.get(workspace);
    }

    _retileMasterStack(workspace, tiledWindows) {
        const gap = this._settings.get_int('gap');
        const numWindows = tiledWindows.length;

        const monitor = global.display.get_primary_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        if (!workArea) return;

        const singleGap = this._settings.get_int('single-gap');
        if (numWindows === 1) {
            this._moveWindow(
                tiledWindows[0],
                workArea.x + singleGap,
                workArea.y + singleGap,
                workArea.width - singleGap * 2,
                workArea.height - singleGap * 2
            );
        } else {
            const areaX = workArea.x + gap;
            const areaY = workArea.y + gap;
            const areaW = workArea.width - gap * 2;
            const areaH = workArea.height - gap * 2;
            const masterRatio = this._getMasterRatio(workspace);
            const masterW = Math.floor((areaW - gap) * masterRatio);
            const stackW = areaW - masterW - gap;
            const numStack = numWindows - 1;

            this._moveWindow(tiledWindows[0], areaX, areaY, masterW, areaH);

            const stackRatios = this._getStackRatios(workspace);
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
                this._moveWindow(
                    tiledWindows[i + 1],
                    areaX + masterW + gap, y,
                    stackW, h
                );
                if (!isLast) y += h + gap;
            }
        }
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

    _bspLayout(node, x, y, w, h, gap) {
        if (!node) return;
        if (node.type === 'empty') return;
        if (node.type === 'leaf') {
            this._moveWindow(node.window, x, y, w, h);
            return;
        }
        const isH = node.direction === 'h';
        const firstEmpty = !node.first || node.first.type === 'empty';
        const secondEmpty = !node.second || node.second.type === 'empty';
        if (firstEmpty && secondEmpty) return;
        if (firstEmpty) {
            this._bspLayout(node.second, x, y, w, h, gap);
            return;
        }
        if (secondEmpty) {
            this._bspLayout(node.first, x, y, w, h, gap);
            return;
        }
        const axisSize = isH ? w : h;
        const split = Math.floor((axisSize - gap) * node.ratio);
        const secondSize = axisSize - split - gap;
        if (isH) {
            this._bspLayout(node.first, x, y, split, h, gap);
            this._bspLayout(node.second, x + split + gap, y, secondSize, h, gap);
        } else {
            this._bspLayout(node.first, x, y, w, split, gap);
            this._bspLayout(node.second, x, y + split + gap, w, secondSize, gap);
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
        if (node.type === 'empty' || node.type === 'leaf') {
            node._x = x;
            node._y = y;
            node._w = w;
            node._h = h;
            return;
        }
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

    _bspBuildTree(windows, workArea, gap) {
        let tree = null;
        const x = workArea.x + gap;
        const y = workArea.y + gap;
        const w = workArea.width - gap * 2;
        const h = workArea.height - gap * 2;
        for (const win of windows)
            tree = this._bspInsert(tree, win, x, y, w, h, gap);
        return tree;
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
        if (tree) {
            const treeWins = this._bspCollectWindows(tree);
            for (const tw of treeWins) {
                if (!tiledWindows.includes(tw)) {
                    tree = this._bspRemove(tree, tw);
                }
            }
            this._bspTrees.set(workspace, tree);
        }
        const treeWins = this._bspCollectWindows(tree);
        const needsRebuild = !tree ||
            tiledWindows.length !== treeWins.length ||
            tiledWindows.some(w => !treeWins.includes(w));
        if (needsRebuild) {
            tree = this._bspBuildTree(tiledWindows, workArea, gap);
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
            win.move_resize_frame(false, x, y, w, h);
        } catch (e) {
            log(`[tiling-wm] _moveWindow failed: ${e.message}`);
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
            if (this._isFloating(win)) continue;
            const frame = win.get_frame_rect();
            if (frame.width === 0 || frame.height === 0) continue;

            const isFocused = win === focusWindow;
            const borderWidth = isFocused ? activeWidth : inactiveWidth;
            const borderColor = isFocused ? activeColor : inactiveColor;

            if (borderWidth === 0) continue;

            const border = new St.Widget({
                name: 'tiling-border',
                x: frame.x - borderWidth,
                y: frame.y - borderWidth,
                width: frame.width + borderWidth * 2,
                height: frame.height + borderWidth * 2,
                style: `border: ${borderWidth}px solid ${borderColor}; border-radius: ${borderRadius}px;`,
                reactive: false,
                visible: true,
            });
            this._borderContainer.add_child(border);
            this._windowBorders.set(win, border);
        }
    }

    _removeAllBorders() {
        if (!this._borderContainer) return;
        let child = this._borderContainer.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            child.destroy();
            child = next;
        }
        this._windowBorders.clear();
    }

    _removeBorder(win) {
        const border = this._windowBorders.get(win);
        if (border) {
            border.destroy();
            this._windowBorders.delete(win);
        }
    }

    _updateBorderContainer() {
        const monitors = global.display.get_n_monitors();
        let maxX = 0, maxY = 0;
        for (let i = 0; i < monitors; i++) {
            const geom = global.display.get_monitor_geometry(i);
            maxX = Math.max(maxX, geom.x + geom.width);
            maxY = Math.max(maxY, geom.y + geom.height);
        }
        this._borderContainer.set_position(0, 0);
        this._borderContainer.set_size(maxX, maxY);
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
        ];

        for (const { key, fn } of bindings) {
            Main.wm.addKeybinding(
                key,
                this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
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
            'toggle-float', 'toggle-tiling',
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
        if (this._isFloating(focused)) return;
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
            this._retileWorkspace(ws);
        } else {
            const frameA = focused.get_frame_rect();
            const frameB = bestWindow.get_frame_rect();
            try {
                focused.move_resize_frame(
                    false, frameB.x, frameB.y, frameB.width, frameB.height
                );
                bestWindow.move_resize_frame(
                    false, frameA.x, frameA.y, frameA.width, frameA.height
                );
            } catch (e) {
                log(`[tiling-wm] swap move_resize failed: ${e.message}`);
            }

            const order = this._getWorkspaceOrder(ws);
            const idxA = order.indexOf(focused);
            const idxB = order.indexOf(bestWindow);
            if (idxA !== -1 && idxB !== -1) {
                order[idxA] = bestWindow;
                order[idxB] = focused;
            }
            this._updateBorders();
        }
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

        if (layout === 'dwindle') {
            this._resizeDwindle(focused, ws, tiledWindows, idx, axis, delta);
        } else {
            this._resizeMasterStack(focused, ws, tiledWindows, idx, axis, delta);
        }

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

    _resizeMasterStack(focused, workspace, tiledWindows, idx, axis, delta) {
        const numStack = tiledWindows.length - 1;
        if (numStack === 0) return;

        const monitor = global.display.get_primary_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        if (!workArea) return;
        const gap = this._settings.get_int('gap');
        const areaW = workArea.width - gap * 2;

        if (axis === 'width') {
            const currentRatio = this._getMasterRatio(workspace);
            const currentMasterW = (areaW - gap) * currentRatio;
            const newMasterW = currentMasterW + delta;
            const minMaster = 100;
            const maxMaster = areaW - gap - numStack * 100;
            if (maxMaster < minMaster) return;
            const clamped = Math.max(minMaster, Math.min(maxMaster, newMasterW));
            this._masterRatios.set(workspace, clamped / (areaW - gap));
        } else {
            if (idx === 0) return;
            const stackIdx = idx - 1;
            const stackRatios = this._getStackRatios(workspace);
            const currentWeight = stackRatios.has(stackIdx) ? stackRatios.get(stackIdx) : 1.0;
            const deltaWeight = delta * 0.005;
            const newWeight = Math.max(0.1, currentWeight + deltaWeight);
            stackRatios.set(stackIdx, newWeight);

            const neighborIdx = stackIdx + 1 < numStack ? stackIdx + 1 : stackIdx - 1;
            if (neighborIdx >= 0 && neighborIdx < numStack) {
                const neighborWeight = stackRatios.has(neighborIdx) ? stackRatios.get(neighborIdx) : 1.0;
                stackRatios.set(neighborIdx, Math.max(0.1, neighborWeight - deltaWeight));
            }
        }
    }

    _resizeDwindle(focused, workspace, tiledWindows, idx, axis, delta) {
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
                const minR = 0.15;
                const maxR = 0.85;
                const axisSize = targetIsHorizontal ? workArea.width : workArea.height;
                const normalizedDelta = delta / axisSize;
                path[i].ratio = Math.max(minR, Math.min(maxR, path[i].ratio + normalizedDelta));
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

        if (current.has(lower)) {
            current.delete(lower);
        } else {
            current.add(lower);
        }

        this._settings.set_strv('float-windows', [...current]);
        const ws = focused.get_workspace();
        if (ws) {
            this._keyboardFocusChange = true;
            this._retileWorkspace(ws);
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._keyboardFocusChange = false;
                return false;
            });
        }
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

    // --- Mouse Edge Resize & Title Bar Swap ---

    _detectWindowEdge(win, px, py) {
        const frame = win.get_frame_rect();
        const THRESHOLD = 8;
        const TITLE_BAR_HEIGHT = 30;

        if (py >= frame.y && py < frame.y + TITLE_BAR_HEIGHT)
            return null;

        const edges = [];
        if (px >= frame.x && px <= frame.x + THRESHOLD)
            edges.push({ edge: 'left', dist: px - frame.x });
        if (px >= frame.x + frame.width - THRESHOLD && px <= frame.x + frame.width)
            edges.push({ edge: 'right', dist: frame.x + frame.width - px });
        if (py >= frame.y && py <= frame.y + THRESHOLD)
            edges.push({ edge: 'top', dist: py - frame.y });
        if (py >= frame.y + frame.height - THRESHOLD && py <= frame.y + frame.height)
            edges.push({ edge: 'bottom', dist: frame.y + frame.height - py });

        if (edges.length === 0) return null;
        edges.sort((a, b) => a.dist - b.dist);
        return edges[0].edge;
    }

    _connectMouseEvents() {
        this._disconnectStageEvents();
        const stage = global.stage;
        this._stagePressId = stage.connect('button-press-event', (_s, event) => this._onButtonPress(event));
        this._stageReleaseId = stage.connect('button-release-event', (_s, event) => this._onButtonRelease(event));
        this._stageMotionId = stage.connect('motion-event', (_s, event) => this._onPointerMotion(event));
    }

    _disconnectStageEvents() {
        const stage = global.stage;
        if (this._stagePressId) {
            try { stage.disconnect(this._stagePressId); } catch (_e) {}
            this._stagePressId = 0;
        }
        if (this._stageReleaseId) {
            try { stage.disconnect(this._stageReleaseId); } catch (_e) {}
            this._stageReleaseId = 0;
        }
        if (this._stageMotionId) {
            try { stage.disconnect(this._stageMotionId); } catch (_e) {}
            this._stageMotionId = 0;
        }
    }

    _onButtonPress(event) {
        if (this._mouseOp) return false;
        if (!this._settings || this._destroyed) return false;
        if (!this._settings.get_boolean('mouse-resize')) return false;
        if (!this._settings.get_boolean('enabled')) return false;

        const [px, py] = event.get_coords();
        const win = global.display.get_window_at_position(px, py);
        if (!win) return false;
        if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
        if (win.is_skip_taskbar()) return false;

        const ws = win.get_workspace();
        if (!ws) return false;
        if (ws !== global.workspace_manager.get_active_workspace()) return false;

        const isFloating = this._isFloating(win);
        const edge = this._detectWindowEdge(win, px, py);

        if (edge) {
            const frame = win.get_frame_rect();
            this._mouseOp = {
                active: true,
                type: 'resize',
                window: win,
                edge: edge,
                origFrame: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
                startPx: px,
                startPy: py,
                frozenX: frame.x,
                frozenY: frame.y,
            };
            this._setCursorForEdge(edge);
            return true;
        }

        if (isFloating) return false;

        const frame = win.get_frame_rect();
        this._mouseOp = {
            active: true,
            type: 'swap',
            window: win,
            origFrame: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
            startPx: px,
            startPy: py,
        };
        return false;
    }

    _onButtonRelease(_event) {
        if (!this._mouseOp || !this._mouseOp.active) return false;
        const op = this._mouseOp;

        if (op.type === 'resize') {
            const [px, py] = global.get_pointer();
            const delta = op.edge === 'left' || op.edge === 'right'
                ? px - op.startPx : py - op.startPy;

            if (!this._isFloating(op.window) && Math.abs(delta) > 2) {
                const layout = this._settings.get_string('layout');
                if (layout === 'master-stack') {
                    this._applyMasterStackResizeFromMouse(op, delta);
                } else {
                    this._applyDwindleResizeFromMouse(op, delta);
                }
            }
        } else if (op.type === 'swap') {
            const [px, py] = global.get_pointer();
            const dx = px - op.startPx;
            const dy = py - op.startPy;
            const distance = Math.sqrt(dx * dx + dy * dy);

            let swapped = false;
            if (distance > 30) {
                const target = global.display.get_window_at_position(px, py);
                if (target && target !== op.window && this._shouldManage(target) && !this._isFloating(target)) {
                    this._performSwap(op.window, target);
                    swapped = true;
                }
            }

            if (!swapped) {
                this._moveWindow(
                    op.window,
                    op.origFrame.x, op.origFrame.y,
                    op.origFrame.w, op.origFrame.h
                );
            }
        }

        this._resetCursor();
        this._mouseOp = null;
        if (op.type !== 'resize' || !this._isFloating(op.window)) {
            const ws = global.workspace_manager.get_active_workspace();
            if (ws) this._retileWorkspace(ws);
        }
        return false;
    }

    _applyMasterStackResizeFromMouse(op, delta) {
        const ws = op.window.get_workspace();
        if (!ws) return;
        const layout = this._settings.get_string('layout');
        if (layout !== 'master-stack') return;

        const tiledWindows = this._getWindowsForWorkspace(ws)
            .filter(w => !this._isFloating(w));
        if (tiledWindows.length <= 1) return;

        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return;
        const gap = this._settings.get_int('gap');
        const areaW = workArea.width - gap * 2;

        const idx = tiledWindows.indexOf(op.window);
        if (idx === -1) return;

        const currentRatio = this._getMasterRatio(ws);
        const currentMasterW = (areaW - gap) * currentRatio;
        const newMasterW = currentMasterW + delta;
        const minMaster = 100;
        const maxMaster = areaW - gap - (tiledWindows.length - 1) * 100;
        if (maxMaster < minMaster) return;
        const clamped = Math.max(minMaster, Math.min(maxMaster, newMasterW));
        this._masterRatios.set(ws, clamped / (areaW - gap));
    }

    _applyDwindleResizeFromMouse(op, delta) {
        const ws = op.window.get_workspace();
        if (!ws) return;
        const tree = this._bspGetTree(ws);
        if (!tree) return;

        const targetIsHorizontal = op.edge === 'left' || op.edge === 'right';
        const path = [];
        this._bspFindPath(tree, op.window, path);

        for (let i = path.length - 1; i >= 0; i--) {
            if ((path[i].direction === 'h') === targetIsHorizontal) {
                const monitor = global.display.get_primary_monitor();
                const workArea = ws.get_work_area_for_monitor(monitor);
                if (!workArea) return;
                const minR = 0.15;
                const maxR = 0.85;
                const axisSize = targetIsHorizontal ? workArea.width : workArea.height;
                const normalizedDelta = delta / axisSize;
                path[i].ratio = Math.max(minR, Math.min(maxR, path[i].ratio + normalizedDelta));
                return;
            }
        }
    }

    _performSwap(winA, winB) {
        const ws = winA.get_workspace();
        if (!ws) return;

        const layout = this._settings.get_string('layout');
        if (layout === 'dwindle') {
            const tree = this._bspGetTree(ws);
            if (tree) this._bspSwapWindows(tree, winA, winB);
            return;
        }

        const frameA = winA.get_frame_rect();
        const frameB = winB.get_frame_rect();
        try {
            winA.move_resize_frame(false, frameB.x, frameB.y, frameB.width, frameB.height);
            winB.move_resize_frame(false, frameA.x, frameA.y, frameA.width, frameA.height);
        } catch (e) {
            log(`[tiling-wm] mouse swap move_resize failed: ${e.message}`);
        }

        const order = this._getWorkspaceOrder(ws);
        const idxA = order.indexOf(winA);
        const idxB = order.indexOf(winB);
        if (idxA !== -1 && idxB !== -1) {
            order[idxA] = winB;
            order[idxB] = winA;
        }
    }

    _onPointerMotion(event) {
        if (!this._mouseOp || !this._mouseOp.active) {
            this._updateEdgeCursor(event);
            return false;
        }

        const op = this._mouseOp;
        const [px, py] = event.get_coords();

        if (op.type === 'resize') {
            const delta = op.edge === 'left' || op.edge === 'right'
                ? px - op.startPx : py - op.startPy;

            if (this._isFloating(op.window)) {
                let x = op.origFrame.x;
                let y = op.origFrame.y;
                let w = op.origFrame.w;
                let h = op.origFrame.h;
                if (op.edge === 'right') {
                    w = Math.max(100, op.origFrame.w + delta);
                } else if (op.edge === 'left') {
                    w = Math.max(100, op.origFrame.w - delta);
                    x = op.origFrame.x + op.origFrame.w - w;
                } else if (op.edge === 'bottom') {
                    h = Math.max(100, op.origFrame.h + delta);
                } else if (op.edge === 'top') {
                    h = Math.max(100, op.origFrame.h - delta);
                    y = op.origFrame.y + op.origFrame.h - h;
                }
                this._moveWindow(op.window, x, y, w, h);
            } else {
                this._moveWindow(op.window, op.frozenX, op.frozenY, op.origFrame.w, op.origFrame.h);

                const layout = this._settings.get_string('layout');
                if (layout === 'master-stack') {
                    this._applyMasterStackResizeFromMouse(op, delta);
                } else {
                    this._applyDwindleResizeFromMouse(op, delta);
                }
                const ws = op.window.get_workspace();
                if (ws) this._doRetileWorkspace(ws);
            }
        } else if (op.type === 'swap') {
            try {
                op.window.move_resize_frame(
                    false,
                    op.origFrame.x + px - op.startPx,
                    op.origFrame.y + py - op.startPy,
                    op.origFrame.w,
                    op.origFrame.h
                );
            } catch (_e) {}
            this._updateBorders();
        }

        return false;
    }

    _updateEdgeCursor(event) {
        if (!this._settings || !this._settings.get_boolean('mouse-resize')) {
            this._resetCursor();
            return;
        }
        if (!this._settings.get_boolean('enabled')) {
            this._resetCursor();
            return;
        }

        const [px, py] = event.get_coords();
        const win = global.display.get_window_at_position(px, py);
        if (!win || win.get_window_type() !== Meta.WindowType.NORMAL || win.is_skip_taskbar()) {
            this._resetCursor();
            return;
        }

        const ws = win.get_workspace();
        if (!ws || ws !== global.workspace_manager.get_active_workspace()) {
            this._resetCursor();
            return;
        }

        const edge = this._detectWindowEdge(win, px, py);
        if (edge) {
            this._setCursorForEdge(edge);
        } else {
            this._resetCursor();
        }
    }

    _setCursorForEdge(edge) {
        const cursorMap = {
            left: 'col-resize',
            right: 'col-resize',
            top: 'row-resize',
            bottom: 'row-resize',
        };
        try {
            global.stage.set_cursor_name(cursorMap[edge] || 'default');
        } catch (_e) {}
    }

    _resetCursor() {
        try {
            global.stage.set_cursor_name('default');
        } catch (_e) {}
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
}
