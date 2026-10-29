// Plaid — identity / title helpers and the mask SDF rect.
//
// The free functions (normalizeAccel, maskSdfRect) are imported directly. The instance methods (leading underscore) use `this` and
// are attached to TilingWMExtension.prototype in extension.js, so their bodies
// and call sites are unchanged.

export const LAYOUT_NAMES = {
    'dwindle': 'Dwindle',
    'master-stack': 'Master-stack',
    'centered-master-stack': 'Centered Master-stack',
    'floating': 'Floating',
};

// Canonical form of an accelerator for comparison: '<Shift><Super>h' and
// '<Super><Shift>h' are the same shortcut (GTK, mutter, and users write the
// modifier order differently) — lowercased sorted modifiers + key.
export function normalizeAccel(combo) {
    try {
        const parts = combo.replace(/[<>]/g, ' ').trim().split(/\s+/);
        if (parts.length === 0) return combo;
        const key = parts[parts.length - 1].toLowerCase();
        const mods = parts.slice(0, -1).map((m) => m.toLowerCase()).sort();
        return mods.length ? `<${mods.join('><')}>${key}` : key;
    } catch (_e) {
        return combo;
    }
}

// SDF border/clip rect for the corner mask, in ACTOR-local coordinates.
// SHARED by _updateMaskBounds (uniform upload) and the GNOME 50 GLSLEffect's
// vfunc_paint_target — that vfunc RE-DERIVES `bounds` on EVERY paint, so it
// is the authoritative source on GNOME 50: a raw formula there silently
// stomps any clamp applied at upload time (the pascube
// square-outside/rounded-inside top corners — updateMask's clamped
// borderedAreaBounds vs paint_target's unclamped bounds = mismatched rects).
// The rect is the frame rect in actor/buffer coordinates; healthy windows
// (frame ⊆ buffer: equal for shadowless Wayland, inset for CSD shadows) land
// strictly INSIDE the actor. A client can commit a surface SMALLER than its
// frame (pascube (GTK3): buffer 37px shorter at the TOP with bottoms flush) —
// the raw formula then puts y1 ABOVE the capture: top border and top rounding
// arc draw outside the captured surface (outer edge cut square by the
// framebuffer edge, content top corners left unclipped). Clamp to the actor
// bounds: no-op for every healthy window, hugs the visible surface for
// divergent ones.
export function maskSdfRect(win, actor) {
    const buffer = win.get_buffer_rect();
    const frame = win.get_frame_rect();
    const offsetX = frame.x - buffer.x;
    const offsetY = frame.y - buffer.y;
    const bw = frame.width - buffer.width;
    const bh = frame.height - buffer.height;
    const x1 = Math.max(1, offsetX + 1);
    const y1 = Math.max(1, offsetY + 1);
    const x2 = Math.max(x1, Math.min(actor.width, offsetX + actor.width + bw));
    const y2 = Math.max(y1, Math.min(actor.height, offsetY + actor.height + bh));
    return [x1, y1, x2, y2];
}

export function _compileTitlePatterns(titles) {
    const patterns = [];
    for (const t of titles || []) {
        if (t.includes('*'))
            patterns.push(new RegExp('^' + t.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'));
    }
    return patterns;
}

export function _floatingTitleMatches(title) {
    if (!title) return false;
    if (this._floatingTitles && this._floatingTitles.has(title)) return true;
    const patterns = this._floatingTitlePatterns;
    if (!patterns) return false;
    for (const re of patterns) {
        if (re.test(title)) return true;
    }
    return false;
}

export function _winClassCandidates(win) {
    // GNOME 50 populates the WM_CLASS *instance* for Wayland (both parts
    // are set to the app id); GNOME 51 leaves the instance empty and the
    // identity lives in WM_CLASS / the GTK app id. Return every non-empty
    // identity candidate (lowercased), most-specific first, so float rules
    // written for either shell version keep matching. The first entry is
    // the window's display class.
    const out = [];
    const inst = win.get_wm_class_instance();
    if (inst) out.push(inst.toLowerCase());
    const cls = win.get_wm_class();
    if (cls) out.push(cls.toLowerCase());
    const app = win.get_gtk_application_id();
    if (app) out.push(app.toLowerCase());
    return out;
}

export function _floatClassMatches(win) {
    if (!this._floatingClasses) return false;
    for (const c of this._winClassCandidates(win)) {
        if (this._floatingClasses.has(c)) return true;
    }
    return false;
}

export function _debugLog(...args) {
    if (!this._settings) return;
    if (!this._settings.get_boolean('debug')) return;
    log(`[plaid] ${args.join(' ')}`);
}

export function _currentTime() {
    try { return global.get_current_time(); } catch (_e) { return 0; }
}

export const helperMethods = {
    _debugLog,
    _currentTime,

    _compileTitlePatterns,
    _floatingTitleMatches,
    _winClassCandidates,
    _floatClassMatches,
};
