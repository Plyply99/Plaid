// Scratchpad (Plaid Scratch Layer) — stash a window (it minimizes away) and
// toggle it back at its remembered position. The scratch ring rendering lives
// in borders.js; this module owns the add/hide/show/remove choreography.
//
// Methods live on this subsystem class.









// --- Grab-Based Mouse Resize & Swap ---


export class Scratchpad {
    constructor(core) {
        this.core = core;
    }

    scratchpadAdd() {
        const win = this.core.actions.getActiveWindow();
        this.core.debugLog('scratch add: invoked');
        if (!win) {
            this.core.debugLog('scratch add: skipped (no active window)');
            return;
        }
        if (this.core._scratchpadWindows.has(win)) {
            // The hotkey toggles: a window already in the scratchpad gets
            // fully restored (unminimize, workspace, geometry, re-tile).
            this.core.debugLog('scratch add: in scratchpad — toggling off');
            this.scratchpadRemove();
            return;
        }
        const ws = win.get_workspace();
        if (!ws) {
            this.core.debugLog('scratch add: skipped (no workspace)');
            return;
        }
        try {
            const frame = win.get_frame_rect();
            this.core._scratchpadWindows.set(win, {
                workspace: ws,
                x: frame.x, y: frame.y, w: frame.width, h: frame.height,
            });
            this.core._toggleFloatWindows.add(win);
            win.minimize();
            {
                const a = win.get_compositor_private();
                this.core.debugLog(`scratch add: after minimize minimized=${win.minimized} actorVisible=${a ? a.visible : '?'}`);
            }
            this.core._scratchpadVisible = false;
            this.core.layouts.retileWorkspace(ws);
            this.core.workspaces.showPopup('Added to Scratchpad');
            this.core.debugLog(`scratch add: added ${win.get_wm_class() || 'window'}`);
        } catch (e) {
            this.core.debugLog(`scratch add failed: ${e.message}`);
        }
    }

    scratchpadToggle() {
        if (!this.core._scratchpadWindows || this.core._scratchpadWindows.size === 0) {
            this.core.debugLog('scratch toggle: empty scratchpad');
            return;
        }
        this.core.debugLog(`scratch toggle: size=${this.core._scratchpadWindows.size}`);
        if (this.core._scratchpadVisible) {
            for (const win of this.core._scratchpadWindows.keys()) {
                {
                    if (!win.get_compositor_private()) continue;
                    // Remember where the window IS at hide time (GNOME
                    // semantics): moves/resizes made while the scratchpad
                    // was visible are captured here, so the next show —
                    // and a later remove — restore the LAST position
                    // instead of the add-time one.
                    const entry = this.core._scratchpadWindows.get(win);
                    if (entry) {
                        const f = win.get_frame_rect();
                        if (f.width > 0 && f.height > 0) {
                            entry.x = f.x;
                            entry.y = f.y;
                            entry.w = f.width;
                            entry.h = f.height;
                        }
                    }
                    win.minimize();
                }
            }
            this.core._scratchpadVisible = false;
            this.core.workspaces.showPopup('Scratchpad Hidden');
        } else {
            const activeWs = global.workspace_manager.get_active_workspace();
            if (!activeWs) return;
            const monitor = global.display.get_primary_monitor();
            const workArea = activeWs.get_work_area_for_monitor(monitor);
            let firstWin = null;
            for (const win of this.core._scratchpadWindows.keys()) {
                {
                    if (!win.get_compositor_private() || win.is_fullscreen()) continue;
                    if (win.get_workspace() !== activeWs) {
                        { win.change_workspace(activeWs); }
                    }
                    // Restore the remembered geometry (captured at add, and
                    // refreshed at every hide) BEFORE the window unminimizes
                    // so it reappears exactly in place. The old code
                    // re-centered every scratchpad window here — stacking
                    // them all in the middle of the screen and throwing the
                    // position away. Fallback to centering only when the
                    // entry is unusable or the remembered rect is entirely
                    // off-screen (its monitor unplugged since it was hidden).
                    const entry = this.core._scratchpadWindows.get(win);
                    const frame = win.get_frame_rect();
                    let restored = false;
                    if (entry && entry.w > 0 && entry.h > 0) {
                        if (this.rectOnScreen({ x: entry.x, y: entry.y, w: entry.w, h: entry.h })) {
                            {
                                win.move_resize_frame(true, entry.x, entry.y, entry.w, entry.h);
                                restored = true;
                            }
                        }
                    }
                    if (!restored && workArea && frame.width > 0 && frame.height > 0) {
                        win.move_resize_frame(true,
                            workArea.x + Math.floor((workArea.width - frame.width) / 2),
                            workArea.y + Math.floor((workArea.height - frame.height) / 2),
                            frame.width, frame.height);
                    }
                    win.unminimize();
                    { win.raise(); }
                    if (!firstWin) firstWin = win;
                }
            }
            this.core._scratchpadVisible = true;
            if (firstWin) {
                { firstWin.activate(this.core.currentTime()); }
            }
            this.core.workspaces.showPopup('Scratchpad Shown');
        }
    }

    rectOnScreen(r) {
        const n = global.display.get_n_monitors();
        for (let i = 0; i < n; i++) {
            const g = global.display.get_monitor_geometry(i);
            if (r.x < g.x + g.width && r.x + r.w > g.x &&
                r.y < g.y + g.height && r.y + r.h > g.y)
                return true;
        }
        return false;
    }

    scratchpadRemove() {
        const win = this.core.actions.getActiveWindow();
        if (!win) return;
        const saved = this.core._scratchpadWindows.get(win);
        if (!saved) return;
        this.core._scratchpadWindows.delete(win);
        this.core._toggleFloatWindows.delete(win);
        // A scratch window may also have been auto-floated for its size minimum;
        // clear that too so it rejoins tiling on return.
        this.core.placement.releaseMinLimitedWindow(win);
        // Destroy the scratch RING here, where membership ends. The sig-gate
        // in _ensureWindowBorder destroys the BORDER widget on the
        // scratch→normal signature flip but never the ring (it lives only in
        // _scratchpadRings) — on a shadowed X11 window (gate lets the widget
        // through) it was orphaned on the actor forever ("Fallout 76 QC:
        // yellow border won't go away"). Placement matters: an entry sweep in
        // _ensureWindowBorder was tried first and correlated with the
        // scratchpad keybind handler dying — keep this cleanup HERE.
        if (this.core._scratchpadRings && this.core._scratchpadRings.has(win)) {
            this.core._scratchpadRings.get(win).destroy();
            this.core._scratchpadRings.delete(win);
        }
        try {
            win.unminimize();
            if (saved.workspace && win.get_workspace() !== saved.workspace) {
                { win.change_workspace(saved.workspace); }
            }
            // The remove/toggle-off key always runs on a VISIBLE, active
            // window — it is already at its remembered (or user-adjusted)
            // position, so keep it there. The old unconditional re-apply of
            // the saved rect yanked a moved-while-shown window back to a
            // stale rect. Only fall back to the saved rect if the frame is
            // unusable (degenerate = can't tell where the window is).
            const f = win.get_frame_rect();
            if (f.width <= 0 || f.height <= 0) {
                win.move_resize_frame(true, saved.x, saved.y, saved.w, saved.h);
            }
            this.core.layouts.retileWorkspace(saved.workspace);
            this.core.workspaces.showPopup('Removed from Scratchpad');
        } catch (e) {
            // Was a silent catch: an exception here (e.g. a dead saved
            // workspace from dynamic-workspace churn) left the toggle-off
            // with NO restore and NO popup — "the key does nothing".
            this.core.debugLog(`scratch remove failed: ${e.message}`);
        }
    }

    destroy() {
        this.core._scratchpadWindows = null;
        this.core._scratchpadVisible = false;
    }
}
