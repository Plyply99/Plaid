import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';
import {
  groupKey,
  parseGroupKey,
  isFallbackConnector,
  persistableConnector,
  encodeMonitorEntry,
  decodeMonitorEntry,
  Monitors,
} from '../../extensions/modules/monitors.js';

test('groupKey: the primary monitor uses the bare workspace index', () => {
  assert.equal(groupKey(1, ''), '1');
  assert.equal(groupKey(3, null), '3');
  assert.equal(groupKey('2'), '2');
});

test('groupKey: other monitors append the connector', () => {
  assert.equal(groupKey(1, 'DP-1'), '1@DP-1');
  assert.equal(groupKey(0, 'HDMI-2'), '0@HDMI-2');
});

test('groupKey: rejects a non-numeric index', () => {
  assert.equal(groupKey('x', 'DP-1'), '');
});

test('parseGroupKey: round-trips both group shapes', () => {
  assert.deepEqual(parseGroupKey('1'), { index: 1, connector: '' });
  assert.deepEqual(parseGroupKey('1@DP-1'), { index: 1, connector: 'DP-1' });
  assert.deepEqual(parseGroupKey('12@eDP-1'), { index: 12, connector: 'eDP-1' });
});

test('parseGroupKey: rejects malformed keys', () => {
  for (const key of ['', 'x', '1@', '01', '-1', '1.5', null, undefined])
    assert.equal(parseGroupKey(key), null, `accepted ${String(key)}`);
});

test('isFallbackConnector: only "#N" stand-ins are transient', () => {
  assert.equal(isFallbackConnector('#0'), true);
  assert.equal(isFallbackConnector('#12'), true);
  assert.equal(isFallbackConnector('DP-1'), false);
  assert.equal(isFallbackConnector(''), false);
});

test('persistableConnector: refuses stand-ins and separator collisions', () => {
  assert.equal(persistableConnector('DP-1'), 'DP-1');
  assert.equal(persistableConnector(' HDMI-2 '), 'HDMI-2');
  assert.equal(persistableConnector('#0'), '');
  assert.equal(persistableConnector('DP:1'), '');
  assert.equal(persistableConnector(''), '');
  assert.equal(persistableConnector(null), '');
});

test('encode/decode: round-trips entries whose value contains colons', () => {
  const dwindle = encodeMonitorEntry('DP-1', '3:h0.8480(l,l)');
  assert.equal(dwindle, 'DP-1:3:h0.8480(l,l)');
  assert.deepEqual(decodeMonitorEntry(dwindle), { connector: 'DP-1', value: '3:h0.8480(l,l)' });

  const stack = encodeMonitorEntry('HDMI-1', '1:0:1.0,1:0.8');
  assert.equal(stack, 'HDMI-1:1:0:1.0,1:0.8');
  assert.deepEqual(decodeMonitorEntry(stack), { connector: 'HDMI-1', value: '1:0:1.0,1:0.8' });
});

test('encode: never writes a fallback connector or an empty value', () => {
  assert.equal(encodeMonitorEntry('#0', '1:dwindle'), '');
  assert.equal(encodeMonitorEntry('DP-1', ''), '');
});

test('decode: rejects malformed entries', () => {
  for (const entry of ['', 'no-colon', ':value', 'DP-1:', '#0:1:dwindle', null])
    assert.equal(decodeMonitorEntry(entry), null, `accepted ${String(entry)}`);
});

function withMonitors(primary, fn) {
  const list = ['eDP-1', 'DP-1', 'HDMI-1'].map(c => ({
    connector: c,
    get_connector() { return this.connector; },
  }));
  const mgr = {
    get_logical_monitors: () => list.map((m, i) => ({
      get_number: () => i,
      get_monitors: () => [m],
    })),
  };
  const oldBackend = globalThis.global.backend;
  const oldPrimary = globalThis.global.display.get_primary_monitor;
  const oldCount = globalThis.global.display.get_n_monitors;
  globalThis.global.backend = { get_monitor_manager: () => mgr };
  globalThis.global.display.get_primary_monitor = () => primary;
  globalThis.global.display.get_n_monitors = () => list.length;
  try {
    fn(list);
  } finally {
    globalThis.global.backend = oldBackend;
    globalThis.global.display.get_primary_monitor = oldPrimary;
    globalThis.global.display.get_n_monitors = oldCount;
  }
}

test('Monitors: maps monitors to connectors and back', () => {
  withMonitors(0, () => {
    const m = new Monitors({ _monitorConnCache: null });
    assert.equal(m.connectorForMonitor(0), 'eDP-1');
    assert.equal(m.connectorForMonitor(1), 'DP-1');
    assert.equal(m.connectorForMonitor(-1), '');
    assert.equal(m.connectorForMonitor(9), '');
    assert.equal(m.primaryConnector(), 'eDP-1');
    assert.equal(m.monitorForConnector('DP-1'), 1);
    assert.equal(m.monitorForConnector('VGA-1'), -1);
    assert.equal(m.monitorForConnector('#0'), 0);
    assert.equal(m.monitorForConnector('#9'), -1);
  });
});

test('Monitors: the connector cache survives renames until invalidated', () => {
  withMonitors(0, (list) => {
    const m = new Monitors({ _monitorConnCache: null });
    assert.equal(m.connectorForMonitor(1), 'DP-1');
    list[1].connector = 'DP-9';
    assert.equal(m.connectorForMonitor(1), 'DP-1', 'cached until monitors change');
    m.invalidate();
    assert.equal(m.connectorForMonitor(1), 'DP-9');
  });
});

test('Monitors: the primary keeps the bare index, others append the connector', () => {
  withMonitors(0, () => {
    const m = new Monitors({ _monitorConnCache: null });
    assert.equal(m.groupKeyFor(2, 0), 2);
    assert.equal(m.groupKeyFor(2, 1), '2@DP-1');
    assert.equal(m.groupKeyFor(2, 2), '2@HDMI-1');
  });
});

test('Monitors: a keyed primary rekeys which monitor owns the bare index', () => {
  withMonitors(0, () => {
    const m = new Monitors({ _monitorConnCache: null, _keyedPrimary: 'DP-1' });
    assert.equal(m.groupKeyFor(2, 1), 2);
    assert.equal(m.groupKeyFor(2, 0), '2@eDP-1');
  });
});

test('Monitors: every display tiles, in either workspace mode', () => {
  withMonitors(0, () => {
    const all = new Monitors({ _monitorConnCache: null, _mutterSettings: { get_boolean: () => false } });
    assert.deepEqual(all.tiledMonitors(), [0, 1, 2]);
    const primaryOnly = new Monitors({ _monitorConnCache: null, _mutterSettings: { get_boolean: () => true } });
    assert.deepEqual(primaryOnly.tiledMonitors(), [0, 1, 2]);
  });
});

test('Monitors: non-primary displays use workspace-independent groups', () => {
  withMonitors(0, () => {
    const m = new Monitors({
      _monitorConnCache: null,
      _fixedGroupObjs: new Map(),
      _groupObjs: new Map(),
      _mutterSettings: { get_boolean: () => true },
      geometry: { wsIndex: () => 2 },
    });
    assert.equal(m.fixedModeFor(0), false, 'primary stays per workspace');
    assert.equal(m.fixedModeFor(1), true);
    assert.equal(m.groupKeyFor(2, 1), 'm@DP-1');
    const ws = {};
    const group = m.groupObj(ws, 1);
    assert.equal(group.fixed, true);
    assert.equal(group.key, 'm@DP-1');
    assert.equal(m.groupObj(ws, 1), group, 'one group per connector');

    m.core._mutterSettings = { get_boolean: () => false };
    assert.equal(m.fixedModeFor(1), false);
    assert.equal(m.groupKeyFor(2, 1), '2@DP-1');
  });
});

test('Monitors: a fixed group collects its monitor windows across workspaces', () => {
  withMonitors(0, () => {
    const ws1 = {};
    const ws2 = {};
    const a = fakeWin({ id: 1, monitor: 1 });
    const b = fakeWin({ id: 2, monitor: 1 });
    const c = fakeWin({ id: 3, monitor: 0 });
    const core = {
      _monitorConnCache: null,
      _windowMonitors: new Map(),
      _mutterSettings: { get_boolean: () => true },
      windows: {
        getWindowsForWorkspace: (w) => w === ws1 ? [a, c] : [b],
      },
    };
    const oldWm = globalThis.global.workspace_manager;
    globalThis.global.workspace_manager = {
      get_n_workspaces: () => 2,
      get_workspace_by_index: (i) => (i === 0 ? ws1 : ws2),
    };
    try {
      const m = new Monitors(core);
      m.setWindowMonitor(a, 1);
      m.setWindowMonitor(b, 1);
      m.setWindowMonitor(c, 0);
      assert.deepEqual(m.getWindowsForGroup(ws1, 1).map(w => w.get_id()), [1, 2]);
      assert.deepEqual(m.getWindowsForGroup(ws1, 0).map(w => w.get_id()), [3]);
    } finally {
      globalThis.global.workspace_manager = oldWm;
    }
  });
});

test('Monitors: window monitor defaults to the window and can be overridden', () => {
  withMonitors(0, () => {
    const m = new Monitors({ _monitorConnCache: null, _windowMonitors: new Map() });
    const win = { get_monitor: () => 1 };
    assert.equal(m.windowMonitor(win), 'DP-1');
    m.setWindowMonitor(win, 2);
    assert.equal(m.windowMonitor(win), 'HDMI-1');
    const noMonitor = { get_monitor: () => -1 };
    m.setWindowMonitor(noMonitor, -1);
    assert.equal(m.windowMonitor(noMonitor), 'eDP-1', 'invalid index falls back to primary');
  });
});

test('Monitors: groups filter the workspace windows by monitor', () => {
  withMonitors(0, () => {
    const a = { get_monitor: () => 0 };
    const b = { get_monitor: () => 1 };
    const core = {
      _monitorConnCache: null,
      _windowMonitors: new Map(),
      windows: { getWindowsForWorkspace: () => [a, b] },
    };
    const m = new Monitors(core);
    m.setWindowMonitor(a, 0);
    m.setWindowMonitor(b, 1);
    assert.deepEqual(m.getWindowsForGroup({}, 0), [a]);
    assert.deepEqual(m.getWindowsForGroup({}, 1), [b]);
    assert.deepEqual(m.getWindowsForGroup({}, 2), []);
  });
});

test('Monitors: group objects are cached per (workspace, connector)', () => {
  withMonitors(0, () => {
    const core = {
      _monitorConnCache: null,
      _groupObjs: new Map(),
      geometry: { wsIndex: () => 4 },
    };
    const m = new Monitors(core);
    const ws = {};
    const g1 = m.groupObj(ws, 1);
    assert.equal(g1.key, '4@DP-1');
    assert.equal(g1.connector, 'DP-1');
    assert.equal(m.groupObj(ws, 1), g1, 'same group object');
    assert.notEqual(m.groupObj(ws, 2), g1, 'different monitor, different group');
  });
});

test('Monitors: unresolved connectors keep the primary bare and secondaries distinct', () => {
  const oldBackend = globalThis.global.backend;
  const oldPrimary = globalThis.global.display.get_primary_monitor;
  globalThis.global.backend = undefined;
  globalThis.global.display.get_primary_monitor = () => 0;
  try {
    const m = new Monitors({
      _monitorConnCache: null,
      _groupObjs: new Map(),
      geometry: { wsIndex: () => 2 },
    });
    assert.equal(m.isKeyedPrimary(0), true);
    assert.equal(m.isKeyedPrimary(1), false);
    assert.equal(m.groupKeyFor(2, 0), 2);
    assert.equal(m.groupKeyFor(2, 1), '2@#1');
    const ws = {};
    assert.equal(m.groupObj(ws, 0), ws, 'primary group is the workspace object');
    assert.notEqual(m.groupObj(ws, 1), ws, 'secondary group is its own object');
  } finally {
    globalThis.global.backend = oldBackend;
    globalThis.global.display.get_primary_monitor = oldPrimary;
  }
});

test('Monitors: entering a monitor moves the window between group trees', () => {
  withMonitors(0, () => {
    const self = makeSelf({ 'inside-gap': 8 });
    self.geometry.wsIndex = () => 2;
    const ws = {
      get_work_area_for_monitor: (m) => ({ x: m * 1000, y: 0, width: 1000, height: 800 }),
    };
    const win = fakeWin({ id: 1, monitor: 1 });
    win.get_workspace = () => ws;
    self._windowWorkspaces.set(win, ws);
    self.windows.getWorkspaceLayout = () => 'dwindle';
    self.grab.safeMove = () => {};
    const oldPointer = globalThis.global.get_pointer;
    globalThis.global.get_pointer = () => [0, 0];
    let retiles = 0;
    self.layouts.retileWorkspace = () => retiles++;

    const primary = self.monitors.groupObj(ws, 0);
    const secondary = self.monitors.groupObj(ws, 1);
    self._bspTrees.set(primary, { type: 'leaf', window: win });
    self.monitors.setWindowMonitor(win, 0);

    self.monitors.onWindowEnteredMonitor(win, 1);

    assert.equal(self.monitors.windowMonitor(win), 'DP-1');
    assert.equal(self.bsp.bspCollectWindows(self._bspTrees.get(primary)).length, 0);
    assert.deepEqual(self.bsp.bspCollectWindows(self._bspTrees.get(secondary)), [win]);
    assert.equal(retiles, 1);
    globalThis.global.get_pointer = oldPointer;
  });
});

test('bsp: inserting a window prunes a closed window from the tree first', () => {
  withMonitors(0, () => {
    const self = makeSelf({ 'inside-gap': 8 });
    self.geometry.wsIndex = () => 2;
    const ws = { get_work_area_for_monitor: () => ({ x: 0, y: 0, width: 2000, height: 1000 }) };
    const ghost = fakeWin({ id: 1, monitor: 0 });
    const live = fakeWin({ id: 2, monitor: 0 });
    const incoming = fakeWin({ id: 3, monitor: 0 });
    self.windows.getWindowsForWorkspace = () => [live, incoming];
    self.windows.isFloating = () => false;
    self._bspTrees.set(ws, split('v', 0.5, leaf(ghost), leaf(live)));
    const oldPointer = globalThis.global.get_pointer;
    globalThis.global.get_pointer = () => [0, 0];
    try {
      self.bsp.bspInsertForWorkspace(ws, incoming, 0);
    } finally {
      globalThis.global.get_pointer = oldPointer;
    }
    const tree = self._bspTrees.get(ws);
    const ids = self.bsp.bspCollectWindows(tree).map(w => w.get_id()).sort((a, b) => a - b);
    assert.deepEqual(ids, [2, 3], 'ghost leaf is gone');
    assert.equal(tree.direction, 'h', 'a single full-screen leaf splits side by side');
  });
});

test('windows: closing a window clears its leaf from every group tree', () => {
  withMonitors(0, () => {
    const self = makeSelf({});
    self.geometry.wsIndex = () => 2;
    const ws = {};
    const win = fakeWin({ id: 1, monitor: 0 });
    const primary = self.monitors.groupObj(ws, 0);
    const secondary = self.monitors.groupObj(ws, 1);
    self._bspTrees.set(primary, split('h', 0.5, leaf(win), leaf(fakeWin({ id: 3 }))));
    self._bspTrees.set(secondary, split('h', 0.5, leaf(win), leaf(fakeWin({ id: 4, monitor: 1 }))));

    self.windows.forgetWindowTree(ws, win);

    assert.equal(self.bsp.bspCollectWindows(self._bspTrees.get(primary)).includes(win), false);
    assert.equal(self.bsp.bspCollectWindows(self._bspTrees.get(secondary)).includes(win), false);
  });
});

test('Monitors: rekeyMap swaps the bare index with the new primary connector', () => {
  const m = new Monitors({});
  const map = new Map([
    [2, 'dwindle'],
    ['2@eDP-1', 'stale-bare-copy'],
    ['2@DP-1', 'master-stack'],
    ['2@HDMI-1', 'floating'],
  ]);

  m.rekeyMap(map, 'eDP-1', 'DP-1');

  assert.equal(map.get(2), 'master-stack');
  assert.equal(map.get('2@eDP-1'), 'dwindle', 'live bare state wins over a stale copy');
  assert.equal(map.get('2@HDMI-1'), 'floating');
  assert.equal(map.has('2@DP-1'), false);
});

test('Monitors: a primary change moves trees and ratios to the new keying', () => {
  withMonitors(0, () => {
    const self = makeSelf({});
    self.geometry.wsIndex = () => 2;
    self._keyedPrimary = 'eDP-1';
    const ws = {};
    const bare = split('h', 0.5, leaf(fakeWin({ id: 1 })), leaf(fakeWin({ id: 2 })));
    const newPrimaryGroup = self.monitors.groupObjFor(ws, 'DP-1');
    const dpTree = split('v', 0.4, leaf(fakeWin({ id: 3 })), leaf(fakeWin({ id: 4 })));
    self._bspTrees.set(ws, bare);
    self._bspTrees.set(newPrimaryGroup, dpTree);
    self._workspaceLayouts.set(2, 'dwindle');
    self._workspaceLayouts.set('2@DP-1', 'master-stack');
    self.layouts.retileAll = () => {};
    self.persistence.scheduleSaveLayouts = () => {};

    self.monitors.syncKeyedPrimary('DP-1');

    assert.equal(self._keyedPrimary, 'DP-1');
    assert.equal(self._bspTrees.get(ws), dpTree);
    const oldGroup = self.monitors.groupObjFor(ws, 'eDP-1');
    assert.equal(self._bspTrees.get(oldGroup), bare);
    assert.equal(self._workspaceLayouts.get(2), 'master-stack');
    assert.equal(self._workspaceLayouts.get('2@eDP-1'), 'dwindle');
    assert.equal(self._workspaceLayouts.has('2@DP-1'), false);
  });
});

test('Monitors: monitor changes are coalesced before touching trees', () => {
  withMonitorList([
    { get_connector: () => 'HDMI-1' },
    { get_connector: () => 'DP-1' },
  ], 0, () => {
    const self = makeSelf({});
    self._keyedPrimary = 'HDMI-1';
    let scheduled = 0;
    self.monitors.scheduleMonitorsSettled = () => scheduled++;
    let regroups = 0;
    self.monitors.regroupWindow = () => regroups++;

    self.monitors.onMonitorsChanged();

    assert.equal(scheduled, 1, 'one settled pass is armed');
    assert.equal(regroups, 0, 'nothing is regrouped yet');
    assert.equal(self._monitorsSettling, true);
  });
});

test('Monitors: monitors-changed rekeys when the runtime primary changes', () => {
  withMonitors(1, () => {
    const self = makeSelf({});
    self._keyedPrimary = 'eDP-1';
    self.geometry.wsIndex = () => 2;
    let retiles = 0;
    self.layouts.retileAll = () => retiles++;
    self.persistence.scheduleSaveLayouts = () => {};

    self.monitors.processMonitorsChanged();

    assert.equal(self._keyedPrimary, 'DP-1');
    assert.equal(retiles, 1);
  });
});

test('Monitors: fallback connectors are renamed once resolved', () => {
  withMonitors(0, () => {
    const core = { _windowMonitors: new Map(), _monitorConnCache: null };
    const m = new Monitors(core);
    const win = {};
    core._windowMonitors.set(win, '#1');
    m.syncFallbackConnectors(m.connectors());
    assert.equal(core._windowMonitors.get(win), 'DP-1');
  });
});

test('Monitors: monitorAt finds the monitor under a point', () => {
  withMonitors(0, () => {
    const oldGeometry = globalThis.global.display.get_monitor_geometry;
    const areas = [
      { x: 0, y: 0, width: 1000, height: 800 },
      { x: 1000, y: 0, width: 1000, height: 800 },
      { x: 2000, y: 0, width: 1000, height: 800 },
    ];
    globalThis.global.display.get_monitor_geometry = (i) => areas[i];
    try {
      const m = new Monitors({ _monitorConnCache: null });
      assert.equal(m.monitorAt(50, 50), 0);
      assert.equal(m.monitorAt(1500, 100), 1);
      assert.equal(m.monitorAt(2500, 700), 2);
      assert.equal(m.monitorAt(-5, 50), -1);
      assert.equal(m.monitorAt(500, 900), -1);
    } finally {
      globalThis.global.display.get_monitor_geometry = oldGeometry;
    }
  });
});

test('layouts: keyboard master resize writes the focused monitor group', () => {
  withMonitors(0, () => {
    const self = makeSelf({});
    self.geometry.wsIndex = () => 2;
    const ws = { get_work_area_for_monitor: () => ({ x: 0, y: 0, width: 1000, height: 800 }) };
    const a = fakeWin({ id: 1, monitor: 1 });
    const b = fakeWin({ id: 2, monitor: 1 });
    self.windows.getWindowsForWorkspace = () => [a, b];
    self.windows.isFloating = () => false;
    self.monitors.setWindowMonitor(a, 1);
    self.monitors.setWindowMonitor(b, 1);

    self.layouts.resizeMasterStack(a, ws, 'width', 100, 1);

    assert.equal(self._masterRatios.has('2@DP-1'), true);
    assert.equal(self._masterRatios.has(2), false, 'the primary key is untouched');
  });
});

test('layouts: master and stack ratios are kept per monitor group', () => {
  withMonitors(0, () => {
    const self = makeSelf({});
    self.geometry.wsIndex = () => 2;
    const ws = {};
    assert.equal(self.layouts.getMasterRatio(ws, 0), 0.5);
    assert.equal(self.layouts.getMasterRatio(ws, 1), 0.5);
    self._masterRatios.set(2, 0.7);
    self._masterRatios.set('2@DP-1', 0.3);
    assert.equal(self.layouts.getMasterRatio(ws, 0), 0.7);
    assert.equal(self.layouts.getMasterRatio(ws, 1), 0.3);

    const primaryStack = self.layouts.getStackRatios(ws, 0);
    const secondaryStack = self.layouts.getStackRatios(ws, 1);
    primaryStack.set(0, 2);
    assert.equal(secondaryStack.has(0), false, 'one map per group');
  });
});

test('layouts: dwindle keeps one tree per monitor and uses that monitor area', () => {
  withMonitors(0, () => {
    const self = makeSelf({ 'inside-gap': 8 });
    self.geometry.wsIndex = () => 2;
    const areas = {
      0: { x: 0, y: 0, width: 1000, height: 800 },
      1: { x: 1000, y: 0, width: 1000, height: 800 },
    };
    const ws = { get_work_area_for_monitor: (m) => areas[m] };
    const a1 = fakeWin({ id: 1, monitor: 0 });
    const a2 = fakeWin({ id: 2, monitor: 0 });
    const b1 = fakeWin({ id: 3, monitor: 1 });
    const b2 = fakeWin({ id: 4, monitor: 1 });
    const moves = [];
    self.windows.moveWindow = (win, x, y, w, h) => moves.push({ win, x, y, w, h });
    self.grab.safeMove = (win, x, y, w, h) => moves.push({ win, x, y, w, h });

    self.layouts.retileDwindle(ws, [a1, a2], 0);
    self.layouts.retileDwindle(ws, [b1, b2], 1);

    const primaryGroup = self.monitors.groupObj(ws, 0);
    const secondaryGroup = self.monitors.groupObj(ws, 1);
    assert.equal(primaryGroup, ws);
    assert.notEqual(secondaryGroup, ws);
    assert.deepEqual(self.bsp.bspCollectWindows(self._bspTrees.get(primaryGroup)), [a1, a2]);
    assert.deepEqual(self.bsp.bspCollectWindows(self._bspTrees.get(secondaryGroup)), [b1, b2]);
    for (const m of moves) {
      if (m.win === b1 || m.win === b2)
        assert.ok(m.x >= 1000, `secondary window placed at x=${m.x}`);
      else
        assert.ok(m.x < 1000, `primary window placed at x=${m.x}`);
    }
  });
});

function withMonitorList(list, primary, fn) {
  const mgr = {
    get_logical_monitors: () => list.map((m, i) => ({
      get_number: () => i,
      get_monitors: () => [m],
    })),
  };
  const old = {
    backend: globalThis.global.backend,
    primary: globalThis.global.display.get_primary_monitor,
    count: globalThis.global.display.get_n_monitors,
  };
  globalThis.global.backend = { get_monitor_manager: () => mgr };
  globalThis.global.display.get_primary_monitor = () => primary;
  globalThis.global.display.get_n_monitors = () => list.length;
  try {
    fn(list);
  } finally {
    globalThis.global.backend = old.backend;
    globalThis.global.display.get_primary_monitor = old.primary;
    globalThis.global.display.get_n_monitors = old.count;
  }
}

test('Monitors: a partial connector map keeps the primary bare and defers regroup', () => {
  withMonitorList([
    { get_connector: () => 'HDMI-1' },
    { get_connector: () => '' },
  ], 0, () => {
    const self = makeSelf({});
    self._keyedPrimary = 'HDMI-1';
    assert.equal(self.monitors.isKeyedPrimary(0), true);
    assert.equal(self.monitors.groupKeyFor(2, 0), 2);
    assert.equal(self.monitors.connectors().length >= 2, false, 'partial map');

    const win = fakeWin({ id: 1, monitor: 1 });
    self._windowMonitors.set(win, 'HDMI-1');
    let regroups = 0;
    self.monitors.regroupWindow = () => regroups++;
    let scheduled = 0;
    self.monitors.scheduleMonitorsSettled = () => scheduled++;

    self.monitors.onMonitorsChanged();

    assert.equal(self._monitorConnPartial, true);
    assert.equal(regroups, 0, 'no regrouping while connectors are unresolved');
    assert.equal(scheduled, 1, 'a settled pass is scheduled');
  });
});

test('Monitors: the settled pass regroups windows and retiles', () => {
  withMonitorList([
    { get_connector: () => 'HDMI-1' },
    { get_connector: () => 'DP-1' },
  ], 0, () => {
    const self = makeSelf({});
    self._keyedPrimary = 'HDMI-1';
    const win = fakeWin({ id: 1, monitor: 1, actor: {} });
    win.get_workspace = () => ({});
    self._windowMonitors.set(win, 'HDMI-1');
    self._windowWorkspaces.set(win, win.get_workspace());
    let regroups = 0;
    self.monitors.regroupWindow = () => regroups++;
    let retiles = 0;
    self.layouts.retileAll = () => retiles++;

    self.monitors.processMonitorsChanged();

    assert.equal(self._monitorConnPartial, false);
    assert.equal(regroups, 1);
    assert.equal(retiles, 1);
  });
});
