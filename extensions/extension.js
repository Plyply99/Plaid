import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

export default class TilingWMExtension extends Extension {
    enable() {
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
            this._retileAll();
            return false;
        });
    }

    disable() {
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
                const actor = win.get_compositor_private();
                if (actor) {
                    const firstFrameId = actor.connect('first-frame', () => {
                        actor.disconnect(firstFrameId);
                        const ws = win.get_workspace();
                        if (ws) this._retileWorkspace(ws);
                    });
                } else {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        const ws = win.get_workspace();
                        if (ws) this._retileWorkspace(ws);
                        return false;
                    });
                }
            }
        }));
        this._addSignal(global.display, global.display.connect('notify::focus-window', () => {
            this._updateBorders();
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
    }

    _shouldManage(win) {
        if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
        if (win.is_skip_taskbar()) return false;
        const wms = win.get_wm_class_instance();
        if (wms && this._floatingClasses.has(wms.toLowerCase())) return false;
        const title = win.get_title();
        if (title && this._floatingTitles.has(title)) return false;
        return true;
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
        const ws = this._windowWorkspaces.get(win) || win.get_workspace();
        if (!ws) return;
        const order = this._getWorkspaceOrder(ws);
        const idx = order.indexOf(win);
        if (idx === -1) return;
        order.splice(idx, 1);
        this._windowWorkspaces.delete(win);
        this._disconnectWindowSignals(win);
        this._removeBorder(win);
        const layout = this._settings.get_string('layout');
        if (layout === 'dwindle') {
            const tree = this._bspGetTree(ws);
            if (tree) this._bspTrees.set(ws, this._bspRemove(tree, win));
        }
        this._retileWorkspace(ws);
    }

    _connectWindowSignals(win) {
        const actor = win.get_compositor_private();
        if (actor && !this._actorSignals)
            this._actorSignals = new Map();
        if (!actor) return;
        if (this._actorSignals.has(actor)) return;
        const sigIds = [];
        sigIds.push({ emitter: win, id: win.connect('position-changed', () => this._updateBorders()) });
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
        return workspace.list_windows().filter(w =>
            w.get_window_type() === Meta.WindowType.NORMAL &&
            !w.is_skip_taskbar() &&
            !w.minimized
        );
    }

    _retileAll() {
        const ws = global.workspace_manager.get_active_workspace();
        if (ws) this._retileWorkspace(ws);
        for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
            const w = global.workspace_manager.get_workspace_by_index(i);
            if (w !== ws) this._retileWorkspace(w);
        }
    }

    _retileWorkspace(workspace) {
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

        this._updateBorders();
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
        if (!node) return null;
        if (node.type === 'leaf') {
            return node.window === win ? null : node;
        }
        node.first = this._bspRemove(node.first, win);
        node.second = this._bspRemove(node.second, win);
        if (!node.first && !node.second) return null;
        if (!node.first) return node.second;
        if (!node.second) return node.first;
        return node;
    }

    _bspCollectWindows(node) {
        if (!node) return [];
        if (node.type === 'leaf') return [node.window];
        return [...this._bspCollectWindows(node.first), ...this._bspCollectWindows(node.second)];
    }

    _bspLayout(node, x, y, w, h, gap) {
        if (!node) return;
        if (node.type === 'leaf') {
            this._moveWindow(node.window, x, y, w, h);
            return;
        }
        const isH = node.direction === 'h';
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
        if (node.type === 'leaf') {
            if (node === targetLeaf) {
                const dir = (node._w >= node._h) ? 'h' : 'v';
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
        if (node.type === 'leaf') {
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
        const treeWins = this._bspCollectWindows(tree);
        const needsRebuild = !tree || treeWins.length !== tiledWindows.length ||
            !tiledWindows.every(w => treeWins.includes(w));
        if (needsRebuild) {
            tree = this._bspBuildTree(tiledWindows, workArea, gap);
            this._bspTrees.set(workspace, tree);
        }

        this._bspLayout(tree, workArea.x + gap, workArea.y + gap, workArea.width - gap * 2, workArea.height - gap * 2, gap);
    }

    _moveWindow(win, x, y, w, h) {
        if (!win || win.is_fullscreen()) return;
        if (win.is_maximized()) return;
        const rect = win.get_frame_rect();
        if (rect.width === 0 || rect.height === 0) return;
        win.move_resize_frame(false, x, y, w, h);
    }

    _updateBorders() {
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
            bestWindow.activate(global.get_current_time());
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
            focused.move_resize_frame(
                false, frameB.x, frameB.y, frameB.width, frameB.height
            );
            bestWindow.move_resize_frame(
                false, frameA.x, frameA.y, frameA.width, frameA.height
            );

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
        if (this._isFloating(focused)) return;

        const ws = focused.get_workspace();
        if (!ws) return;

        const tiledWindows = this._getWindowsForWorkspace(ws)
            .filter(w => !this._isFloating(w));
        const idx = tiledWindows.indexOf(focused);
        if (idx === -1 || tiledWindows.length <= 1) return;

        const layout = this._settings.get_string('layout');
        const amount = this._settings.get_int('resize-amount');
        const delta = action === 'grow' ? amount : -amount;

        if (layout === 'dwindle') {
            this._resizeDwindle(focused, ws, tiledWindows, idx, axis, delta);
        } else {
            this._resizeMasterStack(focused, ws, tiledWindows, idx, axis, delta);
        }

        this._retileWorkspace(ws);
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
    }

    _toggleTiling() {
        const enabled = this._settings.get_boolean('enabled');
        this._settings.set_boolean('enabled', !enabled);

        if (enabled) {
            this._removeAllBorders();
        } else {
            this._retileAll();
        }
    }
}
