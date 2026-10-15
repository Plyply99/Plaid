// Border widgets — the per-window cairo border (gradient, animated) and its
// teardown. The gradient geometry + rotation math lives in border-math.js.
//
// Methods are attached to TilingWMExtension.prototype in extension.js.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import cairo from 'gi://cairo';

export function _ensureWindowBorder(win, actor, frame, isFocused) {
    if (!frame || frame.width === 0 || frame.height === 0) return false;
    // Exactly-one-border (client-type rule). Wayland: the mask attaches to the
    // actor, so this widget is captured/clipped and can never render — the SDF is
    // the sole border. X11: the mask attaches to the surface child, so the widget
    // (on the actor) escapes the capture — use it as the border only when its
    // stroke fits the allocation (shadowed windows), refuse it for zero-shadow
    // electron windows (stroke outside → double SDF), and use a placeholder for a
    // childless window until the surface arrives. Teardown is border-only
    // (_removeWidgetBorder), never destroying the mask.
    if (this._settings.get_boolean('rounded-corners') &&
        this._settings.get_int('border-radius') > 0) {
        if (win.get_client_type() !== Meta.WindowClientType.X11) {
            this._removeWidgetBorder(win);
            return false;
        }
        if (this._unwrapMaskActor(actor, win)) {
            const effWidth = isFocused
                ? this._settings.get_int('active-border-width')
                : this._settings.get_int('inactive-border-width');
            const buffer = win.get_buffer_rect();
            if ((frame.x - buffer.x) < effWidth ||
                (frame.y - buffer.y) < effWidth) {
                this._removeWidgetBorder(win);
                return false;
            }
        }
        // childless → fall through: create the placeholder widget
    }
    const activeWidth = this._settings.get_int('active-border-width');
    const activeColor = (this._settings.get_strv('active-border-color') || [])[0] || '#3584e4';
    const activeColor2 = (this._settings.get_strv('active-border-color-2') || [])[0] || '#62a0ea';
    const inactiveWidth = this._settings.get_int('inactive-border-width');
    const inactiveColor = (this._settings.get_strv('inactive-border-color') || [])[0] || '#555555';
    const inactiveColor2 = (this._settings.get_strv('inactive-border-color-2') || [])[0] || '#777777';
    const borderRadius = this._settings.get_int('border-radius');
    const gradient = this._settings.get_boolean('gradient-borders');
    const gradientDir = this._settings.get_string('gradient-direction');

    let borderWidth = isFocused ? activeWidth : inactiveWidth;
    let color1 = isFocused ? activeColor : inactiveColor;
    let color2 = isFocused ? activeColor2 : inactiveColor2;

    if (borderWidth === 0) {
        // Border-only teardown (never touches the mask) so a 0 width actually
        // removes the widget border. The scratch ring shares this lifecycle by
        // design; the rounded Wayland SDF ring is independent and unaffected.
        this._removeWidgetBorder(win);
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

    const old = this._windowBorders.get(win);
    // Scratch membership is part of the identity: the outer ring lives
    // on the create path, so entering/leaving the scratchpad must flip
    // the signature.
    const scratch = !!(this._scratchpadWindows && this._scratchpadWindows.has(win));
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
        try { old.destroy(); } catch (_e) {}
        this._windowBorders.delete(win);
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
    this._windowBorders.set(win, border);

    // Scratchpad windows get a Hyprland-style outer yellow ring: the
    // normal border stays, plus a flat ring outside it whose width
    // follows the user's active-border-width setting.
    if (this._scratchpadWindows && this._scratchpadWindows.has(win)) {
        try {
            const ringWidth = Math.max(2, activeWidth);
            const scratchColor =
                (this._settings.get_strv('scratchpad-border-color') || [])[0] || '#f5c211';
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
            const old = this._scratchpadRings.get(win);
            if (old) {
                try { old.destroy(); } catch (_e) {}
            }
            this._scratchpadRings.set(win, ring);
        } catch (_e) {}
    }
    return true;
}

export function _applyDropdownEffects(win) {
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
        // Border-only: this follows a fresh _ensureWindowMask — the old
        // _removeBorder here also destroyed the mask it just attached
        // (and killed the DDT's rounded corners when the border gate
        // declined the widget).
        this._removeWidgetBorder(win);
}

export function _repaintBorder(border) {
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
            // Rotation speed comes from border-animation-speed alone;
            // slow_down_factor is an accessibility lever for placement, not rotation.
            theta = ((Date.now() / period) % 1) * Math.PI * 2;
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

export function _startBorderAnimation() {
    if (this._borderAnimId) return;
    try {
        if (!this._settings.get_boolean('gradient-borders')) return;
        if (this._settings.get_int('border-animation-speed') <= 0) return;
    } catch (e) {
        log(`[plaid] _startBorderAnimation failed: ${e.message}`);
        return;
    }
    this._debugLog('border animation: start');
    this._borderAnimId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
        try {
            if (this._destroyed ||
                !this._settings.get_boolean('gradient-borders') ||
                this._settings.get_int('border-animation-speed') <= 0) {
                this._debugLog('border animation: stop (settings)');
                this._stopBorderAnimation();
                return GLib.SOURCE_REMOVE;
            }
            if (this._grabOp) {
                return GLib.SOURCE_CONTINUE;
            }
        } catch (e) {
            log(`[plaid] border animation tick failed: ${e.message}`);
            this._stopBorderAnimation();
            return GLib.SOURCE_REMOVE;
        }
        // Rotation follows border-animation-speed alone (see _repaintBorder).
        const period = this._borderRotationMs(this._settings.get_int('border-animation-speed'));
        const theta = period > 0 ? ((Date.now() / period) % 1) * Math.PI * 2 : 0;
        for (const effect of this._windowMasks.values()) {
            try { effect.setTheta(theta); } catch (_e) {}
        }
        for (const border of this._windowBorders.values()) {
            // St.DrawingArea only runs the cairo handler on ITS queue_repaint
            // (Clutter's queue_redraw repaints the cached texture), so the gradient
            // only rotates via queue_repaint. Plain St.Widgets have no queue_repaint.
            try {
                if (border.queue_repaint) border.queue_repaint();
            } catch (_e) {}
        }
        return GLib.SOURCE_CONTINUE;
    });
}

export function _stopBorderAnimation() {
    if (this._borderAnimId) {
        GLib.source_remove(this._borderAnimId);
        this._borderAnimId = 0;
    }
}

export function _syncBorderAnimation() {
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

export function _updateBordersDuringGrab() {
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
        const actor = win.get_compositor_private();
        // The window's actor can be replaced mid-session; a border on
        // the dead actor must not be poked (and is invisible anyway).
        if (!actor || border.get_parent() !== actor) {
            this._removeBorder(win);
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
        if (border.queue_repaint) {
            try { border.queue_repaint(); } catch (_e) {}
        }
    }
}

export function _removeAllBorders() {
    for (const border of this._windowBorders.values()) {
        try { border.destroy(); } catch (_e) {}
    }
    this._windowBorders.clear();
    if (this._scratchpadRings) {
        for (const ring of this._scratchpadRings.values()) {
            try { ring.destroy(); } catch (_e) {}
        }
        this._scratchpadRings.clear();
    }
}

export function _removeWidgetBorder(win) {
    // Border-only teardown (widget + scratch ring), without touching the mask —
    // unlike _removeBorder, which also destroys the mask (correct for
    // fullscreen/clear, wrong when the SDF border should take over).
    if (this._windowBorders.has(win)) {
        try { this._windowBorders.get(win).destroy(); } catch (_e) {}
        this._windowBorders.delete(win);
    }
    if (this._scratchpadRings && this._scratchpadRings.has(win)) {
        try { this._scratchpadRings.get(win).destroy(); } catch (_e) {}
        this._scratchpadRings.delete(win);
    }
}

export function _removeBorder(win) {
    const border = this._windowBorders.get(win);
    if (border) {
        try { border.destroy(); } catch (_e) {}
        this._windowBorders.delete(win);
    }
    if (this._scratchpadRings) {
        const ring = this._scratchpadRings.get(win);
        if (ring) {
            try { ring.destroy(); } catch (_e) {}
            this._scratchpadRings.delete(win);
        }
    }
    this._removeMask(win);
}


export const borderWidgetMethods = {
    _ensureWindowBorder,
    _applyDropdownEffects,
    _repaintBorder,
    _startBorderAnimation,
    _stopBorderAnimation,
    _syncBorderAnimation,
    _updateBordersDuringGrab,
    _removeAllBorders,
    _removeWidgetBorder,
    _removeBorder,
};
