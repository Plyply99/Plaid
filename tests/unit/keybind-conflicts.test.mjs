import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAccel } from '../../extensions/modules/helpers.js';
import { scanKeybindConflicts, describeConflict, resolveConflictFeedback, clearConflictBinding } from '../../extensions/modules/keybind-conflicts.js';

// A fake Gio with exactly what the scanner touches: Settings (constructed with
// a schema id, optionally a path), list_schemas, and the value accessors.
function fakeGio({ schemas = {}, customPaths = [], customBindings = {} } = {}) {
    class FakeSettings {
        constructor({ schema_id, path = null }) {
            this.schema_id = schema_id;
            this.path = path;
        }
        get settings_schema() {
            if (this.schema_id.endsWith('.custom-keybinding'))
                return { list_keys: () => ['binding', 'name', 'command'] };
            return { list_keys: () => Object.keys(schemas[this.schema_id] || {}) };
        }
        get_value(key) {
            const v = (schemas[this.schema_id] || {})[key];
            return v ? { get_type_string: () => 'as', deep_unpack: () => v } : null;
        }
        get_strv(key) {
            if (this.schema_id === 'org.gnome.settings-daemon.plugins.media-keys' && key === 'custom-keybindings')
                return customPaths;
            return (schemas[this.schema_id] || {})[key] || [];
        }
        get_string(key) {
            return (customBindings[this.path] || {})[key] ?? '';
        }
    }
    FakeSettings.list_schemas = () => Object.keys(schemas);
    return { Settings: FakeSettings };
}

const combosOf = (pairs) => new Map(pairs.map(([combo, key]) =>
    [normalizeAccel(combo), { orig: combo, owners: [key] }]));

test('scan: finds a clash in a fixed schema (type as)', () => {
    const Gio = fakeGio({ schemas: { 'org.gnome.settings-daemon.plugins.media-keys': { screensaver: ['<Super>l'] } } });
    const got = scanKeybindConflicts(Gio, 'plaid', combosOf([['<Super>l', 'move-focus-left']]));
    assert.equal(got.length, 1);
    assert.equal(got[0].schemaId, 'org.gnome.settings-daemon.plugins.media-keys');
    assert.equal(got[0].keyName, 'screensaver');
    assert.equal(got[0].type, 'as');
    assert.equal(got[0].path, null);
    assert.equal(got[0].owners[0], 'move-focus-left');
});

test('scan: finds a clash with a GNOME CUSTOM shortcut (relocatable, type s)', () => {
    const Gio = fakeGio({
        schemas: { 'org.gnome.settings-daemon.plugins.media-keys': {} },
        customPaths: ['/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom2/'],
        customBindings: { '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom2/': { binding: '<Super>t', name: 'Text Editor' } },
    });
    const got = scanKeybindConflicts(Gio, 'plaid', combosOf([['<Super>t', 'toggle-tiling']]));
    assert.equal(got.length, 1);
    assert.equal(got[0].type, 's');
    assert.equal(got[0].label, 'Text Editor');
    assert.ok(got[0].path.endsWith('custom2/'));
    assert.equal(describeConflict(got[0]), 'GNOME — Text Editor');
});

test('scan: modifier order does not matter', () => {
    const Gio = fakeGio({ schemas: { 'org.gnome.desktop.wm.keybindings': { 'switch-input-source-backward': ['<Shift><Super>space'] } } });
    const got = scanKeybindConflicts(Gio, 'plaid', combosOf([['<Super><Shift>space', 'toggle-float']]));
    assert.equal(got.length, 1);
    assert.equal(got[0].keyName, 'switch-input-source-backward');
});

test('scan: no clashes returns empty', () => {
    const Gio = fakeGio({
        schemas: { 'org.gnome.desktop.wm.keybindings': { minimize: ['<Super>h'] } },
        customPaths: ['/x/custom0/'],
        customBindings: { '/x/custom0/': { binding: '<Super>Return', name: 'Terminal' } },
    });
    const got = scanKeybindConflicts(Gio, 'plaid', combosOf([['<Super><Alt>h', 'move-focus-left']]));
    assert.deepEqual(got, []);
});

test('scan: never reports the owning schema against itself', () => {
    const Gio = fakeGio({ schemas: { plaid: { 'move-focus-left': ['<Super>l'] } } });
    const got = scanKeybindConflicts(Gio, 'plaid', combosOf([['<Super>l', 'move-focus-left']]));
    assert.deepEqual(got, []);
});

test('describeConflict: labels each source', () => {
    assert.equal(describeConflict({ path: null, schemaId: 'org.gnome.desktop.wm.keybindings', keyName: 'minimize' }), 'GNOME (minimize)');
    assert.equal(describeConflict({ path: null, schemaId: 'org.gnome.desktop.wm.keybindings', keyName: 'switch-input-source-backward' }), 'GNOME (switch input source backward)');
    assert.equal(describeConflict({ path: '/x/0/', schemaId: 'c', keyName: 'binding', label: '' }), 'GNOME — a custom shortcut');
    assert.equal(describeConflict({ path: null, schemaId: 'org.example.ext', keyName: 'do-thing' }), 'org.example.ext (do-thing)');
});


test('resolveConflictFeedback: action id match wins', () => {
  const byId = new Map([[42, { combo: '<Super>Up', owner: 'GNOME (maximize)' }]]);
  assert.deepEqual(
    resolveConflictFeedback(42, 'maximize', byId, new Map()),
    { combo: '<Super>Up', owner: 'GNOME (maximize)' });
});

test('resolveConflictFeedback: external binding name fallback', () => {
  const byName = new Map([['toggle-overview', { combo: '<Super>a', owner: 'GNOME (toggle overview)' }]]);
  assert.deepEqual(
    resolveConflictFeedback(999, 'toggle-overview', new Map(), byName),
    { combo: '<Super>a', owner: 'GNOME (toggle overview)' });
});

test('resolveConflictFeedback: unknown action/name is a miss', () => {
  assert.equal(resolveConflictFeedback(7, 'nope', new Map(), new Map()), null);
  assert.equal(resolveConflictFeedback(7, null, undefined, undefined), null);
});


test('clearConflictBinding: clears strv and custom string bindings', () => {
  const writes = [];
  class FakeSettings {
    constructor({ schema_id, path = null }) { this.schema_id = schema_id; this.path = path; }
    set_strv(k, v) { writes.push({ schema_id: this.schema_id, path: this.path, key: k, value: v }); }
    set_string(k, v) { writes.push({ schema_id: this.schema_id, path: this.path, key: k, value: v }); }
  }
  const Gio = { Settings: FakeSettings };

  assert.equal(clearConflictBinding(Gio, {
    schemaId: 'org.gnome.desktop.wm.keybindings', keyName: 'maximize', type: 'as', path: null,
  }), true);
  assert.equal(clearConflictBinding(Gio, {
    schemaId: 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding',
    keyName: 'binding', type: 's', path: '/custom0/',
  }), true);

  assert.deepEqual(writes[0], {
    schema_id: 'org.gnome.desktop.wm.keybindings', path: null, key: 'maximize', value: [],
  });
  assert.deepEqual(writes[1], {
    schema_id: 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding',
    path: '/custom0/', key: 'binding', value: '',
  });
});

test('clearConflictBinding: malformed conflict returns false', () => {
  assert.equal(clearConflictBinding({ Settings: class {} }, {}), false);
  assert.equal(clearConflictBinding({ Settings: class {} }, null), false);
});
