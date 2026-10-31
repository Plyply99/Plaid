import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin } from '../helpers.mjs';
import { sessionState } from '../../extensions/modules/session-state.js';

function withGlobal(value, fn) {
  const old = globalThis.global;
  globalThis.global = value;
  try {
    return fn();
  } finally {
    globalThis.global = old;
  }
}

test('getWindowsForWorkspace: live workspace wins over a stale stored index', () => {
  const ws = { name: 'real' };
  const win = fakeWin({ actor: {} });
  win.get_workspace = () => ws;

  const core = makeSelf({});
  core.windows.getWorkspaceOrder = () => [win];
  core.geometry.wsIndex = () => 0;
  // The stashed index is from before the BGAPP parking ws0 was removed.
  core._windowWSIndices.set(win, 3);

  assert.deepEqual(core.windows.getWindowsForWorkspace(ws), [win]);
});

test('restoreTilingState: re-derives workspace indices from the live workspace', () => {
  const ws = { name: 'real' };
  const win = fakeWin({ actor: {} });
  win.get_workspace = () => ws;

  const core = makeSelf({});
  core.geometry.wsIndex = (w) => (w === ws ? 0 : -1);
  sessionState.stashedTiling = {
    bspTrees: new Map(),
    workspaceLayouts: new Map(),
    masterRatios: new Map(),
    stackRatios: new Map(),
    workspaceOrders: new Map([[ws, [win]]]),
    windowWorkspaces: new Map([[win, ws]]),
    windowWSIndices: new Map([[win, 3]]),
    lastFocusedPerWorkspace: new Map(),
    lastRealFocusedWindow: null,
    scratchpadWindows: new Map(),
    toggleFloatWindows: new Set(),
    scratchpadVisible: false,
    observedMinSizes: new Map(),
  };

  withGlobal({
    workspace_manager: {
      get_n_workspaces: () => 1,
      get_workspace_by_index: () => ws,
    },
  }, () => core.restoreTilingState());

  assert.equal(core._windowWSIndices.get(win), 0);
  assert.equal(core._windowWorkspaces.get(win), ws);
  assert.deepEqual(core._workspaceOrders.get(ws), [win]);

  sessionState.stashedTiling = null;
});

test('adoptExistingDropdown: recognizes a surviving terminal by process marker', () => {
  sessionState.ddtPid = 0;
  const win = fakeWin({ minimized: false });
  // Simulate the JS wrapper being collected while Plaid was disabled: the
  // durable PLAID_DDT process marker is all that remains.
  delete win._plaidDdt;
  const ws = { list_windows: () => [win] };
  const wm = { get_n_workspaces: () => 1, get_workspace_by_index: () => ws };
  const core = makeSelf({ 'dropdown-terminal-command': 'ghostty' });
  core.bgApp.isMarkerProcess = () => true;

  withGlobal({ workspace_manager: wm, get_current_time: () => 0 }, () => {
    core.dropdown.adoptExistingDropdown();
  });

  assert.equal(core._dropdownWin, win);
  assert.equal(win._plaidDdt, true);
  assert.equal(win.minimized, true);
});

test('clearDropdownWindow: hides the actor even when already minimized', () => {
  const actor = { visible: true, set_opacity() {}, remove_all_transitions() {} };
  const win = fakeWin({ minimized: true, actor });
  const core = makeSelf({});
  core._dropdownWin = win;

  core.dropdown.clearDropdownWindow(false);

  assert.equal(win.minimized, true);
  assert.equal(actor.visible, false);
  assert.equal(core._dropdownWin, null);
});

test('clearDropdownWindow: minimizes the surviving terminal on disable', () => {
  const win = fakeWin({ minimized: false });
  win.get_compositor_private = () => null;
  const core = makeSelf({});
  core._dropdownWin = win;

  core.dropdown.clearDropdownWindow(false);

  assert.equal(win.minimized, true);
  assert.equal(core._dropdownWin, null);
  assert.notEqual(win._plaidDdt, false);
});

test('adoptExistingDropdown: adopts by stored pid when the wrapper marker is gone', () => {
  sessionState.ddtPid = 4242;
  const win = fakeWin({ pid: 4242, minimized: false });
  delete win._plaidDdt;
  const ws = { list_windows: () => [win] };
  const wm = { get_n_workspaces: () => 1, get_workspace_by_index: () => ws };
  const core = makeSelf({ 'dropdown-terminal-command': 'ghostty' });
  core.bgApp.isMarkerProcess = () => false;

  withGlobal({ workspace_manager: wm, get_current_time: () => 0 }, () => {
    core.dropdown.adoptExistingDropdown();
  });

  assert.equal(core._dropdownWin, win);
  assert.equal(win.minimized, true);
  sessionState.ddtPid = 0;
});

test('recheckDropdownWaiters: retries adoption when no spawn is pending', () => {
  sessionState.ddtPid = 4242;
  const win = fakeWin({ pid: 4242, minimized: false });
  const ws = { list_windows: () => [win] };
  const wm = { get_n_workspaces: () => 1, get_workspace_by_index: () => ws };
  const core = makeSelf({ 'dropdown-terminal-command': 'ghostty' });
  core.bgApp.isMarkerProcess = () => false;
  core._dropdownPending = false;

  withGlobal({ workspace_manager: wm, get_current_time: () => 0 }, () => {
    core.dropdown.recheckDropdownWaiters();
  });

  assert.equal(core._dropdownWin, win);
  sessionState.ddtPid = 0;
});

test('adoptExistingDropdown: re-arms the unmanaged cleanup', () => {
  sessionState.ddtPid = 0;
  const win = fakeWin({ pid: 4242, minimized: false });
  win._plaidDdt = true;
  win._plaidDdtCommand = 'ghostty';
  const ws = { list_windows: () => [win] };
  const wm = { get_n_workspaces: () => 1, get_workspace_by_index: () => ws };
  const core = makeSelf({ 'dropdown-terminal-command': 'ghostty' });

  withGlobal({ workspace_manager: wm, get_current_time: () => 0 }, () => {
    core.dropdown.adoptExistingDropdown();
  });

  assert.equal(core._dropdownWin, win);
  assert.equal(sessionState.ddtPid, 4242);
  assert.equal(typeof win._signals.unmanaged, 'function');

  win._signals.unmanaged();
  assert.equal(core._dropdownWin, null);
  assert.equal(sessionState.ddtPid, 0);
});

test('toggleDropdownTerminal: discards a stale tracked window and relaunches', () => {
  sessionState.ddtPid = 4242;
  const win = fakeWin({ minimized: false });
  win.get_compositor_private = () => null;
  const core = makeSelf({ 'dropdown-terminal-command': 'ghostty' });
  core._dropdownWin = win;
  let launched = false;
  core.dropdown.launchDropdownTerminal = () => {
    launched = true;
  };

  core.dropdown.toggleDropdownTerminal();

  assert.equal(core._dropdownWin, null);
  assert.equal(sessionState.ddtPid, 0);
  assert.equal(launched, true);
});
