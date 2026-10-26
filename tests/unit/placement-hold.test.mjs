import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin } from '../helpers.mjs';

function actorFor(win) {
  const actor = {
    visible: false,
    opacity: 0,
    removed: 0,
    set_opacity(v) { this.opacity = v; },
    remove_all_transitions() { this.removed++; },
    ease(props) { if (props && typeof props.opacity === 'number') this.opacity = props.opacity; },
  };
  win.get_compositor_private = () => actor;
  return actor;
}

function holdSelf(win) {
  const self = makeSelf({}, {
    _newWindowSet: new Set(),
    _windowWorkspaces: new Map([[win, 0]]),
    _windowMasks: new Map(),
    _queuedAnimWorkspaces: new Set(),
    _scheduleBorders() {},
    _scheduleRetile() {},
    _debugLog() {},
  });
  return self;
}

test('_revealHeldNewWindow: shows the held actor, resets the mask, clears the hold', () => {
  const win = fakeWin();
  const actor = actorFor(win);
  const self = holdSelf(win);
  const mask = { setOpacityUniform: (v) => { mask.value = v; }, value: 0 };
  self._windowMasks.set(win, mask);
  win._plaidHoldReveal = true;

  self._revealHeldNewWindow(win, 80);

  assert.equal(win._plaidHoldReveal, false);
  assert.equal(actor.visible, true);
  assert.equal(actor.opacity, 255);
  assert.equal(mask.value, 1);
});

test('_revealHeldNewWindow: is a no-op for a window that is not held', () => {
  const win = fakeWin();
  const actor = actorFor(win);
  const self = holdSelf(win);
  self._revealHeldNewWindow(win, 80);
  assert.equal(actor.visible, false);
  assert.equal(actor.opacity, 0);
});

test('_cancelAnimation: reveals windows still held hidden at teardown (regression)', () => {
  const win = fakeWin();
  const actor = actorFor(win);
  const self = holdSelf(win);
  win._plaidHoldReveal = true;

  self._cancelAnimation();

  assert.equal(win._plaidHoldReveal, false);
  assert.equal(actor.visible, true);
  assert.equal(actor.opacity, 255);
});
