import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin } from '../helpers.mjs';

test('grabMoved: pointer travel without window movement is not a drag', () => {
  const self = makeSelf();
  const win = fakeWin({ frame: { x: 100, y: 100, width: 400, height: 300 } });
  self._grabStartFrame = { x: 100, y: 100, width: 400, height: 300 };
  self._grabStartX = 0;
  self._grabStartY = 0;
  self._grabGrace = 10;

  assert.equal(self.grab.grabMoved(win), false,
    'a cancelled drag restores the frame while the pointer is elsewhere');

  win.get_frame_rect = () => ({ x: 140, y: 100, width: 400, height: 300 });
  assert.equal(self.grab.grabMoved(win), true);
  assert.equal(self.grab.grabMoved(null), false);
});
