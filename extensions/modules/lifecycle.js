// Extension lifecycle: enable/disable orchestration, the Wayland gate, the
// lock-cycle signal, and the stashed tiling state restored on re-enable.
//
// The entry point only delegates here, so enable() and disable() stay
// adjacent and free of teardown wrappers.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { sessionState } from './session-state.js';

// True once the extension has been enabled at least once in this shell
// process. A manual disable/enable (or any re-enable that isn't a fresh
// login) must register pre-existing windows as a resume: the new-window
// choreography would force-show other-workspace windows.
let _enabledThisShell = false;

// Set when the session enters the lock screen (see modules/session-state.js).
let _lockModeId = 0;

// Tiling state stashed at the lock-cycle disable and restored at the unlock
// re-enable, so windows keep their exact arrangement across the cycle. The
// window/workspace objects survive the lock, so the maps stay valid.
let _stashedTiling = null;

export function enablePlaid() {
    const wasEnabled = _enabledThisShell;
    _enabledThisShell = true;
    // GNOME 50/51 do not expose Meta.is_wayland_compositor, and neither
    // Backend.get_wayland_display nor WaylandCompositor.get_default is
    // introspectable. The backend context's get_wayland_compositor() is
    // non-null on Wayland and NULL on X11.
    const ctx = global.backend.get_context();
    if (!ctx.get_wayland_compositor()) {
        this._notifyCritical('Plaid', 'Plaid requires Wayland — the extension is disabled on X11.');
        log('[plaid] disabled: Wayland-only (X11 session detected)');
        return;
    }

    // Track lock-screen cycles: the shell disables extensions on lock and
    // re-enables them on unlock. The module-level flag lets disable()/
    // enable() resume instead of teardown-and-restart. Belt-and-suspenders:
    // the mode signal fires synchronously at the push, while disable()
    // also checks Main.sessionMode.isLocked directly.
    if (!_lockModeId) {
        _lockModeId = Main.sessionMode.connect('updated', (sm) => {
            if (sm.currentMode === 'lock' || sm.currentMode === 'unlock-dialog')
                sessionState.lockCycle = true;
            this._debugLog(`session mode: ${sm.currentMode} lockCycle=${sessionState.lockCycle}`);
        });
    }
    this._settings = this.getSettings();
    this._floatingClasses = new Set(this._settings.get_strv('float-windows'));
    this._floatingTitles = new Set(this._settings.get_strv('float-titles'));
    this._floatingTitlePatterns = this._compileTitlePatterns(this._floatingTitles);
    this._floatProcessCache = new Map();
    this._minSizeOverrides = this._parseMinSizeOverrides(this._settings.get_strv('min-window-sizes'));
    if (this._minSizeOverrides.size > 0)
        this._debugLog(`min-sizes: ${[...this._minSizeOverrides.entries()].map(([k, v]) => `${k}=${v.w}x${v.h}`).join(', ')} (override loaded)`);
    this._windowBorders = new Map();
    this._scratchpadRings = new Map();
    this._windowMasks = new Map();
    this._maskQuarantined = new Set();
    this._windowBlurs = new Map();
    this._sourceIds = new Set();
    this._addIdle(() => {
        this._purgeOrphanBlurs();
        return false;
    });
    this._workspaceOrders = new Map();
    this._windowWorkspaces = new Map();
    this._windowWSIndices = new Map();
    this._slotReassertTimes = new Map();
    this._workspaceLayouts = new Map();
    this._lastRetileTimes = new Map();
    this._masterRatios = new Map();
    this._stackRatios = new Map();
    this._bspTrees = new Map();
    this._dwindleLeafSigs = new Map();
    this._lastFocusedPerWorkspace = new Map();
    this._savedRects = new Map();
    this._workspaceLayoutsSaveId = 0;
    this._saveDirtySince = 0;
    // Explicit zero-init: disable() reads these
    // BEFORE any assignment; an undefined field was only accidentally
    // safe (falsey) — any future truthy default would double-remove a
    // source id.
    this._stackSettleId = 0;
    this._pickFocusId = null;
    this._conflictScanId = 0;
    this._keybindChangeIds = [];
    this._backgroundAppCloneWatchId = 0;
    this._backgroundAppSpawnRetries = 0;
    // Persisted per-workspace layouts/ratios are slot rules parsed at
    // enable and consulted at use time — timing-independent (no workspace
    // objects exist yet at this point, which is fine: the rules key on
    // indices, not objects).
    this._loadPersistedLayoutRules();
    this._signals = [];
    this._pendingRetileIds = new Map();
    this._pendingBorderId = 0;
    this._queuedAnimWorkspaces = new Set();
    this._animStartedAt = 0;
    this._landingRetries = new Map();
    this._mismatchFrames = new Map();
    this._landingGivenUp = new Set();
    // Windows that refuse to shrink past a size we asked for (apps that
    // don't report a min, e.g. ghostty): the observed minimum, plus the
    // auto-float state while a slot can't yet fit them.
    this._observedMinSizes = new Map();
    this._minLimitedWindows = new Set();
    this._pendingWarp = new Set();
    this._lastMonitorsGeom = null;
    this._pinnedAdjustCounts = new Map();
    this._stackDiagnostics = new Set();
    this._toggleFloatWindows = new Set();
    this._keyboardFocusChange = false;
    this._grabOp = null;
    this._grabWindow = null;
    this._grabStartX = 0;
    this._grabStartY = 0;
    this._grabWidthSign = 0;
    this._grabHeightSign = 0;
    this._grabResizeNodeW = null;
    this._grabResizeNodeH = null;
    this._grabInitialRatioW = 0;
    this._grabInitialRatioH = 0;
    this._grabInitialMasterRatio = 0;
    this._grabInitialStackRatios = null;
    this._liveResizeId = 0;
    this._grabSizeChangedId = 0;
    this._grabPositionChangedId = 0;
    this._layoutPopup = null;
    this._layoutPopupHideId = 0;
    this._warningPopup = null;
    this._warningPopupId = 0;
    this._pendingWarning = null;
    this._pendingWarningOverviewId = 0;
    this._origWorkspaceSwitcherDisplay = null;
    this._dropdownWin = null;
    this._dropdownUnmanagedId = 0;
    this._dropdownPending = false;
    this._dropdownPendingId = 0;
    this._dropdownWaiters = new Map();
    this._markerPidCache = null;
    this._dropdownSettingsChangedId = 0;
    this._dropdownHeightChangedId = 0;
    this._dropdownGeometryIds = null;
    this._backgroundAppWin = null;
    this._backgroundAppWaiter = null;
    this._backgroundAppReleaseId = 0;
    this._maximizeToggleRects = new Map();
    this._backgroundAppPending = false;
    this._backgroundAppSpawnRetries = 0;
    this._markerSweepPending = false;
    this._bgAppRecheckPending = false;
    this._bgAppRecheckId = 0;
    this._markerSweepGen = 0;
    this._backgroundAppPendingId = 0;
    this._backgroundAppUnmanagedId = 0;
    this._backgroundAppSettingsChangedId = 0;
    this._backgroundAppEnabledChangedId = 0;
    this._backgroundAppRestartId = 0;
    this._pointerFocusId = 0;
    this._pointerFocusLastX = -1;
    this._pointerFocusLastY = -1;
    this._pointerFocusCandSig = '';
    this._chromiumProcessCache = new Map();
    this._backgroundAppProc = null;
    this._backgroundAppFirstFrameId = 0;
    this._backgroundAppClone = null;
    this._backgroundAppGroupAddedId = 0;
    this._backgroundAppCloneWatchId = 0;
    this._backgroundAppParkIds = null;
    this._backgroundAppParkWatchTimeoutId = 0;
    this._backgroundAppParkCoalesceId = 0;
    this._backgroundAppParkCount = 0;
    this._backgroundAppParkingWs = null;
    this._backgroundAppHiding = null;
    this._backgroundAppParkingFixId = 0;
    this._backgroundAppParkingLastRelocate = 0;
    this._dynamicWsWarned = false;
    this._lastRealFocusedWindow = null;
    this._floatMaxRects = new Map();
    this._gappedMaxSet = new Set();
    this._borderAnimId = 0;
    this._scratchpadWindows = new Map();
    this._scratchpadVisible = false;
    this._dropPreview = null;

    // Migration FIRST: it may pin a user-layer default for an existing
    // install. Plaid itself never writes GNOME keybindings or edge-tiling;
    // those belong to the user. _mutterSettings is read-only (BGAPP's
    // dynamic-workspaces check).
    this._migrateKeybindingDefaults();
    this._mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
    this._dropOverlay = new St.Widget({
        reactive: false,
        visible: true,
    });
    Main.layoutManager.uiGroup.add_child(this._dropOverlay);
    this._shuttingDown = false;
    this._animating = false;
    this._animTargets = null;
    this._animStates = null;
    this._animWindows = null;
    this._animStartTime = 0;
    this._animTickId = 0;
    this._newWindowSet = new Set();
    this._floatHooks = new Map();
    this._connectSignals();
    this._registerKeybindings();
    this._suppressWorkspaceSwitcherPopup();
    this._initWorkspacePopupWarning();
    this._initDropdownTerminal();
    this._workspacePill = null;
    this._workspacePillIndicators = null;
    this._workspacePillNumbers = null;
    this._workspacePillIcon = null;
    this._workspacePillTitle = null;
    this._workspacePillFocusedWin = null;
    this._workspacePillTitleId = 0;
    this._workspacePillUnmanagedId = 0;
    this._workspacePillUpdateId = 0;
    this._initWorkspacePill();
    this._initBackgroundApp();
    this._initPointerFocus();
    this._addIdle(() => {
        this._updateDropOverlaySize();
        const resumeLockCycle = sessionState.lockCycle;
        // Any re-enable within this shell (lock cycle OR manual toggle)
        // must register pre-existing windows as a resume — running the
        // new-window choreography on them force-shows other-workspace
        // windows via the actor.visible reveal.
        const resumeLike = sessionState.lockCycle || wasEnabled;
        if (resumeLike && _stashedTiling)
            restoreTilingState(this);
        const bgCommand = this._settings.get_string('background-app');
        for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
            const ws = global.workspace_manager.get_workspace_by_index(i);
            for (const win of ws.list_windows()) {
                if (this._shouldManage(win)) {
                    this._addWindow(win, resumeLike);
                    // On a lock-cycle resume windows must stay exactly as
                    // they are — never re-gap a maximized window either.
                    if (!resumeLockCycle)
                        this._convertMaximizedToGaps(win);
                } else if (this._isFloating(win)) {
                    this._restoreFloatNaturalRect(win);
                    if (!resumeLockCycle)
                        this._convertMaximizedToGaps(win);
                    this._connectFloatHooks(win);
                } else if (bgCommand && !this._backgroundAppWin &&
                    this._isMarkerProcess(win, 'PLAID_BGAPP=1', bgCommand)) {
                    // A surviving bg-app window (e.g. after a lock cycle)
                    // is never managed — claim it back into the pipeline
                    // (de-register, park, clone) instead of leaving it
                    // orphaned or relaunching a duplicate.
                    this._debugLog('background app: idle-pass re-claim of surviving window');
                    this._adoptFoundWindow(win);
                }
            }
        }
        // Unlock re-enables must not re-arrange windows: the shell tears
        // the extension down on lock and starts a fresh instance on
        // unlock, so a retile would rebuild the layout from defaults and
        // move every tiled window. Resume instead — tracking maps were
        // rebuilt by _addWindow above, so interactions work, but geometry
        // stays exactly where the user left it.
        // Persisted per-ws layouts/ratios are slot rules parsed at enable
        // and consulted at use time by the getters — no load needed here.
        if (!resumeLockCycle)
            this._retileAll();
        this._checkDynamicWorkspaces();
        sessionState.lockCycle = false;
        return false;
    });
}

export function disablePlaid() {
    // X11 early-return path in enable() never initialized the instance
    // fields — teardown must not touch them.
    if (!this._settings) return;
    // Lock-screen cycles: the shell switches to the lock mode and disables
    // extensions not whitelisted for it, then re-enables them on unlock.
    // isLocked is already true when this runs, so the module-level flag is
    // set in time for the teardown below to keep the bg-app alive and for
    // the upcoming re-enable to resume instead of relaunching.
    const mode = Main.sessionMode.currentMode;
    const isLocked = Main.sessionMode.isLocked;
    if (isLocked)
        sessionState.lockCycle = true;
    this._debugLog(`disable: mode=${mode} isLocked=${isLocked} lockCycle=${sessionState.lockCycle}`);
    // Flush any pending per-ws layout/ratio persistence (insurance — the
    // debounced save may not have fired before the teardown).
    if (this._workspaceLayoutsSaveId) {
        GLib.source_remove(this._workspaceLayoutsSaveId);
        this._workspaceLayoutsSaveId = 0;
    }
    this._savePersistedLayouts();
    this._saveDirtySince = 0;
    // Stash the exact tiling state on any in-shell disable (lock cycle OR
    // manual toggle) so the re-enable restores it instead of rebuilding
    // trees from the stack order — which would shuffle windows on the
    // retile. The module dies at a real logout, so stashing there is
    // harmless; a fresh login starts with a fresh module (no stash).
    if (!_stashedTiling) {
        _stashedTiling = {
            bspTrees: this._bspTrees,
            workspaceLayouts: this._workspaceLayouts,
            masterRatios: this._masterRatios,
            stackRatios: this._stackRatios,
            workspaceOrders: this._workspaceOrders,
            windowWorkspaces: this._windowWorkspaces,
            windowWSIndices: this._windowWSIndices,
            lastFocusedPerWorkspace: this._lastFocusedPerWorkspace,
            lastRealFocusedWindow: this._lastRealFocusedWindow,
            // Scratchpad membership + toggle-float status were LOST on
            // every lock/unlock (the maps were nulled and rebuilt empty,
            // so scratch windows silently re-tiled and float-toggled
            // windows snapped back into the layout) — stash them with
            // the tiling state.
            scratchpadWindows: this._scratchpadWindows,
            toggleFloatWindows: this._toggleFloatWindows,
            scratchpadVisible: this._scratchpadVisible,
            // Learned size minimums (apps that report none) must survive
            // the lock cycle too, or the clamp loses its floor until they
            // are re-learned.
            observedMinSizes: this._observedMinSizes,
        };
        this._debugLog(`disable: tiling state stashed (trees=${this._bspTrees ? this._bspTrees.size : 0})`);
    }
    this._removeAllSources();
    if (this._pickFocusId) {
        global.display.disconnect(this._pickFocusId);
        this._pickFocusId = null;
    }
    if (_lockModeId) {
        // Unpaired shell-lifetime signal: the handler captures `this`
        // (the extension instance) for the life of the shell otherwise.
        Main.sessionMode.disconnect(_lockModeId);
        _lockModeId = 0;
    }
    // NOTE: pending retile/border sources are removed by
    // _disconnectSignals() below — removing them here too made GLib log
    // "Source ID not found" (double remove). disable() runs
    // synchronously, so nothing can dispatch between here and there.
    if (this._stackSettleId) {
        GLib.source_remove(this._stackSettleId);
        this._stackSettleId = 0;
    }
    this._stopLiveResizeLoop();
    this._disconnectGrabBoundaryHooks();
    // A disable mid-grab would otherwise leave _grabOp set: every retile
    // early-returns until a grab-op-end that never comes.
    this._grabOp = null;
    this._grabWindow = null;
    this._removeAllBorders();
    this._destroyDropPreview();
    this._destroyDropOverlay();
    this._cancelAnimation();
    if (this._layoutPopupHideId) {
        GLib.source_remove(this._layoutPopupHideId);
        this._layoutPopupHideId = 0;
    }
    if (this._layoutPopup) {
        this._layoutPopup.remove_all_transitions();
        this._layoutPopup.destroy();
        this._layoutPopup = null;
    }
    this._restoreWorkspaceSwitcherPopup();
    if (this._shellSettings) {
        if (this._shellSettingsChangedId) {
            this._shellSettings.disconnect(this._shellSettingsChangedId);
        }
        this._shellSettings = null;
    }
    if (this._jpSettings) {
        if (this._jpSettingsChangedId) {
            this._jpSettings.disconnect(this._jpSettingsChangedId);
        }
        this._jpSettings = null;
    }
    this._shellSettingsChangedId = 0;
    this._jpSettingsChangedId = 0;
    this._clearDropdownWindow();
    this._clearDropdownWaiters();
    this._restoreWorkspacePill();
    this._clearBackgroundApp();
    if (this._backgroundAppSettingsChangedId) {
        this._settings.disconnect(this._backgroundAppSettingsChangedId);
        this._backgroundAppSettingsChangedId = 0;
    }
    if (this._backgroundAppEnabledChangedId) {
        this._settings.disconnect(this._backgroundAppEnabledChangedId);
        this._backgroundAppEnabledChangedId = 0;
    }
    if (this._backgroundAppRestartId) {
        GLib.source_remove(this._backgroundAppRestartId);
        this._backgroundAppRestartId = 0;
    }
    this._teardownPointerFocus();
    if (this._pointerFocusEnabledId) {
        this._settings.disconnect(this._pointerFocusEnabledId);
        this._pointerFocusEnabledId = 0;
    }
    this._dropdownPending = false;
    if (this._dropdownPendingId) {
        GLib.source_remove(this._dropdownPendingId);
        this._dropdownPendingId = 0;
    }
    if (this._dropdownSettingsChangedId) {
        this._settings.disconnect(this._dropdownSettingsChangedId);
        this._dropdownSettingsChangedId = 0;
    }
    if (this._dropdownHeightChangedId) {
        this._settings.disconnect(this._dropdownHeightChangedId);
        this._dropdownHeightChangedId = 0;
    }
    if (this._warningPopupId) {
        GLib.source_remove(this._warningPopupId);
        this._warningPopupId = 0;
    }
    if (this._warningPopup) {
        this._warningPopup.remove_all_transitions();
        this._warningPopup.destroy();
        this._warningPopup = null;
    }
    if (this._pendingWarningOverviewId) {
        Main.overview.disconnect(this._pendingWarningOverviewId);
        this._pendingWarningOverviewId = 0;
    }
    this._pendingWarning = null;
    this._scratchpadWindows = null;
    this._scratchpadVisible = false;
    this._stopBorderAnimation();
    this._disconnectSignals();
    this._mutterSettings = null;
    this._destroyFloatPickDialog();
    this._destroyConflictDialog();
    this._removeKeybindings();
    this._settings = null;
    this._floatingClasses = null;
    this._floatingTitles = null;
    this._floatingTitlePatterns = null;
    this._floatProcessCache = null;
    this._minSizeOverrides = null;
    this._toggleFloatWindows = null;
    this._floatMaxRects = null;
    this._gappedMaxSet = null;
    this._windowBorders = null;
    this._scratchpadRings = null;
    this._removeAllMasks();
    this._windowMasks = null;
    this._removeAllBlurs();
    this._windowBlurs = null;
    this._sourceIds = null;
    this._slotReassertTimes = null;
    this._workspaceOrders = null;
    this._windowWorkspaces = null;
    this._windowWSIndices = null;
    this._workspaceLayouts = null;
    this._masterRatios = null;
    this._stackRatios = null;
    this._bspTrees = null;
    this._dwindleLeafSigs = null;
    this._lastRetileTimes = null;
    this._lastFocusedPerWorkspace = null;
    this._lastRealFocusedWindow = null;
    this._savedRects = null;
    this._signals = null;
    this._grabInitialMasterRatio = 0;
    this._grabInitialStackRatios = null;
    this._animTargets = null;
    this._animWindows = null;
    if (this._floatHooks) {
        for (const win of [...this._floatHooks.keys()])
            this._disconnectFloatHooks(win);
    }
    this._floatHooks = null;
    this._newWindowSet = null;
    this._queuedAnimWorkspaces = null;
    this._animStartedAt = 0;
    this._landingRetries = null;
    this._mismatchFrames = null;
    this._landingGivenUp = null;
    this._observedMinSizes = null;
    this._minLimitedWindows = null;
    this._pendingWarp = null;
    this._lastMonitorsGeom = null;
    this._pinnedAdjustCounts = null;
    this._stackDiagnostics = null;
    this._maximizeToggleRects = null;
}

function restoreTilingState(ext) {
    const s = _stashedTiling;
    _stashedTiling = null;
    if (!s) return;

    const alive = (win) => {
        try {
            return !!(win && win.get_compositor_private());
        } catch (_e) {
            return false;
        }
    };
    // Prune windows that died while locked.
    for (const [win] of s.windowWorkspaces) {
        if (!alive(win)) {
            s.windowWorkspaces.delete(win);
            s.windowWSIndices.delete(win);
        }
    }
    for (const [win] of s.windowWSIndices) {
        if (!alive(win))
            s.windowWSIndices.delete(win);
    }
    for (const [ws, order] of s.workspaceOrders) {
        if (!order) continue;
        s.workspaceOrders.set(ws, order.filter(alive));
    }
    for (const [ws, tree] of s.bspTrees) {
        if (!tree) continue;
        let t = tree;
        for (const w of ext._bspCollectWindows(tree)) {
            if (!alive(w))
                t = ext._bspRemove(t, w);
        }
        s.bspTrees.set(ws, t);
    }
    // Restore the exact pre-lock state.
    ext._bspTrees = s.bspTrees;
    ext._workspaceLayouts = s.workspaceLayouts;
    ext._masterRatios = s.masterRatios;
    ext._stackRatios = s.stackRatios;
    ext._workspaceOrders = s.workspaceOrders;
    ext._windowWorkspaces = s.windowWorkspaces;
    ext._windowWSIndices = s.windowWSIndices;
    ext._lastFocusedPerWorkspace = s.lastFocusedPerWorkspace;
    if (s.lastRealFocusedWindow && alive(s.lastRealFocusedWindow))
        ext._lastRealFocusedWindow = s.lastRealFocusedWindow;
    // Scratchpad / toggle-float survive lock cycles (the pre-lock
    // maps were stashed; prune members that died while locked).
    if (s.scratchpadWindows) {
        for (const [win] of s.scratchpadWindows) {
            if (!alive(win))
                s.scratchpadWindows.delete(win);
        }
        ext._scratchpadWindows = s.scratchpadWindows;
    }
    if (s.toggleFloatWindows) {
        for (const win of s.toggleFloatWindows) {
            if (!alive(win))
                s.toggleFloatWindows.delete(win);
        }
        ext._toggleFloatWindows = s.toggleFloatWindows;
    }
    if (s.scratchpadVisible !== undefined)
        ext._scratchpadVisible = !!s.scratchpadVisible;
    if (s.observedMinSizes) {
        for (const [w] of s.observedMinSizes) {
            if (!alive(w))
                s.observedMinSizes.delete(w);
        }
        ext._observedMinSizes = s.observedMinSizes;
    }
    ext._debugLog(`tiling state restored (windows=${ext._windowWorkspaces.size} trees=${ext._bspTrees.size})`);

}
