// Plaid Workspace Pill (PWP) — the top-bar workspace indicator as a pill:
// visible workspace numbers, the active workspace's app icon, and the focused
// window's title. Reads the BGAPP parking index to number workspaces.
//
// Methods are attached to TilingWMExtension.prototype in extension.js.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export function _initWorkspacePill() {
    // The Plaid Workspace Pill: replaces GNOME's default workspace dots
    // inside the Activities button with the usable workspace numbers, the
    // focused window's app icon on the active slot, and the window title.
    if (this._workspacePill) return;
    try {
        const activities = Main.panel.statusArea.activities;
        if (!activities) return;
        const children = activities.get_children();
        for (const child of children) {
            if (child.constructor.name === 'WorkspaceIndicators') {
                this._workspacePillIndicators = child;
                // Disarm: the dots are connected to the shared workspaces
                // adjustment via connectObject(..., this); release those
                // handlers so a detached actor can never run them.
                try {
                    if (child._workspacesAdjustment && child._workspacesAdjustment.disconnectObject)
                        child._workspacesAdjustment.disconnectObject(child);
                } catch (_e) {}
                activities.remove_child(child);
                break;
            }
        }
        const pill = new St.BoxLayout({ style_class: 'plaid-workspace-pill' });
        this._workspacePillNumbers =
            new St.BoxLayout({ style_class: 'plaid-workspace-pill-numbers' });
        this._workspacePillIcon = new St.Icon({ style_class: 'plaid-workspace-pill-icon' });
        this._workspacePillIcon.set_fallback_gicon(null);
        this._workspacePillTitle = new St.Label({
            style_class: 'plaid-workspace-pill-title',
            y_align: Clutter.ActorAlign.CENTER,
            text: '',
        });
        pill.add_child(this._workspacePillNumbers);
        pill.add_child(this._workspacePillTitle);
        activities.add_child(pill);
        this._workspacePill = pill;
        this._addSignal(global.display, global.display.connect('notify::focus-window',
            () => this._scheduleWorkspacePillUpdate()));
        this._addSignal(global.workspace_manager, global.workspace_manager.connect(
            'active-workspace-changed', () => this._scheduleWorkspacePillUpdate()));
        this._scheduleWorkspacePillUpdate();
        this._debugLog('workspace pill initialized');
    } catch (e) {
        log(`[plaid] workspace pill init failed: ${e.message}`);
        this._workspacePill = null;
    }
}

export function _scheduleWorkspacePillUpdate() {
    // Never churn actors synchronously inside a signal — the compositor is
    // mid-cycle (stacking/redraw) and a destroy/create there can segfault.
    // Coalesce the update onto the idle loop instead.
    if (!this._settings || this._workspacePillUpdateId) return;
    this._workspacePillUpdateId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        this._workspacePillUpdateId = 0;
        if (!this._settings) return GLib.SOURCE_REMOVE;
        this._updateWorkspacePill();
        return GLib.SOURCE_REMOVE;
    });
}

export function _updateWorkspacePill() {
    const pill = this._workspacePill;
    if (!pill) return;
    try {
        if (Main.sessionMode.isLocked) return;
        const wm = global.workspace_manager;
        const n = wm.n_workspaces;
        const active = wm.get_active_workspace_index();
        const parkingIdx = this._backgroundAppParkingWs ?
            this._wsIndex(this._backgroundAppParkingWs) : -1;
        const focused = global.display.focus_window;
        const showFocus =
            focused && !focused.skip_taskbar && focused !== this._backgroundAppWin;

        if (this._workspacePillFocusedWin) {
            this._workspacePillFocusedWin.disconnect(this._workspacePillTitleId);
            this._workspacePillFocusedWin.disconnect(this._workspacePillUnmanagedId);
            this._workspacePillFocusedWin = null;
            this._workspacePillTitleId = 0;
            this._workspacePillUnmanagedId = 0;
        }

        // The icon lives in the numbers row at the active slot. Remove it
        // first so the rebuild can place it at the correct position —
        // add_child on an already-parented actor is a no-op (no reorder).
        if (this._workspacePillIcon.get_parent() === this._workspacePillNumbers)
            this._workspacePillNumbers.remove_child(this._workspacePillIcon);
        // Never destroy the shared icon: destroying it would leave a
        // dangling reference that the next add_child would crash on.
        // Destroy only the label children.
        for (const child of this._workspacePillNumbers.get_children()) {
            if (child !== this._workspacePillIcon)
                child.destroy();
        }
        for (let i = 0; i < n; i++) {
            if (i === parkingIdx) continue;
            if (i === active && showFocus) {
                this._workspacePillNumbers.add_child(this._workspacePillIcon);
            } else {
                const label = new St.Label({
                    text: String(this._bgAppRealToDisplay(i) + 1),
                    style_class: 'plaid-workspace-pill-number',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                if (i === active)
                    label.add_style_pseudo_class('active');
                this._workspacePillNumbers.add_child(label);
            }
        }

        if (showFocus) {
            const app = Shell.WindowTracker.get_default().get_window_app(focused);
            if (app) {
                try { this._workspacePillIcon.set_gicon(app.get_icon()); } catch (_e) {}
            }
            let title = focused.get_title() || '';
            if (title.length > 60)
                title = title.slice(0, 60) + '…';
            this._workspacePillTitle.set_text(title);
            this._workspacePillTitle.visible = true;
            this._workspacePillFocusedWin = focused;
            this._workspacePillTitleId =
                focused.connect('notify::title', () => this._scheduleWorkspacePillUpdate());
            this._workspacePillUnmanagedId = focused.connect('unmanaged', () => {
                if (this._workspacePillFocusedWin !== focused) return;
                focused.disconnect(this._workspacePillTitleId);
                this._workspacePillFocusedWin = null;
                this._workspacePillTitleId = 0;
                this._workspacePillUnmanagedId = 0;
            });
        } else {
            this._workspacePillTitle.set_text('');
            this._workspacePillTitle.visible = false;
        }
    } catch (e) {
        log(`[plaid] workspace pill update failed: ${e.message}`);
    }
}

export function _restoreWorkspacePill() {
    if (this._workspacePillUpdateId) {
        GLib.source_remove(this._workspacePillUpdateId);
        this._workspacePillUpdateId = 0;
    }
    if (this._workspacePill) {
        this._workspacePill.destroy();
        this._workspacePill = null;
    }
    if (this._workspacePillFocusedWin) {
        const win = this._workspacePillFocusedWin;
        const titleId = this._workspacePillTitleId;
        const unmanagedId = this._workspacePillUnmanagedId;
        this._workspacePillFocusedWin = null;
        this._workspacePillTitleId = 0;
        this._workspacePillUnmanagedId = 0;
        win.disconnect(titleId);
        win.disconnect(unmanagedId);
    }
    if (this._workspacePillIndicators) {
        try {
            const activities = Main.panel.statusArea.activities;
            if (activities) activities.add_child(this._workspacePillIndicators);
        } catch (_e) {}
        this._workspacePillIndicators = null;
    }
}

export const workspacePillMethods = {
    _initWorkspacePill,
    _scheduleWorkspacePillUpdate,
    _updateWorkspacePill,
    _restoreWorkspacePill,
};
