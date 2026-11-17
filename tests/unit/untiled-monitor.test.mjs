import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin } from '../helpers.mjs';

function withFocus(monitor, fn) {
  const self = makeSelf({});
  const ws = {};
  const win = fakeWin({ monitor });
  win.get_workspace = () => ws;
  const oldFocus = globalThis.global.display.focus_window;
  globalThis.global.display.focus_window = win;
  try {
    fn(self, win);
  } finally {
    globalThis.global.display.focus_window = oldFocus;
  }
}

test('resizeWindow: an untiled display resizes like a floating window', () => {
  withFocus(1, (self, win) => {
    self.monitors.monitorTiled = () => false;
    const calls = [];
    self.actions.resizeFloating = (w, axis, delta) => calls.push({ w, axis, delta });
    self.actions.resizeWindow('grow', 'width');
    assert.deepEqual(calls, [{ w: win, axis: 'width', delta: 0 }]);
  });
});

test('swapWindow: an untiled display moves like a floating window', () => {
  withFocus(1, (self, win) => {
    self.monitors.monitorTiled = () => false;
    const calls = [];
    self.actions.moveFloating = (w, direction) => calls.push({ w, direction });
    self.actions.swapWindow('left');
    assert.deepEqual(calls, [{ w: win, direction: 'left' }]);
  });
});

test('grab: untiled displays are left to Mutter', () => {
  const self = makeSelf({});
  self.monitors.monitorTiled = () => false;
  const win = fakeWin({ monitor: 1, frame: { x: 0, y: 0, width: 100, height: 100 } });
  win.get_workspace = () => ({});
  self.grab.handleGrabBegin(win, 1);
  assert.equal(self._grabOp, null);
});

test('markPendingWindowInvisible: an untiled display is not held', () => {
  const self = makeSelf({ enabled: true });
  self.monitors.monitorTiled = () => false;
  const win = fakeWin({ monitor: 1 });
  win.get_workspace = () => ({});
  const actor = { visible: true, set_opacity() {} };
  self._newWindowSet.add(win);

  self.windows.markPendingWindowInvisible(win, actor);

  assert.equal(actor.visible, true);
  assert.equal(self._pendingWarp.has(win), false);
});

test('centerWindow: an untiled display centres inside its own monitor', () => {
  withFocus(1, (self, win) => {
    self.monitors.monitorTiled = () => false;
    self.windows.moveCursorToWindow = () => {};
    self.currentTime = () => 0;
    const ws = win.get_workspace();
    ws.get_work_area_for_monitor = (m) => m === 1
      ? { x: 1000, y: 0, width: 1000, height: 800 }
      : { x: 0, y: 0, width: 1920, height: 1080 };
    win.get_frame_rect = () => ({ x: 0, y: 0, width: 400, height: 300 });
    const moves = [];
    win.move_resize_frame = (userOp, x, y, w, h) => moves.push({ x, y, w, h });

    self.actions.centerWindow();

    assert.deepEqual(moves, [{ x: 1300, y: 250, w: 400, h: 300 }]);
  });
});
