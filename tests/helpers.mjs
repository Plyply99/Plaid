// Shared test fixtures: fake GSettings, fake Meta windows, BSP tree builders,
// and a `makeSelf` that builds a real PlaidCore with its subsystem classes.
// The returned Proxy keeps the old method names used by the unit tests.

import { PlaidCore } from '../extensions/modules/core.js';
import { LEGACY_METHODS } from './legacy-methods.mjs';

export { normalizeAccel, maskSdfRect } from '../extensions/modules/helpers.js';

export function fakeSettings(values = {}) {
  return {
    get_int: (k) => (k in values ? values[k] : 0),
    get_double: (k) => (k in values ? values[k] : 0.5),
    get_boolean: (k) => (k in values ? values[k] : false),
    get_string: (k) => (k in values ? values[k] : ''),
    get_strv: (k) => (k in values ? values[k] : []),
    get_default_value: (k) => (k in values ? { deep_unpack: () => values[k] } : null),
    get_user_value: (k) => (k in values ? { deep_unpack: () => values[k] } : null),
    settings_schema: { list_keys: () => Object.keys(values) },
  };
}

function resetCoreState(core, settings) {
  core._settings = fakeSettings(settings);
  core._floatingClasses = new Set(settings['float-windows'] ?? []);
  core._floatingTitles = new Set(settings['float-titles'] ?? []);
  core._floatingTitlePatterns = [];
  core._floatProcessCache = new Map();
  core._minSizeOverrides = new Map();
  core._windowBorders = new Map();
  core._scratchpadRings = new Map();
  core._windowMasks = new Map();
  core._maskQuarantined = new Set();
  core._windowBlurs = new Map();
  core._sourceIds = new Set();
  core._workspaceOrders = new Map();
  core._windowWorkspaces = new Map();
  core._windowWSIndices = new Map();
  core._slotReassertTimes = new Map();
  core._workspaceLayouts = new Map();
  core._lastRetileTimes = new Map();
  core._masterRatios = new Map();
  core._stackRatios = new Map();
  core._bspTrees = new Map();
  core._dwindleLeafSigs = new Map();
  core._lastFocusedPerWorkspace = new Map();
  core._savedRects = new Map();
  core._workspaceLayoutsSaveId = 0;
  core._saveDirtySince = 0;
  core._stackSettleId = 0;
  core._pickFocusId = null;
  core._conflictScanId = 0;
  core._keybindChangeIds = [];
  core._backgroundAppCloneWatchId = 0;
  core._backgroundAppSpawnRetries = 0;
  core._signals = [];
  core._pendingRetileIds = new Map();
  core._pendingBorderId = 0;
  core._queuedAnimWorkspaces = new Set();
  core._animStartedAt = 0;
  core._landingRetries = new Map();
  core._mismatchFrames = new Map();
  core._landingGivenUp = new Set();
  core._observedMinSizes = new Map();
  core._minLimitedWindows = new Set();
  core._pendingWarp = new Set();
  core._lastMonitorsGeom = null;
  core._pinnedAdjustCounts = new Map();
  core._stackDiagnostics = new Set();
  core._toggleFloatWindows = new Set();
  core._keyboardFocusChange = false;
  core._grabOp = null;
  core._grabWindow = null;
  core._grabStartX = 0;
  core._grabStartY = 0;
  core._grabWidthSign = 0;
  core._grabHeightSign = 0;
  core._grabResizeNodeW = null;
  core._grabResizeNodeH = null;
  core._grabInitialRatioW = 0;
  core._grabInitialRatioH = 0;
  core._grabInitialMasterRatio = 0;
  core._grabInitialStackRatios = null;
  core._liveResizeId = 0;
  core._grabSizeChangedId = 0;
  core._grabPositionChangedId = 0;
  core._layoutPopup = null;
  core._layoutPopupHideId = 0;
  core._warningPopup = null;
  core._warningPopupId = 0;
  core._pendingWarning = null;
  core._pendingWarningOverviewId = 0;
  core._origWorkspaceSwitcherDisplay = null;
  core._dropdownWin = null;
  core._dropdownUnmanagedId = 0;
  core._dropdownPending = false;
  core._dropdownPendingId = 0;
  core._dropdownWaiters = new Map();
  core._dropdownGeometryIds = null;
  core._markerPidCache = null;
  core._dropdownSettingsChangedId = 0;
  core._dropdownHeightChangedId = 0;
  core._backgroundAppWin = null;
  core._backgroundAppWaiter = null;
  core._backgroundAppReleaseId = 0;
  core._maximizeToggleRects = new Map();
  core._backgroundAppPending = false;
  core._backgroundAppSpawnRetries = 0;
  core._markerSweepPending = false;
  core._bgAppRecheckPending = false;
  core._bgAppRecheckId = 0;
  core._markerSweepGen = 0;
  core._backgroundAppPendingId = 0;
  core._backgroundAppUnmanagedId = 0;
  core._backgroundAppSettingsChangedId = 0;
  core._backgroundAppEnabledChangedId = 0;
  core._backgroundAppRestartId = 0;
  core._pointerFocusId = 0;
  core._pointerFocusLastX = -1;
  core._pointerFocusLastY = -1;
  core._pointerFocusCandSig = '';
  core._chromiumProcessCache = new Map();
  core._backgroundAppProc = null;
  core._backgroundAppFirstFrameId = 0;
  core._backgroundAppClone = null;
  core._backgroundAppGroupAddedId = 0;
  core._backgroundAppCloneWatchId = 0;
  core._backgroundAppParkIds = null;
  core._backgroundAppParkWatchTimeoutId = 0;
  core._backgroundAppParkCoalesceId = 0;
  core._backgroundAppParkCount = 0;
  core._backgroundAppParkingWs = null;
  core._backgroundAppHiding = null;
  core._backgroundAppParkingFixId = 0;
  core._backgroundAppParkingLastRelocate = 0;
  core._dynamicWsWarned = false;
  core._lastRealFocusedWindow = null;
  core._floatMaxRects = new Map();
  core._gappedMaxSet = new Set();
  core._borderAnimId = 0;
  core._scratchpadWindows = new Map();
  core._scratchpadVisible = false;
  core._dropPreview = null;
  core._dropOverlay = null;
  core._shuttingDown = false;
  core._animating = false;
  core._animTargets = null;
  core._animStates = null;
  core._animWindows = null;
  core._animStartTime = 0;
  core._animTickId = 0;
  core._newWindowSet = new Set();
  core._floatHooks = new Map();
  core._mutterSettings = null;
  core._signals = [];
  core._windowSignals = new Map();
  core._shellSettings = null;
  core._shellSettingsChangedId = 0;
  core._jpSettings = null;
  core._jpSettingsChangedId = 0;
  core._pointerFocusEnabledId = 0;
}

function applyOverride(core, key, value) {
  core[key] = value;
  const target = LEGACY_METHODS[key];
  if (!target) return;
  const [prop, name] = target;
  if (prop === 'core') {
    core[name] = value;
    return;
  }
  if (core[prop])
    core[prop][name] = value;
}

// Real PlaidCore + subsystem instances; the Proxy keeps the old `_method`
// call sites used by the existing unit tests.
export function makeSelf(settings = {}, overrides = {}) {
  const core = new PlaidCore({
    getSettings: () => fakeSettings(settings),
    metadata: {},
  });
  resetCoreState(core, settings);
  for (const [key, value] of Object.entries(overrides))
    applyOverride(core, key, value);

  return new Proxy(core, {
    get(target, prop, receiver) {
      if (prop in target)
        return Reflect.get(target, prop, receiver);
      const targetInfo = LEGACY_METHODS[prop];
      if (targetInfo) {
        const [owner, name] = targetInfo;
        const obj = owner === 'core' ? target : target[owner];
        if (obj && typeof obj[name] === 'function')
          return obj[name].bind(obj);
      }
      return undefined;
    },
    set(target, prop, value) {
      applyOverride(target, prop, value);
      return true;
    },
  });
}

let _winId = 0;

export function fakeWin(opts = {}) {
  const frame = opts.frame ?? { x: 0, y: 0, width: 100, height: 100 };
  const buffer = opts.buffer ?? frame;
  return {
    _testId: opts.id ?? ++_winId,
    get_frame_rect: () => ({ ...frame }),
    get_buffer_rect: () => ({ ...buffer }),
    get_wm_class_instance: () => opts.instance ?? null,
    get_wm_class: () => opts.wmClass ?? null,
    get_gtk_application_id: () => opts.appId ?? null,
    get_title: () => opts.title ?? '',
    get_min_size: () => opts.minSize ?? [0, 0],
    get_window_type: () => opts.type ?? 0,
    is_skip_taskbar: () => opts.skipTaskbar ?? false,
    is_fullscreen: () => opts.fullscreen ?? false,
    is_maximized: () => opts.maximized ?? false,
    minimized: opts.minimized ?? false,
  };
}

export const leaf = (win) => ({ type: 'leaf', window: win });
export const empty = () => ({ type: 'empty' });
export const split = (direction, ratio, first, second) =>
  ({ type: 'split', direction, ratio, first, second });
