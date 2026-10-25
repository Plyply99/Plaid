// Drop-Down Terminal (DDT) — a terminal that drops from the top of the work
// area at a configurable height, claimed by its command/process, positioned
// with Flair, and synced to the active workspace.
//
// Methods are attached to TilingWMExtension.prototype in extension.js.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

export function _initDropdownTerminal() {
    try {
        this._dropdownSettingsChangedId = this._settings.connect(
            'changed::dropdown-terminal-command',
            () => this._clearDropdownWindow());
    } catch (_e) {
        this._dropdownSettingsChangedId = 0;
    }
    try {
        this._dropdownHeightChangedId = this._settings.connect(
            'changed::dropdown-terminal-height',
            () => {
                this._debugLog('dropdown: height setting changed');
                const win = this._dropdownWin;
                if (win && !win.minimized) {
                    this._debugLog('dropdown: height setting changed, re-applying');
                    this._positionDropdownTerminal(win);
                }
            });
    } catch (_e) {
        this._dropdownHeightChangedId = 0;
    }
}

export function _toggleDropdownTerminal() {
    const win = this._dropdownWin;
    if (win) {
        if (win.minimized) {
            this._showDropdownTerminal(win);
        } else {
            try { win.minimize(); } catch (_e) {}
        }
        return;
    }
    if (this._dropdownPending) return;
    const command = this._settings.get_string('dropdown-terminal-command');
    if (!command) return;
    this._dropdownPending = true;
    if (this._dropdownPendingId) GLib.source_remove(this._dropdownPendingId);
    this._dropdownPendingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30000, () => {
        this._dropdownPendingId = 0;
        this._dropdownPending = false;
        this._clearDropdownWaiters();
        return GLib.SOURCE_REMOVE;
    });
    let appInfo = null;
    try {
        appInfo = Gio.AppInfo.create_from_commandline(
            `env PLAID_DDT=1 ${command}`, null, Gio.AppInfoCreateFlags.NONE);
    } catch (_e) {}
    if (!appInfo) {
        this._dropdownPending = false;
        this._showPopup('Failed to Launch Terminal', `Could not start command: ${command}`);
        return;
    }
    this._debugLog(`dropdown: launching ${command}`);
    try {
        appInfo.launch([], null);
    } catch (_e) {
        this._dropdownPending = false;
        this._showPopup('Failed to Launch Terminal', `Could not start command: ${command}`);
    }
}

export function _handleDropdownWindowCreated(win) {
    if (!this._dropdownPending || !win) return false;
    if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
    if (this._tryClaimDropdown(win)) return true;
    if (this._dropdownWaiters.has(win)) return false;
    this._debugLog('dropdown: window created, waiting for identity');
    try { win.skip_taskbar = true; } catch (_e) {}
    const notifyIds = [];
    let unmanagedId = 0;
    const cleanup = () => {
        if (unmanagedId) {
            win.disconnect(unmanagedId);
            unmanagedId = 0;
        }
        for (const id of notifyIds) {
            win.disconnect(id);
        }
        notifyIds.length = 0;
        if (this._dropdownWaiters.get(win) === cleanup) {
            this._dropdownWaiters.delete(win);
        }
    };
    const retry = () => {
        if (this._tryClaimDropdown(win)) cleanup();
    };
    notifyIds.push(win.connect('notify::wm-class', retry));
    notifyIds.push(win.connect('notify::gtk-application-id', retry));
    unmanagedId = win.connect('unmanaged', cleanup);
    this._dropdownWaiters.set(win, cleanup);
    return false;
}

export function _tryClaimDropdown(win) {
    if (!this._dropdownPending || !win) return false;
    const command = this._settings.get_string('dropdown-terminal-command') || '';
    if (!this._isMarkerProcess(win, 'PLAID_DDT=1', command)) {
        this._debugLog('dropdown: identity not yet matching');
        return false;
    }
    if (this._dropdownPendingId) {
        GLib.source_remove(this._dropdownPendingId);
        this._dropdownPendingId = 0;
    }
    this._dropdownPending = false;
    if (this._windowWorkspaces.has(win)) {
        this._debugLog('dropdown: de-registering window from tiler');
        this._removeWindow(win);
    }
    this._removeBlur(win);
    this._removeBorder(win);
    // Reveal the window: the spawn choreography may have hidden it
    // (actor.visible=false + pending-warp mask opacity), and the 2.5s
    // backstop timer must not force-reveal it later on a wrong
    // workspace. Clear both here.
    if (win._plaidInvisibleTimer) {
        GLib.source_remove(win._plaidInvisibleTimer);
        win._plaidInvisibleTimer = 0;
    }
    if (this._pendingWarp && this._pendingWarp.has(win))
        this._pendingWarp.delete(win);
    try {
        const a = win.get_compositor_private();
        if (a) {
            a.visible = true;
            a.set_opacity(255);
        }
    } catch (_e) {}
    this._dropdownWin = win;
    this._dropdownGeometryIds = [];
    this._dropdownGeometryIds.push(win.connect('size-changed', () => {
        if (this._dropdownWin === win) this._applyDropdownEffects(win);
    }));
    this._dropdownGeometryIds.push(win.connect('position-changed', () => {
        if (this._dropdownWin === win) this._applyDropdownEffects(win);
    }));
    this._dropdownUnmanagedId = win.connect('unmanaged', () => {
        if (this._dropdownWin === win) {
            this._dropdownWin = null;
        }
    });
    this._configureDropdownTerminal(win);
    this._showDropdownTerminal(win);
    this._debugLog(`dropdown: claimed ${win.get_wm_class_instance() || win.get_wm_class() || ''}`);
    return true;
}

export function _clearDropdownWaiters() {
    for (const win of [...this._dropdownWaiters.keys()]) {
        try { win.skip_taskbar = false; } catch (_e) {}
        const cleanup = this._dropdownWaiters.get(win);
        try { cleanup(); } catch (_e) {}
    }
    this._dropdownWaiters.clear();
}

export function _configureDropdownTerminal(win) {
    try { win.skip_taskbar = true; } catch (_e) {}
    try { win.make_above(); } catch (_e) {}
    // Sticky: the terminal follows every workspace WITHOUT leaving an empty
    // one. Dynamic workspaces ignore sticky windows, so a workspace is never
    // removed/renumbered when the terminal moves (that was the "strange
    // switching" with the DDT open).
    try { win.stick(); } catch (_e) {}
}

export function _showDropdownTerminal(win) {
    try { win.unminimize(); } catch (_e) {}
    try { win.make_above(); } catch (_e) {}
    // Sticky (see _configureDropdownTerminal) — re-assert in case something
    // unstuck it, so it appears on the active workspace.
    try { if (!win.is_on_all_workspaces()) win.stick(); } catch (_e) {}
    this._positionDropdownTerminal(win);
    try { win.activate(this._currentTime()); } catch (_e) {}
    this._applyDropdownEffects(win);
}

export function _syncDropdownWorkspace() {
    const win = this._dropdownWin;
    if (!win) return;
    // Sticky (see _configureDropdownTerminal): it is already on every workspace.
    // Moving it here on each switch emptied workspaces under dynamic
    // workspaces, which then removed/renumbered them.
    try { if (win.is_on_all_workspaces()) return; } catch (_e) {}
    const ws = global.workspace_manager.get_active_workspace();
    if (!ws) return;
    try {
        if (win.get_workspace() !== ws) {
            win.change_workspace(ws);
            if (!win.minimized)
                this._positionDropdownTerminal(win);
        }
    } catch (_e) {}
}

export function _scheduleDropdownWorkspaceSync() {
    // Coalesce the burst of active-workspace-changed signals a switch can
    // produce — moving the terminal on every one of them used to fight the
    // switch itself.
    if (this._dropdownSyncId) return;
    this._dropdownSyncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
        this._dropdownSyncId = 0;
        if (this._destroyed) return GLib.SOURCE_REMOVE;
        this._syncDropdownWorkspace();
        return GLib.SOURCE_REMOVE;
    });
}

export function _dropdownRect() {
    let workArea = null;
    let mon = null;
    try {
        const idx = this._dropdownMonitorIndex();
        const ws = global.workspace_manager.get_active_workspace();
        if (ws) {
            workArea = ws.get_work_area_for_monitor(idx);
            if (workArea && workArea.width === 0) workArea = null;
        }
        if (!workArea) {
            mon = global.display.get_monitor_geometry(idx);
        }
    } catch (_e) {}
    const base = workArea || mon;
    if (!base || base.width === 0) return null;
    const heightPct = this._settings.get_int('dropdown-terminal-height') || 33;
    const height = Math.floor(base.height * heightPct / 100);
    this._debugLog(`dropdown: workArea=(${base.x},${base.y},${base.width},${base.height}) hPct=${heightPct} -> rect=(${base.x},${base.y},${base.width},${height})`);
    return { x: base.x, y: base.y, width: base.width, height };
}

export function _positionDropdownTerminal(win) {
    let retries = 0;
    const apply = () => {
        if (this._destroyed) return false;
        let rect = null;
        try { rect = this._dropdownRect(); } catch (_e) {}
        if (!rect) return false;
        const before = win.get_frame_rect();
        if (before.x === rect.x && before.y === rect.y &&
            before.width === rect.width && before.height === rect.height) {
            // Already at the target — skip the redundant move_resize (this
            // used to fire on every workspace switch).
            this._applyDropdownEffects(win);
            return false;
        }
        this._debugLog(`dropdown: position target=(${rect.x},${rect.y},${rect.width},${rect.height}) before=(${before.x},${before.y},${before.width},${before.height}) try=${retries}`);
        try {
            win.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
        } catch (_e) {}
        const frame = win.get_frame_rect();
        const done = frame.x === rect.x && frame.y === rect.y &&
            frame.width === rect.width && frame.height === rect.height;
        if (done) {
            this._debugLog(`dropdown: position settled at (${frame.x},${frame.y},${frame.width},${frame.height})`);
            this._applyDropdownEffects(win);
            return false;
        }
        retries++;
        if (retries >= 20) {
            this._debugLog(`dropdown: position gave up after ${retries} tries, frame=(${frame.x},${frame.y},${frame.width},${frame.height})`);
            this._applyDropdownEffects(win);
            return false;
        }
        return true;
    };
    const retry = () => {
        if (this._destroyed) return GLib.SOURCE_REMOVE;
        return apply() ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
    };
    if (apply())
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, retry);
}

export function _dropdownMonitorIndex() {
    let idx = global.display.get_current_monitor();
    try {
        const focus = global.display.focus_window;
        if (focus && focus.get_monitor() >= 0) idx = focus.get_monitor();
    } catch (_e) {}
    return idx;
}

export function _clearDropdownWindow() {
    this._clearDropdownWaiters();
    const win = this._dropdownWin;
    if (!win) return;
    if (this._dropdownGeometryIds) {
        for (const id of this._dropdownGeometryIds) {
            win.disconnect(id);
        }
        this._dropdownGeometryIds = null;
    }
    if (this._dropdownUnmanagedId) {
        win.disconnect(this._dropdownUnmanagedId);
        this._dropdownUnmanagedId = 0;
    }
    this._removeBorder(win);
    this._removeMask(win);
    this._removeBlur(win);
    try { win.skip_taskbar = false; } catch (_e) {}
    try { win.unmake_above(); } catch (_e) {}
    try { win.unstick(); } catch (_e) {}
    this._dropdownWin = null;
}

export const dropdownMethods = {
    _initDropdownTerminal,
    _toggleDropdownTerminal,
    _handleDropdownWindowCreated,
    _tryClaimDropdown,
    _clearDropdownWaiters,
    _configureDropdownTerminal,
    _showDropdownTerminal,
    _syncDropdownWorkspace,
    _scheduleDropdownWorkspaceSync,
    _dropdownRect,
    _positionDropdownTerminal,
    _dropdownMonitorIndex,
    _clearDropdownWindow,
};
