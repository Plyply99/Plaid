// Keybindings — registration, removal, conflict detection/fix, and Input
// feedback when a system shortcut already owns one of our combos.
// PLAID_KEYBIND_KEYS below is the single source of truth for the keys.
// Plaid NEVER writes GNOME keybindings or edge-tiling; those are the user's
// call. The conflict dialog only unbinds another schema after an explicit
// click on 'Let Plaid use it'.
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

import { normalizeAccel } from './helpers.js';
import { scanKeybindConflicts, describeConflict, resolveConflictFeedback, clearConflictBinding } from './keybind-conflicts.js';

// Every Plaid keybinding settings key — the single source of truth for
// registration (_registerKeybindings), removal (_removeKeybindings), and the
// startup/conflict feedback paths.
const PLAID_KEYBIND_KEYS = [
    'move-focus-left', 'move-focus-right', 'move-focus-up', 'move-focus-down',
    'swap-left', 'swap-right', 'swap-up', 'swap-down',
    'resize-shrink-width', 'resize-grow-width', 'resize-shrink-height', 'resize-grow-height',
    'toggle-float', 'toggle-tiling', 'toggle-maximize', 'center-window',
    'pick-float-window', 'cycle-layout',
    'scratchpad-toggle', 'scratchpad-add', 'dropdown-terminal',
];
export function _migrateKeybindingDefaults() {
    // One-time migrations for changed keybind defaults: existing installs keep
    // their binds. get_user_value() reads only the USER dconf layer, so any past
    // change proves an existing install, and a per-key null check never touches a
    // customized key. Each pass runs once (flag); a failed run retries safely.
    // Edge: an install with zero user-layer writes is indistinguishable from
    // fresh and picks up the new defaults (see the v51.17 notes).
    try {
        // Pass 1 — scratchpad moved to GNOME-compatible combos.
        if (!this._settings.get_boolean('keybind-migration-done')) {
            const pinned = this._pinOldKeybinds({
                'scratchpad-add': ['<Super><Shift>Escape'],
                'scratchpad-toggle': ['<Super>Escape'],
            });
            if (pinned === null)
                log('[plaid] keybind migration: fresh install — new scratchpad defaults active');
            else
                log('[plaid] keybind migration: existing install — kept old scratchpad defaults' +
                    (pinned.length ? ` (pinned: ${pinned.join(', ')})` : ' (keys already customized)'));
            this._settings.set_boolean('keybind-migration-done', true);
        }
        // Pass 2 — navigation moved off bare Super+H/Super+L (GNOME's minimize and
        // lock) and toggle-float off Super+Shift+Space (GNOME's
        // switch-input-source-backward), so a fresh install never clashes.
        if (!this._settings.get_boolean('keybind-migration-2-done')) {
            const pinned = this._pinOldKeybinds({
                'move-focus-left': ['<Super>h'],
                'move-focus-right': ['<Super>l'],
                'move-focus-up': ['<Super>k'],
                'move-focus-down': ['<Super>j'],
                'toggle-float': ['<Super><Shift>space'],
            });
            if (pinned === null)
                log('[plaid] keybind migration: fresh install — conflict-free navigation defaults active');
            else
                log('[plaid] keybind migration: existing install — kept old navigation defaults' +
                    (pinned.length ? ` (pinned: ${pinned.join(', ')})` : ' (keys already customized)'));
            this._settings.set_boolean('keybind-migration-2-done', true);
        }
    } catch (e) {
        log(`[plaid] keybind migration failed: ${e.message}`);
    }
}

export function _pinOldKeybinds(oldDefaults) {
    // Pin a superseded default onto the user layer for an EXISTING install (a
    // no-op for a fresh one) so changing the schema default never alters it. Keys
    // the user customized already have a value and are left alone. Returns the
    // pinned keys, or null when this is a fresh install.
    if (!this._hasUserSettings()) return null;
    const pinned = [];
    for (const [key, value] of Object.entries(oldDefaults)) {
        if (this._settings.get_user_value(key) === null) {
            this._settings.set_strv(key, value);
            pinned.push(key);
        }
    }
    return pinned;
}

export function _hasUserSettings() {
    // Any user-layer value (ignoring the migration markers, which every install
    // writes) proves this is not a fresh install.
    for (const key of this._settings.settings_schema.list_keys()) {
        if (key === 'keybind-migration-done' || key === 'keybind-migration-2-done') continue;
        if (this._settings.get_user_value(key) !== null) return true;
    }
    return false;
}

export function _registerKeybindings(dialogDelayMs = 2000) {
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
    this._failedKeybindCombos = new Map();
    this._keybindConflictTimes = new Map();
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
            const combos = this._settings.get_strv(key) || [];
            for (const combo of combos) {
                const norm = normalizeAccel(combo);
                if (norm) this._failedKeybindCombos.set(norm, { key, combo });
            }
        }
    }
    if (failures > 0)
        this._debugLog(`keybindings registered: ${bindings.length - failures}/${bindings.length} ok (${failures} failed)`);
    this._checkKeybindingConflicts(bindings, dialogDelayMs);
    // Re-scan when a binding changes (prefs, gsettings, CLI) so a clash with
    // GNOME is surfaced right away instead of only at the next login. Tracked so
    // a re-registration (the conflict dialog re-grabs after freeing a combo)
    // replaces the handlers instead of stacking duplicates.
    if (this._keybindChangeIds) {
        for (const id of this._keybindChangeIds) {
            this._settings.disconnect(id);
        }
    }
    this._keybindChangeIds = [];
    for (const { key } of bindings) {
        const id = this._settings.connect(`changed::${key}`, () => {
            this._debugLog(`keybind changed: ${key} — re-scanning for conflicts`);
            this._scheduleConflictScan(bindings);
        });
        this._keybindChangeIds.push(id);
    }
}

export function _checkKeybindingConflicts(bindings, dialogDelayMs = 2000) {
    // Combo-collision detector: two settings bindings sharing one combo make grab
    // registration a per-login race (the loser's key silently dies). Runs at
    // enable and again whenever a binding changes — journal every collision, and
    // surface cross-schema ones in a dialog whose "Let Plaid use it" writes the
    // other side (only on that explicit click).
    try {
        // Combos are compared in normalizeAccel form — '<Shift><Super>h'
        // and '<Super><Shift>h' are the same shortcut (systems write
        // modifier orders differently; a plain string compare misses it).
        const ourCombos = new Map(); // normalized -> { orig, owners }
        for (const { key } of bindings) {
            const combos = this._settings.get_strv(key);
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
        const conflicts = scanKeybindConflicts(Gio, this._settings.schema_id, ourCombos);
        for (const c of conflicts)
            log(`[plaid] keybinding CONFLICT: ${c.owners.join(' + ')} '${c.orig}' also bound by ` +
                `${describeConflict(c)} — grab race can kill the Plaid key for a session; ` +
                `unbind one side (or use the dialog to hand it to Plaid)`);
        // Only combos whose Plaid grab actually failed need runtime feedback:
        // a mode-gated other binding can leave our grab working. The dialog
        // follows the same set so it does not nag about non-problems.
        const failed = conflicts.filter(c => this._failedKeybindCombos.has(normalizeAccel(c.orig)));
        // Feedback maps use ALL cross-schema conflicts: if Plaid won the grab
        // the other action never fires, so the map is inert; if the other side
        // wins (including after a live prefs edit), the OSD is exactly right.
        this._buildKeybindFeedbackMaps(conflicts);
        if (failed.length)
            this._showConflictDialog(failed, dialogDelayMs);
        else
            this._destroyConflictDialog();
    } catch (e) {
        log(`[plaid] keybinding conflict scan failed: ${e.message}`);
    }
}

export function _buildKeybindFeedbackMaps(conflicts) {
    this._keybindConflictById = new Map();
    this._keybindConflictByName = new Map();
    for (const c of conflicts) {
        const entry = {
            combo: c.orig,
            owner: describeConflict(c),
            key: c.owners ? c.owners[0] : null,
        };
        if (c.keyName)
            this._keybindConflictByName.set(c.keyName, entry);
        if (c.path) {
            this._keybindConflictByName.set(c.path, entry);
            const base = c.path.replace(/\/+$/, '').split('/').pop();
            if (base) this._keybindConflictByName.set(base, entry);
        }
        let id = Meta.prefs_get_keybinding_action(c.keyName);
        // Fallback for mutter's built-in actions: their schema names map
        // directly onto the KeyBindingAction enum (maximize → MAXIMIZE,
        // toggle-tiled-left → TOGGLE_TILED_LEFT, …).
        if (!id) {
            const enumName = String(c.keyName || '').replace(/-/g, '_').toUpperCase();
            id = Meta.KeyBindingAction[enumName] || 0;
        }
        if (id) this._keybindConflictById.set(id, entry);
    }
    this._debugLog(`keybind feedback: ${this._keybindConflictById.size} by action, ` +
        `${this._keybindConflictByName.size} by name`);
}

export function _onAcceleratorActivated(actionId) {
    if (!this._settings || this._shuttingDown) return;
    if (!this._keybindConflictById.size && !this._keybindConflictByName.size) return;
    const name = Meta.external_binding_name_for_action(actionId);
    const hit = resolveConflictFeedback(actionId, name,
        this._keybindConflictById, this._keybindConflictByName);
    if (!hit) return;
    this._showKeybindConflict(hit.combo, hit.owner, hit.key);
}

export function _showKeybindConflict(combo, owner, keyName = null) {
    const norm = normalizeAccel(combo);
    const now = Date.now();
    if (!this._keybindConflictTimes) this._keybindConflictTimes = new Map();
    if (now - (this._keybindConflictTimes.get(norm) || 0) < 2500) return;
    this._keybindConflictTimes.set(norm, now);
    const action = keyName ? ` (${keyName.replace(/-/g, ' ')})` : '';
    const msg = _('%s%s is already used by %s')
        .replace('%s', () => combo)
        .replace('%s', () => action)
        .replace('%s', () => owner);
    this._debugLog(`keybind conflict: ${msg}`);
    try {
        if (Main.osdWindowManager.showOne) {
            const icon = new Gio.ThemedIcon({ name: 'dialog-warning-symbolic' });
            Main.osdWindowManager.showOne(
                global.display.get_current_monitor(), icon, msg, null, -1);
            return;
        }
    } catch (e) {
        this._debugLog(`keybind conflict osd failed: ${e.message}`);
    }
    this._showPopup(_('Shortcut unavailable'), msg, 2200);
}

export function _scheduleConflictScan(_bindings, dialogDelayMs = 150) {
    // Debounce: one edit in prefs can fire several changed:: signals, and a
    // GNOME-side shortcut change arrives as a separate schema signal.
    if (this._conflictScanId) {
        GLib.source_remove(this._conflictScanId);
    }
    this._conflictScanId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
        this._conflictScanId = 0;
        if (!this._settings) return GLib.SOURCE_REMOVE;
        // Re-GRAB, not just re-scan. A live edit (or a GNOME-side change)
        // can leave the previous grab stale: the key may still be held by
        // Plaid, so the system action never fires and the conflict map stays
        // empty. Re-adding refreshes the grab, the failed set, and the OSD
        // maps in one pass.
        this._debugLog('conflict scan: re-registering keybindings');
        this._removeKeybindings();
        this._registerKeybindings(dialogDelayMs);
        return GLib.SOURCE_REMOVE;
    });
}

export function _showConflictDialog(conflicts, delayMs = 2000) {
    // Mirrors _showFloatPickDialog's lifecycle: ref on this, teardown
    // helper, disable() hook. At enable the open is deferred ~2s so it lands
    // after login settle (and never fights a startup modal); a binding change
    // passes a short delay instead.
    this._destroyConflictDialog();

    const dialog = new ModalDialog();
    this._conflictDialog = dialog;

    const content = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 10px;' });
    content.add_child(new St.Label({
        text: _('Shortcut conflict'),
        style: 'font-weight: bold; font-size: 14px;',
    }));
    const allGnome = conflicts.every(c =>
        String(c.schemaId || '').startsWith('org.gnome.'));
    for (const c of conflicts) {
        const isGnome = String(c.schemaId || '').startsWith('org.gnome.');
        const line = new St.Label({
            text: (isGnome
                ? _('%s conflicts with %s. Disable the GNOME shortcut and use it?')
                : _('%s conflicts with %s. Disable the conflicting shortcut and use it?'))
                .replace('%s', () => c.combo)
                .replace('%s', () => describeConflict(c)),
        });
        line.clutter_text.set_line_wrap(true);
        content.add_child(line);
    }
    dialog.contentLayout.add_child(content);

    dialog.setButtons([
        {
            label: allGnome
                ? _('Disable GNOME shortcut and use it')
                : _('Disable conflicting shortcut and use it'),
            key: Clutter.KEY_f,
            action: () => {
                for (const c of conflicts) {
                    if (clearConflictBinding(Gio, c))
                        log(`[plaid] keybinding conflict freed: ${c.schemaId}${c.path || ''} ${c.keyName} (was '${c.combo}')`);
                    else
                        log(`[plaid] keybinding conflict fix failed: ${c.schemaId}${c.path || ''} ${c.keyName}`);
                }
                // The other side owned the grab, so Plaid's binding was
                // never registered — drop and re-add ours now that the combo
                // is free, or the key stays dead until the next login.
                this._removeKeybindings();
                this._registerKeybindings();
                this._destroyConflictDialog();
                this._showPopup(_('Shortcut fixed'),
                    conflicts.length === 1
                        ? _('Plaid now uses %s').replace('%s', conflicts[0].combo)
                        : _('Plaid now uses its own shortcuts'));
            },
        },
        {
            label: _('Keep it as is'),
            key: Clutter.KEY_Escape,
            action: () => this._destroyConflictDialog(),
        },
    ]);

    this._conflictDialogId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
        this._conflictDialogId = 0;
        if (!this._settings || !this._conflictDialog) return GLib.SOURCE_REMOVE;
        dialog.open();
        return GLib.SOURCE_REMOVE;
    });

}

export function _destroyConflictDialog() {
    if (this._conflictScanId) {
        // A pending change-triggered scan must not outlive disable (or fire
        // against a stale closure after an unlock re-enable).
        GLib.source_remove(this._conflictScanId);
        this._conflictScanId = 0;
    }
    if (this._conflictDialogId) {
        GLib.source_remove(this._conflictDialogId);
        this._conflictDialogId = 0;
    }
    if (this._conflictDialog) {
        this._conflictDialog.close();
        this._conflictDialog = null;
    }
}

export function _removeKeybindings() {
    for (const key of PLAID_KEYBIND_KEYS) {
        Main.wm.removeKeybinding(key);
    }
    // Per-key changed handlers are managed here rather than through
    // _signals: re-registration replaces them, and tracking them twice would
    // leave stale ids for _disconnectSignals to trip over.
    if (this._keybindChangeIds) {
        for (const id of this._keybindChangeIds) {
            this._settings.disconnect(id);
        }
        this._keybindChangeIds = [];
    }
    this._failedKeybindCombos = null;
    this._keybindConflictById = null;
    this._keybindConflictByName = null;
    this._keybindConflictTimes = null;
}


export const keybindMethods = {
    _migrateKeybindingDefaults,
    _pinOldKeybinds,
    _hasUserSettings,
    _registerKeybindings,
    _checkKeybindingConflicts,
    _buildKeybindFeedbackMaps,
    _onAcceleratorActivated,
    _showKeybindConflict,
    _scheduleConflictScan,
    _showConflictDialog,
    _destroyConflictDialog,
    _removeKeybindings,
};
