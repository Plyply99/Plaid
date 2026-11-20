import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin } from '../helpers.mjs';

function withFixedMonitors(fn) {
  const ws1 = { get_work_area_for_monitor: () => ({ x: 0, y: 0, width: 1920, height: 1080 }) };
  const ws2 = { get_work_area_for_monitor: () => ({ x: 0, y: 0, width: 1920, height: 1080 }) };
  const old = globalThis.global;
  globalThis.global = {
    ...old,
    display: {
      ...old.display,
      get_n_monitors: () => 2,
      get_primary_monitor: () => 0,
      get_monitor_geometry: (m) => (m === 0
        ? { x: 0, y: 0, width: 1920, height: 1080 }
        : { x: 1920, y: 0, width: 1920, height: 1080 }),
      get_monitor_scale: () => 1,
      get_current_monitor: () => 0,
      sort_windows_by_stacking: (wins) => wins,
      focus_window: null,
    },
    workspace_manager: {
      get_n_workspaces: () => 2,
      get_workspace_by_index: (i) => (i === 0 ? ws1 : ws2),
      get_active_workspace: () => ws2,
    },
    get_pointer: () => [2100, 50],
    get_current_time: () => 1,
  };
  try {
    return fn(ws1, ws2);
  } finally {
    globalThis.global = old;
  }
}

function fixedSelf(ws1, ws2) {
  const self = makeSelf({}, { _mutterSettings: { get_boolean: () => true } });
  self.monitors.connectorForMonitor = (m) => (m === 0 ? 'HDMI-1' : 'DP-1');

  const primary = fakeWin({ id: 2, monitor: 0, frame: { x: 100, y: 100, width: 400, height: 300 } });
  const dp = fakeWin({ id: 1, monitor: 1, frame: { x: 2000, y: 0, width: 800, height: 600 } });
  primary.get_workspace = () => ws2;
  dp.get_workspace = () => ws1;

  self._workspaceOrders.set(ws1, [dp]);
  self._workspaceOrders.set(ws2, [primary]);
  self._windowMonitors.set(primary, 'HDMI-1');
  self._windowMonitors.set(dp, 'DP-1');
  self._windowWorkspaces.set(primary, ws2);
  self._windowWorkspaces.set(dp, ws1);
  self._windowWSIndices.set(primary, 1);
  self._windowWSIndices.set(dp, 0);
  return { self, primary, dp };
}

test('getVisibleTiledWindows: includes fixed secondary windows from another workspace', () => {
  withFixedMonitors((ws1, ws2) => {
    const { self, primary, dp } = fixedSelf(ws1, ws2);
    const ids = self.windows.getVisibleTiledWindows(ws2).map(w => w.get_id()).sort();
    assert.deepEqual(ids, [primary.get_id(), dp.get_id()].sort());
  });
});

test('getVisibleTiledWindows: a sticky fixed window whose live workspace differs is still visible', () => {
  withFixedMonitors((ws1, ws2) => {
    const { self, dp } = fixedSelf(ws1, ws2);
    // Mutter can report the active workspace while the window stays in its
    // original per-workspace order.
    dp.get_workspace = () => ws2;
    const ids = self.windows.getVisibleTiledWindows(ws2).map(w => w.get_id());
    assert.ok(ids.includes(dp.get_id()));
  });
});

test('moveFocus: reaches a fixed secondary window across workspaces', () => {
  withFixedMonitors((ws1, ws2) => {
    const { self, primary, dp } = fixedSelf(ws1, ws2);
    globalThis.global.display.focus_window = primary;
    let activated = null;
    dp.activate = () => { activated = dp; };
    self.bsp.findDirectionalTarget = (_focused, _dir, wins) =>
      (wins.includes(dp) ? dp : null);

    self.actions.moveFocus('right');

    assert.equal(activated, dp);
  });
});

test('resolveWindowByScan: a fixed secondary window is a hover target', () => {
  withFixedMonitors((ws1, ws2) => {
    const { self, dp } = fixedSelf(ws1, ws2);
    ws1.list_windows = () => [dp];
    ws2.list_windows = () => [];

    assert.equal(self.pointerFocus.resolveWindowByScan(2100, 50), dp);
  });
});
