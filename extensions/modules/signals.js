// Signals, GLib sources, and scheduling.
//
// Every signal and source the extension creates is registered here so the
// lifecycle has one reviewable teardown path. Methods are attached to
// TilingWMExtension.prototype by bootstrap.js.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { bumpMonitorDims } from './blur.js';

export function _connectSignals() {
    // The shell emits this at the very start of shutdown. A retile that
    // was queued by an unmanaged window can otherwise fire after this
    // point and start a 16ms animation against windows/actors that are
    // already being torn down — the main loop then stalls until systemd
    // SIGKILLs the shell (observed: 5s stop-sigterm timeout on logout).
    this._addSignal(global, global.connect('shutdown', () => {
        if (this._settings) this._onShellShutdown();
    }));
    // Display close fires BEFORE meta_display_unmanage_windows(), i.e.
    // before _removeWindow() can queue a retile. global::shutdown is too
    // late: the 50ms retile timeout can win the race and start animating
    // windows that are already being disposed (observed logout stall).
    this._addSignal(global.display, global.display.connect('closing', () => {
        if (this._settings) this._onShellShutdown();
    }));
    // Detect a system shortcut that already owns one of our combos. The
    // other binding stays in control; we just tell the user why Plaid did
    // not run (see _onAcceleratorActivated / _showKeybindConflict).
    this._addSignal(global.display, global.display.connect('accelerator-activated', (_d, actionId) => {
        this._onAcceleratorActivated(actionId);
    }));
    // A GNOME-side shortcut edit (Settings, gsettings, another extension)
    // changes who owns a combo. Re-grab our keys so the old grab cannot
    // shadow the new owner and the conflict maps stay current.
    for (const schemaId of [
        'org.gnome.desktop.wm.keybindings',
        'org.gnome.mutter.keybindings',
        'org.gnome.mutter.wayland.keybindings',
        'org.gnome.shell.keybindings',
    ]) {
        const s = new Gio.Settings({ schema_id: schemaId });
        this._addSignal(s, s.connect('changed', () => this._scheduleConflictScan()));
    }
    this._addSignal(global.display, global.display.connect('window-created', (_d, win) => {
        if (this._handleDropdownWindowCreated(win)) return;
        if (this._handleBackgroundAppWindowCreated(win)) return;
        if (this._shouldManage(win)) {
            this._addWindow(win);
            const doRetile = () => {
                if (!this._settings) return;
                const ws = win.get_workspace();
                if (ws) this._retileWorkspace(ws);
            };
            const actor = win.get_compositor_private();
            if (actor) {
                const firstFrameId = actor.connect('first-frame', () => {
                    actor.disconnect(firstFrameId);
                    this._markPendingWindowInvisible(win, actor);
                    doRetile();
                });
            } else {
                this._addIdle(() => {
                    this._markPendingWindowInvisible(win, win.get_compositor_private());
                    doRetile();
                    return false;
                });
            }
        } else if (this._isFloating(win)) {
            const doRestore = () => {
                if (!this._settings) return;
                this._restoreFloatNaturalRect(win);
            };
            const actor = win.get_compositor_private();
            if (actor) {
                const firstFrameId = actor.connect('first-frame', () => {
                    actor.disconnect(firstFrameId);
                    if (!this._settings) return;
                    doRestore();
                    if (this._settings.get_boolean('follow-focus') &&
                        win.get_window_type() === Meta.WindowType.NORMAL)
                        this._cursorWarpDeferred(win);
                    this._connectFloatHooks(win);
                    this._updateBorders();
                });
            } else {
                this._addIdle(() => {
                    if (!this._settings) return false;
                    doRestore();
                    if (this._settings.get_boolean('follow-focus') &&
                        win.get_window_type() === Meta.WindowType.NORMAL)
                        this._cursorWarpDeferred(win);
                    this._connectFloatHooks(win);
                    this._updateBorders();
                    return false;
                });
            }
        }
    }));
    this._addSignal(global.display, global.display.connect('notify::focus-window', () => {
        this._updateBorders();
        const win = global.display.focus_window;
        if (win) {
            if (win !== this._backgroundAppWin) {
                const ws = win.get_workspace();
                // Never remember a window on the hidden parking workspace
                // as a focus-restore target (activating it would switch
                // the user onto the reserved slot).
                if (ws && ws !== this._backgroundAppParkingWs) {
                    this._lastRealFocusedWindow = win;
                    this._lastFocusedPerWorkspace.set(ws, win);
                }
            }
        }
        if (this._backgroundAppWin && win === this._backgroundAppWin) {
            this._debugLog('background app: focus landed on bg window');
            this._restoreFocusFromBackgroundApp();
        }
        if (this._settings.get_boolean('follow-focus') && this._keyboardFocusChange) {
            this._keyboardFocusChange = false;
            if (win) this._moveCursorToWindow(win);
        }
    }));
    this._addSignal(Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => {
        bumpMonitorDims();
        this._updateDropOverlaySize();
        this._refillBackgroundApp();
        this._retileAll();
        const mon = global.display.get_monitor_geometry(global.display.get_primary_monitor());
        if (mon) this._lastMonitorsGeom = mon;
        this._debugLog('monitors-changed handled');
    }));
    if (this._mutterSettings) {
        this._addSignal(this._mutterSettings, this._mutterSettings.connect(
            'changed::dynamic-workspaces', () => this._checkDynamicWorkspaces()));
    }
    this._addSignal(global.workspace_manager, global.workspace_manager.connect('workspace-added', (_m, index) => {
        const ws = global.workspace_manager.get_workspace_by_index(index);
        this._workspaceOrders.set(ws, []);
        this._scheduleBackgroundAppParkingFix();
    }));
    this._addSignal(global.workspace_manager, global.workspace_manager.connect('workspace-removed', () => {
        this._scheduleBackgroundAppParkingFix();
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
                this._masterRatios.delete(this._wsIndex(workspace));
                this._stackRatios.delete(this._wsIndex(workspace));
                this._bspTrees.delete(workspace);
                this._workspaceLayouts.delete(this._wsIndex(workspace));
                this._lastFocusedPerWorkspace.delete(workspace);
                // Workspace-keyed, workspace-object key — a retained
                // GJS wrapper per removed workspace otherwise.
                this._lastRetileTimes.delete(workspace);
                // The workspace-object-keyed maps missed here: a
                // retained wrapper + a pending retile timeout that
                // later fires against a dead workspace.
                this._dwindleLeafSigs.delete(workspace);
                this._queuedAnimWorkspaces.delete(workspace);
                if (this._pendingRetileIds.has(workspace)) {
                    GLib.source_remove(this._pendingRetileIds.get(workspace));
                    this._pendingRetileIds.delete(workspace);
                }
                this._scheduleSaveLayouts();
            }
        }
    }));
    this._addSignal(global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', () => {
        this._scheduleDropdownWorkspaceSync();
        this._raiseBackgroundAppClone();
        this._addIdle(() => {
            if (!this._settings) return false;
            this._raiseBackgroundAppClone();
            return false;
        });
        this._addTimeout(150, () => {
            if (!this._settings) return GLib.SOURCE_REMOVE;
            this._raiseBackgroundAppClone();
            return GLib.SOURCE_REMOVE;
        });
    }));
    this._addSignal(global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', () => {
        if (!this._settings || !this._settings.get_boolean('enabled')) return;
        const ws = global.workspace_manager.get_active_workspace();
        if (!ws) return;
        if (ws === this._backgroundAppParkingWs) {
            // Reaching the hidden slot means something switched onto the
            // reservation. Move any user windows back to a real workspace
            // and leave the parking before the session restore places new
            // windows there.
            this._debugLog('workspace: active workspace is the hidden parking slot');
            this._evacuateParkingWorkspace();
            return;
        }
        if (this._settings.get_boolean('workspace-popup'))
            this._showWorkspacePopup(ws);
        // Re-assert float layering + refresh Flair after the switch
        // settles (the restacked signal can fire before the reveal
        // ordering is final).
        this._reassertFloatingTransients();
        this._updateBorders();
        this._checkWorkspaceLandings(ws);
        // Post-switch settle POLL: XWayland windows commit their surface AFTER
        // the switch choreography — their visibility flip and the reveal
        // sink happen with no further `restacked`, so the blur glue +
        // visibility sync + float raise never re-run: the float stays
        // sunk with a stale blur sibling painting over the stack until
        // focus forces a restack. A fixed delayed pass made the wrong
        // state visible for the whole delay (janky 300ms snap), so poll
        // instead: every 50ms for 1.5s re-run the cheap pair (glue +
        // re-assert), bounding any correction to ≤50ms after the state
        // actually changes. No early-out: the reveal ordering can re-sink a
        // float after an apparently-quiet tick, so keep re-asserting for
        // the whole window. The heavy borders pass runs
        // ONLY at the end when something was actually corrected (an
        // unconditional pass forces a mask re-upload + stage
        // queue_redraw — a visible flash on calm switches); mid-window
        // geometry changes hit borders naturally via size-changed.
        // One poll per switch (re-armed), cleaned up in disable().
        if (this._stackSettleId) {
            GLib.source_remove(this._stackSettleId);
            this._stackSettleId = 0;
        }
        let settleTicks = 0;
        let settleChanged = false;
        this._stackSettleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!this._settings || ++settleTicks > 30) {
                this._stackSettleId = 0;
                // Borders refresh ONLY when the poll corrected something:
                // an unconditional pass re-uploads mask uniforms +
                // stage queue_redraw — a visible flash on calm switches
                // where nothing needed fixing.
                if (this._settings && settleChanged)
                    this._updateBorders();
                return GLib.SOURCE_REMOVE;
            }
            if (this._syncBlurStackingNow()) settleChanged = true;
            if (this._reassertFloatingTransients()) settleChanged = true;
            return GLib.SOURCE_CONTINUE;
        });
        const windows = this._getWindowsForWorkspace(ws);
        if (windows.length === 0) return;
        let target = this._lastFocusedPerWorkspace.get(ws);
        if (!target || !windows.includes(target)) {
            target = windows[0];
        }
        this._keyboardFocusChange = true;
        this._addIdle(() => {
            if (!this._settings) return false;
            target.activate(this._currentTime());
            this._keyboardFocusChange = false;
            return false;
        });
    }));
    this._addSignal(this._settings, this._settings.connect('changed::float-windows', () => {
        this._floatingClasses = new Set(this._settings.get_strv('float-windows'));
        if (this._floatProcessCache)
            this._floatProcessCache.clear();
        this._reapplyFloatRules();
        this._retileAll();
    }));
    this._addSignal(this._settings, this._settings.connect('changed::float-titles', () => {
        this._floatingTitles = new Set(this._settings.get_strv('float-titles'));
        this._floatingTitlePatterns = this._compileTitlePatterns(this._floatingTitles);
        this._reapplyFloatRules();
        this._retileAll();
    }));
    this._addSignal(this._settings, this._settings.connect('changed::min-window-sizes', () => {
        this._minSizeOverrides = this._parseMinSizeOverrides(this._settings.get_strv('min-window-sizes'));
        this._retileAll();
    }));
    this._addSignal(this._settings, this._settings.connect('changed::workspace-dwindle-trees', () => {
        this._persistedDwindleByIndex = this._parsePersistedDwindleShapes();
    }));
    this._addSignal(this._settings, this._settings.connect('changed::inside-gap', () => this._retileAll()));
    this._addSignal(this._settings, this._settings.connect('changed::outside-gap-top', () => this._retileAll()));
    this._addSignal(this._settings, this._settings.connect('changed::outside-gap-bottom', () => this._retileAll()));
    this._addSignal(this._settings, this._settings.connect('changed::outside-gap-left', () => this._retileAll()));
    this._addSignal(this._settings, this._settings.connect('changed::outside-gap-right', () => this._retileAll()));
    this._addSignal(this._settings, this._settings.connect('changed::scratchpad-border-color', () => this._updateBorders()));
    this._addSignal(this._settings, this._settings.connect('changed::enabled', () => this._onTilingEnabledChanged()));
    this._addSignal(this._settings, this._settings.connect('changed::layout', () => {
        // The new default must apply to every workspace that has no
        // explicit override — _getWorkspaceLayout already resolves
        // live → persisted → default, so workspaces without a live
        // entry fall through to the new default automatically.
        const activeWs = global.workspace_manager.get_active_workspace();
        if (activeWs)
            this._retileWorkspace(activeWs);
        this._scheduleSaveLayouts();
    }));
    this._addSignal(this._settings, this._settings.connect('changed::dwindle-ratio', () => this._retileAll()));
    this._addSignal(this._settings, this._settings.connect('changed::master-ratio', () => this._retileAll()));
    this._addSignal(this._settings, this._settings.connect('changed::active-border-width', () => this._updateBorders()));
    this._addSignal(this._settings, this._settings.connect('changed::borders-enabled', () => this._updateBorders()));
    this._addSignal(this._settings, this._settings.connect('changed::active-border-color', () => this._updateBorders()));
    this._addSignal(this._settings, this._settings.connect('changed::active-border-color-2', () => this._updateBorders()));
    this._addSignal(this._settings, this._settings.connect('changed::inactive-border-width', () => this._updateBorders()));
    this._addSignal(this._settings, this._settings.connect('changed::inactive-border-color', () => this._updateBorders()));
    this._addSignal(this._settings, this._settings.connect('changed::inactive-border-color-2', () => this._updateBorders()));
    this._addSignal(this._settings, this._settings.connect('changed::border-radius', () => this._updateBorders()));
    this._addSignal(this._settings, this._settings.connect('changed::rounded-corners', () => this._updateBorders()));
    this._addSignal(this._settings, this._settings.connect('changed::window-blur', () => this._updateBorders()));
    this._addSignal(this._settings, this._settings.connect('changed::window-blur-radius', () => this._updateBorders()));
    this._addSignal(this._settings, this._settings.connect('changed::window-blur-brightness', () => this._updateBorders()));
    this._addSignal(this._settings, this._settings.connect('changed::window-blur-opacity', () => this._updateBorders()));
    this._addSignal(this._settings, this._settings.connect('changed::gradient-borders', () => {
        this._updateBorders();
        this._syncBorderAnimation();
    }));
    this._addSignal(this._settings, this._settings.connect('changed::gradient-direction', () => this._updateBorders()));
    this._addSignal(this._settings, this._settings.connect('changed::border-animation-speed', () => {
        this._syncBorderAnimation();
        this._updateBorders();
    }));
    this._addSignal(this._settings, this._settings.connect('changed::pick-mode', () => {
        if (this._settings.get_boolean('pick-mode')) {
            this._startPickMode();
        }
    }));
    this._connectGrabSignals();

}

export function _trackSource(id) {
    if (id && this._sourceIds) this._sourceIds.add(id);
    return id;
}

export function _untrackSource(id) {
    if (this._sourceIds) this._sourceIds.delete(id);
}

export function _addIdle(callback) {
    if (!this._settings || !this._sourceIds) return 0;
    let id = 0;
    id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        let result = GLib.SOURCE_REMOVE;
        try {
            result = callback();
        } finally {
            if (!result) this._untrackSource(id);
        }
        return result;
    });
    return this._trackSource(id);
}

export function _addTimeout(delay, callback) {
    if (!this._settings || !this._sourceIds) return 0;
    let id = 0;
    id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
        let result = GLib.SOURCE_REMOVE;
        try {
            result = callback();
        } finally {
            if (!result) this._untrackSource(id);
        }
        return result;
    });
    return this._trackSource(id);
}

export function _removeAllSources() {
    if (!this._sourceIds) return;
    for (const id of this._sourceIds)
        GLib.source_remove(id);
    this._sourceIds.clear();
}

export function _addSignal(emitter, id) {
    this._signals.push({ emitter, id });
}

export function _disconnectSignals() {
    if (this._signals) {
        for (const { emitter, id } of this._signals) {
            emitter.disconnect(id);
        }
        this._signals = [];
    }
    for (const [win, sigIds] of this._windowSignals || []) {
        for (const { emitter, id } of sigIds) {
            emitter.disconnect(id);
        }
        // Re-enables are resumes: the maps come back with the same window
        // objects, so the flag must be cleared here or _connectWindowSignals
        // would refuse to re-arm position/size/identity/unmanaged handlers.
        win._plaidSignalsConnected = false;
    }
    this._windowSignals = null;
    for (const id of this._pendingRetileIds.values())
        GLib.source_remove(id);
    this._pendingRetileIds.clear();
    if (this._pendingBorderId) {
        GLib.source_remove(this._pendingBorderId);
        this._pendingBorderId = 0;
    }
}

export function _onShellShutdown() {
    // Called from Meta.Display::closing and global::shutdown. Only the first
    // one does work.
    if (this._shuttingDown) return;
    // Do NOT run full disable() here: it writes settings and touches UI
    // that is already being destroyed. Just make every queued/active
    // tiling path inert before the compositor goes away.
    this._shuttingDown = true;
    if (this._pendingRetileIds) {
        for (const id of this._pendingRetileIds.values())
            GLib.source_remove(id);
        this._pendingRetileIds.clear();
    }
    this._cancelAnimation();
    this._debugLog('shell shutdown: retiles/animations stopped');
}

export function _scheduleRetile(workspace) {
    if (!this._settings || !workspace || this._shuttingDown) return;
    if (this._pendingRetileIds.has(workspace))
        GLib.source_remove(this._pendingRetileIds.get(workspace));
    const now = Date.now();
    const last = this._lastRetileTimes.get(workspace) || 0;
    const delay = Math.max(0, 50 - (now - last));
    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
        this._pendingRetileIds.delete(workspace);
        if (!this._settings || this._shuttingDown) return false;
        this._doRetileWorkspace(workspace);
        return false;
    });
    this._pendingRetileIds.set(workspace, id);
    this._lastRetileTimes.set(workspace, now);
}

export function _scheduleBorders() {
    if (!this._settings) return;
    if (this._pendingBorderId)
        GLib.source_remove(this._pendingBorderId);
    this._pendingBorderId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        this._pendingBorderId = 0;
        if (!this._settings) return false;
        this._doUpdateBorders();
        return false;
    });
}

export const signalMethods = {
    _connectSignals,
    _trackSource,
    _untrackSource,
    _addIdle,
    _addTimeout,
    _removeAllSources,
    _addSignal,
    _disconnectSignals,
    _onShellShutdown,
    _scheduleRetile,
    _scheduleBorders,
};
