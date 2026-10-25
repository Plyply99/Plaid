// Blur — the pure-GJS window blur effect.
//
// A Clutter.Effect that reimplements GNOME Shell's BACKGROUND-mode blur chain
// (blit the stage beneath the window, blur it through cached offscreen buffers,
// then composite with a rounded-corner SDF) using mutter's own Gaussian kernel.
// No bundled library, no typelibs, no restart — the same code runs on GNOME 50
// and 51.
//
// Methods are attached to TilingWMExtension.prototype in extension.js.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';

// Snippet hook used by the corner SDF; the shell provides it at runtime.
const SNIPPET_HOOK_FRAGMENT = Cogl.SnippetHook?.FRAGMENT;

const BLUR_EFFECT_NAME = 'plaid-window-blur';

// Monitor-geometry cache, invalidated on monitors-changed so the effect's
// per-frame dimension lookup stays cheap.
let _monitorDimsVersion = 0;
let _monitorDimsCache = null;

// Invalidate the monitor-dims cache (called on monitors-changed).
export function bumpMonitorDims() {
    _monitorDimsVersion++;
}

// Corner SDF + brightness: rounds the blurred backdrop and applies brightness.
const BLUR_SNIPPET_DECLARATIONS = `
uniform float brightness;
uniform vec4 bounds;
uniform float clipRadius;
uniform vec2 pixelStep;

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
`;

const BLUR_SNIPPET_CODE = `
    vec2 p = cogl_tex_coord0_in.xy / pixelStep;
    float pointAlpha = getPointOpacity(p, bounds, clipRadius);
    cogl_color_out.rgb *= brightness;
    cogl_color_out *= pointAlpha;
`;

// Separable Gaussian blur, from mutter's clutter-blur.c. It must use the
// TEXTURE_LOOKUP hook — that hook is where cogl_sampler is declared; the
// FRAGMENT hook fails to compile.
const BLUR_LOOKUP_HOOK = Cogl.SnippetHook?.TEXTURE_LOOKUP;

const BLUR_KERNEL_DECLARATIONS = `
uniform float sigma;
uniform float pixel_step;
uniform vec2 direction;
`;

const BLUR_KERNEL_CODE = `
    vec2 uv = vec2 (cogl_tex_coord.st);
    vec3 gauss_coefficient;
    gauss_coefficient.x = 1.0 / (sqrt (2.0 * 3.14159265) * sigma);
    gauss_coefficient.y = exp (-0.5 / (sigma * sigma));
    gauss_coefficient.z = gauss_coefficient.y * gauss_coefficient.y;
    float gauss_coefficient_total = gauss_coefficient.x;
    vec4 ret = texture2D (cogl_sampler, uv) * gauss_coefficient.x;
    gauss_coefficient.xy *= gauss_coefficient.yz;
    int n_steps = int (ceil (1.5 * sigma)) * 2;
    for (int i = 1; i <= n_steps; i += 2) {
        float coefficient_subtotal = gauss_coefficient.x;
        gauss_coefficient.xy *= gauss_coefficient.yz;
        coefficient_subtotal += gauss_coefficient.x;
        float gauss_ratio = gauss_coefficient.x / coefficient_subtotal;
        float foffset = float (i) + gauss_ratio;
        vec2 offset = direction * foffset * pixel_step;
        ret += texture2D (cogl_sampler, uv + offset) * coefficient_subtotal;
        ret += texture2D (cogl_sampler, uv - offset) * coefficient_subtotal;
        gauss_coefficient_total += 2.0 * coefficient_subtotal;
        gauss_coefficient.xy *= gauss_coefficient.yz;
    }
    cogl_texel = ret / gauss_coefficient_total;
`;

// Registered lazily (module-level guard — registerClass runs exactly once).
let PlaidBackgroundBlurEffectClass = null;

export function _blurCornerRadius() {
    return (this._settings && this._settings.get_boolean('rounded-corners'))
        ? this._settings.get_int('border-radius') + 1
        : 0;
}

export function _createGjsBlurEffect() {
    // Rounded window blur. Shell.BlurEffect can't round corners, so the SDF
    // lives inside this effect's final composite. Any construction failure
    // makes the caller fall back to Shell.BlurEffect (square).
    try {
        if (!PlaidBackgroundBlurEffectClass) {
            PlaidBackgroundBlurEffectClass = GObject.registerClass({
                GTypeName: 'PlaidBackgroundBlurEffect',
            }, class PlaidBackgroundBlurEffect extends Clutter.Effect {
                constructor() {
                    super();
                    this._radius = 0;
                    this._brightness = 1;
                    this._cornerRadius = 0;
                    this._ready = false;
                    this._fatalFail = false;
                    this._paintFailLogged = false;
                    this._paintFailCount = 0;
                    this._blitFailLogged = false;
                    // GL textures are allocated only on rebuild (throttled to
                    // ~10/sec); per-frame paint nodes hold no GL resources.
                    this._lastRebuildTime = 0;
                    this._retired = [];
                    this._coglCtx = null;
                    this._basePipeline = null;
                    this._brightPipeline = null;
                    this._hPipeline = null;
                    this._vPipeline = null;
                    this._brightUniform = -1;
                    this._boundsUniform = -1;
                    this._radiusUniform = -1;
                    this._stepUniform = -1;
                    this._hSigmaUniform = -1;
                    this._hStepUniform = -1;
                    this._hDirUniform = -1;
                    this._vSigmaUniform = -1;
                    this._vStepUniform = -1;
                    this._vDirUniform = -1;
                    this._bgFb = null;
                    this._brightFb = null;
                    this._hFb = null;
                    this._vFb = null;
                    this._bgTex = null;
                    this._brightTex = null;
                    this._hTex = null;
                    this._vTex = null;
                    this._kernelKey = '';
                    this._monitorKey = null;
                }

                get radius() { return this._radius; }
                set radius(v) {
                    v = Math.max(0, Math.round(v));
                    if (v === this._radius) return;
                    this._radius = v;
                    this.queue_repaint();
                    global.stage.queue_redraw();
                }
                get brightness() { return this._brightness; }
                set brightness(v) {
                    if (v === this._brightness) return;
                    this._brightness = v;
                    this.queue_repaint();
                    global.stage.queue_redraw();
                }
                get corner_radius() { return this._cornerRadius; }
                set corner_radius(v) {
                    v = Math.max(0, Math.round(v));
                    if (v === this._cornerRadius) return;
                    this._cornerRadius = v;
                    this.queue_repaint();
                    global.stage.queue_redraw();
                }

                _downscaleFor(w, h, radius) {
                    let ds = 1, sW = w, sH = h, sR = radius;
                    while (sR > 12 && sW > 256 && sH > 256) {
                        ds *= 2;
                        sW = w / ds;
                        sH = h / ds;
                        sR = radius / ds;
                    }
                    return ds;
                }

                _probeAndBuild(paintContext) {
                    try {
                        const stage = global.stage;
                        const ctx = stage.get_context();
                        const backend = ctx.get_backend();
                        this._coglCtx = backend.get_cogl_context();
                        this._basePipeline = Cogl.Pipeline.new(this._coglCtx);
                        this._basePipeline.set_layer_null_texture(0);
                        this._brightPipeline = Cogl.Pipeline.new(this._coglCtx);
                        this._brightPipeline.set_layer_null_texture(0);
                        const snippet = Cogl.Snippet.new(SNIPPET_HOOK_FRAGMENT, BLUR_SNIPPET_DECLARATIONS, BLUR_SNIPPET_CODE);
                        this._brightPipeline.add_snippet(snippet);
                        this._brightUniform = this._brightPipeline.get_uniform_location('brightness');
                        this._boundsUniform = this._brightPipeline.get_uniform_location('bounds');
                        this._radiusUniform = this._brightPipeline.get_uniform_location('clipRadius');
                        this._stepUniform = this._brightPipeline.get_uniform_location('pixelStep');
                        this._brightPipeline.set_uniform_float(this._brightUniform, 1, 1, [1]);
                        this._hPipeline = Cogl.Pipeline.new(this._coglCtx);
                        this._hPipeline.set_layer_null_texture(0);
                        this._vPipeline = Cogl.Pipeline.new(this._coglCtx);
                        this._vPipeline.set_layer_null_texture(0);
                        const kernelSnippet = Cogl.Snippet.new(BLUR_LOOKUP_HOOK, BLUR_KERNEL_DECLARATIONS, null);
                        kernelSnippet.set_replace(BLUR_KERNEL_CODE);
                        this._hPipeline.add_layer_snippet(0, kernelSnippet);
                        this._vPipeline.add_layer_snippet(0, kernelSnippet);
                        this._hSigmaUniform = this._hPipeline.get_uniform_location('sigma');
                        this._hStepUniform = this._hPipeline.get_uniform_location('pixel_step');
                        this._hDirUniform = this._hPipeline.get_uniform_location('direction');
                        this._vSigmaUniform = this._vPipeline.get_uniform_location('sigma');
                        this._vStepUniform = this._vPipeline.get_uniform_location('pixel_step');
                        this._vDirUniform = this._vPipeline.get_uniform_location('direction');
                        this._hPipeline.set_uniform_float(this._hSigmaUniform, 1, 1, [3]);
                        this._hPipeline.set_uniform_float(this._hStepUniform, 1, 1, [0.01]);
                        this._hPipeline.set_uniform_float(this._hDirUniform, 2, 1, [1, 0]);
                        const { monW, monH } = this._monitorDims();
                        const ds = this._downscaleFor(monW, monH, this._radius);
                        this._rebuildTargets(ds);
                        if (this._fatalFail) return;
                        const fb = paintContext.get_framebuffer();
                        const blitNode = new Clutter.BlitNode(fb);
                        const layerNode = new Clutter.LayerNode(this._bgFb, this._basePipeline);
                        const box = new Clutter.ActorBox({ x1: 0, y1: 0, x2: 10, y2: 10 });
                        blitNode.add_blit_rectangle(0, 0, 0, 0, 10, 10);
                        layerNode.add_texture_rectangle(box, 0, 0, 0.5, 0.5);
                        this._ready = true;
                    } catch (e) {
                        log(`[plaid] blur: GJS effect build failed: ${e.message}`);
                        this._fatalFail = true;
                    }
                }

                _retireResources() {
                    // Release this generation's GL objects. GJS finalizes Cogl
                    // objects lazily, so the allocation rate must stay bounded.
                    for (const r of [this._bgTex, this._bgFb, this._brightTex,
                        this._brightFb, this._hTex, this._hFb, this._vTex, this._vFb]) {
                        if (r) this._retired.push(r);
                    }
                    while (this._retired.length > 3)
                        this._retired.shift();
                    this._bgTex = null;
                    this._bgFb = null;
                    this._brightTex = null;
                    this._brightFb = null;
                    this._hTex = null;
                    this._hFb = null;
                    this._vTex = null;
                    this._vFb = null;
                }

                _setupFbo(fb, tex, pipeline, fbW, fbH) {
                    // Bind the FBO texture into layer 0 and map its pixel space
                    // to NDC, mirroring shell-blur-effect's setup.
                    try {
                        fb.allocate();
                    } catch (e) {
                        throw e;
                    }
                    try {
                        pipeline.set_layer_texture(0, tex);
                    } catch (e) {
                        throw e;
                    }
                    try {
                        pipeline.set_layer_filters(0,
                            Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
                        pipeline.set_layer_wrap_mode(0,
                            Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
                    } catch (e) {
                        log(`[plaid] blur: FBO filters/wrap failed: ${e.message}`);
                    }
                    try {
                        const m = new graphene.Matrix();
                        m.init_translate(new graphene.Point3D({
                            x: -fbW / 2,
                            y: -fbH / 2,
                            z: 0,
                        }));
                        m.scale(2 / fbW, -2 / fbH, 1);
                        fb.set_projection_matrix(m);
                    } catch (e) {
                        log(`[plaid] blur: FBO projection failed: ${e.message}`);
                    }
                }

                _monitorDims() {
                    // Physical pixel dims (logical geometry × UI scale) — the
                    // stage framebuffer and blit are physical, so FBOs must match.
                    if (_monitorDimsCache && _monitorDimsCache.v === _monitorDimsVersion)
                        return _monitorDimsCache.d;
                    let monW = 0, monH = 0;
                    try {
                        const n = global.display.get_n_monitors();
                        for (let i = 0; i < n; i++) {
                            const g = global.display.get_monitor_geometry(i);
                            monW = Math.max(monW, g.width);
                            monH = Math.max(monH, g.height);
                        }
                    } catch (_e) {}
                    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
                    const d = { monW: Math.max(Math.round(monW * scale), 640), monH: Math.max(Math.round(monH * scale), 480) };
                    _monitorDimsCache = { v: _monitorDimsVersion, d };
                    return d;
                }

                _rebuildTargets(ds) {
                    // FBOs track the monitor size, not the window, so a window
                    // resize never reallocates GL textures.
                    try {
                        this._retireResources();
                        const { monW, monH } = this._monitorDims();
                        const bgW = Math.max(2, Math.round(monW / ds));
                        const bgH = Math.max(2, Math.round(monH / ds));
                        this._bgTex = Cogl.Texture2D.new_with_size(this._coglCtx, monW, monH);
                        this._bgFb = Cogl.Offscreen.new_with_texture(this._bgTex);
                        this._brightTex = Cogl.Texture2D.new_with_size(this._coglCtx, bgW, bgH);
                        this._brightFb = Cogl.Offscreen.new_with_texture(this._brightTex);
                        this._hTex = Cogl.Texture2D.new_with_size(this._coglCtx, bgW, bgH);
                        this._hFb = Cogl.Offscreen.new_with_texture(this._hTex);
                        this._vTex = Cogl.Texture2D.new_with_size(this._coglCtx, bgW, bgH);
                        this._vFb = Cogl.Offscreen.new_with_texture(this._vTex);
                        this._setupFbo(this._bgFb, this._bgTex, this._basePipeline, monW, monH);
                        this._setupFbo(this._brightFb, this._brightTex, this._brightPipeline, bgW, bgH);
                        this._setupFbo(this._hFb, this._hTex, this._hPipeline, bgW, bgH);
                        this._setupFbo(this._vFb, this._vTex, this._vPipeline, bgW, bgH);
                        this._monitorKey = `${monW}x${monH}:${ds}`;
                    } catch (e) {
                        log(`[plaid] blur: FBO build failed: ${e.message}`);
                        this._fatalFail = true;
                    }
                }

                _syncKernel(ds, radius) {
                    // Uploads sigma when the kernel changes (radius or
                    // downscale). Clamped to mutter's MAX_SIGMA (6).
                    const sigma = Math.max(0.5, Math.min(6, (radius / ds) / 3));
                    const key = sigma.toFixed(3);
                    if (key === this._kernelKey) return;
                    this._kernelKey = key;
                    try {
                        this._hPipeline.set_uniform_float(this._hSigmaUniform, 1, 1, [sigma]);
                        this._vPipeline.set_uniform_float(this._vSigmaUniform, 1, 1, [sigma]);
                    } catch (e) {
                        log(`[plaid] blur kernel upload failed: ${e.message}`);
                    }
                }

                _buildChain(w, h, ds, px, py, physW, physH, paintContext) {
                    // Per-frame render chain — only cached FBOs/pipelines, no
                    // per-frame allocation. The layer node copies the pipeline
                    // at creation, so uniforms must be set first. The blit reads
                    // the stage framebuffer in physical view pixels; composites
                    // use logical rects; the SDF maps texcoords back to logical
                    // pixels via pixelStep.
                    const bw = w / ds;
                    const bh = h / ds;
                    if (!this._bgFb || !this._brightFb || !this._hFb || !this._vFb) return null;
                    this._syncKernel(ds, this._radius);
                    const monW = this._bgTex.get_width();
                    const monH = this._bgTex.get_height();
                    const dbw = monW / ds;
                    const dbh = monH / ds;
                    const scale = physW / w;
                    this._brightPipeline.set_uniform_float(this._brightUniform, 1, 1, [this._brightness]);
                    this._brightPipeline.set_uniform_float(this._boundsUniform, 4, 1, [1, 1, w, h]);
                    const safeCorner = Math.max(0, Math.min(this._cornerRadius,
                        Math.floor(Math.max(1, w) / 2), Math.floor(Math.max(1, h) / 2)));
                    this._brightPipeline.set_uniform_float(this._radiusUniform, 1, 1, [safeCorner]);
                    this._brightPipeline.set_uniform_float(this._stepUniform, 2, 1, [scale / monW, scale / monH]);
                    this._hPipeline.set_uniform_float(this._hStepUniform, 1, 1, [1 / dbw]);
                    this._hPipeline.set_uniform_float(this._hDirUniform, 2, 1, [1, 0]);
                    this._vPipeline.set_uniform_float(this._vStepUniform, 1, 1, [1 / dbh]);
                    this._vPipeline.set_uniform_float(this._vDirUniform, 2, 1, [0, 1]);
                    // Each FBO is monitor-sized; map only the content region
                    // (fx, fy) onto the composite rect.
                    const fx = physW / monW;
                    const fy = physH / monH;
                    const brightLayer = new Clutter.LayerNode(this._brightFb, this._brightPipeline);
                    brightLayer.add_texture_rectangle(new Clutter.ActorBox({ x1: 0, y1: 0, x2: w, y2: h }),
                        0, 0, fx, fy);
                    const vLayer = new Clutter.LayerNode(this._vFb, this._vPipeline);
                    vLayer.add_texture_rectangle(new Clutter.ActorBox({ x1: 0, y1: 0, x2: bw, y2: bh }),
                        0, 0, fx, fy);
                    brightLayer.add_child(vLayer);
                    const hLayer = new Clutter.LayerNode(this._hFb, this._hPipeline);
                    hLayer.add_texture_rectangle(new Clutter.ActorBox({ x1: 0, y1: 0, x2: bw, y2: bh }),
                        0, 0, fx, fy);
                    vLayer.add_child(hLayer);
                    const bgLayer = new Clutter.LayerNode(this._bgFb, this._basePipeline);
                    bgLayer.add_texture_rectangle(new Clutter.ActorBox({ x1: 0, y1: 0, x2: bw, y2: bh }),
                        0, 0, fx, fy);
                    hLayer.add_child(bgLayer);
                    const blitNode = new Clutter.BlitNode(paintContext.get_framebuffer());
                    bgLayer.add_child(blitNode);
                    blitNode.add_blit_rectangle(px, py, 0, 0, physW, physH);
                    return brightLayer;
                }

                vfunc_paint_node(node, paintContext) {
                    try {
                        const actor = this.get_actor();
                        if (!actor || !actor.get_parent()) return true;
                        const w = Math.round(actor.width);
                        const h = Math.round(actor.height);
                        if (w <= 1 || h <= 1) return true;
                        if (!this._ready) {
                            this._probeAndBuild(paintContext);
                            if (this._fatalFail || !this._ready) return true;
                        }
                        const { monW, monH } = this._monitorDims();
                        const ds = this._downscaleFor(monW, monH, this._radius);
                        const monKey = `${monW}x${monH}:${ds}`;
                        if (monKey !== this._monitorKey) {
                            const now = Date.now();
                            if (!this._lastRebuildTime || now - this._lastRebuildTime >= 100) {
                                this._rebuildTargets(ds);
                                if (this._fatalFail) return true;
                                this._lastRebuildTime = now;
                            }
                        }
                        let px = 0, py = 0;
                        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
                        try {
                            const pos = actor.get_transformed_position();
                            px = pos[0];
                            py = pos[1];
                            // View-relative blit. On 51 get_stage_view() works;
                            // on 50 it isn't introspectable, so subtract the
                            // actor's monitor origin instead.
                            if (typeof paintContext.get_stage_view === 'function') {
                                const stageView = paintContext.get_stage_view();
                                if (stageView && stageView.get_layout) {
                                    const layout = stageView.get_layout();
                                    if (layout) {
                                        px -= layout.x;
                                        py -= layout.y;
                                    }
                                }
                            } else {
                                const n = global.display.get_n_monitors();
                                for (let i = 0; i < n; i++) {
                                    const g = global.display.get_monitor_geometry(i);
                                    if (px >= g.x && px < g.x + g.width &&
                                        py >= g.y && py < g.y + g.height) {
                                        px -= g.x;
                                        py -= g.y;
                                        break;
                                    }
                                }
                            }
                        } catch (_e) {}
                        px *= scale;
                        py *= scale;
                        if (!Number.isFinite(px) || !Number.isFinite(py)) {
                            px = 0;
                            py = 0;
                            if (!this._blitFailLogged) {
                                this._blitFailLogged = true;
                                log('[plaid] blur: blit position invalid — zeroed');
                            }
                        }
                        const physW = Math.max(1, Math.round(w * scale));
                        const physH = Math.max(1, Math.round(h * scale));
                        const chain = this._buildChain(w, h, ds, px, py, physW, physH, paintContext);
                        if (!chain) return true;
                        node.add_child(chain);
                        // Count consecutive failures only — a good frame resets
                        // the counter, so scattered GL hiccups can't kill the blur.
                        this._paintFailCount = 0;
                        return true;
                    } catch (e) {
                        // Stay recoverable: only repeated consecutive failures
                        // go fatal.
                        this._paintFailCount++;
                        if (!this._paintFailLogged) {
                            this._paintFailLogged = true;
                            log(`[plaid] blur effect paint failed (${this._paintFailCount}): ${e.message}`);
                        } else if (this._paintFailCount <= 5) {
                            log(`[plaid] blur effect paint failed (${this._paintFailCount}): ${e.message}`);
                        }
                        if (this._paintFailCount >= 5)
                            this._fatalFail = true;
                        return true;
                    }
                }
            });
        }
        return new PlaidBackgroundBlurEffectClass();
    } catch (e) {
        log(`[plaid] blur: GJS blur effect unavailable (${e.message}) — square Shell.BlurEffect fallback`);
        return null;
    }
}

export function _ensureWindowBlur(win, actor) {
    if (!this._windowBlurs || !actor || !actor.add_effect_with_name) return;
    if (!this._settings || !this._settings.get_boolean('window-blur')) return;
    if (this._pendingWarp && this._pendingWarp.has(win)) return;

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
                    blur._sibling.destroy();
                    blur._sibling = null;
                }
                this._windowBlurs.delete(win);
                blur = null;
                this._debugLog('blur self-heal: host dead, recreating');
            } catch (e) {
                log(`[plaid] window blur heal failed: ${e.message}`);
                return;
            }
        } else if (blur._sibling) {
            if (blur._fatalFail) {
                // Fatal GJS effect: fall back to the square Shell.BlurEffect
                // and stick to it for this window so we don't rebuild-fail in a loop.
                this._debugLog('blur self-heal: GJS effect fatal, falling back to Shell.BlurEffect');
                win._plaidBlurSquare = true;
                this._removeBlur(win);
                this._ensureWindowBlur(win, win.get_compositor_private() || actor);
                return;
            }
            try {
                const cr = this._blurCornerRadius();
                if (blur.corner_radius !== cr)
                    blur.corner_radius = cr;
            } catch (_e) {}
        }
    }

    if (!blur) {
        if (actor.get_parent() !== global.window_group) {
            this._debugLog('blur defer: window mid-transition, next pass will create');
            return;
        }
        try {
            // Sticky square fallback for a window that already failed once.
            blur = win._plaidBlurSquare
                ? new Shell.BlurEffect()
                : (this._createGjsBlurEffect() || new Shell.BlurEffect());
            blur._bindings = [];
            blur._settleNotifyIds = [];
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
            for (const prop of ['pivot-point', 'translation-x', 'translation-y', 'scale-x', 'scale-y', 'visible', 'opacity']) {
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
            blur._actorDestroyId = actor.connect('destroy', () => this._removeBlur(win));
            blur._actorParentSetId = actor.connect('parent-set',
                () => this._syncBlurStacking());
            // Suppress the blur while the actor animates: a scaled/faded actor
            // would stretch the full-size backdrop paint into a smear. Disable
            // the effect while scaling or fading, re-enable at rest, and re-sync
            // the sibling rect on every re-enable so no stale offset is painted.
            // Toggle the EFFECT, not the sibling's visible — the actor's
            // `visible` binding would overwrite it.
            const syncBlurState = () => {
                if (!blur || !blur._sibling || blur._fatalFail) return;
                if (this._windowBlurs && this._windowBlurs.get(win) !== blur) return;
                try {
                    const moving = !win._plaidFloatAnim &&
                        (actor.scale_x < 0.99 || actor.scale_y < 0.99 ||
                         actor.opacity < 255);
                    const shouldEnable = !moving;
                    if (blur.enabled && shouldEnable) {
                        // Keep the rect fresh once settled (the actor's position
                        // lands a frame after scale reaches 1).
                        this._syncBlurSiblingRect(win, blur);
                    } else if (blur.enabled !== shouldEnable) {
                        if (shouldEnable)
                            this._syncBlurSiblingRect(win, blur);
                        blur.enabled = shouldEnable;
                    }
                } catch (_e) {}
            };
            for (const sig of ['notify::scale-x', 'notify::scale-y',
                               'notify::opacity', 'notify::x', 'notify::y'])
                blur._settleNotifyIds.push(actor.connect(sig, syncBlurState));
            syncBlurState();
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

    if (blur._sibling)
        this._syncBlurSiblingRect(win, blur);

    try {
        const siblingAlive = blur._sibling ? (blur._sibling.get_parent() ? 'yes' : 'no') : 'n/a';
        const actorMatch = blur.get_actor() === blur._sibling ? 'yes' : 'no';
        this._debugLog(`blur state siblingParent=${siblingAlive} actorMatch=${actorMatch}`);
    } catch (_e) {}

    try {
        // mode is Shell-only — the GJS effect has no mode property.
        if (blur instanceof Shell.BlurEffect) {
            const blurMode = Shell.BlurMode.BACKGROUND;
            if (blur.mode !== blurMode)
                blur.mode = blurMode;
        }
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const radius = Math.round(Math.min(this._settings.get_int('window-blur-radius') * scale, 100));
        if (blur.radius !== radius)
            blur.radius = radius;
        const brightness = this._settings.get_double('window-blur-brightness');
        if (blur.brightness !== brightness)
            blur.brightness = brightness;
        const cr = this._blurCornerRadius();
        if (blur.corner_radius !== cr)
            blur.corner_radius = cr;
    } catch (e) {
        log(`[plaid] window blur update failed: ${e.message}`);
    }
}

export function _unbindBlurSibling(blur) {
    if (blur._bindings) {
        for (const binding of blur._bindings) {
            try { binding.unbind(); } catch (_e) {}
        }
        blur._bindings = [];
    }
}

export function _syncBlurSiblingRect(win, blur) {
    // Place the sibling over the window's visible rect (intersection of frame
    // and buffer, relative to the constraint source) so blur never paints
    // outside the window.
    //
    // Skip while the actor is mid-transition: during a fly-in its x/y animate
    // while the Meta frame/buffer rect is already at the destination, so a
    // computed offset would stick after settle. Leaving the last-good offsets
    // is correct — the suppression keeps the sibling unpainted until at rest.
    if (!this._windowBlurs || !blur || !blur._sibling) return;
    try {
        const buffer = win.get_buffer_rect();
        const frame = win.get_frame_rect();
        const src = blur._sourceActor || blur.get_actor();
        if (!src) return;
        if (Math.abs(src.x - buffer.x) > 1 || Math.abs(src.y - buffer.y) > 1)
            return;
        const ix = Math.max(frame.x, buffer.x);
        const iy = Math.max(frame.y, buffer.y);
        const iw = Math.min(frame.x + frame.width, buffer.x + buffer.width) - ix;
        const ih = Math.min(frame.y + frame.height, buffer.y + buffer.height) - iy;
        // Offsets are relative to the constraint source (the actor stored on
        // the effect), not necessarily the actor passed in.
        const offsets = iw > 0 && ih > 0
            ? [ix - src.x, iy - src.y, iw - src.width, ih - src.height]
            : [0, 0, 0, 0];
        const constraints = blur._sibling.get_constraints();
        constraints.forEach((c, i) => {
            if (c instanceof Clutter.BindConstraint)
                c.offset = offsets[i];
        });
    } catch (_e) {}
}

export function _syncBlurStacking() {
    if (!this._windowBlurs) return;
    // Synchronous: mutter re-stacks window actors but not our plain St.Widget
    // siblings, so each sibling is re-inserted below its window inside the
    // signal. Deferring to idle causes a full-stage double repaint.
    this._syncBlurStackingNow();
}

export function _syncBlurStackingNow(recheck = false) {
    if (!this._windowBlurs) return false;
    let changed = false;
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
        // Force the sibling's visibility from the source actor + minimized
        // state at this choke point. The `visible` binding can be lost, and a
        // wrongly-visible sibling of a hidden window paints blur over the stack.
        const wantVisible = source.visible && !win.minimized;
        if (sibling.visible !== wantVisible) {
            sibling.visible = wantVisible;
            changed = true;
        }
        // The sibling's constraints die when its source actor is detached or
        // replaced, freezing it at stale geometry. Re-attach to the current
        // actor instead of skipping.
        const current = win.get_compositor_private();
        if (!current || current.get_parent() !== global.window_group) continue;
        const sourceDead = source.get_parent() !== global.window_group ||
            current !== source;
        const siblingDead = sibling.get_parent() !== global.window_group;
        if (sourceDead || siblingDead) {
            // A re-attach counts as a change (the settle poll refreshes once).
            changed = true;
            if (!blur._reAttachPending) {
                this._debugLog(`blur: ${sourceDead ? 'source detached' : 'sibling detached'} → deferred re-attach (${win.get_wm_class_instance() || '?'})`);
                blur._reAttachPending = true;
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (!this._settings) return GLib.SOURCE_REMOVE;
                    blur._reAttachPending = false;
                    if (!this._windowBlurs || !this._windowBlurs.has(win)) return GLib.SOURCE_REMOVE;
                    try {
                        this._removeBlur(win);
                        this._ensureWindowBlur(win, win.get_compositor_private() || current);
                    } catch (e) {
                        log(`[plaid] blur: deferred re-attach failed: ${e.message}`);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
            continue;
        }
        try {
            const sW = sibling.get_width();
            const sH = sibling.get_height();
            const aW = source.get_width();
            const aH = source.get_height();
            const mismatched = sW > monitorW + 64 || sH > monitorH + 64 ||
                Math.abs(sW - aW) > aW * 0.15 + 64 ||
                Math.abs(sH - aH) > aH * 0.15 + 64;
            if (mismatched) {
                changed = true;
                if (!blur._reAttachPending) {
                    // Guarded: this runs on every restacked — unguarded logging
                    // would spam while a mismatch persists.
                    this._debugLog(`blur: sibling mismatch → deferred re-attach (${win.get_wm_class_instance() || '?'} mon=${monitorW}x${monitorH} sib=${sW}x${sH} src=${aW}x${aH})`);
                    blur._reAttachPending = true;
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        if (!this._settings) return GLib.SOURCE_REMOVE;
                        blur._reAttachPending = false;
                        if (!this._windowBlurs || !this._windowBlurs.has(win)) return GLib.SOURCE_REMOVE;
                        try {
                            this._removeBlur(win);
                            this._ensureWindowBlur(win, win.get_compositor_private() || source);
                        } catch (e) {
                            log(`[plaid] blur: deferred re-attach failed: ${e.message}`);
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                }
            } else {
                // Only fix the broken case: sibling ABOVE its float. A sibling
                // below is covered by the float, and reordering emits
                // ::children-changed → a full-stage redraw.
                const kids = global.window_group.get_children();
                const si = kids.indexOf(sibling);
                const ai = kids.indexOf(source);
                if (si !== -1 && ai !== -1 && si > ai) {
                    global.window_group.set_child_below_sibling(sibling, source);
                    changed = true;
                    // restacked can fire before mutter finishes the re-stack;
                    // re-check once after it settles (only if we moved).
                    if (!recheck && !this._blurStackRecheckId) {
                        this._blurStackRecheckId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                            this._blurStackRecheckId = 0;
                            if (!this._settings) return GLib.SOURCE_REMOVE;
                            this._syncBlurStackingNow(true);
                            return GLib.SOURCE_REMOVE;
                        });
                    }
                }
            }
        } catch (_e) {}
    }
    return changed;
}

export function _removeBlur(win) {
    if (!this._windowBlurs) return;
    const blur = this._windowBlurs.get(win);
    if (!blur) return;
    // Drop the visible sibling FIRST: the blur is painted by that actor, so a
    // stale signal below must never leave it on screen when blur is turned off.
    if (blur._sibling) {
        this._unbindBlurSibling(blur);
        const sibling = blur._sibling;
        blur._sibling = null;
        try {
            sibling.destroy();
        } catch (e) {
            this._debugLog(`blur remove: sibling destroy failed: ${e.message}`);
        }
    }
    // These signals can outlive their actor; a failed disconnect must not abort
    // the rest of the teardown (the sibling is already gone).
    if (blur._actorDestroyId) {
        const id = blur._actorDestroyId;
        blur._actorDestroyId = 0;
        try {
            const a = win.get_compositor_private();
            if (a) a.disconnect(id);
        } catch (e) {
            this._debugLog(`blur remove: destroy disconnect failed: ${e.message}`);
        }
    }
    if (blur._actorParentSetId) {
        const id = blur._actorParentSetId;
        blur._actorParentSetId = 0;
        try {
            const a = win.get_compositor_private();
            if (a) a.disconnect(id);
        } catch (e) {
            this._debugLog(`blur remove: parent-set disconnect failed: ${e.message}`);
        }
    }
    if (blur._settleNotifyIds && blur._settleNotifyIds.length) {
        const ids = blur._settleNotifyIds;
        blur._settleNotifyIds = [];
        try {
            const a = win.get_compositor_private();
            if (a)
                for (const id of ids) a.disconnect(id);
        } catch (e) {
            this._debugLog(`blur remove: settle disconnect failed: ${e.message}`);
        }
    }
    this._windowBlurs.delete(win);
}

export function _removeAllBlurs() {
    if (!this._windowBlurs) return;
    if (this._blurStackRecheckId) {
        GLib.source_remove(this._blurStackRecheckId);
        this._blurStackRecheckId = 0;
    }
    // Fresh attempt on the next blur enable, including windows stuck on the
    // square fallback — the healer re-sticks them if the GL problem persists.
    for (const win of [...this._windowBlurs.keys()]) {
        win._plaidBlurSquare = false;
        this._removeBlur(win);
    }
}

export function _purgeOrphanBlurs() {
    if (!this._windowBlurs) return;
    const tracked = new Set();
    for (const blur of this._windowBlurs.values())
        if (blur._sibling) tracked.add(blur._sibling);
    for (const child of global.window_group.get_children()) {
        if (!child || !child.get_effect || child.get_effect(BLUR_EFFECT_NAME) === null) continue;
        if (!tracked.has(child)) {
            child.destroy();
        }
    }
}


export const blurMethods = {
    _blurCornerRadius,
    _createGjsBlurEffect,
    _ensureWindowBlur,
    _unbindBlurSibling,
    _syncBlurSiblingRect,
    _syncBlurStacking,
    _syncBlurStackingNow,
    _removeBlur,
    _removeAllBlurs,
    _purgeOrphanBlurs,
};
