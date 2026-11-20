// Pointer focus ("focus on hover") — focus the window the pointer enters, across
// the active workspace. The Chromium family is excluded:
// their app-managed focus closes web-rendered menus when focus is called.
//
// Methods live on this subsystem class.

import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { PlaidSubsystem } from './subsystem.js';

// The Chromium/CEF process model: every child process (renderer, gpu-process,
// zygote, crashpad-handler…) carries --type= on its cmdline. Steam's CEF host
// (./steamwebhelper …) is the exception — no --type= — so match its process
// name here too. Verdicts cached per PID (own cache).

export class PointerFocus extends PlaidSubsystem {
    constructor(core) {
        super(core);
    }

    initPointerFocus() {
        this.core._pointerFocusEnabledId = this.connectObject(this.core._settings,
            'changed::pointer-focus', () => this.syncPointerFocus());
        this.syncPointerFocus();
    }

    syncPointerFocus() {
        const enabled = this.core._settings.get_boolean('pointer-focus');
        if (!enabled) {
            this.teardownPointerFocus();
            return;
        }
        if (this.core._pointerFocusId) return;
        this.core._pointerFocusId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            if (!this.core._settings) return GLib.SOURCE_REMOVE;
            this.pointerFocusTick();
            return GLib.SOURCE_CONTINUE;
        });
        this.core.debugLog('pointer focus: tracking enabled');
    }

    teardownPointerFocus() {
        // Re-enabled, the first move focuses the window under the pointer.
        this.core._pointerFocusHover = null;
        if (this.core._pointerFocusId) {
            GLib.source_remove(this.core._pointerFocusId);
            this.core._pointerFocusId = 0;
        }
    }

    pointerFocusTick() {
        const [px, py] = global.get_pointer();
        if (px === this.core._pointerFocusLastX && py === this.core._pointerFocusLastY)
            return;
        this.core._pointerFocusLastX = px;
        this.core._pointerFocusLastY = py;
        this.applyPointerFocus(px, py);
    }

    applyPointerFocus(px, py) {
        if (Main.overview.visible) return;
        if (Main.modalCount > 0) return;
        // Focus moves when the pointer ENTERS a window, never on a move over
        // the one it is already in: a menu that took focus from its window
        // (Zoom's "More", a frameless toplevel) stays open while the pointer
        // travels to it across that window.
        const target = this.resolveWindowByScan(px, py);
        const entered = target !== this.core._pointerFocusHover;
        this.core._pointerFocusHover = target;
        if (!target || !entered) return;
        if (!this.canPointerFocusWindow(target)) return;
        if (target === global.display.focus_window) return;
        if (target === this.core._backgroundAppWin) return;
        // Scratchpad members are NOT excluded: a shown scratchpad window is an
        // ordinary visible float, so hover focus treats it normally. Hidden
        // scratch windows never reach here — the scan skips minimized windows.
        this.core.debugLog(`pointer focus: ${target.get_wm_class_instance() || '?'} title=${target.get_title() || '?'}`);
        target.focus(global.get_current_time());
    }

    resolveWindowByScan(px, py) {
        const candidates = [];
        const under = [];
        let total = 0;
        const wm = global.workspace_manager;
        const activeWs = wm.get_active_workspace();
        // Fixed-group monitors show their windows on every workspace. Include
        // them here, or a visible secondary window can never be a hover target.
        const fixedConns = new Set();
        for (const mon of this.core.monitors.tiledMonitors()) {
            if (this.core.monitors.fixedModeFor(mon))
                fixedConns.add(this.core.monitors.connectorOrFallback(mon));
        }
        const seen = new Set();
        for (let i = 0; i < wm.get_n_workspaces(); i++) {
            const ws = wm.get_workspace_by_index(i);
            if (!ws || ws === this.core._backgroundAppParkingWs) continue;
            for (const win of ws.list_windows()) {
                if (!win || seen.has(win)) continue;
                if (ws !== activeWs &&
                    !fixedConns.has(this.core.monitors.windowMonitor(win)))
                    continue;
                seen.add(win);
                total++;
                // Minimized windows are invisible: not a hover target, and
                // never a reach-through blocker (a hidden DDT / scratchpad
                // / Super+H window whose frame overlaps the pointer would
                // otherwise null the scan via the popup protection).
                if (win.minimized) continue;
                const r = win.get_frame_rect();
                if (px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height) {
                    const pass = this.canPointerFocusWindow(win) && win !== this.core._backgroundAppWin;
                    under.push({ win, pass });
                    if (pass)
                        candidates.push(win);
                }
            }
        }
        if (this.core._settings && this.core._settings.get_boolean('debug')) {
            const sig = candidates.map(w => w.get_id()).join(',');
            if (sig !== this.core._pointerFocusCandSig) {
                this.core._pointerFocusCandSig = sig;
                this.core.debugLog(`pointer focus: scan windows=${total} candidates=${candidates.map(w => w.get_wm_class_instance() || '?').join(',') || 'none'}`);
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
    }

    canPointerFocusWindow(win) {
        if (!win) return false;
        if (win.minimized) return false;
        // The Chromium family (Electron/CEF/Steam's steamwebhelper) renders its menus
        // as web overlays INSIDE its windows; focus calls on the host disturb the web
        // UI and close them (upstream: steam-for-linux#11077, electron#48737). Hover
        // focus steps away from the whole family — their focus is app-managed.
        {
            // Never key this off get_wm_class_instance() alone: it is EMPTY on
            // GNOME 51 (Wayland, and observed for Steam's XWayland window too), so
            // the raw check silently stopped matching. _winClassCandidates covers
            // instance/class/app-id; the process-cmdline fallback covers the
            // empty-instance case (Steam's X11 class is "steam", not "steamwebhelper").
            if (this.core.winClassCandidates(win).includes('steamwebhelper')) return false;
        }
        {
            if (this.isChromiumProcessWindow(win)) return false;
        }
        {
            if (win.is_skip_taskbar() && !this.core.windows.isFloating(win)) return false;
        }
        return true;
    }

    isChromiumProcessWindow(win) {
        const pid = win.get_pid();
        if (!pid) return false;
        if (this.core._chromiumProcessCache) {
            const cached = this.core._chromiumProcessCache.get(pid);
            if (cached !== undefined) return cached;
        }
        const evaluate = (cmd) => {
            const verdict = /--type=|steamwebhelper/.test(cmd || '');
            if (!this.core._chromiumProcessCache) return;
            if (this.core._chromiumProcessCache.size >= 256)
                this.core._chromiumProcessCache.clear();
            this.core._chromiumProcessCache.set(pid, verdict);
            if (!verdict) {
                // Force the next tick to re-evaluate this position; the tick
                // otherwise short-circuits when the pointer has not moved, and
                // focuses only a window the pointer entered.
                this.core._pointerFocusLastX = -1;
                this.core._pointerFocusLastY = -1;
                this.core._pointerFocusHover = null;
            }
        };
        const cachedCmd = this.core.procInfo.procCmdlineCached(pid);
        if (cachedCmd !== undefined) {
            evaluate(cachedCmd);
            return this.core._chromiumProcessCache.get(pid) === true;
        }
        this.core.procInfo.getProcCmdline(pid, evaluate);
        // Unknown process: skip hover focus until the async read lands. This
        // preserves the menu-safety behavior for Chromium/Steam on first hover.
        return true;
    }

    destroy() {
        this.teardownPointerFocus();
        if (this.core._pointerFocusEnabledId) {
            this.core._settings.disconnectObject(this.core._pointerFocusEnabledId);
            this.core._pointerFocusEnabledId = 0;
        }
        super.destroy();
    }
}
