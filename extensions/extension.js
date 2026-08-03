import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import cairo from 'gi://cairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ModalDialog } from 'resource:///org/gnome/shell/ui/modalDialog.js';
import { WorkspaceSwitcherPopup, MonitorWorkspaceSwitcherPopup }
    from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';
import * as WorkspaceThumbnailModule from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

const LAYOUT_NAMES = {
    'dwindle': 'Dwindle',
    'master-stack': 'Master-stack',
    'centered-master-stack': 'Centered Master-stack',
};

const BORDER_SEG_STEP = 12;
const BORDER_CORNER_MIN_SEGS = 8;
const BORDER_CORNER_SEG_STEP = 4;

const SNIPPET_HOOK_FRAGMENT = Cogl.SnippetHook ? Cogl.SnippetHook.FRAGMENT : Shell.SnippetHook.FRAGMENT;
const MASK_EFFECT_NAME = 'plaid-corner-mask';
const BLUR_EFFECT_NAME = 'plaid-window-blur';

const MASK_SNIPPET_DECLARATIONS = `
uniform vec4 bounds;
uniform float clipRadius;
uniform vec2 pixelStep;
uniform vec4 borderColor1;
uniform vec4 borderColor2;
uniform float borderWidth;
uniform float gradientMode;
uniform float theta;
uniform vec4 borderedAreaBounds;
uniform float borderedAreaClipRadius;
uniform float opacity;

float circleBounds(vec2 p, vec2 center, float clipRadius) {
    vec2 delta = p - center;
    float distSquared = dot(delta, delta);
    float outerRadius = clipRadius + 0.5;
    if (distSquared >= (outerRadius * outerRadius))
        return 0.0;
    float innerRadius = clipRadius - 0.5;
    if (distSquared <= (innerRadius * innerRadius))
        return 1.0;
    return outerRadius - sqrt(distSquared);
}

float getPointOpacity(vec2 p, vec4 bounds, float clipRadius) {
    if (p.x < bounds.x || p.x > bounds.z || p.y < bounds.y || p.y > bounds.w)
        return 0.0;
    vec2 center;
    float centerLeft = bounds.x + clipRadius;
    float centerRight = bounds.z - clipRadius;
    if (p.x < centerLeft)
        center.x = centerLeft;
    else if (p.x > centerRight)
        center.x = centerRight;
    else
        return 1.0;
    float centerTop = bounds.y + clipRadius;
    float centerBottom = bounds.w - clipRadius;
    if (p.y < centerTop)
        center.y = centerTop;
    else if (p.y > centerBottom)
        center.y = centerBottom;
    else
        return 1.0;
    return circleBounds(p, center, clipRadius);
}

float gradientPos(vec2 p, vec4 bounds) {
    if (gradientMode < 0.5)
        return clamp((p.y - bounds.y) / (bounds.w - bounds.y), 0.0, 1.0);
    if (gradientMode < 1.5)
        return clamp((p.x - bounds.x) / (bounds.z - bounds.x), 0.0, 1.0);
    if (gradientMode < 2.5)
        return clamp(((p.x - bounds.x) + (p.y - bounds.y)) / ((bounds.z - bounds.x) + (bounds.w - bounds.y)), 0.0, 1.0);
    vec2 c = vec2((bounds.x + bounds.z) / 2.0, (bounds.y + bounds.w) / 2.0);
    float ang = atan(p.y - c.y, p.x - c.x) - theta;
    float t = mod(ang, 6.28318530718) / 6.28318530718;
    return t < 0.5 ? t * 2.0 : (1.0 - t) * 2.0;
}
`;

const MASK_SNIPPET_CODE = `
    vec2 p = cogl_tex_coord0_in.xy / pixelStep;

    float pointAlpha = getPointOpacity(p, bounds, clipRadius);

    cogl_color_out *= pointAlpha;

    cogl_color_out *= opacity;

    if (borderWidth > 0.5) {
        float borderedAreaAlpha = getPointOpacity(p, borderedAreaBounds, borderedAreaClipRadius);
        float borderAlpha = clamp(abs(pointAlpha - borderedAreaAlpha), 0.0, 1.0);
        if (borderAlpha > 0.0) {
            vec3 gradColor = mix(borderColor1.rgb, borderColor2.rgb, gradientPos(p, bounds));
            cogl_color_out = mix(cogl_color_out, vec4(gradColor, 1.0), borderAlpha * borderColor1.a);
        }
    }
`;

const CornerMaskEffect = GObject.registerClass({
    GTypeName: 'PlaidCornerMaskEffect',
}, class CornerMaskEffect extends Shell.GLSLEffect {
    constructor() {
        super();
        this._radius = 0;
        this._metaWin = null;
        this._uniformLocations = {
            bounds: this.get_uniform_location('bounds'),
            clipRadius: this.get_uniform_location('clipRadius'),
            pixelStep: this.get_uniform_location('pixelStep'),
            borderColor1: this.get_uniform_location('borderColor1'),
            borderColor2: this.get_uniform_location('borderColor2'),
            borderWidth: this.get_uniform_location('borderWidth'),
            gradientMode: this.get_uniform_location('gradientMode'),
            theta: this.get_uniform_location('theta'),
            borderedAreaBounds: this.get_uniform_location('borderedAreaBounds'),
            borderedAreaClipRadius: this.get_uniform_location('borderedAreaClipRadius'),
            opacity: this.get_uniform_location('opacity'),
        };
    }

    vfunc_build_pipeline() {
        try {
            this.add_glsl_snippet(SNIPPET_HOOK_FRAGMENT, MASK_SNIPPET_DECLARATIONS, MASK_SNIPPET_CODE, false);
        } catch (e) {
            log(`[plaid] mask snippet failed: ${e.message}`);
        }
    }

    vfunc_paint_target(node, paintContext) {
        try {
            const actor = this.get_actor();
            if (actor && this._metaWin && this._metaWin.get_frame_rect) {
                const buffer = this._metaWin.get_buffer_rect();
                const frame = this._metaWin.get_frame_rect();
                const offsetX = frame.x - buffer.x;
                const offsetY = frame.y - buffer.y;
                const bw = frame.width - buffer.width;
                const bh = frame.height - buffer.height;
                const w = Math.max(1, actor.width);
                const h = Math.max(1, actor.height);
                const loc = this._uniformLocations;
                this.set_uniform_float(loc.bounds, 4, [
                    offsetX + 1,
                    offsetY + 1,
                    offsetX + actor.width + bw,
                    offsetY + actor.height + bh,
                ]);
                this.set_uniform_float(loc.pixelStep, 2, [1 / w, 1 / h]);
            }
        } catch (e) {
            log(`[plaid] mask paint sync failed: ${e.message}`);
        }
        super.vfunc_paint_target(node, paintContext);
    }

    updateMask(x1, y1, x2, y2, radius, borderWidth, color1, color2, mode, theta, opacity) {
        this._radius = radius;
        const loc = this._uniformLocations;
        try {
            const actor = this.get_actor();
            const w = Math.max(1, actor ? actor.width : 1);
            const h = Math.max(1, actor ? actor.height : 1);
            const inset = Math.max(0, borderWidth);
            this.set_uniform_float(loc.bounds, 4, [x1, y1, x2, y2]);
            this.set_uniform_float(loc.clipRadius, 1, [radius]);
            this.set_uniform_float(loc.pixelStep, 2, [1 / w, 1 / h]);
            this.set_uniform_float(loc.borderedAreaBounds, 4, [x1 + inset, y1 + inset, x2 - inset, y2 - inset]);
            this.set_uniform_float(loc.borderedAreaClipRadius, 1, [Math.max(0, radius - inset)]);
            this.set_uniform_float(loc.borderWidth, 1, [borderWidth]);
            this.set_uniform_float(loc.borderColor1, 4, color1);
            this.set_uniform_float(loc.borderColor2, 4, color2);
            this.set_uniform_float(loc.gradientMode, 1, [mode]);
            this.set_uniform_float(loc.theta, 1, [theta]);
            this.set_uniform_float(loc.opacity, 1, [opacity]);
        } catch (e) {
            log(`[plaid] mask uniforms failed: ${e.message}`);
            return;
        }
        this.queue_repaint();
    }

    setTheta(theta) {
        try {
            this.set_uniform_float(this._uniformLocations.theta, 1, [theta]);
        } catch (_e) {
            return;
        }
        this.queue_repaint();
    }

    setBorderWidth(width) {
        try {
            this.set_uniform_float(this._uniformLocations.borderWidth, 1, [width]);
        } catch (_e) {
            return;
        }
        this.queue_repaint();
    }

});

export default class TilingWMExtension extends Extension {
    enable() {
        this._destroyed = false;
        this._settings = this.getSettings();
        this._ensureBlurModule();
        this._floatingClasses = new Set(this._settings.get_strv('float-windows'));
        this._floatingTitles = new Set(this._settings.get_strv('float-titles'));
        this._windowBorders = new Map();
        this._windowMasks = new Map();
        this._windowBlurs = new Map();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._destroyed) return false;
            try { this._purgeOrphanBlurs(); } catch (_e) {}
            return false;
        });
        this._workspaceOrders = new Map();
        this._windowWorkspaces = new Map();
        this._windowWSIndices = new Map();
        this._workspaceLayouts = new Map();
        this._currentDefaultLayout = this._settings.get_string('layout');
        this._lastRetileTimes = new Map();
        this._masterRatios = new Map();
        this._stackRatios = new Map();
        this._bspTrees = new Map();
        this._lastFocusedPerWorkspace = new Map();
        this._savedRects = new Map();
        this._signals = [];
        this._pendingRetileIds = new Map();
        this._pendingBorderId = 0;
        this._queuedAnimWorkspaces = new Set();
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
        this._backgroundAppPending = false;
        this._backgroundAppPendingId = 0;
        this._backgroundAppUnmanagedId = 0;
        this._backgroundAppSettingsChangedId = 0;
        this._backgroundAppEnabledChangedId = 0;
        this._backgroundAppRestartId = 0;
        this._backgroundAppProc = null;
        this._backgroundAppFirstFrameId = 0;
        this._backgroundAppClone = null;
        this._backgroundAppGroupAddedId = 0;
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
        this._anyGrabOp = null;
        this._borderAnimId = 0;
        this._scratchpadWindows = new Map();
        this._scratchpadVisible = false;
        this._dropPreview = null;

        this._disableMutterDefaults();
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
        this._initBackgroundApp();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._destroyed) return false;
            this._updateDropOverlaySize();
            for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
                const ws = global.workspace_manager.get_workspace_by_index(i);
                for (const win of ws.list_windows()) {
                    if (this._shouldManage(win)) {
                        this._addWindow(win);
                        this._convertMaximizedToGaps(win);
                    } else if (this._isFloating(win)) {
                        this._raiseFloatingWindows(ws);
                        this._restoreFloatNaturalRect(win);
                        this._convertMaximizedToGaps(win);
                        this._connectFloatHooks(win);
                    }
                }
            }
            this._retileAll();
            this._checkDynamicWorkspaces();
            return false;
        });
    }

    _currentTime() {
        try { return global.get_current_time(); } catch (_e) { return 0; }
    }

    _wsIndex(ws) {
        if (!ws) return -1;
        try { return typeof ws.index === 'number' ? ws.index : ws.get_index(); } catch (_e) {}
        try {
            for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
                if (global.workspace_manager.get_workspace_by_index(i) === ws) return i;
            }
        } catch (_e) {}
        return -1;
    }

    disable() {
        this._destroyed = true;
        if (this._pickFocusId) {
            try { global.display.disconnect(this._pickFocusId); } catch (_e) {}
            this._pickFocusId = null;
        }
        for (const id of (this._pendingRetileIds || new Map()).values())
            GLib.source_remove(id);
        if (this._pendingBorderId) GLib.source_remove(this._pendingBorderId);
        this._stopLiveResizeLoop();
        this._disconnectGrabBoundaryHooks();
        this._restoreMutterDefaults();
        this._removeAllBorders();
        this._hideDropPreview();
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
        this._removeKeybindings();
        this._settings = null;
        this._floatingClasses = null;
        this._floatingTitles = null;
        this._toggleFloatWindows = null;
        this._floatMaxRects = null;
        this._gappedMaxSet = null;
        this._anyGrabOp = null;
        this._windowBorders = null;
        try { this._removeAllMasks(); } catch (_e) {}
        this._windowMasks = null;
        try { this._removeAllBlurs(); } catch (_e) {}
        this._windowBlurs = null;
        this._blurModulePromise = null;
        this._blurModule = null;
        this._workspaceOrders = null;
        this._windowWorkspaces = null;
        this._windowWSIndices = null;
        this._workspaceLayouts = null;
        this._masterRatios = null;
        this._stackRatios = null;
        this._bspTrees = null;
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
    }

    _disableMutterDefaults() {
        this._mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
        this._savedEdgeTiling = this._mutterSettings.get_boolean('edge-tiling');
        this._mutterSettings.set_boolean('edge-tiling', false);
        this._wmKeybindings = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.keybindings' });
        this._savedMaximize = this._wmKeybindings.get_strv('maximize');
        this._savedMaximizeHoriz = this._wmKeybindings.get_strv('maximize-horizontally');
        this._savedMaximizeVert = this._wmKeybindings.get_strv('maximize-vertically');
        this._wmKeybindings.set_strv('maximize', []);
        this._wmKeybindings.set_strv('maximize-horizontally', []);
        this._wmKeybindings.set_strv('maximize-vertically', []);
    }

    _restoreMutterDefaults() {
        if (this._mutterSettings) {
            this._mutterSettings.set_boolean('edge-tiling', this._savedEdgeTiling);
            this._mutterSettings = null;
        }
        if (this._wmKeybindings) {
            this._wmKeybindings.set_strv('maximize', this._savedMaximize);
            this._wmKeybindings.set_strv('maximize-horizontally', this._savedMaximizeHoriz);
            this._wmKeybindings.set_strv('maximize-vertically', this._savedMaximizeVert);
            this._wmKeybindings = null;
        }
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
                        doRetile();
                        this._cursorWarpDeferred(win);
                    });
                } else {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        doRetile();
                        this._cursorWarpDeferred(win);
                        return false;
                    });
                }
            } else if (this._isFloating(win)) {
                const doRaise = () => {
                    if (this._destroyed) return;
                    const ws = win.get_workspace();
                    if (ws) this._raiseFloatingWindows(ws);
                };
                const doRestore = () => {
                    if (this._destroyed) return;
                    this._restoreFloatNaturalRect(win);
                };
                const actor = win.get_compositor_private();
                if (actor) {
                    const firstFrameId = actor.connect('first-frame', () => {
                        actor.disconnect(firstFrameId);
                        doRaise();
                        doRestore();
                        this._connectFloatHooks(win);
                    });
                } else {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        doRaise();
                        doRestore();
                        this._connectFloatHooks(win);
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
            this._updateDropOverlaySize();
            this._refillBackgroundApp();
            this._retileAll();
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
                    this._masterRatios.delete(workspace);
                    this._stackRatios.delete(workspace);
                    this._bspTrees.delete(workspace);
                    this._workspaceLayouts.delete(workspace);
                    this._lastFocusedPerWorkspace.delete(workspace);
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
            this._reapplyFloatRules();
            this._retileAll();
        }));
        this._addSignal(this._settings, this._settings.connect('changed::float-titles', () => {
            this._floatingTitles = new Set(this._settings.get_strv('float-titles'));
            this._reapplyFloatRules();
            this._retileAll();
        }));
        this._addSignal(this._settings, this._settings.connect('changed::gap', () => this._retileAll()));
        this._addSignal(this._settings, this._settings.connect('changed::single-gap-top', () => this._retileAll()));
        this._addSignal(this._settings, this._settings.connect('changed::single-gap-bottom', () => this._retileAll()));
        this._addSignal(this._settings, this._settings.connect('changed::single-gap-left', () => this._retileAll()));
        this._addSignal(this._settings, this._settings.connect('changed::single-gap-right', () => this._retileAll()));
        this._addSignal(this._settings, this._settings.connect('changed::enabled', () => this._onTilingEnabledChanged()));
        this._addSignal(this._settings, this._settings.connect('changed::layout', () => {
            const oldDefault = this._currentDefaultLayout;
            this._currentDefaultLayout = this._settings.get_string('layout');
            for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
                const ws = global.workspace_manager.get_workspace_by_index(i);
                if (!this._workspaceLayouts.has(ws))
                    this._workspaceLayouts.set(ws, oldDefault);
            }
            const activeWs = global.workspace_manager.get_active_workspace();
            if (activeWs)
                this._workspaceLayouts.set(activeWs, this._currentDefaultLayout);
            this._retileWorkspace(activeWs);
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
        const wms = win.get_wm_class_instance();
        const title = win.get_title();
        if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
        if (win.is_skip_taskbar()) return false;
        if (win.get_transient_for()) return false;
        if (wms && this._floatingClasses.has(wms.toLowerCase())) return false;
        if (title && this._floatingTitles.has(title)) return false;
        return true;
    }

    _moveCursorToWindow(win) {
        try {
            const frame = win.get_frame_rect();
            if (frame.width === 0 || frame.height === 0) return false;
            const centerX = frame.x + frame.width / 2;
            const centerY = frame.y + frame.height / 2;
            const backend = Clutter.get_default_backend();
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
        const wms = win.get_wm_class_instance();
        if (wms && this._floatingClasses.has(wms.toLowerCase())) return true;
        const title = win.get_title();
        if (title && this._floatingTitles.has(title)) return true;
        if (win.is_fullscreen()) return true;
        if (win.get_window_type() !== Meta.WindowType.NORMAL) return true;
        if (win.is_skip_taskbar()) return true;
        if (win.get_transient_for()) return true;
        return false;
    }

    _getWorkspaceOrder(workspace) {
        if (!this._workspaceOrders.has(workspace))
            this._workspaceOrders.set(workspace, []);
        return this._workspaceOrders.get(workspace);
    }

    _getWorkspaceLayout(workspace) {
        return this._workspaceLayouts.get(workspace) || this._settings.get_string('layout');
    }

    _addWindow(win) {
        if (!this._settings) return;
        if (this._windowWorkspaces.has(win)) return;
        this._debugLog(`ADD_WINDOW: ${win.get_wm_class_instance() || '?'} skipTaskbar=${win.is_skip_taskbar()}`);
        this._newWindowSet.add(win);
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
    }

    _removeWindow(win) {
        if (!this._settings) return;
        const ws = this._windowWorkspaces.get(win) || win.get_workspace();
        const wmClass = win.get_wm_class_instance() || '?';
        this._debugLog(`REMOVE_WINDOW: ${wmClass} ws=${this._wsIndex(ws)}`);
        this._windowWorkspaces.delete(win);
        this._windowWSIndices.delete(win);
        this._toggleFloatWindows.delete(win);
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
            this._maybeReassertSlot(win);
        }) });
        sigIds.push({ emitter: win, id: win.connect('notify::wm-class', () => {
            this._onWindowIdentityChanged(win);
        }) });
        sigIds.push({ emitter: win, id: win.connect('notify::gtk-application-id', () => {
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
                this._convertMaximizedToGaps(win);
                this._trackFloatGeometry(win);
            }),
            win.connect('size-changed', () => {
                this._convertMaximizedToGaps(win);
                this._trackFloatGeometry(win);
            }),
        ];
        ids.push(win.connect('unmanaged', () => this._disconnectFloatHooks(win)));
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
            this._windowWSIndices.get(w) === this._wsIndex(workspace)
        );
    }

    _raiseFloatingWindows(workspace) {
        if (!workspace) return;
        const tiled = this._getWindowsForWorkspace(workspace)
            .filter(w => !this._isFloating(w));
        const windows = workspace.list_windows();
        for (const win of windows) {
            if (!tiled.includes(win) && win !== this._backgroundAppWin) {
                try { win.make_above(); } catch (_e) {}
            }
        }
        for (const win of tiled) {
            try { win.unmake_above(); } catch (_e) {}
        }
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
            this._raiseFloatingWindows(workspace);
            return;
        }
        if (this._grabOp) return;
        const tiledWindows = this._getWindowsForWorkspace(workspace)
            .filter(w => !this._isFloating(w));
        if (tiledWindows.length === 0) {
            this._raiseFloatingWindows(workspace);
            return;
        }

        if (this._getAnimationTime() > 0 && !this._grabOp) {
            this._animRetile(workspace, tiledWindows);
            return;
        }

        const layout = this._getWorkspaceLayout(workspace);
        if (layout === 'dwindle')
            this._retileDwindle(workspace, tiledWindows);
        else if (layout === 'centered-master-stack')
            this._retileCenteredMasterStack(workspace, tiledWindows);
        else
            this._retileMasterStack(workspace, tiledWindows);

        try { this._doUpdateBorders(); } catch (e) {
            log(`[plaid] _doUpdateBorders after retile failed: ${e.message}`);
        }
        this._raiseFloatingWindows(workspace);
        for (const win of tiledWindows)
            this._newWindowSet.delete(win);
    }

    // --- Animation ---

    _getAnimationTime() {
        const stSettings = St.Settings.get();
        if (!stSettings.enable_animations) return 0;
        return 0.1 * stSettings.slow_down_factor;
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
                        a.set_opacity(255);
                        a.remove_all_transitions();
                    }
                } catch (_e) {}
            }
        }
        this._animating = false;
        this._animTargets = null;
        this._animStates = null;
    }

    _animRetile(workspace, tiledWindows) {
        if (this._animating) {
            this._queuedAnimWorkspaces.add(workspace);
            return;
        }

        this._animTargets = new Map();

        const layout = this._getWorkspaceLayout(workspace);
        if (layout === 'dwindle')
            this._retileDwindle(workspace, tiledWindows);
        else if (layout === 'centered-master-stack')
            this._retileCenteredMasterStack(workspace, tiledWindows);
        else
            this._retileMasterStack(workspace, tiledWindows);

        if (this._animTargets.size === 0) {
            this._animTargets = null;
            for (const win of tiledWindows) this._newWindowSet.delete(win);
            this._scheduleBorders();
            this._raiseFloatingWindows(workspace);
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
                for (const w of tiledWindows) this._newWindowSet.delete(w);
                this._animStates = null;
                this._scheduleBorders();
                this._raiseFloatingWindows(workspace);
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
                s.actor.show();
            }
        }

        if (existingStates.length > 0) {
            this._animStates = existingStates;
            this._animStartTime = Date.now();
            this._animTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
                if (this._destroyed) { this._animTickId = 0; return GLib.SOURCE_REMOVE; }
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
                        dec();
                    }
                    // Now fade in new windows
                    for (const s of newStates) {
                        if (s.actor) {
                            try { s.win.move_resize_frame(true, s.targetX, s.targetY, s.targetW, s.targetH); } catch (_e) {}
                            try { s.actor.ease({ opacity: 255, duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC, onComplete: () => {
                                if (this._destroyed) return;
                                this._moveCursorToWindow(s.win);
                                dec();
                            } }); } catch (_e) { dec(); }
                        } else {
                            dec();
                        }
                    }
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        } else {
            // Only new windows — just fade them in immediately
            for (const s of newStates) {
                if (s.actor) {
                    try { s.win.move_resize_frame(true, s.targetX, s.targetY, s.targetW, s.targetH); } catch (_e) {}
                    try { s.actor.ease({ opacity: 255, duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC, onComplete: () => {
                        if (this._destroyed) return;
                        this._moveCursorToWindow(s.win);
                        dec();
                    } }); } catch (_e) { dec(); }
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
        actor.ease(props);
    }

    // --- Master-Stack Helpers ---

    _getMasterRatio(ws) {
        if (!this._masterRatios.has(ws))
            this._masterRatios.set(ws, 0.5);
        return this._masterRatios.get(ws);
    }

    _getStackRatios(ws) {
        if (!this._stackRatios.has(ws))
            this._stackRatios.set(ws, new Map());
        return this._stackRatios.get(ws);
    }

    _retileMasterStack(workspace, tiledWindows, skipWindow = null) {
        const gap = this._settings.get_int('gap');
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

        const areaX = workArea.x + gap;
        const areaY = workArea.y + gap;
        const areaW = workArea.width - gap * 2;
        const areaH = workArea.height - gap * 2;
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
                            h = areaY + areaH - y;
                        } else {
                            h = Math.floor(weights[i] * scale);
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
            const h = isLast
                ? (areaY + areaH - y)
                : Math.floor(totalStackH * weights[i] / totalWeight);
            const win = tiledWindows[i + 1];
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
        const gap = this._settings.get_int('gap');
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

        const areaX = workArea.x + gap;
        const areaY = workArea.y + gap;
        const areaW = workArea.width - gap * 2;
        const areaH = workArea.height - gap * 2;
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
                this._masterRatios.set(workspace, Math.max(0.15, Math.min(0.85, effectiveRatio)));
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
                            h = areaY + areaH - y;
                        } else {
                            h = Math.floor(stackWeights[i] * scale);
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
                const h = isLast
                    ? (areaY + areaH - y)
                    : Math.floor(totalStackH * stackWeights[i] / stackTotal);
                const win = stackWindows[i];
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
        const gap = this._settings.get_int('gap');
        const areaW = workArea.width - gap * 2;
        const layout = this._getWorkspaceLayout(workspace);
        const masterDenom = layout === 'centered-master-stack' ? areaW - gap * 2 : areaW - gap;

        if (axis === 'width') {
            const currentRatio = this._getMasterRatio(workspace);
            const currentMasterW = masterDenom * currentRatio;
            const newMasterW = currentMasterW + delta;
            const minMaster = 100;
            const maxMaster = masterDenom - numStack * 100;
            if (maxMaster >= minMaster) {
                const clamped = Math.max(minMaster, Math.min(maxMaster, newMasterW));
                this._masterRatios.set(workspace, clamped / masterDenom);
            }
        } else {
            const idx = tiledWindows.indexOf(focused);
            if (idx === 0) return;
            const stackIdx = idx - 1;
            const stackRatios = this._getStackRatios(workspace);
            const currentWeight = stackRatios.has(stackIdx) ? stackRatios.get(stackIdx) : 1.0;
            const newWeight = Math.max(0.1, currentWeight + delta * 0.005);
            stackRatios.set(stackIdx, newWeight);
        }
    }

    _computeMasterStackDropTarget(ws, px, py) {
        const gap = this._settings.get_int('gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return -1;

        if (px < workArea.x || px > workArea.x + workArea.width ||
            py < workArea.y || py > workArea.y + workArea.height)
            return -1;

        const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
        if (tiled.length === 0) return -1;

        const areaX = workArea.x + gap;
        const areaY = workArea.y + gap;
        const areaW = workArea.width - gap * 2;
        const areaH = workArea.height - gap * 2;
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
                return 1;
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
                return 1 + leftCount;
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

    // --- BSP Tree ---

    _bspGetTree(workspace) {
        if (!this._bspTrees.has(workspace))
            this._bspTrees.set(workspace, null);
        return this._bspTrees.get(workspace);
    }

    _bspMakeLeaf(win) {
        return { type: 'leaf', window: win };
    }

    _bspMakeSplit(dir, ratio, first, second) {
        return { type: 'split', direction: dir, ratio, first, second };
    }

    _bspInsert(node, win, x, y, w, h, gap) {
        if (!node) return this._bspMakeLeaf(win);
        if (node.type === 'empty') return this._bspMakeLeaf(win);
        if (node.type === 'leaf') {
            const dir = w >= h ? 'h' : 'v';
            const ratio = this._settings.get_double('dwindle-ratio');
            return this._bspMakeSplit(dir, ratio, node, this._bspMakeLeaf(win));
        }
        const isH = node.direction === 'h';
        const axisSize = isH ? w : h;
        const split = Math.floor((axisSize - gap) * node.ratio);
        const secondSize = axisSize - split - gap;
        if (isH)
            node.second = this._bspInsert(node.second, win, x + split + gap, y, secondSize, h, gap);
        else
            node.second = this._bspInsert(node.second, win, x, y + split + gap, w, secondSize, gap);
        return node;
    }

    _bspRemove(node, win) {
        if (!node) return { type: 'empty' };
        if (node.type === 'empty') return node;
        if (node.type === 'leaf') {
            return node.window === win ? { type: 'empty' } : node;
        }
        node.first = this._bspRemove(node.first, win);
        node.second = this._bspRemove(node.second, win);
        if (node.first.type === 'empty' && node.second.type === 'empty')
            return { type: 'empty' };
        if (node.first.type === 'empty') return node.second;
        if (node.second.type === 'empty') return node.first;
        return node;
    }

    _bspCollectWindows(node) {
        if (!node) return [];
        if (node.type === 'empty') return [];
        if (node.type === 'leaf') return [node.window];
        return [...this._bspCollectWindows(node.first), ...this._bspCollectWindows(node.second)];
    }

    _bspLayout(node, x, y, w, h, gap, skipWindow) {
        if (!node) return;
        if (node.type === 'empty') return;
        if (node.type === 'leaf') {
            if (node.window !== skipWindow) {
                this._safeMove(node.window, x, y, w, h);
            } else {
                const frame = node.window.get_frame_rect();
                this._safeMove(node.window, x, y, frame.width, frame.height);
            }
            return;
        }
        const isH = node.direction === 'h';
        const firstEmpty = !node.first || node.first.type === 'empty';
        const secondEmpty = !node.second || node.second.type === 'empty';
        if (firstEmpty && secondEmpty) return;
        if (firstEmpty) {
            this._bspLayout(node.second, x, y, w, h, gap, skipWindow);
            return;
        }
        if (secondEmpty) {
            this._bspLayout(node.first, x, y, w, h, gap, skipWindow);
            return;
        }
        const axisSize = isH ? w : h;
        const split = Math.floor((axisSize - gap) * node.ratio);
        const secondSize = axisSize - split - gap;
        if (split < 0 || secondSize < 0) return;
        if (isH) {
            this._bspLayout(node.first, x, y, split, h, gap, skipWindow);
            this._bspLayout(node.second, x + split + gap, y, secondSize, h, gap, skipWindow);
        } else {
            this._bspLayout(node.first, x, y, w, split, gap, skipWindow);
            this._bspLayout(node.second, x, y + split + gap, w, secondSize, gap, skipWindow);
        }
    }

    _bspFindPath(node, win, path) {
        if (!node) return false;
        if (node.type === 'leaf') return node.window === win;
        path.push(node);
        if (this._bspFindPath(node.first, win, path)) return true;
        if (this._bspFindPath(node.second, win, path)) return true;
        path.pop();
        return false;
    }

    _bspFindLeaf(node, win) {
        if (!node) return null;
        if (node.type === 'leaf') return node.window === win ? node : null;
        return this._bspFindLeaf(node.first, win) || this._bspFindLeaf(node.second, win);
    }

    _bspSwapWindows(node, winA, winB) {
        if (!node) return;
        if (node.type === 'leaf') {
            if (node.window === winA) node.window = winB;
            else if (node.window === winB) node.window = winA;
            return;
        }
        this._bspSwapWindows(node.first, winA, winB);
        this._bspSwapWindows(node.second, winA, winB);
    }

    _bspFindLeafAtPoint(node, x, y, w, h, px, py, gap) {
        if (!node) return null;
        if (node.type === 'empty') return node;
        if (node.type === 'leaf') return node;
        const isH = node.direction === 'h';
        const axisSize = isH ? w : h;
        const split = Math.floor((axisSize - gap) * node.ratio);
        const secondSize = axisSize - split - gap;
        if (isH) {
            if (px < x + split + gap)
                return this._bspFindLeafAtPoint(node.first, x, y, split, h, px, py, gap);
            else
                return this._bspFindLeafAtPoint(node.second, x + split + gap, y, secondSize, h, px, py, gap);
        } else {
            if (py < y + split + gap)
                return this._bspFindLeafAtPoint(node.first, x, y, w, split, px, py, gap);
            else
                return this._bspFindLeafAtPoint(node.second, x, y + split + gap, w, secondSize, px, py, gap);
        }
    }

    _bspReplaceLeaf(node, targetLeaf, newWin) {
        if (!node) return null;
        if (node.type === 'empty') {
            if (node === targetLeaf)
                return this._bspMakeLeaf(newWin);
            return node;
        }
        if (node.type === 'leaf') {
            if (node === targetLeaf) {
                const dir = ((node._w || 0) >= (node._h || 0)) ? 'h' : 'v';
                const ratio = this._settings.get_double('dwindle-ratio');
                return this._bspMakeSplit(dir, ratio, node, this._bspMakeLeaf(newWin));
            }
            return node;
        }
        node.first = this._bspReplaceLeaf(node.first, targetLeaf, newWin);
        node.second = this._bspReplaceLeaf(node.second, targetLeaf, newWin);
        return node;
    }

    _bspTagGeometry(node, x, y, w, h, gap) {
        if (!node) return;
        node._x = x;
        node._y = y;
        node._w = w;
        node._h = h;
        if (node.type === 'empty' || node.type === 'leaf') return;
        const isH = node.direction === 'h';
        const axisSize = isH ? w : h;
        const split = Math.floor((axisSize - gap) * node.ratio);
        const secondSize = axisSize - split - gap;
        if (isH) {
            this._bspTagGeometry(node.first, x, y, split, h, gap);
            this._bspTagGeometry(node.second, x + split + gap, y, secondSize, h, gap);
        } else {
            this._bspTagGeometry(node.first, x, y, w, split, gap);
            this._bspTagGeometry(node.second, x, y + split + gap, w, secondSize, gap);
        }
    }

    _bspInsertForWorkspace(ws, win) {
        const gap = this._settings.get_int('gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return;
        let tree = this._bspGetTree(ws);

        if (tree) {
            const existing = this._bspCollectWindows(tree);
            if (existing.includes(win)) return;
        }

        const areaX = workArea.x + gap;
        const areaY = workArea.y + gap;
        const areaW = workArea.width - gap * 2;
        const areaH = workArea.height - gap * 2;

        if (tree) {
            const [px, py] = global.get_pointer();
            this._bspTagGeometry(tree, areaX, areaY, areaW, areaH, gap);
            const target = this._bspFindLeafAtPoint(tree, areaX, areaY, areaW, areaH, px, py, gap);
            if (target) {
                tree = this._bspReplaceLeaf(tree, target, win);
            } else {
                tree = this._bspInsert(tree, win, areaX, areaY, areaW, areaH, gap);
            }
        } else {
            tree = this._bspInsert(tree, win, areaX, areaY, areaW, areaH, gap);
        }
        this._bspTrees.set(ws, tree);
    }

    _retileDwindle(workspace, tiledWindows) {
        const gap = this._settings.get_int('gap');
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
        const areaX = workArea.x + gap;
        const areaY = workArea.y + gap;
        const areaW = workArea.width - gap * 2;
        const areaH = workArea.height - gap * 2;

        if (tree) {
            const treeWins = this._bspCollectWindows(tree);
            for (const tw of treeWins) {
                if (!tiledWindows.includes(tw)) {
                    tree = this._bspRemove(tree, tw);
                }
            }
            for (const win of tiledWindows) {
                const currentWins = this._bspCollectWindows(tree);
                if (!currentWins.includes(win)) {
                    tree = this._bspInsert(tree, win, areaX, areaY, areaW, areaH, gap);
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

        this._bspLayout(tree, workArea.x + gap, workArea.y + gap, workArea.width - gap * 2, workArea.height - gap * 2, gap);
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

    _singleWindowRect(workArea) {
        if (!this._settings) return null;
        const top = this._settings.get_int('single-gap-top');
        const bottom = this._settings.get_int('single-gap-bottom');
        const left = this._settings.get_int('single-gap-left');
        const right = this._settings.get_int('single-gap-right');
        return {
            x: workArea.x + left,
            y: workArea.y + top,
            w: Math.max(1, workArea.width - left - right),
            h: Math.max(1, workArea.height - top - bottom),
        };
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
        if (!this._isFloating(win)) return;
        const ws = win.get_workspace();
        if (ws) this._raiseFloatingWindows(ws);
        this._restoreFloatNaturalRect(win);
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
        if (!workArea) return;
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
                    this._raiseFloatingWindows(ws);
                    this._restoreFloatNaturalRect(win);
                }
            }
        }
    }

    _updateBorders() {
        if (!this._settings || this._destroyed) return;
        this._scheduleBorders();
    }

    _doUpdateBorders() {
        if (!this._settings) return;
        try { this._removeAllBorders(); } catch (_e) {}
        if (!this._settings.get_boolean('enabled')) {
            try { this._removeAllMasks(); } catch (_e) {}
            try { this._removeAllBlurs(); } catch (_e) {}
            return;
        }

        const focusWindow = global.display.focus_window;

        const borderRadius = this._settings.get_int('border-radius');
        const roundedCorners = this._settings.get_boolean('rounded-corners');
        const bordersEnabled = this._settings.get_boolean('borders-enabled');
        const blurEnabled = this._settings.get_boolean('window-blur');

        const ws = global.workspace_manager.get_active_workspace();
        if (!ws) return;

        const windows = this._getWindowsForWorkspace(ws);
        for (const win of windows) {
            if (win.is_fullscreen()) {
                this._removeMask(win);
                this._removeBlur(win);
                continue;
            }
            if (this._grabOp && win === this._getActiveWindow()) continue;
            const actor = win.get_compositor_private();
            if (!actor) continue;
            const frame = win.get_frame_rect();
            if (frame.width === 0 || frame.height === 0) continue;

            if (blurEnabled)
                this._ensureWindowBlur(win, actor);

            if (roundedCorners && borderRadius > 0) {
                this._ensureWindowMask(win, actor, borderRadius + 1);
                continue;
            }

            const isFocused = win === focusWindow;
            if (bordersEnabled && this._ensureWindowBorder(win, actor, frame, isFocused))
                continue;
        }

        if (!roundedCorners || borderRadius <= 0) {
            try { this._removeAllMasks(); } catch (_e) {}
        }

        if (!blurEnabled) {
            try { this._removeAllBlurs(); } catch (_e) {}
        }

        if (this._dropdownWin)
            this._applyDropdownEffects(this._dropdownWin);

        this._raiseFloatingWindows(ws);
        this._syncBorderAnimation();
    }

    _ensureWindowBorder(win, actor, frame, isFocused) {
        if (!frame || frame.width === 0 || frame.height === 0) return false;
        const activeWidth = this._settings.get_int('active-border-width');
        const activeColor = (this._settings.get_strv('active-border-color') || [])[0] || '#3584e4';
        const activeColor2 = (this._settings.get_strv('active-border-color-2') || [])[0] || '#62a0ea';
        const inactiveWidth = this._settings.get_int('inactive-border-width');
        const inactiveColor = (this._settings.get_strv('inactive-border-color') || [])[0] || '#555555';
        const inactiveColor2 = (this._settings.get_strv('inactive-border-color-2') || [])[0] || '#777777';
        const borderRadius = this._settings.get_int('border-radius');
        const gradient = this._settings.get_boolean('gradient-borders');
        const gradientDir = this._settings.get_string('gradient-direction');

        const borderWidth = isFocused ? activeWidth : inactiveWidth;
        const color1 = isFocused ? activeColor : inactiveColor;
        const color2 = isFocused ? activeColor2 : inactiveColor2;

        if (borderWidth === 0) return false;

        const buffer = win.get_buffer_rect();
        const offsetX = frame.x - buffer.x;
        const offsetY = frame.y - buffer.y;

        let border;
        if (gradient) {
            border = new St.DrawingArea({
                x: offsetX - borderWidth,
                y: offsetY - borderWidth,
                width: frame.width + borderWidth * 2,
                height: frame.height + borderWidth * 2,
                reactive: false,
                visible: true,
            });
            border._plaidBorder = {
                color1: this._hexToRgb(color1),
                color2: this._hexToRgb(color2),
                width: borderWidth,
                radius: borderRadius,
                direction: gradientDir,
            };
            border.connect('repaint', () => this._repaintBorder(border));
        } else {
            border = new St.Widget({
                name: 'tiling-border',
                x: offsetX - borderWidth,
                y: offsetY - borderWidth,
                width: frame.width + borderWidth * 2,
                height: frame.height + borderWidth * 2,
                style: `border: ${borderWidth}px solid ${color1}; border-radius: ${borderRadius}px; box-sizing: border-box;`,
                reactive: false,
                visible: true,
            });
        }
        actor.add_child(border);
        this._windowBorders.set(win, border);
        return true;
    }

    _applyDropdownEffects(win) {
        if (!this._settings || this._destroyed || !win) return;
        const actor = win.get_compositor_private();
        if (!actor) return;
        const frame = win.get_frame_rect();
        if (frame.width === 0 || frame.height === 0) return;
        const borderRadius = this._settings.get_int('border-radius');
        const roundedCorners = this._settings.get_boolean('rounded-corners');
        const blurEnabled = this._settings.get_boolean('window-blur');
        const bordersEnabled = this._settings.get_boolean('borders-enabled');

        this._removeBorder(win);

        if (blurEnabled)
            this._ensureWindowBlur(win, actor);

        if (roundedCorners && borderRadius > 0) {
            this._ensureWindowMask(win, actor, borderRadius + 1);
        } else {
            this._removeMask(win);
        }

        if (!blurEnabled)
            this._removeBlur(win);

        if (bordersEnabled && !this._ensureWindowBorder(win, actor, frame, true))
            this._removeBorder(win);
    }

    _debugLog(...args) {
        if (this._destroyed || !this._settings) return;
        if (!this._settings.get_boolean('debug')) return;
        log(`[plaid] ${args.join(' ')}`);
    }

    _hexToRgb(hex) {
        const h = (hex || '').replace('#', '');
        const v = parseInt(h, 16);
        if (isNaN(v) || h.length < 6) return { r: 0.5, g: 0.5, b: 0.5 };
        return {
            r: ((v >> 16) & 255) / 255,
            g: ((v >> 8) & 255) / 255,
            b: (v & 255) / 255,
        };
    }

    _buildBorderSegments(border) {
        const info = border._plaidBorder;
        if (!info) return [];
        const w = border.width;
        const h = border.height;
        const key = `${w}x${h}x${info.radius}`;
        if (border._plaidSegs && border._plaidSegKey === key)
            return border._plaidSegs;

        const bw = info.width;
        const pathX = bw / 2;
        const pathY = bw / 2;
        const pathW = w - bw;
        const pathH = h - bw;
        if (pathW <= 0 || pathH <= 0) return [];

        const r = Math.min(Math.max(0, info.radius), pathW / 2, pathH / 2);
        const segs = [];
        const add = (x0, y0, x1, y1) => segs.push({ x0, y0, x1, y1 });
        const straight = (x0, y0, x1, y1) => {
            const len = Math.hypot(x1 - x0, y1 - y0);
            const n = Math.max(1, Math.ceil(len / BORDER_SEG_STEP));
            for (let i = 0; i < n; i++) {
                const a = i / n;
                const b = (i + 1) / n;
                add(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a,
                    x0 + (x1 - x0) * b, y0 + (y1 - y0) * b);
            }
        };
        const arc = (cxp, cyp, a0, a1) => {
            const n = Math.max(BORDER_CORNER_MIN_SEGS, Math.ceil(Math.abs(a1 - a0) * r / BORDER_CORNER_SEG_STEP));
            for (let i = 0; i < n; i++) {
                const a = a0 + (a1 - a0) * (i / n);
                const b = a0 + (a1 - a0) * ((i + 1) / n);
                add(cxp + Math.cos(a) * r, cyp + Math.sin(a) * r,
                    cxp + Math.cos(b) * r, cyp + Math.sin(b) * r);
            }
        };

        if (r <= 0) {
            straight(pathX, pathY, pathX + pathW, pathY);
            straight(pathX + pathW, pathY, pathX + pathW, pathY + pathH);
            straight(pathX + pathW, pathY + pathH, pathX, pathY + pathH);
            straight(pathX, pathY + pathH, pathX, pathY);
        } else {
            const top = pathY + r;
            const bottom = pathY + pathH - r;
            const left = pathX + r;
            const right = pathX + pathW - r;
            straight(left, pathY, right, pathY);
            arc(right, top, -Math.PI / 2, 0);
            straight(pathX + pathW, top, pathX + pathW, bottom);
            arc(right, bottom, 0, Math.PI / 2);
            straight(right, pathY + pathH, left, pathY + pathH);
            arc(left, bottom, Math.PI / 2, Math.PI);
            straight(pathX, bottom, pathX, top);
            arc(left, top, Math.PI, Math.PI * 1.5);
        }

        border._plaidSegs = segs;
        border._plaidSegKey = key;
        return segs;
    }

    _repaintBorder(border) {
        try {
            const info = border._plaidBorder;
            if (!info || !border.get_context) return;
            const w = border.width;
            const h = border.height;
            if (w <= 0 || h <= 0) return;

            const segs = this._buildBorderSegments(border);
            if (segs.length === 0) return;

            const bw = info.width;
            const cx = w / 2;
            const cy = h / 2;
            const speed = this._settings.get_int('border-animation-speed');
            const period = this._borderRotationMs(speed);
            const animated = period > 0;
            let theta = 0;
            if (animated) {
                const stSettings = St.Settings.get();
                const slow = Math.max(0.1, stSettings.slow_down_factor);
                theta = (((Date.now() / period) * slow) % 1) * Math.PI * 2;
            }

            const cr = border.get_context();
            cr.setLineWidth(bw);
            cr.setLineCap(cairo.LineCap.ROUND);

            for (const seg of segs) {
                const p = { x: (seg.x0 + seg.x1) / 2, y: (seg.y0 + seg.y1) / 2 };
                const gpos = this._borderGradientPos(w, h, p, info.direction, animated, theta, cx, cy);
                const c = this._lerpRgb(info.color1, info.color2, gpos);
                cr.setSourceRGB(c.r, c.g, c.b);
                cr.moveTo(seg.x0, seg.y0);
                cr.lineTo(seg.x1, seg.y1);
                cr.stroke();
            }
        } catch (e) {
            log(`[plaid] repaint FAILED: ${e.message}`);
        }
    }

    _borderGradientPos(w, h, p, direction, animated, theta, cx, cy) {
        if (animated) {
            const ang = Math.atan2(p.y - cy, p.x - cx);
            const g = ((ang - theta) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2);
            return g < 0.5 ? g * 2 : (1 - g) * 2;
        }
        if (direction === 'horizontal')
            return Math.max(0, Math.min(1, p.x / w));
        if (direction === 'diagonal')
            return Math.max(0, Math.min(1, (p.x + p.y) / (w + h)));
        return Math.max(0, Math.min(1, p.y / h));
    }

    _lerpRgb(c1, c2, t) {
        const k = Math.max(0, Math.min(1, t));
        return {
            r: c1.r + (c2.r - c1.r) * k,
            g: c1.g + (c2.g - c1.g) * k,
            b: c1.b + (c2.b - c1.b) * k,
        };
    }

    _borderRotationMs(speed) {
        if (speed <= 0) return 0;
        return 22000 - speed * 2000;
    }

    _startBorderAnimation() {
        if (this._borderAnimId) return;
        try {
            const stSettings = St.Settings.get();
            if (!stSettings.enable_animations) return;
            if (!this._settings.get_boolean('gradient-borders')) return;
            if (this._settings.get_int('border-animation-speed') <= 0) return;
        } catch (e) {
            log(`[plaid] _startBorderAnimation failed: ${e.message}`);
            return;
        }
        this._borderAnimId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
            try {
                const stSettings = St.Settings.get();
                if (this._destroyed || !stSettings.enable_animations ||
                    !this._settings.get_boolean('gradient-borders') ||
                    this._settings.get_int('border-animation-speed') <= 0 || this._grabOp) {
                    this._stopBorderAnimation();
                    return GLib.SOURCE_REMOVE;
                }
            } catch (e) {
                log(`[plaid] border animation tick failed: ${e.message}`);
                this._stopBorderAnimation();
                return GLib.SOURCE_REMOVE;
            }
            const stSettings = St.Settings.get();
            const slow = Math.max(0.1, stSettings.slow_down_factor);
            const period = this._borderRotationMs(this._settings.get_int('border-animation-speed'));
            const theta = period > 0 ? (((Date.now() / period) * slow) % 1) * Math.PI * 2 : 0;
            for (const effect of this._windowMasks.values()) {
                try { effect.setTheta(theta); } catch (_e) {}
            }
            for (const border of this._windowBorders.values()) {
                try { border.queue_redraw(); } catch (_e) {}
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopBorderAnimation() {
        if (this._borderAnimId) {
            GLib.source_remove(this._borderAnimId);
            this._borderAnimId = 0;
        }
    }

    _syncBorderAnimation() {
        try {
            if (!this._settings || this._destroyed) return;
            const wantAnim = this._settings.get_boolean('gradient-borders') &&
                this._settings.get_int('border-animation-speed') > 0 &&
                (this._windowBorders.size > 0 || this._windowMasks.size > 0);
            if (wantAnim)
                this._startBorderAnimation();
            else
                this._stopBorderAnimation();
        } catch (e) {
            log(`[plaid] _syncBorderAnimation failed: ${e.message}`);
            this._stopBorderAnimation();
        }
    }

    _updateBordersDuringGrab() {
        if (!this._settings || !this._settings.get_boolean('enabled')) return;
        const ws = global.workspace_manager.get_active_workspace();
        if (!ws) return;
        const focusWindow = global.display.focus_window;
        const activeWidth = this._settings.get_int('active-border-width');
        const inactiveWidth = this._settings.get_int('inactive-border-width');

        for (const [win, border] of this._windowBorders.entries()) {
            if (!win.get_compositor_private()) {
                this._removeBorder(win);
                continue;
            }
            const frame = win.get_frame_rect();
            if (frame.width === 0 || frame.height === 0) continue;
            const buffer = win.get_buffer_rect();
            const offsetX = frame.x - buffer.x;
            const offsetY = frame.y - buffer.y;
            const bw = win === focusWindow ? activeWidth : inactiveWidth;
            border.set_position(offsetX - bw, offsetY - bw);
            border.set_size(frame.width + bw * 2, frame.height + bw * 2);
            if (border.queue_repaint) {
                try { border.queue_redraw(); } catch (_e) {}
            }
        }
    }

    _removeAllBorders() {
        for (const border of this._windowBorders.values()) {
            try { border.destroy(); } catch (_e) {}
        }
        this._windowBorders.clear();
    }

    _removeBorder(win) {
        const border = this._windowBorders.get(win);
        if (border) {
            try { border.destroy(); } catch (_e) {}
            this._windowBorders.delete(win);
        }
        this._removeMask(win);
    }

    _unwrapMaskActor(actor, win) {
        if (!actor) return null;
        if (win.get_client_type() === Meta.WindowClientType.X11) {
            const firstChild = actor.get_first_child();
            return firstChild || null;
        }
        return actor;
    }

    _ensureWindowMask(win, actor, radius) {
        if (!this._windowMasks || !actor || !actor.add_effect_with_name) return;
        const target = this._unwrapMaskActor(actor, win);
        if (!target || !target.add_effect_with_name) return;
        let effect = this._windowMasks.get(win);
        if (effect && effect._radius !== radius) {
            this._teardownMaskEffect(win, effect);
            this._windowMasks.delete(win);
            effect = null;
        }
        if (!effect) {
            effect = new CornerMaskEffect();
            try {
                target.add_effect_with_name(MASK_EFFECT_NAME, effect);
                this._windowMasks.set(win, effect);
                this._debugLog(`corner mask attached radius=${radius}`);
            } catch (e) {
                log(`[plaid] corner mask attach failed: ${e.message}`);
                return;
            }
            effect.enabled = true;
            effect._metaWin = win;
            try {
                effect._watchActor = target;
                effect._sizeWatchId = target.connect('notify::size', () => {
                    this._connectTextureWatch(win, actor, effect);
                    this._scheduleMaskRedraw(win, actor, effect);
                });
            } catch (_e) {}
            this._connectTextureWatch(win, actor, effect);
        }
        this._updateMaskBounds(win, actor, effect, radius);
        try { target.queue_redraw(); } catch (_e) {}
    }

    _connectTextureWatch(win, actor, effect) {
        if (effect._textureWatchId) {
            try { effect._watchTexture.disconnect(effect._textureWatchId); } catch (_e) {}
            effect._textureWatchId = 0;
        }
        let texture = null;
        if (actor && actor.get_texture)
            texture = actor.get_texture();
        if (texture && texture.connect) {
            try {
                effect._watchTexture = texture;
                effect._textureWatchId = texture.connect('size-changed', () => {
                    this._scheduleMaskRedraw(win, actor, effect);
                });
            } catch (_e) {}
        }
    }

    _scheduleMaskRedraw(win, actor, effect) {
        if (effect._refreshTimeoutId) {
            try { GLib.source_remove(effect._refreshTimeoutId); } catch (_e) {}
        }
        effect._refreshTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            effect._refreshTimeoutId = 0;
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            this._debugLog(`mask redraw kick r=${effect._radius}`);
            this._updateMaskBounds(win, actor, effect, effect._radius);
            this._ensureWindowBlur(win, actor);
            const target = this._unwrapMaskActor(actor, win);
            if (target) {
                try { target.invalidate_paint_volume(); } catch (_e) {}
            }
            try { actor.invalidate_paint_volume(); } catch (_e) {}
            try { global.stage.queue_redraw(); } catch (_e) {}
            return GLib.SOURCE_REMOVE;
        });
    }

    _kickMaskNow(win) {
        if (!this._windowMasks) return;
        const effect = this._windowMasks.get(win);
        if (!effect) return;
        if (effect._refreshTimeoutId) {
            try { GLib.source_remove(effect._refreshTimeoutId); } catch (_e) {}
            effect._refreshTimeoutId = 0;
        }
        const actor = win.get_compositor_private();
        if (!actor) return;
        this._updateMaskBounds(win, actor, effect, effect._radius);
        const target = this._unwrapMaskActor(actor, win);
        if (target) {
            try { target.invalidate_paint_volume(); } catch (_e) {}
        }
        try { actor.invalidate_paint_volume(); } catch (_e) {}
        try { global.stage.queue_redraw(); } catch (_e) {}
    }

    _updateMaskBounds(win, actor, effect, radius) {
        const buffer = win.get_buffer_rect();
        const frame = win.get_frame_rect();
        const offsetX = frame.x - buffer.x;
        const offsetY = frame.y - buffer.y;
        const bw = frame.width - buffer.width;
        const bh = frame.height - buffer.height;
        const x1 = offsetX + 1;
        const y1 = offsetY + 1;
        const x2 = offsetX + actor.width + bw;
        const y2 = offsetY + actor.height + bh;

        if (!this._settings) {
            effect.updateMask(x1, y1, x2, y2, radius, 0, [0.5, 0.5, 0.5, 1], [0.5, 0.5, 0.5, 1], 0, 0);
            return;
        }

        const isFocused = win === global.display.focus_window;
        const widthKey = isFocused ? 'active-border-width' : 'inactive-border-width';
        const color1Key = isFocused ? 'active-border-color' : 'inactive-border-color';
        const color2Key = isFocused ? 'active-border-color-2' : 'inactive-border-color-2';
        const borderWidth = (this._grabWindow === win)
            ? 0
            : (this._settings.get_boolean('borders-enabled')
                ? this._settings.get_int(widthKey)
                : 0);
        const toRgba = (hex) => {
            const c = this._hexToRgb(hex);
            return [c.r, c.g, c.b, 1];
        };
        const color1Hex = (this._settings.get_strv(color1Key) || [])[0] || '#3584e4';
        const color2Hex = (this._settings.get_strv(color2Key) || [])[0] || color1Hex;
        const color1 = toRgba(color1Hex);
        const color2 = toRgba(color2Hex);

        let mode = 0;
        let theta = 0;
        const speed = this._settings.get_int('border-animation-speed');
        const period = this._borderRotationMs(speed);
        if (period > 0 && this._settings.get_boolean('gradient-borders')) {
            mode = 3;
            const stSettings = St.Settings.get();
            const slow = Math.max(0.1, stSettings.slow_down_factor);
            theta = (((Date.now() / period) * slow) % 1) * Math.PI * 2;
        } else {
            const dir = this._settings.get_string('gradient-direction');
            if (dir === 'horizontal')
                mode = 1;
            else if (dir === 'diagonal')
                mode = 2;
        }

        const blurEnabled = this._settings.get_boolean('window-blur');
        const opacity = blurEnabled
            ? this._settings.get_int('window-blur-opacity') / 100
            : 1;

        effect.updateMask(x1, y1, x2, y2, radius, borderWidth, color1, color2, mode, theta, opacity);
    }

    _teardownMaskEffect(win, effect) {
        if (effect._refreshTimeoutId) {
            try { GLib.source_remove(effect._refreshTimeoutId); } catch (_e) {}
            effect._refreshTimeoutId = 0;
        }
        effect._metaWin = null;
        if (effect._sizeWatchId) {
            try { effect._watchActor.disconnect(effect._sizeWatchId); } catch (_e) {}
            effect._sizeWatchId = 0;
        }
        if (effect._textureWatchId) {
            try { effect._watchTexture.disconnect(effect._textureWatchId); } catch (_e) {}
            effect._textureWatchId = 0;
        }
        effect._watchActor = null;
        effect._watchTexture = null;
        const actor = win.get_compositor_private();
        const target = this._unwrapMaskActor(actor, win);
        if (target && target.remove_effect_by_name) {
            try { target.remove_effect_by_name(MASK_EFFECT_NAME); } catch (_e) {}
        }
    }

    _removeMask(win) {
        if (!this._windowMasks) return;
        const effect = this._windowMasks.get(win);
        if (!effect) return;
        this._teardownMaskEffect(win, effect);
        this._windowMasks.delete(win);
    }
    async _ensureBlurModule() {
        if (this._blurModulePromise) return this._blurModulePromise;
        this._blurModule = null;
        this._blurModulePromise = (async () => {
            const [libPath] = GLib.filename_from_uri(import.meta.url);
            const libDir = GLib.path_get_dirname(libPath) + '/lib';
            try {
                const Repo = imports.gi.GIRepository;
                const repo = Repo.Repository.dup_default();
                this._debugLog(`blur lib dir=${libDir}`);
                repo.prepend_search_path(libDir);
                repo.prepend_library_path(libDir);
            } catch (e) {
                log(`[plaid] blur lib paths failed: ${e.message}`);
            }

            const tryImport = async (label, fn) => {
                try {
                    const mod = await fn();
                    this._blurModule = mod;
                    this._debugLog(`using bundled gnome-rounded-blur (${label})`);
                    return true;
                } catch (e) {
                    this._debugLog(`blur import (${label}) failed: ${e.message}`);
                    return false;
                }
            };
            let ok = await tryImport('legacy', () => imports.gi.Blur);
            if (!ok)
                ok = await tryImport('esm', () => import('gi://Blur'));

            if (!ok) {
                const typelibEnv = GLib.getenv('GI_TYPELIB_PATH') || '';
                const libEnv = GLib.getenv('LD_LIBRARY_PATH') || '';
                if (!typelibEnv.includes(libDir) || !libEnv.includes(libDir)) {
                    try {
                        const confDir = GLib.get_home_dir() + '/.config/environment.d';
                        const confFile = confDir + '/plaid-blur.conf';
                        if (!GLib.file_test(confFile, GLib.FileTest.EXISTS)) {
                            GLib.mkdir_with_parents(confDir, 0o755);
                            const content =
                                `GI_TYPELIB_PATH=${libDir}\n` +
                                `LD_LIBRARY_PATH=${libDir}\n`;
                            GLib.file_set_contents(confFile, content);
                            this._debugLog('blur library provisioned - relogin to activate');
                        }
                    } catch (e) {
                        log(`[plaid] blur provision failed: ${e.message}`);
                    }
                }
                this._blurModule = null;
                this._debugLog('bundled blur unavailable, using Shell.BlurEffect');
            }
            if (!this._destroyed)
                this._updateBorders();
            return this._blurModule;
        })();
        return this._blurModulePromise;
    }

    _ensureWindowBlur(win, actor) {
        if (!this._windowBlurs || !actor || !actor.add_effect_with_name) return;
        if (!this._settings || !this._settings.get_boolean('window-blur')) return;

        let blur = this._windowBlurs.get(win);

        if (blur) {
            let hostAlive;
            if (blur._sibling)
                hostAlive = blur._sibling.get_parent() !== null && blur.get_actor() === blur._sibling;
            else
                hostAlive = blur.get_actor() !== null;
            if (!hostAlive) {
                try {
                    const currentActor = blur.get_actor();
                    if (currentActor && currentActor.remove_effect_by_name)
                        currentActor.remove_effect_by_name(BLUR_EFFECT_NAME);
                    if (blur._sibling) {
                        this._unbindBlurSibling(blur);
                        try { blur._sibling.destroy(); } catch (_e) {}
                        blur._sibling = null;
                    }
                    this._windowBlurs.delete(win);
                    blur = null;
                    this._debugLog('blur self-heal: host dead, recreating');
                } catch (e) {
                    log(`[plaid] window blur heal failed: ${e.message}`);
                    return;
                }
            }
        }

        if (!blur) {
            if (actor.get_parent() !== global.window_group) {
                this._debugLog('blur defer: window mid-transition, next pass will create');
                return;
            }
            try {
                const effectClass = this._blurModule ? this._blurModule.BlurEffect : Shell.BlurEffect;
                blur = new effectClass();
                blur._bindings = [];
                const sibling = new St.Widget({
                    reactive: false,
                    visible: true,
                });
                for (let i = 0; i < 4; i++) {
                    sibling.add_constraint(new Clutter.BindConstraint({
                        source: actor,
                        coordinate: i,
                        offset: 0,
                    }));
                }
                for (const prop of ['pivot-point', 'translation-x', 'translation-y', 'scale-x', 'scale-y', 'visible']) {
                    try {
                        blur._bindings.push(actor.bind_property(
                            prop, sibling, prop, GObject.BindingFlags.SYNC_CREATE
                        ));
                    } catch (_e) {}
                }
                global.window_group.insert_child_below(sibling, actor);
                sibling.add_effect_with_name(BLUR_EFFECT_NAME, blur);
                blur._sibling = sibling;
                blur._sourceActor = actor;
                this._windowBlurs.set(win, blur);
                try {
                    blur._actorDestroyId = actor.connect('destroy', () => this._removeBlur(win));
                } catch (_e) {}
                try {
                    blur._actorParentSetId = actor.connect('parent-set',
                        () => this._syncBlurStacking());
                } catch (_e) {}
                try {
                    const frame = win.get_frame_rect();
                    const buffer = win.get_buffer_rect();
                    this._debugLog(`blur sibling created frame=(${frame.x},${frame.y},${frame.width},${frame.height}) buffer=(${buffer.x},${buffer.y},${buffer.width},${buffer.height})`);
                } catch (_e) {}
            } catch (e) {
                log(`[plaid] window blur attach failed: ${e.message}`);
                return;
            }
        }

        if (blur._sibling) {
            try {
                const buffer = win.get_buffer_rect();
                const frame = win.get_frame_rect();
                const offsets = [
                    frame.x - buffer.x,
                    frame.y - buffer.y,
                    frame.width - buffer.width,
                    frame.height - buffer.height,
                ];
                const constraints = blur._sibling.get_constraints();
                constraints.forEach((c, i) => {
                    if (c instanceof Clutter.BindConstraint)
                        c.offset = offsets[i];
                });
            } catch (_e) {}
        }

        try {
            const siblingAlive = blur._sibling ? (blur._sibling.get_parent() ? 'yes' : 'no') : 'n/a';
            const actorMatch = blur.get_actor() === blur._sibling ? 'yes' : 'no';
            this._debugLog(`blur state siblingParent=${siblingAlive} actorMatch=${actorMatch}`);
        } catch (_e) {}

        try {
            const blurMode = this._blurModule ? this._blurModule.BlurMode.BACKGROUND : Shell.BlurMode.BACKGROUND;
            if (blur.mode !== blurMode)
                blur.mode = blurMode;
            if (this._blurModule && blur.corner_radius !== undefined) {
                const cr = this._settings.get_int('border-radius') + 1;
                if (blur.corner_radius !== cr)
                    blur.corner_radius = cr;
            }
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const radius = Math.round(this._settings.get_int('window-blur-radius') * scale);
            if (blur.radius !== radius)
                blur.radius = radius;
            const brightness = this._settings.get_double('window-blur-brightness');
            if (blur.brightness !== brightness)
                blur.brightness = brightness;
        } catch (e) {
            log(`[plaid] window blur update failed: ${e.message}`);
        }
    }

    _unbindBlurSibling(blur) {
        if (blur._bindings) {
            for (const binding of blur._bindings) {
                try { binding.unbind(); } catch (_e) {}
            }
            blur._bindings = [];
        }
    }

    _syncBlurStacking() {
        if (!this._windowBlurs) return;
        const monitors = global.display.get_n_monitors();
        let monitorW = 0, monitorH = 0;
        for (let i = 0; i < monitors; i++) {
            const geom = global.display.get_monitor_geometry(i);
            monitorW = Math.max(monitorW, geom.x + geom.width);
            monitorH = Math.max(monitorH, geom.y + geom.height);
        }
        for (const [win, blur] of this._windowBlurs.entries()) {
            const sibling = blur._sibling;
            const source = blur._sourceActor;
            if (!sibling || !source) continue;
            if (sibling.get_parent() !== global.window_group ||
                source.get_parent() !== global.window_group) continue;
            try {
                const sW = sibling.get_width();
                const sH = sibling.get_height();
                const aW = source.get_width();
                const aH = source.get_height();
                const mismatched = sW > monitorW + 64 || sH > monitorH + 64 ||
                    Math.abs(sW - aW) > aW * 0.15 + 64 ||
                    Math.abs(sH - aH) > aH * 0.15 + 64;
                if (mismatched) {
                    this._removeBlur(win);
                    this._ensureWindowBlur(win, win.get_compositor_private() || source);
                } else {
                    global.window_group.set_child_below_sibling(sibling, source);
                }
            } catch (_e) {}
        }
    }

    _removeBlur(win) {
        if (!this._windowBlurs) return;
        const blur = this._windowBlurs.get(win);
        if (!blur) return;
        if (blur._actorDestroyId) {
            const a = win.get_compositor_private();
            if (a) {
                try { a.disconnect(blur._actorDestroyId); } catch (_e) {}
            }
            blur._actorDestroyId = 0;
        }
        if (blur._actorParentSetId) {
            const a = win.get_compositor_private();
            if (a) {
                try { a.disconnect(blur._actorParentSetId); } catch (_e) {}
            }
            blur._actorParentSetId = 0;
        }
        if (blur._sibling) {
            this._unbindBlurSibling(blur);
            try { blur._sibling.destroy(); } catch (_e) {}
            blur._sibling = null;
        }
        const actor = win.get_compositor_private();
        const target = this._unwrapMaskActor(actor, win);
        if (target && target.remove_effect_by_name) {
            try { target.remove_effect_by_name(BLUR_EFFECT_NAME); } catch (_e) {}
        }
        this._windowBlurs.delete(win);
    }

    _removeAllBlurs() {
        if (!this._windowBlurs) return;
        for (const win of [...this._windowBlurs.keys()])
            this._removeBlur(win);
    }

    _removeAllMasks() {
        if (!this._windowMasks) return;
        for (const win of [...this._windowMasks.keys()])
            this._removeMask(win);
    }

    _purgeOrphanBlurs() {
        if (!this._windowBlurs) return;
        const tracked = new Set();
        for (const blur of this._windowBlurs.values())
            if (blur._sibling) tracked.add(blur._sibling);
        for (const child of global.window_group.get_children()) {
            if (!child || !child.get_effect || child.get_effect(BLUR_EFFECT_NAME) === null) continue;
            if (!tracked.has(child)) {
                try { child.destroy(); } catch (_e) {}
            }
        }
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

    // --- Keybindings ---

    _registerKeybindings() {
        const bindings = [
            { key: 'move-focus-left', fn: () => this._moveFocus('left') },
            { key: 'move-focus-right', fn: () => this._moveFocus('right') },
            { key: 'move-focus-up', fn: () => this._moveFocus('up') },
            { key: 'move-focus-down', fn: () => this._moveFocus('down') },
            { key: 'swap-left', fn: () => this._swapWindow('left') },
            { key: 'swap-right', fn: () => this._swapWindow('right') },
            { key: 'swap-up', fn: () => this._swapWindow('up') },
            { key: 'swap-down', fn: () => this._swapWindow('down') },
            { key: 'resize-shrink-width', fn: () => this._resizeWindow('shrink', 'width') },
            { key: 'resize-grow-width', fn: () => this._resizeWindow('grow', 'width') },
            { key: 'resize-shrink-height', fn: () => this._resizeWindow('shrink', 'height') },
            { key: 'resize-grow-height', fn: () => this._resizeWindow('grow', 'height') },
            { key: 'toggle-float', fn: () => this._toggleFloat() },
            { key: 'toggle-tiling', fn: () => this._toggleTiling() },
            { key: 'center-window', fn: () => this._centerWindow() },
            { key: 'pick-float-window', fn: () => this._handlePickFloat() },
            { key: 'cycle-layout', fn: () => this._cycleLayout() },
            { key: 'scratchpad-toggle', fn: () => this._scratchpadToggle() },
            { key: 'scratchpad-add', fn: () => this._scratchpadAdd() },
            { key: 'scratchpad-remove', fn: () => this._scratchpadRemove() },
            { key: 'dropdown-terminal', fn: () => this._toggleDropdownTerminal() },
        ];

        for (const { key, fn } of bindings) {
            Main.wm.addKeybinding(
                key,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL,
                fn
            );
        }
    }

    _removeKeybindings() {
        const keys = [
            'move-focus-left', 'move-focus-right', 'move-focus-up', 'move-focus-down',
            'swap-left', 'swap-right', 'swap-up', 'swap-down',
            'resize-shrink-width', 'resize-grow-width', 'resize-shrink-height', 'resize-grow-height',
            'toggle-float', 'toggle-tiling', 'center-window', 'pick-float-window',
            'cycle-layout', 'scratchpad-toggle', 'scratchpad-add', 'scratchpad-remove',
            'dropdown-terminal',
        ];
        for (const key of keys) {
            Main.wm.removeKeybinding(key);
        }
    }

    _getActiveWindow() {
        return global.display.focus_window;
    }

    _findDirectionalTarget(win, direction, windows) {
        const f = win.get_frame_rect();
        let best = null;
        let bestOverlap = -1;
        let bestDist = Infinity;
        let bestPerp = Infinity;
        let bestHeight = -1;

        for (const w of windows) {
            if (w === win) continue;
            const r = w.get_frame_rect();
            if (r.width === 0 || r.height === 0) continue;

            let overlap, dist, perp;
            switch (direction) {
                case 'left':
                    if (r.x + r.width > f.x) continue;
                    overlap = Math.min(f.y + f.height, r.y + r.height) - Math.max(f.y, r.y);
                    dist = f.x - (r.x + r.width);
                    perp = Math.abs((f.y + f.height / 2) - (r.y + r.height / 2));
                    break;
                case 'right':
                    if (r.x < f.x + f.width) continue;
                    overlap = Math.min(f.y + f.height, r.y + r.height) - Math.max(f.y, r.y);
                    dist = r.x - (f.x + f.width);
                    perp = Math.abs((f.y + f.height / 2) - (r.y + r.height / 2));
                    break;
                case 'up':
                    if (r.y + r.height > f.y) continue;
                    overlap = Math.min(f.x + f.width, r.x + r.width) - Math.max(f.x, r.x);
                    dist = f.y - (r.y + r.height);
                    perp = Math.abs((f.x + f.width / 2) - (r.x + r.width / 2));
                    break;
                case 'down':
                    if (r.y < f.y + f.height) continue;
                    overlap = Math.min(f.x + f.width, r.x + r.width) - Math.max(f.x, r.x);
                    dist = r.y - (f.y + f.height);
                    perp = Math.abs((f.x + f.width / 2) - (r.x + r.width / 2));
                    break;
                default:
                    return null;
            }
            if (overlap <= 0) continue;

            const sameHeight = Math.abs(r.height - bestHeight) <= 5;
            const overlapTie = Math.abs(overlap - bestOverlap) <= 5;
            const distTie = Math.abs(dist - bestDist) <= 5;
            if (overlap > bestOverlap + 5 ||
                (overlapTie && dist < bestDist - 5) ||
                (overlapTie && distTie &&
                 ((!sameHeight && r.height > bestHeight) ||
                  (sameHeight && perp < bestPerp)))) {
                bestOverlap = overlap;
                bestDist = dist;
                bestPerp = perp;
                bestHeight = r.height;
                best = w;
            }
        }
        return best;
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
            if ((path[i].direction === 'h') === targetIsHorizontal) {
                const monitor = global.display.get_primary_monitor();
                const workArea = workspace.get_work_area_for_monitor(monitor);
                if (!workArea) return;
                const axisSize = targetIsHorizontal ? workArea.width : workArea.height;
                path[i].ratio = Math.max(0.15, Math.min(0.85, path[i].ratio + delta / axisSize));
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
            if (this._settings.get_boolean('tiling-popup'))
                this._showPopup('Tiling Enabled');
        } else {
            this._removeAllBorders();
            this._restoreSavedPositions();
            if (this._settings.get_boolean('tiling-popup'))
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
        const layouts = ['dwindle', 'master-stack', 'centered-master-stack'];
        const ws = global.workspace_manager.get_active_workspace();
        if (!ws) return;
        const current = this._getWorkspaceLayout(ws);
        const idx = layouts.indexOf(current);
        const next = layouts[(idx + 1) % layouts.length];
        if (next !== current) {
            this._workspaceLayouts.set(ws, next);
            this._retileWorkspace(ws);
            this._showPopup(`Layout: ${LAYOUT_NAMES[next] || next}`);
        }
    }

    _showWorkspacePopup(ws) {
        if (!ws) return;
        const layout = this._getWorkspaceLayout(ws);
        this._showPopup(`Workspace ${this._bgAppRealToDisplay(this._wsIndex(ws)) + 1}`,
            `Layout: ${LAYOUT_NAMES[layout] || layout}`);
    }

    _showPopup(title, subtitle = null) {
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
            vertical: true,
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
            reactive: false,
        });
        this._layoutPopup = popup;
        popup.set_position(0, 0);
        popup.set_size(maxX, maxY);
        Main.layoutManager.uiGroup.add_child(popup);

        popup.opacity = 0;
        popup.ease({
            opacity: 255,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._layoutPopupHideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            this._layoutPopupHideId = 0;
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
                    'Another extension is also suppressing this popup — both manage this behavior. Adjust either one to change it.',
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
            vertical: true,
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
        if (hint) {
            box.add_child(new St.Label({
                text: hint,
                style: 'font-size: 12px; color: rgba(255, 255, 255, 0.5);',
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

    // --- Drop-Down Terminal ---

    _initDropdownTerminal() {
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

    _toggleDropdownTerminal() {
        const win = this._dropdownWin;
        if (win) {
            if (win.minimized) {
                this._showDropdownTerminal(win);
            } else {
                try { win.minimize(); } catch (_e) {}
            }
            return;
        }
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

    _handleDropdownWindowCreated(win) {
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
                try { win.disconnect(unmanagedId); } catch (_e) {}
                unmanagedId = 0;
            }
            for (const id of notifyIds) {
                try { win.disconnect(id); } catch (_e) {}
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

    _tryClaimDropdown(win) {
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
        this._removeMask(win);
        this._removeBlur(win);
        this._removeBorder(win);
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

    _clearDropdownWaiters() {
        for (const win of [...this._dropdownWaiters.keys()]) {
            try { win.skip_taskbar = false; } catch (_e) {}
            const cleanup = this._dropdownWaiters.get(win);
            try { cleanup(); } catch (_e) {}
        }
        this._dropdownWaiters.clear();
    }

    _configureDropdownTerminal(win) {
        try { win.skip_taskbar = true; } catch (_e) {}
        try { win.make_above(); } catch (_e) {}
    }

    _showDropdownTerminal(win) {
        try { win.unminimize(); } catch (_e) {}
        try { win.make_above(); } catch (_e) {}
        try {
            const ws = global.workspace_manager.get_active_workspace();
            if (ws && win.get_workspace() !== ws)
                win.change_workspace(ws);
        } catch (_e) {}
        this._positionDropdownTerminal(win);
        try { win.activate(this._currentTime()); } catch (_e) {}
        this._applyDropdownEffects(win);
    }

    _syncDropdownWorkspace() {
        const win = this._dropdownWin;
        if (!win) return;
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

    _dropdownRect() {
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

    _positionDropdownTerminal(win) {
        let retries = 0;
        const apply = () => {
            if (this._destroyed) return false;
            let rect = null;
            try { rect = this._dropdownRect(); } catch (_e) {}
            if (!rect) return false;
            const before = win.get_frame_rect();
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

    _dropdownMonitorIndex() {
        let idx = global.display.get_current_monitor();
        try {
            const focus = global.display.focus_window;
            if (focus && focus.get_monitor() >= 0) idx = focus.get_monitor();
        } catch (_e) {}
        return idx;
    }

    _clearDropdownWindow() {
        this._clearDropdownWaiters();
        const win = this._dropdownWin;
        if (!win) return;
        if (this._dropdownGeometryIds) {
            for (const id of this._dropdownGeometryIds) {
                try { win.disconnect(id); } catch (_e) {}
            }
            this._dropdownGeometryIds = null;
        }
        if (this._dropdownUnmanagedId) {
            try { win.disconnect(this._dropdownUnmanagedId); } catch (_e) {}
            this._dropdownUnmanagedId = 0;
        }
        this._removeBorder(win);
        this._removeMask(win);
        this._removeBlur(win);
        try { win.skip_taskbar = false; } catch (_e) {}
        try { win.unmake_above(); } catch (_e) {}
        this._dropdownWin = null;
    }

    // --- Background App ---

    _initBackgroundApp() {
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
        this._showBackgroundAppInitOverlay();
        this._scheduleBackgroundAppReservation();
        this._launchBackgroundApp();
    }

    _scheduleBackgroundAppReservation() {
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

    _reserveBackgroundAppWorkspace() {
        // BGAPP is integral to Plaid: the first real workspace (ws0 — the
        // user's perceived "workspace 1") is always reserved for it. No
        // reorder — the parking IS the front; hiding its card leaves the
        // overview row gapless. The user's content lives on real ws1+,
        // numbered 1..n via _bgAppRealToDisplay.
        if (this._destroyed || this._backgroundAppParkingWs) return;
        try {
            const first = global.workspace_manager.get_workspace_by_index(0);
            if (!first) return;
            if (first.list_windows().length > 0) {
                // Rare mid-session re-enable with content on ws0: fall back to
                // a trailing parking (no reorder, canonical n-2 position).
                const parking = global.workspace_manager.append_new_workspace(false, this._currentTime());
                this._backgroundAppParkingWs = parking;
                this._backgroundAppParkingFront = false;
                log(`[plaid] background app: reserved trailing parking (index=${this._wsIndex(parking)})`);
            } else {
                this._backgroundAppParkingWs = first;
                this._backgroundAppParkingFront = true;
                log('[plaid] background app: reserved ws0 parking (index=0)');
            }
            // Keep the parking alive: the shell's dynamic-workspace check
            // removes empty inactive workspaces — the reservation must be
            // armed before the append below queues that check.
            try {
                Main.wm.keepWorkspaceAlive(this._backgroundAppParkingWs, 12 * 60 * 60 * 1000);
            } catch (_e) {}
            this._startBackgroundAppKeepAlive();
            // Move the active off the parking onto the first content workspace.
            // append_new_workspace(true) activates BEFORE emitting
            // n-workspaces, so the shell's active-workspace-changed raise
            // would index a card that doesn't exist yet — append inert, then
            // activate after the shell has rebuilt its card list.
            try {
                if (global.workspace_manager.get_active_workspace() === this._backgroundAppParkingWs) {
                    global.workspace_manager.append_new_workspace(false, this._currentTime());
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                        if (this._destroyed) return GLib.SOURCE_REMOVE;
                        try {
                            const next = global.workspace_manager.get_workspace_by_index(1);
                            if (next) next.activate(this._currentTime());
                            log(`[plaid] background app: active moved to index=${global.workspace_manager.get_active_workspace_index()}`);
                        } catch (_e) {}
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    log(`[plaid] background app: active already at index=${global.workspace_manager.get_active_workspace_index()}`);
                }
            } catch (_e) {}
            this._applyBackgroundAppHiding();
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

    _hideParkingCard() {
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

    _startBackgroundAppKeepAlive() {
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

    _bgAppRealToDisplay(realIdx) {
        const parkingIdx = this._backgroundAppParkingWs ?
            this._wsIndex(this._backgroundAppParkingWs) : -1;
        return realIdx > parkingIdx ? realIdx - 1 : realIdx;
    }

    _scheduleBackgroundAppRestart() {
        if (this._destroyed) return;
        if (this._backgroundAppRestartId)
            GLib.source_remove(this._backgroundAppRestartId);
        this._backgroundAppRestartId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._backgroundAppRestartId = 0;
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            this._clearBackgroundApp();
            this._launchBackgroundApp();
            return GLib.SOURCE_REMOVE;
        });
    }

    _isDynamicWorkspaces() {
        try {
            if (!this._mutterSettings) return false;
            return this._mutterSettings.get_boolean('dynamic-workspaces');
        } catch (_e) {
            return false;
        }
    }

    _checkDynamicWorkspaces() {
        if (this._destroyed || this._dynamicWsWarned) return;
        if (this._isDynamicWorkspaces()) return;
        this._dynamicWsWarned = true;
        this._showWarningPopup('Dynamic Workspaces Required',
            "Plaid relies on GNOME's Dynamic Workspaces. Please enable it.",
            'Click to dismiss');
    }

    _showBackgroundAppInitOverlay() {
        // The Plaid login moment — always shown at enable (a brand moment,
        // minimum 3s), extended while the bg-app pipeline processes.
        if (this._backgroundAppInitOverlay) return;
        this._backgroundAppInitOverlayAwaiting =
            this._settings && this._settings.get_boolean('background-app-enabled') &&
            !!this._settings.get_string('background-app');
        this._backgroundAppInitOverlayMinTime = Date.now() + 3000;
        try {
            const stage = global.stage;
            const overlay = new St.BoxLayout({
                reactive: true,
                visible: true,
                vertical: true,
                x_expand: true,
                y_expand: true,
            });
            overlay.set_style('background-color: rgba(0, 0, 0, 1);');
            overlay.set_size(stage.width, stage.height);
            overlay.set_position(0, 0);
            const column = new St.BoxLayout({
                vertical: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const graphicSlot = new St.Widget({
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                width: 24,
                height: 24,
            });
            const wordmark = new St.Label({
                text: 'Plaid',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 64px; font-weight: bold; color: #ffffff;',
            });
            const subtitle = new St.Label({
                text: 'is initializing…',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 28px; color: #ffffff;',
            });
            column.add_child(graphicSlot);
            column.add_child(wordmark);
            column.add_child(subtitle);
            overlay.add_child(column);
            Main.uiGroup.add_child(overlay);
            this._backgroundAppInitOverlay = overlay;
            Main.pushModal(overlay);
            this._backgroundAppInitOverlayModal = true;
            this._backgroundAppInitOverlayCapId =
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
                    this._backgroundAppInitOverlayCapId = 0;
                    this._hideBackgroundAppInitOverlay();
                    return GLib.SOURCE_REMOVE;
                });
            this._backgroundAppInitOverlayMinId =
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
                    this._backgroundAppInitOverlayMinId = 0;
                    // No bg-app pipeline? The moment ends at the 3s mark.
                    // Otherwise the ready signal gates the dismissal.
                    if (!this._backgroundAppInitOverlayAwaiting)
                        this._hideBackgroundAppInitOverlay();
                    return GLib.SOURCE_REMOVE;
                });
            log('[plaid] background app: init overlay shown (input blocked)');
        } catch (e) {
            this._backgroundAppInitOverlay = null;
            log(`[plaid] background app: init overlay failed: ${e.message}`);
        }
    }

    _requestBackgroundAppInitDismiss() {
        if (!this._backgroundAppInitOverlay) return;
        if (this._backgroundAppInitOverlayPendingDismissId) return;
        const remaining = this._backgroundAppInitOverlayMinTime - Date.now();
        if (remaining <= 0) {
            this._hideBackgroundAppInitOverlay();
        } else {
            this._backgroundAppInitOverlayPendingDismissId =
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, remaining, () => {
                    this._backgroundAppInitOverlayPendingDismissId = 0;
                    this._hideBackgroundAppInitOverlay();
                    return GLib.SOURCE_REMOVE;
                });
        }
    }

    _hideBackgroundAppInitOverlay() {
        const overlay = this._backgroundAppInitOverlay;
        this._backgroundAppInitOverlay = null;
        this._backgroundAppInitOverlayAwaiting = false;
        if (this._backgroundAppInitOverlayCapId) {
            GLib.source_remove(this._backgroundAppInitOverlayCapId);
            this._backgroundAppInitOverlayCapId = 0;
        }
        if (this._backgroundAppInitOverlayMinId) {
            GLib.source_remove(this._backgroundAppInitOverlayMinId);
            this._backgroundAppInitOverlayMinId = 0;
        }
        if (this._backgroundAppInitOverlayPendingDismissId) {
            GLib.source_remove(this._backgroundAppInitOverlayPendingDismissId);
            this._backgroundAppInitOverlayPendingDismissId = 0;
        }
        if (this._backgroundAppInitOverlayModal) {
            try { Main.popModal(overlay); } catch (_e) {}
            this._backgroundAppInitOverlayModal = false;
        }
        if (overlay) {
            try { overlay.destroy(); } catch (_e) {}
        }
        log('[plaid] background app: init overlay dismissed');
    }

    _launchBackgroundApp() {
        if (this._destroyed || !this._settings) return;
        if (!this._settings.get_boolean('background-app-enabled')) return;
        const command = this._settings.get_string('background-app');
        if (!command) return;
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
            this._requestBackgroundAppInitDismiss();
            if (this._backgroundAppWaiter) {
                try { this._backgroundAppWaiter.cleanup(false); } catch (_e) {}
            }
            return GLib.SOURCE_REMOVE;
        });
        // After a toggle/restart the reservation was cleared — reserve first so
        // the park never races a missing parking workspace.
        if (!this._backgroundAppParkingWs)
            this._scheduleBackgroundAppReservation();
        this._debugLog(`background app: launching ${command}`);
        try {
            this._backgroundAppProc = Gio.Subprocess.new(
                ['/bin/sh', '-c', `env PLAID_BGAPP=1 ${command}`],
                Gio.SubprocessFlags.NONE);
        } catch (e) {
            this._backgroundAppPending = false;
            this._backgroundAppProc = null;
            this._debugLog(`background app: spawn failed: ${e.message}`);
        }
    }

    _matchesBackgroundApp(win) {
        return this._isMarkerProcess(win, 'PLAID_BGAPP=1',
            this._settings.get_string('background-app') || '');
    }

    _isMarkerProcess(win, marker, command) {
        if (!win) return false;
        let pid = 0;
        try { pid = win.get_pid(); } catch (_e) {}
        if (pid > 0 && this._procEnvironHasMarker(pid, marker)) return true;
        if (pid > 0 && this._markerPidSetHas(marker, pid)) return true;
        return this._commandTokenMatches(win, command);
    }

    _procEnvironHasMarker(pid, marker) {
        try {
            const [, data] = GLib.file_get_contents(`/proc/${pid}/environ`);
            if (!data) return false;
            return new TextDecoder().decode(data).split('\0').includes(marker);
        } catch (_e) {
            return false;
        }
    }

    _markerPidSetHas(marker, pid) {
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

    _commandTokenMatches(win, command) {
        if (!command) return false;
        const instance = (win.get_wm_class_instance() || '').toLowerCase();
        const cls = (win.get_wm_class() || '').toLowerCase();
        if (!instance && !cls) return false;
        for (const raw of command.trim().split(/\s+/)) {
            if (!raw || raw.startsWith('-')) continue;
            let token = raw;
            const slash = token.lastIndexOf('/');
            if (slash >= 0) token = token.slice(slash + 1);
            token = token.toLowerCase();
            if (!token || token.length < 2) continue;
            if (instance.includes(token) || cls.includes(token)) return true;
        }
        return false;
    }

    _handleBackgroundAppWindowCreated(win) {
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

    _tryClaimBackgroundApp(win) {
        if (!this._backgroundAppPending || !win) return false;
        if (!this._matchesBackgroundApp(win)) {
            const instance = (win.get_wm_class_instance() || '').toLowerCase();
            const cls = (win.get_wm_class() || '').toLowerCase();
            this._debugLog(`background app: identity not yet matching (instance=${instance} class=${cls})`);
            return false;
        }
        if (this._backgroundAppPendingId) {
            GLib.source_remove(this._backgroundAppPendingId);
            this._backgroundAppPendingId = 0;
        }
        this._backgroundAppPending = false;
        if (this._windowWorkspaces.has(win)) {
            this._debugLog('background app: de-registering window from tiler');
            this._removeWindow(win);
        }
        this._removeMask(win);
        this._removeBlur(win);
        this._removeBorder(win);
        this._backgroundAppWin = win;
        this._backgroundAppUnmanagedId = win.connect('unmanaged', () => {
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

    _configureBackgroundApp(win) {
        try { win.skip_taskbar = true; } catch (_e) {}
        try { win.skip_pager = true; } catch (_e) {}
        try { win.unstick(); } catch (_e) {}
        try { win.unmake_above(); } catch (_e) {}
        // Clone path: park the window on the reserved parking workspace and
        // show a full-bleed clone in the background group — input-free by
        // construction, smooth (the parked window is never animated).
        this._debugLog('background app: clone mode (parked window + background clone)');
        const deferredPark = () => {
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            log('[plaid] background app: deferred park firing');
            if (win !== this._backgroundAppWin) {
                log('[plaid] background app: deferred park skipped (window no longer the bg app)');
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
            // Late re-raise: at login the shell's wallpaper actors settle
            // after the clone is created and can land above it in the
            // background group — re-insert on top once the startup is done.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
                if (this._destroyed) return GLib.SOURCE_REMOVE;
                this._raiseBackgroundAppClone();
                log('[plaid] background app: clone re-raised after startup settle');
                return GLib.SOURCE_REMOVE;
            });
            this._requestBackgroundAppInitDismiss();
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
                    log('[plaid] background app: first-frame fired, scheduling park in 3s');
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

    _startBackgroundAppParkWatch(win) {
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

    _disconnectBackgroundAppParkWatch() {
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

    _parkBackgroundAppOnWorkspace(win) {
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
            log('[plaid] background app: park deferred (no parking ws yet, scheduling reservation)');
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
        log(`[plaid] background app: parked ws=${beforeIdx}->${targetIdx} frame=(${f.x},${f.y},${f.width},${f.height})`);
    }

    _applyBackgroundAppHiding() {
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
        MonitorWorkspaceSwitcherPopup.prototype.redisplay = wrappedRedisplay;
        WorkspaceThumbnailModule.ThumbnailsBox.prototype.addThumbnails = wrappedAddThumbnails;
        this._backgroundAppHiding = {
            origGetNeighbor, wrappedGetNeighbor,
            origRedisplay, wrappedRedisplay,
            origAddThumbnails, wrappedAddThumbnails,
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

    _restoreBackgroundAppHiding() {
        const h = this._backgroundAppHiding;
        if (!h) return;
        try {
            if (Meta.Workspace.prototype.get_neighbor === h.wrappedGetNeighbor)
                Meta.Workspace.prototype.get_neighbor = h.origGetNeighbor;
            if (MonitorWorkspaceSwitcherPopup.prototype.redisplay === h.wrappedRedisplay)
                MonitorWorkspaceSwitcherPopup.prototype.redisplay = h.origRedisplay;
            if (WorkspaceThumbnailModule.ThumbnailsBox.prototype.addThumbnails === h.wrappedAddThumbnails)
                WorkspaceThumbnailModule.ThumbnailsBox.prototype.addThumbnails = h.origAddThumbnails;
        } catch (_e) {}
        this._backgroundAppHiding = null;
    }

    _raiseBackgroundAppClone() {
        const clone = this._backgroundAppClone;
        if (!clone) return;
        const bg = Main.layoutManager._backgroundGroup;
        if (!bg) return;
        try {
            if (clone.get_parent() === bg)
                bg.set_child_above_sibling(clone, null);
        } catch (_e) {}
    }

    _scheduleBackgroundAppParkingFix() {
        if (this._destroyed || !this._backgroundAppWin) return;
        if (this._backgroundAppParkingFixId) return;
        this._backgroundAppParkingFixId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._backgroundAppParkingFixId = 0;
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            this._reassertBackgroundAppParking();
            return GLib.SOURCE_REMOVE;
        });
    }

    _reassertBackgroundAppParking() {
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
            log(`[plaid] background app: parking relocated to ws=${this._wsIndex(this._backgroundAppParkingWs)}`);
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

    _ensureBackgroundAppClone(win) {
        if (!win) return;
        if (!this._backgroundAppClone) {
            const actor = win.get_compositor_private();
            if (!actor) {
                log('[plaid] background app: clone skipped (no compositor actor)');
                return;
            }
            const bg = Main.layoutManager._backgroundGroup;
            if (!bg) {
                log('[plaid] background app: clone skipped (no background group)');
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
                log('[plaid] background app: clone created');
            } catch (e) {
                log(`[plaid] background app clone failed: ${e.message}`);
                this._backgroundAppClone = null;
                return;
            }
        }
        this._positionBackgroundAppClone();
    }

    _positionBackgroundAppClone() {
        const clone = this._backgroundAppClone;
        if (!clone) {
            log('[plaid] background app: clone position skipped (no clone)');
            return;
        }
        const monitor = global.display.get_primary_monitor();
        const mon = global.display.get_monitor_geometry(monitor);
        if (!mon || mon.width === 0) {
            log('[plaid] background app: clone position skipped (monitor geometry unavailable)');
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
            log(`[plaid] background app: clone at (${mon.x},${mon.y},${mon.width},${mon.height}) ` +
                `source=${src ? `${Math.round(src.width)}x${Math.round(src.height)}` : 'none'}`);
        } catch (e) {
            log(`[plaid] background app: clone position failed: ${e.message}`);
        }
    }

    _refillBackgroundApp() {
        if (!this._backgroundAppWin) return;
        this._parkBackgroundAppOnWorkspace(this._backgroundAppWin);
        this._positionBackgroundAppClone();
    }

    _restoreFocusFromBackgroundApp() {
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

    _clearBackgroundApp() {
        if (this._backgroundAppRestartId) {
            GLib.source_remove(this._backgroundAppRestartId);
            this._backgroundAppRestartId = 0;
        }
        if (this._backgroundAppPendingId) {
            GLib.source_remove(this._backgroundAppPendingId);
            this._backgroundAppPendingId = 0;
        }
        this._backgroundAppPending = false;
        this._hideBackgroundAppInitOverlay();
        this._disconnectBackgroundAppParkWatch();
        if (this._backgroundAppNWorkspacesId) {
            try { global.workspace_manager.disconnect(this._backgroundAppNWorkspacesId); } catch (_e) {}
        this._backgroundAppNWorkspacesId = 0;
        if (this._backgroundAppParkRetryId) {
            GLib.source_remove(this._backgroundAppParkRetryId);
            this._backgroundAppParkRetryId = 0;
        }
        this._backgroundAppParkRetryCount = 0;
        this._backgroundAppInitOverlay = null;
        this._backgroundAppInitOverlayModal = false;
        this._backgroundAppInitOverlayCapId = 0;
        this._backgroundAppInitOverlayMinId = 0;
        this._backgroundAppInitOverlayPendingDismissId = 0;
        this._backgroundAppInitOverlayMinTime = 0;
        this._backgroundAppInitOverlayAwaiting = false;
        this._backgroundAppParkRetryId = 0;
        this._backgroundAppParkRetryCount = 0;
        }
        if (this._backgroundAppKeepAliveId) {
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
            this._closeBackgroundAppWindow(waiter.win);
        }
        const win = this._backgroundAppWin;
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
        if (win)
            this._closeBackgroundAppWindow(win);
        this._backgroundAppWin = null;
        this._backgroundAppProc = null;
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
        this._backgroundAppParkingWs = null;
        this._backgroundAppParkingFront = false;
    }

    _closeBackgroundAppWindow(win) {
        if (!win) return;
        try { win.delete(this._currentTime()); } catch (_e) {}
        const proc = this._backgroundAppProc;
        if (proc) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                try { proc.force_exit(); } catch (_e) {}
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // --- Scratchpad ---

    _scratchpadAdd() {
        const win = this._getActiveWindow();
        if (!win || this._scratchpadWindows.has(win)) return;
        const ws = win.get_workspace();
        if (!ws) return;
        try {
            const frame = win.get_frame_rect();
            this._scratchpadWindows.set(win, {
                workspace: ws,
                x: frame.x, y: frame.y, w: frame.width, h: frame.height,
            });
            this._toggleFloatWindows.add(win);
            try { win.minimize(); } catch (_e) {
                try { win.minimized = true; } catch (_e2) {}
            }
            this._scratchpadVisible = false;
            this._retileWorkspace(ws);
            this._showPopup('Added to Scratchpad');
        } catch (_e) {}
    }

    _scratchpadToggle() {
        if (!this._scratchpadWindows || this._scratchpadWindows.size === 0) return;
        if (this._scratchpadVisible) {
            for (const win of this._scratchpadWindows.keys()) {
                try {
                    if (!win.get_compositor_private()) continue;
                    try { win.minimize(); } catch (_e) {
                        try { win.minimized = true; } catch (_e2) {}
                    }
                } catch (_e) {}
            }
            this._scratchpadVisible = false;
            this._showPopup('Scratchpad Hidden');
        } else {
            const activeWs = global.workspace_manager.get_active_workspace();
            if (!activeWs) return;
            const monitor = global.display.get_primary_monitor();
            const workArea = activeWs.get_work_area_for_monitor(monitor);
            let firstWin = null;
            for (const win of this._scratchpadWindows.keys()) {
                try {
                    if (!win.get_compositor_private() || win.is_fullscreen()) continue;
                    if (win.get_workspace() !== activeWs) {
                        try { win.change_workspace(activeWs); } catch (_e) {}
                    }
                    try { win.unminimize(); } catch (_e) {
                        try { win.minimized = false; } catch (_e2) {}
                    }
                    try { win.raise(); } catch (_e) {}
                    if (workArea) {
                        const frame = win.get_frame_rect();
                        if (frame.width > 0 && frame.height > 0) {
                            win.move_resize_frame(true,
                                workArea.x + Math.floor((workArea.width - frame.width) / 2),
                                workArea.y + Math.floor((workArea.height - frame.height) / 2),
                                frame.width, frame.height);
                        }
                    }
                    if (!firstWin) firstWin = win;
                } catch (_e) {}
            }
            this._scratchpadVisible = true;
            if (firstWin) {
                try { firstWin.activate(this._currentTime()); } catch (_e) {}
            }
            this._showPopup('Scratchpad Shown');
        }
    }

    _scratchpadRemove() {
        const win = this._getActiveWindow();
        if (!win) return;
        const saved = this._scratchpadWindows.get(win);
        if (!saved) return;
        this._scratchpadWindows.delete(win);
        this._toggleFloatWindows.delete(win);
        try {
            try { win.unminimize(); } catch (_e) {
                try { win.minimized = false; } catch (_e2) {}
            }
            if (saved.workspace && win.get_workspace() !== saved.workspace) {
                try { win.change_workspace(saved.workspace); } catch (_e) {}
            }
            win.move_resize_frame(true, saved.x, saved.y, saved.w, saved.h);
            this._retileWorkspace(saved.workspace);
            this._showPopup('Removed from Scratchpad');
        } catch (_e) {}
    }

    // --- Grab-Based Mouse Resize & Swap ---

    _connectGrabSignals() {
        this._addSignal(global.display, global.display.connect('grab-op-begin', (_d, metaWindow, grabOp) => {
            this._anyGrabOp = grabOp;
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
            this._anyGrabOp = null;
            this._handleGrabEnd(metaWindow, grabOp);
        }));
        this._addSignal(global.display, global.display.connect('restacked', () => {
            this._syncBlurStacking();
        }));
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

        if (this._isResizeGrab(grabOp)) {
            this._grabWindow = metaWindow;
            const effect = this._windowMasks?.get(metaWindow);
            if (effect)
                effect.setBorderWidth(0);
        }

        const wmClass = metaWindow.get_wm_class_instance() || '?';
        this._debugLog(`GRAB_BEGIN win=${wmClass} rect=${JSON.stringify(frame)} grabOp=${grabOp} isResize=${this._isResizeGrab(grabOp)} isMove=${this._isMoveGrab(grabOp)} float=${this._isFloating(metaWindow)}`);

        if (this._isResizeGrab(grabOp) && !this._isFloating(metaWindow)) {
            const [startX, startY] = global.get_pointer();
            this._grabStartX = startX;
            this._grabStartY = startY;
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
                    this._repositionWindow(metaWindow, ws);
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
    }

    _isResizeGrab(grabOp) {
        // GNOME 50: MetaGrabOp is bitfield-encoded.
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

                const gap = this._settings.get_int('gap');
                const monitor = global.display.get_primary_monitor();
                const workArea = ws.get_work_area_for_monitor(monitor);
                if (!workArea) return GLib.SOURCE_CONTINUE;

                const layout = this._getWorkspaceLayout(ws);
                if (layout === 'dwindle') {
                    const tree = this._bspGetTree(ws);
                    if (tree) {
                        const areaX = workArea.x + gap;
                        const areaY = workArea.y + gap;
                        const areaW = workArea.width - gap * 2;
                        const areaH = workArea.height - gap * 2;

                        if (this._grabResizeNodeW) {
                            const axis = this._grabResizeNodeW._w;
                            if (axis - gap > 0) {
                                const raw = this._grabInitialRatioW + (dx * this._grabWidthSign) / (axis - gap);
                                if (Number.isFinite(raw))
                                    this._grabResizeNodeW.ratio = Math.max(0.15, Math.min(0.85, raw));
                            }
                        }
                        if (this._grabResizeNodeH) {
                            const axis = this._grabResizeNodeH._h;
                            if (axis - gap > 0) {
                                const raw = this._grabInitialRatioH + (dy * this._grabHeightSign) / (axis - gap);
                                if (Number.isFinite(raw))
                                    this._grabResizeNodeH.ratio = Math.max(0.15, Math.min(0.85, raw));
                            }
                        }
                        this._bspTagGeometry(tree, areaX, areaY, areaW, areaH, gap);
                    }
                } else {
                    const areaW = workArea.width - gap * 2;
                    const areaH = workArea.height - gap * 2;

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
                            if (Number.isFinite(newRatio))
                                this._masterRatios.set(ws, Math.max(0.15, Math.min(0.85, newRatio)));
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
                                    newHeights.push(Math.max(10, initH + delta));
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
                                const newWeight = Math.max(0.1,
                                    initialWeight + (dy * this._grabHeightSign) / totalStackH * numStack);
                                const stackRatios = this._getStackRatios(ws);
                                stackRatios.set(idx - 1, newWeight);
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
        const gap = this._settings.get_int('gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return;

        const layout = this._getWorkspaceLayout(ws);
        if (layout === 'dwindle') {
            const tree = this._bspGetTree(ws);
            if (!tree) return;
            const treeWins = this._bspCollectWindows(tree);
            if (!treeWins.includes(skipWindow)) return;
            this._bspLayout(tree, workArea.x + gap, workArea.y + gap, workArea.width - gap * 2, workArea.height - gap * 2, gap, skipWindow);
        } else {
            const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
            if (tiled.length <= 1) return;
            if (layout === 'centered-master-stack')
                this._retileCenteredMasterStack(ws, tiled, skipWindow);
            else
                this._retileMasterStack(ws, tiled, skipWindow);
        }
    }

    _windowSlotRect(win, ws, layout, workArea, gap) {
        if (!workArea || workArea.width === 0 || workArea.height === 0) return null;
        const areaX = workArea.x + gap;
        const areaY = workArea.y + gap;
        const areaW = workArea.width - gap * 2;
        const areaH = workArea.height - gap * 2;
        if (areaW <= 0 || areaH <= 0) return null;

        if (layout === 'dwindle') {
            const tree = this._bspGetTree(ws);
            if (!tree) return null;
            const leaf = this._bspFindLeaf(tree, win);
            if (!leaf || leaf._w === undefined) return null;
            const r = { x: leaf._x, y: leaf._y, w: leaf._w, h: leaf._h };
            if (!(r.w > 0) || !(r.h > 0) || !Number.isFinite(r.x + r.y + r.w + r.h)) return null;
            return r;
        }

        const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
        const idx = tiled.indexOf(win);
        if (idx === -1) return null;
        if (tiled.length === 1) {
            const r = { x: areaX, y: areaY, w: areaW, h: areaH };
            return r;
        }

        const masterRatio = this._getMasterRatio(ws);
        const numStack = tiled.length - 1;
        const stackRatios = this._getStackRatios(ws);

        let masterX, masterW, stackX, stackW, stackIdx, colCount, colWeights;
        if (layout === 'centered-master-stack') {
            masterW = Math.floor((areaW - gap * 2) * masterRatio);
            masterX = areaX + Math.floor((areaW - masterW) / 2);
            if (idx === 0) {
                const r = { x: masterX, y: areaY, w: masterW, h: areaH };
                return r;
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
                return r;
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
                return r;
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
            const gap = this._settings.get_int('gap');
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

    _maybeReassertSlot(win) {
        if (this._destroyed || !this._settings) return;
        if (!this._settings.get_boolean('enabled')) return;
        if (this._grabOp || this._animating) return;
        if (!win || win.is_fullscreen() || win.minimized) return;
        if (this._isFloating(win)) return;
        if (!this._windowWorkspaces.has(win)) return;
        const ws = win.get_workspace();
        if (!ws) return;
        const gap = this._settings.get_int('gap');
        const monitor = global.display.get_primary_monitor();
        let workArea = null;
        try { workArea = ws.get_work_area_for_monitor(monitor); } catch (_e) {}
        if (!workArea || workArea.width === 0) return;
        const layout = this._getWorkspaceLayout(ws);
        const slot = this._windowSlotRect(win, ws, layout, workArea, gap);
        if (!slot) return;
        const f = win.get_frame_rect();
        if (f.width === 0 || f.height === 0) return;
        if (Math.abs(f.width - slot.w) > 16 || Math.abs(f.height - slot.h) > 16 ||
            Math.abs(f.x - slot.x) > 16 || Math.abs(f.y - slot.y) > 16) {
            this._debugLog(`slot re-assert: ${win.get_wm_class_instance() || '?'} frame=(${f.x},${f.y},${f.width},${f.height}) slot=(${slot.x},${slot.y},${slot.w},${slot.h})`);
            this._scheduleRetile(ws);
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
            const cls = win.get_wm_class_instance() || '';
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

        const cls = win.get_wm_class_instance() || '';
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

        const content = new St.BoxLayout({ vertical: true, style: 'spacing: 12px;' });

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
        const gap = this._settings.get_int('gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return;

        const areaX = workArea.x + gap;
        const areaY = workArea.y + gap;
        const areaW = workArea.width - gap * 2;
        const areaH = workArea.height - gap * 2;
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

        const gap = this._settings.get_int('gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return null;

        if (px < workArea.x || px > workArea.x + workArea.width ||
            py < workArea.y || py > workArea.y + workArea.height)
            return null;

        const ax = workArea.x + gap;
        const ay = workArea.y + gap;
        const aw = workArea.width - gap * 2;
        const ah = workArea.height - gap * 2;

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
        this._dropPreview.set_position(x, y);
        this._dropPreview.set_size(w, h);
    }

    _hideDropPreview() {
        if (this._dropPreview) {
            this._dropPreview.destroy();
            this._dropPreview = null;
        }
    }

    _repositionWindow(window, ws) {
        if (!window || !ws || !this._settings) return;
        const [px, py] = global.get_pointer();
        const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
        if (tiled.length <= 1) return;

        const layout = this._getWorkspaceLayout(ws);
        if (layout === 'dwindle') {
            const targetLeaf = this._computeDwindleDropTarget(ws, px, py);
            if (!targetLeaf || targetLeaf.type !== 'leaf') return;

            const tree = this._bspGetTree(ws);
            if (!tree) return;

            const gap = this._settings.get_int('gap');
            let newTree = this._bspRemove(tree, window);
            if (newTree.type === 'empty') newTree = null;

            if (newTree && targetLeaf.window !== window) {
                newTree = this._bspReplaceLeaf(newTree, targetLeaf, window);
            }
            this._bspTrees.set(ws, newTree);
        } else {
            const targetIdx = this._computeMasterStackDropTarget(ws, px, py);
            if (targetIdx < 0) return;

            const order = this._getWorkspaceOrder(ws);
            const currentIdx = order.indexOf(window);
            if (currentIdx === -1 || currentIdx === targetIdx) return;

            order.splice(currentIdx, 1);
            const adjusted = targetIdx > currentIdx ? targetIdx - 1 : targetIdx;
            order.splice(adjusted, 0, window);
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
    }

}
