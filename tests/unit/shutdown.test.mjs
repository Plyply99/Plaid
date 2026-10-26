import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf } from '../helpers.mjs';

test('_onShellShutdown: sets the flag, clears queued retiles, cancels animation', () => {
  let cancelled = false;
  const self = makeSelf({}, {
    _shuttingDown: false,
    _pendingRetileIds: new Map([[{}, 1], [{}, 2]]),
    _cancelAnimation() { cancelled = true; },
  });

  self._onShellShutdown();

  assert.equal(self._shuttingDown, true);
  assert.equal(self._pendingRetileIds.size, 0);
  assert.equal(cancelled, true);
});

test('_scheduleRetile: no-op after shutdown (regression: retile ran after shutdown)', () => {
  const self = makeSelf({}, {
    _shuttingDown: true,
    _pendingRetileIds: new Map(),
    _lastRetileTimes: new Map(),
  });

  self._scheduleRetile({});

  assert.equal(self._pendingRetileIds.size, 0);
});

test('_animRetile: no-op after shutdown', () => {
  const self = makeSelf({}, { _shuttingDown: true, _animating: false });
  self._animRetile({}, []);
  assert.equal(self._animating, false);
});

test('_doRetileWorkspace: no-op after shutdown', () => {
  let scanned = false;
  const self = makeSelf({}, {
    _shuttingDown: true,
    _getWindowsForWorkspace() { scanned = true; return []; },
  });
  self._doRetileWorkspace({});
  assert.equal(scanned, false);
});
