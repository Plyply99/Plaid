// Plaid — Background App (BGAPP): run a program as a non-interactive desktop
// background, parked on a reserved hidden workspace.
//
// Methods live on this subsystem class; `this`
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
import { PlaidSubsystem } from './subsystem.js';


export class BackgroundApp extends PlaidSubsystem {
    constructor(core) {
        super(core);
    }

    initBackgroundApp() {
        try {
            this.core._backgroundAppSettingsChangedId = this.connectObject(this.core._settings,
                'changed::background-app',
                () => this.scheduleBackgroundAppRestart());
        } catch (_e) {
            this.core._backgroundAppSettingsChangedId = 0;
        }
        try {
            this.core._backgroundAppEnabledChangedId = this.connectObject(this.core._settings,
                'changed::background-app-enabled',
                () => this.scheduleBackgroundAppRestart());
        } catch (_e) {
            this.core._backgroundAppEnabledChangedId = 0;
        }
        this.scheduleBackgroundAppReservation();
        const current = this.core._settings.get_string('background-app');
        if (current)
            this.recordBackgroundAppHistory(current);
        this.launchBackgroundApp();
    }

    scheduleBackgroundAppReleaseWatch() {
        if (this.core._backgroundAppReleaseId) return;
        this.core._backgroundAppReleaseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20000, () => {
            this.core._backgroundAppReleaseId = 0;
            if (!this.core._settings) return GLib.SOURCE_REMOVE;
            if (this.core._backgroundAppWin || !this.core._backgroundAppPending) return GLib.SOURCE_REMOVE;
            this.releaseBackgroundAppReservation();
            return GLib.SOURCE_REMOVE;
        });
    }

    releaseBackgroundAppReservation() {
        if (!this.core._settings || !this.core._backgroundAppParkingWs) return;
        this.core.debugLog('background app: release reservation (no window after 20s)');
        if (this.core._backgroundAppNWorkspacesId) {
            global.workspace_manager.disconnectObject(this.core._backgroundAppNWorkspacesId);
            this.core._backgroundAppNWorkspacesId = 0;
        }
        if (this.core._backgroundAppKeepAliveId) {
            GLib.source_remove(this.core._backgroundAppKeepAliveId);
            this.core._backgroundAppKeepAliveId = 0;
        }
        this.core._backgroundAppParkingWs = null;
        this.core._backgroundAppParkingFront = false;
        { this.restoreBackgroundAppHiding(); }
        this.core.workspacePill.scheduleWorkspacePillUpdate();
    }

    scheduleBackgroundAppReservation() {
        // Workspace mutations during the shell's login burst hang the
        // session; defer the reservation to the first idle plus a timeout
        // fallback (idempotent — whichever fires first wins).
        if (this.core._backgroundAppReservationScheduled) return;
        if (this.core._backgroundAppParkingWs) return;
        this.core._backgroundAppReservationScheduled = true;
        const run = () => {
            this.core._backgroundAppReservationScheduled = false;
            this.reserveBackgroundAppWorkspace();
            return GLib.SOURCE_REMOVE;
        };
        this.core.signals.addIdle(run);
        this.core.signals.addTimeout(1500, run);
    }

    reserveBackgroundAppWorkspace() {
        // BGAPP lives on the first real workspace (ws0, the user's "workspace 1"),
        // permanently reserved at the front (never reordered); its card is hidden so
        // the overview row stays gapless. Content lives on ws1+ (_bgAppRealToDisplay).
        if (!this.core._settings || this.core._backgroundAppParkingWs) return;
        try {
            const first = global.workspace_manager.get_workspace_by_index(0);
            if (!first) return;
            const hasOtherWindows = first.list_windows().some(w =>
                w !== this.core._backgroundAppWin && !this.matchesBackgroundApp(w));
            if (hasOtherWindows) {
                // Rare mid-session re-enable with content on ws0: fall back to
                // a trailing parking (no reorder, canonical n-2 position).
                const parking = global.workspace_manager.append_new_workspace(false, this.core.currentTime());
                this.core._backgroundAppParkingWs = parking;
                this.core._backgroundAppParkingFront = false;
                this.core.debugLog(`background app: reserved trailing parking (index=${this.core.geometry.wsIndex(parking)})`);
            } else {
                this.core._backgroundAppParkingWs = first;
                this.core._backgroundAppParkingFront = true;
                this.core.debugLog('background app: reserved ws0 parking (index=0)');
            }
            // Keep the parking alive: the shell's dynamic-workspace check
            // removes empty inactive workspaces — the reservation must be
            // armed before the append below queues that check.
            Main.wm.keepWorkspaceAlive(this.core._backgroundAppParkingWs, 12 * 60 * 60 * 1000);
            this.startBackgroundAppKeepAlive();
            // append_new_workspace(true) activates before n-workspaces is emitted, so
            // append inert and activate after the shell rebuilds its card list.
            {
                if (global.workspace_manager.get_active_workspace() === this.core._backgroundAppParkingWs) {
                    global.workspace_manager.append_new_workspace(false, this.core.currentTime());
                    this.core.signals.addTimeout(150, () => {
                        if (!this.core._settings) return GLib.SOURCE_REMOVE;
                        {
                            const next = global.workspace_manager.get_workspace_by_index(1);
                            if (next) {
                                next.activate(this.core.currentTime());
                                // Keep the real workspace alive through the login
                                // restore window. Parking the BGAPP empties this
                                // workspace; without the keep-alive dynamic
                                // workspaces can drop it and leave the active
                                // workspace on the hidden parking slot, so the
                                // session-restored user windows land on ws0.
                                {
                                    Main.wm.keepWorkspaceAlive(next, 5 * 60 * 1000);
                                }
                            }
                            this.core.debugLog(`background app: active moved to index=${global.workspace_manager.get_active_workspace_index()}`);
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    this.core.debugLog(`background app: active already at index=${global.workspace_manager.get_active_workspace_index()}`);
                }
            }
            this.applyBackgroundAppHiding();
            this.core.workspacePill.scheduleWorkspacePillUpdate();
            // Controlled card removal: sweep shortly after the append/activate
            // settles, and re-sweep after any shell rebuild that re-adds the
            // parking card. No interception during rebuilds — no races.
            if (!this.core._backgroundAppNWorkspacesId) {
                this.core._backgroundAppNWorkspacesId =
                    this.connectObject(global.workspace_manager, 'notify::n-workspaces', () => {
                        if (!this.core._settings) return;
                        this.core.signals.addTimeout(50, () => {
                            if (!this.core._settings) return GLib.SOURCE_REMOVE;
                            this.hideParkingCard();
                            return GLib.SOURCE_REMOVE;
                        });
                    });
            }
            this.core.signals.addTimeout(100, () => {
                if (!this.core._settings) return GLib.SOURCE_REMOVE;
                this.hideParkingCard();
                return GLib.SOURCE_REMOVE;
            });
            // Login restore can map user windows several seconds after the
            // reservation. A few delayed passes catch anything that lands on the
            // parking before the per-window notify::workspace handler is armed.
            for (const delay of [500, 1500, 3000, 6000, 10000]) {
                this.core.signals.addTimeout(delay, () => {
                    if (!this.core._settings) return GLib.SOURCE_REMOVE;
                    this.evacuateParkingWorkspace();
                    return GLib.SOURCE_REMOVE;
                });
            }
        } catch (e) {
        this.core._backgroundAppParkingWs = null;
        this.core._backgroundAppReservationScheduled = false;
        this.core._backgroundAppParkingFront = false;
        this.core._backgroundAppKeepAliveId = 0;
        this.core._backgroundAppNWorkspacesId = 0;
            this.core.debugLog(`background app: reservation failed: ${e.message}`);
        }
    }

    hideParkingCard() {
        // Passive hide — no splice, no destroy. The shell's overview machinery
        // stays 100% native (index-aligned cards), so no races, no errors; the
        // parking card simply never renders. The row keeps its slots (a
        // leading blank) — the price of stability over surgical removal.
        const parkingWs = this.core._backgroundAppParkingWs;
        if (!parkingWs) return;
        try {
            // Never hide the card while it is the user's current workspace or
            // still holds a user window. The evacuation should make both cases
            // transient, but an invisible current workspace is worse than a
            // visible parking card.
            if (global.workspace_manager.get_active_workspace() === parkingWs) return;
            if (parkingWs.list_windows().some(w =>
                w !== this.core._backgroundAppWin && !this.matchesBackgroundApp(w)))
                return;
        } catch (_e) {
            return;
        }
        {
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
        }
    }

    startBackgroundAppKeepAlive() {
        if (this.core._backgroundAppKeepAliveId) return;
        const rekeep = () => {
            if (!this.core._settings) return GLib.SOURCE_REMOVE;
            if (this.core._backgroundAppParkingWs) {
                Main.wm.keepWorkspaceAlive(this.core._backgroundAppParkingWs, 12 * 60 * 60 * 1000);
            }
            return GLib.SOURCE_CONTINUE;
        };
        this.core._backgroundAppKeepAliveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60 * 60 * 1000, rekeep);
    }

    scheduleBackgroundAppRestart() {
        if (!this.core._settings) return;
        if (this.core._backgroundAppRestartId)
            GLib.source_remove(this.core._backgroundAppRestartId);
        this.core._backgroundAppRestartId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this.core._backgroundAppRestartId = 0;
            if (!this.core._settings) return GLib.SOURCE_REMOVE;
            this.clearBackgroundApp(false);
            this.launchBackgroundApp(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    isDynamicWorkspaces() {
        try {
            if (!this.core._mutterSettings) return false;
            return this.core._mutterSettings.get_boolean('dynamic-workspaces');
        } catch (_e) {
            return false;
        }
    }

    checkDynamicWorkspaces() {
        if (!this.core._settings || this.core._dynamicWsWarned) return;
        if (this.isDynamicWorkspaces()) return;
        this.core._dynamicWsWarned = true;
        this.core.workspaces.showWarningPopup('Dynamic Workspaces Required',
            "Plaid relies on GNOME's Dynamic Workspaces. Please enable it.",
            'Click to dismiss');
    }

    launchBackgroundApp(force = false) {
        if (!this.core._settings) return;
        if (!this.core._settings.get_boolean('background-app-enabled')) return;
        const command = this.core._settings.get_string('background-app');
        if (!command) return;
        // On unlock the shell re-enables us but the bg-app process survives, so adopt
        // the existing window (matched by the PLAID_BGAPP env marker) instead of
        // spawning a duplicate; a dead process leaves no window and respawns.
        this.core.debugLog(`launch check: lockCycle=${sessionState.lockCycle} command=${command}`);
        if (sessionState.lockCycle && this.adoptBackgroundAppWindow()) {
            this.core.debugLog('launch check: adopt pending or done');
            return;
        }
        this.core.debugLog('launch check: no surviving window to adopt');
        // On a settings-driven restart we just closed our own window, but its
        // async unmanage can still make _hasBackgroundAppWindow() true — that
        // silently skipped the new command ("existing window found"). `force`
        // (restart path) always spawns fresh; enable/lock-cycle still adopt.
        if (!force && this.hasBackgroundAppWindow()) {
            this.core.debugLog('background app: existing window found — adopting, skipping relaunch');
            return;
        }
        this.spawnBackgroundAppProcess(command);
    }

    spawnBackgroundAppProcess(command) {
        if (!this.isDynamicWorkspaces()) {
            this.core.debugLog('background app: dynamic workspaces required');
            this.core.workspaces.showPopup('Background App',
                'Requires dynamic workspaces (org.gnome.mutter dynamic-workspaces).');
            return;
        }
        this.core._backgroundAppPending = true;
        if (this.core._backgroundAppPendingId) GLib.source_remove(this.core._backgroundAppPendingId);
        this.core._backgroundAppPendingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30000, () => {
            this.core._backgroundAppPendingId = 0;
            this.core._backgroundAppPending = false;
            if (this.core._backgroundAppWaiter) {
                { this.core._backgroundAppWaiter.cleanup(false); }
            }
            return GLib.SOURCE_REMOVE;
        });
        // After a toggle/restart the reservation was cleared — reserve first so
        // the park never races a missing parking workspace.
        if (!this.core._backgroundAppParkingWs)
            this.scheduleBackgroundAppReservation();
        this.scheduleBackgroundAppReleaseWatch();
        this.core.debugLog(`background app: launching ${command}`);
        this.recordBackgroundAppHistory(command);
        try {
            this.core._backgroundAppProc = Gio.Subprocess.new(
                ['/bin/sh', '-c', `env PLAID_BGAPP=1 ${command}`],
                Gio.SubprocessFlags.NONE);
            // Watch for an early exit: a process that dies before its window is
            // ever claimed would otherwise leave Plaid waiting out the 30s
            // pending timer and give up (the "bgapp didn't autostart" report).
            // wait_async also reaps the child.
            {
                // GJS overrides this as wait_async(cancellable, callback) — the
                // C-style (io_priority, cancellable, callback) form is rejected
                // ("Too many arguments … expected 2"), which silently disarmed
                // the exit watch and disabled the respawn entirely.
                this.core._backgroundAppProc.wait_async(null, (p, res) => {
                    { p.wait_finish(res); }
                    this.onBackgroundAppProcExit(p);
                });
            }
        } catch (e) {
            this.core._backgroundAppPending = false;
            this.core._backgroundAppProc = null;
            this.core.debugLog(`background app: spawn failed: ${e.message}`);
        }
    }

    onBackgroundAppProcExit(proc) {
        // The spawned shell exited. Only respawn when it died BEFORE any window
        // was claimed and nothing else has already resolved the launch.
        if (!this.core._settings) return;
        if (proc !== this.core._backgroundAppProc) return; // superseded (restart/relaunch)
        if (!this.core._settings.get_boolean('background-app-enabled')) return;
        const command = this.core._settings.get_string('background-app');
        if (!command) return;
        if (this.core._backgroundAppWin) return; // was claimed — leave the state alone
        if (!this.core._backgroundAppPending) return; // claim/timeout already resolved
        if (this.core._backgroundAppSpawnRetries >= 2) {
            this.core.debugLog('background app: spawn retries exhausted');
            return;
        }
        this.core._backgroundAppSpawnRetries++;
        this.core.debugLog(`background app: process exited before claim — respawn ${this.core._backgroundAppSpawnRetries}/2`);
        this.spawnBackgroundAppProcess(command);
    }

    recordBackgroundAppHistory(command) {
        if (!this.core._settings || !command) return;
        {
            let history = this.core._settings.get_strv('background-app-history');
            history = history.filter((c) => c !== command);
            history.unshift(command);
            history = history.slice(0, 5);
            this.core._settings.set_strv('background-app-history', history);
        }
    }

    matchesBackgroundApp(win) {
        return this.isMarkerProcess(win, 'PLAID_BGAPP=1',
            this.core._settings.get_string('background-app') || '');
    }

    hasBackgroundAppWindow() {
        {
            for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
                const ws = global.workspace_manager.get_workspace_by_index(i);
                if (!ws) continue;
                for (const win of ws.list_windows()) {
                    // is_client_window() doesn't exist on 50/51; the marker match
                    // below is the reliable identity on its own.
                    if (win && this.matchesBackgroundApp(win))
                        return true;
                }
            }
        }
        return false;
    }

    adoptBackgroundAppWindow() {
        let win = this.findBackgroundAppWindow();
        if (win)
            return this.adoptFoundWindow(win);
        // The surviving window's identity can take a moment to settle after an unlock
        // re-map — retry a few times, and cancel once any path has claimed the window
        // so we never spawn a second instance.
        let attempt = 0;
        const command = this.core._settings.get_string('background-app');
        this.core.signals.addTimeout(500, () => {
            if (!this.core._settings) return GLib.SOURCE_REMOVE;
            if (this.core._backgroundAppWin) {
                this.core.debugLog('adopt: window already claimed elsewhere — cancelling retry');
                return GLib.SOURCE_REMOVE;
            }
            attempt++;
            this.core.debugLog(`adopt: retry ${attempt}`);
            const w = this.findBackgroundAppWindow();
            if (w) {
                if (this.adoptFoundWindow(w))
                    this.core.debugLog('background app: resumed surviving window (lock cycle, retry)');
                else
                    this.core.debugLog('adopt: retry found window but adoption failed');
                return GLib.SOURCE_REMOVE;
            }
            if (attempt >= 4) {
                if (this.core._backgroundAppWin || this.hasBackgroundAppWindow()) {
                    this.core.debugLog('adopt: surviving window present — skipping fresh spawn');
                    return GLib.SOURCE_REMOVE;
                }
                this.core.debugLog('adopt: no surviving window after retries — spawning fresh');
                this.spawnBackgroundAppProcess(command);
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        return true;
    }

    findBackgroundAppWindow() {
        // Pass 1: pid-based environ marker — the most reliable early signal
        // (independent of wm-class/GTK app id resolution timing).
        {
            for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
                const ws = global.workspace_manager.get_workspace_by_index(i);
                if (!ws) continue;
                for (const w of ws.list_windows()) {
                    let pid = 0;
                    { pid = w.get_pid(); }
                    if (pid > 0 && this.procEnvironHasMarker(pid, 'PLAID_BGAPP=1'))
                        return w;
                }
            }
        }
        // Pass 2: full match (marker + pid set + command token fallback).
        {
            for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
                const ws = global.workspace_manager.get_workspace_by_index(i);
                if (!ws) continue;
                for (const w of ws.list_windows()) {
                    if (w && this.matchesBackgroundApp(w))
                        return w;
                }
            }
        }
        {
            const seen = [];
            for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
                const ws = global.workspace_manager.get_workspace_by_index(i);
                if (!ws) continue;
                for (const w of ws.list_windows()) {
                    if (!w) continue;
                    let pid = 0;
                    { pid = w.get_pid(); }
                    seen.push(`${w.get_wm_class_instance() || '?'}/${w.get_title ? w.get_title() || '' : ''}:pid${pid}`);
                }
            }
            this.core.debugLog(`adopt: scan miss — windows: ${seen.join(', ') || 'none'}`);
        }
        return null;
    }

    adoptFoundWindow(win) {
        try {
            if (this.core._windowWorkspaces.has(win)) {
                this.core.debugLog('background app: de-registering window from tiler');
                this.core.windows.removeWindow(win);
            }
            this.core.masks.removeMask(win);
            this.core.blur.removeBlur(win);
            this.core.borders.removeBorder(win);
            this.core._backgroundAppWin = win;
            this.core._backgroundAppSpawnRetries = 0;
            this.core._backgroundAppUnmanagedId = this.connectObject(win, 'unmanaged', () => {
                this.core.debugLog(`background app: bg window unmanaged ${win.get_wm_class_instance() || '?'}`);
                if (this.core._backgroundAppWin === win)
                    this.core._backgroundAppWin = null;
            });
            this.configureBackgroundApp(win);
        } catch (e) {
            this.core.debugLog(`background app: adopt failed: ${e.message}`);
            return false;
        }
        this.core.debugLog(`adopt: found ${win.get_wm_class_instance() || '?'}`);
        this.core.debugLog('background app: resumed surviving window (lock cycle)');
        return true;
    }

    isMarkerProcess(win, marker, command) {
        if (!win) return false;
        let pid = 0;
        { pid = win.get_pid(); }
        if (pid > 0 && this.procEnvironHasMarker(pid, marker)) return true;
        if (pid > 0 && this.markerPidSetHas(marker, pid)) return true;
        // No command-token fallback here: a token like 'ghostty' matches every
        // ghostty window, not just the bg-app. The env marker is the reliable
        // identity — the bg-app is always spawned with it.
        return false;
    }

    isBgAppProcessWindow(win) {
        // Strict bg-app identity: the process env carries PLAID_BGAPP=1.
        // No class/token matching — user windows of the same app (ghostty)
        // must never be mistaken for the bg-app.
        if (!win) return false;
        let pid = 0;
        { pid = win.get_pid(); }
        if (pid > 0 && this.procEnvironHasMarker(pid, 'PLAID_BGAPP=1')) return true;
        return false;
    }

    isExtensionsAppWindow(win) {
        if (!win) return false;
        let pid = 0;
        { pid = win.get_pid(); }
        const isExtensionsCmd = (cmd) => !!cmd && (
            cmd.includes('org.gnome.Shell.Extensions') ||
            cmd.includes('org.gnome.Extensions') ||
            cmd.includes('gnome-extensions-app'));
        if (pid > 0) {
            const cached = this.core.procInfo.procCmdlineCached(pid);
            if (cached !== undefined) {
                if (isExtensionsCmd(cached)) return true;
            } else {
                this.core.procInfo.getProcCmdline(pid, (cmd) => {
                    if (!this.core._settings) return;
                    if (isExtensionsCmd(cmd) && !win._plaidProcIdentityNotified) {
                        win._plaidProcIdentityNotified = true;
                        this.core.signals.addIdle(() => { this.core.windows.onWindowIdentityChanged(win); return false; });
                    }
                });
            }
        }
        const wms = (win.get_wm_class_instance() || '').toLowerCase();
        if (wms === 'org.gnome.shell.extensions' || wms === 'org.gnome.extensions')
            return true;
        const appId = (win.get_gtk_application_id && win.get_gtk_application_id() || '').toLowerCase();
        if (appId === 'org.gnome.shell.extensions' || appId === 'org.gnome.extensions')
            return true;
        return false;
    }

    procEnvironHasMarker(pid, marker) {
        if (!pid) return false;
        const data = this.core.procInfo.procEnvironCached(pid);
        if (data !== undefined)
            return data.split('\0').includes(marker);
        this.core.procInfo.getProcEnviron(pid, (env) => {
            if (!this.core._settings) return;
            if (env.split('\0').includes(marker))
                this.recheckMarkerWaiters();
        });
        return false;
    }

    markerSweepAllowed() {
        if (!this.core._settings) return false;
        return this.core._settings.get_boolean('background-app-enabled') || !!this.core._dropdownPending;
    }

    recheckMarkerWaiters() {
        if (!this.core._settings) return;
        this.core.dropdown.recheckDropdownWaiters();
        this.recheckBackgroundAppAfterProc();
    }

    recheckBackgroundAppAfterProc() {
        if (!this.core._settings || this.core._bgAppRecheckPending) return;
        if (!this.core._settings.get_boolean('background-app-enabled')) return;
        const gen = this.core._markerSweepGen;
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this.core._bgAppRecheckId = 0;
            this.core._bgAppRecheckPending = false;
            if (!this.core._settings) return false;
            if (this.core._markerSweepGen !== gen) return false;
            if (!this.core._settings.get_boolean('background-app-enabled')) return false;
            const win = this.findBackgroundAppWindow();
            if (!win) return false;
            if (this.core._backgroundAppPending)
                this.tryClaimBackgroundApp(win);
            else if (!this.core._backgroundAppWin)
                this.adoptFoundWindow(win);
            return false;
        });
        if (id) {
            this.core._bgAppRecheckId = id;
            this.core._bgAppRecheckPending = true;
        }
    }

    markerPidSetHas(marker, pid) {
        // The /proc sweep is only needed while the bg-app is on and unclaimed
        // (spawn pending or lock-cycle adoption). Once claimed, skip it.
        if (!this.markerSweepAllowed()) return false;
        if (this.core._backgroundAppWin && !this.core._backgroundAppPending && !this.core._dropdownPending)
            return false;
        const now = Date.now();
        const cache = this.core._markerPidCache;
        if (!cache || cache.marker !== marker || now - cache.at > 1500)
            this.startMarkerPidSweep(marker);
        const current = this.core._markerPidCache;
        return !!current && current.marker === marker && current.set.has(pid);
    }

    startMarkerPidSweep(marker) {
        if (this.core._markerSweepPending) return;
        if (!this.markerSweepAllowed()) return;
        this.core._markerSweepPending = true;
        const gen = (this.core._markerSweepGen || 0) + 1;
        this.core._markerSweepGen = gen;
        const run = async () => {
            const set = new Set();
            {
                const dir = Gio.File.new_for_path('/proc');
                const children = dir.enumerate_children(
                    'standard::name', Gio.FileQueryInfoFlags.NONE, null);
                const pids = [];
                let info;
                while ((info = children.next_file(null))) {
                    const name = info.get_name();
                    if (/^\d+$/.test(name))
                        pids.push(parseInt(name, 10));
                }
                { children.close(null); }
                for (let start = 0; start < pids.length; start += 32) {
                    if (this.core._markerSweepGen !== gen) return;
                    const batch = pids.slice(start, start + 32);
                    const envs = await Promise.all(batch.map(pidN =>
                        this.core.procInfo.readProcFilePromise(`/proc/${pidN}/environ`)));
                    if (this.core._markerSweepGen !== gen) return;
                    for (let i = 0; i < batch.length; i++) {
                        if (!envs[i]) continue;
                        const env = new TextDecoder().decode(envs[i]);
                        if (!env.split('\0').includes(marker)) continue;
                        const status = await this.core.procInfo.readProcFilePromise(`/proc/${batch[i]}/status`);
                        if (!status) continue;
                        const m = new TextDecoder().decode(status).match(/^NSpid:\s+(.+)$/m);
                        if (!m) continue;
                        const vals = m[1].trim().split(/\s+/).map(Number);
                        const last = vals[vals.length - 1];
                        if (last > 0) set.add(last);
                    }
                }
            }
            if (this.core._markerSweepGen !== gen) return;
            this.core._markerSweepPending = false;
            if (!this.core._settings) return;
            if (!this.core._settings.get_boolean('background-app-enabled')) return;
            this.core._markerPidCache = { marker, at: Date.now(), set };
            if (set.size > 0)
                this.recheckMarkerWaiters();
        };
        run().catch(() => {
            if (this.core._markerSweepGen === gen)
                this.core._markerSweepPending = false;
        });
    }

    handleBackgroundAppWindowCreated(win) {
        if (!win || win.get_window_type() !== Meta.WindowType.NORMAL) return false;
        if (this.core._backgroundAppPending && this.tryClaimBackgroundApp(win)) return true;
        if (this.core._backgroundAppWin && this.core._backgroundAppWin !== win &&
            this.matchesBackgroundApp(win)) {
            this.core.debugLog('background app: closing stray matching window');
            { win.delete(this.core.currentTime()); }
        }
        if (this.core._backgroundAppWaiter && this.core._backgroundAppWaiter.win === win) return false;
        if (!this.core._backgroundAppPending) return false;
        this.core.debugLog('background app: window created, waiting for identity');
        const ids = [];
        const cleanup = (claimed) => {
            for (const id of ids) {
                win.disconnectObject(id);
            }
            ids.length = 0;
            if (this.core._backgroundAppWaiter && this.core._backgroundAppWaiter.win === win)
                this.core._backgroundAppWaiter = null;
        };
        const retry = () => {
            if (this.tryClaimBackgroundApp(win)) cleanup(true);
        };
        ids.push(this.connectObject(win, 'notify::wm-class', retry));
        ids.push(this.connectObject(win, 'notify::gtk-application-id', retry));
        ids.push(this.connectObject(win, 'unmanaged', () => cleanup(false)));
        this.core._backgroundAppWaiter = { win, cleanup };
        return false;
    }

    tryClaimBackgroundApp(win) {
        if (!this.core._backgroundAppPending || !win) return false;
        const instance = (win.get_wm_class_instance() || '').toLowerCase();
        const cls = (win.get_wm_class() || '').toLowerCase();
        if (!this.matchesBackgroundApp(win)) {
            this.core.debugLog(`background app: identity not yet matching (instance=${instance} class=${cls})`);
            return false;
        }
        if (this.core._backgroundAppPendingId) {
            GLib.source_remove(this.core._backgroundAppPendingId);
            this.core._backgroundAppPendingId = 0;
        }
        this.core._backgroundAppPending = false;
        this.core._backgroundAppSpawnRetries = 0;
        if (this.core._windowWorkspaces.has(win)) {
            this.core.debugLog('background app: de-registering window from tiler');
            this.core.windows.removeWindow(win);
        }
        this.core.masks.removeMask(win);
        this.core.blur.removeBlur(win);
        this.core.borders.removeBorder(win);
        this.core._backgroundAppWin = win;
        this.core._backgroundAppUnmanagedId = this.connectObject(win, 'unmanaged', () => {
            this.core.debugLog(`background app: bg window unmanaged ${win.get_wm_class_instance() || '?'}`);
            if (this.core._backgroundAppWin === win)
                this.core._backgroundAppWin = null;
        });
        this.configureBackgroundApp(win);
        {
            const f = win.get_frame_rect();
            this.core.debugLog(`background app: claimed ${instance || cls} frame=(${f.x},${f.y},${f.width},${f.height})`);
        }
        return true;
    }

    configureBackgroundApp(win) {
        { win.unstick(); }
        { win.unmake_above(); }
        // Clone path: park the window on the reserved parking workspace and
        // show a full-bleed clone in the background group — input-free by
        // construction, smooth (the parked window is never animated).
        this.core.debugLog('background app: clone mode (parked window + background clone)');
        const deferredPark = () => {
            if (!this.core._settings) return GLib.SOURCE_REMOVE;
            this.core.debugLog('background app: deferred park firing');
            if (win !== this.core._backgroundAppWin) {
                this.core.debugLog('background app: deferred park skipped (window no longer the bg app)');
                return GLib.SOURCE_REMOVE;
            }
            // Defer the park out of the login burst: the workspace mutation,
            // the maximize and the clone's first paint land in the settled
            // session. Each step is independent so a park failure can never
            // skip the clone.
            try {
                this.parkBackgroundAppOnWorkspace(win);
            } catch (e) {
                this.core.debugLog(`background app: park failed: ${e.message}`);
            }
            try {
                this.startBackgroundAppParkWatch(win);
            } catch (e) {
                this.core.debugLog(`background app: park watch failed: ${e.message}`);
            }
            try {
                this.ensureBackgroundAppClone(win);
            } catch (e) {
                this.core.debugLog(`background app: clone failed: ${e.message}`);
            }
            // Retry/heal the clone from here (post-park, so the clone is built
            // from the settled maximized source) until it is stable.
            this.startBackgroundAppCloneWatch(win);
            // Late re-raise: at login the shell's wallpaper actors settle
            // after the clone is created and can land above it in the
            // background group — re-insert on top once the startup is done.
            this.core.signals.addTimeout(10000, () => {
                if (!this.core._settings) return GLib.SOURCE_REMOVE;
                this.raiseBackgroundAppClone();
                this.core.debugLog('background app: clone re-raised after startup settle');
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        };
        // The window actor can be gone during the login burst; the 5s fallback
        // timer below still schedules the park.
        {
            const actor = win.get_compositor_private();
            if (actor) {
                this.core._backgroundAppFirstFrameId = this.connectObject(actor, 'first-frame', () => {
                    if (this.core._backgroundAppFirstFrameId) {
                        actor.disconnectObject(this.core._backgroundAppFirstFrameId);
                        this.core._backgroundAppFirstFrameId = 0;
                    }
                    this.core.debugLog('background app: first-frame fired, scheduling park in 3s');
                    this.core.signals.addTimeout(3000, deferredPark);
                });
            }
        }
        // Fallback: during the login burst the window can map and paint before
        // the claim's first-frame connect — the signal is then missed and the
        // pipeline would never run. This timer guarantees it regardless.
        this.core.signals.addTimeout(5000, deferredPark);
        this.core.signals.addTimeout(1000, () => {
            if (!this.core._settings) return GLib.SOURCE_REMOVE;
            if (win !== this.core._backgroundAppWin) return GLib.SOURCE_REMOVE;
            this.positionBackgroundAppClone();
            return GLib.SOURCE_REMOVE;
        });
    }

    startBackgroundAppParkWatch(win) {
        this.disconnectBackgroundAppParkWatch();
        if (!win) return;
        this.core._backgroundAppParkCount = 0;
        const pending = () => {
            if (this.core._backgroundAppParkCoalesceId) return;
            this.core._backgroundAppParkCoalesceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this.core._backgroundAppParkCoalesceId = 0;
                if (!this.core._settings) return GLib.SOURCE_REMOVE;
                if (this.core._backgroundAppParkCount >= 15) {
                    this.disconnectBackgroundAppParkWatch();
                    return GLib.SOURCE_REMOVE;
                }
                this.core._backgroundAppParkCount++;
                this.parkBackgroundAppOnWorkspace(win);
                // The clone computed its scale when the source was still 0x0;
                // re-allocate it so Clutter re-syncs the stretch to full-bleed.
                this.positionBackgroundAppClone();
                return GLib.SOURCE_REMOVE;
            });
        };
        const ids = [
            { emitter: win, id: this.connectObject(win, 'size-changed', pending) },
        ];
        this.core._backgroundAppParkIds = ids;
        this.core._backgroundAppParkWatchTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
            this.core._backgroundAppParkWatchTimeoutId = 0;
            this.disconnectBackgroundAppParkWatch();
            return GLib.SOURCE_REMOVE;
        });
    }

    disconnectBackgroundAppParkWatch() {
        if (this.core._backgroundAppParkWatchTimeoutId) {
            GLib.source_remove(this.core._backgroundAppParkWatchTimeoutId);
            this.core._backgroundAppParkWatchTimeoutId = 0;
        }
        if (this.core._backgroundAppParkCoalesceId) {
            GLib.source_remove(this.core._backgroundAppParkCoalesceId);
            this.core._backgroundAppParkCoalesceId = 0;
        }
        this.core._backgroundAppParkCount = 0;
        if (this.core._backgroundAppParkIds) {
            for (const { emitter, id } of this.core._backgroundAppParkIds) {
                emitter.disconnectObject(id);
            }
            this.core._backgroundAppParkIds = null;
        }
    }

    parkBackgroundAppOnWorkspace(win) {
        // The parked window renders live on the trailing workspace because
        // ghostty renders continuously; clients that render only on frame
        // callbacks may freeze here (native-Wayland research continues).
        if (!win) return;
        const ws = win.get_workspace() || global.workspace_manager.get_active_workspace();
        if (!ws) return;
        const monitor = global.display.get_primary_monitor();
        const mon = global.display.get_monitor_geometry(monitor);
        if (!mon || mon.width === 0) return;

        if (!this.core._backgroundAppParkingWs) {
            this.core.debugLog('background app: park deferred (no parking ws yet, scheduling reservation)');
            this.scheduleBackgroundAppReservation();
            // Retry until the reservation completes (bounded) — the window
            // must never be left unparked on the user's workspace.
            if (this.core._backgroundAppParkRetryCount < 6) {
                this.core._backgroundAppParkRetryCount++;
                if (this.core._backgroundAppParkRetryId)
                    GLib.source_remove(this.core._backgroundAppParkRetryId);
                this.core._backgroundAppParkRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                        this.core._backgroundAppParkRetryId = 0;
                        if (!this.core._settings) return GLib.SOURCE_REMOVE;
                        if (this.core._backgroundAppWin)
                            this.parkBackgroundAppOnWorkspace(this.core._backgroundAppWin);
                        return GLib.SOURCE_REMOVE;
                    });
            }
            return;
        }
        this.core._backgroundAppParkRetryCount = 0;
        const beforeIdx = this.core.geometry.wsIndex(ws);
        const targetIdx = this.core.geometry.wsIndex(this.core._backgroundAppParkingWs);
        // Already parked on the parking workspace and maximized — skip the
        // maximize/move_resize churn. Comparing against the monitor geometry never
        // matched (a maximized window fills the work area, below the top bar), so
        // this used to run on every workspace change and feed a switch loop.
        if (beforeIdx >= 0 && beforeIdx === targetIdx) {
            let parked = false;
            { parked = win.maximized_horz && win.maximized_vert; }
            if (parked) return;
        }
        try {
            if (win.get_workspace() !== this.core._backgroundAppParkingWs)
                win.change_workspace(this.core._backgroundAppParkingWs);
        } catch (e) {
            this.core.debugLog(`background app: park change_workspace failed: ${e.message}`);
        }
        try {
            // Maximize for a sharp full-size clone source — mutter-enforced,
            // clients cannot refuse it (native Wayland clients may ignore
            // plain move_resize configures). The GIR signature takes no args.
            win.maximize();
        } catch (e) {
            this.core.debugLog(`background app: park maximize failed: ${e.message}`);
        }
        try {
            win.move_resize_frame(true, mon.x, mon.y, mon.width, mon.height);
        } catch (e) {
            this.core.debugLog(`background app: park resize failed: ${e.message}`);
        }
        const f = win.get_frame_rect();
        this.core.debugLog(`background app: parked ws=${beforeIdx}->${targetIdx} frame=(${f.x},${f.y},${f.width},${f.height})`);
    }

    applyBackgroundAppHiding() {
        if (this.core._backgroundAppHiding || !this.core._backgroundAppParkingWs) return;
        const self = this;
        const origGetNeighbor = Meta.Workspace.prototype.get_neighbor;
        const wrappedGetNeighbor = function (direction) {
            // Skip the hidden parking workspace and WRAP at the ends. Returning
            // null at the last workspace made the shell append a workspace when
            // dynamic workspaces are on — which fed a BGAPP parking/switch churn
            // loop and meant the switch never wrapped back to workspace 1.
            // The shell calls get_neighbor() with Meta.MotionDirection values
            // (LEFT=-3 / RIGHT=-4), while other callers use Meta.DisplayDirection
            // (LEFT=2 / RIGHT=3). Accept BOTH — guarding on one enum only made this
            // hook hand the call back to the original and silently skip the wrap.
            const leftDirs = [Meta.MotionDirection.LEFT];
            const rightDirs = [Meta.MotionDirection.RIGHT];
            if (Meta.DisplayDirection) {
                leftDirs.push(Meta.DisplayDirection.LEFT);
                rightDirs.push(Meta.DisplayDirection.RIGHT);
            }
            if (!leftDirs.includes(direction) && !rightDirs.includes(direction))
                return origGetNeighbor.call(this, direction);
            const wm = global.workspace_manager;
            const n = wm.get_n_workspaces();
            // Resolve the parking slot by IDENTITY, with its known front/trailing
            // home as a fallback. A stale Meta.Workspace must never let the hidden
            // parking back into the cycle — it renders as a second "Workspace 1".
            let parkingIdx = -1;
            const parking = self._backgroundAppParkingWs;
            if (parking) {
                for (let i = 0; i < n; i++) {
                    if (wm.get_workspace_by_index(i) === parking) {
                        parkingIdx = i;
                        break;
                    }
                }
            }
            if (parkingIdx < 0 && (parking || self._backgroundAppParkingFront))
                parkingIdx = self._backgroundAppParkingFront ? 0 : Math.max(0, n - 2);
            const real = [];
            for (let i = 0; i < n; i++) {
                if (i === parkingIdx) continue;
                const ws = wm.get_workspace_by_index(i);
                if (ws) real.push(ws);
            }
            const idx = real.indexOf(this);
            if (idx < 0)
                return origGetNeighbor.call(this, direction);
            // A single real workspace has nowhere to wrap to; deny the move so the
            // shell does not append one (which would fight the reservation).
            if (real.length < 2)
                return this;
            const step = leftDirs.includes(direction) ? -1 : 1;
            return real[(idx + step + real.length) % real.length];
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
            try {
                if (global.workspace_manager.get_active_workspace() === parkingWs) return;
                if (parkingWs.list_windows().some(w =>
                    w !== self._backgroundAppWin && !self._matchesBackgroundApp(w)))
                    return;
            } catch (_e) {
                return;
            }
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
            try {
                if (global.workspace_manager.get_active_workspace() === parkingWs) return;
                if (parkingWs.list_windows().some(w =>
                    w !== self._backgroundAppWin && !self._matchesBackgroundApp(w)))
                    return;
            } catch (_e) {
                return;
            }
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
            {
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
            }
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
            this.core.debugLog(`background app: keybind remap failed: ${e.message}`);
        }
        this.core._backgroundAppHiding = {
            origGetNeighbor, wrappedGetNeighbor,
            origUpdateVisibility, wrappedUpdateVisibility,
            origRedisplay, wrappedRedisplay,
            origAddThumbnails, wrappedAddThumbnails,
            remapBindings, origSwitcher,
        };
        // Hide the pre-existing parking thumbnail (the addThumbnails wrap
        // covers future ones).
        {
            const controls = Main.overview._overview.controls;
            const parkingWs = this.core._backgroundAppParkingWs;
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
        }
        this.core.debugLog('background app: hiding parking workspace from overview, switcher, cycling');
    }

    restoreBackgroundAppHiding() {
        const h = this.core._backgroundAppHiding;
        if (!h) return;
        {
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
                {
                    const pass = (display, window, event, binding) =>
                        h.origSwitcher.call(Main.wm, display, window, event, binding);
                    const modes = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
                    for (const name of h.remapBindings)
                        Main.wm.setCustomKeybindingHandler(name, modes, pass);
                }
            }
        }
        this.core._backgroundAppHiding = null;
    }

    raiseBackgroundAppClone() {
        const clone = this.core._backgroundAppClone;
        if (!clone) return;
        const bg = Main.layoutManager._backgroundGroup;
        if (!bg) return;
        {
            if (clone.get_parent() !== bg) {
                // Self-heal an orphaned clone (background-group churn): re-attach it
                // to the current background group and re-stretch, or the background
                // stays invisible until a manual bg-app toggle.
                this.core.debugLog('background app: clone orphaned — re-parenting to background group');
                const parent = clone.get_parent();
                if (parent) parent.remove_child(clone);
                bg.add_child(clone);
                this.positionBackgroundAppClone();
            }
            bg.set_child_above_sibling(clone, null);
        }
    }

    evacuateParkingWorkspace() {
        if (!this.core._settings) return;
        const parking = this.core._backgroundAppParkingWs;
        if (!parking) return;
        const wm = global.workspace_manager;
        let users = [];
        try {
            users = parking.list_windows().filter(w =>
                w !== this.core._backgroundAppWin && !this.matchesBackgroundApp(w));
        } catch (_e) {
            return;
        }
        const active = wm.get_active_workspace();
        if (users.length === 0 && active !== parking) return;
        let target = null;
        let n = 0;
        try { n = wm.get_n_workspaces(); } catch (_e) { return; }
        for (let i = 0; i < n; i++) {
            const ws = wm.get_workspace_by_index(i);
            if (ws && ws !== parking) { target = ws; break; }
        }
        if (!target) {
            { target = wm.append_new_workspace(false, this.core.currentTime()); }
            if (!target) return;
            this.core.debugLog('background app: evacuation appended a real workspace');
        }
        for (const win of users) {
            {
                if (win.get_workspace() === parking)
                    win.change_workspace(target);
            }
        }
        if (active === parking) {
            { target.activate(this.core.currentTime()); }
        }
        if (users.length > 0)
            this.core.debugLog(`background app: evacuated ${users.length} window(s) from parking to ws=${this.core.geometry.wsIndex(target)}`);
        this.core.workspacePill.scheduleWorkspacePillUpdate();
    }

    scheduleBackgroundAppParkingFix() {
        if (!this.core._settings || !this.core._backgroundAppWin) return;
        if (this.core._backgroundAppParkingFixId) return;
        this.core._backgroundAppParkingFixId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this.core._backgroundAppParkingFixId = 0;
            if (!this.core._settings) return GLib.SOURCE_REMOVE;
            this.evacuateParkingWorkspace();
            this.reassertBackgroundAppParking();
            return GLib.SOURCE_REMOVE;
        });
    }

    reassertBackgroundAppParking() {
        if (!this.core._settings || !this.core._backgroundAppWin) return;
        if (!this.core._backgroundAppParkingWs) {
            this.parkBackgroundAppOnWorkspace(this.core._backgroundAppWin);
            return;
        }
        const n = global.workspace_manager.get_n_workspaces();
        // Find the parking workspace by IDENTITY rather than ws.index(): indexing
        // a workspace that dynamic-workspaces destroyed logs mutter's
        // `meta_workspace_index: assertion 'ret >= 0' failed` on every switch.
        let parkingIdx = -1;
        for (let i = 0; i < n; i++) {
            if (global.workspace_manager.get_workspace_by_index(i) === this.core._backgroundAppParkingWs) {
                parkingIdx = i;
                break;
            }
        }
        if (parkingIdx < 0) {
            // Stale reservation — drop it and re-reserve instead of re-parking
            // against a dead workspace.
            this.core.debugLog('background app: parking workspace is stale — re-reserving');
            this.core._backgroundAppParkingWs = null;
            this.core._backgroundAppParkingFront = false;
            this.scheduleBackgroundAppReservation();
            return;
        }
        // Stable homes: the front (ws0 — the normal reservation) or the
        // trailing n-2 (rare fallback). Nothing reorders them; if the parking
        // ever ends up elsewhere, relocate with the old append-and-move logic.
        if (parkingIdx !== 0 && parkingIdx !== n - 2) {
            const now = Date.now();
            if (now - (this.core._backgroundAppParkingLastRelocate || 0) < 1000)
                return;
            this.core._backgroundAppParkingLastRelocate = now;
            this.core._backgroundAppParkingWs =
                global.workspace_manager.append_new_workspace(false, this.core.currentTime());
            this.core.debugLog(`background app: parking relocated to ws=${this.core.geometry.wsIndex(this.core._backgroundAppParkingWs)}`);
            {
                if (this.core._backgroundAppWin.get_workspace() !== this.core._backgroundAppParkingWs)
                    this.core._backgroundAppWin.change_workspace(this.core._backgroundAppParkingWs);
            }
        }
        // Route through the logged park so every re-park is journal-visible.
        try {
            this.parkBackgroundAppOnWorkspace(this.core._backgroundAppWin);
        } catch (e) {
            this.core.debugLog(`background app: reassert park failed: ${e.message}`);
        }
    }

    ensureBackgroundAppClone(win) {
        if (!win) return;
        if (!this.core._backgroundAppClone) {
            const actor = win.get_compositor_private();
            if (!actor) {
                this.core.debugLog('background app: clone skipped (no compositor actor)');
                return;
            }
            const bg = Main.layoutManager._backgroundGroup;
            if (!bg) {
                this.core.debugLog('background app: clone skipped (no background group)');
                return;
            }
            try {
                this.core._backgroundAppClone = new Clutter.Clone({ source: actor });
                bg.add_child(this.core._backgroundAppClone);
                if (!this.core._backgroundAppGroupAddedId) {
                    this.core._backgroundAppGroupAddedId = this.connectObject(bg, 'child-added', () => {
                        this.raiseBackgroundAppClone();
                    });
                }
                this.core.debugLog('background app: clone created');
            } catch (e) {
                this.core.debugLog(`background app clone failed: ${e.message}`);
                this.core._backgroundAppClone = null;
                return;
            }
        }
        this.positionBackgroundAppClone();
    }

    startBackgroundAppCloneWatch(win) {
        // Post-login clone watchdog: the clone is built into the background group
        // during the login burst (group may not exist yet, actor may be replaced,
        // later churn can orphan it), and a lost clone leaves the background absent
        // for the session. Bounded: stops after two stable ticks or ~20s.
        if (this.core._backgroundAppCloneWatchId) {
            GLib.source_remove(this.core._backgroundAppCloneWatchId);
            this.core._backgroundAppCloneWatchId = 0;
        }
        if (!win) return;
        let ticks = 0;
        let good = 0;
        this.core._backgroundAppCloneWatchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            if (!this.core._settings || win !== this.core._backgroundAppWin) {
                this.core._backgroundAppCloneWatchId = 0;
                return GLib.SOURCE_REMOVE;
            }
            ticks++;
            if (!this.core._backgroundAppClone) {
                this.ensureBackgroundAppClone(win);
            } else {
                const srcActor = win.get_compositor_private();
                if (srcActor && this.core._backgroundAppClone.get_source() !== srcActor) {
                    // The window actor can be replaced (surface round-trips):
                    // the clone would keep painting the dead source (blank).
                    this.core.debugLog('background app: clone source actor replaced — recreating clone');
                    this.core._backgroundAppClone.destroy();
                    this.core._backgroundAppClone = null;
                    this.ensureBackgroundAppClone(win);
                }
            }
            this.raiseBackgroundAppClone();
            const bg = Main.layoutManager._backgroundGroup;
            const c = this.core._backgroundAppClone;
            const src = c ? c.get_source() : null;
            if (c && bg && c.get_parent() === bg && src && src.width > 0 && src.height > 0)
                good++;
            else
                good = 0;
            if (good >= 2) {
                this.core._backgroundAppCloneWatchId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (ticks >= 20) {
                const srcNow = c ? c.get_source() : null;
                this.core.debugLog(`background app: clone watchdog gave up clone=${!!c} ` +
                    `parent=${!!(c && c.get_parent() === bg)} ` +
                    `source=${srcNow ? `${Math.round(srcNow.width)}x${Math.round(srcNow.height)}` : 'none'}`);
                this.core._backgroundAppCloneWatchId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    positionBackgroundAppClone() {
        const clone = this.core._backgroundAppClone;
        if (!clone) {
            this.core.debugLog('background app: clone position skipped (no clone)');
            return;
        }
        const monitor = global.display.get_primary_monitor();
        const mon = global.display.get_monitor_geometry(monitor);
        if (!mon || mon.width === 0) {
            this.core.debugLog('background app: clone position skipped (monitor geometry unavailable)');
            return;
        }
        try {
            clone.set_position(mon.x, mon.y);
            clone.set_size(mon.width, mon.height);
            // The same-size set_size is a no-op, so the clone never re-runs
            // clutter_clone_allocate and its internal scale stays 1.0 (computed
            // when the source was 0x0). Nudge the size to force a real
            // re-allocation that recomputes the stretch from the settled source.
            {
                clone.queue_relayout();
                clone.set_size(mon.width + 1, mon.height + 1);
                clone.set_size(mon.width, mon.height);
            }
            const src = clone.get_source();
            this.core.debugLog(`background app: clone at (${mon.x},${mon.y},${mon.width},${mon.height}) ` +
                `source=${src ? `${Math.round(src.width)}x${Math.round(src.height)}` : 'none'}`);
        } catch (e) {
            this.core.debugLog(`background app: clone position failed: ${e.message}`);
        }
    }

    refillBackgroundApp() {
        if (!this.core._backgroundAppWin) return;
        this.parkBackgroundAppOnWorkspace(this.core._backgroundAppWin);
        this.positionBackgroundAppClone();
    }

    restoreFocusFromBackgroundApp() {
        if (!this.core._settings || !this.core._backgroundAppWin) return;
        const ws = global.workspace_manager.get_active_workspace();
        if (!ws || ws === this.core._backgroundAppParkingWs) return;
        // NEVER restore focus across workspaces: activating a window on another
        // workspace switches to it, which re-runs the parking fix and starts a
        // focus/switch feedback loop (the user saw workspace 3<->4 churn).
        let prev = this.core._lastRealFocusedWindow;
        if (!prev || prev === this.core._backgroundAppWin || !prev.get_compositor_private() ||
            prev.get_workspace() !== ws)
            prev = this.core._lastFocusedPerWorkspace.get(ws);
        if (!prev || prev === this.core._backgroundAppWin || !prev.get_compositor_private() ||
            prev.get_workspace() !== ws)
            return;
        this.core.debugLog('background app: stealing focus back');
        this.core.signals.addIdle(() => {
            if (!this.core._settings) return false;
            if (global.display.focus_window === prev) return false;
            // The workspace may have moved while the idle was queued.
            if (prev.get_workspace() !== global.workspace_manager.get_active_workspace()) return false;
            { prev.activate(this.core.currentTime()); }
            return false;
        });
    }

    clearBackgroundApp(releaseReservation = true) {
        this.core._markerSweepGen = (this.core._markerSweepGen || 0) + 1;
        this.core._markerSweepPending = false;
        this.core._bgAppRecheckPending = false;
        this.core._markerPidCache = null;
        if (this.core._bgAppRecheckId) {
            {
                if (GLib.MainContext.default().find_source_by_id(this.core._bgAppRecheckId))
                    GLib.source_remove(this.core._bgAppRecheckId);
            }
            this.core.signals.untrackSource(this.core._bgAppRecheckId);
            this.core._bgAppRecheckId = 0;
        }
        if (this.core._backgroundAppReleaseId) {
            GLib.source_remove(this.core._backgroundAppReleaseId);
            this.core._backgroundAppReleaseId = 0;
        }
        if (this.core._backgroundAppRestartId) {
            GLib.source_remove(this.core._backgroundAppRestartId);
            this.core._backgroundAppRestartId = 0;
        }
        if (this.core._backgroundAppPendingId) {
            GLib.source_remove(this.core._backgroundAppPendingId);
            this.core._backgroundAppPendingId = 0;
        }
        this.core._backgroundAppPending = false;
        this.core._backgroundAppSpawnRetries = 0;
        this.disconnectBackgroundAppParkWatch();
        if (this.core._backgroundAppCloneWatchId) {
            GLib.source_remove(this.core._backgroundAppCloneWatchId);
            this.core._backgroundAppCloneWatchId = 0;
        }
        // A soft teardown (feature toggled off / command changed while Plaid
        // stays enabled) keeps the reserved parking workspace, its hiding
        // wraps, and the n-workspaces re-hide hook — only a full release
        // (extension disable) tears them down.
        if (releaseReservation && this.core._backgroundAppNWorkspacesId) {
            global.workspace_manager.disconnectObject(this.core._backgroundAppNWorkspacesId);
            this.core._backgroundAppNWorkspacesId = 0;
        }
        if (this.core._backgroundAppParkRetryId) {
            GLib.source_remove(this.core._backgroundAppParkRetryId);
            this.core._backgroundAppParkRetryId = 0;
        }
        this.core._backgroundAppParkRetryCount = 0;
        // Keep the hourly keep-alive re-arm while the reservation is kept, or
        // the shell's 12h keep-alive could lapse and sweep the empty parking.
        if (releaseReservation && this.core._backgroundAppKeepAliveId) {
            GLib.source_remove(this.core._backgroundAppKeepAliveId);
            this.core._backgroundAppKeepAliveId = 0;
        }
        if (this.core._backgroundAppParkingFixId) {
            GLib.source_remove(this.core._backgroundAppParkingFixId);
            this.core._backgroundAppParkingFixId = 0;
        }
        if (this.core._backgroundAppClone) {
            this.core._backgroundAppClone.destroy();
            this.core._backgroundAppClone = null;
        }
        if (this.core._backgroundAppGroupAddedId) {
            const bg = Main.layoutManager._backgroundGroup;
            if (bg) bg.disconnectObject(this.core._backgroundAppGroupAddedId);
            this.core._backgroundAppGroupAddedId = 0;
        }
        if (this.core._backgroundAppWaiter) {
            const waiter = this.core._backgroundAppWaiter;
            this.core._backgroundAppWaiter = null;
            { waiter.cleanup(false); }
            if (!sessionState.lockCycle) {
                this.core.debugLog(`bg teardown: closing waiter window (lockCycle=${sessionState.lockCycle})`);
                this.closeBackgroundAppWindow(waiter.win);
            } else {
                this.core.debugLog('bg teardown: keeping waiter window alive (lock cycle)');
            }
        }
        const win = this.core._backgroundAppWin;
        this.core.debugLog(`bg teardown: win=${win ? win.get_wm_class_instance() || '?' : 'null'} ` +
            `waiter=${!!this.core._backgroundAppWaiter} lockCycle=${sessionState.lockCycle}`);
        if (this.core._backgroundAppUnmanagedId) {
            if (win) {
                win.disconnectObject(this.core._backgroundAppUnmanagedId);
            }
            this.core._backgroundAppUnmanagedId = 0;
        }
        if (this.core._backgroundAppFirstFrameId && win) {
            // A destroyed window actor cannot be disconnected; teardown continues.
            {
                const actor = win.get_compositor_private();
                if (actor) actor.disconnectObject(this.core._backgroundAppFirstFrameId);
            }
            this.core._backgroundAppFirstFrameId = 0;
        }
        if (win && !sessionState.lockCycle) {
            this.core.debugLog(`bg teardown: closing main window (lockCycle=${sessionState.lockCycle})`);
            this.closeBackgroundAppWindow(win);
        } else if (win) {
            this.core.debugLog('bg teardown: keeping main window alive (lock cycle)');
        }
        this.core._backgroundAppWin = null;
        this.core._backgroundAppProc = null;
        // A lock cycle re-enables us right after unlocking: keep the bg-app process,
        // its hiding state, and the parking workspace so we adopt the surviving window.
        // A soft teardown (releaseReservation=false) also keeps the parking reserved
        // and hidden — releasing it would expose an empty workspace and shift the
        // index-keyed layout rules.
        if (!sessionState.lockCycle && releaseReservation) {
            this.restoreBackgroundAppHiding();
            {
                // The front-reserved ws0 is the shell's own first workspace — never
                // remove it (only the appended trailing fallback parking is
                // removable). The reservation survives restarts and toggles.
                if (!this.core._backgroundAppParkingFront &&
                    this.core._backgroundAppParkingWs &&
                    this.core._backgroundAppParkingWs.list_windows().length === 0)
                    global.workspace_manager.remove_workspace(this.core._backgroundAppParkingWs, this.core.currentTime());
            }
        }
        if (releaseReservation) {
            this.core._backgroundAppParkingWs = null;
            this.core._backgroundAppParkingFront = false;
        }
    }

    closeBackgroundAppWindow(win) {
        if (!win) return;
        this.core.debugLog(`background app: closing bg window ${win.get_wm_class_instance() || '?'}`);
        { win.delete(this.core.currentTime()); }
        const proc = this.core._backgroundAppProc;
        if (proc) {
            this.core.debugLog('background app: bg process force_exit scheduled');
            this.core.signals.addTimeout(1000, () => {
                { proc.force_exit(); }
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    destroy() {
        this.clearBackgroundApp(true);
        if (this.core._backgroundAppSettingsChangedId) {
            this.core._settings.disconnectObject(this.core._backgroundAppSettingsChangedId);
            this.core._backgroundAppSettingsChangedId = 0;
        }
        if (this.core._backgroundAppEnabledChangedId) {
            this.core._settings.disconnectObject(this.core._backgroundAppEnabledChangedId);
            this.core._backgroundAppEnabledChangedId = 0;
        }
        this.core._mutterSettings = null;
            super.destroy();
}
}
