// Keybindings — registration, removal, conflict detection/fix, and the
// mutter-default yield on enable/disable. PLAID_KEYBIND_KEYS below is the
// single source of truth for the keys.
//
// Methods are attached to TilingWMExtension.prototype in extension.js.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ModalDialog } from 'resource:///org/gnome/shell/ui/modalDialog.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { normalizeAccel, schemaDefaultValue } from './helpers.js';

// Every Plaid keybinding settings key — the single source of truth for
// registration (_registerKeybindings), removal (_removeKeybindings), and the
// "which GNOME shortcuts must yield" check in _disableMutterDefaults.
const PLAID_KEYBIND_KEYS = [
    'move-focus-left', 'move-focus-right', 'move-focus-up', 'move-focus-down',
    'swap-left', 'swap-right', 'swap-up', 'swap-down',
    'resize-shrink-width', 'resize-grow-width', 'resize-shrink-height', 'resize-grow-height',
    'toggle-float', 'toggle-tiling', 'toggle-maximize', 'center-window',
    'pick-float-window', 'cycle-layout',
    'scratchpad-toggle', 'scratchpad-add', 'dropdown-terminal',
];
export function _disableMutterDefaults() {
    // While Plaid is active these mutter keys are modified so edge-tiling and
    // maximize shortcuts don't fight our layouts: minimize / unmaximize /
    // toggle-tiled are unbound ONLY when a Plaid keybind holds the same combo
    // (modifier order ignored); otherwise they are untouched. All restored to
    // their pre-Plaid state on disable().
    try {
        this._mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
        this._savedEdgeTiling = this._mutterSettings.get_boolean('edge-tiling');
        if (!this._savedEdgeTiling) {
            const def = schemaDefaultValue(this._mutterSettings, 'edge-tiling');
            if (typeof def === 'boolean') this._savedEdgeTiling = def;
        }
        this._mutterSettings.set_boolean('edge-tiling', false);
        this._wmKeybindings = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.keybindings' });
        this._savedMaximize = this._wmKeybindings.get_strv('maximize');
        if (this._savedMaximize.length === 0)
            this._savedMaximize = schemaDefaultValue(this._wmKeybindings, 'maximize') || [];
        this._savedMaximizeHoriz = this._wmKeybindings.get_strv('maximize-horizontally');
        if (this._savedMaximizeHoriz.length === 0)
            this._savedMaximizeHoriz = schemaDefaultValue(this._wmKeybindings, 'maximize-horizontally') || [];
        this._savedMaximizeVert = this._wmKeybindings.get_strv('maximize-vertically');
        if (this._savedMaximizeVert.length === 0)
            this._savedMaximizeVert = schemaDefaultValue(this._wmKeybindings, 'maximize-vertically') || [];
        this._wmKeybindings.set_strv('maximize', []);
        this._wmKeybindings.set_strv('maximize-horizontally', []);
        this._wmKeybindings.set_strv('maximize-vertically', []);
        try {
            this._savedToggleMaximized = this._wmKeybindings.get_strv('toggle-maximized');
            if (this._savedToggleMaximized.length === 0)
                this._savedToggleMaximized = schemaDefaultValue(this._wmKeybindings, 'toggle-maximized') || [];
            this._wmKeybindings.set_strv('toggle-maximized', []);
        } catch (e) {
            log(`[plaid] wm toggle-maximized key unavailable: ${e.message}`);
        }
    } catch (e) {
        log(`[plaid] mutter defaults disable failed: ${e.message}`);
    }
    this._savedYieldKeys = [];
    try {
        const held = new Set();
        for (const key of PLAID_KEYBIND_KEYS) {
            try {
                for (const combo of this._settings.get_strv(key)) {
                    if (combo) held.add(normalizeAccel(combo));
                }
            } catch (_e) {}
        }
        try {
            this._mutterKbSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter.keybindings' });
        } catch (_e) {
            this._mutterKbSettings = null;
        }
        const candidates = [
            [this._wmKeybindings, 'minimize'],
            [this._wmKeybindings, 'unmaximize'],
            [this._mutterKbSettings, 'toggle-tiled-left'],
            [this._mutterKbSettings, 'toggle-tiled-right'],
        ];
        for (const [settings, key] of candidates) {
            if (!settings) continue;
            try {
                const current = settings.get_strv(key);
                let saveValue = current;
                if (saveValue.length === 0)
                    saveValue = schemaDefaultValue(settings, key) || [];
                if (current.some((combo) => held.has(normalizeAccel(combo)))) {
                    this._savedYieldKeys.push({ settings, key, value: saveValue });
                    settings.set_strv(key, []);
                    log(`[plaid] yielded GNOME shortcut: ${key} (same combo as a Plaid keybind) — restored on disable`);
                }
            } catch (e) {
                log(`[plaid] yield ${key} failed: ${e.message}`);
            }
        }
    } catch (e) {
        log(`[plaid] conditional keybind yield failed: ${e.message}`);
    }
}

export function _restoreMutterDefaults() {
    // Reverses the writes above; per-key null guards ensure each key is attempted
    // even if an earlier restore fails.
    if (this._mutterSettings) {
        this._mutterSettings.set_boolean('edge-tiling', this._savedEdgeTiling);
        this._mutterSettings = null;
    }
    if (this._wmKeybindings) {
        this._wmKeybindings.set_strv('maximize', this._savedMaximize);
        this._wmKeybindings.set_strv('maximize-horizontally', this._savedMaximizeHoriz);
        this._wmKeybindings.set_strv('maximize-vertically', this._savedMaximizeVert);
        try {
            this._wmKeybindings.set_strv('toggle-maximized', this._savedToggleMaximized);
        } catch (e) {
            log(`[plaid] wm toggle-maximized restore unavailable: ${e.message}`);
        }
        this._wmKeybindings = null;
    }
    if (this._savedYieldKeys) {
        for (const y of this._savedYieldKeys) {
            try { y.settings.set_strv(y.key, y.value); } catch (_e) {}
        }
        this._savedYieldKeys = null;
    }
    this._mutterKbSettings = null;
}

export function _migrateKeybindingDefaults() {
    // One-time migration (the scratchpad defaults moved to GNOME-compatible
    // combos): existing installs keep their binds. get_user_value() reads only the
    // USER dconf layer, so any past change proves an existing install, and a
    // per-key null check never touches customized keys. Runs once (flag); a failed
    // run retries safely. Edge: an install with zero user-layer writes is
    // indistinguishable from fresh and picks up the new defaults (see the v51.17 notes).
    try {
        if (this._settings.get_boolean('keybind-migration-done')) return;
        let hasUserKeys = false;
        for (const key of this._settings.settings_schema.list_keys()) {
            try {
                if (this._settings.get_user_value(key) !== null) {
                    hasUserKeys = true;
                    break;
                }
            } catch (_e) {}
        }
        if (hasUserKeys) {
            const oldDefaults = {
                'scratchpad-add': ['<Super><Shift>Escape'],
                'scratchpad-toggle': ['<Super>Escape'],
            };
            const pinned = [];
            for (const [key, value] of Object.entries(oldDefaults)) {
                if (this._settings.get_user_value(key) === null) {
                    this._settings.set_strv(key, value);
                    pinned.push(key);
                }
            }
            log(`[plaid] keybind migration: existing install — kept old scratchpad defaults` +
                (pinned.length ? ` (pinned: ${pinned.join(', ')})` : ' (keys already customized)'));
        } else {
            log('[plaid] keybind migration: fresh install — new scratchpad defaults active');
        }
        this._settings.set_boolean('keybind-migration-done', true);
    } catch (e) {
        log(`[plaid] keybind migration failed: ${e.message}`);
    }
}

export function _registerKeybindings() {
    const bindings = [
        { key: 'move-focus-left', fn: () => this._moveFocus('left') },
        { key: 'move-focus-right', fn: () => this._moveFocus('right') },
        { key: 'move-focus-up', fn: () => this._moveFocus('up') },
        { key: 'move-focus-down', fn: () => this._moveFocus('down') },
        { key: 'swap-left', fn: () => this._swapWindow('left') },
        { key: 'swap-right', fn: () => this._swapWindow('right') },
        { key: 'swap-up', fn: () => this._swapWindow('up') },
        { key: 'swap-down', fn: () => this._swapWindow('down') },
        { key: 'resize-shrink-width', fn: () => this._resizeWindow('shrink', 'width') },
        { key: 'resize-grow-width', fn: () => this._resizeWindow('grow', 'width') },
        { key: 'resize-shrink-height', fn: () => this._resizeWindow('shrink', 'height') },
        { key: 'resize-grow-height', fn: () => this._resizeWindow('grow', 'height') },
        { key: 'toggle-float', fn: () => this._toggleFloat() },
        { key: 'toggle-tiling', fn: () => this._toggleTiling() },
        { key: 'toggle-maximize', fn: () => this._toggleMaximize() },
        { key: 'center-window', fn: () => this._centerWindow() },
        { key: 'pick-float-window', fn: () => this._handlePickFloat() },
        { key: 'cycle-layout', fn: () => this._cycleLayout() },
        { key: 'scratchpad-toggle', fn: () => this._scratchpadToggle() },
        { key: 'scratchpad-add', fn: () => this._scratchpadAdd() },
        { key: 'dropdown-terminal', fn: () => this._toggleDropdownTerminal() },
    ];

    let failures = 0;
    for (const { key, fn } of bindings) {
        const ok = Main.wm.addKeybinding(
            key,
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            fn
        );
        if (ok) {
            this._debugLog(`keybind: ${key} registered`);
        } else {
            log(`[plaid] keybind: ${key} grab FAILED (conflict or invalid binding)`);
            failures++;
        }
    }
    if (failures > 0)
        log(`[plaid] keybindings registered: ${bindings.length - failures}/${bindings.length} ok (${failures} failed)`);
    this._checkKeybindingConflicts(bindings);
}

export function _checkKeybindingConflicts(bindings) {
    // Combo-collision detector: two settings bindings sharing one combo make grab
    // registration a per-login race (the loser's key silently dies). Scan at
    // enable — journal every collision, and surface cross-schema ones in a dialog
    // whose Fix-now writes the other side (only on that explicit click).
    try {
        // Combos are compared in normalizeAccel form — '<Shift><Super>h'
        // and '<Super><Shift>h' are the same shortcut (systems write
        // modifier orders differently; a plain string compare misses it).
        const ourCombos = new Map(); // normalized -> { orig, owners }
        for (const { key } of bindings) {
            let combos = [];
            try { combos = this._settings.get_strv(key); } catch (_e) {}
            for (const combo of combos) {
                if (!combo) continue;
                const norm = normalizeAccel(combo);
                let entry = ourCombos.get(norm);
                if (!entry) {
                    entry = { orig: combo, owners: [] };
                    ourCombos.set(norm, entry);
                }
                entry.owners.push(key);
            }
        }
        for (const entry of ourCombos.values()) {
            if (entry.owners.length > 1)
                log(`[plaid] keybinding CONFLICT: ${entry.owners.join(' + ')} all use '${entry.orig}' — remap one of them in prefs`);
        }
        const ownSchema = this._settings.schema_id;
        const conflicts = [];
        for (const schemaId of Gio.Settings.list_schemas()) {
            if (schemaId === ownSchema) continue;
            let settings;
            try { settings = new Gio.Settings({ schema_id: schemaId }); } catch (_e) { continue; }
            let keys;
            try { keys = settings.settings_schema.list_keys(); } catch (_e) { continue; }
            for (const keyName of keys) {
                let value;
                try { value = settings.get_value(keyName); } catch (_e) { continue; }
                if (!value || value.get_type_string() !== 'as') continue;
                let combos;
                try { combos = value.deep_unpack(); } catch (_e) { continue; }
                for (const combo of combos) {
                    const entry = ourCombos.get(normalizeAccel(combo));
                    if (!entry) continue;
                    log(`[plaid] keybinding CONFLICT: ${entry.owners.join(' + ')} '${entry.orig}' also bound by ` +
                        `${schemaId} ${keyName} — grab race can kill the Plaid key for a session; ` +
                        `unbind one side: gsettings set ${schemaId} ${keyName} '[]' (or remap in Plaid prefs)`);
                    conflicts.push({ owners: entry.owners, combo: entry.orig, schemaId, keyName });
                }
            }
        }
        if (conflicts.length)
            this._showConflictDialog(conflicts);
    } catch (e) {
        log(`[plaid] keybinding conflict scan failed: ${e.message}`);
    }
}

export function _showConflictDialog(conflicts) {
    // Mirrors _showFloatPickDialog's lifecycle: ref on this, teardown
    // helper, disable() hook. Open is deferred ~2s so it lands after
    // login settle (and never fights a startup modal).
    this._destroyConflictDialog();
    try {
        const dialog = new ModalDialog();
        this._conflictDialog = dialog;

        const content = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 10px;' });
        content.add_child(new St.Label({
            text: _('Shortcut conflict'),
            style: 'font-weight: bold; font-size: 14px;',
        }));
        for (const c of conflicts) {
            const other = c.schemaId.startsWith('org.gnome.') ? _('GNOME') : c.schemaId;
            const line = new St.Label({
                text: _('Plaid and %s both want %s. One of them may randomly stop working.')
                    .replace('%s', other)
                    .replace('%s', c.combo),
            });
            line.clutter_text.set_line_wrap(true);
            content.add_child(line);
        }
        dialog.contentLayout.add_child(content);

        dialog.setButtons([
            {
                label: _('Let Plaid use it'),
                key: Clutter.KEY_f,
                action: () => {
                    for (const c of conflicts) {
                        try {
                            new Gio.Settings({ schema_id: c.schemaId }).set_strv(c.keyName, []);
                            log(`[plaid] keybinding conflict fixed: unbound ${c.schemaId} ${c.keyName} (was '${c.combo}')`);
                        } catch (e) {
                            log(`[plaid] keybinding conflict fix failed: ${e.message}`);
                        }
                    }
                    this._destroyConflictDialog();
                    this._showPopup(_('Shortcut fixed'),
                        conflicts.length === 1
                            ? _('Plaid now uses %s').replace('%s', conflicts[0].combo)
                            : _('Plaid now uses its own shortcuts'));
                },
            },
            {
                label: _('Not now'),
                key: Clutter.KEY_Escape,
                action: () => this._destroyConflictDialog(),
            },
        ]);

        this._conflictDialogId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            this._conflictDialogId = 0;
            if (this._destroyed || !this._conflictDialog) return GLib.SOURCE_REMOVE;
            try { dialog.open(); } catch (_e) {}
            return GLib.SOURCE_REMOVE;
        });
    } catch (e) {
        log(`[plaid] conflict dialog failed: ${e.message}`);
    }
}

export function _destroyConflictDialog() {
    if (this._conflictDialogId) {
        try { GLib.source_remove(this._conflictDialogId); } catch (_e) {}
        this._conflictDialogId = 0;
    }
    if (this._conflictDialog) {
        try { this._conflictDialog.close(); } catch (_e) {}
        this._conflictDialog = null;
    }
}

export function _removeKeybindings() {
    for (const key of PLAID_KEYBIND_KEYS) {
        Main.wm.removeKeybinding(key);
    }
}


export const keybindMethods = {
    _disableMutterDefaults,
    _restoreMutterDefaults,
    _migrateKeybindingDefaults,
    _registerKeybindings,
    _checkKeybindingConflicts,
    _showConflictDialog,
    _destroyConflictDialog,
    _removeKeybindings,
};
