import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf } from '../helpers.mjs';

// The extension calls the GJS global `log`; stub it for these unit tests.
globalThis.log = () => {};

// Minimal GSettings-shaped fake with a user (dconf) layer distinct from the
// new schema defaults, so we can drive the fresh-vs-existing migration.
function keySettings(user = {}) {
    const defaults = {
        'keybind-migration-done': false,
        'keybind-migration-2-done': false,
        'inside-gap': 8,
        'move-focus-left': ['<Super><Alt>h'],
        'move-focus-right': ['<Super><Alt>l'],
        'move-focus-up': ['<Super><Alt>k'],
        'move-focus-down': ['<Super><Alt>j'],
        'toggle-float': ['<Super><Shift>f'],
        'scratchpad-toggle': ['<Super><Control>s'],
        'scratchpad-add': ['<Super><Shift>s'],
    };
    const keys = Object.keys(defaults);
    const u = { ...user };
    return {
        settings_schema: { list_keys: () => keys },
        get_boolean: (k) => (k in u ? u[k] : defaults[k]),
        set_boolean: (k, v) => { u[k] = v; },
        get_strv: (k) => (k in u ? u[k] : defaults[k]),
        set_strv: (k, v) => { u[k] = v; },
        get_user_value: (k) => (k in u ? { unpack: () => u[k] } : null),
        _user: u,
    };
}

const self = (user) => makeSelf({}, { _settings: keySettings(user) });

test('migration: fresh install keeps the new conflict-free defaults (nothing pinned)', () => {
    const s = self();
    s._migrateKeybindingDefaults();
    assert.equal(s._settings._user['keybind-migration-done'], true);
    assert.equal(s._settings._user['keybind-migration-2-done'], true);
    assert.equal('move-focus-left' in s._settings._user, false);
    assert.equal('toggle-float' in s._settings._user, false);
});

test('migration: existing install pins the superseded nav + toggle-float defaults', () => {
    const s = self({ 'inside-gap': 16 }); // any user-layer value proves an existing install
    s._migrateKeybindingDefaults();
    assert.deepEqual(s._settings._user['move-focus-left'], ['<Super>h']);
    assert.deepEqual(s._settings._user['move-focus-right'], ['<Super>l']);
    assert.deepEqual(s._settings._user['move-focus-up'], ['<Super>k']);
    assert.deepEqual(s._settings._user['move-focus-down'], ['<Super>j']);
    assert.deepEqual(s._settings._user['toggle-float'], ['<Super><Shift>space']);
});

test('migration: the scratchpad pass still runs, independently of the nav pass', () => {
    const s = self({ 'inside-gap': 16 });
    s._migrateKeybindingDefaults();
    assert.deepEqual(s._settings._user['scratchpad-toggle'], ['<Super>Escape']);
    assert.deepEqual(s._settings._user['scratchpad-add'], ['<Super><Shift>Escape']);
});

test('migration: a customized key is never overwritten', () => {
    const s = self({ 'inside-gap': 16, 'move-focus-left': ['<Super><Alt>Left'] });
    s._migrateKeybindingDefaults();
    assert.deepEqual(s._settings._user['move-focus-left'], ['<Super><Alt>Left']);
    assert.deepEqual(s._settings._user['move-focus-right'], ['<Super>l']); // others still pinned
});

test('migration: is idempotent (a second run changes nothing)', () => {
    const s = self({ 'inside-gap': 16 });
    s._migrateKeybindingDefaults();
    const snapshot = { ...s._settings._user };
    s._migrateKeybindingDefaults();
    assert.deepEqual(s._settings._user, snapshot);
});
