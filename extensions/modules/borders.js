// Border widgets — the per-window cairo border (gradient, animated) and its
// teardown. The gradient geometry + rotation math lives in border-math.js.
//
// Methods live on this subsystem class.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import cairo from 'gi://cairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { PlaidSubsystem } from './subsystem.js';

export class Borders extends PlaidSubsystem {
    constructor(core) {
        super(core);
    }

    ensureWindowBorder(win, actor, frame, isFocused, settings = this.core._settings) {
        if (!frame || frame.width === 0 || frame.height === 0) return false;
        // Exactly-one-border (client-type rule). Wayland: the mask attaches to the
        // actor, so this widget is captured/clipped and can never render — the SDF is
        // the sole border. X11: the mask attaches to the surface child, so the widget
        // (on the actor) escapes the capture; borderBox keeps its stroke inside the
        // buffer, and a childless window uses a placeholder until the surface arrives.
        // Teardown is border-only (_removeWidgetBorder), never destroying the mask.
        if (settings.get_boolean('rounded-corners') &&
            settings.get_int('border-radius') > 0) {
            if (win.get_client_type() !== Meta.WindowClientType.X11) {
                this.removeWidgetBorder(win);
                return false;
            }
            // childless → fall through: create the placeholder widget
        }
        const activeWidth = settings.get_int('active-border-width');
        const activeColor = (settings.get_strv('active-border-color') || [])[0] || '#bd93f9';
        const activeColor2 = (settings.get_strv('active-border-color-2') || [])[0] || '#50fa7b';
        const inactiveWidth = settings.get_int('inactive-border-width');
        const inactiveColor = (settings.get_strv('inactive-border-color') || [])[0] || '#1e1f29';
        const inactiveColor2 = (settings.get_strv('inactive-border-color-2') || [])[0] || '#282a36';
        const borderRadius = settings.get_int('border-radius');
        const gradient = settings.get_boolean('gradient-borders');
        const gradientDir = settings.get_string('gradient-direction');

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
        const [borderX, borderY, borderW, borderH] =
            this.borderBox(win, frame, buffer, borderWidth);

        const old = this.core._windowBorders.get(win);
        // Scratch membership is part of the style: the outer ring lives on
        // the create path, so entering/leaving the scratchpad rebuilds. So is
        // whether the gradient rotates: stopping it redraws the static one.
        const scratch = !!(this.core._scratchpadWindows && this.core._scratchpadWindows.has(win));
        const style = [borderWidth, borderRadius, gradient ? 1 : 0, gradientDir, color1, color2,
            scratch ? 1 : 0, this.core.borderMath.borderRotationMs(settings.get_int('border-animation-speed')) > 0 ? 1 : 0].join('|');
        if (old) {
            // The window's actor can be REPLACED (X11 surface round-trips)
            // while the style stays identical — the border would linger on the
            // dead actor (invisible). The parent check forces a recreate on
            // the current actor.
            const alive = old.get_parent() === actor;
            const g = old._plaidGeom;
            const reshaped = !g || g[0] !== borderX || g[1] !== borderY || g[2] !== borderW || g[3] !== borderH;
            // Moved, resized or recoloured in place: a rebuild reallocates the
            // widget (a focus change recolours two). A scratch ring is laid
            // out on the create path only.
            if (alive && old._plaidStyle === style && !(scratch && reshaped)) {
                this.placeBorder(old, borderX, borderY, borderW, borderH);
                this.keepBorderOnTop(actor, old, win);
                return true;
            }
            if (alive && !scratch && !old._plaidScratch && !!old._plaidStrips === gradient) {
                this.restyleBorder(old, style, borderWidth, borderRadius, gradientDir, color1, color2);
                this.placeBorder(old, borderX, borderY, borderW, borderH, true);
                this.keepBorderOnTop(actor, old, win);
                return true;
            }
            this.destroyBorderWidget(old);
            this.core._windowBorders.delete(win);
        }

        let border;
        if (gradient) {
            // Four edge strips under a plain container: a window-sized cairo
            // surface was reallocated and uploaded on every size change, for
            // a stroke a few pixels wide. Each strip draws the same path,
            // translated and clipped to itself.
            border = new St.Widget({ reactive: false, visible: true });
            border._plaidStrips = [];
            border._plaidTokens = [];
            for (let i = 0; i < 4; i++) {
                const strip = new St.DrawingArea({ reactive: false });
                border._plaidTokens.push(this.connectObject(strip, 'repaint', () => this.repaintBorder(border, strip)));
                border.add_child(strip);
                border._plaidStrips.push(strip);
            }
        } else {
            border = new St.Widget({ name: 'tiling-border', reactive: false, visible: true });
        }
        // Plaid's own child of the window actor, never the client surface
        // (unwrapMaskActor).
        border._plaidOwned = true;
        this.restyleBorder(border, style, borderWidth, borderRadius, gradientDir, color1, color2);
        border._plaidScratch = scratch;
        this.placeBorder(border, borderX, borderY, borderW, borderH, true);
        actor.add_child(border);
        this.core._windowBorders.set(win, border);

        // Scratchpad windows get a Hyprland-style outer yellow ring: the
        // normal border stays, plus a flat ring outside it whose width
        // follows the user's active-border-width setting.
        if (this.core._scratchpadWindows && this.core._scratchpadWindows.has(win)) {
            // Ring creation is best-effort; a failure must not break the border.
            {
                const ringWidth = Math.max(2, activeWidth);
                const scratchColor =
                    (settings.get_strv('scratchpad-border-color') || [])[0] || '#f5c211';
                const [ringX, ringY, ringW, ringH] =
                    this.borderBox(win, frame, win.get_buffer_rect(), borderWidth + ringWidth);
                const ring = new St.Widget({
                    name: 'tiling-border',
                    x: ringX,
                    y: ringY,
                    width: ringW,
                    height: ringH,
                    style: `border: ${ringWidth}px solid ${scratchColor}; ` +
                        `border-radius: ${borderRadius + borderWidth + ringWidth}px; box-sizing: border-box;`,
                    reactive: false,
                    visible: true,
                });
                actor.add_child(ring);
                ring._plaidRing = true;
                ring._plaidOwned = true;
                const old = this.core._scratchpadRings.get(win);
                if (old)
                    old.destroy();
                this.core._scratchpadRings.set(win, ring);
            }
        }
        return true;
    }

    // The border paints above the client surface only as a later child: an
    // X11 client's surface child can be replaced (appended after it), and a
    // border kept in place would then sit under it. Rebuilds re-append.
    keepBorderOnTop(actor, border, win) {
        for (let c = actor.get_last_child(); c && c !== border; c = c.get_previous_sibling()) {
            if (c._plaidOwned) continue;
            actor.set_child_above_sibling(border, null);
            const ring = this.core._scratchpadRings?.get(win);
            if (ring && ring.get_parent() === actor) actor.set_child_above_sibling(ring, null);
            return;
        }
    }

    // A border widget and the strip handlers it holds.
    destroyBorderWidget(border) {
        for (const token of border._plaidTokens ?? []) this.disconnectToken(token);
        border._plaidTokens = null;
        border.destroy();
    }

    // A border's look: the gradient's colours, stroke and direction, or a
    // solid border's style. The caller lays it out again (placeBorder).
    restyleBorder(border, style, width, radius, direction, color1, color2) {
        border._plaidStyle = style;
        border._plaidWidth = width;
        if (!border._plaidStrips) {
            border.set_style(`border: ${width}px solid ${color1}; border-radius: ${radius}px; box-sizing: border-box;`);
            return;
        }
        const c1 = this.core.borderMath.hexToRgb(color1);
        const c2 = this.core.borderMath.hexToRgb(color2);
        border._plaidBorder = {
            color1: c1,
            color2: c2,
            width,
            radius,
            direction,
            thetaStep: this.core.borderMath.gradientThetaStep(c1, c2),
        };
    }

    // The border's box in the window actor: `width` around the frame. An X11
    // window actor repaints only its surface and shadow (mutter's paint volume
    // leaves Plaid's children out), so on X11 the box stays inside the buffer:
    // past its edge (a frameless window with no shadow) the border would leave
    // trails as the window moves.
    borderBox(win, frame, buffer, width) {
        let x = frame.x - buffer.x - width, y = frame.y - buffer.y - width;
        let x2 = x + frame.width + width * 2, y2 = y + frame.height + width * 2;
        if (win.get_client_type() === Meta.WindowClientType.X11) {
            x = Math.max(0, x);
            y = Math.max(0, y);
            x2 = Math.min(buffer.width, x2);
            y2 = Math.min(buffer.height, y2);
        }
        return [x, y, x2 - x, y2 - y];
    }

    // Moves and sizes a border to its window; a border already there is left
    // alone (the grab loop calls this for every border on every frame). A
    // gradient's strips are laid out when the size changes, or on `force` (a
    // new look), and each is drawn once: St redraws a resized DrawingArea at
    // the next frame by itself, and queue_repaint draws at once, every call.
    placeBorder(border, x, y, w, h, force = false) {
        const g = border._plaidGeom;
        const resized = force || !g || g[2] !== w || g[3] !== h;
        if (!resized && g[0] === x && g[1] === y) return false;
        border._plaidGeom = [x, y, w, h];
        border.set_position(x, y);
        if (!resized) return true;
        border.set_size(w, h);
        if (border._plaidStrips) {
            border._plaidPaintTheta = this.borderAngle()[1];
            const rects = this.core.borderMath.borderStripRects(border._plaidBorder, w, h);
            for (const [i, strip] of border._plaidStrips.entries()) {
                const r = rects[i];
                // Against the size last drawn, not the one last asked for: a
                // size changed and changed back before a layout is no change to St.
                const d = strip._plaidDrawn;
                const own = !d || d[0] !== r.w || d[1] !== r.h;
                strip._plaidOrigin = [r.x, r.y];
                strip.set_position(r.x, r.y);
                strip.set_size(r.w, r.h);
                strip.visible = r.w > 0 && r.h > 0;
                // Same size, new content (the gradient spans the whole border).
                // A hidden strip is empty, a size never drawn.
                if (!own) strip.queue_repaint();
            }
        }
        return true;
    }

    // Whether the gradient rotates, and its angle now. Rotation speed comes
    // from border-animation-speed alone; slow_down_factor is an accessibility
    // lever for placement, not rotation. The period is read once per setting
    // change (forgetRotation).
    borderAngle() {
        this._rotationMs ??= this.core.borderMath.borderRotationMs(this.core._settings.get_int('border-animation-speed'));
        const period = this._rotationMs;
        return period > 0 ? [true, ((Date.now() / period) % 1) * Math.PI * 2] : [false, 0];
    }

    forgetRotation() {
        this._rotationMs = undefined;
    }

    // Where a window's frame sits in its buffer, and their sizes: all a
    // border, mask or blur sibling is laid out from (relative to the actor).
    passGeom(win) {
        const f = win.get_frame_rect(), b = win.get_buffer_rect();
        return `${f.x - b.x},${f.y - b.y},${f.width},${f.height},${b.width},${b.height}`;
    }

    forgetPass(win) {
        win._plaidPassGeom = undefined;
    }

    // Whether the live resize tick lays out this window's border: an existing,
    // non-scratch border on the window's actor, on the grabbed window's
    // monitor, not fullscreen (and tiling on: the tick places none without).
    // Anything else still gets its pass.
    tickPlaces(win) {
        const border = this.core._windowBorders?.get(win);
        const grabbed = this.core._grabWindow;
        return !!border && !!grabbed && !border._plaidScratch && !win.is_fullscreen() &&
            border.get_parent() === win.get_compositor_private() && win.get_monitor() === grabbed.get_monitor();
    }

    // What this pass laid the window out from (noteGeometry). A window still
    // waiting for its warp is left unrecorded: its blur waits for a later pass.
    notePass(win) {
        if (!this.core._pendingWarp?.has(win)) win._plaidPassGeom = this.passGeom(win);
    }

    // A window moved or was resized (position-changed, size-changed). No pass
    // when it would change nothing: a move that keeps the window where the
    // last pass saw it inside its buffer (everything it lays out moves with
    // the actor), or a change while a live resize lays out the window's
    // border (tickPlaces) and no mask or blur needs a pass (the grab end runs
    // one).
    noteGeometry(win) {
        if (!this.core._settings) return;
        if (this.core.grab.resizeLoopRunning() && this.core._settings.get_boolean('enabled') && this.tickPlaces(win) &&
            !this.core._settings.get_boolean('window-blur') &&
            !(this.core._settings.get_boolean('rounded-corners') && this.core._settings.get_int('border-radius') > 0))
            return;
        if (win._plaidPassGeom === this.passGeom(win)) return;
        this.updateBorders();
    }

    // Redraws a gradient border (every strip, at one angle); a solid border
    // has nothing to redraw.
    queueBorderRepaint(border) {
        border._plaidPaintTheta = this.borderAngle()[1];
        for (const strip of border._plaidStrips ?? []) {
            if (strip.visible) strip.queue_repaint();
        }
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

    // Draws a gradient border, or the part of it in one strip, translated to
    // the strip. A static gradient is linear along its direction: one stroke
    // of the rounded rect with a cairo gradient. A rotating one is drawn in
    // runs of segments, limited to those whose stroke can reach the strip.
    repaintBorder(border, strip = null) {
        try {
            const info = border._plaidBorder;
            const area = strip ?? border;
            if (!info || !area.get_context) return;
            const [w, h] = border._plaidGeom ? border._plaidGeom.slice(2) : [border.width, border.height];
            if (w <= 0 || h <= 0) return;
            const path = this.core.borderMath.borderPath(info, w, h);
            if (!path) return;
            const [ox, oy] = strip?._plaidOrigin ?? [0, 0];

            const bw = info.width;
            // The angle queued with the repaint: the four strips draw one.
            const [animated, now] = this.borderAngle();
            const theta = animated ? (border._plaidPaintTheta ?? now) : 0;
            border._plaidTheta = theta;

            const cr = area.get_context();
            // The surface this draw fills: during a pending allocation the
            // old one, which is what St compares a new allocation against.
            area._plaidDrawn = area.get_surface_size ? area.get_surface_size() : [area.width, area.height];
            cr.translate(-ox, -oy);
            cr.setLineWidth(bw);
            cr.setLineCap(cairo.LineCap.ROUND);
            // One path per run of same-colour segments (a stroke each is hundreds of
            // GI calls per repaint); round joins match separate round caps.
            cr.setLineJoin(cairo.LineJoin.ROUND);

            if (!animated) {
                const [gx0, gy0, gx1, gy1] = this.core.borderMath.borderGradientLine(w, h, info.direction);
                const pattern = new cairo.LinearGradient(gx0, gy0, gx1, gy1);
                pattern.addColorStopRGB(0, info.color1.r, info.color1.g, info.color1.b);
                pattern.addColorStopRGB(1, info.color2.r, info.color2.g, info.color2.b);
                cr.setSource(pattern);
                const { x, y, pw, ph, r } = path;
                cr.moveTo(x + r, y);
                cr.lineTo(x + pw - r, y);
                cr.arc(x + pw - r, y + r, r, -Math.PI / 2, 0);
                cr.lineTo(x + pw, y + ph - r);
                cr.arc(x + pw - r, y + ph - r, r, 0, Math.PI / 2);
                cr.lineTo(x + r, y + ph);
                cr.arc(x + r, y + ph - r, r, Math.PI / 2, Math.PI);
                cr.lineTo(x, y + r);
                cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
                cr.closePath();
                cr.stroke();
                cr.$dispose();
                return;
            }

            const segs = this.core.borderMath.buildBorderSegments(border, w, h);
            if (segs.length === 0) return;
            const reach = info.width / 2 + 1;
            const x0 = ox - reach, y0 = oy - reach;
            const x1 = ox + area.width + reach, y1 = oy + area.height + reach;

            // Every strip of one repaint shares the runs (same segments, look
            // and angle).
            let runs = border._plaidRuns;
            if (!runs || runs.segs !== segs || runs.info !== info || runs.theta !== theta) {
                runs = { segs, info, theta,
                    list: this.core.borderMath.borderRuns(segs, w, h, info, animated, theta) };
                border._plaidRuns = runs;
            }
            // The segments whose stroke can reach this strip, found once per
            // shape (the strips follow the segments' size).
            const reachKey = `${x0},${y0},${x1},${y1}`;
            let reached = runs.reach?.get(reachKey);
            if (!reached) {
                reached = [];
                for (const [i, seg] of segs.entries()) {
                    if (Math.max(seg.x0, seg.x1) >= x0 && Math.min(seg.x0, seg.x1) <= x1 &&
                        Math.max(seg.y0, seg.y1) >= y0 && Math.min(seg.y0, seg.y1) <= y1)
                        reached.push(i);
                }
                (runs.reach ??= new Map()).set(reachKey, reached);
            }
            let runKey = -1;
            let endX = 0, endY = 0, dirX = 0, dirY = 0;
            let prev = -2;
            for (const i of reached) {
                const seg = segs[i];
                // A gap (segments outside the strip) ends the run: their
                // stroke draws nothing here, so the cut changes no pixel.
                if (i !== prev + 1 && runKey >= 0) {
                    cr.lineTo(endX, endY);
                    cr.stroke();
                    runKey = -1;
                }
                prev = i;
                const { key, c } = runs.list[i];
                const sx = seg.x1 - seg.x0;
                const sy = seg.y1 - seg.y0;
                if (key !== runKey) {
                    if (runKey >= 0) {
                        cr.lineTo(endX, endY);
                        cr.stroke();
                    }
                    runKey = key;
                    cr.setSourceRGB(c.r, c.g, c.b);
                    cr.moveTo(seg.x0, seg.y0);
                    dirX = sx;
                    dirY = sy;
                } else if (Math.abs(sx * dirY - sy * dirX) > 1e-6 * (sx * sx + sy * sy) ||
                           sx * dirX + sy * dirY <= 0) {
                    cr.lineTo(endX, endY);
                    dirX = sx;
                    dirY = sy;
                }
                endX = seg.x1;
                endY = seg.y1;
            }
            if (runKey >= 0) {
                cr.lineTo(endX, endY);
                cr.stroke();
            }
            cr.$dispose();
        } catch (e) {
            this.core.debugLog(`repaint FAILED: ${e.message}`);
        }
    }

    startBorderAnimation() {
        if (this.core._borderAnimId || this.core._shuttingDown) return;

        if (!this.core._settings.get_boolean('gradient-borders')) return;
        if (this.core._settings.get_int('border-animation-speed') <= 0) return;

        this.core.debugLog(`border animation: start (borders=${this.core._windowBorders.size} masks=${this.core._windowMasks.size})`);
        this.core._borderAnimId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
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
            if (!this.borderAnimationNeeded()) {
                this.core.debugLog(`border animation: stop (idle) (borders=${this.core._windowBorders.size} masks=${this.core._windowMasks.size})`);
                this.stopBorderAnimation();
                return GLib.SOURCE_REMOVE;
            }

            // Rotation follows border-animation-speed alone (see _repaintBorder).
            const period = this.core.borderMath.borderRotationMs(this.core._settings.get_int('border-animation-speed'));
            const theta = period > 0 ? ((Date.now() / period) % 1) * Math.PI * 2 : 0;
            // Re-render only while visible (mapped or in the overview) and once the
            // colour moved a level (gradientThetaStep).
            const math = this.core.borderMath;
            const overview = Main.overview.visible;
            for (const effect of this.core._windowMasks.values()) {
                if (!math.gradientStale(effect._plaidTheta, theta, effect._plaidThetaStep)) continue;
                const target = effect.get_actor();
                if (!target || !(overview || target.mapped)) continue;
                effect._plaidTheta = theta;
                effect.setTheta(theta);
            }
            for (const border of this.core._windowBorders.values()) {
                const info = border._plaidBorder;
                if (!info || !(overview || border.mapped)) continue;
                if (!math.gradientStale(border._plaidTheta, theta, info.thetaStep)) continue;
                // St.DrawingArea only runs the cairo handler on ITS queue_repaint
                // (Clutter's queue_redraw repaints the cached texture), so the gradient
                // only rotates via queue_repaint. Plain St.Widgets (no _plaidBorder)
                // have nothing to animate.
                border._plaidTheta = theta;
                this.queueBorderRepaint(border);
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    // A gradient whose rotation is visible: a two-colour cairo border, or a mask
    // drawing its SDF border (borderless masks only round corners).
    borderAnimationNeeded() {
        for (const border of this.core._windowBorders.values()) {
            if (border._plaidBorder && border._plaidBorder.thetaStep < Infinity) return true;
        }
        for (const effect of this.core._windowMasks.values()) {
            if (effect._plaidThetaStep < Infinity) return true;
        }
        return false;
    }

    stopBorderAnimation() {
        if (this.core._borderAnimId) {
            GLib.source_remove(this.core._borderAnimId);
            this.core._borderAnimId = 0;
        }
    }

    syncBorderAnimation() {
        if (!this.core._settings) return;
        const wantAnim = this.core._settings.get_boolean('gradient-borders') &&
            this.core._settings.get_int('border-animation-speed') > 0 &&
            this.borderAnimationNeeded();
        if (wantAnim)
            this.startBorderAnimation();
        else
            this.stopBorderAnimation();
    }

    // Memo of the settings for one borders pass (it runs after every commit and
    // re-reads ~12 keys per window). Keys cannot change mid-pass.
    settingsMemo() {
        const settings = this.core._settings;
        const memo = new Map();
        const read = (getter, key) => {
            const k = `${getter}:${key}`;
            if (!memo.has(k)) memo.set(k, settings[getter](key));
            return memo.get(k);
        };
        return {
            get_boolean: key => read('get_boolean', key),
            get_int: key => read('get_int', key),
            get_string: key => read('get_string', key),
            get_strv: key => read('get_strv', key),
        };
    }

    // Every border follows its window through a grab, at the stroke it was
    // drawn with (the borders pass restyles a focus change). Only a border
    // whose rect changed is touched (placeBorder).
    updateBordersDuringGrab() {
        if (!this.core._settings || !this.core._settings.get_boolean('enabled')) return;
        for (const [win, border] of this.core._windowBorders.entries()) {
            const actor = win.get_compositor_private();
            // The window's actor can be replaced mid-session; a border on
            // the dead actor must not be poked (and is invisible anyway).
            if (!actor || border.get_parent() !== actor) {
                this.removeBorder(win);
                continue;
            }
            const frame = win.get_frame_rect();
            if (frame.width === 0 || frame.height === 0) continue;
            const buffer = win.get_buffer_rect();
            // A scratch border is laid out with its ring, on the pass after.
            if (border._plaidScratch) continue;
            this.placeBorder(border, ...this.borderBox(win, frame, buffer, border._plaidWidth ?? 0));
        }
    }

    removeAllBorders() {
        for (const border of this.core._windowBorders.values()) {
            this.destroyBorderWidget(border);
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
            this.destroyBorderWidget(this.core._windowBorders.get(win));
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
            this.destroyBorderWidget(border);
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

        const settings = this.settingsMemo();
        const borderRadius = settings.get_int('border-radius');
        const roundedCorners = settings.get_boolean('rounded-corners');
        const bordersEnabled = settings.get_boolean('borders-enabled');
        const blurEnabled = settings.get_boolean('window-blur');

        // No Flair: skip the per-window walk, which runs after every commit.
        if (!bordersEnabled && !(roundedCorners && borderRadius > 0) && !blurEnabled) {
            this.removeAllBorders();
            this.core.masks.removeAllMasks();
            this.core.blur.removeAllBlurs();
            if (this.core._dropdownWin)
                this.applyDropdownEffects(this.core._dropdownWin);
            this.syncBorderAnimation();
            return;
        }

        // Only sweep ALL borders when the feature turned off — otherwise
        // _ensureWindowBorder's per-window style gate skips unchanged
        // windows (destroy/recreate churn on every focus change is the
        // biggest steady-state cost under hover-focus).
        if (!bordersEnabled)
            this.removeAllBorders();

        const ws = global.workspace_manager.get_active_workspace();
        if (!ws) return;

        const windows = this.core.windows.getWindowsForWorkspace(ws);
        for (const win of windows) {
            // Recorded again only once this pass lays the window out
            // (notePass): one stripped or skipped here is not.
            this.forgetPass(win);
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
            this.notePass(win);

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
                    this.destroyBorderWidget(this.core._windowBorders.get(win));
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
                    this.ensureWindowBorder(win, actor, frame, isFocused, settings);
                this.core.masks.ensureWindowMask(win, actor, borderRadius + 1, settings);
                // Scratch windows fall through to their special border even
                // with rounded corners (normal windows stay mask-only).
                if (!scratch)
                    continue;
            }

            if (bordersEnabled) this.ensureWindowBorder(win, actor, frame, isFocused, settings);
        }

        // Floating windows are not in _windowWSIndices (they skip _addWindow),
        // so the tiled loop above misses them. Apply Flair directly.
        for (const win of ws.list_windows()) {
            if (win.get_window_type() !== Meta.WindowType.NORMAL) continue;
            if (!this.core.windows.isFloating(win)) continue;
            this.forgetPass(win);
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
            this.notePass(win);
            if (blurEnabled) this.core.blur.ensureWindowBlur(win, actor);
            const isFocused = win === focusWindow;
            // Order matters: create the WIDGET border before the mask —
            // _updateMaskBounds zeroes the SDF border when a renderable
            // widget exists, so creating the widget first avoids a
            // first-pass (or transition-pass) transient double border.
            if (bordersEnabled) this.ensureWindowBorder(win, actor, frame, isFocused, settings);
            if (roundedCorners && borderRadius > 0)
                this.core.masks.ensureWindowMask(win, actor, borderRadius + 1, settings);
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
