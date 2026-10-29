// Drop-Down Terminal (DDT) — a terminal that drops from the top of the work
// area at a configurable height, claimed by its command/process, positioned
// with Flair, and synced to the active workspace.
//
// Methods live on this subsystem class.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { PlaidSubsystem } from './subsystem.js';


export class DropdownTerminal extends PlaidSubsystem {
    constructor(core) {
        super(core);
    }

    initDropdownTerminal() {
        try {
            this.core._dropdownSettingsChangedId = this.connectObject(this.core._settings,
                'changed::dropdown-terminal-command',
                () => this.clearDropdownWindow());
        } catch (_e) {
            this.core._dropdownSettingsChangedId = 0;
        }
        try {
            this.core._dropdownHeightChangedId = this.connectObject(this.core._settings,
                'changed::dropdown-terminal-height',
                () => {
                    this.core.debugLog('dropdown: height setting changed');
                    const win = this.core._dropdownWin;
                    if (win && !win.minimized) {
                        this.core.debugLog('dropdown: height setting changed, re-applying');
                        this.positionDropdownTerminal(win);
                    }
                });
        } catch (_e) {
            this.core._dropdownHeightChangedId = 0;
        }
    }

    toggleDropdownTerminal() {
        const win = this.core._dropdownWin;
        if (win) {
            if (win.minimized) {
                this.showDropdownTerminal(win);
            } else {
                { win.minimize(); }
            }
            return;
        }
        if (this.core._dropdownPending) return;
        const command = this.core._settings.get_string('dropdown-terminal-command');
        if (!command) return;
        this.core._dropdownPending = true;
        if (this.core._dropdownPendingId) GLib.source_remove(this.core._dropdownPendingId);
        this.core._dropdownPendingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30000, () => {
            this.core._dropdownPendingId = 0;
            this.core._dropdownPending = false;
            this.clearDropdownWaiters();
            return GLib.SOURCE_REMOVE;
        });
        let appInfo = null;
        {
            appInfo = Gio.AppInfo.create_from_commandline(
                `env PLAID_DDT=1 ${command}`, null, Gio.AppInfoCreateFlags.NONE);
        }
        if (!appInfo) {
            this.core._dropdownPending = false;
            this.core.workspaces.showPopup('Failed to Launch Terminal', `Could not start command: ${command}`);
            return;
        }
        this.core.debugLog(`dropdown: launching ${command}`);
        try {
            appInfo.launch([], null);
        } catch (_e) {
            this.core._dropdownPending = false;
            this.core.workspaces.showPopup('Failed to Launch Terminal', `Could not start command: ${command}`);
        }
    }

    handleDropdownWindowCreated(win) {
        if (!this.core._dropdownPending || !win) return false;
        if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
        if (this.tryClaimDropdown(win)) return true;
        if (this.core._dropdownWaiters.has(win)) return false;
        this.core.debugLog('dropdown: window created, waiting for identity');
        const notifyIds = [];
        let unmanagedId = 0;
        const cleanup = () => {
            if (unmanagedId) {
                win.disconnectObject(unmanagedId);
                unmanagedId = 0;
            }
            for (const id of notifyIds) {
                win.disconnectObject(id);
            }
            notifyIds.length = 0;
            if (this.core._dropdownWaiters.get(win) === cleanup) {
                this.core._dropdownWaiters.delete(win);
            }
        };
        const retry = () => {
            if (this.tryClaimDropdown(win)) cleanup();
        };
        notifyIds.push(this.connectObject(win, 'notify::wm-class', retry));
        notifyIds.push(this.connectObject(win, 'notify::gtk-application-id', retry));
        unmanagedId = this.connectObject(win, 'unmanaged', cleanup);
        this.core._dropdownWaiters.set(win, cleanup);
        return false;
    }

    tryClaimDropdown(win) {
        if (!this.core._dropdownPending || !win) return false;
        const command = this.core._settings.get_string('dropdown-terminal-command') || '';
        if (!this.core.bgApp.isMarkerProcess(win, 'PLAID_DDT=1', command)) {
            this.core.debugLog('dropdown: identity not yet matching');
            return false;
        }
        if (this.core._dropdownPendingId) {
            GLib.source_remove(this.core._dropdownPendingId);
            this.core._dropdownPendingId = 0;
        }
        this.core._dropdownPending = false;
        if (this.core._windowWorkspaces.has(win)) {
            this.core.debugLog('dropdown: de-registering window from tiler');
            this.core.windows.removeWindow(win);
        }
        this.core.blur.removeBlur(win);
        this.core.borders.removeBorder(win);
        win._plaidDdtRevealed = false;
        // Keep the spawn-map geometry off-screen until the terminal has been
        // moved. GNOME maps the new window centered at its default 800x600;
        // revealing it here showed that centered frame until the asynchronous
        // Wayland move landed. The position loop (or the backstop below)
        // reveals it once it is at the drop rect. Clear the spawn-choreography
        // timers/state here so they cannot fight that later reveal.
        if (win._plaidInvisibleTimer) {
            GLib.source_remove(win._plaidInvisibleTimer);
            win._plaidInvisibleTimer = 0;
        }
        if (this.core._pendingWarp && this.core._pendingWarp.has(win))
            this.core._pendingWarp.delete(win);
        {
            const a = win.get_compositor_private();
            if (a) {
                a.visible = false;
                a.set_opacity(0);
            }
        }
        this.core._dropdownWin = win;
        this.core._dropdownGeometryIds = [];
        this.core._dropdownGeometryIds.push(this.connectObject(win, 'size-changed', () => {
            if (this.core._dropdownWin === win) this.core.borders.applyDropdownEffects(win);
        }));
        this.core._dropdownGeometryIds.push(this.connectObject(win, 'position-changed', () => {
            if (this.core._dropdownWin === win) this.core.borders.applyDropdownEffects(win);
        }));
        this.core._dropdownUnmanagedId = this.connectObject(win, 'unmanaged', () => {
            if (this.core._dropdownWin === win) {
                this.core._dropdownWin = null;
            }
        });
        this.configureDropdownTerminal(win);
        this.showDropdownTerminal(win);
        // Reveal backstop: `move_resize_frame` is asynchronous, and a client
        // that never reports the exact target must not leave the terminal
        // invisible after the 20-try position loop gives up.
        this.core.signals.addTimeout(400, () => {
            if (!this.core._settings || this.core._dropdownWin !== win) return GLib.SOURCE_REMOVE;
            this.revealDropdownWindow(win);
            return GLib.SOURCE_REMOVE;
        });
        this.core.debugLog(`dropdown: claimed ${win.get_wm_class_instance() || win.get_wm_class() || ''}`);
        return true;
    }

    recheckDropdownWaiters() {
        if (!this.core._settings || !this.core._dropdownPending) return;
        for (const win of [...this.core._dropdownWaiters.keys()]) {
            const cleanup = this.core._dropdownWaiters.get(win);
            if (!this.tryClaimDropdown(win)) continue;
            { cleanup(); }
        }
    }

    clearDropdownWaiters() {
        for (const win of [...this.core._dropdownWaiters.keys()]) {
            const cleanup = this.core._dropdownWaiters.get(win);
            { cleanup(); }
        }
        this.core._dropdownWaiters.clear();
    }

    configureDropdownTerminal(win) {
        { win.make_above(); }
        // Sticky: the terminal follows every workspace WITHOUT leaving an empty
        // one. Dynamic workspaces ignore sticky windows, so a workspace is never
        // removed/renumbered when the terminal moves (that was the "strange
        // switching" with the DDT open).
        { win.stick(); }
    }

    revealDropdownWindow(win) {
        if (!this.core._settings || !win) return;
        win._plaidDdtRevealed = true;
        // The spawn choreography may have left the actor hidden and/or the
        // corner mask's opacity uniform at 0. Restore both together: the mask
        // multiplies the whole output in the shader, so actor opacity alone
        // still paints nothing.
        {
            const a = win.get_compositor_private();
            if (a) {
                a.visible = true;
                a.set_opacity(255);
            }
        }
        {
            const effect = this.core._windowMasks && this.core._windowMasks.get(win);
            if (effect && effect.setOpacityUniform)
                effect.setOpacityUniform(1);
        }
        // Now that the window is at the drop rect, attaching Flair (blur
        // sibling, border, mask) paints it at the correct geometry.
        this.core.borders.applyDropdownEffects(win);
    }

    showDropdownTerminal(win) {
        { win.unminimize(); }
        { win.make_above(); }
        // Sticky (see _configureDropdownTerminal) — re-assert in case something
        // unstuck it, so it appears on the active workspace.
        { if (!win.is_on_all_workspaces()) win.stick(); }
        this.positionDropdownTerminal(win);
        { win.activate(this.core.currentTime()); }
    }

    syncDropdownWorkspace() {
        const win = this.core._dropdownWin;
        if (!win) return;
        // Sticky (see _configureDropdownTerminal): it is already on every workspace.
        // Moving it here on each switch emptied workspaces under dynamic
        // workspaces, which then removed/renumbered them.
        { if (win.is_on_all_workspaces()) return; }
        const ws = global.workspace_manager.get_active_workspace();
        if (!ws) return;
        {
            if (win.get_workspace() !== ws) {
                win.change_workspace(ws);
                if (!win.minimized)
                    this.positionDropdownTerminal(win);
            }
        }
    }

    scheduleDropdownWorkspaceSync() {
        if (this.core._shuttingDown) return;
        // Coalesce the burst of active-workspace-changed signals a switch can
        // produce — moving the terminal on every one of them used to fight the
        // switch itself.
        if (this.core._dropdownSyncId) return;
        this.core._dropdownSyncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this.core._dropdownSyncId = 0;
            if (!this.core._settings) return GLib.SOURCE_REMOVE;
            this.syncDropdownWorkspace();
            return GLib.SOURCE_REMOVE;
        });
    }

    dropdownRect() {
        let workArea = null;
        let mon = null;
        {
            const idx = this.dropdownMonitorIndex();
            const ws = global.workspace_manager.get_active_workspace();
            if (ws) {
                workArea = ws.get_work_area_for_monitor(idx);
                if (workArea && workArea.width === 0) workArea = null;
            }
            if (!workArea) {
                mon = global.display.get_monitor_geometry(idx);
            }
        }
        const base = workArea || mon;
        if (!base || base.width === 0) return null;
        const heightPct = this.core._settings.get_int('dropdown-terminal-height') || 33;
        const height = Math.floor(base.height * heightPct / 100);
        this.core.debugLog(`dropdown: workArea=(${base.x},${base.y},${base.width},${base.height}) hPct=${heightPct} -> rect=(${base.x},${base.y},${base.width},${height})`);
        return { x: base.x, y: base.y, width: base.width, height };
    }

    positionDropdownTerminal(win) {
        let retries = 0;
        const apply = () => {
            if (!this.core._settings) return false;
            let rect = null;
            { rect = this.dropdownRect(); }
            if (!rect) return false;
            const before = win.get_frame_rect();
            if (before.x === rect.x && before.y === rect.y &&
                before.width === rect.width && before.height === rect.height) {
                // Already at the target — skip the redundant move_resize (this
                // used to fire on every workspace switch).
                this.revealDropdownWindow(win);
                return false;
            }
            this.core.debugLog(`dropdown: position target=(${rect.x},${rect.y},${rect.width},${rect.height}) before=(${before.x},${before.y},${before.width},${before.height}) try=${retries}`);
            {
                win.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
            }
            const frame = win.get_frame_rect();
            const done = frame.x === rect.x && frame.y === rect.y &&
                frame.width === rect.width && frame.height === rect.height;
            if (done) {
                this.core.debugLog(`dropdown: position settled at (${frame.x},${frame.y},${frame.width},${frame.height})`);
                this.revealDropdownWindow(win);
                return false;
            }
            retries++;
            if (retries >= 20) {
                this.core.debugLog(`dropdown: position gave up after ${retries} tries, frame=(${frame.x},${frame.y},${frame.width},${frame.height})`);
                this.revealDropdownWindow(win);
                return false;
            }
            return true;
        };
        const retry = () => {
            if (!this.core._settings) return GLib.SOURCE_REMOVE;
            return apply() ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        };
        if (apply())
            this.core.signals.addTimeout(100, retry);
    }

    dropdownMonitorIndex() {
        let idx = global.display.get_current_monitor();
        {
            const focus = global.display.focus_window;
            if (focus && focus.get_monitor() >= 0) idx = focus.get_monitor();
        }
        return idx;
    }

    clearDropdownWindow() {
        this.clearDropdownWaiters();
        const win = this.core._dropdownWin;
        if (!win) return;
        if (this.core._dropdownGeometryIds) {
            for (const id of this.core._dropdownGeometryIds) {
                win.disconnectObject(id);
            }
            this.core._dropdownGeometryIds = null;
        }
        if (this.core._dropdownUnmanagedId) {
            win.disconnectObject(this.core._dropdownUnmanagedId);
            this.core._dropdownUnmanagedId = 0;
        }
        this.core.borders.removeBorder(win);
        this.core.masks.removeMask(win);
        this.core.blur.removeBlur(win);
        { win.unmake_above(); }
        { win.unstick(); }
        // If the terminal was still held hidden (disabled before the position
        // loop revealed it), never leave it invisible after teardown.
        {
            const a = win.get_compositor_private();
            if (a) {
                a.visible = true;
                a.set_opacity(255);
                a.remove_all_transitions();
            }
            const effect = this.core._windowMasks && this.core._windowMasks.get(win);
            if (effect && effect.setOpacityUniform)
                effect.setOpacityUniform(1);
        }
        win._plaidDdtRevealed = false;
        this.core._dropdownWin = null;
    }

    destroy() {
        this.clearDropdownWindow();
        if (this.core._dropdownPendingId) {
            GLib.source_remove(this.core._dropdownPendingId);
            this.core._dropdownPendingId = 0;
        }
        if (this.core._dropdownSyncId) {
            GLib.source_remove(this.core._dropdownSyncId);
            this.core._dropdownSyncId = 0;
        }
        if (this.core._dropdownSettingsChangedId) {
            this.core._settings.disconnectObject(this.core._dropdownSettingsChangedId);
            this.core._dropdownSettingsChangedId = 0;
        }
        if (this.core._dropdownHeightChangedId) {
            this.core._settings.disconnectObject(this.core._dropdownHeightChangedId);
            this.core._dropdownHeightChangedId = 0;
        }
        this.core._dropdownPending = false;
            super.destroy();
}
}
