import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

const CornerEffect = GObject.registerClass({
    GTypeName: 'PlaidCornerEffect',
    Properties: {
        'radius': GObject.ParamSpec.double(
            'radius', 'Radius', 'Radius',
            GObject.ParamFlags.READWRITE,
            0, 200, 0,
        ),
    },
}, class CornerEffect extends Clutter.ShaderEffect {
    _init(params = {}) {
        super._init(params);
        this._radius = 0;
        this._sizeId = 0;
    }

    get radius() {
        return this._radius;
    }

    set radius(value) {
        if (this._radius !== value) {
            this._radius = value;
            this.set_uniform_value('radius', parseFloat(value));
        }
    }

    vfunc_set_actor(actor) {
        if (this._sizeId) {
            const old = this.get_actor();
            if (old) old.disconnect(this._sizeId);
            this._sizeId = 0;
        }
        if (actor) {
            this._updateSize(actor);
            this._sizeId = actor.connect('notify::size', () => {
                this._updateSize(actor);
            });
        }
        super.vfunc_set_actor(actor);
    }

    _updateSize(actor) {
        const [w, h] = actor.get_size();
        this.set_uniform_value('width', parseFloat(w));
        this.set_uniform_value('height', parseFloat(h));
    }
});

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
        this._lastFocusedPerWorkspace = new Map();
        this._signals = [];
        this._pendingRetileIds = new Map();
        this._pendingBorderId = 0;
        this._keyboardFocusChange = false;
        this._grabOp = null;
        this._grabInitRect = null;
        this._liveResizeId = 0;
        this._swapTarget = null;
        this._lastSwapTarget = null;
        this._dropPreview = null;
        this._decorationsHidden = new Set();
        this._cornerEffects = new Map();
        this._cornerShaderSource = null;
        const shaderPath = this.path + '/corner.glsl';
        try {
            this._cornerShaderSource = Shell.get_file_contents_utf8_sync(shaderPath);
        } catch (e) {
            log(`[plaid] Failed to load corner shader: ${e.message}`);
        }

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
            this._applyCornerRadiusAll();
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
        this._removeAllCornerEffects();
        this._hideDropPreview();
        if (this._dropOverlay) {
            this._dropOverlay.destroy();
            this._dropOverlay = null;
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
        this._lastFocusedPerWorkspace = null;
        this._restoreAllDecorations();
        this._decorationsHidden = null;
        this._signals = null;
        this._cornerEffects = null;
        this._cornerShaderSource = null;
        this._swapTarget = null;
        this._lastSwapTarget = null;
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
            log(`[plaid] window-created: "${win.get_title()}" type=${win.get_window_type()} skip_taskbar=${win.is_skip_taskbar()} transient=${!!win.get_transient_for()} class=${win.get_wm_class_instance()}`);
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
                const doCorner = () => {
                    if (this._destroyed) return;
                    this._applyCornerRadius(win);
                };
                const actor = win.get_compositor_private();
                if (actor) {
                    const firstFrameId = actor.connect('first-frame', () => {
                        actor.disconnect(firstFrameId);
                        doRaise();
                        doCorner();
                    });
                } else {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        doRaise();
                        doCorner();
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
                    this._bspTrees.delete(workspace);
                    this._stackRatios.delete(workspace);
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
        this._addSignal(this._settings, this._settings.connect('changed::layout', () => this._retileAll()));
        this._addSignal(this._settings, this._settings.connect('changed::dwindle-ratio', () => this._retileAll()));
        this._addSignal(this._settings, this._settings.connect('changed::hide-title-bars', () => {
            if (this._destroyed) return;
            if (this._settings.get_boolean('hide-title-bars'))
                this._applyHideDecorationsAll();
            else
                this._restoreAllDecorations();
        }));
        this._addSignal(this._settings, this._settings.connect('changed::active-border-width', () => this._updateBorders()));
        this._addSignal(this._settings, this._settings.connect('changed::active-border-color', () => this._updateBorders()));
        this._addSignal(this._settings, this._settings.connect('changed::inactive-border-width', () => this._updateBorders()));
        this._addSignal(this._settings, this._settings.connect('changed::inactive-border-color', () => this._updateBorders()));
        this._addSignal(this._settings, this._settings.connect('changed::border-radius', () => this._updateBorders()));
        this._addSignal(this._settings, this._settings.connect('changed::corner-radius', () => {
            this._applyCornerRadiusAll();
        }));
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
            const layout = this._settings.get_string('layout');
            if (layout === 'dwindle' && !this._isFloating(win)) {
                this._bspInsertForWorkspace(ws, win);
            }
            if (this._settings.get_boolean('hide-title-bars'))
                this._hideDecorations(win);
            this._applyCornerRadius(win);
        }
    }

    _removeWindow(win) {
        if (!this._settings) return;
        const ws = this._windowWorkspaces.get(win) || win.get_workspace();
        this._windowWorkspaces.delete(win);
        this._decorationsHidden.delete(win);
        this._disconnectWindowSignals(win);
        this._removeBorder(win);
        this._removeCornerEffect(win);
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
        if (layout === 'dwindle') {
            this._retileDwindle(workspace, tiledWindows);
        } else {
            this._retileMasterStack(workspace, tiledWindows);
        }

        this._doUpdateBorders();
        this._raiseFloatingWindows(workspace);
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

    _bspLayout(node, x, y, w, h, gap, skipWindow) {
        if (!node) return;
        if (node.type === 'empty') return;
        if (node.type === 'leaf') {
            if (node.window !== skipWindow)
                this._safeMove(node.window, x, y, w, h);
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

    _bspUpdateRatioFromFrame(node, win, frame, x, y, w, h, gap) {
        if (!node || node.type === 'empty') return false;
        if (node.type === 'leaf') return node.window === win;

        const isH = node.direction === 'h';
        const axisSize = isH ? w : h;
        const split = Math.floor((axisSize - gap) * node.ratio);
        const secondSize = axisSize - split - gap;

        if (isH) {
            if (this._bspUpdateRatioFromFrame(node.first, win, frame, x, y, split, h, gap)) {
                const newRatio = (frame.x + frame.width - x) / (w - gap);
                node.ratio = Math.max(0.15, Math.min(0.85, newRatio));
                return true;
            }
            if (this._bspUpdateRatioFromFrame(node.second, win, frame, x + split + gap, y, secondSize, h, gap)) {
                const newRatio = (frame.x - gap - x) / (w - gap);
                node.ratio = Math.max(0.15, Math.min(0.85, newRatio));
                return true;
            }
        } else {
            if (this._bspUpdateRatioFromFrame(node.first, win, frame, x, y, w, split, gap)) {
                const newRatio = (frame.y + frame.height - y) / (h - gap);
                node.ratio = Math.max(0.15, Math.min(0.85, newRatio));
                return true;
            }
            if (this._bspUpdateRatioFromFrame(node.second, win, frame, x, y + split + gap, w, secondSize, gap)) {
                const newRatio = (frame.y - gap - y) / (h - gap);
                node.ratio = Math.max(0.15, Math.min(0.85, newRatio));
                return true;
            }
        }
        return false;
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
            log(`[plaid] _moveWindow failed: ${e.message}`);
        }
    }

    _applyCornerRadius(win) {
        if (!this._settings || this._destroyed) return;
        if (!this._cornerShaderSource) return;
        const radius = this._settings.get_int('corner-radius');
        const actor = win.get_compositor_private();
        if (!actor) return;

        const existing = this._cornerEffects.get(win);
        if (existing) {
            existing.radius = radius;
            if (radius <= 0) this._removeCornerEffect(win);
            actor.queue_repaint();
            return;
        }

        if (radius <= 0) return;

        const effect = new CornerEffect({ radius });
        try {
            effect.set_shader_source(this._cornerShaderSource);
        } catch (e) {
            log(`[plaid] Failed to set shader source: ${e.message}`);
            return;
        }
        actor.add_effect(effect);
        this._cornerEffects.set(win, effect);
    }

    _applyCornerRadiusAll() {
        if (!this._settings || this._destroyed) return;
        const radius = this._settings.get_int('corner-radius');
        if (radius <= 0) {
            this._removeAllCornerEffects();
            return;
        }
        for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
            const ws = global.workspace_manager.get_workspace_by_index(i);
            for (const win of ws.list_windows()) {
                const actor = win.get_compositor_private();
                if (actor) this._applyCornerRadius(win);
            }
        }
    }

    _removeCornerEffect(win) {
        const effect = this._cornerEffects.get(win);
        if (effect) {
            const actor = win.get_compositor_private();
            if (actor) {
                try { actor.remove_effect(effect); } catch (_e) {}
            }
            this._cornerEffects.delete(win);
        }
    }

    _removeAllCornerEffects() {
        for (const [win, effect] of this._cornerEffects) {
            const actor = win.get_compositor_private();
            if (actor) {
                try { actor.remove_effect(effect); } catch (_e) {}
            }
        }
        this._cornerEffects.clear();
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
        ];

        for (const { key, fn } of bindings) {
            const flags = key.startsWith('resize-')
                ? Meta.KeyBindingFlags.NONE
                : Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
            Main.wm.addKeybinding(
                key,
                this._settings,
                flags,
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
                log(`[plaid] swap move_resize failed: ${e.message}`);
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

        this._grabOp = grabOp;
        this._grabInitRect = metaWindow.get_frame_rect();
        this._swapTarget = null;

        if (this._isResizeGrab(grabOp) && !this._isFloating(metaWindow)) {
            this._startGrabLoop(metaWindow, 'resize');
        } else if (this._isMoveGrab(grabOp) && !this._isFloating(metaWindow)) {
            this._startGrabLoop(metaWindow, 'move');
        } else {
            this._grabOp = null;
            this._grabInitRect = null;
        }
    }

    _handleGrabEnd(metaWindow, grabOp) {
        const wasTracking = this._grabOp !== null;

        if (wasTracking && metaWindow && !this._isFloating(metaWindow)) {
            const ws = metaWindow.get_workspace();
            if (ws) {
                if (this._isMoveGrab(grabOp)) {
                    this._repositionWindow(metaWindow, ws);
                } else {
                    this._updateRatiosAtGrabEnd(metaWindow, ws);
                }
                this._retileWorkspace(ws);
            }
        }

        this._hideDropPreview();
        this._stopLiveResizeLoop();
        this._grabOp = null;
        this._grabInitRect = null;
        this._swapTarget = null;
        this._lastSwapTarget = null;
    }

    _updateRatiosAtGrabEnd(win, ws) {
        const layout = this._settings.get_string('layout');
        const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
        if (tiled.length <= 1) return;

        if (layout === 'master-stack') {
            const gap = this._settings.get_int('gap');
            const monitor = global.display.get_primary_monitor();
            const workArea = ws.get_work_area_for_monitor(monitor);
            if (!workArea) return;
            const areaW = workArea.width - gap * 2;
            const numStack = tiled.length - 1;

            const frame = win.get_frame_rect();
            const idx = tiled.indexOf(win);
            if (idx === 0) {
                this._masterRatios.set(ws, frame.width / (areaW - gap));
            } else if (idx > 0) {
                const areaH = workArea.height - gap * 2;
                const gapTotal = gap * (numStack - 1);
                const totalStackH = areaH - gapTotal;
                if (totalStackH > 0) {
                    const stackRatios = this._getStackRatios(ws);
                    stackRatios.set(idx - 1, frame.height / totalStackH);
                }
            }
        } else if (layout === 'dwindle') {
            const tree = this._bspGetTree(ws);
            if (!tree) return;
            const gap = this._settings.get_int('gap');
            const monitor = global.display.get_primary_monitor();
            const workArea = ws.get_work_area_for_monitor(monitor);
            if (!workArea) return;
            const ax = workArea.x + gap;
            const ay = workArea.y + gap;
            const aw = workArea.width - gap * 2;
            const ah = workArea.height - gap * 2;
            const frame = win.get_frame_rect();
            this._bspUpdateRatioFromFrame(tree, win, frame, ax, ay, aw, ah, gap);
        }
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
        let lastWidth = this._grabInitRect?.width || 0;
        let lastHeight = this._grabInitRect?.height || 0;

        this._liveResizeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (this._destroyed || !metaWindow || !this._grabOp) {
                this._liveResizeId = 0;
                return GLib.SOURCE_REMOVE;
            }

            const frame = metaWindow.get_frame_rect();
            if (frame.width === 0 || frame.height === 0) return GLib.SOURCE_CONTINUE;

            if (mode === 'resize') {
                if (frame.width === lastWidth && frame.height === lastHeight) {
                    this._checkSwapTarget(metaWindow);
                    return GLib.SOURCE_CONTINUE;
                }
                lastWidth = frame.width;
                lastHeight = frame.height;

                this._moveTiledExcept(metaWindow);
                this._doUpdateBorders();
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
        const layout = this._settings.get_string('layout');
        const tiledWindows = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
        const gap = this._settings.get_int('gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return;

        const isGrab = this._grabOp !== null;
        const draggedIdx = isGrab ? tiledWindows.indexOf(skipWindow) : -1;

        if (layout === 'master-stack') {
            if (tiledWindows.length === 1) return;
            const areaX = workArea.x + gap;
            const areaY = workArea.y + gap;
            const areaW = workArea.width - gap * 2;
            const areaH = workArea.height - gap * 2;
            const numStack = tiledWindows.length - 1;

            let masterW;
            if (draggedIdx === 0) {
                masterW = skipWindow.get_frame_rect().width;
            } else {
                masterW = Math.floor((areaW - gap) * this._getMasterRatio(ws));
            }
            const minMaster = 100;
            const maxMaster = areaW - gap - numStack * 100;
            if (maxMaster >= minMaster)
                masterW = Math.max(minMaster, Math.min(maxMaster, masterW));
            const stackW = areaW - masterW - gap;

            if (tiledWindows[0] !== skipWindow)
                this._safeMove(tiledWindows[0], areaX, areaY, masterW, areaH);

            const stackRatios = this._getStackRatios(ws);
            const resizeStackIdx = draggedIdx > 0 ? draggedIdx - 1 : -1;
            const resizeStackH = resizeStackIdx >= 0 ? skipWindow.get_frame_rect().height : 0;

            let y = areaY;
            for (let j = 0; j < numStack; j++) {
                const isLast = j === numStack - 1;
                let h;
                if (j === resizeStackIdx) {
                    h = resizeStackH;
                } else if (resizeStackIdx >= 0) {
                    const otherWeights = [];
                    let otherTotal = 0;
                    for (let k = 0; k < numStack; k++) {
                        if (k === resizeStackIdx) continue;
                        const w = stackRatios.has(k) ? stackRatios.get(k) : 1.0;
                        otherWeights.push({ idx: k, weight: w });
                        otherTotal += w;
                    }
                    const remainingH = areaH - resizeStackH - gap * (numStack - 1);
                    const oIdx = otherWeights.findIndex(o => o.idx === j);
                    if (oIdx >= 0 && otherTotal > 0) {
                        h = oIdx < otherWeights.length - 1
                            ? Math.floor(remainingH * otherWeights[oIdx].weight / otherTotal)
                            : Math.max(0, areaY + areaH - y);
                    } else {
                        h = isLast ? Math.max(0, areaY + areaH - y) : 100;
                    }
                } else {
                    const weights = [];
                    let totalWeight = 0;
                    for (let k = 0; k < numStack; k++) {
                        const w = stackRatios.has(k) ? stackRatios.get(k) : 1.0;
                        weights.push(w);
                        totalWeight += w;
                    }
                    h = isLast
                        ? (areaY + areaH - y)
                        : Math.floor((areaH - gap * (numStack - 1)) * weights[j] / totalWeight);
                }
                if (tiledWindows[j + 1] !== skipWindow)
                    this._safeMove(tiledWindows[j + 1], areaX + masterW + gap, y, stackW, h);
                if (!isLast) y += h + gap;
            }
        } else if (layout === 'dwindle') {
            const tree = this._bspGetTree(ws);
            if (!tree) return;
            if (isGrab) {
                const frame = skipWindow.get_frame_rect();
                const ax = workArea.x + gap;
                const ay = workArea.y + gap;
                const aw = workArea.width - gap * 2;
                const ah = workArea.height - gap * 2;
                this._bspUpdateRatioFromFrame(tree, skipWindow, frame, ax, ay, aw, ah, gap);
            }
            this._bspLayout(tree, workArea.x + gap, workArea.y + gap, workArea.width - gap * 2, workArea.height - gap * 2, gap, skipWindow);
        }
    }

    _safeMove(win, x, y, w, h) {
        if (!win || win.is_fullscreen() || !win.get_workspace()) return;
        try {
            const actor = win.get_compositor_private();
            if (actor) actor.remove_all_transitions();
            win.move_resize_frame(true, x, y, w, h);
        } catch (_e) {}
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
            const order = this._getWorkspaceOrder(ws);
            const idxA = order.indexOf(winA);
            const idxB = order.indexOf(winB);
            if (idxA !== -1 && idxB !== -1) {
                order[idxA] = winB;
                order[idxB] = winA;
            }
        }
    }

    _performSwap(winA, winB) {
        this._swapInLayout(winA, winB);
        const ws = winA.get_workspace();
        if (!ws) return;

        const layout = this._settings.get_string('layout');
        if (layout !== 'dwindle') {
            const frameA = winA.get_frame_rect();
            const frameB = winB.get_frame_rect();
            try {
                winA.move_resize_frame(false, frameB.x, frameB.y, frameB.width, frameB.height);
                winB.move_resize_frame(false, frameA.x, frameA.y, frameA.width, frameA.height);
            } catch (e) {
                log(`[plaid] swap move_resize failed: ${e.message}`);
            }
        }
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

    // --- Drag & Drop Repositioning ---

    _updateMoveDragPreview(metaWindow) {
        if (!metaWindow || !this._settings) return;
        const ws = metaWindow.get_workspace();
        if (!ws) return;

        const [px, py] = global.get_pointer();
        const layout = this._settings.get_string('layout');
        const tiledWindows = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
        if (tiledWindows.length <= 1) {
            this._hideDropPreview();
            return;
        }

        let targetRect = null;
        if (layout === 'master-stack') {
            const target = this._computeMasterStackDropTarget(ws, px, py);
            if (target) {
                targetRect = this._getTargetRect(ws, target);
            }
        } else if (layout === 'dwindle') {
            const leaf = this._computeDwindleDropTarget(ws, px, py);
            if (leaf && leaf.type === 'leaf') {
                targetRect = { x: leaf._x, y: leaf._y, width: leaf._w, height: leaf._h };
            }
        }

        if (targetRect) {
            this._showDropPreview(targetRect.x, targetRect.y, targetRect.width, targetRect.height);
        } else {
            this._hideDropPreview();
        }
    }

    _computeMasterStackDropTarget(ws, px, py) {
        const gap = this._settings.get_int('gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return null;

        if (px < workArea.x || px > workArea.x + workArea.width ||
            py < workArea.y || py > workArea.y + workArea.height)
            return null;

        const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
        if (tiled.length === 0) return null;

        const areaX = workArea.x + gap;
        const areaY = workArea.y + gap;
        const areaW = workArea.width - gap * 2;
        const areaH = workArea.height - gap * 2;
        const numStack = tiled.length - 1;

        if (numStack === 0) return { index: 0 };

        const masterRatio = this._getMasterRatio(ws);
        const masterW = Math.floor((areaW - gap) * masterRatio);
        const stackW = areaW - masterW - gap;
        const stackX = areaX + masterW + gap;

        if (px >= areaX && px <= areaX + masterW)
            return { index: 0 };

        if (px >= stackX && px <= stackX + stackW && py >= areaY) {
            let y = areaY;
            const totalStackH = areaH - gap * (numStack - 1);
            for (let i = 0; i < numStack; i++) {
                const h = Math.floor(totalStackH / numStack);
                const slotEnd = y + h + (i < numStack - 1 ? gap / 2 : totalStackH);
                if (py <= slotEnd)
                    return { index: i + 1 };
                y += h + gap;
            }
            return { index: tiled.length - 1 };
        }

        return null;
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

    _getTargetRect(ws, target) {
        const gap = this._settings.get_int('gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return null;

        const areaX = workArea.x + gap;
        const areaY = workArea.y + gap;
        const areaW = workArea.width - gap * 2;
        const areaH = workArea.height - gap * 2;
        const numStack = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w)).length - 1;

        if (numStack === 0)
            return { x: areaX, y: areaY, width: areaW, height: areaH };

        const masterRatio = this._getMasterRatio(ws);
        const masterW = Math.floor((areaW - gap) * masterRatio);

        if (target.index === 0)
            return { x: areaX, y: areaY, width: masterW, height: areaH };

        const stackX = areaX + masterW + gap;
        const stackW = areaW - masterW - gap;
        let y = areaY;
        const slotH = Math.floor((areaH - gap * (numStack - 1)) / numStack);
        for (let i = 0; i < target.index - 1; i++)
            y += slotH + gap;

        return { x: stackX, y, width: stackW, height: slotH };
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
        const layout = this._settings.get_string('layout');
        const [px, py] = global.get_pointer();
        const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
        if (tiled.length <= 1) return;

        if (layout === 'master-stack') {
            const target = this._computeMasterStackDropTarget(ws, px, py);
            if (!target) return;
            const order = this._getWorkspaceOrder(ws);
            const currentIdx = order.indexOf(window);
            if (currentIdx === -1 || currentIdx === target.index) return;

            order.splice(currentIdx, 1);
            const adjusted = target.index > currentIdx ? target.index - 1 : target.index;
            order.splice(adjusted, 0, window);
        } else if (layout === 'dwindle') {
            const targetLeaf = this._computeDwindleDropTarget(ws, px, py);
            if (!targetLeaf || targetLeaf.type !== 'leaf') return;

            const tree = this._bspGetTree(ws);
            if (!tree) return;

            const gap = this._settings.get_int('gap');
            let newTree = this._bspRemove(tree, window);
            if (newTree.type === 'empty') newTree = null;

            if (newTree && targetLeaf.window !== window) {
                newTree = this._bspReplaceLeaf(newTree, targetLeaf, window, gap);
                this._bspTrees.set(ws, newTree);
            }
        }
    }

    // --- Title Bar Hiding ---

    _hideDecorations(win) {
        if (!win || !this._settings) return;
        const xid = win.get_xwindow();
        if (!xid) return;
        if (this._decorationsHidden.has(win)) return;

        try {
            Gio.Subprocess.new(
                ['xprop', '-id', String(xid), '-f', '_MOTIF_WM_HINTS', '32c',
                 '-set', '_MOTIF_WM_HINTS', '0x2, 0x0, 0x0, 0x0, 0x0'],
                Gio.SubprocessFlags.NONE
            );
            this._decorationsHidden.add(win);
        } catch (e) {
            log(`[plaid] _hideDecorations failed: ${e.message}`);
        }
    }

    _restoreDecorations(win) {
        if (!win) return;
        if (!this._decorationsHidden.has(win)) return;
        const xid = win.get_xwindow();
        if (!xid) return;

        try {
            Gio.Subprocess.new(
                ['xprop', '-id', String(xid), '-remove', '_MOTIF_WM_HINTS'],
                Gio.SubprocessFlags.NONE
            );
        } catch (e) {}
        this._decorationsHidden.delete(win);
    }

    _restoreAllDecorations() {
        for (const win of this._decorationsHidden) {
            const xid = win.get_xwindow();
            if (!xid) continue;
            try {
                Gio.Subprocess.new(
                    ['xprop', '-id', String(xid), '-remove', '_MOTIF_WM_HINTS'],
                    Gio.SubprocessFlags.NONE
                );
            } catch (_e) {}
        }
        this._decorationsHidden.clear();
    }

    _applyHideDecorationsAll() {
        for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
            const ws = global.workspace_manager.get_workspace_by_index(i);
            for (const win of ws.list_windows()) {
                if (this._shouldManage(win))
                    this._hideDecorations(win);
            }
        }
    }
}
