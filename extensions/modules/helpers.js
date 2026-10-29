// Pure identity, accelerator, and mask-rect helpers shared by the shell and
// preferences processes. Anything that needs extension state lives on
// PlaidCore or a subsystem class.

export const LAYOUT_NAMES = {
    'dwindle': 'Dwindle',
    'master-stack': 'Master-stack',
    'centered-master-stack': 'Centered Master-stack',
    'floating': 'Floating',
};

// Canonical form of an accelerator for comparison: '<Shift><Super>h' and
// '<Super><Shift>h' are the same shortcut (GTK, mutter, and users write the
// modifier order differently) — lowercased sorted modifiers + key.
const KEY_ALIASES = {
    above_tab: 'grave',
};

export function normalizeAccel(combo) {
    const parts = combo.replace(/[<>]/g, ' ').trim().split(/\s+/);
    if (parts.length === 0) return combo;
    const rawKey = parts[parts.length - 1].toLowerCase();
    const key = KEY_ALIASES[rawKey] || rawKey;
    const mods = parts.slice(0, -1).map((m) => m.toLowerCase()).sort();
    return mods.length ? `<${mods.join('><')}>${key}` : key;
}

// Translate Mutter-only key names into portable GTK accelerator names. The
// shortcut editor uses Gtk.accelerator_parse(), which does not know Above_Tab.
export function normalizeTypedAccel(text) {
    return text.replace(/\babove_tab\b/gi, 'grave');
}

// SDF border/clip rect for the corner mask, in ACTOR-local coordinates.
// SHARED by the mask bounds upload and the GNOME 50 GLSLEffect's
// vfunc_paint_target — that vfunc RE-DERIVES `bounds` on EVERY paint, so it
// is the authoritative source on GNOME 50. Clamp to the actor bounds so a
// client surface smaller than its frame cannot draw the border outside the
// captured texture.
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
