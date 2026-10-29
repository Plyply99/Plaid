// PlaidCore — owns the extension state and composes the subsystem classes.
// The extension entry point only creates this object and asks it to enable
// or destroy itself.

import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { sessionState } from './session-state.js';
import { Geometry } from './geometry.js';
import { Bsp } from './bsp.js';
import { BorderMath } from './border-math.js';
import { Blur } from './blur.js';
import { BackgroundApp } from './background-app.js';
import { Masks } from './mask.js';
import { Borders } from './borders.js';
import { Keybindings } from './keybindings.js';
import { Scratchpad } from './scratchpad.js';
import { DropdownTerminal } from './dropdown-terminal.js';
import { PointerFocus } from './pointer-focus.js';
import { WorkspacePill } from './workspace-pill.js';
import { Workspaces } from './workspaces.js';
import { Placement } from './placement.js';
import { Grab } from './grab.js';
import { Windows } from './windows.js';
import { Layouts } from './layouts.js';
import { Persistence } from './persistence.js';
import { ProcInfo } from './proc-info.js';
import { Signals } from './signals.js';
import { Actions } from './actions.js';
import { DragPreview } from './drag-preview.js';

export class PlaidCore {
    constructor(ext) {
        this.ext = ext;
        this._enabledThisShell = false;
        this._stashedTiling = null;

        this.geometry = new Geometry(this);
        this.bsp = new Bsp(this);
        this.borderMath = new BorderMath(this);
        this.blur = new Blur(this);
        this.bgApp = new BackgroundApp(this);
        this.masks = new Masks(this);
        this.borders = new Borders(this);
        this.keybindings = new Keybindings(this);
        this.scratchpad = new Scratchpad(this);
        this.dropdown = new DropdownTerminal(this);
        this.pointerFocus = new PointerFocus(this);
        this.workspacePill = new WorkspacePill(this);
        this.workspaces = new Workspaces(this);
        this.placement = new Placement(this);
        this.grab = new Grab(this);
        this.windows = new Windows(this);
        this.layouts = new Layouts(this);
        this.persistence = new Persistence(this);
        this.procInfo = new ProcInfo(this);
        this.signals = new Signals(this);
        this.actions = new Actions(this);
        this.dragPreview = new DragPreview(this);
    }

    compileTitlePatterns(titles) {
        const patterns = [];
        for (const t of titles || []) {
            if (t.includes('*'))
                patterns.push(new RegExp('^' + t.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'));
        }
        return patterns;
    }

    floatingTitleMatches(title) {
        if (!title) return false;
        if (this._floatingTitles && this._floatingTitles.has(title)) return true;
        const patterns = this._floatingTitlePatterns;
        if (!patterns) return false;
        for (const re of patterns) {
            if (re.test(title)) return true;
        }
        return false;
    }

    winClassCandidates(win) {
        const out = [];
        const inst = win.get_wm_class_instance();
        if (inst) out.push(inst.toLowerCase());
        const cls = win.get_wm_class();
        if (cls) out.push(cls.toLowerCase());
        const app = win.get_gtk_application_id();
        if (app) out.push(app.toLowerCase());
        return out;
    }

    floatClassMatches(win) {
        if (!this._floatingClasses) return false;
        for (const c of this.winClassCandidates(win)) {
            if (this._floatingClasses.has(c)) return true;
        }
        return false;
    }

    debugLog(...args) {
        if (!this._settings) return;
        if (!this._settings.get_boolean('debug')) return;
        console.debug(`[plaid] ${args.join(' ')}`);
    }

    currentTime() {
        return global.get_current_time();
    }

    enable() {
        const wasEnabled = this._enabledThisShell;
        this._enabledThisShell = true;

        this._settings = this.ext.getSettings();
        this._floatingClasses = new Set(this._settings.get_strv('float-windows'));
        this._floatingTitles = new Set(this._settings.get_strv('float-titles'));
        this._floatingTitlePatterns = this.compileTitlePatterns(this._floatingTitles);
        this._floatProcessCache = new Map();
        this._minSizeOverrides = this.bsp.parseMinSizeOverrides(this._settings.get_strv('min-window-sizes'));
        if (this._minSizeOverrides.size > 0)
            this.debugLog(`min-sizes: ${[...this._minSizeOverrides.entries()].map(([k, v]) => `${k}=${v.w}x${v.h}`).join(', ')} (override loaded)`);
        this._windowBorders = new Map();
        this._scratchpadRings = new Map();
        this._windowMasks = new Map();
        this._maskQuarantined = new Set();
        this._windowBlurs = new Map();
        this._sourceIds = new Set();
        this.signals.addIdle(() => {
            this.blur.purgeOrphanBlurs();
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
        this._stackSettleId = 0;
        this._pickFocusId = null;
        this._conflictScanId = 0;
        this._keybindChangeIds = [];
        this._backgroundAppCloneWatchId = 0;
        this._backgroundAppSpawnRetries = 0;
        this.persistence.loadPersistedLayoutRules();
        this._pendingRetileIds = new Map();
        this._pendingBorderId = 0;
        this._queuedAnimWorkspaces = new Set();
        this._animStartedAt = 0;
        this._landingRetries = new Map();
        this._mismatchFrames = new Map();
        this._landingGivenUp = new Set();
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
        this._dropOverlay = null;
        this._shuttingDown = false;
        this._animating = false;
        this._animTargets = null;
        this._animStates = null;
        this._animWindows = null;
        this._animStartTime = 0;
        this._animTickId = 0;
        this._newWindowSet = new Set();
        this._floatHooks = new Map();

        const ctx = global.backend.get_context();
        if (!ctx.get_wayland_compositor()) {
            this.workspaces.notifyCritical('Plaid', 'Plaid requires Wayland — the extension is disabled on X11.');
            console.error('[plaid] disabled: Wayland-only (X11 session detected)');
            return;
        }

        Main.sessionMode.connectObject('updated', (sm) => {
            if (sm.currentMode === 'lock' || sm.currentMode === 'unlock-dialog')
                sessionState.lockCycle = true;
            this.debugLog(`session mode: ${sm.currentMode} lockCycle=${sessionState.lockCycle}`);
        }, this);

        this.keybindings.migrateKeybindingDefaults();
        this._mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
        this.dragPreview.init();
        this.signals.connectSignals();
        this.keybindings.registerKeybindings();
        this.workspaces.suppressWorkspaceSwitcherPopup();
        this.workspaces.initWorkspacePopupWarning();
        this.dropdown.initDropdownTerminal();
        this._workspacePill = null;
        this._workspacePillIndicators = null;
        this._workspacePillNumbers = null;
        this._workspacePillIcon = null;
        this._workspacePillTitle = null;
        this._workspacePillFocusedWin = null;
        this._workspacePillTitleId = 0;
        this._workspacePillUnmanagedId = 0;
        this._workspacePillUpdateId = 0;
        this.workspacePill.initWorkspacePill();
        this.bgApp.initBackgroundApp();
        this.pointerFocus.initPointerFocus();
        this.signals.addIdle(() => {
            this.dragPreview.updateDropOverlaySize();
            const resumeLockCycle = sessionState.lockCycle;
            const resumeLike = sessionState.lockCycle || wasEnabled;
            if (resumeLike && this._stashedTiling)
                this.restoreTilingState();
            const bgCommand = this._settings.get_string('background-app');
            for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
                const ws = global.workspace_manager.get_workspace_by_index(i);
                for (const win of ws.list_windows()) {
                    if (this.windows.shouldManage(win)) {
                        this.windows.addWindow(win, resumeLike);
                        if (!resumeLockCycle)
                            this.windows.convertMaximizedToGaps(win);
                    } else if (this.windows.isFloating(win)) {
                        this.windows.restoreFloatNaturalRect(win);
                        if (!resumeLockCycle)
                            this.windows.convertMaximizedToGaps(win);
                        this.windows.connectFloatHooks(win);
                    } else if (bgCommand && !this._backgroundAppWin &&
                        this.bgApp.isMarkerProcess(win, 'PLAID_BGAPP=1', bgCommand)) {
                        this.debugLog('background app: idle-pass re-claim of surviving window');
                        this.bgApp.adoptFoundWindow(win);
                    }
                }
            }
            if (!resumeLockCycle)
                this.layouts.retileAll();
            this.bgApp.checkDynamicWorkspaces();
            sessionState.lockCycle = false;
            return false;
        });
    }

    restoreTilingState() {
        const s = this._stashedTiling;
        this._stashedTiling = null;
        if (!s) return;

        const alive = (win) => {
            try {
                return !!(win && win.get_compositor_private());
            } catch (e) {
                return false;
            }
        };
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
            for (const w of this.bsp.bspCollectWindows(tree)) {
                if (!alive(w))
                    t = this.bsp.bspRemove(t, w);
            }
            s.bspTrees.set(ws, t);
        }
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
        this.debugLog(`tiling state restored (windows=${this._windowWorkspaces.size} trees=${this._bspTrees.size})`);
    }

    destroy() {
        const mode = Main.sessionMode.currentMode;
        const isLocked = Main.sessionMode.isLocked;
        if (isLocked)
            sessionState.lockCycle = true;
        this.debugLog(`disable: mode=${mode} isLocked=${isLocked} lockCycle=${sessionState.lockCycle}`);

        this.persistence.destroy();
        this._saveDirtySince = 0;

        if (!this._stashedTiling) {
            this._stashedTiling = {
                bspTrees: this._bspTrees,
                workspaceLayouts: this._workspaceLayouts,
                masterRatios: this._masterRatios,
                stackRatios: this._stackRatios,
                workspaceOrders: this._workspaceOrders,
                windowWorkspaces: this._windowWorkspaces,
                windowWSIndices: this._windowWSIndices,
                lastFocusedPerWorkspace: this._lastFocusedPerWorkspace,
                lastRealFocusedWindow: this._lastRealFocusedWindow,
                scratchpadWindows: this._scratchpadWindows,
                toggleFloatWindows: this._toggleFloatWindows,
                scratchpadVisible: this._scratchpadVisible,
                observedMinSizes: this._observedMinSizes,
            };
            this.debugLog(`disable: tiling state stashed (trees=${this._bspTrees ? this._bspTrees.size : 0})`);
        }

        Main.sessionMode.disconnectObject(this);

        this.pointerFocus.destroy();
        this.workspacePill.destroy();
        this.dropdown.destroy();
        this.bgApp.destroy();
        this.workspaces.destroy();
        this.placement.destroy();
        this.grab.destroy();
        this.keybindings.destroy();
        this.actions.destroy();
        this.scratchpad.destroy();
        this.dragPreview.destroy();
        this.borders.destroy();
        this.masks.destroy();
        this.blur.destroy();
        this.windows.destroy();
        this.signals.destroy();
        this.procInfo.destroy();

        this._settings = null;
        this._mutterSettings = null;
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
        this._windowMasks = null;
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
        this._grabInitialMasterRatio = 0;
        this._grabInitialStackRatios = null;
        this._animTargets = null;
        this._animWindows = null;
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
        this._scratchpadWindows = null;
        this._scratchpadVisible = false;
    }
}
