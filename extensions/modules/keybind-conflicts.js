// Shared keybinding-conflict scanner.
//
// Used by the extension and the preferences app, so both agree on what
// conflicts. `Gio` is INJECTED rather than imported: the prefs process is
// GTK-only and must not pull in the shell's gi namespaces.
//
// The scan is deliberately limited to the schemas that can own a global
// shortcut. Walking every installed schema is slow and noisy; these cover the
// GNOME/Mutter defaults plus user-defined custom shortcuts.

import { normalizeAccel } from './helpers.js';

const CUSTOM_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding';

const GNOME_SCHEMAS = [
    'org.gnome.desktop.wm.keybindings',
    'org.gnome.mutter.keybindings',
    'org.gnome.mutter.wayland.keybindings',
    'org.gnome.shell.keybindings',
    'org.gnome.settings-daemon.plugins.media-keys',
];

const GNOME_LABELS = {
    'minimize': 'Hide window',
    'toggle-fullscreen': 'Toggle fullscreen',
    'switch-group': 'Switch windows of an application',
    'switch-group-backward': 'Switch windows of an application backward',
    'switch-applications': 'Switch applications',
    'switch-applications-backward': 'Switch applications backward',
    'switch-windows': 'Switch windows',
    'switch-windows-backward': 'Switch windows backward',
    'switch-input-source': 'Switch input source',
    'switch-input-source-backward': 'Switch input source backward',
    'logout': 'Log out',
    'lock-screen': 'Lock screen',
    'show-desktop': 'Show desktop',
};

// Human label for the other side, shared by the shell dialog and the prefs
// tooltip. Kept plain (no gettext) so both processes format it the same.
export function describeConflict(c) {
    if (c.path)
        return `GNOME — ${c.label || 'a custom shortcut'}`;
    if (c.schemaId.startsWith('org.gnome.')) {
        const label = GNOME_LABELS[c.keyName] || c.keyName.replace(/-/g, ' ');
        return `GNOME (${label})`;
    }
    return `${c.schemaId} (${c.keyName})`;
}

// Every binding that is NOT ours, as { combo, schemaId, keyName, path, type, label }.
export function collectOtherBindings(Gio, ownSchemaId) {
    const out = [];

    for (const schemaId of GNOME_SCHEMAS) {
        if (schemaId === ownSchemaId) continue;
        const s = new Gio.Settings({ schema_id: schemaId });
        for (const keyName of s.settings_schema.list_keys()) {
            // This key holds custom-shortcut paths, not an accelerator.
            if (keyName === 'custom-keybindings') continue;
            const value = s.get_value(keyName);
            if (!value || value.get_type_string() !== 'as') continue;
            for (const combo of value.deep_unpack()) {
                if (combo)
                    out.push({ combo, schemaId, keyName, path: null, type: 'as', label: null });
            }
        }
    }

    // GNOME custom shortcuts. These live in a RELOCATABLE schema instance,
    // which the fixed schemas above never return, and their `binding` key is
    // type 's' (a single string).
    const mk = new Gio.Settings({ schema_id: 'org.gnome.settings-daemon.plugins.media-keys' });
    for (const path of mk.get_strv('custom-keybindings')) {
        if (!path) continue;
        let cs;
        try {
            cs = new Gio.Settings({ schema_id: CUSTOM_SCHEMA, path });
        } catch (e) {
            // A stale custom-shortcut path can survive in the list.
            continue;
        }
        const combo = cs.get_string('binding');
        const label = cs.get_string('name');
        if (combo)
            out.push({ combo, schemaId: CUSTOM_SCHEMA, keyName: 'binding', path, type: 's', label });
    }

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

// Resolve an accelerator-activated action back to one of our dead combos.
// Built-in mutter actions match by action id; shell/extension bindings match
// by the external binding name returned by mutter.
export function resolveConflictFeedback(actionId, name, byActionId, byName) {
    const hit = byActionId ? byActionId.get(actionId) : null;
    if (hit) return hit;
    if (name && byName) return byName.get(name) || null;
    return null;
}

// Clear the OTHER side of a conflict. This is the only external write Plaid
// performs, and callers invoke it only after an explicit user click.
export function clearConflictBinding(Gio, conflict) {
    if (!conflict || !conflict.schemaId || !conflict.keyName) return false;
    try {
        const target = conflict.path
            ? new Gio.Settings({ schema_id: conflict.schemaId, path: conflict.path })
            : new Gio.Settings({ schema_id: conflict.schemaId });
        if (conflict.type === 's')
            target.set_string(conflict.keyName, '');
        else
            target.set_strv(conflict.keyName, []);
        return true;
    } catch (e) {
        return false;
    }
}
