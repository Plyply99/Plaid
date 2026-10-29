// Window actions: focus, swap, resize, tiling/maximize toggles, centering,
// layout cycling, and the float picker.
//
// Methods are attached to TilingWMExtension.prototype by bootstrap.js.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ModalDialog } from 'resource:///org/gnome/shell/ui/modalDialog.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { LAYOUT_NAMES } from './helpers.js';

export function _getActiveWindow() {
    return global.display.focus_window;
}

export function _moveFocus(direction) {
    const focused = this._getActiveWindow();
    if (!focused) return;
    const ws = focused.get_workspace();
    if (!ws) return;

    const windows = this._getWindowsForWorkspace(ws)
        .filter(w => !this._isFloating(w));
    if (windows.length <= 1) return;

    const bestWindow = this._findDirectionalTarget(focused, direction, windows);
    if (!bestWindow) return;

    this._keyboardFocusChange = true;
    bestWindow.activate(this._currentTime());
    this._addIdle(() => {
        if (!this._settings) return false;
        this._keyboardFocusChange = false;
        return false;
    });
}

export function _swapWindow(direction) {
    const focused = this._getActiveWindow();
    if (!focused) return;
    if (this._isFloating(focused)) {
        this._moveFloating(focused, direction);
        return;
    }
    const ws = focused.get_workspace();
    if (!ws) return;
    if (this._getWorkspaceLayout(ws) === 'floating') {
        this._moveFloating(focused, direction);
        return;
    }

    const windows = this._getWindowsForWorkspace(ws)
        .filter(w => !this._isFloating(w));
    if (windows.length <= 1) return;

    const bestWindow = this._findDirectionalTarget(focused, direction, windows);
    if (!bestWindow) return;

    const layout = this._getWorkspaceLayout(ws);
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
    focused.activate(this._currentTime());
    this._cursorWarpDeferred(focused);
    this._addIdle(() => {
        if (!this._settings) return false;
        this._keyboardFocusChange = false;
        return false;
    });
}

export function _resizeWindow(action, axis) {
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
    if (this._getWorkspaceLayout(ws) === 'floating') {
        this._resizeFloating(focused, axis, delta);
        return;
    }

    const tiledWindows = this._getWindowsForWorkspace(ws)
        .filter(w => !this._isFloating(w));
    const idx = tiledWindows.indexOf(focused);
    if (idx === -1 || tiledWindows.length <= 1) return;

    const layout = this._getWorkspaceLayout(ws);
    if (layout === 'dwindle')
        this._resizeDwindle(focused, ws, axis, delta);
    else
        this._resizeMasterStack(focused, ws, axis, delta);

    this._retileWorkspace(ws);
    if (this._settings.get_boolean('follow-focus'))
        this._cursorWarpDeferred(focused);
}

export function _resizeFloating(win, axis, delta) {
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
    this._animFloat(win, x, y, w, h);
    this._moveCursorToWindow(win);
}

export function _moveFloating(win, direction) {
    const amount = this._settings.get_int('resize-amount');
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
    this._animFloat(win, x, y, frame.width, frame.height);
    this._moveCursorToWindow(win);
}

export function _resizeDwindle(focused, workspace, axis, delta) {
    const tree = this._bspGetTree(workspace);
    if (!tree) return;

    const targetIsHorizontal = axis === 'width';
    const path = [];
    this._bspFindPath(tree, focused, path);

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
            const inFirst = this._bspFindPath(split.first, focused, []);
            const signedDelta = inFirst ? delta : -delta;
            split.ratio = Math.max(0.15, Math.min(0.85, split.ratio + signedDelta / axisSize));
            return;
        }
    }
}

export function _toggleFloat() {
    const focused = this._getActiveWindow();
    if (!focused) return;

    // A min-limited window (auto-floated because no slot met its minimum)
    // was never user-floated — toggling releases it back to tiling instead
    // of marking it floated.
    if (this._minLimitedWindows && this._minLimitedWindows.has(focused)) {
        this._releaseMinLimitedWindow(focused);
        const ws = focused.get_workspace();
        if (ws) {
            if (this._getWorkspaceLayout(ws) === 'dwindle')
                this._bspInsertForWorkspace(ws, focused);
            this._retileWorkspace(ws);
        }
        return;
    }

    const wasFloating = this._toggleFloatWindows.has(focused);
    if (wasFloating) {
        this._toggleFloatWindows.delete(focused);
    } else {
        this._toggleFloatWindows.add(focused);
    }
    const ws = focused.get_workspace();
    if (!ws) return;

    if (wasFloating) {
        const layout = this._getWorkspaceLayout(ws);
        if (layout === 'dwindle')
            this._bspInsertForWorkspace(ws, focused);
    } else {
        const layout = this._getWorkspaceLayout(ws);
        if (layout === 'dwindle') {
            const tree = this._bspGetTree(ws);
            if (tree)
                this._bspTrees.set(ws, this._bspRemove(tree, focused));
        }
    }

    this._keyboardFocusChange = true;
    this._retileWorkspace(ws);
    this._addIdle(() => {
        if (!this._settings) return false;
        this._keyboardFocusChange = false;
        return false;
    });
}

export function _toggleTiling() {
    this._settings.set_boolean('enabled', !this._settings.get_boolean('enabled'));
}

export function _toggleMaximize() {
    const win = this._getActiveWindow();
    if (!win) return;
    if (win.is_maximized()) {
        win.unmaximize();
        return;
    }
    const saved = this._maximizeToggleRects && this._maximizeToggleRects.get(win);
    if (saved) {
        this._maximizeToggleRects.delete(win);
        win.unmaximize();
        if (saved.w > 0)
            win.move_resize_frame(true, saved.x, saved.y, saved.w, saved.h);
        return;
    }
    const f = win.get_frame_rect();
    if (this._maximizeToggleRects)
        this._maximizeToggleRects.set(win, { x: f.x, y: f.y, w: f.width, h: f.height });
    win.maximize();
}

export function _onTilingEnabledChanged() {
    if (!this._settings) return;
    const enabled = this._settings.get_boolean('enabled');

    if (enabled) {
        for (const win of this._windowWorkspaces.keys())
            this._capturePosition(win);
        this._keyboardFocusChange = true;
        this._retileAll();
        this._addIdle(() => {
            this._keyboardFocusChange = false;
            return false;
        });
        this._checkDynamicWorkspaces();
        if (this._settings.get_boolean('workspace-popup'))
            this._showPopup('Tiling Enabled');
    } else {
        this._restoreSavedPositions();
        if (this._settings.get_boolean('workspace-popup'))
            this._showPopup('Tiling Disabled');
    }
}

export function _centerWindow() {
    const win = this._getActiveWindow();
    if (!win) return;
    if (!this._isFloating(win)) return;

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

    this._keyboardFocusChange = true;
    win.activate(this._currentTime());

    this._moveCursorToWindow(win);

    this._addIdle(() => {
        if (!this._settings) return false;
        this._keyboardFocusChange = false;
        return false;
    });
}

export function _cycleLayout() {
    const layouts = ['dwindle', 'master-stack', 'centered-master-stack', 'floating'];
    const ws = global.workspace_manager.get_active_workspace();
    if (!ws) return;
    this._releaseMinLimitedWindows();
    const current = this._getWorkspaceLayout(ws);
    const idx = layouts.indexOf(current);
    const next = layouts[(idx + 1) % layouts.length];
    if (next !== current) {
        this._workspaceLayouts.set(this._wsIndex(ws), next);
        this._retileWorkspace(ws);
        this._showPopup(`Layout: ${LAYOUT_NAMES[next] || next}`);
        this._scheduleSaveLayouts();
    }
}

export function _startPickMode() {
    if (this._pickFocusId) {
        global.display.disconnect(this._pickFocusId);
        this._pickFocusId = null;
    }
    this._pickFocusId = global.display.connect('notify::focus-window', () => {
        const win = global.display.focus_window;
        if (!win) return;
        if (this._pickFocusId) {
            global.display.disconnect(this._pickFocusId);
            this._pickFocusId = null;
        }
        const cls = this._winClassCandidates(win)[0] || '';
        const title = win.get_title() || '';
        this._settings.set_string('pick-mode-class', cls);
        this._settings.set_string('pick-mode-title', title);
        this._settings.set_boolean('pick-mode', false);
    });
}

export function _handlePickFloat() {
    const win = global.display.focus_window;
    if (!win) {
        Main.notify(_('No window is focused'));
        return;
    }

    const cls = this._winClassCandidates(win)[0] || '';
    const title = win.get_title() || '';

    if (!cls && !title) {
        Main.notify(_('Could not identify the focused window'));
        return;
    }

    this._showFloatPickDialog(cls, title);
}

export function _showFloatPickDialog(cls, title) {
    this._destroyFloatPickDialog();
    const dialog = new ModalDialog();
    this._pickDialog = dialog;

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

export function _addFloatEntry(key, value) {
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

export function _destroyFloatPickDialog() {
    if (this._pickDialog) {
        this._pickDialog.close();
        this._pickDialog = null;
    }
}

export const actionMethods = {
    _getActiveWindow,
    _moveFocus,
    _swapWindow,
    _resizeWindow,
    _resizeFloating,
    _moveFloating,
    _resizeDwindle,
    _toggleFloat,
    _toggleTiling,
    _toggleMaximize,
    _onTilingEnabledChanged,
    _centerWindow,
    _cycleLayout,
    _startPickMode,
    _handlePickFloat,
    _showFloatPickDialog,
    _addFloatEntry,
    _destroyFloatPickDialog,
};
