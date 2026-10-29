// Signals, GLib sources, and scheduling.
//
// Every signal and source the extension creates is registered here so the
// lifecycle has one reviewable teardown path. Methods live on this subsystem class.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { bumpMonitorDims } from './blur.js';
import { PlaidSubsystem } from './subsystem.js';


export class Signals extends PlaidSubsystem {
    constructor(core) {
        super(core);
    }

    connectSignals() {
        // The shell emits this at the very start of shutdown. A retile that
        // was queued by an unmanaged window can otherwise fire after this
        // point and start a 16ms animation against windows/actors that are
        // already being torn down — the main loop then stalls until systemd
        // SIGKILLs the shell (observed: 5s stop-sigterm timeout on logout).
        this.connectObject(global, 'shutdown', () => {
            if (this.core._settings) this.onShellShutdown();
        });
        // Display close fires BEFORE meta_display_unmanage_windows(), i.e.
        // before _removeWindow() can queue a retile. global::shutdown is too
        // late: the 50ms retile timeout can win the race and start animating
        // windows that are already being disposed (observed logout stall).
        this.connectObject(global.display, 'closing', () => {
            if (this.core._settings) this.onShellShutdown();
        });
        // X11/XWayland teardown can reach this earlier than Meta.Display::closing
        // when XWayland clients are present.
        this.connectObject(global.display, 'x11-display-closing', () => {
            if (this.core._settings) this.onShellShutdown();
        });
        // Detect a system shortcut that already owns one of our combos. The
        // other binding stays in control; we just tell the user why Plaid did
        // not run (see _onAcceleratorActivated / _showKeybindConflict).
        this.connectObject(global.display, 'accelerator-activated', (_d, actionId) => {
            this.core.keybindings.onAcceleratorActivated(actionId);
        });
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
            this.connectObject(s, 'changed', () => this.core.keybindings.scheduleConflictScan());
        }
        this.connectObject(global.display, 'window-created', (_d, win) => {
            if (this.core.dropdown.handleDropdownWindowCreated(win)) return;
            if (this.core.bgApp.handleBackgroundAppWindowCreated(win)) return;
            if (this.core.windows.shouldManage(win)) {
                this.core.windows.addWindow(win);
                const doRetile = () => {
                    if (!this.core._settings) return;
                    const ws = win.get_workspace();
                    if (ws) this.core.layouts.retileWorkspace(ws);
                };
                const actor = win.get_compositor_private();
                if (actor) {
                    const firstFrameId = this.connectObject(actor, 'first-frame', () => {
                        actor.disconnectObject(firstFrameId);
                        this.core.windows.markPendingWindowInvisible(win, actor);
                        doRetile();
                    });
                } else {
                    this.addIdle(() => {
                        this.core.windows.markPendingWindowInvisible(win, win.get_compositor_private());
                        doRetile();
                        return false;
                    });
                }
            } else if (this.core.windows.isFloating(win)) {
                const doRestore = () => {
                    if (!this.core._settings) return;
                    this.core.windows.restoreFloatNaturalRect(win);
                };
                const actor = win.get_compositor_private();
                if (actor) {
                    const firstFrameId = this.connectObject(actor, 'first-frame', () => {
                        actor.disconnectObject(firstFrameId);
                        if (!this.core._settings) return;
                        doRestore();
                        if (this.core._settings.get_boolean('follow-focus') &&
                            win.get_window_type() === Meta.WindowType.NORMAL)
                            this.core.windows.cursorWarpDeferred(win);
                        this.core.windows.connectFloatHooks(win);
                        this.core.borders.updateBorders();
                    });
                } else {
                    this.addIdle(() => {
                        if (!this.core._settings) return false;
                        doRestore();
                        if (this.core._settings.get_boolean('follow-focus') &&
                            win.get_window_type() === Meta.WindowType.NORMAL)
                            this.core.windows.cursorWarpDeferred(win);
                        this.core.windows.connectFloatHooks(win);
                        this.core.borders.updateBorders();
                        return false;
                    });
                }
            }
        });
        this.connectObject(global.display, 'notify::focus-window', () => {
            this.core.borders.updateBorders();
            const win = global.display.focus_window;
            if (win) {
                if (win !== this.core._backgroundAppWin) {
                    const ws = win.get_workspace();
                    // Never remember a window on the hidden parking workspace
                    // as a focus-restore target (activating it would switch
                    // the user onto the reserved slot).
                    if (ws && ws !== this.core._backgroundAppParkingWs) {
                        this.core._lastRealFocusedWindow = win;
                        this.core._lastFocusedPerWorkspace.set(ws, win);
                    }
                }
            }
            if (this.core._backgroundAppWin && win === this.core._backgroundAppWin) {
                this.core.debugLog('background app: focus landed on bg window');
                this.core.bgApp.restoreFocusFromBackgroundApp();
            }
            if (this.core._settings.get_boolean('follow-focus') && this.core._keyboardFocusChange) {
                this.core._keyboardFocusChange = false;
                if (win) this.core.windows.moveCursorToWindow(win);
            }
        });
        this.connectObject(Main.layoutManager, 'monitors-changed', () => {
            bumpMonitorDims();
            this.core.dragPreview.updateDropOverlaySize();
            this.core.bgApp.refillBackgroundApp();
            this.core.layouts.retileAll();
            const mon = global.display.get_monitor_geometry(global.display.get_primary_monitor());
            if (mon) this.core._lastMonitorsGeom = mon;
            this.core.debugLog('monitors-changed handled');
        });
        if (this.core._mutterSettings) {
            this.connectObject(this.core._mutterSettings,
                'changed::dynamic-workspaces', () => this.core.bgApp.checkDynamicWorkspaces());
        }
        this.connectObject(global.workspace_manager, 'workspace-added', (_m, index) => {
            const ws = global.workspace_manager.get_workspace_by_index(index);
            this.core._workspaceOrders.set(ws, []);
            this.core.bgApp.scheduleBackgroundAppParkingFix();
        });
        this.connectObject(global.workspace_manager, 'workspace-removed', () => {
            this.core.bgApp.scheduleBackgroundAppParkingFix();
            for (const [workspace] of this.core._workspaceOrders) {
                let valid = false;
                for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
                    if (global.workspace_manager.get_workspace_by_index(i) === workspace) {
                        valid = true;
                        break;
                    }
                }
                if (!valid) {
                    this.core._workspaceOrders.delete(workspace);
                    this.core._masterRatios.delete(this.core.geometry.wsIndex(workspace));
                    this.core._stackRatios.delete(this.core.geometry.wsIndex(workspace));
                    this.core._bspTrees.delete(workspace);
                    this.core._workspaceLayouts.delete(this.core.geometry.wsIndex(workspace));
                    this.core._lastFocusedPerWorkspace.delete(workspace);
                    // Workspace-keyed, workspace-object key — a retained
                    // GJS wrapper per removed workspace otherwise.
                    this.core._lastRetileTimes.delete(workspace);
                    // The workspace-object-keyed maps missed here: a
                    // retained wrapper + a pending retile timeout that
                    // later fires against a dead workspace.
                    this.core._dwindleLeafSigs.delete(workspace);
                    this.core._queuedAnimWorkspaces.delete(workspace);
                    if (this.core._pendingRetileIds.has(workspace)) {
                        GLib.source_remove(this.core._pendingRetileIds.get(workspace));
                        this.core._pendingRetileIds.delete(workspace);
                    }
                    this.core.persistence.scheduleSaveLayouts();
                }
            }
        });
        this.connectObject(global.workspace_manager, 'active-workspace-changed', () => {
            this.core.dropdown.scheduleDropdownWorkspaceSync();
            this.core.bgApp.raiseBackgroundAppClone();
            this.addIdle(() => {
                if (!this.core._settings) return false;
                this.core.bgApp.raiseBackgroundAppClone();
                return false;
            });
            this.addTimeout(150, () => {
                if (!this.core._settings) return GLib.SOURCE_REMOVE;
                this.core.bgApp.raiseBackgroundAppClone();
                return GLib.SOURCE_REMOVE;
            });
        });
        this.connectObject(global.workspace_manager, 'active-workspace-changed', () => {
            if (!this.core._settings || !this.core._settings.get_boolean('enabled')) return;
            const ws = global.workspace_manager.get_active_workspace();
            if (!ws) return;
            if (ws === this.core._backgroundAppParkingWs) {
                // Reaching the hidden slot means something switched onto the
                // reservation. Move any user windows back to a real workspace
                // and leave the parking before the session restore places new
                // windows there.
                this.core.debugLog('workspace: active workspace is the hidden parking slot');
                this.core.bgApp.evacuateParkingWorkspace();
                return;
            }
            if (this.core._settings.get_boolean('workspace-popup'))
                this.core.workspaces.showWorkspacePopup(ws);
            // Re-assert float layering + refresh Flair after the switch
            // settles (the restacked signal can fire before the reveal
            // ordering is final).
            this.core.windows.reassertFloatingTransients();
            this.core.borders.updateBorders();
            this.core.placement.checkWorkspaceLandings(ws);
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
            if (this.core._stackSettleId) {
                GLib.source_remove(this.core._stackSettleId);
                this.core._stackSettleId = 0;
            }
            let settleTicks = 0;
            let settleChanged = false;
            this.core._stackSettleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                if (!this.core._settings || ++settleTicks > 30) {
                    this.core._stackSettleId = 0;
                    // Borders refresh ONLY when the poll corrected something:
                    // an unconditional pass re-uploads mask uniforms +
                    // stage queue_redraw — a visible flash on calm switches
                    // where nothing needed fixing.
                    if (this.core._settings && settleChanged)
                        this.core.borders.updateBorders();
                    return GLib.SOURCE_REMOVE;
                }
                if (this.core.blur.syncBlurStackingNow()) settleChanged = true;
                if (this.core.windows.reassertFloatingTransients()) settleChanged = true;
                return GLib.SOURCE_CONTINUE;
            });
            const windows = this.core.windows.getWindowsForWorkspace(ws);
            if (windows.length === 0) return;
            let target = this.core._lastFocusedPerWorkspace.get(ws);
            if (!target || !windows.includes(target)) {
                target = windows[0];
            }
            this.core._keyboardFocusChange = true;
            this.addIdle(() => {
                if (!this.core._settings) return false;
                target.activate(this.core.currentTime());
                this.core._keyboardFocusChange = false;
                return false;
            });
        });
        this.connectObject(this.core._settings, 'changed::float-windows', () => {
            this.core._floatingClasses = new Set(this.core._settings.get_strv('float-windows'));
            if (this.core._floatProcessCache)
                this.core._floatProcessCache.clear();
            this.core.windows.reapplyFloatRules();
            this.core.layouts.retileAll();
        });
        this.connectObject(this.core._settings, 'changed::float-titles', () => {
            this.core._floatingTitles = new Set(this.core._settings.get_strv('float-titles'));
            this.core._floatingTitlePatterns = this.core.compileTitlePatterns(this.core._floatingTitles);
            this.core.windows.reapplyFloatRules();
            this.core.layouts.retileAll();
        });
        this.connectObject(this.core._settings, 'changed::min-window-sizes', () => {
            this.core._minSizeOverrides = this.core.bsp.parseMinSizeOverrides(this.core._settings.get_strv('min-window-sizes'));
            this.core.layouts.retileAll();
        });
        this.connectObject(this.core._settings, 'changed::workspace-dwindle-trees', () => {
            this.core._persistedDwindleByIndex = this.core.persistence.parsePersistedDwindleShapes();
        });
        this.connectObject(this.core._settings, 'changed::inside-gap', () => this.core.layouts.retileAll());
        this.connectObject(this.core._settings, 'changed::outside-gap-top', () => this.core.layouts.retileAll());
        this.connectObject(this.core._settings, 'changed::outside-gap-bottom', () => this.core.layouts.retileAll());
        this.connectObject(this.core._settings, 'changed::outside-gap-left', () => this.core.layouts.retileAll());
        this.connectObject(this.core._settings, 'changed::outside-gap-right', () => this.core.layouts.retileAll());
        this.connectObject(this.core._settings, 'changed::scratchpad-border-color', () => this.core.borders.updateBorders());
        this.connectObject(this.core._settings, 'changed::enabled', () => this.core.actions.onTilingEnabledChanged());
        this.connectObject(this.core._settings, 'changed::layout', () => {
            // The new default must apply to every workspace that has no
            // explicit override — _getWorkspaceLayout already resolves
            // live → persisted → default, so workspaces without a live
            // entry fall through to the new default automatically.
            const activeWs = global.workspace_manager.get_active_workspace();
            if (activeWs)
                this.core.layouts.retileWorkspace(activeWs);
            this.core.persistence.scheduleSaveLayouts();
        });
        this.connectObject(this.core._settings, 'changed::dwindle-ratio', () => this.core.layouts.retileAll());
        this.connectObject(this.core._settings, 'changed::master-ratio', () => this.core.layouts.retileAll());
        this.connectObject(this.core._settings, 'changed::active-border-width', () => this.core.borders.updateBorders());
        this.connectObject(this.core._settings, 'changed::borders-enabled', () => this.core.borders.updateBorders());
        this.connectObject(this.core._settings, 'changed::active-border-color', () => this.core.borders.updateBorders());
        this.connectObject(this.core._settings, 'changed::active-border-color-2', () => this.core.borders.updateBorders());
        this.connectObject(this.core._settings, 'changed::inactive-border-width', () => this.core.borders.updateBorders());
        this.connectObject(this.core._settings, 'changed::inactive-border-color', () => this.core.borders.updateBorders());
        this.connectObject(this.core._settings, 'changed::inactive-border-color-2', () => this.core.borders.updateBorders());
        this.connectObject(this.core._settings, 'changed::border-radius', () => this.core.borders.updateBorders());
        this.connectObject(this.core._settings, 'changed::rounded-corners', () => this.core.borders.updateBorders());
        this.connectObject(this.core._settings, 'changed::window-blur', () => this.core.borders.updateBorders());
        this.connectObject(this.core._settings, 'changed::window-blur-radius', () => this.core.borders.updateBorders());
        this.connectObject(this.core._settings, 'changed::window-blur-brightness', () => this.core.borders.updateBorders());
        this.connectObject(this.core._settings, 'changed::window-blur-opacity', () => this.core.borders.updateBorders());
        this.connectObject(this.core._settings, 'changed::gradient-borders', () => {
            this.core.borders.updateBorders();
            this.core.borders.syncBorderAnimation();
        });
        this.connectObject(this.core._settings, 'changed::gradient-direction', () => this.core.borders.updateBorders());
        this.connectObject(this.core._settings, 'changed::border-animation-speed', () => {
            this.core.borders.syncBorderAnimation();
            this.core.borders.updateBorders();
        });
        this.connectObject(this.core._settings, 'changed::pick-mode', () => {
            if (this.core._settings.get_boolean('pick-mode')) {
                this.core.actions.startPickMode();
            }
        });
        this.core.grab.connectGrabSignals();

    }

    trackSource(id) {
        if (id && this.core._sourceIds) this.core._sourceIds.add(id);
        return id;
    }

    untrackSource(id) {
        if (this.core._sourceIds) this.core._sourceIds.delete(id);
    }

    addIdle(callback) {
        if (!this.core._settings || !this.core._sourceIds) return 0;
        let id = 0;
        id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            let result = GLib.SOURCE_REMOVE;
            try {
                result = callback();
            } finally {
                if (!result) this.untrackSource(id);
            }
            return result;
        });
        return this.trackSource(id);
    }

    addTimeout(delay, callback) {
        if (!this.core._settings || !this.core._sourceIds) return 0;
        let id = 0;
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            let result = GLib.SOURCE_REMOVE;
            try {
                result = callback();
            } finally {
                if (!result) this.untrackSource(id);
            }
            return result;
        });
        return this.trackSource(id);
    }

    removeAllSources() {
        if (!this.core._sourceIds) return;
        for (const id of this.core._sourceIds)
            GLib.source_remove(id);
        this.core._sourceIds.clear();
    }

    disconnectSignals() {
        for (const [win, sigIds] of this.core._windowSignals || []) {
            for (const { emitter, id } of sigIds) {
                emitter.disconnectObject(id);
            }
            // Re-enables are resumes: the maps come back with the same window
            // objects, so the flag must be cleared here or _connectWindowSignals
            // would refuse to re-arm position/size/identity/unmanaged handlers.
            win._plaidSignalsConnected = false;
        }
        this.core._windowSignals = null;
        for (const id of this.core._pendingRetileIds.values())
            GLib.source_remove(id);
        this.core._pendingRetileIds.clear();
        if (this.core._pendingBorderId) {
            GLib.source_remove(this.core._pendingBorderId);
            this.core._pendingBorderId = 0;
        }
    }

    onShellShutdown() {
        // Called from Meta.Display::closing, x11-display-closing, and
        // global::shutdown. Only the first one does work.
        if (this.core._shuttingDown) return;
        this.core._shuttingDown = true;
        // Tracked GLib sources (idle/timeout wrappers).
        this.removeAllSources();

        // Direct source IDs owned by subsystems.
        const sourceFields = [
            '_pendingBorderId', '_stackSettleId', '_workspacePillUpdateId',
            '_workspaceLayoutsSaveId', '_conflictScanId', '_conflictDialogId',
            '_dropdownPendingId', '_dropdownSyncId', '_layoutPopupHideId',
            '_warningPopupId', '_pointerFocusId', '_liveResizeId', '_animTickId',
            '_backgroundAppReleaseId', '_backgroundAppRestartId',
            '_backgroundAppPendingId', '_backgroundAppParkCoalesceId',
            '_backgroundAppParkWatchTimeoutId', '_backgroundAppParkingFixId',
            '_backgroundAppCloneWatchId', '_bgAppRecheckId',
        ];
        for (const field of sourceFields) {
            const id = this.core[field];
            if (id) {
                GLib.source_remove(id);
                this.core[field] = 0;
            }
        }

        if (this.core._pendingRetileIds) {
            for (const id of this.core._pendingRetileIds.values())
                GLib.source_remove(id);
            this.core._pendingRetileIds.clear();
        }

        if (this.core._windowWorkspaces) {
            for (const win of this.core._windowWorkspaces.keys()) {
                if (win._plaidInvisibleTimer) {
                    GLib.source_remove(win._plaidInvisibleTimer);
                    win._plaidInvisibleTimer = 0;
                }
                if (win._plaidSettlePollId) {
                    GLib.source_remove(win._plaidSettlePollId);
                    win._plaidSettlePollId = 0;
                }
            }
        }

        this.core.borders.stopBorderAnimation();
        this.core.placement.cancelAnimation();
    }

    scheduleRetile(workspace) {
        if (!this.core._settings || !workspace || this.core._shuttingDown) return;
        if (this.core._pendingRetileIds.has(workspace))
            GLib.source_remove(this.core._pendingRetileIds.get(workspace));
        const now = Date.now();
        const last = this.core._lastRetileTimes.get(workspace) || 0;
        const delay = Math.max(0, 50 - (now - last));
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this.core._pendingRetileIds.delete(workspace);
            if (!this.core._settings || this.core._shuttingDown) return false;
            this.core.layouts.doRetileWorkspace(workspace);
            return false;
        });
        this.core._pendingRetileIds.set(workspace, id);
        this.core._lastRetileTimes.set(workspace, now);
    }

    scheduleBorders() {
        if (!this.core._settings || this.core._shuttingDown) return;
        if (this.core._pendingBorderId)
            GLib.source_remove(this.core._pendingBorderId);
        this.core._pendingBorderId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this.core._pendingBorderId = 0;
            if (!this.core._settings) return false;
            this.core.borders.doUpdateBorders();
            return false;
        });
    }

    destroy() {
        this.removeAllSources();
        this.disconnectSignals();
        if (this.core._stackSettleId) {
            GLib.source_remove(this.core._stackSettleId);
            this.core._stackSettleId = 0;
        }
            super.destroy();
}
}
