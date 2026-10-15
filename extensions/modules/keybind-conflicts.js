// Shared keybinding-conflict scanner.
//
// Used by the extension (modules/keybindings.js) and the prefs app, so both
// agree on what conflicts. `Gio` is INJECTED rather than imported: the prefs
// process is GTK-only and must not pull in the shell's gi namespaces.
//
// Split in two so the expensive half can be cached: `collectOtherBindings()`
// walks every schema (and the GNOME custom shortcuts) and only has to be redone
// when those change, while `findConflicts()` is a cheap lookup per keybinding.

import { normalizeAccel } from './helpers.js';

const CUSTOM_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding';

// Human label for the other side, shared by the shell dialog and the prefs
// tooltip. Kept plain (no gettext) so both processes format it the same.
export function describeConflict(c) {
    if (c.path)
        return `GNOME — ${c.label || 'a custom shortcut'}`;
    if (c.schemaId.startsWith('org.gnome.'))
        return `GNOME (${c.keyName.replace(/-/g, ' ')})`;
    return `${c.schemaId} (${c.keyName})`;
}

// Every binding that is NOT ours, as { combo, schemaId, keyName, path, type, label }.
export function collectOtherBindings(Gio, ownSchemaId) {
    const out = [];

    // 1. Every FIXED schema — mutter, wm/media-keys keybindings, the shell, and
    //    other extensions that use a non-relocatable schema.
    let schemaIds = [];
    try { schemaIds = Gio.Settings.list_schemas(); } catch (_e) {}
    for (const schemaId of schemaIds) {
        if (schemaId === ownSchemaId) continue;
        let s;
        try { s = new Gio.Settings({ schema_id: schemaId }); } catch (_e) { continue; }
        let keys;
        try { keys = s.settings_schema.list_keys(); } catch (_e) { continue; }
        for (const keyName of keys) {
            let value;
            try { value = s.get_value(keyName); } catch (_e) { continue; }
            if (!value || value.get_type_string() !== 'as') continue;
            let list;
            try { list = value.deep_unpack(); } catch (_e) { continue; }
            for (const combo of list) {
                if (combo)
                    out.push({ combo, schemaId, keyName, path: null, type: 'as', label: null });
            }
        }
    }

    // 2. GNOME custom shortcuts. These live in a RELOCATABLE schema instance,
    //    which list_schemas() never returns, and their `binding` key is type 's'
    //    (a single string) — both of which the loop above misses.
    try {
        const mk = new Gio.Settings({ schema_id: 'org.gnome.settings-daemon.plugins.media-keys' });
        for (const path of mk.get_strv('custom-keybindings')) {
            if (!path) continue;
            let cs;
            try { cs = new Gio.Settings({ schema_id: CUSTOM_SCHEMA, path }); } catch (_e) { continue; }
            let combo = '';
            let label = '';
            try { combo = cs.get_string('binding'); } catch (_e) {}
            try { label = cs.get_string('name'); } catch (_e) {}
            if (combo)
                out.push({ combo, schemaId: CUSTOM_SCHEMA, keyName: 'binding', path, type: 's', label });
        }
    } catch (_e) {}

    return out;
}

// Conflicts between `combos` (Map: normalized combo -> { orig, owners }) and the
// bindings from `collectOtherBindings()`.
export function findConflicts(others, combos) {
    const out = [];
    for (const b of others) {
        const hit = combos.get(normalizeAccel(b.combo));
        if (hit)
            out.push({ orig: hit.orig, owners: hit.owners, ...b });
    }
    return out;
}

// One-shot convenience for the shell (runs at enable and on a binding change).
export function scanKeybindConflicts(Gio, ownSchemaId, combos) {
    return findConflicts(collectOtherBindings(Gio, ownSchemaId), combos);
}
