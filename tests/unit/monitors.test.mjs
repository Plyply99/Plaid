import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin } from '../helpers.mjs';
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
    assert.equal(m.monitorForConnector('#0'), -1);
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

test('Monitors: tiledMonitors honours workspaces-only-on-primary', () => {
  withMonitors(0, () => {
    const all = new Monitors({ _monitorConnCache: null, _mutterSettings: { get_boolean: () => false } });
    assert.deepEqual(all.tiledMonitors(), [0, 1, 2]);
    const primaryOnly = new Monitors({ _monitorConnCache: null, _mutterSettings: { get_boolean: () => true } });
    assert.deepEqual(primaryOnly.tiledMonitors(), [0]);
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
