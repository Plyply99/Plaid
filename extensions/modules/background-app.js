// Plaid — Background App (BGAPP): run a program as a non-interactive desktop
// background, parked on a reserved hidden workspace.
//
// Methods are attached to TilingWMExtension.prototype in extension.js; `this`
// (settings, _backgroundApp* state, maps) is the extension instance.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { MonitorWorkspaceSwitcherPopup }
    from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';
import * as WorkspacesViewModule from 'resource:///org/gnome/shell/ui/workspacesView.js';
import * as WorkspaceThumbnailModule from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';

import { sessionState } from './session-state.js';

export function _initBackgroundApp() {
    try {
        this._backgroundAppSettingsChangedId = this._settings.connect(
            'changed::background-app',
            () => this._scheduleBackgroundAppRestart());
    } catch (_e) {
        this._backgroundAppSettingsChangedId = 0;
    }
    try {
        this._backgroundAppEnabledChangedId = this._settings.connect(
            'changed::background-app-enabled',
            () => this._scheduleBackgroundAppRestart());
    } catch (_e) {
        this._backgroundAppEnabledChangedId = 0;
    }
    this._scheduleBackgroundAppReservation();
    const current = this._settings.get_string('background-app');
    if (current)
        this._recordBackgroundAppHistory(current);
    this._launchBackgroundApp();
}

export function _scheduleSetupPopupCheck() {
    if (this._setupPopupCheckId) return;
    this._setupPopupCheckId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 6000, () => {
        this._setupPopupCheckId = 0;
        if (this._destroyed) return GLib.SOURCE_REMOVE;
        const lines = [];
        if (this._plaidSetupNoticeTerminal) {
            const where = (this._plaidTerminalProfilePath || '').replace(GLib.get_home_dir(), '~')
                || 'your shell profile';
            lines.push(`• Plaid's terminal settings were added to ${where} — open a new terminal to use them.`);
        }
        this._plaidSetupNoticeTerminal = false;
        if (lines.length > 0)
            this._showWarningPopup('Plaid setup complete', lines.join('\n'), 'Click to dismiss');
        return GLib.SOURCE_REMOVE;
    });
}

export function _scheduleBackgroundAppReleaseWatch() {
    if (this._backgroundAppReleaseId) return;
    this._backgroundAppReleaseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20000, () => {
        this._backgroundAppReleaseId = 0;
        if (this._destroyed) return GLib.SOURCE_REMOVE;
        if (this._backgroundAppWin || !this._backgroundAppPending) return GLib.SOURCE_REMOVE;
        this._releaseBackgroundAppReservation();
        return GLib.SOURCE_REMOVE;
    });
}

export function _releaseBackgroundAppReservation() {
    if (this._destroyed || !this._backgroundAppParkingWs) return;
    this._debugLog('background app: release reservation (no window after 20s)');
    try {
        if (this._backgroundAppNWorkspacesId) {
            global.workspace_manager.disconnect(this._backgroundAppNWorkspacesId);
            this._backgroundAppNWorkspacesId = 0;
        }
    } catch (_e) {}
    try {
        if (this._backgroundAppKeepAliveId) {
            GLib.source_remove(this._backgroundAppKeepAliveId);
            this._backgroundAppKeepAliveId = 0;
        }
    } catch (_e) {}
    this._backgroundAppParkingWs = null;
    this._backgroundAppParkingFront = false;
    try { this._restoreBackgroundAppHiding(); } catch (_e) {}
    this._scheduleWorkspacePillUpdate();
}

export function _scheduleBackgroundAppReservation() {
    // Workspace mutations during the shell's login burst hang the
    // session; defer the reservation to the first idle plus a timeout
    // fallback (idempotent — whichever fires first wins).
    if (this._backgroundAppReservationScheduled) return;
    if (this._backgroundAppParkingWs) return;
    this._backgroundAppReservationScheduled = true;
    const run = () => {
        this._backgroundAppReservationScheduled = false;
        this._reserveBackgroundAppWorkspace();
        return GLib.SOURCE_REMOVE;
    };
    GLib.idle_add(GLib.PRIORITY_DEFAULT, run);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, run);
}

export function _reserveBackgroundAppWorkspace() {
    // BGAPP lives on the first real workspace (ws0, the user's "workspace 1"),
    // permanently reserved at the front (never reordered); its card is hidden so
    // the overview row stays gapless. Content lives on ws1+ (_bgAppRealToDisplay).
    if (this._destroyed || this._backgroundAppParkingWs) return;
    try {
        const first = global.workspace_manager.get_workspace_by_index(0);
        if (!first) return;
        const hasOtherWindows = first.list_windows().some(w =>
            w !== this._backgroundAppWin && !this._matchesBackgroundApp(w));
        if (hasOtherWindows) {
            // Rare mid-session re-enable with content on ws0: fall back to
            // a trailing parking (no reorder, canonical n-2 position).
            const parking = global.workspace_manager.append_new_workspace(false, this._currentTime());
            this._backgroundAppParkingWs = parking;
            this._backgroundAppParkingFront = false;
            this._debugLog(`background app: reserved trailing parking (index=${this._wsIndex(parking)})`);
        } else {
            this._backgroundAppParkingWs = first;
            this._backgroundAppParkingFront = true;
            this._debugLog('background app: reserved ws0 parking (index=0)');
        }
        // Keep the parking alive: the shell's dynamic-workspace check
        // removes empty inactive workspaces — the reservation must be
        // armed before the append below queues that check.
        try {
            Main.wm.keepWorkspaceAlive(this._backgroundAppParkingWs, 12 * 60 * 60 * 1000);
        } catch (_e) {}
        this._startBackgroundAppKeepAlive();
        // append_new_workspace(true) activates before n-workspaces is emitted, so
        // append inert and activate after the shell rebuilds its card list.
        try {
            if (global.workspace_manager.get_active_workspace() === this._backgroundAppParkingWs) {
                global.workspace_manager.append_new_workspace(false, this._currentTime());
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                    if (this._destroyed) return GLib.SOURCE_REMOVE;
                    try {
                        const next = global.workspace_manager.get_workspace_by_index(1);
                        if (next) next.activate(this._currentTime());
                        this._debugLog(`background app: active moved to index=${global.workspace_manager.get_active_workspace_index()}`);
                    } catch (_e) {}
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                this._debugLog(`background app: active already at index=${global.workspace_manager.get_active_workspace_index()}`);
            }
        } catch (_e) {}
        this._applyBackgroundAppHiding();
        this._scheduleWorkspacePillUpdate();
        // Controlled card removal: sweep shortly after the append/activate
        // settles, and re-sweep after any shell rebuild that re-adds the
        // parking card. No interception during rebuilds — no races.
        if (!this._backgroundAppNWorkspacesId) {
            this._backgroundAppNWorkspacesId =
                global.workspace_manager.connect('notify::n-workspaces', () => {
                    if (this._destroyed) return;
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                        if (this._destroyed) return GLib.SOURCE_REMOVE;
                        this._hideParkingCard();
                        return GLib.SOURCE_REMOVE;
                    });
                });
        }
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            this._hideParkingCard();
            return GLib.SOURCE_REMOVE;
        });
    } catch (e) {
    this._backgroundAppParkingWs = null;
    this._backgroundAppReservationScheduled = false;
    this._backgroundAppParkingFront = false;
    this._backgroundAppKeepAliveId = 0;
    this._backgroundAppNWorkspacesId = 0;
        log(`[plaid] background app: reservation failed: ${e.message}`);
    }
}

export function _hideParkingCard() {
    // Passive hide — no splice, no destroy. The shell's overview machinery
    // stays 100% native (index-aligned cards), so no races, no errors; the
    // parking card simply never renders. The row keeps its slots (a
    // leading blank) — the price of stability over surgical removal.
    const parkingWs = this._backgroundAppParkingWs;
    if (!parkingWs) return;
    try {
        const controls = Main.overview._overview.controls;
        const display = controls && controls._workspacesDisplay;
        if (!display || !display._workspacesViews) return;
        for (const view of display._workspacesViews) {
            if (!view || !view._workspaces) continue;
            for (const card of view._workspaces) {
                if (card && card.metaWorkspace === parkingWs)
                    card.visible = false;
            }
        }
    } catch (_e) {}
}

export function _startBackgroundAppKeepAlive() {
    if (this._backgroundAppKeepAliveId) return;
    const rekeep = () => {
        if (this._destroyed) return GLib.SOURCE_REMOVE;
        if (this._backgroundAppParkingWs) {
            try {
                Main.wm.keepWorkspaceAlive(this._backgroundAppParkingWs, 12 * 60 * 60 * 1000);
            } catch (_e) {}
        }
        return GLib.SOURCE_CONTINUE;
    };
    this._backgroundAppKeepAliveId =
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60 * 60 * 1000, rekeep);
}

export function _scheduleBackgroundAppRestart() {
    if (this._destroyed) return;
    if (this._backgroundAppRestartId)
        GLib.source_remove(this._backgroundAppRestartId);
    this._backgroundAppRestartId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
        this._backgroundAppRestartId = 0;
        if (this._destroyed) return GLib.SOURCE_REMOVE;
        this._clearBackgroundApp(false);
        this._launchBackgroundApp(true);
        return GLib.SOURCE_REMOVE;
    });
}

export function _isDynamicWorkspaces() {
    try {
        if (!this._mutterSettings) return false;
        return this._mutterSettings.get_boolean('dynamic-workspaces');
    } catch (_e) {
        return false;
    }
}

export function _checkDynamicWorkspaces() {
    if (this._destroyed || this._dynamicWsWarned) return;
    if (this._isDynamicWorkspaces()) return;
    this._dynamicWsWarned = true;
    this._showWarningPopup('Dynamic Workspaces Required',
        "Plaid relies on GNOME's Dynamic Workspaces. Please enable it.",
        'Click to dismiss');
}

export function _launchBackgroundApp(force = false) {
    if (this._destroyed || !this._settings) return;
    if (!this._settings.get_boolean('background-app-enabled')) return;
    const command = this._settings.get_string('background-app');
    if (!command) return;
    // On unlock the shell re-enables us but the bg-app process survives, so adopt
    // the existing window (matched by the PLAID_BGAPP env marker) instead of
    // spawning a duplicate; a dead process leaves no window and respawns.
    this._debugLog(`launch check: lockCycle=${sessionState.lockCycle} command=${command}`);
    if (sessionState.lockCycle && this._adoptBackgroundAppWindow()) {
        this._debugLog('launch check: adopt pending or done');
        return;
    }
    this._debugLog('launch check: no surviving window to adopt');
    // On a settings-driven restart we just closed our own window, but its
    // async unmanage can still make _hasBackgroundAppWindow() true — that
    // silently skipped the new command ("existing window found"). `force`
    // (restart path) always spawns fresh; enable/lock-cycle still adopt.
    if (!force && this._hasBackgroundAppWindow()) {
        this._debugLog('background app: existing window found — adopting, skipping relaunch');
        return;
    }
    this._spawnBackgroundAppProcess(command);
}

export function _spawnBackgroundAppProcess(command) {
    if (!this._isDynamicWorkspaces()) {
        this._debugLog('background app: dynamic workspaces required');
        this._showPopup('Background App',
            'Requires dynamic workspaces (org.gnome.mutter dynamic-workspaces).');
        return;
    }
    this._backgroundAppPending = true;
    if (this._backgroundAppPendingId) GLib.source_remove(this._backgroundAppPendingId);
    this._backgroundAppPendingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30000, () => {
        this._backgroundAppPendingId = 0;
        this._backgroundAppPending = false;
        if (this._backgroundAppWaiter) {
            try { this._backgroundAppWaiter.cleanup(false); } catch (_e) {}
        }
        return GLib.SOURCE_REMOVE;
    });
    // After a toggle/restart the reservation was cleared — reserve first so
    // the park never races a missing parking workspace.
    if (!this._backgroundAppParkingWs)
        this._scheduleBackgroundAppReservation();
    this._scheduleBackgroundAppReleaseWatch();
    this._debugLog(`background app: launching ${command}`);
    this._recordBackgroundAppHistory(command);
    try {
        this._backgroundAppProc = Gio.Subprocess.new(
            ['/bin/sh', '-c', `env PLAID_BGAPP=1 ${command}`],
            Gio.SubprocessFlags.NONE);
        // Watch for an early exit: a process that dies before its window is
        // ever claimed would otherwise leave Plaid waiting out the 30s
        // pending timer and give up (the "bgapp didn't autostart" report).
        // wait_async also reaps the child.
        try {
            // GJS overrides this as wait_async(cancellable, callback) — the
            // C-style (io_priority, cancellable, callback) form is rejected
            // ("Too many arguments … expected 2"), which silently disarmed
            // the exit watch and disabled the respawn entirely.
            this._backgroundAppProc.wait_async(null, (p, res) => {
                try { p.wait_finish(res); } catch (_e) {}
                this._onBackgroundAppProcExit(p);
            });
        } catch (_e) {}
    } catch (e) {
        this._backgroundAppPending = false;
        this._backgroundAppProc = null;
        this._debugLog(`background app: spawn failed: ${e.message}`);
    }
}

export function _onBackgroundAppProcExit(proc) {
    // The spawned shell exited. Only respawn when it died BEFORE any window
    // was claimed and nothing else has already resolved the launch.
    if (this._destroyed || !this._settings) return;
    if (proc !== this._backgroundAppProc) return; // superseded (restart/relaunch)
    if (!this._settings.get_boolean('background-app-enabled')) return;
    const command = this._settings.get_string('background-app');
    if (!command) return;
    if (this._backgroundAppWin) return; // was claimed — leave the state alone
    if (!this._backgroundAppPending) return; // claim/timeout already resolved
    if (this._backgroundAppSpawnRetries >= 2) {
        this._debugLog('background app: spawn retries exhausted');
        return;
    }
    this._backgroundAppSpawnRetries++;
    this._debugLog(`background app: process exited before claim — respawn ${this._backgroundAppSpawnRetries}/2`);
    this._spawnBackgroundAppProcess(command);
}

export function _recordBackgroundAppHistory(command) {
    if (!this._settings || !command) return;
    try {
        let history = this._settings.get_strv('background-app-history');
        history = history.filter((c) => c !== command);
        history.unshift(command);
        history = history.slice(0, 5);
        this._settings.set_strv('background-app-history', history);
    } catch (_e) {}
}

export function _matchesBackgroundApp(win) {
    return this._isMarkerProcess(win, 'PLAID_BGAPP=1',
        this._settings.get_string('background-app') || '');
}

export function _hasBackgroundAppWindow() {
    try {
        for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
            const ws = global.workspace_manager.get_workspace_by_index(i);
            if (!ws) continue;
            for (const win of ws.list_windows()) {
                // is_client_window() doesn't exist on 50/51; the marker match
                // below is the reliable identity on its own.
                if (win && this._matchesBackgroundApp(win))
                    return true;
            }
        }
    } catch (_e) {}
    return false;
}

export function _adoptBackgroundAppWindow() {
    let win = this._findBackgroundAppWindow();
    if (win)
        return this._adoptFoundWindow(win);
    // The surviving window's identity can take a moment to settle after an unlock
    // re-map — retry a few times, and cancel once any path has claimed the window
    // so we never spawn a second instance.
    let attempt = 0;
    const command = this._settings.get_string('background-app');
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        if (this._destroyed) return GLib.SOURCE_REMOVE;
        if (this._backgroundAppWin) {
            this._debugLog('adopt: window already claimed elsewhere — cancelling retry');
            return GLib.SOURCE_REMOVE;
        }
        attempt++;
        this._debugLog(`adopt: retry ${attempt}`);
        const w = this._findBackgroundAppWindow();
        if (w) {
            if (this._adoptFoundWindow(w))
                this._debugLog('background app: resumed surviving window (lock cycle, retry)');
            else
                this._debugLog('adopt: retry found window but adoption failed');
            return GLib.SOURCE_REMOVE;
        }
        if (attempt >= 4) {
            if (this._backgroundAppWin || this._hasBackgroundAppWindow()) {
                this._debugLog('adopt: surviving window present — skipping fresh spawn');
                return GLib.SOURCE_REMOVE;
            }
            this._debugLog('adopt: no surviving window after retries — spawning fresh');
            this._spawnBackgroundAppProcess(command);
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    });
    return true;
}

export function _findBackgroundAppWindow() {
    // Pass 1: pid-based environ marker — the most reliable early signal
    // (independent of wm-class/GTK app id resolution timing).
    try {
        for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
            const ws = global.workspace_manager.get_workspace_by_index(i);
            if (!ws) continue;
            for (const w of ws.list_windows()) {
                let pid = 0;
                try { pid = w.get_pid(); } catch (_e) {}
                if (pid > 0 && this._procEnvironHasMarker(pid, 'PLAID_BGAPP=1'))
                    return w;
            }
        }
    } catch (_e) {}
    // Pass 2: full match (marker + pid set + command token fallback).
    try {
        for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
            const ws = global.workspace_manager.get_workspace_by_index(i);
            if (!ws) continue;
            for (const w of ws.list_windows()) {
                if (w && this._matchesBackgroundApp(w))
                    return w;
            }
        }
    } catch (_e) {}
    try {
        const seen = [];
        for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
            const ws = global.workspace_manager.get_workspace_by_index(i);
            if (!ws) continue;
            for (const w of ws.list_windows()) {
                if (!w) continue;
                let pid = 0;
                try { pid = w.get_pid(); } catch (_e) {}
                seen.push(`${w.get_wm_class_instance() || '?'}/${w.get_title ? w.get_title() || '' : ''}:pid${pid}`);
            }
        }
        this._debugLog(`adopt: scan miss — windows: ${seen.join(', ') || 'none'}`);
    } catch (_e) {}
    return null;
}

export function _adoptFoundWindow(win) {
    try {
        if (this._windowWorkspaces.has(win)) {
            this._debugLog('background app: de-registering window from tiler');
            this._removeWindow(win);
        }
        this._removeMask(win);
        this._removeBlur(win);
        this._removeBorder(win);
        this._backgroundAppWin = win;
        this._backgroundAppSpawnRetries = 0;
        this._backgroundAppUnmanagedId = win.connect('unmanaged', () => {
            this._debugLog(`background app: bg window unmanaged ${win.get_wm_class_instance() || '?'}`);
            if (this._backgroundAppWin === win)
                this._backgroundAppWin = null;
        });
        this._configureBackgroundApp(win);
    } catch (e) {
        log(`[plaid] background app: adopt failed: ${e.message}`);
        return false;
    }
    this._debugLog(`adopt: found ${win.get_wm_class_instance() || '?'}`);
    this._debugLog('background app: resumed surviving window (lock cycle)');
    return true;
}

export function _isMarkerProcess(win, marker, command) {
    if (!win) return false;
    let pid = 0;
    try { pid = win.get_pid(); } catch (_e) {}
    if (pid > 0 && this._procEnvironHasMarker(pid, marker)) return true;
    if (pid > 0 && this._markerPidSetHas(marker, pid)) return true;
    // No command-token fallback here: a token like 'ghostty' matches every
    // ghostty window, not just the bg-app. The env marker is the reliable
    // identity — the bg-app is always spawned with it.
    return false;
}

export function _isBgAppProcessWindow(win) {
    // Strict bg-app identity: the process env carries PLAID_BGAPP=1.
    // No class/token matching — user windows of the same app (ghostty)
    // must never be mistaken for the bg-app.
    if (!win) return false;
    let pid = 0;
    try { pid = win.get_pid(); } catch (_e) {}
    if (pid > 0 && this._procEnvironHasMarker(pid, 'PLAID_BGAPP=1')) return true;
    return false;
}

export function _isExtensionsAppWindow(win) {
    if (!win) return false;
    let pid = 0;
    try { pid = win.get_pid(); } catch (_e) {}
    if (pid > 0) {
        try {
            const [, data] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
            if (data) {
                const cmd = new TextDecoder().decode(data).replace(/\0/g, ' ');
                if (cmd.includes('org.gnome.Shell.Extensions') ||
                    cmd.includes('org.gnome.Extensions') ||
                    cmd.includes('gnome-extensions-app'))
                    return true;
            }
        } catch (_e) {}
    }
    const wms = (win.get_wm_class_instance() || '').toLowerCase();
    if (wms === 'org.gnome.shell.extensions' || wms === 'org.gnome.extensions')
        return true;
    const appId = (win.get_gtk_application_id && win.get_gtk_application_id() || '').toLowerCase();
    if (appId === 'org.gnome.shell.extensions' || appId === 'org.gnome.extensions')
        return true;
    return false;
}

export function _procEnvironHasMarker(pid, marker) {
    try {
        // GLib.file_get_contents stats the file first — /proc files report
        // size 0, so it returns empty. Gio.File.load_contents reads to EOF
        // and works on /proc/<pid>/environ.
        const f = Gio.File.new_for_path(`/proc/${pid}/environ`);
        const [success, data] = f.load_contents(null);
        if (!success || !data) return false;
        return new TextDecoder().decode(data).split('\0').includes(marker);
    } catch (_e) {
        return false;
    }
}

export function _markerPidSetHas(marker, pid) {
    // The /proc sweep is a synchronous, full-directory scan in the
    // compositor main loop — only run it while the bg-app feature is on
    // and its window isn't claimed yet (spawn pending or lock-cycle
    // adoption search). Once claimed, no marker match is needed.
    if (!this._settings || !this._settings.get_boolean('background-app-enabled'))
        return false;
    if (this._backgroundAppWin && !this._backgroundAppPending) return false;
    const now = Date.now();
    const cache = this._markerPidCache;
    if (!cache || cache.marker !== marker || now - cache.at > 1500) {
        const set = new Set();
        try {
            const dir = Gio.File.new_for_path('/proc');
            const children = dir.enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = children.next_file(null))) {
                const name = info.get_name();
                if (!/^\d+$/.test(name)) continue;
                const pidN = parseInt(name, 10);
                if (!this._procEnvironHasMarker(pidN, marker)) continue;
                try {
                    const [, status] = GLib.file_get_contents(`/proc/${pidN}/status`);
                    if (!status) continue;
                    const m = new TextDecoder().decode(status).match(/^NSpid:\s+(.+)$/m);
                    if (!m) continue;
                    const vals = m[1].trim().split(/\s+/).map(Number);
                    const last = vals[vals.length - 1];
                    if (last > 0) set.add(last);
                } catch (_e) {}
            }
        } catch (_e) {}
        this._markerPidCache = { marker, at: now, set };
    }
    const current = this._markerPidCache;
    return !!current && current.marker === marker && current.set.has(pid);
}

export function _handleBackgroundAppWindowCreated(win) {
    if (!win || win.get_window_type() !== Meta.WindowType.NORMAL) return false;
    if (this._backgroundAppPending && this._tryClaimBackgroundApp(win)) return true;
    if (this._backgroundAppWin && this._backgroundAppWin !== win &&
        this._matchesBackgroundApp(win)) {
        this._debugLog('background app: closing stray matching window');
        try { win.delete(this._currentTime()); } catch (_e) {}
    }
    if (this._backgroundAppWaiter && this._backgroundAppWaiter.win === win) return false;
    if (!this._backgroundAppPending) return false;
    this._debugLog('background app: window created, waiting for identity');
    try { win.skip_taskbar = true; } catch (_e) {}
    const ids = [];
    const cleanup = (claimed) => {
        if (!claimed) {
            try { win.skip_taskbar = false; } catch (_e) {}
        }
        for (const id of ids) {
            try { win.disconnect(id); } catch (_e) {}
        }
        ids.length = 0;
        if (this._backgroundAppWaiter && this._backgroundAppWaiter.win === win)
            this._backgroundAppWaiter = null;
    };
    const retry = () => {
        if (this._tryClaimBackgroundApp(win)) cleanup(true);
    };
    ids.push(win.connect('notify::wm-class', retry));
    ids.push(win.connect('notify::gtk-application-id', retry));
    ids.push(win.connect('unmanaged', () => cleanup(false)));
    this._backgroundAppWaiter = { win, cleanup };
    return false;
}

export function _tryClaimBackgroundApp(win) {
    if (!this._backgroundAppPending || !win) return false;
    const instance = (win.get_wm_class_instance() || '').toLowerCase();
    const cls = (win.get_wm_class() || '').toLowerCase();
    if (!this._matchesBackgroundApp(win)) {
        this._debugLog(`background app: identity not yet matching (instance=${instance} class=${cls})`);
        return false;
    }
    if (this._backgroundAppPendingId) {
        GLib.source_remove(this._backgroundAppPendingId);
        this._backgroundAppPendingId = 0;
    }
    this._backgroundAppPending = false;
    this._backgroundAppSpawnRetries = 0;
    if (this._windowWorkspaces.has(win)) {
        this._debugLog('background app: de-registering window from tiler');
        this._removeWindow(win);
    }
    this._removeMask(win);
    this._removeBlur(win);
    this._removeBorder(win);
    this._backgroundAppWin = win;
    this._backgroundAppUnmanagedId = win.connect('unmanaged', () => {
        this._debugLog(`background app: bg window unmanaged ${win.get_wm_class_instance() || '?'}`);
        if (this._backgroundAppWin === win)
            this._backgroundAppWin = null;
    });
    this._configureBackgroundApp(win);
    try {
        const f = win.get_frame_rect();
        this._debugLog(`background app: claimed ${instance || cls} frame=(${f.x},${f.y},${f.width},${f.height})`);
    } catch (_e) {}
    return true;
}

export function _configureBackgroundApp(win) {
    try { win.skip_taskbar = true; } catch (_e) {}
    try { win.unstick(); } catch (_e) {}
    try { win.unmake_above(); } catch (_e) {}
    // Clone path: park the window on the reserved parking workspace and
    // show a full-bleed clone in the background group — input-free by
    // construction, smooth (the parked window is never animated).
    this._debugLog('background app: clone mode (parked window + background clone)');
    const deferredPark = () => {
        if (this._destroyed) return GLib.SOURCE_REMOVE;
        this._debugLog('background app: deferred park firing');
        if (win !== this._backgroundAppWin) {
            this._debugLog('background app: deferred park skipped (window no longer the bg app)');
            return GLib.SOURCE_REMOVE;
        }
        // Defer the park out of the login burst: the workspace mutation,
        // the maximize and the clone's first paint land in the settled
        // session. Each step is independent so a park failure can never
        // skip the clone.
        try {
            this._parkBackgroundAppOnWorkspace(win);
        } catch (e) {
            log(`[plaid] background app: park failed: ${e.message}`);
        }
        try {
            this._startBackgroundAppParkWatch(win);
        } catch (e) {
            log(`[plaid] background app: park watch failed: ${e.message}`);
        }
        try {
            this._ensureBackgroundAppClone(win);
        } catch (e) {
            log(`[plaid] background app: clone failed: ${e.message}`);
        }
        // Retry/heal the clone from here (post-park, so the clone is built
        // from the settled maximized source) until it is stable.
        this._startBackgroundAppCloneWatch(win);
        // Late re-raise: at login the shell's wallpaper actors settle
        // after the clone is created and can land above it in the
        // background group — re-insert on top once the startup is done.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            this._raiseBackgroundAppClone();
            this._debugLog('background app: clone re-raised after startup settle');
            return GLib.SOURCE_REMOVE;
        });
        return GLib.SOURCE_REMOVE;
    };
    try {
        const actor = win.get_compositor_private();
        if (actor) {
            this._backgroundAppFirstFrameId = actor.connect('first-frame', () => {
                if (this._backgroundAppFirstFrameId) {
                    try { actor.disconnect(this._backgroundAppFirstFrameId); } catch (_e) {}
                    this._backgroundAppFirstFrameId = 0;
                }
                this._debugLog('background app: first-frame fired, scheduling park in 3s');
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, deferredPark);
            });
        }
    } catch (_e) {}
    // Fallback: during the login burst the window can map and paint before
    // the claim's first-frame connect — the signal is then missed and the
    // pipeline would never run. This timer guarantees it regardless.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, deferredPark);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        if (this._destroyed) return GLib.SOURCE_REMOVE;
        if (win !== this._backgroundAppWin) return GLib.SOURCE_REMOVE;
        this._positionBackgroundAppClone();
        return GLib.SOURCE_REMOVE;
    });
}

export function _startBackgroundAppParkWatch(win) {
    this._disconnectBackgroundAppParkWatch();
    if (!win) return;
    this._backgroundAppParkCount = 0;
    const pending = () => {
        if (this._backgroundAppParkCoalesceId) return;
        this._backgroundAppParkCoalesceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._backgroundAppParkCoalesceId = 0;
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            if (this._backgroundAppParkCount >= 15) {
                this._disconnectBackgroundAppParkWatch();
                return GLib.SOURCE_REMOVE;
            }
            this._backgroundAppParkCount++;
            this._parkBackgroundAppOnWorkspace(win);
            // The clone computed its scale when the source was still 0x0;
            // re-allocate it so Clutter re-syncs the stretch to full-bleed.
            this._positionBackgroundAppClone();
            return GLib.SOURCE_REMOVE;
        });
    };
    const ids = [
        { emitter: win, id: win.connect('size-changed', pending) },
    ];
    this._backgroundAppParkIds = ids;
    this._backgroundAppParkWatchTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
        this._backgroundAppParkWatchTimeoutId = 0;
        this._disconnectBackgroundAppParkWatch();
        return GLib.SOURCE_REMOVE;
    });
}

export function _disconnectBackgroundAppParkWatch() {
    if (this._backgroundAppParkWatchTimeoutId) {
        GLib.source_remove(this._backgroundAppParkWatchTimeoutId);
        this._backgroundAppParkWatchTimeoutId = 0;
    }
    if (this._backgroundAppParkCoalesceId) {
        GLib.source_remove(this._backgroundAppParkCoalesceId);
        this._backgroundAppParkCoalesceId = 0;
    }
    this._backgroundAppParkCount = 0;
    if (this._backgroundAppParkIds) {
        for (const { emitter, id } of this._backgroundAppParkIds) {
            try { emitter.disconnect(id); } catch (_e) {}
        }
        this._backgroundAppParkIds = null;
    }
}

export function _parkBackgroundAppOnWorkspace(win) {
    // The parked window renders live on the trailing workspace because
    // ghostty renders continuously; clients that render only on frame
    // callbacks may freeze here (native-Wayland research continues).
    if (!win) return;
    const ws = win.get_workspace() || global.workspace_manager.get_active_workspace();
    if (!ws) return;
    const monitor = global.display.get_primary_monitor();
    const mon = global.display.get_monitor_geometry(monitor);
    if (!mon || mon.width === 0) return;

    if (!this._backgroundAppParkingWs) {
        this._debugLog('background app: park deferred (no parking ws yet, scheduling reservation)');
        this._scheduleBackgroundAppReservation();
        // Retry until the reservation completes (bounded) — the window
        // must never be left unparked on the user's workspace.
        if (this._backgroundAppParkRetryCount < 6) {
            this._backgroundAppParkRetryCount++;
            if (this._backgroundAppParkRetryId)
                GLib.source_remove(this._backgroundAppParkRetryId);
            this._backgroundAppParkRetryId =
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                    this._backgroundAppParkRetryId = 0;
                    if (this._destroyed) return GLib.SOURCE_REMOVE;
                    if (this._backgroundAppWin)
                        this._parkBackgroundAppOnWorkspace(this._backgroundAppWin);
                    return GLib.SOURCE_REMOVE;
                });
        }
        return;
    }
    this._backgroundAppParkRetryCount = 0;
    const beforeIdx = this._wsIndex(ws);
    const targetIdx = this._wsIndex(this._backgroundAppParkingWs);
    try {
        if (win.get_workspace() !== this._backgroundAppParkingWs)
            win.change_workspace(this._backgroundAppParkingWs);
    } catch (e) {
        log(`[plaid] background app: park change_workspace failed: ${e.message}`);
    }
    try {
        // Maximize for a sharp full-size clone source — mutter-enforced,
        // clients cannot refuse it (native Wayland clients may ignore
        // plain move_resize configures). The GIR signature takes no args.
        win.maximize();
    } catch (e) {
        log(`[plaid] background app: park maximize failed: ${e.message}`);
    }
    try {
        win.move_resize_frame(true, mon.x, mon.y, mon.width, mon.height);
    } catch (e) {
        log(`[plaid] background app: park resize failed: ${e.message}`);
    }
    const f = win.get_frame_rect();
    this._debugLog(`background app: parked ws=${beforeIdx}->${targetIdx} frame=(${f.x},${f.y},${f.width},${f.height})`);
}

export function _applyBackgroundAppHiding() {
    if (this._backgroundAppHiding || !this._backgroundAppParkingWs) return;
    const self = this;
    const origGetNeighbor = Meta.Workspace.prototype.get_neighbor;
    const wrappedGetNeighbor = function (direction) {
        const neighbor = origGetNeighbor.call(this, direction);
        if (!neighbor || neighbor === this) return neighbor;
        if (neighbor === self._backgroundAppParkingWs) {
            const next = origGetNeighbor.call(neighbor, direction);
            if (next && next !== neighbor) return next;
            return this;
        }
        return neighbor;
    };
    const origUpdateVisibility =
        WorkspacesViewModule.WorkspacesView.prototype._updateVisibility;
    const wrappedUpdateVisibility = function () {
        origUpdateVisibility.call(this);
        // The shell's visibility funnel re-shows every card (overview
        // transitions, fit-mode changes); re-hide the parking card so the
        // passive hide survives. No destroy, no reorder — pure visibility.
        const parkingWs = self._backgroundAppParkingWs;
        if (!parkingWs || !this._workspaces) return;
        for (const card of this._workspaces) {
            if (card && card.metaWorkspace === parkingWs)
                card.visible = false;
        }
    };
    const origRedisplay = MonitorWorkspaceSwitcherPopup.prototype.redisplay;
    const wrappedRedisplay = function (activeWorkspaceIndex) {
        const parkingIdx = self._backgroundAppParkingWs ?
            self._wsIndex(self._backgroundAppParkingWs) : -1;
        const wm = global.workspace_manager;
        this._list.destroy_all_children();
        for (let i = 0; i < wm.n_workspaces; i++) {
            if (i === parkingIdx) continue;
            const indicator = new St.Bin({ style_class: 'ws-switcher-indicator' });
            if (i === activeWorkspaceIndex)
                indicator.add_style_pseudo_class('active');
            this._list.add_child(indicator);
        }
    };
    const origAddThumbnails =
        WorkspaceThumbnailModule.ThumbnailsBox.prototype.addThumbnails;
    const wrappedAddThumbnails = function (start, count) {
        origAddThumbnails.call(this, start, count);
        const parkingWs = self._backgroundAppParkingWs;
        if (!parkingWs) return;
        for (const t of this._thumbnails) {
            if (t.metaWorkspace === parkingWs) {
                t.visible = false;
                break;
            }
        }
    };
    Meta.Workspace.prototype.get_neighbor = wrappedGetNeighbor;
    WorkspacesViewModule.WorkspacesView.prototype._updateVisibility = wrappedUpdateVisibility;
    MonitorWorkspaceSwitcherPopup.prototype.redisplay = wrappedRedisplay;
    WorkspaceThumbnailModule.ThumbnailsBox.prototype.addThumbnails = wrappedAddThumbnails;
    // The shell binds its workspace keybindings at init with a pre-bound handler,
    // so method wraps don't run — re-register the numeric + 'last' bindings to
    // translate the visible numbering (ws0 is reserved parking).
    const origSwitcher = Main.wm._showWorkspaceSwitcher;
    const remapHandler = (display, window, event, binding) => {
        try {
            const name = binding.get_name() || '';
            const parts = name.split('-');
            if (parts.length >= 4) {
                const action = parts[0];
                const target = parts[3];
                let shim = null;
                if (/^\d+$/.test(target)) {
                    const n = parseInt(target, 10);
                    shim = { get_name: () => `${action}-to-workspace-${n + 1}` };
                } else if (target === 'last') {
                    const n = global.workspace_manager.n_workspaces;
                    shim = { get_name: () => `${action}-to-workspace-${Math.max(1, n - 1)}` };
                }
                if (shim)
                    return origSwitcher.call(Main.wm, display, window, event, shim);
            }
        } catch (_e) {}
        return origSwitcher.call(Main.wm, display, window, event, binding);
    };
    const remapBindings = [];
    for (let i = 1; i <= 12; i++) {
        remapBindings.push(`switch-to-workspace-${i}`);
        remapBindings.push(`move-to-workspace-${i}`);
    }
    remapBindings.push('switch-to-workspace-last', 'move-to-workspace-last');
    try {
        const modes = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        for (const name of remapBindings)
            Main.wm.setCustomKeybindingHandler(name, modes, remapHandler);
    } catch (e) {
        // A keybind registration failure must never abort the reservation.
        log(`[plaid] background app: keybind remap failed: ${e.message}`);
    }
    this._backgroundAppHiding = {
        origGetNeighbor, wrappedGetNeighbor,
        origUpdateVisibility, wrappedUpdateVisibility,
        origRedisplay, wrappedRedisplay,
        origAddThumbnails, wrappedAddThumbnails,
        remapBindings, origSwitcher,
    };
    // Hide the pre-existing parking thumbnail (the addThumbnails wrap
    // covers future ones).
    try {
        const controls = Main.overview._overview.controls;
        const parkingWs = this._backgroundAppParkingWs;
        const thumbs = controls && controls._workspacesThumbnails;
        if (thumbs) {
            const hideParkingThumb = (box) => {
                if (!box || !box._thumbnails) return;
                for (const t of box._thumbnails) {
                    if (t.metaWorkspace === parkingWs)
                        t.visible = false;
                }
            };
            hideParkingThumb(thumbs);
            if (thumbs.get_children) {
                for (const child of thumbs.get_children())
                    hideParkingThumb(child);
            }
        }
    } catch (_e) {}
    this._debugLog('background app: hiding parking workspace from overview, switcher, cycling');
}

export function _restoreBackgroundAppHiding() {
    const h = this._backgroundAppHiding;
    if (!h) return;
    try {
        if (Meta.Workspace.prototype.get_neighbor === h.wrappedGetNeighbor)
            Meta.Workspace.prototype.get_neighbor = h.origGetNeighbor;
        if (WorkspacesViewModule.WorkspacesView.prototype._updateVisibility === h.wrappedUpdateVisibility)
            WorkspacesViewModule.WorkspacesView.prototype._updateVisibility = h.origUpdateVisibility;
        if (MonitorWorkspaceSwitcherPopup.prototype.redisplay === h.wrappedRedisplay)
            MonitorWorkspaceSwitcherPopup.prototype.redisplay = h.origRedisplay;
        if (WorkspaceThumbnailModule.ThumbnailsBox.prototype.addThumbnails === h.wrappedAddThumbnails)
            WorkspaceThumbnailModule.ThumbnailsBox.prototype.addThumbnails = h.origAddThumbnails;
        // Restore the stock keybinding handlers (pass-through to the
        // original workspace switcher).
        if (h.remapBindings && h.origSwitcher) {
            try {
                const pass = (display, window, event, binding) =>
                    h.origSwitcher.call(Main.wm, display, window, event, binding);
                const modes = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
                for (const name of h.remapBindings)
                    Main.wm.setCustomKeybindingHandler(name, modes, pass);
            } catch (_e) {}
        }
    } catch (_e) {}
    this._backgroundAppHiding = null;
}

export function _raiseBackgroundAppClone() {
    const clone = this._backgroundAppClone;
    if (!clone) return;
    const bg = Main.layoutManager._backgroundGroup;
    if (!bg) return;
    try {
        if (clone.get_parent() !== bg) {
            // Self-heal an orphaned clone (background-group churn): re-attach it
            // to the current background group and re-stretch, or the background
            // stays invisible until a manual bg-app toggle.
            this._debugLog('background app: clone orphaned — re-parenting to background group');
            const parent = clone.get_parent();
            if (parent) parent.remove_child(clone);
            bg.add_child(clone);
            this._positionBackgroundAppClone();
        }
        bg.set_child_above_sibling(clone, null);
    } catch (_e) {}
}

export function _scheduleBackgroundAppParkingFix() {
    if (this._destroyed || !this._backgroundAppWin) return;
    if (this._backgroundAppParkingFixId) return;
    this._backgroundAppParkingFixId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
        this._backgroundAppParkingFixId = 0;
        if (this._destroyed) return GLib.SOURCE_REMOVE;
        this._reassertBackgroundAppParking();
        return GLib.SOURCE_REMOVE;
    });
}

export function _reassertBackgroundAppParking() {
    if (this._destroyed || !this._backgroundAppWin) return;
    if (!this._backgroundAppParkingWs) {
        this._parkBackgroundAppOnWorkspace(this._backgroundAppWin);
        return;
    }
    const n = global.workspace_manager.get_n_workspaces();
    const parkingIdx = this._wsIndex(this._backgroundAppParkingWs);
    // Stable homes: the front (ws0 — the normal reservation) or the
    // trailing n-2 (rare fallback). Nothing reorders them; if the parking
    // ever ends up elsewhere, relocate with the old append-and-move logic.
    if (parkingIdx !== 0 && parkingIdx !== n - 2) {
        const now = Date.now();
        if (now - (this._backgroundAppParkingLastRelocate || 0) < 1000)
            return;
        this._backgroundAppParkingLastRelocate = now;
        const oldParking = this._backgroundAppParkingWs;
        this._backgroundAppParkingWs =
            global.workspace_manager.append_new_workspace(false, this._currentTime());
        this._debugLog(`background app: parking relocated to ws=${this._wsIndex(this._backgroundAppParkingWs)}`);
        try {
            if (this._backgroundAppWin.get_workspace() !== this._backgroundAppParkingWs)
                this._backgroundAppWin.change_workspace(this._backgroundAppParkingWs);
        } catch (_e) {}
    }
    // Route through the logged park so every re-park is journal-visible.
    try {
        this._parkBackgroundAppOnWorkspace(this._backgroundAppWin);
    } catch (e) {
        log(`[plaid] background app: reassert park failed: ${e.message}`);
    }
}

export function _ensureBackgroundAppClone(win) {
    if (!win) return;
    if (!this._backgroundAppClone) {
        const actor = win.get_compositor_private();
        if (!actor) {
            this._debugLog('background app: clone skipped (no compositor actor)');
            return;
        }
        const bg = Main.layoutManager._backgroundGroup;
        if (!bg) {
            this._debugLog('background app: clone skipped (no background group)');
            return;
        }
        try {
            this._backgroundAppClone = new Clutter.Clone({ source: actor });
            bg.add_child(this._backgroundAppClone);
            if (!this._backgroundAppGroupAddedId) {
                this._backgroundAppGroupAddedId = bg.connect('child-added', () => {
                    this._raiseBackgroundAppClone();
                });
            }
            this._debugLog('background app: clone created');
        } catch (e) {
            log(`[plaid] background app clone failed: ${e.message}`);
            this._backgroundAppClone = null;
            return;
        }
    }
    this._positionBackgroundAppClone();
}

export function _startBackgroundAppCloneWatch(win) {
    // Post-login clone watchdog: the clone is built into the background group
    // during the login burst (group may not exist yet, actor may be replaced,
    // later churn can orphan it), and a lost clone leaves the background absent
    // for the session. Bounded: stops after two stable ticks or ~20s.
    if (this._backgroundAppCloneWatchId) {
        GLib.source_remove(this._backgroundAppCloneWatchId);
        this._backgroundAppCloneWatchId = 0;
    }
    if (!win) return;
    let ticks = 0;
    let good = 0;
    this._backgroundAppCloneWatchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        if (this._destroyed || win !== this._backgroundAppWin) {
            this._backgroundAppCloneWatchId = 0;
            return GLib.SOURCE_REMOVE;
        }
        ticks++;
        if (!this._backgroundAppClone) {
            this._ensureBackgroundAppClone(win);
        } else {
            const srcActor = win.get_compositor_private();
            if (srcActor && this._backgroundAppClone.get_source() !== srcActor) {
                // The window actor can be replaced (surface round-trips):
                // the clone would keep painting the dead source (blank).
                this._debugLog('background app: clone source actor replaced — recreating clone');
                try { this._backgroundAppClone.destroy(); } catch (_e) {}
                this._backgroundAppClone = null;
                this._ensureBackgroundAppClone(win);
            }
        }
        this._raiseBackgroundAppClone();
        const bg = Main.layoutManager._backgroundGroup;
        const c = this._backgroundAppClone;
        const src = c ? c.get_source() : null;
        if (c && bg && c.get_parent() === bg && src && src.width > 0 && src.height > 0)
            good++;
        else
            good = 0;
        if (good >= 2) {
            this._backgroundAppCloneWatchId = 0;
            return GLib.SOURCE_REMOVE;
        }
        if (ticks >= 20) {
            const srcNow = c ? c.get_source() : null;
            this._debugLog(`background app: clone watchdog gave up clone=${!!c} ` +
                `parent=${!!(c && c.get_parent() === bg)} ` +
                `source=${srcNow ? `${Math.round(srcNow.width)}x${Math.round(srcNow.height)}` : 'none'}`);
            this._backgroundAppCloneWatchId = 0;
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    });
}

export function _positionBackgroundAppClone() {
    const clone = this._backgroundAppClone;
    if (!clone) {
        this._debugLog('background app: clone position skipped (no clone)');
        return;
    }
    const monitor = global.display.get_primary_monitor();
    const mon = global.display.get_monitor_geometry(monitor);
    if (!mon || mon.width === 0) {
        this._debugLog('background app: clone position skipped (monitor geometry unavailable)');
        return;
    }
    try {
        clone.set_position(mon.x, mon.y);
        clone.set_size(mon.width, mon.height);
        // The same-size set_size is a no-op, so the clone never re-runs
        // clutter_clone_allocate and its internal scale stays 1.0 (computed
        // when the source was 0x0). Nudge the size to force a real
        // re-allocation that recomputes the stretch from the settled source.
        try {
            clone.queue_relayout();
            clone.set_size(mon.width + 1, mon.height + 1);
            clone.set_size(mon.width, mon.height);
        } catch (_e) {}
        const src = clone.get_source();
        this._debugLog(`background app: clone at (${mon.x},${mon.y},${mon.width},${mon.height}) ` +
            `source=${src ? `${Math.round(src.width)}x${Math.round(src.height)}` : 'none'}`);
    } catch (e) {
        log(`[plaid] background app: clone position failed: ${e.message}`);
    }
}

export function _refillBackgroundApp() {
    if (!this._backgroundAppWin) return;
    this._parkBackgroundAppOnWorkspace(this._backgroundAppWin);
    this._positionBackgroundAppClone();
}

export function _restoreFocusFromBackgroundApp() {
    if (this._destroyed || !this._backgroundAppWin) return;
    const ws = global.workspace_manager.get_active_workspace();
    let prev = this._lastRealFocusedWindow;
    if (!prev || !prev.get_compositor_private()) {
        if (ws) prev = this._lastFocusedPerWorkspace.get(ws);
    }
    if (!prev || prev === this._backgroundAppWin) return;
    if (!prev.get_compositor_private()) return;
    this._debugLog('background app: stealing focus back');
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        if (this._destroyed) return false;
        if (global.display.focus_window === prev) return false;
        try { prev.activate(this._currentTime()); } catch (_e) {}
        return false;
    });
}

export function _clearBackgroundApp(releaseReservation = true) {
    if (this._setupPopupCheckId) {
        GLib.source_remove(this._setupPopupCheckId);
        this._setupPopupCheckId = 0;
    }
    this._plaidSetupNoticeTerminal = false;
    if (this._backgroundAppReleaseId) {
        GLib.source_remove(this._backgroundAppReleaseId);
        this._backgroundAppReleaseId = 0;
    }
    if (this._backgroundAppRestartId) {
        GLib.source_remove(this._backgroundAppRestartId);
        this._backgroundAppRestartId = 0;
    }
    if (this._backgroundAppPendingId) {
        GLib.source_remove(this._backgroundAppPendingId);
        this._backgroundAppPendingId = 0;
    }
    this._backgroundAppPending = false;
    this._backgroundAppSpawnRetries = 0;
    this._disconnectBackgroundAppParkWatch();
    if (this._backgroundAppCloneWatchId) {
        GLib.source_remove(this._backgroundAppCloneWatchId);
        this._backgroundAppCloneWatchId = 0;
    }
    // A soft teardown (feature toggled off / command changed while Plaid
    // stays enabled) keeps the reserved parking workspace, its hiding
    // wraps, and the n-workspaces re-hide hook — only a full release
    // (extension disable) tears them down.
    if (releaseReservation && this._backgroundAppNWorkspacesId) {
        try { global.workspace_manager.disconnect(this._backgroundAppNWorkspacesId); } catch (_e) {}
        this._backgroundAppNWorkspacesId = 0;
    }
    if (this._backgroundAppParkRetryId) {
        GLib.source_remove(this._backgroundAppParkRetryId);
        this._backgroundAppParkRetryId = 0;
    }
    this._backgroundAppParkRetryCount = 0;
    // Keep the hourly keep-alive re-arm while the reservation is kept, or
    // the shell's 12h keep-alive could lapse and sweep the empty parking.
    if (releaseReservation && this._backgroundAppKeepAliveId) {
        GLib.source_remove(this._backgroundAppKeepAliveId);
        this._backgroundAppKeepAliveId = 0;
    }
    if (this._backgroundAppParkingFixId) {
        GLib.source_remove(this._backgroundAppParkingFixId);
        this._backgroundAppParkingFixId = 0;
    }
    if (this._backgroundAppClone) {
        try { this._backgroundAppClone.destroy(); } catch (_e) {}
        this._backgroundAppClone = null;
    }
    if (this._backgroundAppGroupAddedId) {
        try {
            const bg = Main.layoutManager._backgroundGroup;
            if (bg) bg.disconnect(this._backgroundAppGroupAddedId);
        } catch (_e) {}
        this._backgroundAppGroupAddedId = 0;
    }
    if (this._backgroundAppWaiter) {
        const waiter = this._backgroundAppWaiter;
        this._backgroundAppWaiter = null;
        try { waiter.cleanup(false); } catch (_e) {}
        if (!sessionState.lockCycle) {
            this._debugLog(`bg teardown: closing waiter window (lockCycle=${sessionState.lockCycle})`);
            this._closeBackgroundAppWindow(waiter.win);
        } else {
            this._debugLog('bg teardown: keeping waiter window alive (lock cycle)');
        }
    }
    const win = this._backgroundAppWin;
    this._debugLog(`bg teardown: win=${win ? win.get_wm_class_instance() || '?' : 'null'} ` +
        `waiter=${!!this._backgroundAppWaiter} lockCycle=${sessionState.lockCycle}`);
    if (this._backgroundAppUnmanagedId) {
        if (win) {
            try { win.disconnect(this._backgroundAppUnmanagedId); } catch (_e) {}
        }
        this._backgroundAppUnmanagedId = 0;
    }
    if (this._backgroundAppFirstFrameId && win) {
        try {
            const actor = win.get_compositor_private();
            if (actor) actor.disconnect(this._backgroundAppFirstFrameId);
        } catch (_e) {}
        this._backgroundAppFirstFrameId = 0;
    }
    if (win && !sessionState.lockCycle) {
        this._debugLog(`bg teardown: closing main window (lockCycle=${sessionState.lockCycle})`);
        this._closeBackgroundAppWindow(win);
    } else if (win) {
        this._debugLog('bg teardown: keeping main window alive (lock cycle)');
    }
    this._backgroundAppWin = null;
    this._backgroundAppProc = null;
    // A lock cycle re-enables us right after unlocking: keep the bg-app process,
    // its hiding state, and the parking workspace so we adopt the surviving window.
    // A soft teardown (releaseReservation=false) also keeps the parking reserved
    // and hidden — releasing it would expose an empty workspace and shift the
    // index-keyed layout rules.
    if (!sessionState.lockCycle && releaseReservation) {
        this._restoreBackgroundAppHiding();
        try {
            // The front-reserved ws0 is the shell's own first workspace — never
            // remove it (only the appended trailing fallback parking is
            // removable). The reservation survives restarts and toggles.
            if (!this._backgroundAppParkingFront &&
                this._backgroundAppParkingWs &&
                this._backgroundAppParkingWs.list_windows().length === 0)
                global.workspace_manager.remove_workspace(this._backgroundAppParkingWs, this._currentTime());
        } catch (_e) {}
    }
    if (releaseReservation) {
        this._backgroundAppParkingWs = null;
        this._backgroundAppParkingFront = false;
    }
}

export function _closeBackgroundAppWindow(win) {
    if (!win) return;
    this._debugLog(`background app: closing bg window ${win.get_wm_class_instance() || '?'}`);
    try { win.delete(this._currentTime()); } catch (_e) {}
    const proc = this._backgroundAppProc;
    if (proc) {
        this._debugLog('background app: bg process force_exit scheduled');
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            try { proc.force_exit(); } catch (_e) {}
            return GLib.SOURCE_REMOVE;
        });
    }
}

export const backgroundAppMethods = {
    _initBackgroundApp,
    _scheduleSetupPopupCheck,
    _scheduleBackgroundAppReleaseWatch,
    _releaseBackgroundAppReservation,
    _scheduleBackgroundAppReservation,
    _reserveBackgroundAppWorkspace,
    _hideParkingCard,
    _startBackgroundAppKeepAlive,
    _scheduleBackgroundAppRestart,
    _isDynamicWorkspaces,
    _checkDynamicWorkspaces,
    _launchBackgroundApp,
    _spawnBackgroundAppProcess,
    _onBackgroundAppProcExit,
    _recordBackgroundAppHistory,
    _matchesBackgroundApp,
    _hasBackgroundAppWindow,
    _adoptBackgroundAppWindow,
    _findBackgroundAppWindow,
    _adoptFoundWindow,
    _isMarkerProcess,
    _isBgAppProcessWindow,
    _isExtensionsAppWindow,
    _procEnvironHasMarker,
    _markerPidSetHas,
    _handleBackgroundAppWindowCreated,
    _tryClaimBackgroundApp,
    _configureBackgroundApp,
    _startBackgroundAppParkWatch,
    _disconnectBackgroundAppParkWatch,
    _parkBackgroundAppOnWorkspace,
    _applyBackgroundAppHiding,
    _restoreBackgroundAppHiding,
    _raiseBackgroundAppClone,
    _scheduleBackgroundAppParkingFix,
    _reassertBackgroundAppParking,
    _ensureBackgroundAppClone,
    _startBackgroundAppCloneWatch,
    _positionBackgroundAppClone,
    _refillBackgroundApp,
    _restoreFocusFromBackgroundApp,
    _clearBackgroundApp,
    _closeBackgroundAppWindow,
};
