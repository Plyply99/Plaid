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

    // Keyboard-driven focus changes must not be mistaken for a pointer move;
    // clear the flag once the activation settles.
    resetKeyboardFocusChange() {
        this.core.signals.addIdle(() => {
            if (!this.core._settings) return false;
            this.core._keyboardFocusChange = false;
            return false;
        });
    }

    moveFocus(direction) {
        const focused = this.getActiveWindow();
        if (!focused) return;
        const ws = global.workspace_manager.get_active_workspace();
        if (!ws) return;

        // Fixed-group windows on secondary displays are visible here even
        // though their Meta workspace can differ from the active one.
        const windows = this.core.windows.getVisibleTiledWindows(ws);
        if (windows.length <= 1) return;

        const bestWindow = this.core.bsp.findDirectionalTarget(focused, direction, windows);
        if (!bestWindow) return;

        this.core._keyboardFocusChange = true;
        bestWindow.activate(this.core.currentTime());
        this.resetKeyboardFocusChange();
    }

    swapWindow(direction) {
        const focused = this.getActiveWindow();
        if (!focused) return;
        if (this.core.windows.isFloating(focused)) {
            this.moveFloating(focused, direction);
            return;
        }
        const mon = focused.get_monitor();
        if (!this.core.monitors.monitorTiled(mon)) {
            this.moveFloating(focused, direction);
            return;
        }
        const focusedWs = focused.get_workspace();
        const activeWs = global.workspace_manager.get_active_workspace();
        const ws = activeWs || focusedWs;
        if (!ws) return;
        if (this.core.windows.getWorkspaceLayout(ws, mon) === 'floating') {
            this.moveFloating(focused, direction);
            return;
        }

        // Include fixed-group windows from other workspaces.
        const windows = this.core.windows.getVisibleTiledWindows(ws);
        if (windows.length <= 1) return;

        const bestWindow = this.core.bsp.findDirectionalTarget(focused, direction, windows);
        if (!bestWindow) return;

        const bestMon = bestWindow.get_monitor();
        if (bestMon !== mon) {
            // Swap across monitors: the two windows exchange groups, then the
            // per-group retile puts each into a slot on the other monitor.
            this.core.monitors.regroupWindow(focused, ws, mon, bestMon);
            this.core.monitors.regroupWindow(bestWindow, ws, bestMon, mon);
            this.core.monitors.setWindowMonitor(focused, bestMon);
            this.core.monitors.setWindowMonitor(bestWindow, mon);
        } else {
            const layout = this.core.windows.getWorkspaceLayout(ws, mon);
            if (layout === 'dwindle') {
                const tree = this.core.bsp.bspGetTree(this.core.monitors.groupObj(ws, mon));
                if (tree) {
                    this.core.bsp.bspSwapWindows(tree, focused, bestWindow);
                }
            } else {
                this.core.layouts.swapMasterStackWindows(focused, bestWindow);
            }
        }
        this.core.layouts.retileWorkspace(ws);
        this.core._keyboardFocusChange = true;
        focused.activate(this.core.currentTime());
        this.core.windows.cursorWarpDeferred(focused);
        this.resetKeyboardFocusChange();
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
        const mon = focused.get_monitor();
        // Untiled displays behave like floating for move/resize, without
        // being marked floating (focus navigation still includes them).
        if (!this.core.monitors.monitorTiled(mon)) {
            this.resizeFloating(focused, axis, delta);
            return;
        }
        if (this.core.windows.getWorkspaceLayout(ws, mon) === 'floating') {
            this.resizeFloating(focused, axis, delta);
            return;
        }

        const tiledWindows = this.core.windows.getWindowsForWorkspace(ws)
            .filter(w => !this.core.windows.isFloating(w));
        const idx = tiledWindows.indexOf(focused);
        if (idx === -1 || tiledWindows.length <= 1) return;

        const layout = this.core.windows.getWorkspaceLayout(ws, mon);
        if (layout === 'dwindle')
            this.resizeDwindle(focused, ws, axis, delta, mon);
        else
            this.core.layouts.resizeMasterStack(focused, ws, axis, delta, mon);

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

    resizeDwindle(focused, workspace, axis, delta, mon) {
        const tree = this.core.bsp.bspGetTree(this.core.monitors.groupObj(workspace, mon));
        if (!tree) return;

        const targetIsHorizontal = axis === 'width';
        const path = [];
        this.core.bsp.bspFindPath(tree, focused, path);

        for (let i = path.length - 1; i >= 0; i--) {
            const split = path[i];
            if ((split.direction === 'h') === targetIsHorizontal) {
                const workArea = workspace.get_work_area_for_monitor(
                    mon === undefined || mon === null ? global.display.get_primary_monitor() : mon);
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

        // A min-limited or give-up-landing window (auto-floated, never
        // user-floated) is released back to tiling instead of being marked
        // floated a second time.
        if ((this.core._minLimitedWindows && this.core._minLimitedWindows.has(focused)) ||
            (this.core._landingGivenUp && this.core._landingGivenUp.has(focused))) {
            this.core.placement.releaseMinLimitedWindow(focused);
            const ws = focused.get_workspace();
            if (ws) {
                const mon = focused.get_monitor();
                if (this.core.windows.getWorkspaceLayout(ws, mon) === 'dwindle')
                    this.core.bsp.bspInsertForWorkspace(ws, focused, mon);
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
        const mon = focused.get_monitor();

        if (wasFloating) {
            const layout = this.core.windows.getWorkspaceLayout(ws, mon);
            if (layout === 'dwindle')
                this.core.bsp.bspInsertForWorkspace(ws, focused, mon);
        } else {
            const layout = this.core.windows.getWorkspaceLayout(ws, mon);
            if (layout === 'dwindle') {
                const group = this.core.monitors.groupObj(ws, mon);
                const tree = this.core.bsp.bspGetTree(group);
                if (tree)
                    this.core._bspTrees.set(group, this.core.bsp.bspRemove(tree, focused));
            }
        }

        this.core._keyboardFocusChange = true;
        this.core.layouts.retileWorkspace(ws);
        this.resetKeyboardFocusChange();
    }

    toggleTiling() {
        this.core._settings.set_boolean('enabled', !this.core._settings.get_boolean('enabled'));
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
                this.core.workspaces.showPopup('Tiling Enabled', null, 3000, null,
                    global.display.get_current_monitor());
        } else {
            this.core.windows.restoreSavedPositions();
            if (this.core._settings.get_boolean('workspace-popup'))
                this.core.workspaces.showPopup('Tiling Disabled', null, 3000, null,
                    global.display.get_current_monitor());
        }
    }

    centerWindow() {
        const win = this.getActiveWindow();
        if (!win) return;
        const mon = win.get_monitor();
        // Tiled windows are laid out; floating windows and windows on untiled
        // displays can be centred.
        if (!this.core.windows.isFloating(win) && this.core.monitors.monitorTiled(mon)) return;

        const ws = win.get_workspace();
        if (!ws) return;

        const frame = win.get_frame_rect();
        const workArea = ws.get_work_area_for_monitor(mon);
        if (!workArea) return;

        const x = workArea.x + Math.floor((workArea.width - frame.width) / 2);
        const y = workArea.y + Math.floor((workArea.height - frame.height) / 2);

        const actor = win.get_compositor_private();
        if (actor) actor.remove_all_transitions();

        win.move_resize_frame(true, x, y, frame.width, frame.height);

        this.core._keyboardFocusChange = true;
        win.activate(this.core.currentTime());

        this.core.windows.moveCursorToWindow(win);

        this.resetKeyboardFocusChange();
    }

    cycleLayout() {
        const layouts = ['dwindle', 'master-stack', 'centered-master-stack', 'floating'];
        const focused = this.getActiveWindow();
        const ws = focused ? focused.get_workspace() : global.workspace_manager.get_active_workspace();
        if (!ws) return;
        // The pointer selects the display: an empty display has no focused
        // window, and layout is per-display state.
        const currentMon = global.display.get_current_monitor();
        const mon = Number.isInteger(currentMon) && currentMon >= 0
            ? currentMon
            : (focused ? focused.get_monitor() : this.core.monitors.primaryMonitorIndex());
        this.core.placement.releaseMinLimitedWindows();
        const current = this.core.windows.getWorkspaceLayout(ws, mon);
        const idx = layouts.indexOf(current);
        const next = layouts[(idx + 1) % layouts.length];
        if (next !== current) {
            this.core._workspaceLayouts.set(
                this.core.monitors.groupKeyFor(this.core.geometry.wsIndex(ws), mon), next);
            this.core.layouts.retileWorkspace(ws);
            this.core.workspaces.showPopup(`Layout: ${LAYOUT_NAMES[next] || next}`,
                null, 3000, null, mon);
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

    floatListMatches(win) {
        const out = [];
        const classes = new Set();
        for (const c of this.core.winClassCandidates(win)) {
            if (this.core._floatingClasses && this.core._floatingClasses.has(c))
                classes.add(c);
        }
        for (const token of this.core.windows.matchingFloatTokens(win))
            classes.add(token);
        for (const value of classes)
            out.push({ key: 'float-windows', value });
        const title = win.get_title() || '';
        if (title && this.core._floatingTitles && this.core._floatingTitles.has(title))
            out.push({ key: 'float-titles', value: title });
        return out;
    }

    handlePickFloat() {
        const win = global.display.focus_window;
        if (!win) {
            Main.notify(_('No window is focused'));
            return;
        }

        const cls = this.core.winClassCandidates(win)[0] || '';
        const title = win.get_title() || '';
        const matches = this.floatListMatches(win);

        if (!cls && !title && matches.length === 0) {
            Main.notify(_('Could not identify the focused window'));
            return;
        }

        this.showFloatPickDialog(cls, title, matches);
    }

    showFloatPickDialog(cls, title, matches = []) {
        this.destroyFloatPickDialog();
        const dialog = new ModalDialog();
        this.core._pickDialog = dialog;

        const content = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 12px;' });
        const removing = matches.length > 0;

        const header = new St.Label({
            text: removing ? _('Remove from Float List') : _('Add Floating Window'),
            style: 'font-weight: bold; font-size: 14px;',
        });
        content.add_child(header);

        const subtitle = new St.Label({
            text: removing
                ? _('This window is floating because of an entry in the float list.')
                : _('How should this window be identified?'),
        });
        content.add_child(subtitle);

        dialog.contentLayout.add_child(content);

        const buttons = [];
        const short = (value) => value.length > 40 ? value.substring(0, 37) + '...' : value;

        if (removing) {
            let values = [...new Set(matches.map(m => m.value))];
            if (values.length > 2)
                values = [values[0], values[1], `+${values.length - 2}`];
            buttons.push({
                label: _('Remove: %s').replace('%s', values.map(short).join(', ')),
                action: () => {
                    this.removeFloatEntries(matches);
                    dialog.close();
                },
                key: Clutter.KEY_Return,
            });
        } else {
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
        // A process-based verdict cached from before the rule existed would
        // keep the window floating until relog.
        if (this.core._floatProcessCache) this.core._floatProcessCache.clear();

        Main.notify(_('Added "%s" to float list').replace('%s', this.clipFloatValue(value)));
    }

    removeFloatEntries(matches) {
        const removed = this.applyFloatRemoval(matches);

        const win = global.display.focus_window;
        if (win) {
            if (!this.core._windowWorkspaces.has(win) && this.core.windows.shouldManage(win))
                this.core.windows.addWindow(win);
            const ws = win.get_workspace();
            if (ws) this.core.layouts.retileWorkspace(ws);
        }

        let values = removed;
        if (values.length > 2)
            values = [values[0], values[1], `+${values.length - 2}`];
        Main.notify(_('Removed "%s" from float list').replace('%s', values.map(v => this.clipFloatValue(v)).join(', ')));
    }

    // Remove the matching entries from the settings and the live sets. Returns
    // the removed values (unique), without touching the focused window.
    applyFloatRemoval(matches) {
        const removed = [];
        const byKey = new Map();
        for (const { key, value } of matches) {
            if (!byKey.has(key)) byKey.set(key, new Set());
            byKey.get(key).add(value);
            removed.push(value);
        }
        for (const [key, values] of byKey) {
            const next = this.core._settings.get_strv(key).filter(v => !values.has(v));
            this.core._settings.set_strv(key, next);
        }
        this.core._floatingClasses = new Set(this.core._settings.get_strv('float-windows'));
        this.core._floatingTitles = new Set(this.core._settings.get_strv('float-titles'));
        if (this.core._floatProcessCache) this.core._floatProcessCache.clear();
        return [...new Set(removed)];
    }

    clipFloatValue(value) {
        return value.length > 40 ? value.substring(0, 37) + '...' : value;
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
