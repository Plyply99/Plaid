// Corner mask — clips window content to a rounded rect and draws the SDF
// border + scratch ring. Dual-compat: a Shell.GLSLEffect subclass on GNOME 50,
// a Clutter.ShaderEffect (new_with_snippet) on GNOME 51.
//
// Methods are attached to TilingWMExtension.prototype in extension.js.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import { maskSdfRect } from './helpers.js';

const MASK_EFFECT_NAME = 'plaid-corner-mask';

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
uniform vec4 ringColor;
uniform float ringWidth;
uniform vec4 ringAreaBounds;
uniform float ringAreaClipRadius;
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

    if (borderWidth > 0.5) {
        float borderedAreaAlpha = getPointOpacity(p, borderedAreaBounds, borderedAreaClipRadius);
        float borderAlpha = clamp(abs(pointAlpha - borderedAreaAlpha), 0.0, 1.0);
        if (borderAlpha > 0.0) {
            vec3 gradColor = mix(borderColor1.rgb, borderColor2.rgb, gradientPos(p, bounds));
            cogl_color_out = mix(cogl_color_out, vec4(gradColor, 1.0), borderAlpha * borderColor1.a);
        }
        if (ringWidth > 0.5) {
            float ringAreaAlpha = getPointOpacity(p, ringAreaBounds, ringAreaClipRadius);
            float ringAlpha = clamp(borderedAreaAlpha - ringAreaAlpha, 0.0, 1.0);
            if (ringAlpha > 0.0)
                cogl_color_out = mix(cogl_color_out, vec4(ringColor.rgb, 1.0), ringAlpha * ringColor.a);
        }
    }

    // Opacity applies to the final output — content, border, and ring alike —
    // so a hidden window (opacity 0) shows nothing, including its Flair.
    cogl_color_out *= opacity;
`;

// Shell.SnippetHook (the old fallback arm) does not exist on GNOME 50/51 —
// referencing it threw at MODULE LOAD if Cogl.SnippetHook were ever absent.
// Optional chaining keeps the load safe; the creation paths handle undefined.
const SNIPPET_HOOK_FRAGMENT = Cogl.SnippetHook?.FRAGMENT;

// The GNOME 50 mask class must never be registered on GNOME 51 (its vfuncs
// no longer exist there), so registration is lazy — and it must register
// exactly once per process, so the result is cached.
let CornerMaskEffectClass = null;
export function _unwrapMaskActor(actor, win) {
    if (!actor) return null;
    if (win.get_client_type() === Meta.WindowClientType.X11) {
        // The client surface is the first non-Plaid child; our border/ring
        // widgets can occupy the first-child slot, so treating them as the mask
        // target nested borders and grew them each pass.
        let child = actor.get_first_child();
        while (child) {
            if (!child._plaidSig && !child._plaidBorder && !child._plaidRing)
                return child;
            child = child.get_next_sibling();
        }
        return null;
    }
    return actor;
}

export function _createMaskEffect() {
    // Dual-compat: GNOME 50 uses a Shell.GLSLEffect subclass (location-based
    // uniforms, set_shader_source); GNOME 51 uses a Clutter.ShaderEffect built
    // via new_with_snippet (name-based uniforms). The GLSL + geometry are shared.
    if (!(Clutter.ShaderEffect && Clutter.ShaderEffect.new_with_snippet)) {
        try {
        if (!CornerMaskEffectClass) {
            CornerMaskEffectClass = GObject.registerClass({
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
                        ringColor: this.get_uniform_location('ringColor'),
                        ringWidth: this.get_uniform_location('ringWidth'),
                        ringAreaBounds: this.get_uniform_location('ringAreaBounds'),
                        ringAreaClipRadius: this.get_uniform_location('ringAreaClipRadius'),
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
                            const w = Math.max(1, actor.width);
                            const h = Math.max(1, actor.height);
                            const loc = this._uniformLocations;
                            // Authoritative clamped rect on GNOME 50: this per-paint
                            // re-derivation would otherwise stomp the clamp uploaded
                            // by updateMask (top border drawn above the capture).
                            this.set_uniform_float(loc.bounds, 4,
                                maskSdfRect(this._metaWin, actor));
                            this.set_uniform_float(loc.pixelStep, 2, [1 / w, 1 / h]);
                        }
                    } catch (e) {
                        log(`[plaid] mask paint sync failed: ${e.message}`);
                    }
                    super.vfunc_paint_target(node, paintContext);
                }

                updateMask(x1, y1, x2, y2, radius, borderWidth, color1, color2, mode, theta, opacity, ringWidth, ringColor) {
                    this._radius = radius;
                    const loc = this._uniformLocations;
                    try {
                        const actor = this.get_actor();
                        const w = Math.max(1, actor ? actor.width : 1);
                        const h = Math.max(1, actor ? actor.height : 1);
                        const inset = Math.max(0, borderWidth);
                        const rw = Math.max(0, ringWidth || 0);
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
                        this.set_uniform_float(loc.ringWidth, 1, [rw]);
                        this.set_uniform_float(loc.ringColor, 4, ringColor || [0, 0, 0, 0]);
                        this.set_uniform_float(loc.ringAreaBounds, 4, [x1 + inset + rw, y1 + inset + rw, x2 - inset - rw, y2 - inset - rw]);
                        this.set_uniform_float(loc.ringAreaClipRadius, 1, [Math.max(0, radius - inset - rw)]);
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

                // Clutter's offscreen paint hardcodes opacity 255, so
                // actor.set_opacity(0) does not hide rounded windows — the shader's
                // own 'opacity' uniform is the effective visibility control.
                setOpacityUniform(v) {
                    try {
                        this.set_uniform_float(this._uniformLocations.opacity, 1, [v]);
                    } catch (_e) {
                        return;
                    }
                    this.queue_repaint();
                }

            });
        }
        return new CornerMaskEffectClass();
        } catch (e) {
            log(`[plaid] mask shader failed: ${e.message}`);
            return null;
        }
    }
    let snippet = null;
    try {
        snippet = Cogl.Snippet.new(SNIPPET_HOOK_FRAGMENT, MASK_SNIPPET_DECLARATIONS, MASK_SNIPPET_CODE);
    } catch (e) {
        log(`[plaid] mask snippet failed: ${e.message}`);
        return null;
    }
    let effect = null;
    try {
        effect = Clutter.ShaderEffect.new_with_snippet(snippet);
    } catch (e) {
        log(`[plaid] mask shader failed: ${e.message}`);
        return null;
    }
    effect._radius = 0;
    effect._metaWin = null;

    const setUniform = (name, nComponents, values) => {
        try {
            effect.set_uniform_float(name, nComponents, values);
        } catch (e) {
            log(`[plaid] mask uniform '${name}' failed: ${e.message}`);
        }
    };

    effect.updateMask = (x1, y1, x2, y2, radius, borderWidth, color1, color2, mode, theta, opacity, ringWidth, ringColor) => {
        effect._radius = radius;
        try {
            const actor = effect.get_actor();
            const w = Math.max(1, actor ? actor.width : 1);
            const h = Math.max(1, actor ? actor.height : 1);
            const inset = Math.max(0, borderWidth);
            const rw = Math.max(0, ringWidth || 0);
            setUniform('bounds', 4, [x1, y1, x2, y2]);
            setUniform('clipRadius', 1, [radius]);
            setUniform('pixelStep', 2, [1 / w, 1 / h]);
            setUniform('borderedAreaBounds', 4, [x1 + inset, y1 + inset, x2 - inset, y2 - inset]);
            setUniform('borderedAreaClipRadius', 1, [Math.max(0, radius - inset)]);
            setUniform('borderWidth', 1, [borderWidth]);
            setUniform('borderColor1', 4, color1);
            setUniform('borderColor2', 4, color2);
            setUniform('gradientMode', 1, [mode]);
            setUniform('theta', 1, [theta]);
            setUniform('opacity', 1, [opacity]);
            setUniform('ringWidth', 1, [rw]);
            setUniform('ringColor', 4, ringColor || [0, 0, 0, 0]);
            setUniform('ringAreaBounds', 4, [x1 + inset + rw, y1 + inset + rw, x2 - inset - rw, y2 - inset - rw]);
            setUniform('ringAreaClipRadius', 1, [Math.max(0, radius - inset - rw)]);
        } catch (e) {
            log(`[plaid] mask uniforms failed: ${e.message}`);
            return;
        }
        effect.queue_repaint();
        global.stage.queue_redraw();
    };

    effect.setTheta = (theta) => {
        try {
            effect.set_uniform_float('theta', 1, [theta]);
            if (effect.invalidate)
                effect.invalidate();
            global.stage.queue_redraw();
        } catch (_e) {}
    };

    effect.setBorderWidth = (width) => {
        try {
            effect.set_uniform_float('borderWidth', 1, [width]);
            if (effect.invalidate)
                effect.invalidate();
            global.stage.queue_redraw();
        } catch (_e) {}
    };

    effect.setOpacityUniform = (v) => {
        try {
            effect.set_uniform_float('opacity', 1, [v]);
            if (effect.invalidate)
                effect.invalidate();
            global.stage.queue_redraw();
        } catch (_e) {}
        };

    return effect;
}

export function _ensureWindowMask(win, actor, radius) {
    if (!this._windowMasks || !actor || !actor.add_effect_with_name) return;
    // Mask self-heal quarantine: a texture swap rendered the offscreen capture
    // empty, so the mask was dropped and must NOT be re-created or content goes
    // invisible again. Only a rounded-corners toggle clears it.
    if (this._maskQuarantined && this._maskQuarantined.has(win)) return;
    const target = this._unwrapMaskActor(actor, win);
    // The mask attaches to the X11 client child once; if the child is replaced
    // (workspace round-trips) the mask is lost and corners go square — benign.
    // Re-targeting the replaced child is NOT benign (empty capture → invisible
    // content), so never re-target.
    if (!target || !target.add_effect_with_name) return;
    // Radius clamp: _updateMaskBounds stores the CLAMPED radius on the effect,
    // so compare against the clamped value — comparing the unclamped caller
    // radius recreated the effect every borders pass for small windows. Use the
    // Meta rect while the actor is unsized so the radius never collapses to 0.
    const size = _clampSize(win, actor);
    if (size.w <= 2 || size.h <= 2)
        return; // not sized yet — a later borders pass attaches correctly
    radius = Math.max(0, Math.min(radius,
        Math.floor(size.w / 2),
        Math.floor(size.h / 2)));
    let effect = this._windowMasks.get(win);
    if (effect && effect._radius !== radius) {
        this._teardownMaskEffect(win, effect);
        this._windowMasks.delete(win);
        effect = null;
    }
    if (!effect) {
        effect = this._createMaskEffect();
        if (!effect) return;
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
        effect._watchActor = target;
        effect._sizeWatchId = target.connect('notify::size', () => {
            this._connectTextureWatch(win, actor, effect);
            this._scheduleMaskRedraw(win, actor, effect);
        });
        this._connectTextureWatch(win, actor, effect);
    }
    this._updateMaskBounds(win, actor, effect, radius);
    target.queue_redraw();
}

export function _connectTextureWatch(win, actor, effect) {
    if (effect._textureWatchId) {
        effect._watchTexture.disconnect(effect._textureWatchId);
        effect._textureWatchId = 0;
    }
    let texture = null;
    if (actor && actor.get_texture)
        texture = actor.get_texture();
    if (texture && texture.connect) {
        effect._watchTexture = texture;
        effect._textureWatchId = texture.connect('size-changed', () => {
            this._scheduleMaskRedraw(win, actor, effect);
        });
    }
}

export function _scheduleMaskRedraw(win, actor, effect) {
    if (effect._refreshTimeoutId) {
        GLib.source_remove(effect._refreshTimeoutId);
    }
    effect._refreshTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        effect._refreshTimeoutId = 0;
        if (!this._settings) return GLib.SOURCE_REMOVE;
        this._debugLog(`mask redraw kick r=${effect._radius}`);
        this._updateMaskBounds(win, actor, effect, effect._radius);
        this._ensureWindowBlur(win, actor);
        const target = this._unwrapMaskActor(actor, win);
        if (target) {
            try { target.invalidate_paint_volume(); } catch (_e) {}
        }
        try { actor.invalidate_paint_volume(); } catch (_e) {}
        global.stage.queue_redraw();
        return GLib.SOURCE_REMOVE;
    });
}

export function _kickMaskNow(win) {
    if (!this._windowMasks) return;
    const effect = this._windowMasks.get(win);
    if (!effect) return;
    if (effect._refreshTimeoutId) {
        GLib.source_remove(effect._refreshTimeoutId);
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
    global.stage.queue_redraw();
}

// A window can be flaired BEFORE its actor is sized (portal dialogs and file
// pickers map fast) — clamping the radius against an unsized actor collapsed it
// to 0 and left the window permanently square. Fall back to the window's Meta
// rect, which is already valid at map time.
function _clampSize(win, actor) {
    const aw = Math.floor((actor && actor.width) || 0);
    const ah = Math.floor((actor && actor.height) || 0);
    if (aw > 2 && ah > 2)
        return { w: aw, h: ah };
    try {
        const r = win.get_buffer_rect();
        if (r.width > 2 && r.height > 2)
            return { w: r.width, h: r.height };
    } catch (_e) {}
    try {
        const r = win.get_frame_rect();
        if (r.width > 2 && r.height > 2)
            return { w: r.width, h: r.height };
    } catch (_e) {}
    return { w: aw, h: ah };
}

export function _updateMaskBounds(win, actor, effect, radius) {
    // Mask self-heal: X11 foreign-texture surfaces (Chromium/electron) can swap
    // their texture on workspace round-trips, making the offscreen capture empty.
    // Drop the mask (square corners) rather than render invisible; a
    // rounded-corners toggle clears it.
    if (win.get_client_type() === Meta.WindowClientType.X11) {
        const target = this._unwrapMaskActor(actor, win);
        if (target && target.get_texture) {
            const tex = target.get_texture();
            if (effect._texId && tex && tex !== effect._texId) {
                this._debugLog(`mask self-heal: texture replaced — dropping mask for ${win.get_wm_class_instance() || '?'}`);
                this._maskQuarantined.add(win);
                // Teardown inline — _removeMask would delete the
                // quarantine we just set.
                this._teardownMaskEffect(win, effect);
                this._windowMasks.delete(win);
                return;
            }
            effect._texId = tex;
        }
    }
    const buffer = win.get_buffer_rect();
    const frame = win.get_frame_rect();
    const offsetX = frame.x - buffer.x;
    const offsetY = frame.y - buffer.y;

    let borderWidth = 0;

    // Clamp the SDF radius to half the window — a radius wider than the
    // window inverts the rounded-rect SDF (centerLeft > centerRight). Use the
    // Meta rect when the actor is not sized yet (see _clampSize).
    const clampSize = _clampSize(win, actor);
    radius = Math.max(0, Math.min(radius,
        Math.floor(Math.max(1, clampSize.w) / 2),
        Math.floor(Math.max(1, clampSize.h) / 2)));
    if (this._settings) {
        const isFocused = win === global.display.focus_window;
        const widthKey = isFocused ? 'active-border-width' : 'inactive-border-width';
        borderWidth = (this._grabWindow === win)
            ? 0
            : (this._settings.get_boolean('borders-enabled')
                ? this._settings.get_int(widthKey)
                : 0);
    }

    // Exactly-one-border (client-type rule). X11: the mask attaches to the
    // surface child, so the sibling widget escapes the capture and IS the border —
    // zero the SDF or both draw. Wayland: the mask attaches to the actor, so the
    // widget is clipped and can never show — the SDF is always the border.
    // Tiled windows have no widget (mask-only), so the SDF is unchanged.
    if (this._windowBorders.has(win) &&
        win.get_client_type() === Meta.WindowClientType.X11 &&
        offsetX >= borderWidth && offsetY >= borderWidth)
        borderWidth = 0;

    // Shared clamped rect (see maskSdfRect in helpers.js) — both uniform paths
    // must use it.
    const [x1, y1, x2, y2] = maskSdfRect(win, actor);

    if (!this._settings) {
        effect.updateMask(x1, y1, x2, y2, radius, borderWidth, [0.5, 0.5, 0.5, 1], [0.5, 0.5, 0.5, 1], 0, 0, 0, 0, [0, 0, 0, 0]);
        return;
    }

    const isFocused = win === global.display.focus_window;
    const color1Key = isFocused ? 'active-border-color' : 'inactive-border-color';
    const color2Key = isFocused ? 'active-border-color-2' : 'inactive-border-color-2';
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
        // Rotation follows border-animation-speed alone (see _repaintBorder).
        theta = ((Date.now() / period) % 1) * Math.PI * 2;
    } else {
        const dir = this._settings.get_string('gradient-direction');
        if (dir === 'horizontal')
            mode = 1;
        else if (dir === 'diagonal')
            mode = 2;
    }

    const blurEnabled = this._settings.get_boolean('window-blur');
    let opacity = blurEnabled
        ? this._settings.get_int('window-blur-opacity') / 100
        : 1;
    // A window hidden for its spawn choreography (actor opacity is ignored
    // by the offscreen mask) must stay invisible through the shader
    // uniform until it lands at its slot.
    if (this._pendingWarp && this._pendingWarp.has(win))
        opacity = 0;

    const scratchWin = !!(this._scratchpadWindows && this._scratchpadWindows.has(win));
    let ringWidth = 0;
    let ringColor = [0, 0, 0, 0];
    if (scratchWin && this._settings.get_boolean('borders-enabled')) {
        ringWidth = Math.max(2, this._settings.get_int('active-border-width'));
        const ringHex = (this._settings.get_strv('scratchpad-border-color') || [])[0] || '#f5c211';
        ringColor = toRgba(ringHex);
        if (!effect._ringLogged) {
            effect._ringLogged = true;
            this._debugLog(`scratch ring: shader ring enabled width=${ringWidth} color=${ringHex}`);
        }
    }

    // Same rule for the scratch ring: the widget ring shows only on X11
    // (outside the capture); on Wayland it is clipped, so the shader ring stays.
    if (this._scratchpadRings && this._scratchpadRings.has(win) &&
        ringWidth > 0 &&
        win.get_client_type() === Meta.WindowClientType.X11 &&
        offsetX >= borderWidth + ringWidth && offsetY >= borderWidth + ringWidth) {
        ringWidth = 0;
        ringColor = [0, 0, 0, 0];
    }

    if (this._scratchpadWindows && this._scratchpadWindows.has(win)) {
        this._debugLog(`mask uniforms: ${win.get_wm_class_instance() || '?'} ring=${ringWidth} bw=${borderWidth} eff=${effect.get_actor() ? 'attached' : 'DETACHED'}`);
    }
    effect.updateMask(x1, y1, x2, y2, radius, borderWidth, color1, color2, mode, theta, opacity, ringWidth, ringColor);
}

export function _teardownMaskEffect(win, effect) {
    if (effect._refreshTimeoutId) {
        GLib.source_remove(effect._refreshTimeoutId);
        effect._refreshTimeoutId = 0;
    }
    effect._metaWin = null;
    if (effect._sizeWatchId) {
        effect._watchActor.disconnect(effect._sizeWatchId);
        effect._sizeWatchId = 0;
    }
    if (effect._textureWatchId) {
        effect._watchTexture.disconnect(effect._textureWatchId);
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

export function _removeMask(win) {
    if (!this._windowMasks) return;
    if (this._maskQuarantined) this._maskQuarantined.delete(win);
    const effect = this._windowMasks.get(win);
    if (!effect) return;
    this._teardownMaskEffect(win, effect);
    this._windowMasks.delete(win);
}
export function _removeAllMasks() {
    if (!this._windowMasks) return;
    // The toggle path re-arms everything, including self-healed masks
    // (a fresh attempt; the healer re-quarantines within a pass if the
    // texture is still foreign).
    if (this._maskQuarantined) this._maskQuarantined.clear();
    for (const win of [...this._windowMasks.keys()])
        this._removeMask(win);
}

export const maskMethods = {
    _unwrapMaskActor,
    _createMaskEffect,
    _ensureWindowMask,
    _connectTextureWatch,
    _scheduleMaskRedraw,
    _kickMaskNow,
    _updateMaskBounds,
    _teardownMaskEffect,
    _removeMask,
    _removeAllMasks,
};
