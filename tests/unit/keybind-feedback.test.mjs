import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf } from '../helpers.mjs';

test('_onAcceleratorActivated: shows the dead combo for a matching action id', () => {
  let shown = null;
  const self = makeSelf({}, {
    _shuttingDown: false,
    _keybindConflictById: new Map([[42, {
      combo: '<Super>Up', owner: 'GNOME (maximize)', key: 'move-focus-up',
    }]]),
    _keybindConflictByName: new Map(),
    _showKeybindConflict: (combo, owner, key) => { shown = { combo, owner, key }; },
  });

  self._onAcceleratorActivated(42);

  assert.deepEqual(shown, {
    combo: '<Super>Up', owner: 'GNOME (maximize)', key: 'move-focus-up',
  });
});

test('_onAcceleratorActivated: ignores an unmatched action', () => {
  let shown = false;
  const self = makeSelf({}, {
    _shuttingDown: false,
    _keybindConflictById: new Map([[42, { combo: '<Super>Up' }]]),
    _keybindConflictByName: new Map(),
    _showKeybindConflict: () => { shown = true; },
  });

  self._onAcceleratorActivated(7);

  assert.equal(shown, false);
});

test('_showKeybindConflict: throttles repeats and falls back to the Plaid popup', () => {
  const calls = [];
  const self = makeSelf({}, {
    _showPopup: (title, subtitle) => calls.push({ title, subtitle }),
    _debugLog() {},
    _keybindConflictTimes: new Map(),
  });

  self._showKeybindConflict('<Super>Up', 'GNOME (maximize)', 'move-focus-up');
  self._showKeybindConflict('<Super>Up', 'GNOME (maximize)', 'move-focus-up');

  assert.equal(calls.length, 1);
  assert.match(calls[0].subtitle, /<Super>Up/);
  assert.match(calls[0].subtitle, /move focus up/);
  assert.match(calls[0].subtitle, /GNOME \(maximize\)/);
});
