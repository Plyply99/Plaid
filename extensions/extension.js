import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ModalDialog } from 'resource:///org/gnome/shell/ui/modalDialog.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { helperMethods, LAYOUT_NAMES } from './modules/helpers.js';
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
import { workspacesMethods } from './modules/workspaces.js';
import { placementMethods } from './modules/placement.js';
import { grabMethods } from './modules/grab.js';
import { windowMethods } from './modules/windows.js';
import { layoutMethods } from './modules/layouts.js';
import { persistenceMethods } from './modules/persistence.js';
import { procInfoMethods } from './modules/proc-info.js';


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
            if (!this._settings) return false;
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

        // Migration FIRST: it may pin a user-layer default (e.g. the old
        // Super+H nav binds on an existing install), and _disableMutterDefaults
        // reads the EFFECTIVE values to decide which GNOME defaults to yield —
        // running it after a schema-default change would yield the new combo
        // and leave the pinned old one fighting GNOME's grab.
        this._migrateKeybindingDefaults();
        this._disableMutterDefaults();
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
            if (!this._settings) return false;
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

    disable() {
        try {
            this._disable();
        } finally {
            // If any teardown step throws, late callbacks must not see a live
            // instance. Keep _settings valid through _disable() so cleanup
            // that needs settings (BGAPP/DDT) still runs.
            this._settings = null;
            this._sourceIds = null;
        }
    }

    _disable() {
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
            if (s.observedMinSizes) {
                for (const [w] of s.observedMinSizes) {
                    if (!alive(w))
                        s.observedMinSizes.delete(w);
                }
                this._observedMinSizes = s.observedMinSizes;
            }
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

    _connectSignals() {
        // The shell emits this at the very start of shutdown. A retile that
        // was queued by an unmanaged window can otherwise fire after this
        // point and start a 16ms animation against windows/actors that are
        // already being torn down — the main loop then stalls until systemd
        // SIGKILLs the shell (observed: 5s stop-sigterm timeout on logout).
        this._addSignal(global, global.connect('shutdown', () => {
            if (this._settings) this._onShellShutdown();
        }));
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
                    this._lastRetileTimes?.delete(workspace);
                    // The workspace-object-keyed maps missed here: a
                    // retained wrapper + a pending retile timeout that
                    // later fires against a dead workspace.
                    this._dwindleLeafSigs?.delete(workspace);
                    this._queuedAnimWorkspaces?.delete(workspace);
                    if (this._pendingRetileIds?.has(workspace)) {
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
                // reservation — log it loudly and skip the per-workspace work.
                this._debugLog('workspace: active workspace is the hidden parking slot');
                return;
            }
            try {
                if (this._settings.get_boolean('workspace-popup'))
                    this._showWorkspacePopup(ws);
            } catch (_e) {}
            // Re-assert float layering + refresh Flair after the switch
            // settles (the restacked signal can fire before the reveal
            // ordering is final).
            try { this._reassertFloatingTransients(); } catch (e) {
                log(`[plaid] float re-assert failed: ${e.message}`);
            }
            try { this._updateBorders(); } catch (e) {
                log(`[plaid] border update failed: ${e.message}`);
            }
            try { this._checkWorkspaceLandings(ws); } catch (e) {
                log(`[plaid] landing check failed: ${e.message}`);
            }
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
                    if (this._settings && settleChanged) {
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
            this._addIdle(() => {
                if (!this._settings) return false;
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
        this._connectGrabSignals();

    }

    _trackSource(id) {
        if (id && this._sourceIds) this._sourceIds.add(id);
        return id;
    }

    _untrackSource(id) {
        if (this._sourceIds) this._sourceIds.delete(id);
    }

    _addIdle(callback) {
        if (!this._settings || !this._sourceIds) return 0;
        let id = 0;
        id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            let result = GLib.SOURCE_REMOVE;
            try {
                result = callback();
            } catch (e) {
                log(`[plaid] idle callback failed: ${e.message}`);
            }
            if (!result) this._untrackSource(id);
            return result;
        });
        return this._trackSource(id);
    }

    _addTimeout(delay, callback) {
        if (!this._settings || !this._sourceIds) return 0;
        let id = 0;
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            let result = GLib.SOURCE_REMOVE;
            try {
                result = callback();
            } catch (e) {
                log(`[plaid] timeout callback failed: ${e.message}`);
            }
            if (!result) this._untrackSource(id);
            return result;
        });
        return this._trackSource(id);
    }

    _removeAllSources() {
        if (!this._sourceIds) return;
        for (const id of this._sourceIds) {
            try {
                if (GLib.MainContext.default().find_source_by_id(id))
                    GLib.source_remove(id);
            } catch (_e) {}
        }
        this._sourceIds.clear();
    }

    _addSignal(emitter, id) {
        this._signals.push({ emitter, id });
    }

    _disconnectSignals() {
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

    _onShellShutdown() {
        // Do NOT run full disable() here: it writes settings and touches UI
        // that is already being destroyed. Just make every queued/active
        // tiling path inert before the compositor goes away.
        this._shuttingDown = true;
        if (this._pendingRetileIds) {
            for (const id of this._pendingRetileIds.values()) {
                try { GLib.source_remove(id); } catch (_e) {}
            }
            this._pendingRetileIds.clear();
        }
        try { this._cancelAnimation(); } catch (_e) {}
        this._debugLog('shell shutdown: retiles/animations stopped');
    }

    _scheduleRetile(workspace) {
        if (!this._settings || !workspace || this._shuttingDown) return;
        if (this._pendingRetileIds.has(workspace))
            GLib.source_remove(this._pendingRetileIds.get(workspace));
        const now = Date.now();
        const last = this._lastRetileTimes?.get(workspace) || 0;
        const delay = Math.max(0, 50 - (now - last));
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._pendingRetileIds.delete(workspace);
            if (!this._settings || this._shuttingDown) return false;
            this._doRetileWorkspace(workspace);
            return false;
        });
        this._pendingRetileIds.set(workspace, id);
        this._lastRetileTimes?.set(workspace, now);
    }

    _scheduleBorders() {
        if (!this._settings) return;
        if (this._pendingBorderId)
            GLib.source_remove(this._pendingBorderId);
        this._pendingBorderId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._pendingBorderId = 0;
            if (!this._settings) return false;
            try {
                this._doUpdateBorders();
            } catch (e) {
                log(`[plaid] _doUpdateBorders failed: ${e.message}`);
            }
            return false;
        });
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
        if (!this._settings || !win) return;
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
            if (!this._settings) return false;
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
            if (!this._settings) return GLib.SOURCE_REMOVE;
            return apply() ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        };
        if (apply())
            this._addTimeout(100, retry);
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
        if (!this._settings || !win) return;
        this._debugLog(`identity: ${this._winClassCandidates(win).join('/') || '?'} appId=${win.get_gtk_application_id ? (win.get_gtk_application_id() || '?') : '?'} ` +
            `ws=${this._wsIndex(win.get_workspace())} managed=${this._windowWorkspaces.has(win)}`);
        // Backstop for the Extensions app / prefs window: its wm-class and GTK
        // app id can resolve AFTER the window was already added to the tiler.
        // If it identifies as the Extensions app now, un-tile it and restore
        // the layout so opening prefs never leaves the workspace rearranged.
        try {
            if (this._isExtensionsAppWindow(win)) {
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
        if (!this._settings) return;
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
        if (!this._settings) return;
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
            // for the whole grab.
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
                    this._windowBorders.get(win).destroy();
                    this._windowBorders.delete(win);
                    if (this._scratchpadRings) {
                        const ring = this._scratchpadRings.get(win);
                        if (ring) {
                            ring.destroy();
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
            // mask is gone there so the widget is unclipped).
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
        if (!this._settings) return;
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
        this._addIdle(() => {
            if (!this._settings) return false;
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
        this._addIdle(() => {
            if (!this._settings) return false;
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
                // shallower at depth and shift with the gap settings.
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
                // them.
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

        // A min-limited window (auto-floated because no slot met its minimum)
        // was never user-floated — toggling releases it back to tiling instead
        // of marking it floated.
        if (this._minLimitedWindows && this._minLimitedWindows.has(focused)) {
            this._releaseMinLimitedWindow(focused);
            const ws = focused.get_workspace();
            if (ws) {
                if (this._getWorkspaceLayout(ws) === 'dwindle')
                    this._bspInsertForWorkspace(ws, focused);
                this._retileWorkspace(ws);
            }
            return;
        }

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
        this._addIdle(() => {
            if (!this._settings) return false;
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
            this._addIdle(() => {
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

        this._addIdle(() => {
            if (!this._settings) return false;
            this._keyboardFocusChange = false;
            return false;
        });
    }


    _cycleLayout() {
        const layouts = ['dwindle', 'master-stack', 'centered-master-stack', 'floating'];
        const ws = global.workspace_manager.get_active_workspace();
        if (!ws) return;
        this._releaseMinLimitedWindows();
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






    _startPickMode() {
        if (this._pickFocusId) {
            global.display.disconnect(this._pickFocusId);
            this._pickFocusId = null;
        }
        this._pickFocusId = global.display.connect('notify::focus-window', () => {
            const win = global.display.focus_window;
            if (!win) return;
            if (this._pickFocusId) {
                global.display.disconnect(this._pickFocusId);
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
            this._dropPreview.destroy();
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

            // Dropping the dragged window on its OWN leaf (or on a leaf the
            // removal merges away) must leave the tree untouched: the old
            // code removed the window and never re-inserted it, so the
            // follow-up retile re-added it as the "newest" leaf — a silent
            // arrangement reshuffle (and the reshuffled shape got persisted).
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
            // whenever a float was interleaved. Map
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
    workspacesMethods,
    placementMethods,
    grabMethods,
    windowMethods,
    layoutMethods,
    persistenceMethods,
    procInfoMethods,
);
