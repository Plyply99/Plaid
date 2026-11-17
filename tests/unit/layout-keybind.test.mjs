import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin } from '../helpers.mjs';

function withFocused(monitor, fn) {
  const self = makeSelf({ layout: 'dwindle' });
  const ws = {};
  const win = fakeWin({ monitor });
  win.get_workspace = () => ws;
  const oldFocus = globalThis.global.display.focus_window;
  globalThis.global.display.focus_window = win;
  const calls = [];
  self.workspaces.showPopup = (title, subtitle) => calls.push({ title, subtitle });
  self.layouts.retileWorkspace = () => {};
  self.persistence.scheduleSaveLayouts = () => {};
  self.geometry.wsIndex = () => 1;
  try {
    fn(self, calls);
  } finally {
    globalThis.global.display.focus_window = oldFocus;
  }
}

test('cycleLayout: an untiled display explains instead of changing the layout', () => {
  withFocused(1, (self, calls) => {
    self.monitors.monitorTiled = () => false;
    self.actions.cycleLayout();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].title, 'Display not tiled');
    assert.equal(self._workspaceLayouts.size, 0);
  });
});

test('cycleLayout: the pointer monitor wins over a focused window elsewhere', () => {
  withFocused(1, (self) => {
    const display = globalThis.global.display;
    const oldCurrent = display.get_current_monitor;
    display.get_current_monitor = () => 0;
    const seen = [];
    self.monitors.monitorTiled = (m) => { seen.push(m); return true; };
    self.monitors.groupKeyFor = () => '1';
    try {
      self.actions.cycleLayout();
    } finally {
      display.get_current_monitor = oldCurrent;
    }
    assert.deepEqual(seen, [0]);
  });
});

test('cycleLayout: the pointer display is explained even with no focused window', () => {
  const self = makeSelf({ layout: 'dwindle' });
  const display = globalThis.global.display;
  const oldFocus = display.focus_window;
  const oldCurrent = display.get_current_monitor;
  const oldWm = globalThis.global.workspace_manager;
  display.focus_window = null;
  display.get_current_monitor = () => 1;
  globalThis.global.workspace_manager = { get_active_workspace: () => ({}) };
  const calls = [];
  self.workspaces.showPopup = (title) => calls.push(title);
  self.monitors.monitorTiled = () => false;
  self.geometry.wsIndex = () => 1;
  try {
    self.actions.cycleLayout();
  } finally {
    display.focus_window = oldFocus;
    display.get_current_monitor = oldCurrent;
    globalThis.global.workspace_manager = oldWm;
  }
  assert.equal(calls[0], 'Display not tiled');
  assert.equal(self._workspaceLayouts.size, 0);
});

test('cycleLayout: a tiled display cycles its monitor group', () => {
  withFocused(1, (self, calls) => {
    self.monitors.monitorTiled = () => true;
    self.monitors.groupKeyFor = () => '1@DP-1';
    self.actions.cycleLayout();
    assert.equal(self._workspaceLayouts.get('1@DP-1'), 'master-stack');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].title.startsWith('Layout:'));
  });
});
