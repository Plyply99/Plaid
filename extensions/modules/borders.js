// Border widgets — the per-window cairo border (gradient, animated) and its
// teardown. The gradient geometry + rotation math lives in border-math.js.
//
// Methods live on this subsystem class.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import cairo from 'gi://cairo';
import { PlaidSubsystem } from './subsystem.js';


export class Borders extends PlaidSubsystem {
    constructor(core) {
        super(core);
    }

    ensureWindowBorder(win, actor, frame, isFocused) {
        if (!frame || frame.width === 0 || frame.height === 0) return false;
        // Exactly-one-border (client-type rule). Wayland: the mask attaches to the
        // actor, so this widget is captured/clipped and can never render — the SDF is
        // the sole border. X11: the mask attaches to the surface child, so the widget
        // (on the actor) escapes the capture — use it as the border only when its
        // stroke fits the allocation (shadowed windows), refuse it for zero-shadow
        // electron windows (stroke outside → double SDF), and use a placeholder for a
        // childless window until the surface arrives. Teardown is border-only
        // (_removeWidgetBorder), never destroying the mask.
        if (this.core._settings.get_boolean('rounded-corners') &&
            this.core._settings.get_int('border-radius') > 0) {
            if (win.get_client_type() !== Meta.WindowClientType.X11) {
                this.removeWidgetBorder(win);
                return false;
            }
            if (this.core.masks.unwrapMaskActor(actor, win)) {
                const effWidth = isFocused
                    ? this.core._settings.get_int('active-border-width')
                    : this.core._settings.get_int('inactive-border-width');
                const buffer = win.get_buffer_rect();
                if ((frame.x - buffer.x) < effWidth ||
                    (frame.y - buffer.y) < effWidth) {
                    this.removeWidgetBorder(win);
                    return false;
                }
            }
            // childless → fall through: create the placeholder widget
        }
        const activeWidth = this.core._settings.get_int('active-border-width');
        const activeColor = (this.core._settings.get_strv('active-border-color') || [])[0] || '#bd93f9';
        const activeColor2 = (this.core._settings.get_strv('active-border-color-2') || [])[0] || '#50fa7b';
        const inactiveWidth = this.core._settings.get_int('inactive-border-width');
        const inactiveColor = (this.core._settings.get_strv('inactive-border-color') || [])[0] || '#1e1f29';
        const inactiveColor2 = (this.core._settings.get_strv('inactive-border-color-2') || [])[0] || '#282a36';
        const borderRadius = this.core._settings.get_int('border-radius');
        const gradient = this.core._settings.get_boolean('gradient-borders');
        const gradientDir = this.core._settings.get_string('gradient-direction');

        let borderWidth = isFocused ? activeWidth : inactiveWidth;
        let color1 = isFocused ? activeColor : inactiveColor;
        let color2 = isFocused ? activeColor2 : inactiveColor2;

        if (borderWidth === 0) {
            // Border-only teardown (never touches the mask) so a 0 width actually
            // removes the widget border. The scratch ring shares this lifecycle by
            // design; the rounded Wayland SDF ring is independent and unaffected.
            this.removeWidgetBorder(win);
            return false;
        }

        // Border on the window ACTOR (frame-level): appended last, it always paints
        // above the frame and the client surface. The client child is replaced on
        // workspace round-trips for some clients (Steam), so attaching there nested
        // and sank borders. The mask cuts the corners; the border stays square.
        const buffer = win.get_buffer_rect();
        const borderX = (frame.x - buffer.x) - borderWidth;
        const borderY = (frame.y - buffer.y) - borderWidth;
        const borderW = frame.width + borderWidth * 2;
        const borderH = frame.height + borderWidth * 2;

        const old = this.core._windowBorders.get(win);
        // Scratch membership is part of the identity: the outer ring lives
        // on the create path, so entering/leaving the scratchpad must flip
        // the signature.
        const scratch = !!(this.core._scratchpadWindows && this.core._scratchpadWindows.has(win));
        const sig = [borderX, borderY, borderW, borderH, borderWidth,
            borderRadius, gradient ? 1 : 0, gradientDir, color1, color2, scratch ? 1 : 0].join('|');
        if (old) {
            // The window's actor can be REPLACED (X11 surface round-trips)
            // while the geometry sig stays identical — the border would
            // linger on the dead actor (invisible). The parent check forces
            // a recreate on the current actor.
            let alive = false;
            try { alive = old.get_parent() === actor; } catch (_e) { alive = false; }
            if (old._plaidSig === sig && alive) return true;
            old.destroy();
            this.core._windowBorders.delete(win);
        }

        let border;
        if (gradient) {
            border = new St.DrawingArea({
                x: borderX,
                y: borderY,
                width: borderW,
                height: borderH,
                reactive: false,
                visible: true,
            });
            border._plaidBorder = {
                color1: this.core.borderMath.hexToRgb(color1),
                color2: this.core.borderMath.hexToRgb(color2),
                width: borderWidth,
                radius: borderRadius,
                direction: gradientDir,
            };
            this.connectObject(border, 'repaint', () => this.repaintBorder(border));
        } else {
            border = new St.Widget({
                name: 'tiling-border',
                x: borderX,
                y: borderY,
                width: borderW,
                height: borderH,
                style: `border: ${borderWidth}px solid ${color1}; border-radius: ${borderRadius}px; box-sizing: border-box;`,
                reactive: false,
                visible: true,
            });
        }
        actor.add_child(border);
        border._plaidSig = sig;
        this.core._windowBorders.set(win, border);

        // Scratchpad windows get a Hyprland-style outer yellow ring: the
        // normal border stays, plus a flat ring outside it whose width
        // follows the user's active-border-width setting.
        if (this.core._scratchpadWindows && this.core._scratchpadWindows.has(win)) {
            // Ring creation is best-effort; a failure must not break the border.
            {
                const ringWidth = Math.max(2, activeWidth);
                const scratchColor =
                    (this.core._settings.get_strv('scratchpad-border-color') || [])[0] || '#f5c211';
                const ring = new St.Widget({
                    name: 'tiling-border',
                    x: borderX - ringWidth,
                    y: borderY - ringWidth,
                    width: borderW + ringWidth * 2,
                    height: borderH + ringWidth * 2,
                    style: `border: ${ringWidth}px solid ${scratchColor}; ` +
                        `border-radius: ${borderRadius + borderWidth + ringWidth}px; box-sizing: border-box;`,
                    reactive: false,
                    visible: true,
                });
                actor.add_child(ring);
                ring._plaidRing = true;
                const old = this.core._scratchpadRings.get(win);
                if (old)
                    old.destroy();
                this.core._scratchpadRings.set(win, ring);
            }
        }
        return true;
    }

    applyDropdownEffects(win) {
        if (!this.core._settings || !win) return;
        // The DDT is held hidden until it has been moved to the drop rect.
        // Attaching blur/border at the centered spawn geometry paints a visible
        // clone there even though the terminal actor itself is hidden.
        if (win === this.core._dropdownWin && !win._plaidDdtRevealed) return;
        const actor = win.get_compositor_private();
        if (!actor) return;
        const frame = win.get_frame_rect();
        if (frame.width === 0 || frame.height === 0) return;
        const borderRadius = this.core._settings.get_int('border-radius');
        const roundedCorners = this.core._settings.get_boolean('rounded-corners');
        const blurEnabled = this.core._settings.get_boolean('window-blur');
        const bordersEnabled = this.core._settings.get_boolean('borders-enabled');

        this.removeBorder(win);

        if (blurEnabled)
            this.core.blur.ensureWindowBlur(win, actor);

        if (roundedCorners && borderRadius > 0) {
            this.core.masks.ensureWindowMask(win, actor, borderRadius + 1);
        } else {
            this.core.masks.removeMask(win);
        }

        if (!blurEnabled)
            this.core.blur.removeBlur(win);

        if (bordersEnabled && !this.ensureWindowBorder(win, actor, frame, true))
            // Border-only: this follows a fresh _ensureWindowMask — the old
            // _removeBorder here also destroyed the mask it just attached
            // (and killed the DDT's rounded corners when the border gate
            // declined the widget).
            this.removeWidgetBorder(win);
    }

    repaintBorder(border) {
        try {
            const info = border._plaidBorder;
            if (!info || !border.get_context) return;
            const w = border.width;
            const h = border.height;
            if (w <= 0 || h <= 0) return;

            const segs = this.core.borderMath.buildBorderSegments(border);
            if (segs.length === 0) return;

            const bw = info.width;
            const cx = w / 2;
            const cy = h / 2;
            const speed = this.core._settings.get_int('border-animation-speed');
            const period = this.core.borderMath.borderRotationMs(speed);
            const animated = period > 0;
            let theta = 0;
            if (animated) {
                // Rotation speed comes from border-animation-speed alone;
                // slow_down_factor is an accessibility lever for placement, not rotation.
                theta = ((Date.now() / period) % 1) * Math.PI * 2;
            }

            const cr = border.get_context();
            cr.setLineWidth(bw);
            cr.setLineCap(cairo.LineCap.ROUND);

            for (const seg of segs) {
                const p = { x: (seg.x0 + seg.x1) / 2, y: (seg.y0 + seg.y1) / 2 };
                const gpos = this.core.borderMath.borderGradientPos(w, h, p, info.direction, animated, theta, cx, cy);
                const c = this.core.borderMath.lerpRgb(info.color1, info.color2, gpos);
                cr.setSourceRGB(c.r, c.g, c.b);
                cr.moveTo(seg.x0, seg.y0);
                cr.lineTo(seg.x1, seg.y1);
                cr.stroke();
            }
        } catch (e) {
            this.core.debugLog(`repaint FAILED: ${e.message}`);
        }
    }

    startBorderAnimation() {
        if (this.core._borderAnimId) return;
        try {
            if (!this.core._settings.get_boolean('gradient-borders')) return;
            if (this.core._settings.get_int('border-animation-speed') <= 0) return;
        } catch (e) {
            this.core.debugLog(`_startBorderAnimation failed: ${e.message}`);
            return;
        }
        this.core.debugLog('border animation: start');
        this.core._borderAnimId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
            try {
                if (!this.core._settings ||
                    !this.core._settings.get_boolean('gradient-borders') ||
                    this.core._settings.get_int('border-animation-speed') <= 0) {
                    this.core.debugLog('border animation: stop (settings)');
                    this.stopBorderAnimation();
                    return GLib.SOURCE_REMOVE;
                }
                if (this.core._grabOp) {
                    return GLib.SOURCE_CONTINUE;
                }
            } catch (e) {
                this.core.debugLog(`border animation tick failed: ${e.message}`);
                this.stopBorderAnimation();
                return GLib.SOURCE_REMOVE;
            }
            // Rotation follows border-animation-speed alone (see _repaintBorder).
            const period = this.core.borderMath.borderRotationMs(this.core._settings.get_int('border-animation-speed'));
            const theta = period > 0 ? ((Date.now() / period) % 1) * Math.PI * 2 : 0;
            for (const effect of this.core._windowMasks.values())
                effect.setTheta(theta);
            for (const border of this.core._windowBorders.values()) {
                // St.DrawingArea only runs the cairo handler on ITS queue_repaint
                // (Clutter's queue_redraw repaints the cached texture), so the gradient
                // only rotates via queue_repaint. Plain St.Widgets have no queue_repaint.
                if (border.queue_repaint) border.queue_repaint();
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    stopBorderAnimation() {
        if (this.core._borderAnimId) {
            GLib.source_remove(this.core._borderAnimId);
            this.core._borderAnimId = 0;
        }
    }

    syncBorderAnimation() {
        try {
            if (!this.core._settings) return;
            const wantAnim = this.core._settings.get_boolean('gradient-borders') &&
                this.core._settings.get_int('border-animation-speed') > 0 &&
                (this.core._windowBorders.size > 0 || this.core._windowMasks.size > 0);
            if (wantAnim)
                this.startBorderAnimation();
            else
                this.stopBorderAnimation();
        } catch (e) {
            this.core.debugLog(`_syncBorderAnimation failed: ${e.message}`);
            this.stopBorderAnimation();
        }
    }

    updateBordersDuringGrab() {
        if (!this.core._settings || !this.core._settings.get_boolean('enabled')) return;
        const ws = global.workspace_manager.get_active_workspace();
        if (!ws) return;
        const focusWindow = global.display.focus_window;
        const activeWidth = this.core._settings.get_int('active-border-width');
        const inactiveWidth = this.core._settings.get_int('inactive-border-width');

        for (const [win, border] of this.core._windowBorders.entries()) {
            if (!win.get_compositor_private()) {
                this.removeBorder(win);
                continue;
            }
            const frame = win.get_frame_rect();
            if (frame.width === 0 || frame.height === 0) continue;
            const actor = win.get_compositor_private();
            // The window's actor can be replaced mid-session; a border on
            // the dead actor must not be poked (and is invisible anyway).
            if (!actor || border.get_parent() !== actor) {
                this.removeBorder(win);
                continue;
            }
            const buffer = win.get_buffer_rect();
            const bw = win === focusWindow ? activeWidth : inactiveWidth;
            const bx = (frame.x - buffer.x) - bw;
            const by = (frame.y - buffer.y) - bw;
            const bwSize = frame.width + bw * 2;
            const bhSize = frame.height + bw * 2;
            border.set_position(bx, by);
            border.set_size(bwSize, bhSize);
            if (border._plaidBorder) {
                // Gradient path: the cairo stroke width lives in _plaidBorder
                // — keep it in sync with the live width and rebuild the
                // cached segments for the new size.
                if (border._plaidBorder.width !== bw) {
                    border._plaidBorder.width = bw;
                    border._plaidSegKey = '';
                }
            }
            if (border.queue_repaint) border.queue_repaint();
        }
    }

    removeAllBorders() {
        for (const border of this.core._windowBorders.values()) {
            border.destroy();
        }
        this.core._windowBorders.clear();
        if (this.core._scratchpadRings) {
            for (const ring of this.core._scratchpadRings.values()) {
                ring.destroy();
            }
            this.core._scratchpadRings.clear();
        }
    }

    removeWidgetBorder(win) {
        // Border-only teardown (widget + scratch ring), without touching the mask —
        // unlike _removeBorder, which also destroys the mask (correct for
        // fullscreen/clear, wrong when the SDF border should take over).
        if (this.core._windowBorders.has(win)) {
            this.core._windowBorders.get(win).destroy();
            this.core._windowBorders.delete(win);
        }
        if (this.core._scratchpadRings && this.core._scratchpadRings.has(win)) {
            this.core._scratchpadRings.get(win).destroy();
            this.core._scratchpadRings.delete(win);
        }
    }

    removeBorder(win) {
        const border = this.core._windowBorders.get(win);
        if (border) {
            border.destroy();
            this.core._windowBorders.delete(win);
        }
        if (this.core._scratchpadRings) {
            const ring = this.core._scratchpadRings.get(win);
            if (ring) {
                ring.destroy();
                this.core._scratchpadRings.delete(win);
            }
        }
        this.core.masks.removeMask(win);
    }

    updateBorders() {
        if (!this.core._settings) return;
        this.core.signals.scheduleBorders();
    }

    doUpdateBorders() {
        if (!this.core._settings) return;

        // Flair (borders, rounded corners, blur) renders from its own
        // settings and stays even when tiling is toggled off.

        const focusWindow = global.display.focus_window;

        const borderRadius = this.core._settings.get_int('border-radius');
        const roundedCorners = this.core._settings.get_boolean('rounded-corners');
        const bordersEnabled = this.core._settings.get_boolean('borders-enabled');
        const blurEnabled = this.core._settings.get_boolean('window-blur');

        // Only sweep ALL borders when the feature turned off — otherwise
        // _ensureWindowBorder's per-window signature gate skips unchanged
        // windows (destroy/recreate churn on every focus change is the
        // biggest steady-state cost under hover-focus).
        if (!bordersEnabled)
            this.removeAllBorders();

        const ws = global.workspace_manager.get_active_workspace();
        if (!ws) return;

        const windows = this.core.windows.getWindowsForWorkspace(ws);
        for (const win of windows) {
            if (win.is_fullscreen()) {
                this.core.masks.removeMask(win);
                this.core.blur.removeBlur(win);
                this.removeBorder(win);
                continue;
            }
            // The grab skip must compare against the GRABBED window — the focus
            // window can differ mid-grab (hover-focus during a drag), and
            // the grabbed-but-unfocused window then got stale mask uniforms
            // for the whole grab.
            if (this.core._grabOp && this.core._grabWindow && win === this.core._grabWindow) continue;
            const actor = win.get_compositor_private();
            if (!actor) continue;
            const frame = win.get_frame_rect();
            if (frame.width === 0 || frame.height === 0) continue;

            if (blurEnabled && !(this.core._pendingWarp && this.core._pendingWarp.has(win)))
                this.core.blur.ensureWindowBlur(win, actor);

            const isFocused = win === focusWindow;
            const scratch = !!(this.core._scratchpadWindows && this.core._scratchpadWindows.has(win));

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
                if (!scratch && !this.core.windows.isFloating(win) && this.core._windowBorders.has(win)) {
                    this.core.debugLog(`border: removed stale widget border on mask-only window ${win.get_wm_class_instance() || '?'}`);
                    this.core._windowBorders.get(win).destroy();
                    this.core._windowBorders.delete(win);
                    if (this.core._scratchpadRings) {
                        const ring = this.core._scratchpadRings.get(win);
                        if (ring) {
                            ring.destroy();
                            this.core._scratchpadRings.delete(win);
                        }
                    }
                }
                // Widget before mask (same ordering rule as the floating
                // loop) for the scratch fall-through.
                if (scratch && bordersEnabled)
                    this.ensureWindowBorder(win, actor, frame, isFocused);
                this.core.masks.ensureWindowMask(win, actor, borderRadius + 1);
                // Scratch windows fall through to their special border even
                // with rounded corners (normal windows stay mask-only).
                if (!scratch)
                    continue;
            }

            if (bordersEnabled) this.ensureWindowBorder(win, actor, frame, isFocused);
        }

        // Floating windows are not in _windowWSIndices (they skip _addWindow),
        // so the tiled loop above misses them. Apply Flair directly.
        for (const win of ws.list_windows()) {
            if (win.get_window_type() !== Meta.WindowType.NORMAL) continue;
            if (!this.core.windows.isFloating(win)) continue;
            // The tiled fullscreen branch drops border+mask+blur; the float branch
            // missed the WIDGET border (and scratch ring) — a floating
            // window entering fullscreen kept its colored frame + ring
            // rendered on top of the fullscreen content (X11 floats; the
            // mask is gone there so the widget is unclipped).
            if (win.is_fullscreen()) { this.core.masks.removeMask(win); this.core.blur.removeBlur(win); this.removeBorder(win); continue; }
            const actor = win.get_compositor_private();
            if (!actor) continue;
            const frame = win.get_frame_rect();
            if (frame.width === 0 || frame.height === 0) continue;
            if (blurEnabled) this.core.blur.ensureWindowBlur(win, actor);
            const isFocused = win === focusWindow;
            // Order matters: create the WIDGET border before the mask —
            // _updateMaskBounds zeroes the SDF border when a renderable
            // widget exists, so creating the widget first avoids a
            // first-pass (or transition-pass) transient double border.
            if (bordersEnabled) this.ensureWindowBorder(win, actor, frame, isFocused);
            if (roundedCorners && borderRadius > 0)
                this.core.masks.ensureWindowMask(win, actor, borderRadius + 1);
        }

        // The border animation is armed by _syncBorderAnimation() below with the
        // full condition (gradient + speed + live borders/masks). A standalone
        // start here (without the maps check) armed the tick on every pass
        // even with empty maps — start log → sync stops it → next pass:
        // a per-pass `border animation: start` log pair.

        if (!roundedCorners || borderRadius <= 0)
            this.core.masks.removeAllMasks();

        if (!blurEnabled)
            this.core.blur.removeAllBlurs();

        if (this.core._dropdownWin)
            this.applyDropdownEffects(this.core._dropdownWin);

        this.syncBorderAnimation();
    }

    destroy() {
        this.stopBorderAnimation();
        this.removeAllBorders();
            super.destroy();
}
}
