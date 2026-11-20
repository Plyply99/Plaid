import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin } from '../helpers.mjs';

test('revealWindow restores the actor and the mask opacity uniform', () => {
  const self = makeSelf();
  const actor = { visible: false, opacity: 0, set_opacity(v) { this.opacity = v; } };
  const win = fakeWin({ id: 7 });
  win.get_compositor_private = () => actor;
  const uniforms = [];
  self._windowMasks.set(win, { setOpacityUniform: (v) => uniforms.push(v) });

  self.windows.revealWindow(win);

  assert.equal(actor.visible, true);
  assert.equal(actor.opacity, 255);
  assert.deepEqual(uniforms, [1]);
});

test('revealWindow tolerates a window without an actor', () => {
  const self = makeSelf();
  const win = fakeWin({ id: 8 });
  win.get_compositor_private = () => null;

  self.windows.revealWindow(win);
});
