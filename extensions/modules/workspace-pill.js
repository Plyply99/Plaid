// Plaid Workspace Pill (PWP) — the top-bar workspace indicator as a pill:
// visible workspace numbers, the active workspace's app icon, and the focused
// window's title. Reads the BGAPP parking index to number workspaces.
//
// Methods live on this subsystem class.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { PlaidSubsystem } from './subsystem.js';


export class WorkspacePill extends PlaidSubsystem {
    constructor(core) {
        super(core);
    }

    initWorkspacePill() {
        // The Plaid Workspace Pill: replaces GNOME's default workspace dots
        // inside the Activities button with the usable workspace numbers, the
        // focused window's app icon on the active slot, and the window title.
        if (this.core._workspacePill) return;
        try {
            const activities = Main.panel.statusArea.activities;
            if (!activities) return;
            const children = activities.get_children();
            for (const child of children) {
                if (child.constructor.name === 'WorkspaceIndicators') {
                    this.core._workspacePillIndicators = child;
                    // Disarm: the dots are connected to the shared workspaces
                    // adjustment via connectObject(..., this); release those
                    // handlers so a detached actor can never run them.
                    {
                        if (child._workspacesAdjustment && child._workspacesAdjustment.disconnectObject)
                            child._workspacesAdjustment.disconnectObject(child);
                    }
                    activities.remove_child(child);
                    break;
                }
            }
            const pill = new St.BoxLayout({ style_class: 'plaid-workspace-pill' });
            this.core._workspacePillNumbers =
                new St.BoxLayout({ style_class: 'plaid-workspace-pill-numbers' });
            this.core._workspacePillIcon = new St.Icon({ style_class: 'plaid-workspace-pill-icon' });
            this.core._workspacePillIcon.set_fallback_gicon(null);
            this.core._workspacePillTitle = new St.Label({
                style_class: 'plaid-workspace-pill-title',
                y_align: Clutter.ActorAlign.CENTER,
                text: '',
            });
            pill.add_child(this.core._workspacePillNumbers);
            pill.add_child(this.core._workspacePillTitle);
            activities.add_child(pill);
            this.core._workspacePill = pill;
            this.connectObject(global.display, 'notify::focus-window',
                () => this.scheduleWorkspacePillUpdate());
            this.connectObject(global.workspace_manager,
                'active-workspace-changed', () => this.scheduleWorkspacePillUpdate());
            this.scheduleWorkspacePillUpdate();
            this.core.debugLog('workspace pill initialized');
        } catch (e) {
            this.core.debugLog(`workspace pill init failed: ${e.message}`);
            this.core._workspacePill = null;
            this.core._workspacePillNumbers = null;
            this.core._workspacePillIcon = null;
            this.core._workspacePillTitle = null;
        }
    }

    scheduleWorkspacePillUpdate() {
        // Never churn actors synchronously inside a signal — the compositor is
        // mid-cycle (stacking/redraw) and a destroy/create there can segfault.
        // Coalesce the update onto the idle loop instead.
        if (!this.core._settings || this.core._shuttingDown || this.core._workspacePillUpdateId) return;
        this.core._workspacePillUpdateId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this.core._workspacePillUpdateId = 0;
            if (!this.core._settings || this.core._shuttingDown) return GLib.SOURCE_REMOVE;
            this.updateWorkspacePill();
            return GLib.SOURCE_REMOVE;
        });
    }

    updateWorkspacePill() {
        const pill = this.core._workspacePill;
        const numbers = this.core._workspacePillNumbers;
        const icon = this.core._workspacePillIcon;
        const titleActor = this.core._workspacePillTitle;
        if (!pill || !numbers || !icon || !titleActor || this.core._shuttingDown) return;
        try {
            if (Main.sessionMode.isLocked) return;
            const wm = global.workspace_manager;
            const n = wm.n_workspaces;
            const active = wm.get_active_workspace_index();
            const parkingIdx = this.core._backgroundAppParkingWs ?
                this.core.geometry.wsIndex(this.core._backgroundAppParkingWs) : -1;
            const focused = global.display.focus_window;
            const showFocus =
                focused && !focused.skip_taskbar && focused !== this.core._backgroundAppWin;

            if (this.core._workspacePillFocusedWin) {
                this.core._workspacePillFocusedWin.disconnectObject(this.core._workspacePillTitleId);
                this.core._workspacePillFocusedWin.disconnectObject(this.core._workspacePillUnmanagedId);
                this.core._workspacePillFocusedWin = null;
                this.core._workspacePillTitleId = 0;
                this.core._workspacePillUnmanagedId = 0;
            }

            // The icon lives in the numbers row at the active slot. Remove it
            // first so the rebuild can place it at the correct position —
            // add_child on an already-parented actor is a no-op (no reorder).
            if (icon.get_parent() === numbers)
                numbers.remove_child(icon);
            // Never destroy the shared icon: destroying it would leave a
            // dangling reference that the next add_child would crash on.
            // Destroy only the label children.
            for (const child of numbers.get_children()) {
                if (child !== icon)
                    child.destroy();
            }
            for (let i = 0; i < n; i++) {
                if (i === parkingIdx) continue;
                if (i === active && showFocus) {
                    numbers.add_child(icon);
                } else {
                    const label = new St.Label({
                        text: String(this.core.geometry.bgAppRealToDisplay(i) + 1),
                        style_class: 'plaid-workspace-pill-number',
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    if (i === active)
                        label.add_style_pseudo_class('active');
                    numbers.add_child(label);
                }
            }

            if (showFocus) {
                const app = Shell.WindowTracker.get_default().get_window_app(focused);
                if (app)
                    icon.set_gicon(app.get_icon());
                let title = focused.get_title() || '';
                if (title.length > 60)
                    title = title.slice(0, 60) + '…';
                titleActor.set_text(title);
                titleActor.visible = true;
                this.core._workspacePillFocusedWin = focused;
                this.core._workspacePillTitleId =
                    this.connectObject(focused, 'notify::title', () => this.scheduleWorkspacePillUpdate());
                this.core._workspacePillUnmanagedId = this.connectObject(focused, 'unmanaged', () => {
                    if (this.core._workspacePillFocusedWin !== focused) return;
                    focused.disconnectObject(this.core._workspacePillTitleId);
                    this.core._workspacePillFocusedWin = null;
                    this.core._workspacePillTitleId = 0;
                    this.core._workspacePillUnmanagedId = 0;
                });
            } else {
                titleActor.set_text('');
                titleActor.visible = false;
            }
        } catch (e) {
            this.core.debugLog(`workspace pill update failed: ${e.message}`);
        }
    }

    restoreWorkspacePill() {
        if (this.core._workspacePillUpdateId) {
            GLib.source_remove(this.core._workspacePillUpdateId);
            this.core._workspacePillUpdateId = 0;
        }
        if (this.core._workspacePill) {
            this.core._workspacePill.destroy();
            this.core._workspacePill = null;
        }
        this.core._workspacePillNumbers = null;
        this.core._workspacePillIcon = null;
        this.core._workspacePillTitle = null;
        if (this.core._workspacePillFocusedWin) {
            const win = this.core._workspacePillFocusedWin;
            const titleId = this.core._workspacePillTitleId;
            const unmanagedId = this.core._workspacePillUnmanagedId;
            this.core._workspacePillFocusedWin = null;
            this.core._workspacePillTitleId = 0;
            this.core._workspacePillUnmanagedId = 0;
            win.disconnectObject(titleId);
            win.disconnectObject(unmanagedId);
        }
        if (this.core._workspacePillIndicators) {
            const activities = Main.panel.statusArea.activities;
            if (activities) activities.add_child(this.core._workspacePillIndicators);
            this.core._workspacePillIndicators = null;
        }
    }

    destroy() {
        this.restoreWorkspacePill();
            super.destroy();
}
}
