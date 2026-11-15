import { test } from 'node:test';
import assert from 'node:assert/strict';
import Meta from 'gi://Meta';
import { makeSelf, fakeWin } from '../helpers.mjs';

test('desktop windows are never managed or floated', () => {
  const self = makeSelf({});
  const byType = fakeWin({ type: Meta.WindowType.DESKTOP });
  const byId = fakeWin({ type: Meta.WindowType.NORMAL, appId: 'com.rastersoft.ding' });

  assert.equal(self.windows.isDesktopWindow(byType), true);
  assert.equal(self.windows.isDesktopWindow(byId), true);
  assert.equal(self.windows.shouldManage(byType), false);
  assert.equal(self.windows.shouldManage(byId), false);
  assert.equal(self.windows.isFloating(byType), false);
  assert.equal(self.windows.isFloating(byId), false);
});

test('addWindow: a desktop window is not registered', () => {
  const self = makeSelf({});
  const win = fakeWin({ type: Meta.WindowType.DESKTOP });
  self.windows.addWindow(win);
  assert.equal(self._windowWorkspaces.has(win), false);
});

test('onWindowIdentityChanged: a late desktop identity un-tiles and strips Flair', () => {
  const self = makeSelf({});
  const win = fakeWin({ type: Meta.WindowType.DESKTOP });
  win.get_workspace = () => null;
  const calls = [];
  self._windowWorkspaces.set(win, {});
  self.windows.removeWindow = () => calls.push('remove');
  self.borders.removeBorder = () => calls.push('border');
  self.masks.removeMask = () => calls.push('mask');
  self.blur.removeBlur = () => calls.push('blur');

  self.windows.onWindowIdentityChanged(win);

  assert.deepEqual(calls, ['remove', 'border', 'mask', 'blur']);
});
