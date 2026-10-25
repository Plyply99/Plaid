// Pointer focus ("focus on hover") — focus the window under the pointer as the
// mouse moves, across the active workspace. The Chromium family is excluded:
// their app-managed focus closes web-rendered menus when focus is called.
//
// Methods are attached to TilingWMExtension.prototype in extension.js.

import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export function _initPointerFocus() {
    try {
        this._pointerFocusEnabledId = this._settings.connect(
            'changed::pointer-focus', () => this._syncPointerFocus());
    } catch (_e) {
        this._pointerFocusEnabledId = 0;
    }
    this._syncPointerFocus();
}

export function _syncPointerFocus() {
    const enabled = this._settings?.get_boolean('pointer-focus') ?? false;
    if (!enabled) {
        this._teardownPointerFocus();
        return;
    }
    if (this._pointerFocusId) return;
    this._pointerFocusId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
        if (!this._settings) return GLib.SOURCE_REMOVE;
        this._pointerFocusTick();
        return GLib.SOURCE_CONTINUE;
    });
    this._debugLog('pointer focus: tracking enabled');
}

export function _teardownPointerFocus() {
    if (this._pointerFocusId) {
        GLib.source_remove(this._pointerFocusId);
        this._pointerFocusId = 0;
    }
}

export function _pointerFocusTick() {
    try {
        const [px, py] = global.get_pointer();
        if (px === this._pointerFocusLastX && py === this._pointerFocusLastY)
            return;
        this._pointerFocusLastX = px;
        this._pointerFocusLastY = py;
        this._applyPointerFocus(px, py);
    } catch (e) {
        this._debugLog(`pointer focus: tick failed: ${e.message}`);
    }
}

export function _applyPointerFocus(px, py) {
    try {
        if (Main.overview.visible) return;
        if (Main.modalCount > 0) return;
        const target = this._resolveWindowByScan(px, py);
        if (!target) return;
        if (!this._canPointerFocusWindow(target)) return;
        if (target === global.display.focus_window) return;
        if (target === this._backgroundAppWin) return;
        // Scratchpad members are NOT excluded: a shown scratchpad window is an
        // ordinary visible float, so hover focus treats it normally. Hidden
        // scratch windows never reach here — the scan skips minimized windows.
        this._debugLog(`pointer focus: ${target.get_wm_class_instance() || '?'} title=${target.get_title() || '?'}`);
        target.focus(global.get_current_time());
    } catch (e) {
        this._debugLog(`pointer focus: apply failed: ${e.message}`);
    }
}

export function _resolveWindowByScan(px, py) {
    try {
        const candidates = [];
        const under = [];
        let total = 0;
        const activeWs = global.workspace_manager.get_active_workspace();
        for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
            const ws = global.workspace_manager.get_workspace_by_index(i);
            if (ws !== activeWs) continue;
            if (ws === this._backgroundAppParkingWs) continue;
            for (const win of ws.list_windows()) {
                total++;
                if (!win) continue;
                // Minimized windows are invisible: not a hover target, and
                // never a reach-through blocker (a hidden DDT / scratchpad
                // / Super+H window whose frame overlaps the pointer would
                // otherwise null the scan via the popup protection).
                if (win.minimized) continue;
                const r = win.get_frame_rect();
                if (px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height) {
                    const pass = this._canPointerFocusWindow(win) && win !== this._backgroundAppWin;
                    under.push({ win, pass });
                    if (pass)
                        candidates.push(win);
                }
            }
        }
        if (this._settings && this._settings.get_boolean('debug')) {
            const sig = candidates.map(w => w.get_id()).join(',');
            if (sig !== this._pointerFocusCandSig) {
                this._pointerFocusCandSig = sig;
                this._debugLog(`pointer focus: scan windows=${total} candidates=${candidates.map(w => w.get_wm_class_instance() || '?').join(',') || 'none'}`);
            }
        }
        if (under.length === 0) return null;
        const stacked = global.display.sort_windows_by_stacking(under.map(u => u.win));
        const top = stacked[stacked.length - 1];
        // A popup/menu-like window on top must never be reached through:
        // focusing what's beneath it strips the menu's parent focus and
        // kills the menu (Steam's fixed-size popups extending over other
        // windows). No focus change is the safe outcome.
        const topUnder = under.find(u => u.win === top);
        if (topUnder && !topUnder.pass) return null;
        return top;
    } catch (e) {
        this._debugLog(`pointer focus: scan failed: ${e.message}`);
        return null;
    }
}

export function _canPointerFocusWindow(win) {
    if (!win) return false;
    if (win.minimized) return false;
    // The Chromium family (Electron/CEF/Steam's steamwebhelper) renders its menus
    // as web overlays INSIDE its windows; focus calls on the host disturb the web
    // UI and close them (upstream: steam-for-linux#11077, electron#48737). Hover
    // focus steps away from the whole family — their focus is app-managed.
    try {
        // Never key this off get_wm_class_instance() alone: it is EMPTY on
        // GNOME 51 (Wayland, and observed for Steam's XWayland window too), so
        // the raw check silently stopped matching. _winClassCandidates covers
        // instance/class/app-id; the process-cmdline fallback covers the
        // empty-instance case (Steam's X11 class is "steam", not "steamwebhelper").
        if (this._winClassCandidates(win).includes('steamwebhelper')) return false;
    } catch (_e) {}
    try {
        if (this._isChromiumProcessWindow(win)) return false;
    } catch (_e) {}
    try {
        if (win.is_skip_taskbar() && !this._isFloating(win)) return false;
    } catch (_e) {}
    return true;
}

// The Chromium/CEF process model: every child process (renderer, gpu-process,
// zygote, crashpad-handler…) carries --type= on its cmdline. Steam's CEF host
// (./steamwebhelper …) is the exception — no --type= — so match its process
// name here too. Verdicts cached per PID (own cache).
export function _isChromiumProcessWindow(win) {
    try {
        const pid = win.get_pid();
        if (!pid) return false;
        if (this._chromiumProcessCache) {
            const cached = this._chromiumProcessCache.get(pid);
            if (cached !== undefined) return cached;
        }
        const evaluate = (cmd) => {
            const verdict = /--type=|steamwebhelper/.test(cmd || '');
            if (!this._chromiumProcessCache) return;
            if (this._chromiumProcessCache.size >= 256)
                this._chromiumProcessCache.clear();
            this._chromiumProcessCache.set(pid, verdict);
            if (!verdict) {
                // Force the next tick to re-evaluate this position; the tick
                // otherwise short-circuits when the pointer has not moved.
                this._pointerFocusLastX = -1;
                this._pointerFocusLastY = -1;
            }
        };
        const cachedCmd = this._procCmdlineCached(pid);
        if (cachedCmd !== undefined) {
            evaluate(cachedCmd);
            return this._chromiumProcessCache.get(pid) === true;
        }
        this._getProcCmdline(pid, evaluate);
        // Unknown process: skip hover focus until the async read lands. This
        // preserves the menu-safety behavior for Chromium/Steam on first hover.
        return true;
    } catch (_e) {
        return false;
    }
}

export const pointerFocusMethods = {
    _initPointerFocus,
    _syncPointerFocus,
    _teardownPointerFocus,
    _pointerFocusTick,
    _applyPointerFocus,
    _resolveWindowByScan,
    _canPointerFocusWindow,
    _isChromiumProcessWindow,
};
