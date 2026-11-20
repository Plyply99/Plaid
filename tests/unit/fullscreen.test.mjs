import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';

function withWorkspace(fn) {
  const ws = { get_work_area_for_monitor: () => ({ x: 0, y: 0, width: 2000, height: 1000 }) };
  const old = globalThis.global;
  globalThis.global = {
    ...old,
    display: { ...old.display, get_primary_monitor: () => 0 },
    workspace_manager: {
      get_n_workspaces: () => 2,
      get_workspace_by_index: (i) => (i === 1 ? ws : null),
      get_active_workspace: () => ws,
    },
    get_pointer: () => [0, 0],
  };
  try {
    return fn(ws);
  } finally {
    globalThis.global = old;
  }
}

let nextId = 1;
function tile(opts = {}, ws = null) {
  const w = fakeWin(opts);
  const id = nextId++;
  w.get_id = () => id;
  w.get_workspace = () => (opts.fullscreen ? ws : null);
  w.get_compositor_private = () => null;
  return w;
}

test('isFloating: a fullscreen tile is excluded from tiling but does not float', () => {
  const self = makeSelf();
  const w = tile({ fullscreen: true });
  assert.equal(self.windows.isFloating(w), true);
  assert.equal(self.windows.floatsWhenWindowed(w), false);
});

test('retileDwindle: a fullscreen tile keeps its leaf', () => {
  withWorkspace((ws) => {
    const self = makeSelf();
    const a = tile({ fullscreen: true }, ws);
    const b = tile();
    const c = tile();
    self._windowWorkspaces.set(a, ws);
    self._bspTrees.set(ws, split('h', 0.5, leaf(a), leaf(b)));
    self.grab.safeMove = () => {};

    self.layouts.retileDwindle(ws, [b, c], 0);

    const ids = self.bsp.bspCollectWindows(self._bspTrees.get(ws)).map(w => w.get_id()).sort();
    assert.deepEqual(ids, [a, b, c].map(w => w.get_id()).sort());
  });
});

test('onWindowIdentityChanged: a retitled fullscreen tile keeps its leaf', () => {
  withWorkspace((ws) => {
    const self = makeSelf();
    const a = tile({ fullscreen: true }, ws);
    const b = tile();
    self._windowWorkspaces.set(a, ws);
    const tree = split('h', 0.5, leaf(a), leaf(b));
    self._bspTrees.set(ws, tree);

    self.windows.onWindowIdentityChanged(a);

    assert.equal(self._bspTrees.get(ws), tree);
    assert.deepEqual(self.bsp.bspCollectWindows(tree), [a, b]);
  });
});

test('isFullscreenTile: only on its workspace, registered, and not floating', () => {
  withWorkspace((ws) => {
    const self = makeSelf();
    const a = tile({ fullscreen: true }, ws);
    self._windowWorkspaces.set(a, ws);

    assert.equal(self.windows.isFullscreenTile(a, ws), true);
    assert.equal(self.windows.isFullscreenTile(a, {}), false);

    self._windowWorkspaces.delete(a);
    assert.equal(self.windows.isFullscreenTile(a, ws), false);

    self._windowWorkspaces.set(a, ws);
    self._toggleFloatWindows.add(a);
    assert.equal(self.windows.isFullscreenTile(a, ws), false);
  });
});

test('adjustForConstraints: a fullscreen leaf does not bend its parent', () => {
  withWorkspace((ws) => {
    const self = makeSelf();
    const fs = tile({ fullscreen: true, frame: { x: 0, y: 0, width: 2000, height: 1000 } }, ws);
    const b = tile({ frame: { x: 1000, y: 0, width: 1000, height: 500 } });
    const c = tile({ frame: { x: 1000, y: 500, width: 1000, height: 500 } });
    const tree = split('h', 0.5, leaf(fs), split('v', 0.5, leaf(b), leaf(c)));
    self.grab.safeMove = () => {};
    self.bsp.bspLayout(tree, 0, 0, 2000, 1000, 0);

    assert.equal(self.bsp.adjustForConstraints(tree, null, true, 0, 0, 2000, 1000, 0, 0), false);
    assert.equal(tree.ratio, 0.5);
  });
});

test('notify::fullscreen: leaving fullscreen retiles, entering does not', () => {
  const self = makeSelf();
  const ws = {};
  const state = { fullscreen: true };
  const win = fakeWin();
  win.get_workspace = () => ws;
  win.is_fullscreen = () => state.fullscreen;
  const retiled = [];
  self.layouts.retileWorkspace = (w) => retiled.push(w);

  self.windows.connectWindowSignals(win);
  self._landingRetries.set(win, 2);
  win._signals['notify::fullscreen']();
  assert.deepEqual(retiled, []);
  assert.equal(self._landingRetries.has(win), false, 'toggle clears landing retries');

  state.fullscreen = false;
  win._signals['notify::fullscreen']();
  assert.deepEqual(retiled, [ws]);
});
