import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf } from '../helpers.mjs';

test('workspaces: popups follow the focused window monitor, then pointer, then primary', () => {
  const self = makeSelf({});
  const display = globalThis.global.display;
  const old = {
    focus: display.focus_window,
    current: display.get_current_monitor,
    geometry: display.get_monitor_geometry,
  };
  const areas = [
    { x: 0, y: 0, width: 1000, height: 800 },
    { x: 1000, y: 0, width: 1200, height: 900 },
  ];
  display.get_monitor_geometry = (i) => areas[i];
  display.get_current_monitor = () => 1;
  try {
    display.focus_window = { get_monitor: () => 1 };
    assert.deepEqual(self.workspaces.popupMonitorGeometry(), areas[1]);

    display.focus_window = null;
    assert.deepEqual(self.workspaces.popupMonitorGeometry(), areas[1], 'pointer monitor');

    display.get_current_monitor = () => -1;
    assert.deepEqual(self.workspaces.popupMonitorGeometry(), areas[0], 'primary fallback');

    display.focus_window = { get_monitor: () => -1 };
    assert.deepEqual(self.workspaces.popupMonitorGeometry(), areas[0], 'invalid focus falls back');
  } finally {
    display.focus_window = old.focus;
    display.get_current_monitor = old.current;
    display.get_monitor_geometry = old.geometry;
  }
});

test('workspaces: an explicit popup monitor wins over focus', () => {
  const self = makeSelf({});
  const display = globalThis.global.display;
  const old = {
    focus: display.focus_window,
    current: display.get_current_monitor,
    geometry: display.get_monitor_geometry,
  };
  const areas = [
    { x: 0, y: 0, width: 1000, height: 800 },
    { x: 1000, y: 0, width: 1200, height: 900 },
  ];
  display.get_monitor_geometry = (i) => areas[i];
  display.focus_window = { get_monitor: () => 0 };
  display.get_current_monitor = () => 0;
  try {
    assert.deepEqual(self.workspaces.popupMonitorGeometry(1), areas[1]);
    assert.deepEqual(self.workspaces.popupMonitorGeometry(-1), areas[0], 'invalid falls back to focus');
  } finally {
    display.focus_window = old.focus;
    display.get_current_monitor = old.current;
    display.get_monitor_geometry = old.geometry;
  }
});
