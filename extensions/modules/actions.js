// Window actions: focus, swap, resize, tiling/maximize toggles, centering,
// layout cycling, and the float picker.
//
// Methods live on this subsystem class.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ModalDialog } from 'resource:///org/gnome/shell/ui/modalDialog.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { LAYOUT_NAMES } from './helpers.js';
import { PlaidSubsystem } from './subsystem.js';


export class Actions extends PlaidSubsystem {
    constructor(core) {
        super(core);
    }

    getActiveWindow() {
        return global.display.focus_window;
    }

    moveFocus(direction) {
        const focused = this.getActiveWindow();
        if (!focused) return;
        const ws = focused.get_workspace();
        if (!ws) return;

        const windows = this.core.windows.getWindowsForWorkspace(ws)
            .filter(w => !this.core.windows.isFloating(w));
        if (windows.length <= 1) return;

        const bestWindow = this.core.bsp.findDirectionalTarget(focused, direction, windows);
        if (!bestWindow) return;

        this.core._keyboardFocusChange = true;
        bestWindow.activate(this.core.currentTime());
        this.core.signals.addIdle(() => {
            if (!this.core._settings) return false;
            this.core._keyboardFocusChange = false;
            return false;
        });
    }

    swapWindow(direction) {
        const focused = this.getActiveWindow();
        if (!focused) return;
        if (this.core.windows.isFloating(focused)) {
            this.moveFloating(focused, direction);
            return;
        }
        const ws = focused.get_workspace();
        if (!ws) return;
        if (this.core.windows.getWorkspaceLayout(ws) === 'floating') {
            this.moveFloating(focused, direction);
            return;
        }

        const windows = this.core.windows.getWindowsForWorkspace(ws)
            .filter(w => !this.core.windows.isFloating(w));
        if (windows.length <= 1) return;

        const bestWindow = this.core.bsp.findDirectionalTarget(focused, direction, windows);
        if (!bestWindow) return;

        const layout = this.core.windows.getWorkspaceLayout(ws);
        if (layout === 'dwindle') {
            const tree = this.core.bsp.bspGetTree(ws);
            if (tree) {
                this.core.bsp.bspSwapWindows(tree, focused, bestWindow);
            }
        } else {
            this.core.layouts.swapMasterStackWindows(focused, bestWindow);
        }
        this.core.layouts.retileWorkspace(ws);
        this.core._keyboardFocusChange = true;
        focused.activate(this.core.currentTime());
        this.core.windows.cursorWarpDeferred(focused);
        this.core.signals.addIdle(() => {
            if (!this.core._settings) return false;
            this.core._keyboardFocusChange = false;
            return false;
        });
    }

    resizeWindow(action, axis) {
        const focused = this.getActiveWindow();
        if (!focused) return;

        const amount = this.core._settings.get_int('resize-amount');
        const delta = action === 'grow' ? amount : -amount;

        if (this.core.windows.isFloating(focused)) {
            this.resizeFloating(focused, axis, delta);
            return;
        }

        const ws = focused.get_workspace();
        if (!ws) return;
        if (this.core.windows.getWorkspaceLayout(ws) === 'floating') {
            this.resizeFloating(focused, axis, delta);
            return;
        }

        const tiledWindows = this.core.windows.getWindowsForWorkspace(ws)
            .filter(w => !this.core.windows.isFloating(w));
        const idx = tiledWindows.indexOf(focused);
        if (idx === -1 || tiledWindows.length <= 1) return;

        const layout = this.core.windows.getWorkspaceLayout(ws);
        if (layout === 'dwindle')
            this.resizeDwindle(focused, ws, axis, delta);
        else
            this.core.layouts.resizeMasterStack(focused, ws, axis, delta);

        this.core.layouts.retileWorkspace(ws);
        if (this.core._settings.get_boolean('follow-focus'))
            this.core.windows.cursorWarpDeferred(focused);
    }

    resizeFloating(win, axis, delta) {
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
        this.core.placement.animFloat(win, x, y, w, h);
        this.core.windows.moveCursorToWindow(win);
    }

    moveFloating(win, direction) {
        const amount = this.core._settings.get_int('resize-amount');
        const frame = win.get_frame_rect();
        if (frame.width === 0 || frame.height === 0) return;

        let x = frame.x;
        let y = frame.y;
        switch (direction) {
            case 'left': x -= amount; break;
            case 'right': x += amount; break;
            case 'up': y -= amount; break;
            case 'down': y += amount; break;
        }
        this.core.placement.animFloat(win, x, y, frame.width, frame.height);
        this.core.windows.moveCursorToWindow(win);
    }

    resizeDwindle(focused, workspace, axis, delta) {
        const tree = this.core.bsp.bspGetTree(workspace);
        if (!tree) return;

        const targetIsHorizontal = axis === 'width';
        const path = [];
        this.core.bsp.bspFindPath(tree, focused, path);

        for (let i = path.length - 1; i >= 0; i--) {
            const split = path[i];
            if ((split.direction === 'h') === targetIsHorizontal) {
                const monitor = global.display.get_primary_monitor();
                const workArea = workspace.get_work_area_for_monitor(monitor);
                if (!workArea) return;
                // Scale the delta by the split's OWN span (tagged by
                // _bspTagGeometry during layout) so a deep-nested split
                // moves by the same RELATIVE amount as a top-level one —
                // the old full-work-area divisor made the resize feel
                // shallower at depth and shift with the gap settings.
                const axisSize = targetIsHorizontal
                    ? (split._w > 0 ? split._w : workArea.width)
                    : (split._h > 0 ? split._h : workArea.height);
                if (!(axisSize > 0)) return;
                // grow/shrink is relative to the FOCUSED window. The ratio is
                // the FIRST child's fraction, so a window living in the second
                // child must move the ratio the opposite way (the mouse-resize
                // path flips its sign the same way). Without this, keyboard
                // resize was inverted for every non-leftmost leaf — and the
                // BSP builds a right-leaning tree, so that was almost all of
                // them.
                const inFirst = this.core.bsp.bspFindPath(split.first, focused, []);
                const signedDelta = inFirst ? delta : -delta;
                split.ratio = Math.max(0.15, Math.min(0.85, split.ratio + signedDelta / axisSize));
                return;
            }
        }
    }

    toggleFloat() {
        const focused = this.getActiveWindow();
        if (!focused) return;

        // A min-limited window (auto-floated because no slot met its minimum)
        // was never user-floated — toggling releases it back to tiling instead
        // of marking it floated.
        if (this.core._minLimitedWindows && this.core._minLimitedWindows.has(focused)) {
            this.core.placement.releaseMinLimitedWindow(focused);
            const ws = focused.get_workspace();
            if (ws) {
                if (this.core.windows.getWorkspaceLayout(ws) === 'dwindle')
                    this.core.bsp.bspInsertForWorkspace(ws, focused);
                this.core.layouts.retileWorkspace(ws);
            }
            return;
        }

        const wasFloating = this.core._toggleFloatWindows.has(focused);
        if (wasFloating) {
            this.core._toggleFloatWindows.delete(focused);
        } else {
            this.core._toggleFloatWindows.add(focused);
        }
        const ws = focused.get_workspace();
        if (!ws) return;

        if (wasFloating) {
            const layout = this.core.windows.getWorkspaceLayout(ws);
            if (layout === 'dwindle')
                this.core.bsp.bspInsertForWorkspace(ws, focused);
        } else {
            const layout = this.core.windows.getWorkspaceLayout(ws);
            if (layout === 'dwindle') {
                const tree = this.core.bsp.bspGetTree(ws);
                if (tree)
                    this.core._bspTrees.set(ws, this.core.bsp.bspRemove(tree, focused));
            }
        }

        this.core._keyboardFocusChange = true;
        this.core.layouts.retileWorkspace(ws);
        this.core.signals.addIdle(() => {
            if (!this.core._settings) return false;
            this.core._keyboardFocusChange = false;
            return false;
        });
    }

    toggleTiling() {
        this.core._settings.set_boolean('enabled', !this.core._settings.get_boolean('enabled'));
    }

    toggleMaximize() {
        const win = this.getActiveWindow();
        if (!win) return;
        if (win.is_maximized()) {
            win.unmaximize();
            return;
        }
        const saved = this.core._maximizeToggleRects && this.core._maximizeToggleRects.get(win);
        if (saved) {
            this.core._maximizeToggleRects.delete(win);
            win.unmaximize();
            if (saved.w > 0)
                win.move_resize_frame(true, saved.x, saved.y, saved.w, saved.h);
            return;
        }
        const f = win.get_frame_rect();
        if (this.core._maximizeToggleRects)
            this.core._maximizeToggleRects.set(win, { x: f.x, y: f.y, w: f.width, h: f.height });
        win.maximize();
    }

    onTilingEnabledChanged() {
        if (!this.core._settings) return;
        const enabled = this.core._settings.get_boolean('enabled');

        if (enabled) {
            for (const win of this.core._windowWorkspaces.keys())
                this.core.windows.capturePosition(win);
            this.core._keyboardFocusChange = true;
            this.core.layouts.retileAll();
            this.core.signals.addIdle(() => {
                this.core._keyboardFocusChange = false;
                return false;
            });
            this.core.bgApp.checkDynamicWorkspaces();
            if (this.core._settings.get_boolean('workspace-popup'))
                this.core.workspaces.showPopup('Tiling Enabled');
        } else {
            this.core.windows.restoreSavedPositions();
            if (this.core._settings.get_boolean('workspace-popup'))
                this.core.workspaces.showPopup('Tiling Disabled');
        }
    }

    centerWindow() {
        const win = this.getActiveWindow();
        if (!win) return;
        if (!this.core.windows.isFloating(win)) return;

        const ws = win.get_workspace();
        if (!ws) return;

        const frame = win.get_frame_rect();
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return;

        const x = workArea.x + Math.floor((workArea.width - frame.width) / 2);
        const y = workArea.y + Math.floor((workArea.height - frame.height) / 2);

        const actor = win.get_compositor_private();
        if (actor) actor.remove_all_transitions();

        win.move_resize_frame(true, x, y, frame.width, frame.height);

        this.core._keyboardFocusChange = true;
        win.activate(this.core.currentTime());

        this.core.windows.moveCursorToWindow(win);

        this.core.signals.addIdle(() => {
            if (!this.core._settings) return false;
            this.core._keyboardFocusChange = false;
            return false;
        });
    }

    cycleLayout() {
        const layouts = ['dwindle', 'master-stack', 'centered-master-stack', 'floating'];
        const ws = global.workspace_manager.get_active_workspace();
        if (!ws) return;
        this.core.placement.releaseMinLimitedWindows();
        const current = this.core.windows.getWorkspaceLayout(ws);
        const idx = layouts.indexOf(current);
        const next = layouts[(idx + 1) % layouts.length];
        if (next !== current) {
            this.core._workspaceLayouts.set(this.core.geometry.wsIndex(ws), next);
            this.core.layouts.retileWorkspace(ws);
            this.core.workspaces.showPopup(`Layout: ${LAYOUT_NAMES[next] || next}`);
            this.core.persistence.scheduleSaveLayouts();
        }
    }

    startPickMode() {
        if (this.core._pickFocusId) {
            global.display.disconnectObject(this.core._pickFocusId);
            this.core._pickFocusId = null;
        }
        this.core._pickFocusId = this.connectObject(global.display, 'notify::focus-window', () => {
            const win = global.display.focus_window;
            if (!win) return;
            if (this.core._pickFocusId) {
                global.display.disconnectObject(this.core._pickFocusId);
                this.core._pickFocusId = null;
            }
            const cls = this.core.winClassCandidates(win)[0] || '';
            const title = win.get_title() || '';
            this.core._settings.set_string('pick-mode-class', cls);
            this.core._settings.set_string('pick-mode-title', title);
            this.core._settings.set_boolean('pick-mode', false);
        });
    }

    handlePickFloat() {
        const win = global.display.focus_window;
        if (!win) {
            Main.notify(_('No window is focused'));
            return;
        }

        const cls = this.core.winClassCandidates(win)[0] || '';
        const title = win.get_title() || '';

        if (!cls && !title) {
            Main.notify(_('Could not identify the focused window'));
            return;
        }

        this.showFloatPickDialog(cls, title);
    }

    showFloatPickDialog(cls, title) {
        this.destroyFloatPickDialog();
        const dialog = new ModalDialog();
        this.core._pickDialog = dialog;

        const content = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 12px;' });

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
                    this.addFloatEntry('float-windows', cls.toLowerCase());
                    dialog.close();
                },
                key: Clutter.KEY_c,
            });
        }

        if (title) {
            buttons.push({
                label: _('By title: %s').replace('%s', title),
                action: () => {
                    this.addFloatEntry('float-titles', title);
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

    addFloatEntry(key, value) {
        const current = new Set(this.core._settings.get_strv(key));
        current.add(value);
        this.core._settings.set_strv(key, [...current]);

        if (key === 'float-windows') {
            this.core._floatingClasses = new Set(this.core._settings.get_strv('float-windows'));
        } else {
            this.core._floatingTitles = new Set(this.core._settings.get_strv('float-titles'));
        }

        if (value.length > 40)
            value = value.substring(0, 37) + '...';
        Main.notify(_('Added "%s" to float list').replace('%s', value));
    }

    destroyFloatPickDialog() {
        if (this.core._pickDialog) {
            this.core._pickDialog.close();
            this.core._pickDialog = null;
        }
    }

    destroy() {
        this.destroyFloatPickDialog();
        if (this.core._pickFocusId) {
            global.display.disconnectObject(this.core._pickFocusId);
            this.core._pickFocusId = null;
        }
            super.destroy();
}
}
