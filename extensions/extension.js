import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ModalDialog } from 'resource:///org/gnome/shell/ui/modalDialog.js';
import { WorkspaceSwitcherPopup }
    from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { helperMethods } from './modules/helpers.js';
import { geometryMethods } from './modules/geometry.js';
import { bspMethods } from './modules/bsp.js';
import { borderMathMethods } from './modules/border-math.js';
import { blurMethods, bumpMonitorDims } from './modules/blur.js';
import { sessionState } from './modules/session-state.js';
import { backgroundAppMethods } from './modules/background-app.js';
import { maskMethods } from './modules/mask.js';
import { borderWidgetMethods } from './modules/borders.js';
import { keybindMethods } from './modules/keybindings.js';
import { scratchpadMethods } from './modules/scratchpad.js';
import { dropdownMethods } from './modules/dropdown-terminal.js';
import { pointerFocusMethods } from './modules/pointer-focus.js';
import { workspacePillMethods } from './modules/workspace-pill.js';
import { terminalSettingsMethods } from './modules/terminal-settings.js';

const LAYOUT_NAMES = {
    'dwindle': 'Dwindle',
    'master-stack': 'Master-stack',
    'centered-master-stack': 'Centered Master-stack',
    'floating': 'Floating',
};


// True once the extension has been enabled at least once in this shell
// process. A manual disable/enable (or any re-enable that isn't a fresh
// login) must register pre-existing windows as a resume — running the
// new-window choreography on them force-shows other-workspace windows
// (the actor.visible reveal overrides the workspace manager's hiding).
// enable() captures the PREVIOUS value before setting it — the resume
// decision is "was it enabled before this enable()".
let _enabledThisShell = false;

// Set when the session enters the lock screen (see modules/session-state.js).
let _lockModeId = 0;

// Tiling state stashed at the lock-cycle disable and restored at the unlock
// re-enable, so windows keep their exact arrangement across the cycle. The
// window/workspace objects survive the lock, so the maps stay valid.
let _stashedTiling = null;



export default class TilingWMExtension extends Extension {
    enable() {
        const wasEnabled = _enabledThisShell;
        _enabledThisShell = true;
        try {
            // Meta.is_wayland_compositor does not exist on GNOME 50/51 (the
            // old check was inert — the rejection never fired), and neither
            // Backend.get_wayland_display nor WaylandCompositor.get_default
            // are introspectable. The working chain: the backend's context
            // exposes get_wayland_compositor() — non-null on Wayland, NULL
            // on X11. Any failure defaults to permissive (never block a
            // real Wayland session).
            let isWayland = true;
            try {
                if (global.backend.get_context) {
                    const ctx = global.backend.get_context();
                    if (ctx && typeof ctx.get_wayland_compositor === 'function')
                        isWayland = !!ctx.get_wayland_compositor();
                }
            } catch (_e) {}
            if (!isWayland) {
                this._notifyCritical('Plaid', 'Plaid requires Wayland — the extension is disabled on X11.');
                log('[plaid] disabled: Wayland-only (X11 session detected)');
                return;
            }
        } catch (_e) {}
        // Track lock-screen cycles: the shell disables extensions on lock and
        // re-enables them on unlock. The module-level flag lets disable()/
        // enable() resume instead of teardown-and-restart. Belt-and-suspenders:
        // the mode signal fires synchronously at the push, while disable()
        // also checks Main.sessionMode.isLocked directly.
        if (!_lockModeId && Main.sessionMode) {
            try {
                _lockModeId = Main.sessionMode.connect('updated', (sm) => {
                    if (sm.currentMode === 'lock' || sm.currentMode === 'unlock-dialog')
                        sessionState.lockCycle = true;
                    this._debugLog(`session mode: ${sm.currentMode} lockCycle=${sessionState.lockCycle}`);
                });
            } catch (_e) {}
        }
        this._destroyed = false;
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
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._destroyed) return false;
            try { this._purgeOrphanBlurs(); } catch (_e) {}
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
        // Explicit zero-init (2026-10-04 audit): disable() reads these
        // BEFORE any assignment; an undefined field was only accidentally
        // safe (falsey) — any future truthy default would double-remove a
        // source id.
        this._stackSettleId = 0;
        this._pickFocusId = null;
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
        this._plaidSetupNoticeTerminal = false;
        this._plaidTerminalProfilePath = '';
        this._setupPopupCheckId = 0;
        this._maximizeToggleRects = new Map();
        this._backgroundAppPending = false;
        this._backgroundAppSpawnRetries = 0;
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

        this._disableMutterDefaults();
        this._migrateKeybindingDefaults();
        this._dropOverlay = new St.Widget({
            reactive: false,
            visible: true,
        });
        Main.layoutManager.uiGroup.add_child(this._dropOverlay);
        this._animating = false;
        this._animTargets = null;
        this._animStates = null;
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
        this._plaidTerminalProfileNotified = false;
        this._initWorkspacePill();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            if (this._settings && this._settings.get_boolean('terminal-profile-integration'))
                this._ensureTerminalSettingsProfile();
            else
                this._removeTerminalSettingsProfile();
            return GLib.SOURCE_REMOVE;
        });
        this._initBackgroundApp();
        this._initPointerFocus();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._destroyed) return false;
            this._updateDropOverlaySize();
            const resumeLockCycle = sessionState.lockCycle;
            // Any re-enable within this shell (lock cycle OR manual toggle)
            // must register pre-existing windows as a resume — running the
            // new-window choreography on them force-shows other-workspace
            // windows via the actor.visible reveal.
            const resumeLike = sessionState.lockCycle || wasEnabled;
            if (resumeLike && _stashedTiling)
                this._restoreTilingState();
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

    _restoreTilingState() {
        const s = _stashedTiling;
        _stashedTiling = null;
        if (!s) return;
        try {
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
                for (const w of this._bspCollectWindows(tree)) {
                    if (!alive(w))
                        t = this._bspRemove(t, w);
                }
                s.bspTrees.set(ws, t);
            }
            // Restore the exact pre-lock state.
            this._bspTrees = s.bspTrees;
            this._workspaceLayouts = s.workspaceLayouts;
            this._masterRatios = s.masterRatios;
            this._stackRatios = s.stackRatios;
            this._workspaceOrders = s.workspaceOrders;
            this._windowWorkspaces = s.windowWorkspaces;
            this._windowWSIndices = s.windowWSIndices;
            this._lastFocusedPerWorkspace = s.lastFocusedPerWorkspace;
            if (s.lastRealFocusedWindow && alive(s.lastRealFocusedWindow))
                this._lastRealFocusedWindow = s.lastRealFocusedWindow;
            // Scratchpad / toggle-float survive lock cycles (the pre-lock
            // maps were stashed; prune members that died while locked).
            if (s.scratchpadWindows) {
                for (const [win] of s.scratchpadWindows) {
                    if (!alive(win))
                        s.scratchpadWindows.delete(win);
                }
                this._scratchpadWindows = s.scratchpadWindows;
            }
            if (s.toggleFloatWindows) {
                for (const win of s.toggleFloatWindows) {
                    if (!alive(win))
                        s.toggleFloatWindows.delete(win);
                }
                this._toggleFloatWindows = s.toggleFloatWindows;
            }
            if (s.scratchpadVisible !== undefined)
                this._scratchpadVisible = !!s.scratchpadVisible;
            this._debugLog(`tiling state restored (windows=${this._windowWorkspaces.size} trees=${this._bspTrees.size})`);
        } catch (e) {
            log(`[plaid] tiling state restore failed: ${e.message}`);
            // Fall back to a clean rebuild if anything went wrong.
            this._bspTrees = new Map();
            this._dwindleLeafSigs = new Map();
            this._workspaceOrders = new Map();
            this._windowWorkspaces = new Map();
            this._windowWSIndices = new Map();
        }
    }

    _currentTime() {
        try { return global.get_current_time(); } catch (_e) { return 0; }
    }

    _wsIndex(ws) {
        if (!ws) return -1;
        try { return ws.index(); } catch (_e) {}
        try {
            for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
                if (global.workspace_manager.get_workspace_by_index(i) === ws) return i;
            }
        } catch (_e) {}
        return -1;
    }

    disable() {
        // X11 early-return path in enable() never initialized the instance
        // fields — teardown must not touch them.
        if (!this._settings) return;
        // Lock-screen cycles: the shell switches to the lock mode and disables
        // extensions not whitelisted for it, then re-enables them on unlock.
        // isLocked is already true when this runs, so the module-level flag is
        // set in time for the teardown below to keep the bg-app alive and for
        // the upcoming re-enable to resume instead of relaunching.
        const mode = Main.sessionMode ? Main.sessionMode.currentMode : '?';
        const isLocked = !!(Main.sessionMode && Main.sessionMode.isLocked);
        if (isLocked)
            sessionState.lockCycle = true;
        this._debugLog(`disable: mode=${mode} isLocked=${isLocked} lockCycle=${sessionState.lockCycle}`);
        // Flush any pending per-ws layout/ratio persistence (insurance — the
        // debounced save may not have fired before the teardown).
        if (this._workspaceLayoutsSaveId) {
            GLib.source_remove(this._workspaceLayoutsSaveId);
            this._workspaceLayoutsSaveId = 0;
        }
        try { this._savePersistedLayouts(); } catch (_e) {}
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
                // the tiling state (2026-10-04 audit).
                scratchpadWindows: this._scratchpadWindows,
                toggleFloatWindows: this._toggleFloatWindows,
                scratchpadVisible: this._scratchpadVisible,
            };
            this._debugLog(`disable: tiling state stashed (trees=${this._bspTrees ? this._bspTrees.size : 0})`);
        }
        this._destroyed = true;
        if (this._pickFocusId) {
            try { global.display.disconnect(this._pickFocusId); } catch (_e) {}
            this._pickFocusId = null;
        }
        if (_lockModeId) {
            // Unpaired shell-lifetime signal: the handler captures `this`
            // (the extension instance) for the life of the shell otherwise.
            try { Main.sessionMode.disconnect(_lockModeId); } catch (_e) {}
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
        this._restoreMutterDefaults();
        this._removeAllBorders();
        this._destroyDropPreview();
        if (this._dropOverlay) {
            this._dropOverlay.destroy();
            this._dropOverlay = null;
        }
        this._cancelAnimation();
        if (this._layoutPopupHideId) {
            GLib.source_remove(this._layoutPopupHideId);
            this._layoutPopupHideId = 0;
        }
        if (this._layoutPopup) {
            try { this._layoutPopup.remove_all_transitions(); } catch (_e) {}
            try { this._layoutPopup.destroy(); } catch (_e) {}
            this._layoutPopup = null;
        }
        this._restoreWorkspaceSwitcherPopup();
        if (this._shellSettings) {
            if (this._shellSettingsChangedId) {
                try { this._shellSettings.disconnect(this._shellSettingsChangedId); } catch (_e) {}
            }
            this._shellSettings = null;
        }
        if (this._jpSettings) {
            if (this._jpSettingsChangedId) {
                try { this._jpSettings.disconnect(this._jpSettingsChangedId); } catch (_e) {}
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
            try { this._settings.disconnect(this._backgroundAppSettingsChangedId); } catch (_e) {}
            this._backgroundAppSettingsChangedId = 0;
        }
        if (this._backgroundAppEnabledChangedId) {
            try { this._settings.disconnect(this._backgroundAppEnabledChangedId); } catch (_e) {}
            this._backgroundAppEnabledChangedId = 0;
        }
        if (this._backgroundAppRestartId) {
            GLib.source_remove(this._backgroundAppRestartId);
            this._backgroundAppRestartId = 0;
        }
        this._teardownPointerFocus();
        if (this._pointerFocusEnabledId) {
            try { this._settings.disconnect(this._pointerFocusEnabledId); } catch (_e) {}
            this._pointerFocusEnabledId = 0;
        }
        this._dropdownPending = false;
        if (this._dropdownPendingId) {
            GLib.source_remove(this._dropdownPendingId);
            this._dropdownPendingId = 0;
        }
        if (this._dropdownSettingsChangedId) {
            try { this._settings.disconnect(this._dropdownSettingsChangedId); } catch (_e) {}
            this._dropdownSettingsChangedId = 0;
        }
        if (this._dropdownHeightChangedId) {
            try { this._settings.disconnect(this._dropdownHeightChangedId); } catch (_e) {}
            this._dropdownHeightChangedId = 0;
        }
        if (this._warningPopupId) {
            GLib.source_remove(this._warningPopupId);
            this._warningPopupId = 0;
        }
        if (this._warningPopup) {
            try { this._warningPopup.remove_all_transitions(); } catch (_e) {}
            try { this._warningPopup.destroy(); } catch (_e) {}
            this._warningPopup = null;
        }
        if (this._pendingWarningOverviewId) {
            try { Main.overview.disconnect(this._pendingWarningOverviewId); } catch (_e) {}
            this._pendingWarningOverviewId = 0;
        }
        this._pendingWarning = null;
        this._scratchpadWindows = null;
        this._scratchpadVisible = false;
        this._stopBorderAnimation();
        this._disconnectSignals();
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
        try { this._removeAllMasks(); } catch (_e) {}
        this._windowMasks = null;
        try { this._removeAllBlurs(); } catch (_e) {}
        this._windowBlurs = null;
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
        this._pendingWarp = null;
        this._lastMonitorsGeom = null;
        this._pinnedAdjustCounts = null;
        this._stackDiagnostics = null;
        this._maximizeToggleRects = null;
    }

    _connectSignals() {
        this._addSignal(global.display, global.display.connect('window-created', (_d, win) => {
            if (this._handleDropdownWindowCreated(win)) return;
            if (this._handleBackgroundAppWindowCreated(win)) return;
            if (this._shouldManage(win)) {
                this._addWindow(win);
                const doRetile = () => {
                    if (this._destroyed) return;
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
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        this._markPendingWindowInvisible(win, win.get_compositor_private());
                        doRetile();
                        return false;
                    });
                }
            } else if (this._isFloating(win)) {
                const doRestore = () => {
                    if (this._destroyed) return;
                    this._restoreFloatNaturalRect(win);
                };
                const actor = win.get_compositor_private();
                if (actor) {
                    const firstFrameId = actor.connect('first-frame', () => {
                        actor.disconnect(firstFrameId);
                        if (this._destroyed || !this._settings) return;
                        doRestore();
                        if (this._settings.get_boolean('follow-focus') &&
                            win.get_window_type() === Meta.WindowType.NORMAL)
                            this._cursorWarpDeferred(win);
                        this._connectFloatHooks(win);
                        this._updateBorders();
                    });
                } else {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        if (this._destroyed || !this._settings) return false;
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
                    this._lastRealFocusedWindow = win;
                    const ws = win.get_workspace();
                    if (ws) this._lastFocusedPerWorkspace.set(ws, win);
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
            try {
                this._updateDropOverlaySize();
                this._refillBackgroundApp();
                this._retileAll();
                const mon = global.display.get_monitor_geometry(global.display.get_primary_monitor());
                if (mon) this._lastMonitorsGeom = mon;
            } catch (e) {
                log(`[plaid] monitors-changed failed: ${e.message}`);
            }
            this._debugLog('monitors-changed handled');
        }));
        try {
            if (this._mutterSettings) {
                this._addSignal(this._mutterSettings, this._mutterSettings.connect(
                    'changed::dynamic-workspaces', () => this._checkDynamicWorkspaces()));
            }
        } catch (_e) {}
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
                    this._lastRetileTimes?.delete(workspace);
                    // The workspace-object-keyed maps missed here: a
                    // retained wrapper + a pending retile timeout that
                    // later fires against a dead workspace (2026-10-04
                    // audit).
                    this._dwindleLeafSigs?.delete(workspace);
                    this._queuedAnimWorkspaces?.delete(workspace);
                    if (this._pendingRetileIds?.has(workspace)) {
                        try { GLib.source_remove(this._pendingRetileIds.get(workspace)); } catch (_e) {}
                        this._pendingRetileIds.delete(workspace);
                    }
                    this._scheduleSaveLayouts();
                }
            }
        }));
        this._addSignal(global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', () => {
            this._syncDropdownWorkspace();
            this._raiseBackgroundAppClone();
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (this._destroyed) return false;
                this._raiseBackgroundAppClone();
                return false;
            });
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                if (this._destroyed) return GLib.SOURCE_REMOVE;
                this._raiseBackgroundAppClone();
                return GLib.SOURCE_REMOVE;
            });
        }));
        this._addSignal(global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', () => {
            if (this._destroyed || !this._settings.get_boolean('enabled')) return;
            const ws = global.workspace_manager.get_active_workspace();
            if (!ws) return;
            try {
                if (this._settings.get_boolean('workspace-popup'))
                    this._showWorkspacePopup(ws);
            } catch (_e) {}
            // Re-assert float layering + refresh Flair after the switch
            // settles (the restacked signal can fire before the reveal
            // ordering is final).
            try { this._reassertFloatingTransients(); } catch (_e) {}
            try { this._updateBorders(); } catch (_e) {}
            try { this._auditWorkspaceLandings(ws); } catch (_e) {}
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
                try { GLib.source_remove(this._stackSettleId); } catch (_e) {}
                this._stackSettleId = 0;
            }
            let settleTicks = 0;
            let settleChanged = false;
            this._stackSettleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                if (this._destroyed || ++settleTicks > 30) {
                    this._stackSettleId = 0;
                    // Borders refresh ONLY when the poll corrected something:
                    // an unconditional pass re-uploads mask uniforms +
                    // stage queue_redraw — a visible flash on calm switches
                    // where nothing needed fixing.
                    if (!this._destroyed && settleChanged) {
                        try { this._updateBorders(); } catch (_e) {}
                    }
                    return GLib.SOURCE_REMOVE;
                }
                try { if (this._syncBlurStackingNow()) settleChanged = true; } catch (_e) {}
                try { if (this._reassertFloatingTransients()) settleChanged = true; } catch (_e) {}
                return GLib.SOURCE_CONTINUE;
            });
            const windows = this._getWindowsForWorkspace(ws);
            if (windows.length === 0) return;
            let target = this._lastFocusedPerWorkspace.get(ws);
            if (!target || !windows.includes(target)) {
                target = windows[0];
            }
            this._keyboardFocusChange = true;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (this._destroyed) return false;
                try { target.activate(this._currentTime()); } catch (_e) {}
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
        this._addSignal(this._settings, this._settings.connect('changed::terminal-profile-integration', () => {
            if (this._settings.get_boolean('terminal-profile-integration'))
                this._ensureTerminalSettingsProfile();
            else
                this._removeTerminalSettingsProfile();
        }));

        this._connectGrabSignals();

    }

    _addSignal(emitter, id) {
        this._signals.push({ emitter, id });
    }

    _disconnectSignals() {
        if (this._signals) {
            for (const { emitter, id } of this._signals) {
                try { emitter.disconnect(id); } catch (_e) {}
            }
            this._signals = [];
        }
        for (const [win, sigIds] of this._windowSignals || []) {
            for (const { emitter, id } of sigIds) {
                try { emitter.disconnect(id); } catch (_e) {}
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

    _scheduleRetile(workspace) {
        if (this._destroyed || !workspace) return;
        if (this._pendingRetileIds.has(workspace))
            GLib.source_remove(this._pendingRetileIds.get(workspace));
        const now = Date.now();
        const last = this._lastRetileTimes?.get(workspace) || 0;
        const delay = Math.max(0, 50 - (now - last));
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._pendingRetileIds.delete(workspace);
            if (this._destroyed) return false;
            this._doRetileWorkspace(workspace);
            return false;
        });
        this._pendingRetileIds.set(workspace, id);
        this._lastRetileTimes?.set(workspace, now);
    }

    _scheduleBorders() {
        if (this._destroyed) return;
        if (this._pendingBorderId)
            GLib.source_remove(this._pendingBorderId);
        this._pendingBorderId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._pendingBorderId = 0;
            if (this._destroyed) return false;
            try {
                this._doUpdateBorders();
            } catch (e) {
                log(`[plaid] _doUpdateBorders failed: ${e.message}`);
            }
            return false;
        });
    }

    _shouldManage(win) {
        if (this._dropdownWin === win ||
            (this._dropdownWaiters && this._dropdownWaiters.has(win))) return false;
        if (this._backgroundAppWin === win) return false;
        // The bg-app window must never be tiled — even mid-cycle when the new
        // instance hasn't claimed it yet (its skip_taskbar state does not
        // reliably survive a lock cycle). The PLAID_BGAPP env marker on the
        // process identifies it precisely — never the class/token, so user
        // windows of the same app (ghostty) are never excluded.
        try {
            if (this._isBgAppProcessWindow(win))
                return false;
        } catch (_e) {}
        const title = win.get_title();
        if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
        if (win.is_skip_taskbar()) return false;
        if (win.get_transient_for()) return false;
        // The GNOME Extensions app (and its Plaid prefs window) is a settings
        // dialog — keep it out of the tiler so opening prefs never re-arranges
        // the workspace. The process cmdline match works at add time (before
        // the wm-class/GTK app id resolve); the class/app-id checks and the
        // late-identity backstop cover the remaining cases.
        if (this._isExtensionsAppWindow(win))
            return false;
        // Float-listed apps whose wm-class hasn't resolved yet (flatpaks
        // especially) must not be registered as tiled — the process cmdline
        // is available immediately (cached per PID).
        if (this._isFloatProcessWindow(win))
            return false;
        if (this._floatClassMatches(win)) return false;
        if (this._floatingTitleMatches(title)) return false;
        if (this._isFixedSizeWindow(win)) return false;
        return true;
    }

    _moveCursorToWindow(win) {
        try {
            const frame = win.get_frame_rect();
            if (frame.width === 0 || frame.height === 0) return false;
            const centerX = frame.x + frame.width / 2;
            const centerY = frame.y + frame.height / 2;
            // mutter-51 removed Clutter.get_default_backend (the 51.β→.rc
            // window); the context-accessor route works on both 50 and 51.
            const backend = (typeof Clutter.get_default_backend === 'function')
                ? Clutter.get_default_backend()
                : global.stage.get_context().get_backend();
            const seat = backend.get_default_seat();
            seat.warp_pointer(centerX, centerY);
            return true;
        } catch (e) {
            log(`[plaid] _moveCursorToWindow failed: ${e.message}`);
            return false;
        }
    }

    _cursorWarpDeferred(win) {
        if (this._destroyed) return;
        let prevFrame = null;
        let retries = 0;
        const MAX_RETRIES = 6;
        const tryWarp = () => {
            if (this._destroyed || retries >= MAX_RETRIES) return false;
            retries++;
            if (!win || !win.get_workspace()) return false;
            const frame = win.get_frame_rect();
            if (frame.width === 0 || frame.height === 0) return true;
            if (prevFrame && frame.x === prevFrame.x && frame.y === prevFrame.y &&
                frame.width === prevFrame.w && frame.height === prevFrame.h) {
                this._moveCursorToWindow(win);
                return false;
            }
            prevFrame = { x: frame.x, y: frame.y, w: frame.width, h: frame.height };
            return true;
        };
        if (tryWarp()) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, tryWarp);
        }
    }

    _isFloating(win) {
        if (this._toggleFloatWindows && this._toggleFloatWindows.has(win)) return true;
        if (this._floatClassMatches(win)) return true;
        const title = win.get_title();
        if (this._floatingTitleMatches(title)) return true;
        // Process-based fallback: at window-created the wm-class may not be
        // resolved yet (flatpak apps especially), so a float-listed app would
        // be registered as tiled and churn the retile pipeline at launch.
        // The process cmdline is available immediately — and the verdict is
        // cached per PID (process-lifetime stable).
        if (this._isFloatProcessWindow(win)) return true;
        if (win.is_fullscreen()) return true;
        if (win.get_window_type() !== Meta.WindowType.NORMAL) return true;
        if (win.is_skip_taskbar()) return true;
        if (win.get_transient_for()) return true;
        if (this._isFixedSizeWindow(win)) return true;
        return false;
    }

    _isFloatProcessWindow(win) {
        if (!win) return false;
        let pid = 0;
        try { pid = win.get_pid(); } catch (_e) {}
        if (pid <= 0) return false;
        if (this._floatProcessCache) {
            const cached = this._floatProcessCache.get(pid);
            if (cached !== undefined) return cached;
        }
        let verdict = false;
        try {
            const [, data] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
            if (data) {
                const cmd = new TextDecoder().decode(data).replace(/\0/g, ' ').toLowerCase();
                for (const token of this._floatingClasses) {
                    if (!token || token.length < 3) continue;
                    if (cmd.includes(token)) {
                        verdict = true;
                        break;
                    }
                }
            }
        } catch (_e) {}
        if (this._floatProcessCache) {
            if (this._floatProcessCache.size >= 256)
                this._floatProcessCache.clear();
            this._floatProcessCache.set(pid, verdict);
        }
        return verdict;
    }

    _isFixedSizeWindow(win) {
        // Non-resizable windows: Mutter refuses atomic move_resize_frame
        // placements, so tiling them only buys a ~2s retry dance before the
        // give-up float. A min===max hint is the cheap, reliable signal —
        // float such windows up front instead.
        const [mw, mh] = win.get_min_size();
        const [xw, xh] = win.get_max_size();
        return mw > 0 && xw > 0 && mw === xw && mh === xh;
    }

    _getWorkspaceOrder(workspace) {
        if (!this._workspaceOrders.has(workspace))
            this._workspaceOrders.set(workspace, []);
        return this._workspaceOrders.get(workspace);
    }

    _getWorkspaceLayout(workspace) {
        // Live overrides, remembered slot rules, and the default all live in
        // the SAME index space — the lookup is deterministic per workspace
        // index, so a recreated workspace (dynamic-workspace churn) resolves
        // identically every time. Object-keyed live entries caused layout
        // flip-flops when workspaces were removed and recreated.
        const idx = this._wsIndex(workspace);
        const live = this._workspaceLayouts.get(idx);
        if (live) return live;
        if (this._persistedLayoutByIndex && this._persistedLayoutByIndex.size > 0) {
            const rule = this._persistedLayoutByIndex.get(idx);
            if (rule) return rule;
        }
        return this._settings.get_string('layout');
    }

    // --- Per-workspace layout/ratio persistence (across logins) ---

    _scheduleSaveLayouts() {
        // Trailing (quiet-period) debounce: every change RESETS the timer,
        // so exactly ONE write lands 10s after interaction STOPS. The old
        // fixed-500ms-from-first-event window wrote to dconf every ~500ms
        // during sustained resize/retile activity (253 writes in 2 days;
        // 1/sec bursts in the 2026-10-04 resize-testing journal).
        if (this._destroyed || !this._settings) return;
        const now = Date.now();
        if (!this._saveDirtySince) this._saveDirtySince = now;
        // Starvation cap: under back-to-back activity the quiet timer keeps
        // getting reset — force a save once we've been continuously dirty
        // for 60s, so a crash loses at most ~60s of layout changes.
        // (disable() flushes synchronously regardless.)
        if (now - this._saveDirtySince >= 60000) {
            if (this._workspaceLayoutsSaveId) {
                GLib.source_remove(this._workspaceLayoutsSaveId);
                this._workspaceLayoutsSaveId = 0;
            }
            this._saveDirtySince = 0;
            this._savePersistedLayouts();
            return;
        }
        if (this._workspaceLayoutsSaveId)
            GLib.source_remove(this._workspaceLayoutsSaveId);
        this._workspaceLayoutsSaveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
            this._workspaceLayoutsSaveId = 0;
            if (this._destroyed || !this._settings) return GLib.SOURCE_REMOVE;
            this._saveDirtySince = 0;
            this._savePersistedLayouts();
            return GLib.SOURCE_REMOVE;
        });
    }

    _savePersistedLayouts() {
        try {
            const layouts = [];
            const masterRatios = [];
            const stackRatios = [];
            const dwindleRaw = new Map(this._persistedDwindleRaw || []);
            const n = global.workspace_manager.get_n_workspaces();
            for (let i = 1; i < n; i++) {
                const ws = global.workspace_manager.get_workspace_by_index(i);
                if (!ws) continue;
                // "The layout last used is the persistent one" — store the
                // effective layout of every real workspace (the parking ws at
                // index 0 is never stored).
                layouts.push(`${i}:${this._getWorkspaceLayout(ws)}`);
                const mr = this._masterRatios.get(i);
                if (mr !== undefined)
                    masterRatios.push(`${i}:${mr}`);
                const sr = this._stackRatios.get(i);
                if (sr && sr.size > 0) {
                    const idx = [];
                    for (const [k, v] of sr)
                        idx.push(`${k}:${v}`);
                    stackRatios.push(`${i}:${idx.join(',')}`);
                }
                // Dwindle trees are in-memory only — serialize the shape+
                // ratios (no window refs) so resized arrangements (e.g. a
                // big Steam + narrow friends strip) survive logins.
                //
                // MERGE, don't rebuild (2026-10-04 — the steam/ws3 failure):
                // the old full-strv rewrite dropped every workspace with no
                // live tree at save time — at boot the FIRST save (triggered
                // by ws1's windows) deleted ws3's shape before Steam had even
                // opened, so steam+friends came back 50/50 while ws1
                // restored fine. Mid-session churn had the same effect in
                // reverse: a collapsed single-leaf tree degraded a good
                // shape to 'l'/'e' (logout window kills, steam client
                // restarts, friends closing). Rule: only a live 2+-window
                // tree (a real arrangement) may overwrite an entry; no
                // tree / leaf / empty PRESERVES the previously-saved shape.
                const tree = this._bspTrees.get(ws);
                if (tree && tree.type === 'split' &&
                    this._getWorkspaceLayout(ws) === 'dwindle')
                    dwindleRaw.set(i, this._dwindleShapeToString(tree));
            }
            this._settings.set_strv('workspace-layouts', layouts);
            this._settings.set_strv('workspace-master-ratios', masterRatios);
            this._settings.set_strv('workspace-stack-ratios', stackRatios);
            // Write merged dwindle shapes: non-split leftovers (stale 'l'/'e'
            // products of the old code) are filtered out, entries for
            // workspaces beyond the current count survive, and the raw map
            // is re-synced to exactly what we wrote.
            const dwindleTrees = [];
            for (const [i, shape] of dwindleRaw) {
                const node = this._dwindleShapeFromString(shape);
                if (node && node.type === 'split')
                    dwindleTrees.push(`${i}:${shape}`);
            }
            dwindleTrees.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
            this._settings.set_strv('workspace-dwindle-trees', dwindleTrees);
            this._persistedDwindleRaw = new Map(
                dwindleTrees.map(e => [parseInt(e, 10), e.substring(e.indexOf(':') + 1)]));
            this._debugLog(`persisted layouts: ${layouts.length} ws, ${masterRatios.length} master, ${stackRatios.length} stack, ${dwindleTrees.length} dwindle`);
        } catch (e) {
            log(`[plaid] persist layouts failed: ${e.message}`);
        }
    }

    _loadPersistedLayoutRules() {
        // Persisted layouts/ratios are RULES keyed by workspace slot (index):
        // "whatever workspace occupies slot N uses layout Y". Rules are parsed
        // once at enable and consulted by the getters at use time — no binding
        // to workspace objects (which churn during login restores) and no
        // load timing to get wrong. Rules for slots beyond the current
        // workspace count persist and apply when those slots spawn.
        this._persistedLayoutByIndex = new Map();
        this._persistedMasterByIndex = new Map();
        this._persistedStackByIndex = new Map();
        this._persistedDwindleByIndex = this._parsePersistedDwindleShapes();
        try {
            const layouts = this._settings.get_strv('workspace-layouts') || [];
            for (const entry of layouts) {
                const [idxStr, layout] = entry.split(':');
                const idx = parseInt(idxStr, 10);
                if (idx <= 0 || !Number.isInteger(idx)) continue;
                if (!['dwindle', 'master-stack', 'centered-master-stack', 'floating'].includes(layout)) continue;
                this._persistedLayoutByIndex.set(idx, layout);
            }
            const masterEntries = this._settings.get_strv('workspace-master-ratios') || [];
            for (const entry of masterEntries) {
                const [idxStr, ratioStr] = entry.split(':');
                const idx = parseInt(idxStr, 10);
                const ratio = parseFloat(ratioStr);
                if (idx <= 0 || !Number.isInteger(idx) || !Number.isFinite(ratio)) continue;
                if (ratio < 0.05 || ratio > 0.95) continue;
                this._persistedMasterByIndex.set(idx, ratio);
            }
            const stackEntries = this._settings.get_strv('workspace-stack-ratios') || [];
            for (const entry of stackEntries) {
                const [idxStr, weightsStr] = entry.split(':');
                const idx = parseInt(idxStr, 10);
                if (idx <= 0 || !Number.isInteger(idx)) continue;
                const map = new Map();
                for (const part of (weightsStr || '').split(',')) {
                    const [kStr, vStr] = part.split(':');
                    const k = parseInt(kStr, 10);
                    const v = parseFloat(vStr);
                    if (k >= 0 && Number.isFinite(v) && v > 0)
                        map.set(k, v);
                }
                if (map.size > 0)
                    this._persistedStackByIndex.set(idx, map);
            }
            this._debugLog(`persisted rules: ${this._persistedLayoutByIndex.size} layouts, ${this._persistedMasterByIndex.size} master, ${this._persistedStackByIndex.size} stack, ${this._persistedDwindleByIndex.size} dwindle`);
        } catch (e) {
            log(`[plaid] load persisted layout rules failed: ${e.message}`);
        }
    }

    _parsePersistedDwindleShapes() {
        // "index:shape" slot rules, same keying as workspace-layouts:
        // "whatever workspace occupies slot N uses dwindle shape S". The
        // shape carries ONLY structure + ratios (no window refs) — leaves
        // are placeholders; live windows are matched by position at
        // reconcile time. The raw strings are kept alongside (in
        // _persistedDwindleRaw) so saves can MERGE instead of rebuilding —
        // see _savePersistedLayouts.
        const map = new Map();
        const raw = new Map();
        try {
            for (const entry of (this._settings.get_strv('workspace-dwindle-trees') || [])) {
                const sep = entry.indexOf(':');
                if (sep <= 0) continue;
                const idx = parseInt(entry.substring(0, sep), 10);
                if (idx <= 0 || !Number.isInteger(idx)) continue;
                const shapeStr = entry.substring(sep + 1);
                const shape = this._dwindleShapeFromString(shapeStr);
                if (shape) {
                    map.set(idx, shape);
                    raw.set(idx, shapeStr);
                }
            }
        } catch (e) {
            log(`[plaid] parse dwindle shapes failed: ${e.message}`);
        }
        this._persistedDwindleRaw = raw;
        return map;
    }

    _markPendingWindowInvisible(win, actor) {
        if (this._destroyed || !win || !actor) {
            this._debugLog(`hide skip: ${this._destroyed ? 'destroyed' : 'null actor'} class=${win ? (win.get_wm_class_instance() || '?') : '?'}`);
            return;
        }
        if (!this._settings || !this._settings.get_boolean('enabled')) {
            this._debugLog('hide skip: disabled');
            return;
        }
        if (this._isFloating(win)) {
            if (this._settings.get_boolean('follow-focus') &&
                win.get_window_type() === Meta.WindowType.NORMAL)
                this._cursorWarpDeferred(win);
            this._debugLog('hide skip: floating');
            return;
        }
        if (this._getAnimationTime() <= 0) {
            this._debugLog('hide skip: anim-time 0');
            return;
        }
        if (!this._pendingWarp || !this._newWindowSet) {
            this._debugLog('hide skip: maps null');
            return;
        }
        if (!this._newWindowSet.has(win)) {
            this._debugLog('hide skip: not in newWindowSet');
            return;
        }
        try {
            // An invisible actor is never painted — even by the offscreen mask
            // pipeline — so this hide cannot be bypassed by any effect. The
            // actor opacity + mask uniform stay as belt-and-suspenders for the
            // non-mask and partial-cover paths.
            actor.visible = false;
            actor.set_opacity(0);
            this._pendingWarp.add(win);
            try {
                const effect = this._windowMasks && this._windowMasks.get(win);
                if (effect && effect.setOpacityUniform)
                    effect.setOpacityUniform(0);
            } catch (_e) {}
            this._debugLog(`hide applied: ${win.get_wm_class_instance() || '?'}`);
        } catch (_e) {}
        if (!win._plaidInvisibleTimer) {
            win._plaidInvisibleTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
                win._plaidInvisibleTimer = 0;
                if (this._destroyed) return GLib.SOURCE_REMOVE;
                this._debugLog(`backstop reveal: ${win.get_wm_class_instance() || '?'} ws=${this._wsIndex(win.get_workspace())} tiled=${this._windowWorkspaces.has(win)} frame=(${Math.round(win.get_frame_rect().x)},${Math.round(win.get_frame_rect().y)},${Math.round(win.get_frame_rect().width)},${Math.round(win.get_frame_rect().height)})`);
                if (this._pendingWarp) this._pendingWarp.delete(win);
                try {
                    const a = win.get_compositor_private();
                    if (a) {
                        a.visible = true;
                        a.set_opacity(255);
                    }
                } catch (_e) {}
                try {
                    const effect = this._windowMasks && this._windowMasks.get(win);
                    if (effect && effect.setOpacityUniform)
                        effect.setOpacityUniform(1);
                } catch (_e) {}
                // The blur/flair skipped during the pending-warp window must
                // attach once the reveal fires.
                this._scheduleBorders();
                this._updateBorders();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _addWindow(win, resume = false) {
        if (!this._settings) return;
        if (this._windowWorkspaces.has(win)) {
            // Belt-and-braces: if the maps survived a disable/enable but the
            // window signals did not (stale flag from a previous instance),
            // re-arm them instead of leaving the window deaf.
            if (!win._plaidSignalsConnected) this._connectWindowSignals(win);
            return;
        }
        this._debugLog(`ADD_WINDOW: ${this._winClassCandidates(win)[0] || '?'} title=${win.get_title() || '?'} skipTaskbar=${win.is_skip_taskbar()} ws=${this._wsIndex(win.get_workspace())} type=${win.get_window_type()}`);
        // Lock-cycle resumes register windows that are already on screen and
        // tiled — the new-window fade-in (opacity 0 → landing audit → fade
        // back) would make every window vanish and reappear at unlock and
        // break focus. Only real new windows go through it.
        // Tiling toggled off: still REGISTER the window (so flair — borders,
        // mask, blur — keeps rendering via _workspaceOrders) but skip the
        // new-window hide/place choreography entirely. Otherwise a window
        // opened while tiling was off was force-placed at the full work-area
        // slot (and its mask opacity driven to 0 with no retile to reveal it,
        // since every retile path bails on !enabled) — 2026-10-05 audit.
        const tilingEnabled = this._settings.get_boolean('enabled');
        if (!resume && tilingEnabled) {
            this._newWindowSet.add(win);
            try { this._markPendingWindowInvisible(win, win.get_compositor_private()); } catch (_e) {}
        }
        const ws = win.get_workspace();
        this._windowWorkspaces.set(win, ws);
        this._windowWSIndices.set(win, this._wsIndex(ws));
        this._capturePosition(win);
        this._connectWindowSignals(win);
        if (ws) {
            const order = this._getWorkspaceOrder(ws);
            if (!order.includes(win)) {
                order.push(win);
            }
            if (!this._isFloating(win)) {
                const layout = this._getWorkspaceLayout(ws);
                if (layout === 'dwindle')
                    this._bspInsertForWorkspace(ws, win);
            }
        }
        if (!resume && tilingEnabled) {
            // The new window must be invisible AND at its slot before the
            // compositor paints its first frame — otherwise it flashes at
            // GNOME's center spawn point. Two synchronous guarantees:
            // 1) attach the mask now (the borders update can lag behind the
            //    retile pipeline) and drive its opacity uniform to 0 — the
            //    actor opacity is ignored by the offscreen mask, but the
            //    uniform is the shader's real visibility control.
            // 2) place the window at its slot now that it is registered in
            //    the order (the retile later finds it already landed).
            try {
                const actorNow = win.get_compositor_private();
                if (actorNow && this._settings.get_boolean('rounded-corners') &&
                    this._settings.get_int('border-radius') > 0) {
                    this._ensureWindowMask(win, actorNow,
                        this._settings.get_int('border-radius') + 1);
                    const effect = this._windowMasks && this._windowMasks.get(win);
                    if (effect && effect.setOpacityUniform)
                        effect.setOpacityUniform(0);
                }
            } catch (_e) {}
            try {
                const wsNow = win.get_workspace();
                // Placement guard: a window whose identity is still
                // unresolved (no wm-class, no GTK app id) may be float-listed
                // — the class resolves AFTER window-created for flatpaks and
                // for native apps whose /usr/bin/name misses the float-list
                // token (e.g. org.gnome.nautilus vs /usr/bin/nautilus), so
                // _shouldManage registered it as tiled. Pre-mapping it at
                // the single-window full-area slot makes mutter AUTO-MAXIMIZE
                // it on map (placement area > 80% of the work area —
                // MAX_UNMAXIMIZED_WINDOW_AREA in core/place.c), and the later
                // float flip cannot restore the remembered size (the restore
                // refuses maximized windows). Unresolved windows are placed
                // by the first-frame retile, after identity resolution —
                // float-listed ones are then never touched by the tiler and
                // open at their own remembered geometry.
                const idKnown = !!(win.get_wm_class_instance() ||
                    (win.get_gtk_application_id ? win.get_gtk_application_id() : ''));
                if (wsNow && idKnown && !this._isFloating(win)) {
                    const slot = this._windowSlotRect(win, wsNow,
                        this._getWorkspaceLayout(wsNow),
                        wsNow.get_work_area_for_monitor(global.display.get_primary_monitor()),
                        this._settings.get_int('inside-gap'));
                    if (slot && win.get_compositor_private())
                        win.move_resize_frame(true, slot.x, slot.y, slot.w, slot.h);
                }
            } catch (_e) {}
        }
    }

    _removeWindow(win) {
        if (!this._settings) return;
        const ws = this._windowWorkspaces.get(win) || win.get_workspace();
        const wmClass = win.get_wm_class_instance() || '?';
        this._debugLog(`REMOVE_WINDOW: ${wmClass} ws=${this._wsIndex(ws)}`);
        this._windowWorkspaces.delete(win);
        this._windowWSIndices.delete(win);
        this._toggleFloatWindows.delete(win);
        win._plaidFloatAnim = false;
        // Prune the landing/choreography maps so dead windows (and the
        // actors they hold) don't linger until disable.
        if (this._landingRetries) this._landingRetries.delete(win);
        if (this._landingGivenUp) this._landingGivenUp.delete(win);
        if (this._mismatchFrames) this._mismatchFrames.delete(win);
        if (this._slotReassertTimes) this._slotReassertTimes.delete(win);
        if (this._pendingWarp) this._pendingWarp.delete(win);
        if (this._newWindowSet) this._newWindowSet.delete(win);
        if (win._plaidInvisibleTimer) {
            try { GLib.source_remove(win._plaidInvisibleTimer); } catch (_e) {}
            win._plaidInvisibleTimer = 0;
        }
        if (win._plaidSettlePollId) {
            // The poll self-stops next tick via the _windowWorkspaces guard,
            // but remove it eagerly so no source id outlives the window.
            try { GLib.source_remove(win._plaidSettlePollId); } catch (_e) {}
            win._plaidSettlePollId = 0;
        }
        win._plaidSettleUntil = 0;
        win._plaidSurfaceStrikes = 0;
        if (this._maximizeToggleRects) this._maximizeToggleRects.delete(win);
        this._savedRects.delete(win);
        this._scratchpadWindows.delete(win);
        this._gappedMaxSet.delete(win);
        this._floatMaxRects.delete(win);
        this._disconnectWindowSignals(win);
        this._removeBorder(win);
        for (const [workspace, lastWin] of this._lastFocusedPerWorkspace) {
            if (lastWin === win) this._lastFocusedPerWorkspace.delete(workspace);
        }
        if (ws) {
            const order = this._getWorkspaceOrder(ws);
            const idx = order.indexOf(win);
            if (idx !== -1) order.splice(idx, 1);
            const layout = this._getWorkspaceLayout(ws);
            if (layout === 'dwindle') {
                const tree = this._bspGetTree(ws);
                if (tree) this._bspTrees.set(ws, this._bspRemove(tree, win));
            }
            this._retileWorkspace(ws);
        }
    }

    _connectWindowSignals(win) {
        if (win._plaidSignalsConnected) return;
        win._plaidSignalsConnected = true;
        if (!this._windowSignals)
            this._windowSignals = new Map();
        const sigIds = [];
        sigIds.push({ emitter: win, id: win.connect('position-changed', () => {
            this._updateBorders();
            this._convertMaximizedToGaps(win);
            this._trackFloatGeometry(win);
        }) });
        sigIds.push({ emitter: win, id: win.connect('size-changed', () => {
            this._updateBorders();
            this._convertMaximizedToGaps(win);
            this._trackFloatGeometry(win);
            // Settle window (event-driven client-resize correction): a
            // freshly placed window can be re-sized by the client itself
            // (Firefox's session restore) — correct it the INSTANT the
            // size-changed fires, with the tight tolerance + direct
            // re-place. After the window settles, the normal (16px/retile)
            // path takes over so user resizes are free.
            if (win._plaidSettleUntil && win._plaidSettleUntil > Date.now()) {
                this._debugLog(`settle event: ${win.get_wm_class_instance() || '?'} remaining=${Math.round((win._plaidSettleUntil - Date.now()) / 1000)}s`);
                this._maybeReassertSlot(win, 4, 'direct');
            } else {
                this._maybeReassertSlot(win);
            }
        }) });
        sigIds.push({ emitter: win, id: win.connect('notify::wm-class', () => {
            this._onWindowIdentityChanged(win);
        }) });
        sigIds.push({ emitter: win, id: win.connect('notify::gtk-application-id', () => {
            this._onWindowIdentityChanged(win);
        }) });
        sigIds.push({ emitter: win, id: win.connect('notify::title', () => {
            this._onWindowIdentityChanged(win);
        }) });
        sigIds.push({ emitter: win, id: win.connect('notify::window-type', () => {
            this._onWindowIdentityChanged(win);
        }) });
        sigIds.push({ emitter: win, id: win.connect('unmanaged', () => this._removeWindow(win)) });
        sigIds.push({ emitter: win, id: win.connect('workspace-changed', () => {
            const oldWs = this._windowWorkspaces.get(win);
            const newWs = win.get_workspace();
            if (oldWs) {
                const order = this._getWorkspaceOrder(oldWs);
                const idx = order.indexOf(win);
                if (idx !== -1) order.splice(idx, 1);
                this._retileWorkspace(oldWs);
            }
            if (newWs) {
                const order = this._getWorkspaceOrder(newWs);
                if (!order.includes(win)) order.push(win);
                this._windowWorkspaces.set(win, newWs);
                this._windowWSIndices.set(win, this._wsIndex(newWs));
                this._retileWorkspace(newWs);
            }
        }) });
        sigIds.push({ emitter: win, id: win.connect('notify::minimized', () => {
            // Scratch members are float-class but stay in _windowWorkspaces
            // (scratch-add never un-manages them), so their minimize /
            // unminimize from the scratchpad choreography fired a workspace
            // retile here on EVERY toggle — the animated path moved the
            // blurred tiled windows around the reveal, and their
            // constraint-bound blur siblings lagged a frame → transient blur
            // smears at the trailing (right/bottom) edges of the windows
            // (2026-10-04: "2 blur glitch areas" when revealing the
            // scratchpad). A float's minimized state never changes the tiled
            // layout — skip the retile. _scratchpadRemove still retiles
            // explicitly, so the intentional path is unaffected.
            if (this._isFloating(win)) return;
            const ws = win.get_workspace();
            if (ws) this._retileWorkspace(ws);
        }) });
        const actor = win.get_compositor_private();
        if (actor)
            sigIds.push({ emitter: actor, id: actor.connect('destroy', () => this._removeWindow(win)) });
        this._windowSignals.set(win, sigIds);
    }

    _disconnectWindowSignals(win) {
        if (!this._windowSignals) return;
        const sigIds = this._windowSignals.get(win);
        if (sigIds) {
            for (const { emitter, id } of sigIds) {
                try { emitter.disconnect(id); } catch (_e) {}
            }
            this._windowSignals.delete(win);
        }
        win._plaidSignalsConnected = false;
    }

    _connectFloatHooks(win) {
        if (this._destroyed || !this._floatHooks || this._floatHooks.has(win)) return;
        const ids = [
            win.connect('position-changed', () => {
                this._updateBorders();
                this._convertMaximizedToGaps(win);
                this._trackFloatGeometry(win);
            }),
            win.connect('size-changed', () => {
                this._updateBorders();
                this._convertMaximizedToGaps(win);
                this._trackFloatGeometry(win);
            }),
        ];
        ids.push(win.connect('unmanaged', () => {
            this._disconnectFloatHooks(win);
            // Floats never pass through _removeWindow — prune the per-window
            // state their flair created, or every closed float/popup leaks a
            // widget, an effect, and map entries for the session (and the
            // stale border map keeps the gradient animation tick alive with
            // no live windows).
            try { this._removeBorder(win); } catch (_e) {} // border + ring + mask + quarantine
            this._floatMaxRects?.delete(win);
            this._gappedMaxSet?.delete(win);
            this._maximizeToggleRects?.delete(win);
            this._scratchpadWindows?.delete(win);
            this._toggleFloatWindows?.delete(win);
            this._savedRects?.delete(win);
        }));
        this._floatHooks.set(win, ids);
    }

    _disconnectFloatHooks(win) {
        if (!this._floatHooks) return;
        const ids = this._floatHooks.get(win);
        if (!ids) return;
        for (const id of ids) {
            try { win.disconnect(id); } catch (_e) {}
        }
        this._floatHooks.delete(win);
    }

    _getWindowsForWorkspace(workspace) {
        const order = this._getWorkspaceOrder(workspace);
        return order.filter(w =>
            w.get_window_type() === Meta.WindowType.NORMAL &&
            !w.is_skip_taskbar() &&
            !w.minimized &&
            w !== this._backgroundAppWin &&
            this._windowWSIndices.get(w) === this._wsIndex(workspace)
        );
    }

    _reassertFloatingTransients() {
        try {
            if (this._destroyed || !this._settings || !this._settings.get_boolean('enabled'))
                return false;
            let moved = false;
            const index = (w) => {
                const a = w.get_compositor_private();
                // get_child_index() does not exist on Clutter.Actor in
                // GNOME 50/51 — the helper threw on every call (swallowed
                // by the outer catch) and this whole routine was dead.
                // get_children() returns a fresh array, so indexOf tracks
                // live order — required because raises inside this routine
                // mutate the child order (a prebuilt map would go stale).
                return a && a.get_parent() === global.window_group
                    ? global.window_group.get_children().indexOf(a) : -1;
            };
            // ACTIVE WORKSPACE ONLY: raising/reordering windows on inactive
            // (hidden) workspaces mutates window_group child order →
            // ::children-changed → a full stage queue_redraw → every
            // offscreen mask/blur re-renders — a visible flash on the
            // workspace being switched TO, even though the reordered actors
            // are on the leaving workspace (the "unfocused float → redraw
            // jank" case: an unfocused float sits below the top tile, so
            // every switch re-raised it and repainted the whole stage).
            // Inactive-workspace floats are re-asserted when their
            // workspace activates (ws-changed + restacked + the 50ms
            // settle poll), so scoping to the active workspace loses
            // nothing.
            const activeWs = global.workspace_manager.get_active_workspace();
            if (activeWs) {
                const order = activeWs.list_windows();
                // The tiled stack = windows Plaid actually manages AND that
                // are not floating. Everything else — float-listed windows,
                // transients, and UNMANAGED windows (non-NORMAL types like
                // Steam's "Update News" child that the tiler never claims)
                // — is naturally floating and must be re-raised above the
                // tiles on restacks/workspace changes. The old "not
                // _isFloating" bucket lumped the unmanaged windows into the
                // tiles, so they sank below them.
                const tiled = order.filter(w => this._windowWorkspaces.has(w) && !this._isFloating(w));
                // Floats: reposition each float's actor above the topmost
                // tiled actor — pure compositor layering, no meta above state.
                // Transients are included: a floating transient of a TILED
                // parent (e.g. a floating Steam child window) would otherwise
                // sink below the tiles on restacks/workspace changes (loop 2
                // only covers transients of floating parents).
                for (const win of order) {
                    if (tiled.includes(win) || win === this._backgroundAppWin) continue;
                    const a = win.get_compositor_private();
                    if (!a || a.get_parent() !== global.window_group) continue;
                    // Pre-stage raises even for HIDDEN floats (minimized DDT/scratch,
                    // a not-yet-committed XWayland window): reordering a
                    // hidden actor changes no pixels, and at ws-switch time
                    // we're inside mutter's switch animation (repaints are
                    // masked there) — so raising BEFORE the show is free,
                    // while raising AFTER it (the old `!a.visible` skip
                    // forced a post-show raise) caused a visible stage
                    // repaint — the "X11 float arrival flash". The float
                    // then shows already above the tiles: no pop, no
                    // correction repaint. The sibling-overlap risk this
                    // skip used to guard is owned by the visibility sync in
                    // _syncBlurStackingNow (a hidden source keeps its
                    // sibling hidden). The active-workspace-only scope above
                    // already excludes hidden floats on other workspaces.
                    let topTiledIdx = -1;
                    let topTiledActor = null;
                    for (const t of tiled) {
                        const ti = index(t);
                        if (ti > topTiledIdx) {
                            topTiledIdx = ti;
                            topTiledActor = t.get_compositor_private();
                        }
                    }
                    if (topTiledActor && index(win) < topTiledIdx) {
                        // win.raise() (mutter-native) instead of a Clutter
                        // set_child_above_sibling: a Clutter reorder emits
                        // ::children-changed → full-stage queue_redraw —
                        // the whole screen re-renders (every blur/mask
                        // offscreen re-captures) as an extra frame at a
                        // quiet moment = the "switch arrival flash". A
                        // mutter raise carries REGIONAL damage (smooth, like
                        // a focus click) and — crucially — updates MUTTER'S
                        // OWN internal z, so the reveal choreography can't
                        // undo it (the Clutter-only reorder fought mutter's
                        // z on every restack — the root of the float-sink
                        // tug-of-war). raise() is one-shot, unlike
                        // make_above (the persistent above-state that broke
                        // Qt popups historically).
                        win.raise();
                        moved = true;
                    }
                }
                // Transients above their floating parents.
                for (const win of order) {
                    const parent = win.get_transient_for();
                    if (!parent || !this._isFloating(parent)) continue;
                    const a = win.get_compositor_private();
                    const pa = parent.get_compositor_private();
                    if (!a || !pa || a.get_parent() !== global.window_group) continue;
                    // Same pre-stage + mutter-native rationale as loop 1: raise() puts
                    // the transient at the top of the stack (above its
                    // parent too) with regional damage and a persistent
                    // mutter z.
                    if (index(win) >= 0 && index(win) < index(parent)) {
                        try {
                            if (this._stackDiagnostics && !this._stackDiagnostics.has(win.get_id())) {
                                this._stackDiagnostics.add(win.get_id());
                                this._debugLog(`stack reassert: transient ${win.get_id()} re-positioned above ${parent.get_wm_class_instance() || '?'}`);
                            }
                        } catch (_e) {}
                        win.raise();
                        moved = true;
                    }
                }
            }
            return moved;
        } catch (_e) {}
        return false;
    }

    _retileAll() {
        if (!this._settings || this._destroyed) return;
        for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
            const w = global.workspace_manager.get_workspace_by_index(i);
            this._scheduleRetile(w);
        }
        this._scheduleBorders();
    }

    _retileWorkspace(workspace) {
        if (!this._settings || this._destroyed) return;
        this._scheduleRetile(workspace);
    }

    _doRetileWorkspace(workspace) {
        if (!this._settings) return;
        if (!this._settings.get_boolean('enabled')) {
            return;
        }
        if (this._grabOp) return;
        const tiledWindows = this._getWindowsForWorkspace(workspace)
            .filter(w => !this._isFloating(w));
        if (tiledWindows.length === 0) {
            return;
        }
        // Work-area guard: at login/monitor reconfig mutter can return a
        // degenerate rect (2026-10-04: a (5,4,1,1) garbage work area drove a
        // false 1x1-slot retile that floated Firefox). Bail — the
        // monitors-changed handler re-retiles once monitors settle, and the
        // settle/re-assert machinery covers the gap.
        const monIdx = global.display.get_primary_monitor();
        let workArea = null;
        try { workArea = workspace.get_work_area_for_monitor(monIdx); } catch (_e) {}
        if (!this._isValidWorkArea(workArea)) {
            this._debugLog(`retile: skipped ws=${this._wsIndex(workspace)} (work area not ready)`);
            return;
        }
        this._debugLog(`retile: ws=${this._wsIndex(workspace)} tiled=[${tiledWindows.map(w => w.get_wm_class_instance() || '?').join(',')}] layout=${this._getWorkspaceLayout(workspace)} animTime=${this._getAnimationTime().toFixed(2)} animating=${this._animating}`);

        if (this._getAnimationTime() > 0 && !this._grabOp) {
            this._animRetile(workspace, tiledWindows);
            return;
        }
        // NOTE: the instant (non-animated) retile branch that once lived
        // here was DEAD CODE — _getAnimationTime() floors at 0.1 by design
        // (never gate placement on St.Settings.enable_animations), so the
        // animated path above is the only one that runs. The dead branch
        // (direct retile + the _verifyRetileLandings audit) was deleted in
        // the 2026-10-04 audit; the animated path's completion (dec())
        // covers the _newWindowSet cleanup, the borders refresh, and the
        // debounced layout save.
    }

    // --- Animation ---

    _getAnimationTime() {
        // Do NOT gate on St.Settings.enable_animations — it can read false
        // even when the gsettings default is true (observed on llvmpipe
        // VMs), silently disabling every placement animation and the spawn
        // hide choreography. slow_down_factor is the accessibility lever.
        const stSettings = St.Settings.get();
        return 0.1 * Math.max(0.1, stSettings.slow_down_factor);
    }

    _cancelAnimation() {
        if (this._animTickId) {
            GLib.source_remove(this._animTickId);
            this._animTickId = 0;
        }
        if (this._newWindowSet) {
            for (const win of this._newWindowSet) {
                try {
                    const a = win.get_compositor_private();
                    if (a) {
                        a.visible = true;
                        a.set_opacity(255);
                        a.remove_all_transitions();
                    }
                } catch (_e) {}
            }
        }
        this._animating = false;
        this._animTargets = null;
        this._animStates = null;
        if (this._queuedAnimWorkspaces && this._queuedAnimWorkspaces.size > 0) {
            const pending = [...this._queuedAnimWorkspaces];
            this._queuedAnimWorkspaces.clear();
            this._debugLog(`anim: cancelled, draining ${pending.length} queued retiles`);
            for (const ws of pending) this._scheduleRetile(ws);
        }
    }

    _deferNewWindowPlacement(s, duration, done) {
        const fadeDuration = Math.min(duration, 80);
        const fadeIn = () => {
            if (this._destroyed) return;
            try {
                const f = s.win.get_frame_rect();
                this._debugLog(`place: fading frame=(${Math.round(f.x)},${Math.round(f.y)},${Math.round(f.width)},${Math.round(f.height)}) ` +
                    `target=(${Math.round(s.targetX)},${Math.round(s.targetY)},${Math.round(s.targetW)},${Math.round(s.targetH)})`);
            } catch (_e) {}
            try {
                const actor = s.win.get_compositor_private();
                if (actor) {
                    actor.visible = true;
                    // actor opacity is still 0 from the spawn hide — the
                    // ease below animates 0→255.
                }
            } catch (_e) {}
            // The window has landed — cancel the 2.5s backstop reveal so it
            // can't force-reveal a window that later moves to an inactive
            // workspace.
            if (s.win._plaidInvisibleTimer) {
                try { GLib.source_remove(s.win._plaidInvisibleTimer); } catch (_e) {}
                s.win._plaidInvisibleTimer = 0;
            }
            // Revealing = leaving the pending-warp state NOW: the offscreen
            // mask multiplies the whole output (content AND border) by its
            // opacity uniform, so a window still in _pendingWarp paints
            // invisible even though the actor is visible. The frozen-frame
            // / give-up paths reach fadeIn WITHOUT the verified-landing
            // success branch (the only other place _pendingWarp is cleared),
            // so clear it here — the same block the backstop reveal uses.
            if (this._pendingWarp) this._pendingWarp.delete(s.win);
            try {
                const effect = this._windowMasks && this._windowMasks.get(s.win);
                if (effect && effect.setOpacityUniform)
                    effect.setOpacityUniform(1);
            } catch (_e) {}
            // Settle window: some clients (Firefox's session restore) re-apply
            // their remembered geometry AFTER the placement. The size-changed
            // hook catches it when the event reaches us, but the event path
            // proved unreliable for this case (the journal showed only the
            // backstop ever correcting), so a fine-grained poll is the
            // dependable monitor: every 400ms for the 6s window, re-check
            // the slot with the tight tolerance + direct re-place. The
            // restore lands ~1-2s in → corrected within ~400ms of it (a
            // quick flicker, no multi-second wait). Cost: ~15 trivial ticks
            // per newly opened window, settle-window-only. The poll is NOT
            // stopped on the first in-slot tick — a restore landing between
            // ticks would be missed.
            s.win._plaidSettleUntil = Date.now() + 6000;
            if (s.win._plaidSettlePollId) {
                try { GLib.source_remove(s.win._plaidSettlePollId); } catch (_e) {}
                s.win._plaidSettlePollId = 0;
            }
            s.win._plaidSettlePollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                const w = s.win;
                if (this._destroyed || !w || !w.get_compositor_private() ||
                    !this._windowWorkspaces || !this._windowWorkspaces.has(w)) {
                    if (w) w._plaidSettlePollId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                if (!w._plaidSettleUntil || Date.now() > w._plaidSettleUntil) {
                    w._plaidSettlePollId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                try { this._maybeReassertSlot(w, 4, 'direct'); } catch (_e) {}
                return GLib.SOURCE_CONTINUE;
            });
            this._scheduleBorders();
            let faded = false;
            const finishFade = () => {
                if (this._destroyed) return;
                if (!faded) {
                    faded = true;
                    done();
                }
            };
            try {
                const actor = s.win.get_compositor_private();
                if (actor) {
                    actor.ease({ opacity: 255, duration: fadeDuration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC, onComplete: finishFade });
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, fadeDuration + 100, finishFade);
                    return;
                }
            } catch (_e) {}
            finishFade();
        };
        let tries = 0;
        let lastFrameKey = null;
        let sameFrameCount = 0;
        const attempt = () => {
            if (this._destroyed) return;
            try {
                if (!s.win || !s.win.get_compositor_private()) {
                    done();
                    return;
                }
                s.win.move_resize_frame(true, s.targetX, s.targetY, s.targetW, s.targetH);
            } catch (_e) {}
            let frameKey = null;
            try {
                const f = s.win.get_frame_rect();
                frameKey = `${f.x},${f.y},${f.width},${f.height}`;
                this._debugLog(`place: moved frame=(${Math.round(f.x)},${Math.round(f.y)},${Math.round(f.width)},${Math.round(f.height)}) ` +
                    `target=(${Math.round(s.targetX)},${Math.round(s.targetY)},${Math.round(s.targetW)},${Math.round(s.targetH)})`);
            } catch (_e) {}
            if (this._verifyAnimationLanding(s, 'new', true)) {
                this._debugLog(`place: attempt ${tries} verified — fading at target`);
                fadeIn();
            } else if (this._landingGivenUp && this._landingGivenUp.has(s.win)) {
                this._debugLog('place: given-up set — fading');
                fadeIn();
            } else {
                // Bounded: the pure landing verify never populates the
                // given-up set, so an endless retry here would wedge the whole
                // animation pipeline (_animating stays true, later retiles
                // queue forever, new windows sit hidden until the reveal
                // timer pops them at the center). Give up after ~1.5s and
                // finish at the target regardless.
                tries++;
                this._debugLog(`place: attempt ${tries} mismatch`);
                // Provably-ignored move: the frame is byte-identical across
                // consecutive attempts while the verify keeps failing —
                // mutter/Qt are not honoring geometry ops at all (the
                // map-time settling race; the 2026-10-02 goverlay trace
                // burned all 16 retries on a frozen frame, keeping the
                // window invisible ~1.7s for nothing). Stop retrying and
                // take the give-up path NOW: reveal at the spawn geometry,
                // then the settle poll + the 2s re-retile land it the
                // moment mutter wakes up. Windows whose frame MOVES between
                // attempts keep the full budget and stay hidden — normal
                // placement polish is unchanged.
                if (frameKey !== null && frameKey === lastFrameKey) {
                    sameFrameCount++;
                } else {
                    sameFrameCount = 0;
                }
                lastFrameKey = frameKey;
                const frozen = sameFrameCount >= 2;
                if (tries > 15 || frozen) {
                    this._debugLog(frozen
                        ? `anim: new-window placement frozen after ${tries} identical frames — finishing at spawn`
                        : 'anim: new-window placement gave up after retries — finishing at target');
                    try {
                        if (s.win && s.win.get_compositor_private())
                            s.win.move_resize_frame(true, s.targetX, s.targetY, s.targetW, s.targetH);
                    } catch (_e) {}
                    fadeIn();
                    // Self-healing settle re-request: a fresh window's
                    // move_resize_frame can be ignored/clamped by mutter
                    // while it is still settling (map-time race, or the
                    // shadow buffer wider than the screen), so all attempts
                    // fail. By ~2s the window has settled and a normal
                    // retile lands (the "second app fixes it" effect,
                    // automated). One shot; the reveal above already
                    // happened, so the window never sits hidden.
                    const settleWin = s.win;
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                        if (this._destroyed) return GLib.SOURCE_REMOVE;
                        if (!settleWin || !settleWin.get_compositor_private()) return GLib.SOURCE_REMOVE;
                        if (!this._windowWorkspaces || !this._windowWorkspaces.has(settleWin))
                            return GLib.SOURCE_REMOVE;
                        const ws = settleWin.get_workspace();
                        if (ws) this._retileWorkspace(ws);
                        return GLib.SOURCE_REMOVE;
                    });
                    return;
                }
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, attempt);
            }
        };
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, attempt);
    }

    _auditWorkspaceLandings(ws) {
        if (this._destroyed || !this._settings || !this._settings.get_boolean('enabled')) return;
        if (this._grabOp) return;
        const layout = this._getWorkspaceLayout(ws);
        if (layout === 'floating') return;
        const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
        if (tiled.length === 0) return;
        const gap = this._settings.get_int('inside-gap');
        const monitor = global.display.get_primary_monitor();
        let workArea = null;
        try { workArea = ws.get_work_area_for_monitor(monitor); } catch (_e) {}
        if (!workArea || workArea.width === 0) return;
        let off = 0;
        for (const win of tiled) {
            if (win.minimized || win.is_fullscreen()) continue;
            if (this._landingGivenUp && this._landingGivenUp.has(win)) continue;
            const slot = this._windowSlotRect(win, ws, layout, workArea, gap);
            if (!slot) continue;
            const f = win.get_frame_rect();
            if (Math.abs(f.x - slot.x) > 16 || Math.abs(f.y - slot.y) > 16 ||
                Math.abs(f.width - slot.w) > 16 || Math.abs(f.height - slot.h) > 16)
                off++;
        }
        if (off > 0) {
            this._debugLog(`audit: ws re-tiled (${off}/${tiled.length} windows off-slot)`);
            this._scheduleRetile(ws);
        }
    }

    _adjustPinnedTree(win, ws) {
        // Convergence guard: when min-size constraints can't fit the
        // partition, re-splitting just flips the layout back and forth
        // (steam 1364x810 + friends 306x540 + several windows). Bound the
        // adjustments per workspace so the layout settles on a stable
        // partition instead of oscillating forever.
        const idx = this._wsIndex(ws);
        const now = Date.now();
        let rec = this._pinnedAdjustCounts.get(idx);
        if (!rec || now - rec.since > 2000) {
            rec = { count: 0, since: now };
            this._pinnedAdjustCounts.set(idx, rec);
        }
        rec.count++;
        if (rec.count > 4) {
            this._debugLog(`pinned adjust: ws=${idx} gave up after ${rec.count} adjustments`);
            return;
        }
        try {
            if (!win || !ws) return;
            const layout = this._getWorkspaceLayout(ws);
            if (layout === 'floating') return;
            const gap = this._settings.get_int('inside-gap');
            const monitor = global.display.get_primary_monitor();
            const workArea = ws.get_work_area_for_monitor(monitor);
            if (!workArea || workArea.width === 0) return;
            const area = this._outsideArea(workArea);
            if (!area) return;
            const areaW = area.w;
            const areaH = area.h;
            const f = win.get_frame_rect();
            const min = this._getWindowMinSize(win);
            const minSrc = min.w > 0 || min.h > 0 ? `min=${min.w}x${min.h}` : 'min=none';
            let changed = false;
            if (layout === 'dwindle') {
                const tree = this._bspGetTree(ws);
                if (!tree) return;
                changed = this._adjustForConstraints(tree, null, true, area.x, area.y, areaW, areaH, gap, 0);
            } else if (layout === 'master-stack' || layout === 'centered-master-stack') {
                const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
                if (tiled.length < 2) return;
                if (win === tiled[0]) {
                    const basis = layout === 'centered-master-stack' ? areaW - gap * 2 : areaW - gap;
                    if (basis > 0) {
                        const ratio = this._getMasterRatio(ws);
                        const nr = Math.min(0.95, Math.max(ratio, f.width / basis));
                        if (nr !== ratio) {
                            this._masterRatios.set(this._wsIndex(ws), nr);
                            changed = true;
                        }
                    }
                } else {
                    const idx = tiled.indexOf(win) - 1;
                    const stackRatios = this._getStackRatios(ws);
                    const numStack = tiled.length - 1;
                    const totalStackH = areaH - gap * (numStack - 1);
                    if (totalStackH > 0 && idx >= 0) {
                        let total = 0;
                        const weights = [];
                        for (let i = 0; i < numStack; i++) {
                            const w = stackRatios.has(i) ? stackRatios.get(i) : 1.0;
                            weights.push(w);
                            total += w;
                        }
                        const curH = total > 0 ? Math.floor(totalStackH * weights[idx] / total) : 0;
                        if (curH > 0 && f.height > curH + 1) {
                            stackRatios.set(idx, weights[idx] * (f.height / curH));
                            changed = true;
                        }
                    }
                }
            } else {
                return;
            }
            // Report and persist ONLY on a real ratio change: the old
            // unconditional log claimed "bent" even when every clamp was a
            // no-op (it misled the 2026-10-02 triage).
            if (!changed) return;
            this._debugLog(`constraint: pinned frame ${Math.round(f.width)}x${Math.round(f.height)} bent the split ratio (${minSrc})`);
            this._scheduleSaveLayouts();
        } catch (e) {
            // The whole bend used to be swallowed silently — any exception
            // (e.g. a finalized window's get_frame_rect) killed the min-size
            // bend with zero trace while the window sat off-slot
            // (2026-10-04 audit).
            log(`[plaid] pinned adjust failed: ${e.message}`);
        }
    }

    _verifyAnimationLanding(s, kind, pure = false) {
        try {
            if (this._grabOp) return false;
            const win = s.win;
            if (!win || !win.get_compositor_private()) {
                if (!pure)
                    this._debugLog(`anim: landing skipped (window gone) ${kind} id=${win ? win.get_id() : '?'}`);
                return false;
            }
            if (this._landingGivenUp && this._landingGivenUp.has(win)) return false;
            const f = win.get_frame_rect();
            // The deferred new-window placement must land PRECISELY (pure
            // mode): the 16px tolerance silently accepted off-landings like
            // mutter's shadow-clamped frame (8px x-offset) and never
            // re-requested, leaving the window at wrong screen gaps. The
            // animated tick path keeps 16px — sliding frames.
            const tol = kind === 'new' && pure ? 4 : 16;
            if (Math.abs(f.x - s.targetX) > tol || Math.abs(f.y - s.targetY) > tol ||
                Math.abs(f.width - s.targetW) > tol || Math.abs(f.height - s.targetH) > tol) {
                if (!pure) {
                    this._debugLog(`anim: landing mismatch (${kind}) ${win.get_wm_class_instance() || '?'} id=${win.get_id()} minimized=${win.minimized} frame=(${f.x},${f.y},${f.width},${f.height}) target=(${s.targetX},${s.targetY},${s.targetW},${s.targetH})`);
                    try {
                        const mws = win.get_workspace();
                        if (mws) {
                            const tree = this._bspGetTree(mws);
                            const min = this._getWindowMinSize(win);
                            if (tree)
                                this._debugLog(`diag: tree=${JSON.stringify(tree)} min=${min.w}x${min.h}`);
                        }
                    } catch (_e) {}
                    const prev = this._mismatchFrames?.get(win);
                    this._mismatchFrames?.set(win, { x: f.x, y: f.y, w: f.width, h: f.height });
                    const refusesShrink = f.width > s.targetW + 16 || f.height > s.targetH + 16;
                    if (prev && refusesShrink &&
                        Math.abs(f.x - prev.x) <= 1 && Math.abs(f.y - prev.y) <= 1 &&
                        Math.abs(f.width - prev.w) <= 1 && Math.abs(f.height - prev.h) <= 1)
                        this._adjustPinnedTree(win, win.get_workspace());
                    this._retryLanding(win);
                }
                return false;
            } else {
                if (this._landingRetries) this._landingRetries.delete(win);
                if (this._landingGivenUp) this._landingGivenUp.delete(win);
                if (this._mismatchFrames) this._mismatchFrames.delete(win);
                if (this._pendingWarp && this._pendingWarp.has(win)) {
                    this._pendingWarp.delete(win);
                    this._moveCursorToWindow(win);
                    // The window has landed — cancel the 2.5s backstop reveal
                    // (it must not force-reveal a window that later moves to
                    // an inactive workspace) and re-attach flair that the
                    // pending-warp state skipped.
                    //
                    // The settle poll is deliberately NOT cancelled here:
                    // this function also runs on the 'tiled' verify path of
                    // every animated retile, where killing an armed settle
                    // poll would silently skip the client-resize correction
                    // for give-up windows. The poll self-expires at 6s.
                    if (win._plaidInvisibleTimer) {
                        try { GLib.source_remove(win._plaidInvisibleTimer); } catch (_e) {}
                        win._plaidInvisibleTimer = 0;
                    }
                    this._scheduleBorders();
                    this._updateBorders();
                }
                return true;
            }
        } catch (_e) {
            return false;
        }
    }

    _retryLanding(win) {
        if (!this._landingRetries || !this._landingGivenUp || this._destroyed || !win) return;
        if (!win.get_compositor_private()) {
            this._debugLog(`anim: landing retry skipped (window gone) id=${win.get_id()}`);
            return;
        }
        const n = (this._landingRetries.get(win) || 0) + 1;
        if (n > 3 || this._isFixedSizeWindow(win)) {
            this._landingRetries.delete(win);
            this._landingGivenUp.add(win);
            if (this._mismatchFrames) this._mismatchFrames.delete(win);
            try { this._toggleFloatWindows.add(win); } catch (_e) {}
            // The window is floating now — clear the pending-warp state so a
            // masked window is never left invisible: _landingGivenUp makes
            // every future _verifyAnimationLanding return false, so the
            // success branch that clears _pendingWarp can never run again,
            // and the mask uniform stays at 0 (the whole output multiplied
            // by it — no content, no border) until a title/wm-class notify
            // or close. Mirror the backstop-reveal block.
            if (this._pendingWarp) this._pendingWarp.delete(win);
            try {
                const a = win.get_compositor_private();
                if (a) {
                    a.visible = true;
                    a.set_opacity(255);
                }
            } catch (_e) {}
            try {
                const effect = this._windowMasks && this._windowMasks.get(win);
                if (effect && effect.setOpacityUniform)
                    effect.setOpacityUniform(1);
            } catch (_e) {}
            this._scheduleBorders();
            const ws = win.get_workspace();
            const list = ws
                ? ws.list_windows().map(w => `${w.get_id()}:${w.get_wm_class_instance() || '?'}:min=${w.minimized}:${Math.round(w.get_frame_rect().width)}x${Math.round(w.get_frame_rect().height)}`).join(' | ')
                : 'no ws';
            log(`[plaid] anim: landing failed after retries for ${win.get_wm_class_instance() || '?'} id=${win.get_id()} minimized=${win.minimized} — floated (tiled set: ${list})`);
            if (ws) this._retileWorkspace(ws);
            return;
        }
        this._landingRetries.set(win, n);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            if (this._landingGivenUp && this._landingGivenUp.has(win)) return GLib.SOURCE_REMOVE;
            // Window-liveness: _removeWindow prunes the given-up set on
            // close, so that guard no longer covers a window closed within
            // this 200ms window — touching a finalized Meta.Window here
            // throws inside the source callback.
            if (!win.get_compositor_private()) return GLib.SOURCE_REMOVE;
            const ws = win.get_workspace();
            if (ws) {
                this._debugLog(`anim: landing retry ${n} for ${win.get_wm_class_instance() || '?'} id=${win.get_id()} minimized=${win.minimized}`);
                this._retileWorkspace(ws);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _animRetile(workspace, tiledWindows) {
        if (this._animating) {
            // Stall watchdog: the in-flight animation's completion signal
            // can be missed (interrupted transitions, destroyed windows).
            // If it has not completed within a generous budget, force-finish
            // so queued retiles keep running instead of wedging forever.
            if (this._animStartedAt && Date.now() - this._animStartedAt > 800) {
                // Teardown the in-flight animation BEFORE starting a new
                // one: the watchdog previously just cleared _animating and
                // drained the queue, leaving the 16ms tick alive — the new
                // animation then overwrote _animTickId without removing the
                // old source, so BOTH ticks ran concurrently on the same
                // _animStates (double dec(), spurious landing verifies,
                // one leaked GLib source per occurrence; live at
                // slow-down-factor 8 where 800ms animations sit exactly on
                // the watchdog budget).
                if (this._animTickId) {
                    GLib.source_remove(this._animTickId);
                    this._animTickId = 0;
                }
                this._animStates = null;
                this._animTargets = null;
                this._animating = false;
                const pending = [...this._queuedAnimWorkspaces];
                this._queuedAnimWorkspaces.clear();
                this._debugLog(`anim: watchdog drained stalled queue (${pending.length})`);
                for (const ws of pending) this._scheduleRetile(ws);
            } else {
                this._queuedAnimWorkspaces.add(workspace);
                this._debugLog(`anim: retile queued while animating (queue=${this._queuedAnimWorkspaces.size})`);
                return;
            }
        }
        this._animStartedAt = Date.now();

        this._animTargets = new Map();

        const layout = this._getWorkspaceLayout(workspace);
        if (layout === 'floating') {
            // GNOME owns floating placement; the fade-in choreography just
            // anchors at the window's current (GNOME-placed) position.
            try {
                for (const win of tiledWindows) {
                    if (!this._newWindowSet.has(win)) continue;
                    const f = win.get_frame_rect();
                    if (f.width > 0 && f.height > 0)
                        this._animTargets.set(win, { x: f.x, y: f.y, w: f.width, h: f.height });
                }
            } catch (_e) {}
        } else if (layout === 'dwindle')
            this._retileDwindle(workspace, tiledWindows);
        else if (layout === 'centered-master-stack')
            this._retileCenteredMasterStack(workspace, tiledWindows);
        else
            this._retileMasterStack(workspace, tiledWindows);

        if (this._animTargets.size === 0) {
            this._debugLog('anim: no targets (bail)');
            this._animTargets = null;
            for (const win of tiledWindows) this._newWindowSet.delete(win);
            this._scheduleBorders();
            return;
        }

        this._animating = true;
        const animTime = this._getAnimationTime();
        const duration = animTime * 1000;

        const states = [];
        for (const [win, target] of this._animTargets) {
            if (!win || win.is_fullscreen() || !win.get_workspace()) continue;
            const frame = win.get_frame_rect();
            const actor = win.get_compositor_private();
            const isNew = this._newWindowSet.has(win);
            this._debugLog(`anim: start ws=${this._wsIndex(workspace)} win=${win.get_wm_class_instance() || '?'} new=${isNew} target=(${Math.round(target.x)},${Math.round(target.y)},${Math.round(target.w)},${Math.round(target.h)})`);
            states.push({ win, actor, isNew, startX: frame.x, startY: frame.y, startW: frame.width, startH: frame.height, targetX: target.x, targetY: target.y, targetW: target.w, targetH: target.h });
        }
        this._animTargets = null;

        let remaining = states.length;
        if (remaining === 0) { this._animating = false; return; }

        const dec = () => {
            if (!this._newWindowSet) return;
            remaining--;
            if (remaining <= 0) {
                this._animating = false;
                this._debugLog(`anim: done ws=${this._wsIndex(workspace)} queued=${this._queuedAnimWorkspaces.size}`);
                for (const w of tiledWindows) this._newWindowSet.delete(w);
                this._animStates = null;
                this._scheduleSaveLayouts();
                this._scheduleBorders();
                if (this._queuedAnimWorkspaces.size > 0) {
                    const pending = [...this._queuedAnimWorkspaces];
                    this._queuedAnimWorkspaces.clear();
                    for (const ws of pending) this._scheduleRetile(ws);
                }
            }
        };

        const newStates = states.filter(s => s.isNew);
        const existingStates = states.filter(s => !s.isNew);

        // New windows: init opacity and animate later
        for (const s of newStates) {
            if (s.actor) {
                s.actor.remove_all_transitions();
                s.actor.set_opacity(0);
                // No show() here — a new window hidden via actor.visible=false
                // must stay invisible until the placement reveals it at its
                // slot.
            }
        }

        if (existingStates.length > 0) {
            this._animStates = existingStates;
            this._animStartTime = Date.now();
            this._animTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
                if (this._destroyed) { this._animTickId = 0; return GLib.SOURCE_REMOVE; }
                if (!this._animStates) { this._animTickId = 0; this._animating = false; return GLib.SOURCE_REMOVE; }
                const elapsed = Date.now() - this._animStartTime;
                const t = Math.min(elapsed / duration, 1);
                const e = 1 - Math.pow(1 - t, 3);
                for (const s of this._animStates) {
                    if (!s.win.get_compositor_private()) continue;
                    const x = s.startX + (s.targetX - s.startX) * e;
                    const y = s.startY + (s.targetY - s.startY) * e;
                    const w = s.startW + (s.targetW - s.startW) * e;
                    const h = s.startH + (s.targetH - s.startH) * e;
                    try { s.win.move_resize_frame(true, Math.round(x), Math.round(y), Math.round(w), Math.round(h)); } catch (_e) {}
                }
                if (t >= 1) {
                    this._animTickId = 0;
                    this._animStates = null;
                    for (const s of existingStates) {
                        if (!s.win.get_compositor_private()) { dec(); continue; }
                        try { s.win.move_resize_frame(true, s.targetX, s.targetY, s.targetW, s.targetH); } catch (_e) {}
                        this._verifyAnimationLanding(s, 'tiled');
                        dec();
                    }
                    // Now fade in new windows (placement + fade handled deferred)
                    for (const s of newStates) {
                        if (s.actor) {
                            this._deferNewWindowPlacement(s, duration, dec);
                        } else {
                            dec();
                        }
                    }
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        } else {
            // Only new windows — fade them in after the deferred placement
            for (const s of newStates) {
                if (s.actor) {
                    this._deferNewWindowPlacement(s, duration, dec);
                } else {
                    dec();
                }
            }
        }
    }

    _animFloat(win, x, y, w, h) {
        const animTime = this._getAnimationTime();
        if (animTime <= 0) {
            this._moveWindow(win, x, y, w, h);
            return;
        }
        const actor = win.get_compositor_private();
        if (!actor) {
            this._moveWindow(win, x, y, w, h);
            return;
        }
        const frame = win.get_frame_rect();
        try { win.move_resize_frame(true, x, y, w, h); } catch (_e) {}
        actor.remove_all_transitions();
        actor.set_translation(0, 0, 0);
        actor.set_scale(1, 1);
        const scaleX = frame.width > 0 ? frame.width / w : 1;
        const scaleY = frame.height > 0 ? frame.height / h : 1;
        actor.set_pivot_point(0, 0);
        actor.set_translation(frame.x - x, frame.y - y, 0);
        actor.set_scale(scaleX, scaleY);
        actor.show();
        const props = { duration: animTime * 1000, mode: Clutter.AnimationMode.EASE_OUT_CUBIC };
        props.translation_x = 0;
        props.translation_y = 0;
        if (Math.abs(scaleX - 1) > 0.01 || Math.abs(scaleY - 1) > 0.01) {
            props.scale_x = 1;
            props.scale_y = 1;
        }
        // Mark Plaid's own resize animation so the blur suppression does not
        // mistake this deliberate scale for an external fly-in (which would
        // flash the blur off while growing a window).
        win._plaidFloatAnim = true;
        props.onStopped = () => { win._plaidFloatAnim = false; };
        actor.ease(props);
    }

    // --- Master-Stack Helpers ---

    _getMasterRatio(ws) {
        const idx = this._wsIndex(ws);
        if (!this._masterRatios.has(idx)) {
            let ratio = 0.5;
            if (this._persistedMasterByIndex) {
                const rule = this._persistedMasterByIndex.get(idx);
                if (rule !== undefined) ratio = rule;
            }
            this._masterRatios.set(idx, ratio);
        }
        return this._masterRatios.get(idx);
    }

    _getStackRatios(ws) {
        const idx = this._wsIndex(ws);
        if (!this._stackRatios.has(idx)) {
            const map = new Map();
            if (this._persistedStackByIndex) {
                const rule = this._persistedStackByIndex.get(idx);
                if (rule) {
                    for (const [k, v] of rule)
                        map.set(k, v);
                }
            }
            this._stackRatios.set(idx, map);
        }
        return this._stackRatios.get(idx);
    }

    _clampMasterStackRatios(ws, tiledWindows, areaW, gap, centered) {
        if (!tiledWindows || tiledWindows.length < 2) return;
        const masterMin = this._getWindowMinSize(tiledWindows[0]).w || 0;
        let stackMinW = 0;
        for (let i = 1; i < tiledWindows.length; i++)
            stackMinW = Math.max(stackMinW, this._getWindowMinSize(tiledWindows[i]).w || 0);
        const basis = centered ? areaW - gap * 2 : areaW - gap;
        if (basis <= 0) return;
        let lo = masterMin / basis;
        let hi = 1 - stackMinW / basis;
        if (centered) {
            // The stack splits into two side columns, each roughly half the
            // remaining width — a window in one column needs double the
            // headroom the flat bound assumes.
            const numStack = tiledWindows.length - 1;
            const leftCount = Math.ceil(numStack / 2);
            let leftMinW = 0;
            let rightMinW = 0;
            for (let i = 1; i < tiledWindows.length; i++) {
                const m = this._getWindowMinSize(tiledWindows[i]).w || 0;
                if (i <= leftCount) leftMinW = Math.max(leftMinW, m);
                else rightMinW = Math.max(rightMinW, m);
            }
            hi = 1 - 2 * Math.max(leftMinW, rightMinW) / basis;
        }
        const ratio = this._getMasterRatio(ws);
        let clamped;
        if (hi <= lo) {
            const need = masterMin + stackMinW;
            // A master window without a min-size hint would clamp to
            // 0 / stackMinW = 0 here (a zero-width master pane that the
            // landing verify can never satisfy) — fall back to a sane
            // 50/50 split instead (2026-10-04 audit).
            clamped = (need > 0 && masterMin > 0) ? masterMin / need : 0.5;
        } else {
            clamped = Math.max(lo, Math.min(hi, ratio));
        }
        this._masterRatios.set(this._wsIndex(ws), clamped);
        this._scheduleSaveLayouts();
    }

    _retileMasterStack(workspace, tiledWindows, skipWindow = null) {
        const gap = this._settings.get_int('inside-gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        if (!workArea) return;

        const numWindows = tiledWindows.length;

        if (numWindows === 1) {
            const rect = this._singleWindowRect(workArea);
            if (rect)
                this._moveWindow(tiledWindows[0], rect.x, rect.y, rect.w, rect.h);
            return;
        }

        const area = this._outsideArea(workArea);
        if (!area) return;
        const areaX = area.x;
        const areaY = area.y;
        const areaW = area.w;
        const areaH = area.h;
        this._clampMasterStackRatios(workspace, tiledWindows, areaW, gap, false);
        const masterRatio = this._getMasterRatio(workspace);
        const masterW = Math.floor((areaW - gap) * masterRatio);
        const stackW = areaW - masterW - gap;
        const numStack = numWindows - 1;

        if (tiledWindows[0] !== skipWindow)
            this._moveWindow(tiledWindows[0], areaX, areaY, masterW, areaH);

        const stackRatios = this._getStackRatios(workspace);
        const weights = [];
        let totalWeight = 0;
        for (let i = 0; i < numStack; i++) {
            const w = stackRatios.has(i) ? stackRatios.get(i) : 1.0;
            weights.push(w);
            totalWeight += w;
        }

        const totalStackH = areaH - gap * (numStack - 1);

        if (skipWindow && numStack > 1) {
            const draggedIdx = tiledWindows.indexOf(skipWindow) - 1;
            if (draggedIdx >= 0) {
                const draggedH = skipWindow.get_frame_rect().height;
                const availableForOthers = areaH - draggedH - gap * (numStack - 1);
                if (availableForOthers > 0) {
                    let otherWeightSum = 0;
                    for (let i = 0; i < numStack; i++) {
                        if (i !== draggedIdx) otherWeightSum += weights[i];
                    }
                    const scale = otherWeightSum > 0 ? availableForOthers / otherWeightSum : 1;
                    let y = areaY;
                    for (let i = 0; i < numStack; i++) {
                        const isLast = i === numStack - 1;
                        const win = tiledWindows[i + 1];
                        let h;
                        if (i === draggedIdx) {
                            h = draggedH;
                        } else if (isLast) {
                            h = Math.max(10, areaY + areaH - y);
                        } else {
                            h = Math.max(this._getWindowMinSize(win).h || 0, Math.floor(weights[i] * scale));
                            if (y + h > areaY + areaH) h = Math.max(10, areaY + areaH - y);
                        }
                        if (win !== skipWindow)
                            this._moveWindow(win, areaX + masterW + gap, y, stackW, h);
                        else
                            this._moveWindow(win, areaX + masterW + gap, y, stackW, draggedH);
                        if (!isLast) y += h + gap;
                    }
                    return;
                }
            }
        }

        let y = areaY;
        for (let i = 0; i < numStack; i++) {
            const isLast = i === numStack - 1;
            const win = tiledWindows[i + 1];
            const minH = this._getWindowMinSize(win).h || 0;
            let h = isLast
                ? Math.max(10, areaY + areaH - y)
                : Math.max(minH, Math.floor(totalStackH * weights[i] / totalWeight));
            if (!isLast && y + h > areaY + areaH) h = Math.max(10, areaY + areaH - y);
            if (win !== skipWindow)
                this._moveWindow(win, areaX + masterW + gap, y, stackW, h);
            else
                this._moveWindow(win, areaX + masterW + gap, y, stackW, win.get_frame_rect().height);
            if (!isLast) {
                if (win === skipWindow) {
                    const frame = win.get_frame_rect();
                    y += frame.height + gap;
                } else {
                    y += h + gap;
                }
            }
        }
    }

    _retileCenteredMasterStack(workspace, tiledWindows, skipWindow = null) {
        const gap = this._settings.get_int('inside-gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        if (!workArea) return;

        const numWindows = tiledWindows.length;

        if (numWindows === 1) {
            const rect = this._singleWindowRect(workArea);
            if (rect)
                this._moveWindow(tiledWindows[0], rect.x, rect.y, rect.w, rect.h);
            return;
        }

        const area = this._outsideArea(workArea);
        if (!area) return;
        const areaX = area.x;
        const areaY = area.y;
        const areaW = area.w;
        const areaH = area.h;
        this._clampMasterStackRatios(workspace, tiledWindows, areaW, gap, true);
        const numStack = numWindows - 1;
        const leftCount = Math.ceil(numStack / 2);
        const rightCount = numStack - leftCount;

        let masterX, masterW;
        if (skipWindow && numStack > 0) {
            if (tiledWindows[0] === skipWindow) {
                const frame = skipWindow.get_frame_rect();
                masterX = frame.x;
                masterW = frame.width;
                const effectiveRatio = masterW / (areaW - gap * 2);
                this._masterRatios.set(this._wsIndex(workspace), Math.max(0.15, Math.min(0.85, effectiveRatio)));
            } else {
                const masterRatio = this._getMasterRatio(workspace);
                masterW = Math.floor((areaW - gap * 2) * masterRatio);
                masterX = areaX + Math.floor((areaW - masterW) / 2);
            }
        } else {
            const masterRatio = this._getMasterRatio(workspace);
            masterW = Math.floor((areaW - gap * 2) * masterRatio);
            masterX = areaX + Math.floor((areaW - masterW) / 2);
        }
        const leftStackW = masterX - areaX - gap;
        const rightStackX = masterX + masterW + gap;
        const rightStackW = areaX + areaW - rightStackX;

        if (tiledWindows[0] !== skipWindow)
            this._moveWindow(tiledWindows[0], masterX, areaY, masterW, areaH);

        const stackRatios = this._getStackRatios(workspace);
        const leftWeights = [];
        let leftTotal = 0;
        for (let i = 0; i < leftCount; i++) {
            const w = stackRatios.has(i) ? stackRatios.get(i) : 1.0;
            leftWeights.push(w);
            leftTotal += w;
        }
        const rightWeights = [];
        let rightTotal = 0;
        for (let i = 0; i < rightCount; i++) {
            const w = stackRatios.has(leftCount + i) ? stackRatios.get(leftCount + i) : 1.0;
            rightWeights.push(w);
            rightTotal += w;
        }

        const _layoutStack = (stackWindows, stackWeights, stackTotal, x, w) => {
            if (stackWindows.length === 0) return;
            const count = stackWindows.length;
            const totalStackH = areaH - gap * (count - 1);
            if (skipWindow && stackWindows.includes(skipWindow) && count > 1) {
                const draggedIdx = stackWindows.indexOf(skipWindow);
                const draggedH = skipWindow.get_frame_rect().height;
                const availableForOthers = areaH - draggedH - gap * (count - 1);
                if (availableForOthers > 0) {
                    let otherWeightSum = 0;
                    for (let i = 0; i < count; i++) {
                        if (i !== draggedIdx) otherWeightSum += stackWeights[i];
                    }
                    const scale = otherWeightSum > 0 ? availableForOthers / otherWeightSum : 1;
                    let y = areaY;
                    for (let i = 0; i < count; i++) {
                        const isLast = i === count - 1;
                        const win = stackWindows[i];
                        let h;
                        if (i === draggedIdx) {
                            h = draggedH;
                        } else if (isLast) {
                            h = Math.max(10, areaY + areaH - y);
                        } else {
                            h = Math.max(this._getWindowMinSize(win).h || 0, Math.floor(stackWeights[i] * scale));
                            if (y + h > areaY + areaH) h = Math.max(10, areaY + areaH - y);
                        }
                        if (win !== skipWindow)
                            this._moveWindow(win, x, y, w, h);
                        else
                            this._moveWindow(win, x, y, w, draggedH);
                        if (!isLast) y += h + gap;
                    }
                    return;
                }
            }
            let y = areaY;
            for (let i = 0; i < count; i++) {
                const isLast = i === count - 1;
                const win = stackWindows[i];
                const minH = this._getWindowMinSize(win).h || 0;
                let h = isLast
                    ? Math.max(10, areaY + areaH - y)
                    : Math.max(minH, Math.floor(totalStackH * stackWeights[i] / stackTotal));
                if (!isLast && y + h > areaY + areaH) h = Math.max(10, areaY + areaH - y);
                if (win !== skipWindow)
                    this._moveWindow(win, x, y, w, h);
                else
                    this._moveWindow(win, x, y, w, win.get_frame_rect().height);
                if (!isLast) {
                    if (win === skipWindow) {
                        const frame = win.get_frame_rect();
                        y += frame.height + gap;
                    } else {
                        y += h + gap;
                    }
                }
            }
        };

        if (leftStackW > 0 && leftCount > 0) {
            const leftWins = tiledWindows.slice(1, 1 + leftCount);
            _layoutStack(leftWins, leftWeights, leftTotal, areaX, leftStackW);
        }

        if (rightStackW > 0 && rightCount > 0) {
            const rightWins = tiledWindows.slice(1 + leftCount);
            _layoutStack(rightWins, rightWeights, rightTotal, rightStackX, rightStackW);
        }
    }

    _swapMasterStackWindows(winA, winB) {
        const ws = winA.get_workspace();
        if (!ws) return;
        const order = this._getWorkspaceOrder(ws);
        const idxA = order.indexOf(winA);
        const idxB = order.indexOf(winB);
        if (idxA !== -1 && idxB !== -1) {
            order[idxA] = winB;
            order[idxB] = winA;
        }
        const frameA = winA.get_frame_rect();
        const frameB = winB.get_frame_rect();
        try {
            winA.move_resize_frame(true, frameB.x, frameB.y, frameB.width, frameB.height);
            winB.move_resize_frame(true, frameA.x, frameA.y, frameA.width, frameA.height);
        } catch (e) {
            log(`[plaid] swap move_resize failed: ${e.message}`);
        }
    }

    _resizeMasterStack(focused, workspace, axis, delta) {
        const tiledWindows = this._getWindowsForWorkspace(workspace)
            .filter(w => !this._isFloating(w));
        const numStack = tiledWindows.length - 1;
        if (numStack === 0) return;

        const monitor = global.display.get_primary_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        if (!workArea) return;
        const gap = this._settings.get_int('inside-gap');
        const area = this._outsideArea(workArea);
        if (!area) return;
        const areaW = area.w;
        const layout = this._getWorkspaceLayout(workspace);
        const masterDenom = layout === 'centered-master-stack' ? areaW - gap * 2 : areaW - gap;

        if (axis === 'width') {
            const currentRatio = this._getMasterRatio(workspace);
            const currentMasterW = masterDenom * currentRatio;
            // grow/shrink is relative to the FOCUSED window: a stack window
            // needs the master column to move the OPPOSITE way, and in the
            // centered layout the master width is split between two side
            // columns, so each side moves by half — the mouse-resize path
            // applies the same sign + 2x rules (2026-10-05 audit).
            const idx = tiledWindows.indexOf(focused);
            let signedDelta = idx > 0 ? -delta : delta;
            if (layout === 'centered-master-stack' && idx > 0)
                signedDelta *= 2;
            const newMasterW = currentMasterW + signedDelta;
            const minMaster = 100;
            const maxMaster = masterDenom - numStack * 100;
            if (maxMaster >= minMaster) {
                const clamped = Math.max(minMaster, Math.min(maxMaster, newMasterW));
                this._masterRatios.set(this._wsIndex(workspace), clamped / masterDenom);
            }
        } else {
            const idx = tiledWindows.indexOf(focused);
            if (idx === 0) return;
            const stackIdx = idx - 1;
            const stackRatios = this._getStackRatios(workspace);
            const currentWeight = stackRatios.has(stackIdx) ? stackRatios.get(stackIdx) : 1.0;
            const newWeight = Math.max(0.1, currentWeight + delta * 0.005);
            stackRatios.set(stackIdx, newWeight);
            this._scheduleSaveLayouts();
        }
    }

    _computeMasterStackDropTarget(ws, px, py) {
        const gap = this._settings.get_int('inside-gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return -1;

        const area = this._outsideArea(workArea);
        if (!area) return -1;
        const areaX = area.x;
        const areaY = area.y;
        const areaW = area.w;
        const areaH = area.h;

        // Drop zones live inside the outside-gapped area — a pointer in the
        // outside-gap strip selects nothing.
        if (px < areaX || px > areaX + areaW || py < areaY || py > areaY + areaH)
            return -1;

        const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
        if (tiled.length === 0) return -1;

        const numStack = tiled.length - 1;

        if (numStack === 0) return 0;

        const masterRatio = this._getMasterRatio(ws);
        const layout = this._getWorkspaceLayout(ws);

        if (layout === 'centered-master-stack') {
            const masterW = Math.floor((areaW - gap * 2) * masterRatio);
            const masterX = areaX + Math.floor((areaW - masterW) / 2);
            const leftStackW = masterX - areaX - gap;
            const rightStackX = masterX + masterW + gap;

            if (px >= masterX && px <= masterX + masterW)
                return 0;

            const leftCount = Math.ceil(numStack / 2);
            const rightCount = numStack - leftCount;
            const stackRatios = this._getStackRatios(ws);

            if (px < masterX && leftStackW > 0 && leftCount > 0) {
                const weights = [];
                let totalWeight = 0;
                for (let i = 0; i < leftCount; i++) {
                    const w = stackRatios.has(i) ? stackRatios.get(i) : 1.0;
                    weights.push(w);
                    totalWeight += w;
                }
                let y = areaY;
                for (let i = 0; i < leftCount; i++) {
                    const isLast = i === leftCount - 1;
                    const h = isLast
                        ? (areaY + areaH - y)
                        : Math.floor((areaH - gap * (leftCount - 1)) * weights[i] / totalWeight);
                    if (py <= y + h + (isLast ? 0 : gap / 2))
                        return 1 + i;
                    y += h + gap;
                }
                // Drop below the last left-column window targets the LAST
                // column window (the drop lands at the column's bottom) —
                // the old first-window fallback was inconsistent with the
                // right column and the flat stack (2026-10-04 audit).
                return leftCount;
            }

            if (px > masterX + masterW && rightStackX > 0 && rightCount > 0) {
                const weights = [];
                let totalWeight = 0;
                for (let i = 0; i < rightCount; i++) {
                    const w = stackRatios.has(leftCount + i) ? stackRatios.get(leftCount + i) : 1.0;
                    weights.push(w);
                    totalWeight += w;
                }
                let y = areaY;
                for (let i = 0; i < rightCount; i++) {
                    const isLast = i === rightCount - 1;
                    const h = isLast
                        ? (areaY + areaH - y)
                        : Math.floor((areaH - gap * (rightCount - 1)) * weights[i] / totalWeight);
                    if (py <= y + h + (isLast ? 0 : gap / 2))
                        return 1 + leftCount + i;
                    y += h + gap;
                }
                // Same as the left column: below the column = its LAST
                // window (the flat-stack semantics).
                return 1 + leftCount + rightCount - 1;
            }
        } else {
            const masterW = Math.floor((areaW - gap) * masterRatio);
            const stackW = areaW - masterW - gap;
            const stackX = areaX + masterW + gap;

            if (px >= areaX && px <= areaX + masterW)
                return 0;

            if (px >= stackX && px <= stackX + stackW) {
                const stackRatios = this._getStackRatios(ws);
                const weights = [];
                let totalWeight = 0;
                for (let i = 0; i < numStack; i++) {
                    const w = stackRatios.has(i) ? stackRatios.get(i) : 1.0;
                    weights.push(w);
                    totalWeight += w;
                }
                let y = areaY;
                for (let i = 0; i < numStack; i++) {
                    const isLast = i === numStack - 1;
                    const h = isLast
                        ? (areaY + areaH - y)
                        : Math.floor((areaH - gap * (numStack - 1)) * weights[i] / totalWeight);
                    if (py <= y + h + (isLast ? 0 : gap / 2))
                        return i + 1;
                    y += h + gap;
                }
                return tiled.length - 1;
            }
        }

        return -1;
    }

    _retileDwindle(workspace, tiledWindows) {
        const gap = this._settings.get_int('inside-gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        if (!workArea) return;

        if (tiledWindows.length === 1) {
            const rect = this._singleWindowRect(workArea);
            if (rect)
                this._moveWindow(tiledWindows[0], rect.x, rect.y, rect.w, rect.h);
            return;
        }

        let tree = this._bspGetTree(workspace);
        const area = this._outsideArea(workArea);
        if (!area) return;
        const areaX = area.x;
        const areaY = area.y;
        const areaW = area.w;
        const areaH = area.h;

        if (tree) {
            const treeWins = this._bspCollectWindows(tree);
            for (const tw of treeWins) {
                if (!tiledWindows.includes(tw)) {
                    tree = this._bspRemove(tree, tw);
                }
            }
            let currentWins = this._bspCollectWindows(tree);
            for (const win of tiledWindows) {
                if (!currentWins.includes(win)) {
                    tree = this._bspInsert(tree, win, areaX, areaY, areaW, areaH, gap);
                    currentWins = this._bspCollectWindows(tree);
                }
            }
            this._bspTrees.set(workspace, tree);
        } else {
            tree = null;
            for (const win of tiledWindows) {
                if (tree) {
                    tree = this._bspInsert(tree, win, areaX, areaY, areaW, areaH, gap);
                } else {
                    tree = this._bspMakeLeaf(win);
                }
            }
            this._bspTrees.set(workspace, tree);
        }

        // Restore saved split ratios ONLY when the window set changed
        // (fresh session build, a window opened, or one closed). A plain
        // retile after a manual resize has the same leaf signature → no
        // reconcile → live ratios are never stomped; the resize itself
        // already scheduled a save (retiles are the save trigger), so the
        // saved shape stays current for the next window-set change.
        if (tree && this._dwindleLeafSigs) {
            const sig = tiledWindows.map(w => w.get_id()).join(',');
            if (this._dwindleLeafSigs.get(workspace) !== sig) {
                this._dwindleLeafSigs.set(workspace, sig);
                const savedShape = this._persistedDwindleByIndex &&
                    this._persistedDwindleByIndex.get(this._wsIndex(workspace));
                if (savedShape && this._reconcileTreeRatios(savedShape, tree))
                    this._debugLog(`dwindle: restored saved split ratios (ws=${this._wsIndex(workspace)}, windows=${tiledWindows.length})`);
            }
        }

        this._treeMinSizes(tree);
        this._clampTreeToMinSizes(tree, areaW, areaH, gap);
        this._bspLayout(tree, areaX, areaY, areaW, areaH, gap);
    }

    _moveWindow(win, x, y, w, h) {
        if (!win || win.is_fullscreen()) return;
        if (!win.get_workspace()) return;
        const rect = win.get_frame_rect();
        if (rect.width === 0 || rect.height === 0) return;
        if (win.is_maximized()) {
            try { win.unmaximize(); } catch (_e) {}
        }
        if (this._animTargets) {
            this._animTargets.set(win, { x, y, w, h });
            return;
        }
        try {
            const actor = win.get_compositor_private();
            if (actor) actor.remove_all_transitions();
            win.move_resize_frame(true, x, y, w, h);
        } catch (e) {
            log(`[plaid] _moveWindow failed: ${e.message}`);
        }
    }

    _convertMaximizedToGaps(win) {
        if (this._destroyed || !win) return;
        if (!this._settings || !this._settings.get_boolean('enabled')) return;
        if (this._dropdownWin === win) return;
        if (win.is_fullscreen() || !win.is_maximized()) return;
        if (this._isFloating(win)) {
            this._handleFloatMaximize(win);
            return;
        }
        const ws = win.get_workspace();
        if (!ws) return;
        let workArea = null;
        try {
            workArea = ws.get_work_area_for_monitor(win.get_monitor());
        } catch (_e) {}
        if (!workArea) return;
        const rect = this._singleWindowRect(workArea);
        if (!rect) return;
        this._debugLog(`maximize: converting to gapped rect=(${rect.x},${rect.y},${rect.w},${rect.h})`);
        try { win.unmaximize(); } catch (_e) {}
        this._moveWindow(win, rect.x, rect.y, rect.w, rect.h);
    }

    _handleFloatMaximize(win) {
        if (this._gappedMaxSet.has(win)) {
            const saved = this._floatMaxRects.get(win);
            try { win.unmaximize(); } catch (_e) {}
            if (saved && saved.w > 0) {
                this._debugLog(`float maximize: restoring (${saved.x},${saved.y},${saved.w},${saved.h})`);
                this._applyFloatRect(win, saved.x, saved.y, saved.w, saved.h, (success) => {
                    if (success) this._gappedMaxSet.delete(win);
                });
            } else {
                this._gappedMaxSet.delete(win);
            }
            return;
        }
        if (!this._floatMaxRects.has(win)) {
            this._debugLog('float maximize: no saved rect, leaving window normally maximized');
            return;
        }
        const ws = win.get_workspace();
        if (!ws) return;
        let workArea = null;
        try {
            workArea = ws.get_work_area_for_monitor(win.get_monitor());
        } catch (_e) {}
        if (!workArea) return;
        const rect = this._singleWindowRect(workArea);
        if (!rect) return;
        this._debugLog(`float maximize: gapped rect=(${rect.x},${rect.y},${rect.w},${rect.h})`);
        this._gappedMaxSet.add(win);
        this._applyFloatRect(win, rect.x, rect.y, rect.w, rect.h);
    }

    _applyFloatRect(win, x, y, w, h, onDone) {
        let retries = 0;
        const apply = () => {
            if (this._destroyed) return false;
            if (!win.get_workspace()) return false;
            try {
                if (win.is_maximized()) win.unmaximize();
            } catch (_e) {}
            this._moveWindow(win, x, y, w, h);
            const f = win.get_frame_rect();
            if (f.x === x && f.y === y && f.width === w && f.height === h) {
                if (onDone) { try { onDone(true); } catch (_e) {} }
                return false;
            }
            retries++;
            if (retries >= 15) {
                if (onDone) { try { onDone(false); } catch (_e) {} }
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

    _trackFloatGeometry(win) {
        if (!this._floatMaxRects || !win) return;
        if (!this._isFloating(win) || win.is_maximized()) return;
        if (this._gappedMaxSet.has(win)) return;
        const f = win.get_frame_rect();
        if (f.width > 0 && f.height > 0)
            this._floatMaxRects.set(win, { x: f.x, y: f.y, w: f.width, h: f.height });
    }

    _onWindowIdentityChanged(win) {
        if (this._destroyed || !win) return;
        this._debugLog(`identity: ${this._winClassCandidates(win).join('/') || '?'} appId=${win.get_gtk_application_id ? (win.get_gtk_application_id() || '?') : '?'} ws=${this._wsIndex(win.get_workspace())} managed=${this._windowWorkspaces.has(win)}`);
        // Backstop for the Extensions app / prefs window: its wm-class and GTK
        // app id can resolve AFTER the window was already added to the tiler.
        // If it identifies as the Extensions app now, un-tile it and restore
        // the layout so opening prefs never leaves the workspace rearranged.
        try {
            const wms = (win.get_wm_class_instance() || '').toLowerCase();
            const appId = (win.get_gtk_application_id && win.get_gtk_application_id() || '').toLowerCase();
            if (wms === 'org.gnome.shell.extensions' || wms === 'org.gnome.extensions' ||
                appId === 'org.gnome.shell.extensions' || appId === 'org.gnome.extensions') {
                if (this._windowWorkspaces.has(win)) {
                    this._debugLog('extensions app: un-tiling settings window (late identity)');
                    const ws = win.get_workspace();
                    this._removeWindow(win);
                    if (ws) this._retileWorkspace(ws);
                }
                return;
            }
        } catch (_e) {}
        if (!this._isFloating(win)) return;
        const ws = win.get_workspace();
        if (ws) {
            const tree = this._bspGetTree(ws);
            if (tree && this._bspCollectWindows(tree).includes(win)) {
                this._bspTrees.set(ws, this._bspRemove(tree, win));
                this._retileWorkspace(ws);
            }
        }
        // The window may be in the maximized state from mutter's map-time
        // auto-maximize (a pre-map full-area slot > 80% of the work area) —
        // _restoreFloatNaturalRect refuses maximized windows, so undo the
        // state first, then restore the spawn rect captured at _addWindow.
        if (win.is_maximized()) {
            try { win.unmaximize(); } catch (_e) {}
        }
        this._restoreFloatNaturalRect(win);
        // Reveal: the window can be pending-hidden from the tiled
        // choreography (actor.visible=false + mask uniform 0) when its
        // identity resolved late to floating — nothing else reveals it, so
        // it would sit invisible until the 2.5s safety timer. Reveal now.
        // GUARD: a DELIBERATELY minimized window (the scratch layer, or the
        // user's own minimize) must never be force-shown by an identity /
        // title notify — GTK re-applies titles on state changes, so this
        // reveal un-minimized scratch windows within milliseconds of the
        // scratch-add's minimize (the "add does nothing" bug: hide →
        // instant re-show → net zero on screen).
        if (win.minimized) {
            this._debugLog(`float reveal skipped (minimized): ${win.get_wm_class_instance() || '?'}`);
            return;
        }
        this._debugLog(`float reveal: ${win.get_wm_class_instance() || '?'}`);
        try {
            if (this._pendingWarp) this._pendingWarp.delete(win);
            const a = win.get_compositor_private();
            if (a) {
                a.visible = true;
                a.set_opacity(255);
            }
            const effect = this._windowMasks && this._windowMasks.get(win);
            if (effect && effect.setOpacityUniform)
                effect.setOpacityUniform(1);
        } catch (_e) {}
    }

    _restoreFloatNaturalRect(win) {
        if (!this._savedRects || !this._savedRects.has(win)) return;
        if (win.is_fullscreen() || win.is_maximized()) return;
        const saved = this._savedRects.get(win);
        if (!saved || saved.w === 0) return;
        const frame = win.get_frame_rect();
        if (frame.width === 0) return;
        const ws = win.get_workspace();
        if (!ws) return;
        let workArea = null;
        try {
            workArea = ws.get_work_area_for_monitor(win.get_monitor());
        } catch (_e) {}
        if (!this._isValidWorkArea(workArea)) return;
        if (frame.width < workArea.width - 20 || frame.height < workArea.height - 20) return;
        this._debugLog(`float: restoring natural rect (${saved.x},${saved.y},${saved.w},${saved.h})`);
        this._moveWindow(win, saved.x, saved.y, saved.w, saved.h);
    }

    _reapplyFloatRules() {
        if (this._destroyed || !this._settings) return;
        for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
            const ws = global.workspace_manager.get_workspace_by_index(i);
            for (const win of ws.list_windows()) {
                if (this._isFloating(win)) {
                    this._restoreFloatNaturalRect(win);
                }
            }
        }
        this._updateBorders();
    }

    _updateBorders() {
        if (!this._settings || this._destroyed) return;
        this._scheduleBorders();
    }

    _doUpdateBorders() {
        if (!this._settings) return;

        // Flair (borders, rounded corners, blur) renders from its own
        // settings and stays even when tiling is toggled off.

        const focusWindow = global.display.focus_window;

        const borderRadius = this._settings.get_int('border-radius');
        const roundedCorners = this._settings.get_boolean('rounded-corners');
        const bordersEnabled = this._settings.get_boolean('borders-enabled');
        const blurEnabled = this._settings.get_boolean('window-blur');

        // Only sweep ALL borders when the feature turned off — otherwise
        // _ensureWindowBorder's per-window signature gate skips unchanged
        // windows (destroy/recreate churn on every focus change is the
        // biggest steady-state cost under hover-focus).
        if (!bordersEnabled) {
            try { this._removeAllBorders(); } catch (_e) {}
        }

        const ws = global.workspace_manager.get_active_workspace();
        if (!ws) return;

        const windows = this._getWindowsForWorkspace(ws);
        for (const win of windows) {
            if (win.is_fullscreen()) {
                this._removeMask(win);
                this._removeBlur(win);
                this._removeBorder(win);
                continue;
            }
            // The grab skip must compare against the GRABBED window — the focus
            // window can differ mid-grab (hover-focus during a drag), and
            // the grabbed-but-unfocused window then got stale mask uniforms
            // for the whole grab (2026-10-04 audit).
            if (this._grabOp && this._grabWindow && win === this._grabWindow) continue;
            const actor = win.get_compositor_private();
            if (!actor) continue;
            const frame = win.get_frame_rect();
            if (frame.width === 0 || frame.height === 0) continue;

            if (blurEnabled && !(this._pendingWarp && this._pendingWarp.has(win)))
                this._ensureWindowBlur(win, actor);

            const isFocused = win === focusWindow;
            const scratch = !!(this._scratchpadWindows && this._scratchpadWindows.has(win));

            if (roundedCorners && borderRadius > 0) {
                // Stale-widget purge FIRST (was after the mask): updateMask
                // zeroes the SDF border while a widget still exists, so the
                // old order left a borderless gap between the mask pass and
                // the purge — now the widget is gone before the mask draws.
                // Mask-only WINDOWS (not floats) must not keep a widget
                // border from an earlier floating state — this path never
                // re-creates or updates it, so it freezes stale (double
                // border at the old geometry) until a full rebuild.
                // FLOATS are excluded: their widget border is LIVE (made
                // by the floating flair loop) — purging it every pass
                // churned widgets + logged unconditionally, and
                // _removeBorder → _removeMask cleared the mask quarantine
                // — re-opening the empty-capture hole the self-heal
                // exists to prevent for registered-then-floated X11
                // windows. Border-only teardown: keep the mask alive.
                if (!scratch && !this._isFloating(win) && this._windowBorders.has(win)) {
                    this._debugLog(`border: removed stale widget border on mask-only window ${win.get_wm_class_instance() || '?'}`);
                    try { this._windowBorders.get(win).destroy(); } catch (_e) {}
                    this._windowBorders.delete(win);
                    if (this._scratchpadRings) {
                        const ring = this._scratchpadRings.get(win);
                        if (ring) {
                            try { ring.destroy(); } catch (_e) {}
                            this._scratchpadRings.delete(win);
                        }
                    }
                }
                // Widget before mask (same ordering rule as the floating
                // loop) for the scratch fall-through.
                if (scratch && bordersEnabled)
                    this._ensureWindowBorder(win, actor, frame, isFocused);
                this._ensureWindowMask(win, actor, borderRadius + 1);
                // Scratch windows fall through to their special border even
                // with rounded corners (normal windows stay mask-only).
                if (!scratch)
                    continue;
            }

            if (bordersEnabled) this._ensureWindowBorder(win, actor, frame, isFocused);
        }

        // Floating windows are not in _windowWSIndices (they skip _addWindow),
        // so the tiled loop above misses them. Apply Flair directly.
        for (const win of ws.list_windows()) {
            if (win.get_window_type() !== Meta.WindowType.NORMAL) continue;
            if (!this._isFloating(win)) continue;
            // The tiled fullscreen branch drops border+mask+blur; the float branch
            // missed the WIDGET border (and scratch ring) — a floating
            // window entering fullscreen kept its colored frame + ring
            // rendered on top of the fullscreen content (X11 floats; the
            // mask is gone there so the widget is unclipped)
            // (2026-10-04 audit).
            if (win.is_fullscreen()) { this._removeMask(win); this._removeBlur(win); this._removeBorder(win); continue; }
            const actor = win.get_compositor_private();
            if (!actor) continue;
            const frame = win.get_frame_rect();
            if (frame.width === 0 || frame.height === 0) continue;
            if (blurEnabled) this._ensureWindowBlur(win, actor);
            const isFocused = win === focusWindow;
            // Order matters: create the WIDGET border before the mask —
            // _updateMaskBounds zeroes the SDF border when a renderable
            // widget exists, so creating the widget first avoids a
            // first-pass (or transition-pass) transient double border.
            if (bordersEnabled) this._ensureWindowBorder(win, actor, frame, isFocused);
            if (roundedCorners && borderRadius > 0)
                this._ensureWindowMask(win, actor, borderRadius + 1);
        }

        // The border animation is armed by _syncBorderAnimation() below with the
        // full condition (gradient + speed + live borders/masks). A standalone
        // start here (without the maps check) armed the tick on every pass
        // even with empty maps — start log → sync stops it → next pass:
        // a per-pass `border animation: start` log pair.

        if (!roundedCorners || borderRadius <= 0)
            this._removeAllMasks();

        if (!blurEnabled)
            this._removeAllBlurs();

        if (this._dropdownWin)
            this._applyDropdownEffects(this._dropdownWin);

        this._syncBorderAnimation();
    }

    _debugLog(...args) {
        if (this._destroyed || !this._settings) return;
        if (!this._settings.get_boolean('debug')) return;
        log(`[plaid] ${args.join(' ')}`);
    }

    _updateDropOverlaySize() {
        const monitors = global.display.get_n_monitors();
        let maxX = 0, maxY = 0;
        for (let i = 0; i < monitors; i++) {
            const geom = global.display.get_monitor_geometry(i);
            maxX = Math.max(maxX, geom.x + geom.width);
            maxY = Math.max(maxY, geom.y + geom.height);
        }
        if (this._dropOverlay) {
            this._dropOverlay.set_position(0, 0);
            this._dropOverlay.set_size(maxX, maxY);
        }
    }

    _getActiveWindow() {
        return global.display.focus_window;
    }

    _moveFocus(direction) {
        const focused = this._getActiveWindow();
        if (!focused) return;
        const ws = focused.get_workspace();
        if (!ws) return;

        const windows = this._getWindowsForWorkspace(ws)
            .filter(w => !this._isFloating(w));
        if (windows.length <= 1) return;

        const bestWindow = this._findDirectionalTarget(focused, direction, windows);
        if (!bestWindow) return;

        this._keyboardFocusChange = true;
        bestWindow.activate(this._currentTime());
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._destroyed) return false;
            this._keyboardFocusChange = false;
            return false;
        });
    }

    _swapWindow(direction) {
        const focused = this._getActiveWindow();
        if (!focused) return;
        if (this._isFloating(focused)) {
            this._moveFloating(focused, direction);
            return;
        }
        const ws = focused.get_workspace();
        if (!ws) return;
        if (this._getWorkspaceLayout(ws) === 'floating') {
            this._moveFloating(focused, direction);
            return;
        }

        const windows = this._getWindowsForWorkspace(ws)
            .filter(w => !this._isFloating(w));
        if (windows.length <= 1) return;

        const bestWindow = this._findDirectionalTarget(focused, direction, windows);
        if (!bestWindow) return;

        const layout = this._getWorkspaceLayout(ws);
        if (layout === 'dwindle') {
            const tree = this._bspGetTree(ws);
            if (tree) {
                this._bspSwapWindows(tree, focused, bestWindow);
            }
        } else {
            this._swapMasterStackWindows(focused, bestWindow);
        }
        this._retileWorkspace(ws);
        this._keyboardFocusChange = true;
        focused.activate(this._currentTime());
        this._cursorWarpDeferred(focused);
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._destroyed) return false;
            this._keyboardFocusChange = false;
            return false;
        });
    }

    _resizeWindow(action, axis) {
        const focused = this._getActiveWindow();
        if (!focused) return;

        const amount = this._settings.get_int('resize-amount');
        const delta = action === 'grow' ? amount : -amount;

        if (this._isFloating(focused)) {
            this._resizeFloating(focused, axis, delta);
            return;
        }

        const ws = focused.get_workspace();
        if (!ws) return;
        if (this._getWorkspaceLayout(ws) === 'floating') {
            this._resizeFloating(focused, axis, delta);
            return;
        }

        const tiledWindows = this._getWindowsForWorkspace(ws)
            .filter(w => !this._isFloating(w));
        const idx = tiledWindows.indexOf(focused);
        if (idx === -1 || tiledWindows.length <= 1) return;

        const layout = this._getWorkspaceLayout(ws);
        if (layout === 'dwindle')
            this._resizeDwindle(focused, ws, axis, delta);
        else
            this._resizeMasterStack(focused, ws, axis, delta);

        this._retileWorkspace(ws);
        if (this._settings.get_boolean('follow-focus'))
            this._cursorWarpDeferred(focused);
    }

    _resizeFloating(win, axis, delta) {
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
        this._animFloat(win, x, y, w, h);
        this._moveCursorToWindow(win);
    }

    _moveFloating(win, direction) {
        const amount = this._settings.get_int('resize-amount');
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
        this._animFloat(win, x, y, frame.width, frame.height);
        this._moveCursorToWindow(win);
    }

    _resizeDwindle(focused, workspace, axis, delta) {
        const tree = this._bspGetTree(workspace);
        if (!tree) return;

        const targetIsHorizontal = axis === 'width';
        const path = [];
        this._bspFindPath(tree, focused, path);

        for (let i = path.length - 1; i >= 0; i--) {
            const split = path[i];
            if ((split.direction === 'h') === targetIsHorizontal) {
                const monitor = global.display.get_primary_monitor();
                const workArea = workspace.get_work_area_for_monitor(monitor);
                if (!workArea) return;
                // Scale the delta by the split's OWN span (tagged by
                // _bspTagGeometry during layout) so a deep-nested split
                // moves by the same RELATIVE amount as a top-level one —
                // the old full-work-area divisor made the resize feel
                // shallower at depth and shift with the gap settings
                // (2026-10-04 audit).
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
                // them (2026-10-05 audit).
                const inFirst = this._bspFindPath(split.first, focused, []);
                const signedDelta = inFirst ? delta : -delta;
                split.ratio = Math.max(0.15, Math.min(0.85, split.ratio + signedDelta / axisSize));
                return;
            }
        }
    }

    _toggleFloat() {
        const focused = this._getActiveWindow();
        if (!focused) return;

        const wasFloating = this._toggleFloatWindows.has(focused);
        if (wasFloating) {
            this._toggleFloatWindows.delete(focused);
        } else {
            this._toggleFloatWindows.add(focused);
        }
        const ws = focused.get_workspace();
        if (!ws) return;

        if (wasFloating) {
            const layout = this._getWorkspaceLayout(ws);
            if (layout === 'dwindle')
                this._bspInsertForWorkspace(ws, focused);
        } else {
            const layout = this._getWorkspaceLayout(ws);
            if (layout === 'dwindle') {
                const tree = this._bspGetTree(ws);
                if (tree)
                    this._bspTrees.set(ws, this._bspRemove(tree, focused));
            }
        }

        this._keyboardFocusChange = true;
        this._retileWorkspace(ws);
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._destroyed) return false;
            this._keyboardFocusChange = false;
            return false;
        });
    }

    _toggleTiling() {
        this._settings.set_boolean('enabled', !this._settings.get_boolean('enabled'));
    }

    _toggleMaximize() {
        const win = this._getActiveWindow();
        if (!win) return;
        try {
            if (win.is_maximized()) {
                win.unmaximize();
                return;
            }
            const saved = this._maximizeToggleRects && this._maximizeToggleRects.get(win);
            if (saved) {
                this._maximizeToggleRects.delete(win);
                try { win.unmaximize(); } catch (_e) {}
                if (saved.w > 0)
                    win.move_resize_frame(true, saved.x, saved.y, saved.w, saved.h);
                return;
            }
            const f = win.get_frame_rect();
            if (this._maximizeToggleRects)
                this._maximizeToggleRects.set(win, { x: f.x, y: f.y, w: f.width, h: f.height });
            win.maximize();
        } catch (e) {
            log(`[plaid] toggle maximize failed: ${e.message}`);
        }
    }

    _onTilingEnabledChanged() {
        if (!this._settings) return;
        const enabled = this._settings.get_boolean('enabled');

        if (enabled) {
            for (const win of this._windowWorkspaces.keys())
                this._capturePosition(win);
            this._keyboardFocusChange = true;
            this._retileAll();
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._keyboardFocusChange = false;
                return false;
            });
            this._checkDynamicWorkspaces();
            if (this._settings.get_boolean('workspace-popup'))
                this._showPopup('Tiling Enabled');
        } else {
            this._restoreSavedPositions();
            if (this._settings.get_boolean('workspace-popup'))
                this._showPopup('Tiling Disabled');
        }
    }

    _capturePosition(win) {
        if (!this._savedRects || this._savedRects.has(win)) return;
        try {
            const frame = win.get_frame_rect();
            if (frame.width > 0 && frame.height > 0)
                this._savedRects.set(win, { x: frame.x, y: frame.y, w: frame.width, h: frame.height });
        } catch (_e) {}
    }

    _restoreSavedPositions() {
        if (!this._savedRects) return;
        for (const [win, rect] of this._savedRects) {
            try {
                if (!win.get_compositor_private() || win.is_fullscreen()) continue;
                win.move_resize_frame(true, rect.x, rect.y, rect.w, rect.h);
            } catch (_e) {}
        }
        this._savedRects.clear();
    }

    _centerWindow() {
        const win = this._getActiveWindow();
        if (!win) return;
        if (!this._isFloating(win)) return;

        const ws = win.get_workspace();
        if (!ws) return;

        const frame = win.get_frame_rect();
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return;

        const x = workArea.x + Math.floor((workArea.width - frame.width) / 2);
        const y = workArea.y + Math.floor((workArea.height - frame.height) / 2);

        const actor = win.get_compositor_private();
        if (actor) actor.remove_all_transitions();

        win.move_resize_frame(true, x, y, frame.width, frame.height);

        this._keyboardFocusChange = true;
        win.activate(this._currentTime());

        this._moveCursorToWindow(win);

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._destroyed) return false;
            this._keyboardFocusChange = false;
            return false;
        });
    }


    _cycleLayout() {
        const layouts = ['dwindle', 'master-stack', 'centered-master-stack', 'floating'];
        const ws = global.workspace_manager.get_active_workspace();
        if (!ws) return;
        const current = this._getWorkspaceLayout(ws);
        const idx = layouts.indexOf(current);
        const next = layouts[(idx + 1) % layouts.length];
        if (next !== current) {
            this._workspaceLayouts.set(this._wsIndex(ws), next);
            this._retileWorkspace(ws);
            this._showPopup(`Layout: ${LAYOUT_NAMES[next] || next}`);
            this._scheduleSaveLayouts();
        }
    }

    _showWorkspacePopup(ws) {
        if (!ws) return;
        const layout = this._getWorkspaceLayout(ws);
        this._showPopup(`Workspace ${this._bgAppRealToDisplay(this._wsIndex(ws)) + 1}`,
            `Layout: ${LAYOUT_NAMES[layout] || layout}`);
    }

    _showPopup(title, subtitle = null, duration = 3000, onActivate = null) {
        if (this._layoutPopupHideId) {
            GLib.source_remove(this._layoutPopupHideId);
            this._layoutPopupHideId = 0;
        }
        if (this._layoutPopup) {
            try { this._layoutPopup.remove_all_transitions(); } catch (_e) {}
            try { this._layoutPopup.destroy(); } catch (_e) {}
            this._layoutPopup = null;
        }

        const monitors = global.display.get_n_monitors();
        let maxX = 0, maxY = 0;
        for (let i = 0; i < monitors; i++) {
            const geom = global.display.get_monitor_geometry(i);
            maxX = Math.max(maxX, geom.x + geom.width);
            maxY = Math.max(maxY, geom.y + geom.height);
        }
        const bottomMargin = Math.floor(maxY * 0.70);

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: `background-color: rgba(0, 0, 0, 0.7); border-radius: 12px; padding: 14px 28px; spacing: 4px; margin-top: ${bottomMargin}px;`,
        });
        box.add_child(new St.Label({
            text: title,
            style: 'font-size: 20px; font-weight: bold; color: #ffffff;',
        }));
        if (subtitle) {
            box.add_child(new St.Label({
                text: subtitle,
                style: 'font-size: 14px; color: rgba(255, 255, 255, 0.8);',
            }));
        }

        const popup = new St.Bin({
            child: box,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: onActivate !== null,
        });
        this._layoutPopup = popup;
        popup.set_position(0, 0);
        popup.set_size(maxX, maxY);
        Main.layoutManager.uiGroup.add_child(popup);
        this._debugLog(`popup shown: ${title}`);

        const dismissPopup = () => {
            if (this._layoutPopupHideId) {
                GLib.source_remove(this._layoutPopupHideId);
                this._layoutPopupHideId = 0;
            }
            if (this._layoutPopup === popup) {
                popup.ease({
                    opacity: 0,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => {
                        if (this._layoutPopup === popup) {
                            this._layoutPopup.destroy();
                            this._layoutPopup = null;
                        }
                    },
                });
            }
        };

        if (onActivate) {
            popup.connect('button-press-event', () => {
                dismissPopup();
                try { onActivate(); } catch (_e) {}
                return Clutter.EVENT_STOP;
            });
        }

        popup.opacity = 0;
        popup.ease({
            opacity: 255,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._layoutPopupHideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration, () => {
            this._layoutPopupHideId = 0;
            dismissPopup();
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- Workspace Switcher Popup ---

    _suppressWorkspaceSwitcherPopup() {
        try {
            this._origWorkspaceSwitcherDisplay = WorkspaceSwitcherPopup.prototype.display;
            WorkspaceSwitcherPopup.prototype.display = function (index) {
                this.destroy();
            };
        } catch (_e) {
            this._origWorkspaceSwitcherDisplay = null;
        }
    }

    _restoreWorkspaceSwitcherPopup() {
        if (this._origWorkspaceSwitcherDisplay) {
            try {
                WorkspaceSwitcherPopup.prototype.display = this._origWorkspaceSwitcherDisplay;
            } catch (_e) {}
            this._origWorkspaceSwitcherDisplay = null;
        }
    }

    _getJPSettings() {
        try {
            const jpExt = Extension.lookupByUUID('just-perfection-desktop@just-perfection');
            if (!jpExt) {
                this._debugLog('workspace popup: JP extension not loaded');
                return null;
            }
            const settings = jpExt.getSettings();
            this._debugLog('workspace popup: JP settings acquired');
            return settings;
        } catch (e) {
            this._debugLog('workspace popup: JP settings lookup failed:', String(e));
            return null;
        }
    }

    _initWorkspacePopupWarning() {
        try {
            this._shellSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
            this._shellSettingsChangedId = this._shellSettings.connect(
                'changed::enabled-extensions',
                () => this._updateWorkspacePopupWarning());
        } catch (_e) {
            this._shellSettings = null;
        }
        this._jpSettings = this._getJPSettings();
        if (this._jpSettings) {
            this._jpSettingsChangedId = this._jpSettings.connect(
                'changed::workspace-popup',
                () => this._updateWorkspacePopupWarning());
        }
        this._warningPopupId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._warningPopupId = 0;
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            this._updateWorkspacePopupWarning();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateWorkspacePopupWarning() {
        if (this._destroyed) return;
        const jpExt = Extension.lookupByUUID('just-perfection-desktop@just-perfection');
        if (!jpExt) {
            if (this._jpSettings) {
                if (this._jpSettingsChangedId) {
                    try { this._jpSettings.disconnect(this._jpSettingsChangedId); } catch (_e) {}
                }
                this._jpSettings = null;
                this._jpSettingsChangedId = 0;
            }
        } else if (!this._jpSettings) {
            this._jpSettings = this._getJPSettings();
            if (this._jpSettings) {
                this._jpSettingsChangedId = this._jpSettings.connect(
                    'changed::workspace-popup',
                    () => this._updateWorkspacePopupWarning());
            }
        }
        let overlap = false;
        try {
            const jpEnabled = !!(this._shellSettings &&
                this._shellSettings.get_strv('enabled-extensions')
                    .includes('just-perfection-desktop@just-perfection'));
            const jpSuppresses = !!(this._jpSettings &&
                !this._jpSettings.get_boolean('workspace-popup'));
            overlap = jpEnabled && jpSuppresses;
            this._debugLog(`workspace popup: jpEnabled=${jpEnabled} jpSuppresses=${jpSuppresses} overlap=${overlap}`);
        } catch (e) {
            overlap = false;
            this._debugLog('workspace popup: overlap check error:', String(e));
        }
        if (overlap) {
            if (!this._warningPopup) {
                this._debugLog('workspace popup: showing warning');
                this._showWarningPopup('Workspace Popup Hidden',
                    'Just Perfection also manages the workspace popup — workspace-switch popups may be suppressed. Plaid’s tiling popups are unaffected.',
                    'Click to dismiss');
            }
        } else {
            this._hideWarningPopup();
        }
    }

    _hideWarningPopup() {
        const popup = this._warningPopup;
        if (!popup) return;
        this._warningPopup = null;
        try { popup.remove_all_transitions(); } catch (_e) {}
        popup.ease({
            opacity: 0,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                try { popup.destroy(); } catch (_e) {}
            },
        });
    }

    _showWarningPopup(title, subtitle, hint) {
        try {
            if (Main.overview && Main.overview.visible) {
                this._pendingWarning = { title, subtitle, hint };
                if (!this._pendingWarningOverviewId) {
                    this._pendingWarningOverviewId = Main.overview.connect('hidden', () => {
                        if (this._pendingWarningOverviewId) {
                            try { Main.overview.disconnect(this._pendingWarningOverviewId); } catch (_e) {}
                            this._pendingWarningOverviewId = 0;
                        }
                        if (this._pendingWarning) {
                            const pending = this._pendingWarning;
                            this._pendingWarning = null;
                            this._displayWarningPopup(pending.title, pending.subtitle, pending.hint);
                        }
                    });
                }
                return;
            }
        } catch (_e) {}
        this._displayWarningPopup(title, subtitle, hint);
    }

    _displayWarningPopup(title, subtitle, hint) {
        if (this._warningPopup) {
            try { this._warningPopup.remove_all_transitions(); } catch (_e) {}
            try { this._warningPopup.destroy(); } catch (_e) {}
            this._warningPopup = null;
        }

        const monitors = global.display.get_n_monitors();
        let maxX = 0, maxY = 0;
        for (let i = 0; i < monitors; i++) {
            const geom = global.display.get_monitor_geometry(i);
            maxX = Math.max(maxX, geom.x + geom.width);
            maxY = Math.max(maxY, geom.y + geom.height);
        }
        const bottomMargin = Math.floor(maxY * 0.70);

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: `background-color: rgba(0, 0, 0, 0.75); border-radius: 16px; padding: 22px 40px; spacing: 8px; margin-top: ${bottomMargin}px; min-width: 480px;`,
        });
        box.add_child(new St.Label({
            text: title,
            style: 'font-size: 24px; font-weight: bold; color: #ffffff;',
        }));
        if (subtitle) {
            box.add_child(new St.Label({
                text: subtitle,
                style: 'font-size: 16px; color: rgba(255, 255, 255, 0.85);',
            }));
        }
        if (hint) {
            box.add_child(new St.Label({
                text: hint,
                style: 'font-size: 14px; color: rgba(255, 255, 255, 0.6);',
            }));
        }

        const popup = new St.Bin({
            child: box,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });
        this._warningPopup = popup;
        popup.set_position(0, 0);
        popup.set_size(maxX, maxY);
        Main.layoutManager.uiGroup.add_child(popup);

        popup.connect('button-press-event', () => {
            if (this._warningPopup !== popup) return;
            popup.remove_all_transitions();
            popup.ease({
                opacity: 0,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    if (this._warningPopup === popup) {
                        try { this._warningPopup.destroy(); } catch (_e) {}
                        this._warningPopup = null;
                    }
                },
            });
        });

        popup.opacity = 0;
        popup.ease({
            opacity: 255,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // --- Notifications ---

    _notifyCritical(title, body) {
        try {
            const conn = Gio.DBus.session;
            const variant = new GLib.Variant('(susssasa{sv}i)', [
                'org.gnome.Shell.Extensions.Plaid', 0, '',
                title, body, [],
                { urgency: new GLib.Variant('y', 2) }, -1,
            ]);
            conn.call(
                'org.freedesktop.Notifications', '/org/freedesktop/Notifications',
                'org.freedesktop.Notifications', 'Notify',
                variant, null, Gio.DBusCallFlags.NONE, -1, null, null);
        } catch (e) {
            log(`[plaid] critical notification failed: ${e.message}`);
        }
    }


    // --- Grab-Based Mouse Resize & Swap ---

    _connectGrabSignals() {
        this._addSignal(global.display, global.display.connect('grab-op-begin', (_d, metaWindow, grabOp) => {
            if (metaWindow && this._gappedMaxSet && this._gappedMaxSet.has(metaWindow)) {
                this._debugLog('float maximize: drag exits gapped mode');
                this._gappedMaxSet.delete(metaWindow);
                this._floatMaxRects.delete(metaWindow);
            }
            if (this._destroyed || !this._settings || !this._settings.get_boolean('mouse-resize')) return;
            if (!this._settings.get_boolean('enabled')) return;
            this._handleGrabBegin(metaWindow, grabOp);
        }));
        this._addSignal(global.display, global.display.connect('grab-op-end', (_d, metaWindow, grabOp) => {
            this._handleGrabEnd(metaWindow, grabOp);
        }));
        this._addSignal(global.display, global.display.connect('restacked', () => {
            this._syncBlurStacking();
            try { this._reassertFloatingTransients(); } catch (_e) {}
        }));
    }

    _computeGrabGraceThreshold() {
        try {
            const [px, py] = global.get_pointer();
            // get_monitor_at_point() does not exist on Meta.Display in
            // GNOME 50/51 — the old call threw (swallowed) and the grace
            // was pinned at 10px on every monitor. Find the monitor by
            // geometry containment instead.
            let mon = null;
            const n = global.display.get_n_monitors();
            for (let i = 0; i < n; i++) {
                const g = global.display.get_monitor_geometry(i);
                if (px >= g.x && px < g.x + g.width && py >= g.y && py < g.y + g.height) {
                    mon = g;
                    break;
                }
            }
            if (!mon)
                mon = global.display.get_monitor_geometry(global.display.get_primary_monitor());
            const minDim = Math.min(mon.width, mon.height);
            return Math.max(10, Math.min(30, Math.round(minDim / 100)));
        } catch (_e) {
            return 10;
        }
    }

    _handleGrabBegin(metaWindow, grabOp) {
        if (!metaWindow || metaWindow.get_window_type() !== Meta.WindowType.NORMAL) return;
        if (metaWindow.is_skip_taskbar()) return;
        const ws = metaWindow.get_workspace();
        if (!ws || ws !== global.workspace_manager.get_active_workspace()) return;

        const frame = metaWindow.get_frame_rect();
        const buffer = metaWindow.get_buffer_rect();
        if (!frame || frame.width === 0 || frame.height === 0 || !buffer) return;

        this._grabOp = grabOp;

        // Capture the pointer for every tracked grab — the move-grab path
        // (e.g. SSD titlebar clicks) must compare against the real click
        // position, not the constructor's zeroed coords.
        const [startX, startY] = global.get_pointer();
        this._grabStartX = startX;
        this._grabStartY = startY;
        this._grabGrace = this._computeGrabGraceThreshold();

        if (this._isResizeGrab(grabOp)) {
            this._grabWindow = metaWindow;
            const effect = this._windowMasks?.get(metaWindow);
            if (effect)
                effect.setBorderWidth(0);
        }

        const wmClass = metaWindow.get_wm_class_instance() || '?';
        this._debugLog(`GRAB_BEGIN win=${wmClass} rect=${JSON.stringify(frame)} grabOp=${grabOp} isResize=${this._isResizeGrab(grabOp)} isMove=${this._isMoveGrab(grabOp)} float=${this._isFloating(metaWindow)}`);

        if (this._isResizeGrab(grabOp) && !this._isFloating(metaWindow)) {
            const direction = (grabOp >> 12) & 0xF;
            this._grabWidthSign = (direction & 1) ? -1 : (direction & 2) ? 1 : 0;
            this._grabHeightSign = (direction & 8) ? -1 : (direction & 4) ? 1 : 0;
            const tree = this._bspGetTree(ws);
            this._grabResizeNodeW = null;
            this._grabResizeNodeH = null;
            this._grabInitialRatioW = 0;
            this._grabInitialRatioH = 0;

            if (tree) {
                const path = [];
                this._bspFindPath(tree, metaWindow, path);
                for (let i = path.length - 1; i >= 0; i--) {
                    if (path[i].direction === 'h' && this._grabWidthSign !== 0 && !this._grabResizeNodeW) {
                        this._grabResizeNodeW = path[i];
                        this._grabInitialRatioW = path[i].ratio;
                        if (!this._bspFindPath(path[i].first, metaWindow, []))
                            this._grabWidthSign = -this._grabWidthSign;
                    }
                    if (path[i].direction === 'v' && this._grabHeightSign !== 0 && !this._grabResizeNodeH) {
                        this._grabResizeNodeH = path[i];
                        this._grabInitialRatioH = path[i].ratio;
                        if (!this._bspFindPath(path[i].first, metaWindow, []))
                            this._grabHeightSign = -this._grabHeightSign;
                    }
                }
            }

            this._grabInitialMasterRatio = this._getMasterRatio(ws);
            const sr = this._getStackRatios(ws);
            this._grabInitialStackRatios = new Map(sr);

            this._startGrabLoop(metaWindow, 'resize');
            this._disconnectGrabBoundaryHooks();
            try {
                this._grabSizeChangedId = metaWindow.connect('size-changed', () =>
                    this._enforceGrabBoundary(metaWindow));
                this._grabPositionChangedId = metaWindow.connect('position-changed', () =>
                    this._enforceGrabBoundary(metaWindow));
            } catch (_e) {}
        } else if (this._isMoveGrab(grabOp) && !this._isFloating(metaWindow)) {
            this._startGrabLoop(metaWindow, 'move');
        } else {
            this._grabOp = null;
            this._grabWindow = null;
        }
    }

    _handleGrabEnd(metaWindow, grabOp) {
        const wasTracking = this._grabOp !== null;

        if (wasTracking && metaWindow && !this._isFloating(metaWindow)) {
            const ws = metaWindow.get_workspace();
            if (ws) {
                if (this._isMoveGrab(grabOp)) {
                    // Click-vs-drag guard: a titlebar click on a decorated
                    // window starts a move grab with no real movement — only
                    // reposition when the pointer actually travelled.
                    try {
                        const [ex, ey] = global.get_pointer();
                        const dx = ex - this._grabStartX;
                        const dy = ey - this._grabStartY;
                        const grace = this._grabGrace ?? 10;
                        if (Math.hypot(dx, dy) >= grace)
                            this._repositionWindow(metaWindow, ws);
                    } catch (_e) {}
                }
                this._retileWorkspace(ws);
                try { metaWindow.raise(); } catch (_e) {}
            }
        }

        if (wasTracking && metaWindow)
            this._kickMaskNow(metaWindow);

        if (wasTracking && metaWindow) {
            const wmClass = metaWindow.get_wm_class_instance() || '?';
            const ws = metaWindow.get_workspace();
            if (ws) {
                const tree = this._bspGetTree(ws);
                const treeWins = tree ? this._bspCollectWindows(tree) : [];
                const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
                this._debugLog(`GRAB_END win=${wmClass} treeWins=[${treeWins.map(w => w.get_wm_class_instance() || '?').join(',')}] tiled=[${tiled.map(w => w.get_wm_class_instance() || '?').join(',')}]`);
            }
        }

        this._hideDropPreview();
        this._stopLiveResizeLoop();
        this._disconnectGrabBoundaryHooks();
        this._grabOp = null;
        this._grabWindow = null;
        this._grabInitialStackRatios = null;
        this._startBorderAnimation();
    }

    _isResizeGrab(grabOp) {
        // MetaGrabOp is bitfield-encoded (identical on mutter 18 and 51):
        // WINDOW_BASE=1, direction in bits 12-15 (W=1,E=2,S=4,N=8).
        // Resize ops have direction bits; move ops have none.
        if (grabOp === Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN) return true;
        if (grabOp === Meta.GrabOp.NONE) return false;
        const direction = (grabOp >> 12) & 0xF;
        return (grabOp & 1) !== 0 && direction !== 0;
    }

    _isMoveGrab(grabOp) {
        if (grabOp === Meta.GrabOp.NONE) return false;
        if (grabOp === Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN) return false;
        const direction = (grabOp >> 12) & 0xF;
        return (grabOp & 1) !== 0 && direction === 0;
    }

    _startGrabLoop(metaWindow, mode) {
        this._stopLiveResizeLoop();

        const ws = metaWindow.get_workspace();

        this._liveResizeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (this._destroyed || !metaWindow || !this._grabOp) {
                this._liveResizeId = 0;
                return GLib.SOURCE_REMOVE;
            }
            const frame = metaWindow.get_frame_rect();
            if (frame.width === 0 || frame.height === 0) return GLib.SOURCE_CONTINUE;

            if (mode === 'resize') {
                const [curX, curY] = global.get_pointer();
                const dx = curX - this._grabStartX;
                const dy = curY - this._grabStartY;

                const gap = this._settings.get_int('inside-gap');
                const monitor = global.display.get_primary_monitor();
                const workArea = ws.get_work_area_for_monitor(monitor);
                if (!workArea) return GLib.SOURCE_CONTINUE;

                const layout = this._getWorkspaceLayout(ws);
                if (layout === 'dwindle') {
                    const tree = this._bspGetTree(ws);
                    if (tree) {
                        const area = this._outsideArea(workArea);
                        if (!area) return GLib.SOURCE_CONTINUE;
                        const areaX = area.x;
                        const areaY = area.y;
                        const areaW = area.w;
                        const areaH = area.h;

                        this._treeMinSizes(tree);
                        if (this._grabResizeNodeW) {
                            const axis = this._grabResizeNodeW._w;
                            if (axis - gap > 0) {
                                const axisSize = axis - gap;
                                const minW1 = this._grabResizeNodeW.first?._minW || 0;
                                const minW2 = this._grabResizeNodeW.second?._minW || 0;
                                const minRatio = minW1 / axisSize;
                                const maxRatio = 1 - minW2 / axisSize;
                                const lo = maxRatio <= minRatio
                                    ? (minW1 + minW2 > 0 ? minW1 / (minW1 + minW2) : 0.15) : minRatio;
                                const hi = maxRatio <= minRatio ? lo : maxRatio;
                                const raw = this._grabInitialRatioW + (dx * this._grabWidthSign) / axisSize;
                                if (Number.isFinite(raw))
                                    this._grabResizeNodeW.ratio = Math.max(lo, Math.min(hi, raw));
                            }
                        }
                        if (this._grabResizeNodeH) {
                            const axis = this._grabResizeNodeH._h;
                            if (axis - gap > 0) {
                                const axisSize = axis - gap;
                                const minH1 = this._grabResizeNodeH.first?._minH || 0;
                                const minH2 = this._grabResizeNodeH.second?._minH || 0;
                                const minRatio = minH1 / axisSize;
                                const maxRatio = 1 - minH2 / axisSize;
                                const lo = maxRatio <= minRatio
                                    ? (minH1 + minH2 > 0 ? minH1 / (minH1 + minH2) : 0.15) : minRatio;
                                const hi = maxRatio <= minRatio ? lo : maxRatio;
                                const raw = this._grabInitialRatioH + (dy * this._grabHeightSign) / axisSize;
                                if (Number.isFinite(raw))
                                    this._grabResizeNodeH.ratio = Math.max(lo, Math.min(hi, raw));
                            }
                        }
                        this._bspTagGeometry(tree, areaX, areaY, areaW, areaH, gap);
                    }
                } else if (layout === 'master-stack' || layout === 'centered-master-stack') {
                    const area = this._outsideArea(workArea);
                    if (!area) return GLib.SOURCE_CONTINUE;
                    const areaW = area.w;
                    const areaH = area.h;

                    if (this._grabWidthSign !== 0) {
                        const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
                        const idx = tiled.indexOf(metaWindow);
                        this._debugLog(`MS_RESIZE dx=${dx} dy=${dy} wSign=${this._grabWidthSign} hSign=${this._grabHeightSign} idx=${idx} numTiled=${tiled.length} initMasterRatio=${this._grabInitialMasterRatio.toFixed(3)}`);
                        let sign = this._grabWidthSign;
                        if (idx > 0) sign = -sign;
                        const masterDenom = layout === 'centered-master-stack' ? areaW - gap * 2 : areaW - gap;
                        if (masterDenom > 0) {
                            let ratioDelta = (dx * sign) / masterDenom;
                            if (layout === 'centered-master-stack' && idx > 0)
                                ratioDelta *= 2;
                            const newRatio = this._grabInitialMasterRatio + ratioDelta;
                            const masterMin = tiled.length > 0 ? (this._getWindowMinSize(tiled[0]).w || 0) : 0;
                            let stackMinW = 0;
                            for (let i = 1; i < tiled.length; i++)
                                stackMinW = Math.max(stackMinW, this._getWindowMinSize(tiled[i]).w || 0);
                            let lo = masterMin / masterDenom;
                            let hi = 1 - stackMinW / masterDenom;
                            if (layout === 'centered-master-stack') {
                                const numStack = tiled.length - 1;
                                const leftCount = Math.ceil(numStack / 2);
                                let leftMinW = 0;
                                let rightMinW = 0;
                                for (let i = 1; i < tiled.length; i++) {
                                    const m = this._getWindowMinSize(tiled[i]).w || 0;
                                    if (i <= leftCount) leftMinW = Math.max(leftMinW, m);
                                    else rightMinW = Math.max(rightMinW, m);
                                }
                                hi = 1 - 2 * Math.max(leftMinW, rightMinW) / masterDenom;
                            }
                            if (hi <= lo) { lo = 0.5; hi = 0.5; }
                            if (Number.isFinite(newRatio))
                                this._masterRatios.set(this._wsIndex(ws), Math.max(lo, Math.min(hi, newRatio)));
                        }
                    }
                    if (this._grabHeightSign !== 0) {
                        const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
                        const idx = tiled.indexOf(metaWindow);
                        if (idx > 0 && this._grabInitialStackRatios) {
                            this._debugLog(`MS_HEIGHT idx=${idx} dy=${dy} hSign=${this._grabHeightSign} initStackRatios=[${[...this._grabInitialStackRatios.entries()].map(([k,v])=>`${k}:${v.toFixed(2)}`).join(',')}]`);
                            const numStack = tiled.length - 1;
                            const gapTotal = gap * (numStack - 1);
                            const totalStackH = areaH - gapTotal;
                            if (totalStackH > 0 && numStack > 1) {
                                const stackRatios = this._getStackRatios(ws);
                                const draggedStackIdx = idx - 1;
                                const pixelDelta = dy * this._grabHeightSign;
                                const otherDelta = -pixelDelta / (numStack - 1);
                                let initTotal = 0;
                                for (let j = 0; j < numStack; j++)
                                    initTotal += this._grabInitialStackRatios.has(j)
                                        ? this._grabInitialStackRatios.get(j) : 1.0;
                                const newHeights = [];
                                for (let j = 0; j < numStack; j++) {
                                    const initW = this._grabInitialStackRatios.has(j)
                                        ? this._grabInitialStackRatios.get(j) : 1.0;
                                    const initH = totalStackH * initW / initTotal;
                                    const delta = j === draggedStackIdx ? pixelDelta : otherDelta;
                                    const minH = tiled.length > j + 1
                                        ? (this._getWindowMinSize(tiled[j + 1]).h || 0) : 0;
                                    newHeights.push(Math.max(minH, initH + delta));
                                }
                                const newTotalH = newHeights.reduce((a, b) => a + b, 0);
                                if (newTotalH > 0) {
                                    for (let j = 0; j < numStack; j++) {
                                        const newW = newHeights[j] / newTotalH * numStack;
                                        stackRatios.set(j, Math.max(0.1, newW));
                                    }
                                }
                            } else if (totalStackH > 0) {
                                const initialWeight = this._grabInitialStackRatios.has(idx - 1)
                                    ? this._grabInitialStackRatios.get(idx - 1) : 1.0;
                                const minH = tiled.length > idx
                                    ? (this._getWindowMinSize(tiled[idx]).h || 0) : 0;
                                const minWeight = totalStackH > 0 ? minH / totalStackH * numStack : 0.1;
                                const newWeight = Math.max(Math.max(0.1, minWeight),
                                    initialWeight + (dy * this._grabHeightSign) / totalStackH * numStack);
                                const stackRatios = this._getStackRatios(ws);
                                stackRatios.set(idx - 1, newWeight);
                                this._scheduleSaveLayouts();
                            }
                        }
                    }
                }

                this._moveTiledExcept(metaWindow);
                this._enforceGrabBoundary(metaWindow);
                this._updateBordersDuringGrab();
            } else if (mode === 'move') {
                this._updateMoveDragPreview(metaWindow);
            }

            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopLiveResizeLoop() {
        if (this._liveResizeId) {
            GLib.source_remove(this._liveResizeId);
            this._liveResizeId = 0;
        }
    }

    _moveTiledExcept(skipWindow) {
        const ws = skipWindow.get_workspace();
        if (!ws) return;
        const gap = this._settings.get_int('inside-gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return;

        const layout = this._getWorkspaceLayout(ws);
        if (layout === 'floating') return;
        if (layout === 'dwindle') {
            const tree = this._bspGetTree(ws);
            if (!tree) return;
            const treeWins = this._bspCollectWindows(tree);
            if (!treeWins.includes(skipWindow)) return;
            const area = this._outsideArea(workArea);
            if (!area) return;
            this._bspLayout(tree, area.x, area.y, area.w, area.h, gap, skipWindow);
        } else {
            const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
            if (tiled.length <= 1) return;
            if (layout === 'centered-master-stack')
                this._retileCenteredMasterStack(ws, tiled, skipWindow);
            else
                this._retileMasterStack(ws, tiled, skipWindow);
        }
    }

    _windowSlotRect(win, ws, layout, workArea, insideGap) {
        if (!this._isValidWorkArea(workArea)) return null;
        if (layout === 'floating') return null;
        // A single tiled window's slot IS its placement rect — the layouts
        // place the lone window via _singleWindowRect (the work area inset
        // by the per-edge outside-gap-* settings). The slot must agree
        // EXACTLY or the re-assert/audit machinery sees a phantom mismatch
        // (or, for dwindle, no slot at all — the BSP tree is never built
        // for a single window, so the tree branch returned null and every
        // settle re-assert silently no-oped while the window sat off-slot).
        if (this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w)).length === 1)
            return this._singleWindowRect(workArea);
        const area = this._outsideArea(workArea);
        if (!area) return null;
        const { x: areaX, y: areaY, w: areaW, h: areaH } = area;
        const gap = insideGap;
        if (areaW <= 0 || areaH <= 0) return null;

        if (layout === 'dwindle') {
            const tree = this._bspGetTree(ws);
            if (!tree) return null;
            const leaf = this._bspFindLeaf(tree, win);
            if (!leaf || leaf._w === undefined) return null;
            const r = { x: leaf._x, y: leaf._y, w: leaf._w, h: leaf._h };
            if (!(r.w > 0) || !(r.h > 0) || !Number.isFinite(r.x + r.y + r.w + r.h)) return null;
            // Insurance: never report a slot narrower than the window's
            // minimum — the layout clamps, so verdicts must agree.
            const min = this._getWindowMinSize(win);
            if (min.w > 0 && r.w < min.w) r.w = Math.min(min.w, areaW);
            if (min.h > 0 && r.h < min.h) r.h = Math.min(min.h, areaH);
            return r;
        }

        const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
        const idx = tiled.indexOf(win);
        if (idx === -1) return null;

        const masterRatio = this._getMasterRatio(ws);
        const numStack = tiled.length - 1;
        const stackRatios = this._getStackRatios(ws);

        let masterX, masterW, stackX, stackW, stackIdx, colCount, colWeights;
        if (layout === 'centered-master-stack') {
            masterW = Math.floor((areaW - gap * 2) * masterRatio);
            masterX = areaX + Math.floor((areaW - masterW) / 2);
            if (idx === 0) {
                const r = { x: masterX, y: areaY, w: masterW, h: areaH };
                return this._minClampSlot(r, win, areaW, areaH);
            }
            const leftCount = Math.ceil(numStack / 2);
            const stackIdxIn = idx - 1;
            if (stackIdxIn < leftCount) {
                stackX = areaX;
                stackW = masterX - areaX - gap;
                stackIdx = stackIdxIn;
                colCount = leftCount;
            } else {
                stackX = masterX + masterW + gap;
                stackW = areaX + areaW - stackX;
                stackIdx = stackIdxIn - leftCount;
                colCount = numStack - leftCount;
            }
            colWeights = [];
            for (let i = 0; i < colCount; i++)
                colWeights.push(stackRatios.has(stackIdxIn - stackIdx + i) ? stackRatios.get(stackIdxIn - stackIdx + i) : 1.0);
        } else {
            masterW = Math.floor((areaW - gap) * masterRatio);
            masterX = areaX;
            if (idx === 0) {
                const r = { x: areaX, y: areaY, w: masterW, h: areaH };
                return this._minClampSlot(r, win, areaW, areaH);
            }
            stackX = areaX + masterW + gap;
            stackW = areaW - masterW - gap;
            stackIdx = idx - 1;
            colCount = numStack;
            colWeights = [];
            for (let i = 0; i < colCount; i++)
                colWeights.push(stackRatios.has(i) ? stackRatios.get(i) : 1.0);
        }

        if (stackW <= 0 || colCount === 0) return null;
        const totalWeight = colWeights.reduce((a, b) => a + b, 0);
        if (!(totalWeight > 0) || !Number.isFinite(totalWeight)) return null;
        const totalColH = areaH - gap * (colCount - 1);
        let y = areaY;
        for (let i = 0; i < colCount; i++) {
            const isLast = i === colCount - 1;
            const h = isLast
                ? (areaY + areaH - y)
                : Math.floor(totalColH * colWeights[i] / totalWeight);
            if (i === stackIdx) {
                const r = { x: stackX, y, w: stackW, h };
                if (!(r.w > 0) || !(r.h > 0) || !Number.isFinite(r.x + r.y + r.w + r.h)) return null;
                return this._minClampSlot(r, win, areaW, areaH);
            }
            y += h + gap;
        }
        return null;
    }

    _enforceGrabBoundary(win) {
        try {
            if (this._destroyed || !this._grabOp || !win) return;
            const ws = win.get_workspace();
            if (!ws) return;
            const gap = this._settings.get_int('inside-gap');
            const monitor = global.display.get_primary_monitor();
            let workArea = null;
            try { workArea = ws.get_work_area_for_monitor(monitor); } catch (_e) {}
            if (!workArea || workArea.width === 0) return;
            const layout = this._getWorkspaceLayout(ws);
            const boundary = this._windowSlotRect(win, ws, layout, workArea, gap);
            if (!boundary) return;
            const f = win.get_frame_rect();
            if (f.width === 0 || f.height === 0) return;
            let nx = f.x, ny = f.y, nw = f.width, nh = f.height;
            const wOut = this._grabWidthSign > 0
                ? (f.x + f.width > boundary.x + boundary.w + 1)
                : this._grabWidthSign < 0
                    ? (f.x < boundary.x - 1 || f.x + f.width > boundary.x + boundary.w + 1)
                    : false;
            const hOut = this._grabHeightSign > 0
                ? (f.y + f.height > boundary.y + boundary.h + 1)
                : this._grabHeightSign < 0
                    ? (f.y < boundary.y - 1 || f.y + f.height > boundary.y + boundary.h + 1)
                    : false;
            if (wOut) { nx = boundary.x; nw = boundary.w; }
            if (hOut) { ny = boundary.y; nh = boundary.h; }
            if (wOut || hOut)
                this._safeMove(win, nx, ny, nw, nh);
        } catch (_e) {}
    }

    _disconnectGrabBoundaryHooks() {
        const win = this._grabWindow;
        if (this._grabSizeChangedId) {
            if (win) {
                try { win.disconnect(this._grabSizeChangedId); } catch (_e) {}
            }
            this._grabSizeChangedId = 0;
        }
        if (this._grabPositionChangedId) {
            if (win) {
                try { win.disconnect(this._grabPositionChangedId); } catch (_e) {}
            }
            this._grabPositionChangedId = 0;
        }
    }

    _maybeReassertSlot(win, tol = 16, mode = 'retile') {
        if (this._destroyed || !this._settings) return;
        if (!this._settings.get_boolean('enabled')) return;
        if (this._grabOp) return;
        if (!win || win.is_fullscreen() || win.minimized) return;
        if (this._isFloating(win)) return;
        if (!this._windowWorkspaces.has(win)) return;
        // Timestamp gate: size-changed fires per move/resize step and the
        // full slot computation is O(n²) per retile — skip re-checks for the
        // same window within 250ms (the retile verify covers the rest).
        // NOTE: the gate is only READ here — the timestamp is recorded
        // AFTER the animating block below, so a retile-mode call that only
        // queues (and does no work) no longer refreshes the gate and starve
        // a direct correction queued behind it. Consecutive acting calls
        // stay debounced (the client-fight protection).
        const now = Date.now();
        if (this._slotReassertTimes) {
            const last = this._slotReassertTimes.get(win);
            if (last && now - last < 250) return;
        }
        if (this._animating) {
            // Direct mode must NOT queue: the settle re-assert of a freshly
            // placed window can be starved by other workspaces' retile
            // animation churn (ws1's constant 1s animations) — the queued
            // ws drains into another animated retile that re-loses the
            // client-resize race. A direct re-place is safe mid-animation
            // (it only moves one window; it does not touch the retile
            // machinery).
            if (mode === 'direct') {
                // fall through to the direct check below
            } else {
                const ws = win.get_workspace();
                if (ws && this._queuedAnimWorkspaces) this._queuedAnimWorkspaces.add(ws);
                return;
            }
        }
        if (this._slotReassertTimes) this._slotReassertTimes.set(win, now);
        const ws = win.get_workspace();
        if (!ws) return;
        const gap = this._settings.get_int('inside-gap');
        const monitor = global.display.get_primary_monitor();
        let workArea = null;
        try { workArea = ws.get_work_area_for_monitor(monitor); } catch (_e) {}
        if (!workArea || workArea.width === 0) return;
        const layout = this._getWorkspaceLayout(ws);
        if (layout === 'floating') return;
        const slot = this._windowSlotRect(win, ws, layout, workArea, gap);
        if (!slot) return;
        const f = win.get_frame_rect();
        if (f.width === 0 || f.height === 0) return;
        let off = Math.abs(f.width - slot.w) > tol || Math.abs(f.height - slot.h) > tol ||
            Math.abs(f.x - slot.x) > tol || Math.abs(f.y - slot.y) > tol;
        if (!off && win.get_client_type() !== Meta.WindowClientType.X11) {
            // Surface divergence: a Wayland client (Firefox's session
            // restore) can re-commit its buffer at a SMALLER size after the
            // placement while the compositor keeps the FRAME at the placed
            // geometry — the frame rect then lies about the visible window
            // (every frame-based check passes, the content renders short).
            // A healthy Wayland buffer ≥ frame (shadow margins); buffer <
            // frame = the client shrank its surface → treat as off-slot.
            // (X11 SSD frames legitimately exceed the buffer — excluded.)
            const buffer = win.get_buffer_rect();
            if (buffer.width > 0 && (buffer.width < f.width || buffer.height < f.height)) {
                // Strike bound: the frame is ALREADY in slot here (this
                // branch only runs when the frame check passed), so the
                // correction below is a fresh configure of the identical
                // rect — the Firefox-restore client obeys it (surface
                // heals → counter resets), but a client that structurally
                // never fills its frame (pascube (GTK3): committing a
                // surface 37px shorter than the frame, top
                // inset only, from first placement) makes every re-place a
                // no-op: without the bound the settle window burns ~12
                // futile moves + log lines fighting a fight it cannot win.
                const strikes = (win._plaidSurfaceStrikes || 0) + 1;
                win._plaidSurfaceStrikes = strikes;
                if (strikes > 3) {
                    if (strikes === 4)
                        this._debugLog(`surface divergence: accepting client geometry for ${win.get_wm_class_instance() || '?'} frame=(${f.x},${f.y},${f.width},${f.height}) buffer=(${buffer.x},${buffer.y},${buffer.width},${buffer.height})`);
                    return;
                }
                this._debugLog(`slot re-assert (surface): ${win.get_wm_class_instance() || '?'} frame=(${f.x},${f.y},${f.width},${f.height}) buffer=(${buffer.x},${buffer.y},${buffer.width},${buffer.height}) slot=(${slot.x},${slot.y},${slot.w},${slot.h}) (strike ${strikes}/3)`);
                off = true;
            } else {
                // Surface (re)covered the frame — forget past strikes so a
                // later genuine shrink (Firefox restore round 2) gets a
                // fresh correction budget.
                win._plaidSurfaceStrikes = 0;
            }
        }
        if (off) {
            if (mode === 'direct') {
                // Direct re-place: forces a fresh configure the client must
                // obey (the maximize-keybind path) — silent, unanimated, no
                // verify/float machinery, so it cannot re-lose the race.
                this._debugLog(`slot re-assert: ${win.get_wm_class_instance() || '?'} frame=(${f.x},${f.y},${f.width},${f.height}) slot=(${slot.x},${slot.y},${slot.w},${slot.h})`);
                try {
                    win.move_resize_frame(true, slot.x, slot.y, slot.w, slot.h);
                    this._scheduleBorders();
                } catch (_e) {}
            } else {
                this._debugLog(`slot re-assert: ${win.get_wm_class_instance() || '?'} frame=(${f.x},${f.y},${f.width},${f.height}) slot=(${slot.x},${slot.y},${slot.w},${slot.h})`);
                this._scheduleRetile(ws);
            }
        }
    }

    _safeMove(win, x, y, w, h) {
        if (!win || win.is_fullscreen() || !win.get_workspace()) return;
        if (!(w > 0) || !(h > 0)) return;
        if (!Number.isFinite(x + y + w + h)) return;
        if (this._animTargets) {
            this._animTargets.set(win, { x, y, w, h });
            return;
        }
        try {
            const actor = win.get_compositor_private();
            if (actor) actor.remove_all_transitions();
            win.move_resize_frame(true, x, y, w, h);
        } catch (e) {
            log(`[plaid] _safeMove FAILED: ${win.get_wm_class_instance() || '?'} to ${x},${y} ${w}x${h}: ${e.message}`);
        }
    }

    // --- Pick Mode ---

    _startPickMode() {
        if (this._pickFocusId) {
            try { global.display.disconnect(this._pickFocusId); } catch (_e) {}
            this._pickFocusId = null;
        }
        this._pickFocusId = global.display.connect('notify::focus-window', () => {
            const win = global.display.focus_window;
            if (!win) return;
            if (this._pickFocusId) {
                try { global.display.disconnect(this._pickFocusId); } catch (_e) {}
                this._pickFocusId = null;
            }
            const cls = this._winClassCandidates(win)[0] || '';
            const title = win.get_title() || '';
            this._settings.set_string('pick-mode-class', cls);
            this._settings.set_string('pick-mode-title', title);
            this._settings.set_boolean('pick-mode', false);
        });
    }

    _handlePickFloat() {
        const win = global.display.focus_window;
        if (!win) {
            Main.notify(_('No window is focused'));
            return;
        }

        const cls = this._winClassCandidates(win)[0] || '';
        const title = win.get_title() || '';

        if (!cls && !title) {
            Main.notify(_('Could not identify the focused window'));
            return;
        }

        this._showFloatPickDialog(cls, title);
    }

    _showFloatPickDialog(cls, title) {
        this._destroyFloatPickDialog();
        const dialog = new ModalDialog();
        this._pickDialog = dialog;

        const content = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 12px;' });

        const header = new St.Label({
            text: _('Add Floating Window'),
            style: 'font-weight: bold; font-size: 14px;',
        });
        content.add_child(header);

        const subtitle = new St.Label({
            text: _('How should this window be identified?'),
        });
        content.add_child(subtitle);

        dialog.contentLayout.add_child(content);

        const buttons = [];

        if (cls) {
            buttons.push({
                label: _('By class: %s').replace('%s', cls),
                action: () => {
                    this._addFloatEntry('float-windows', cls.toLowerCase());
                    dialog.close();
                },
                key: Clutter.KEY_c,
            });
        }

        if (title) {
            buttons.push({
                label: _('By title: %s').replace('%s', title),
                action: () => {
                    this._addFloatEntry('float-titles', title);
                    dialog.close();
                },
                key: Clutter.KEY_t,
            });
        }

        buttons.push({
            label: _('Cancel'),
            action: () => dialog.close(),
            key: Clutter.KEY_Escape,
        });

        dialog.setButtons(buttons);
        dialog.open();
    }

    _addFloatEntry(key, value) {
        const current = new Set(this._settings.get_strv(key));
        current.add(value);
        this._settings.set_strv(key, [...current]);

        if (key === 'float-windows') {
            this._floatingClasses = new Set(this._settings.get_strv('float-windows'));
        } else {
            this._floatingTitles = new Set(this._settings.get_strv('float-titles'));
        }

        if (value.length > 40)
            value = value.substring(0, 37) + '...';
        Main.notify(_('Added "%s" to float list').replace('%s', value));
    }

    _destroyFloatPickDialog() {
        if (this._pickDialog) {
            try { this._pickDialog.close(); } catch (_e) {}
            this._pickDialog = null;
        }
    }

    // --- Drag & Drop Repositioning ---

    _updateMoveDragPreview(metaWindow) {
        if (!metaWindow || !this._settings) return;
        const ws = metaWindow.get_workspace();
        if (!ws) return;
        // Click-vs-drag gate: keep the overlay hidden until the pointer
        // actually travelled — a titlebar click must not show a drag preview.
        try {
            const [px, py] = global.get_pointer();
            const dx = px - this._grabStartX;
            const dy = py - this._grabStartY;
            const grace = this._grabGrace ?? 10;
            if (Math.hypot(dx, dy) < grace) {
                this._hideDropPreview();
                return;
            }
        } catch (_e) {}
        if (this._getWorkspaceLayout(ws) === 'floating') {
            this._hideDropPreview();
            return;
        }

        const [px, py] = global.get_pointer();
        const tiledWindows = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
        if (tiledWindows.length <= 1) {
            this._hideDropPreview();
            return;
        }

        const layout = this._getWorkspaceLayout(ws);
        if (layout === 'dwindle') {
            const leaf = this._computeDwindleDropTarget(ws, px, py);
            if (leaf && leaf.type === 'leaf') {
                this._showDropPreview(leaf._x, leaf._y, leaf._w, leaf._h);
            } else {
                this._hideDropPreview();
            }
        } else {
            const targetIdx = this._computeMasterStackDropTarget(ws, px, py);
            if (targetIdx >= 0) {
                this._showMasterStackPreview(ws, targetIdx);
            } else {
                this._hideDropPreview();
            }
        }
    }

    _showMasterStackPreview(ws, targetIdx) {
        const gap = this._settings.get_int('inside-gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return;

        const area = this._outsideArea(workArea);
        if (!area) return;
        const areaX = area.x;
        const areaY = area.y;
        const areaW = area.w;
        const areaH = area.h;
        const masterRatio = this._getMasterRatio(ws);
        const layout = this._getWorkspaceLayout(ws);

        let rx, ry;
        let rw, rh;

        if (targetIdx === 0) {
            if (layout === 'centered-master-stack') {
                const masterW = Math.floor((areaW - gap * 2) * masterRatio);
                rx = areaX + Math.floor((areaW - masterW) / 2);
                rw = masterW;
            } else {
                rw = Math.floor((areaW - gap) * masterRatio);
                rx = areaX;
            }
            ry = areaY;
            rh = areaH;
        } else {
            if (layout === 'centered-master-stack') {
                const leftCount = Math.ceil((this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w)).length - 1) / 2);
                const masterW = Math.floor((areaW - gap * 2) * masterRatio);
                const masterX = areaX + Math.floor((areaW - masterW) / 2);
                if (targetIdx <= leftCount) {
                    rx = areaX;
                    rw = masterX - areaX - gap;
                } else {
                    rx = masterX + masterW + gap;
                    rw = areaX + areaW - rx;
                }
            } else {
                const masterW = Math.floor((areaW - gap) * masterRatio);
                rx = areaX + masterW + gap;
                rw = areaW - masterW - gap;
            }
            ry = areaY;
            rh = areaH;
        }

        this._showDropPreview(rx, ry, rw, rh);
    }

    _computeDwindleDropTarget(ws, px, py) {
        const tree = this._bspGetTree(ws);
        if (!tree) return null;

        const gap = this._settings.get_int('inside-gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return null;

        const area = this._outsideArea(workArea);
        if (!area) return null;
        const ax = area.x;
        const ay = area.y;
        const aw = area.w;
        const ah = area.h;

        // Drop zones live inside the outside-gapped area — a pointer in the
        // outside-gap strip selects nothing.
        if (px < ax || px > ax + aw || py < ay || py > ay + ah)
            return null;

        this._bspTagGeometry(tree, ax, ay, aw, ah, gap);
        return this._bspFindLeafAtPoint(tree, ax, ay, aw, ah, px, py, gap);
    }

    _showDropPreview(x, y, w, h) {
        if (w <= 0 || h <= 0) {
            this._hideDropPreview();
            return;
        }
        if (!this._dropPreview) {
            this._dropPreview = new St.Widget({
                style: 'background-color: rgba(53, 132, 228, 0.15); border: 2px solid #3584e4;',
                reactive: false,
                visible: true,
            });
            this._dropOverlay.add_child(this._dropPreview);
        }
        this._dropPreview.visible = true;
        this._dropPreview.set_position(x, y);
        this._dropPreview.set_size(w, h);
    }

    _hideDropPreview() {
        // Hide, don't destroy — the 16ms grab loop alternates between
        // target/no-target regions; recreating the widget each tick churns
        // allocations and re-layout under a live grab.
        if (this._dropPreview)
            this._dropPreview.visible = false;
    }

    _destroyDropPreview() {
        if (this._dropPreview) {
            try { this._dropPreview.destroy(); } catch (_e) {}
            this._dropPreview = null;
        }
    }

    _repositionWindow(window, ws) {
        if (!window || !ws || !this._settings) return;
        if (this._getWorkspaceLayout(ws) === 'floating') return;
        const [px, py] = global.get_pointer();
        const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
        if (tiled.length <= 1) return;

        const layout = this._getWorkspaceLayout(ws);
        if (layout === 'dwindle') {
            const targetLeaf = this._computeDwindleDropTarget(ws, px, py);
            if (!targetLeaf || targetLeaf.type !== 'leaf') return;

            const tree = this._bspGetTree(ws);
            if (!tree) return;

            // Preserve the split ratio at the drop target so the re-insert
            // mirrors the previous proportions instead of resetting to the
            // default dwindle-ratio.
            let targetRatio = null;
            const path = [];
            this._bspFindPath(tree, targetLeaf.window, path);
            for (let i = path.length - 1; i >= 0; i--) {
                if (path[i].type === 'split' && path[i].ratio > 0 && path[i].ratio < 1) {
                    targetRatio = path[i].ratio;
                    break;
                }
            }

            const gap = this._settings.get_int('inside-gap');
            // Dropping the dragged window on its OWN leaf (or on a leaf the
            // removal merges away) must leave the tree untouched: the old
            // code removed the window and never re-inserted it, so the
            // follow-up retile re-added it as the "newest" leaf — a silent
            // arrangement reshuffle (and the reshuffled shape got persisted)
            // (2026-10-04 audit).
            if (targetLeaf.window === window) {
                this._bspTrees.set(ws, tree);
                return;
            }
            let newTree = this._bspRemove(tree, window);
            if (newTree.type === 'empty') newTree = null;
            if (newTree && !this._bspFindLeaf(newTree, targetLeaf.window)) {
                this._bspTrees.set(ws, tree);
                return;
            }
            if (newTree) {
                newTree = this._bspReplaceLeaf(newTree, targetLeaf, window, targetRatio);
            }
            this._bspTrees.set(ws, newTree);
        } else {
            const targetIdx = this._computeMasterStackDropTarget(ws, px, py);
            if (targetIdx < 0) return;

            const order = this._getWorkspaceOrder(ws);
            // The drop target is expressed in TILED-only index space
            // (master=0, stack=1..N-1) while the order interleaves
            // toggle-floated windows — comparing/splicing across the two
            // spaces placed the window at the wrong relative position
            // whenever a float was interleaved (2026-10-04 audit). Map
            // both sides to the tiled space, then back to the order.
            const tiledIdx = tiled.indexOf(window);
            if (tiledIdx === -1) return;
            const currentIdx = order.indexOf(window);
            if (currentIdx === -1 || tiledIdx === targetIdx) return;

            order.splice(currentIdx, 1);
            const adjustedTarget = targetIdx > tiledIdx ? targetIdx - 1 : targetIdx;
            let insertIdx = order.length;
            let tiledSeen = 0;
            for (let i = 0; i < order.length; i++) {
                const w = order[i];
                if (this._isFloating(w) || w.minimized || w.is_skip_taskbar() ||
                    w.get_window_type() !== Meta.WindowType.NORMAL) continue;
                if (tiledSeen === adjustedTarget) {
                    insertIdx = i;
                    break;
                }
                tiledSeen++;
            }
            order.splice(insertIdx, 0, window);
            const tiledOnly = order.filter(w =>
                !this._isFloating(w) &&
                w.get_window_type() === Meta.WindowType.NORMAL &&
                !w.is_skip_taskbar() &&
                !w.minimized
            );
            if (layout === 'centered-master-stack')
                this._retileCenteredMasterStack(ws, tiledOnly);
            else
                this._retileMasterStack(ws, tiledOnly);
        }
        // A drop-swap restructured the tree/order directly (not every path
        // here goes through _doRetileWorkspace) — persist the new
        // arrangement (debounced) so it survives a login.
        this._scheduleSaveLayouts();
    }

}

// Subsystem methods extracted into ./modules/*.js are attached here. Each
// module's functions use `this` exactly as ordinary methods do, so call sites
// and instance state are unchanged. This runs once at module load, before
// enable() can be called.
Object.assign(
    TilingWMExtension.prototype,
    helperMethods,
    geometryMethods,
    bspMethods,
    borderMathMethods,
    blurMethods,
    backgroundAppMethods,
    maskMethods,
    borderWidgetMethods,
    keybindMethods,
    scratchpadMethods,
    dropdownMethods,
    pointerFocusMethods,
    workspacePillMethods,
    terminalSettingsMethods,
);
