import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin } from '../helpers.mjs';

function fakeWorkspace(windows = []) {
  return {
    _wins: windows.slice(),
    activated: false,
    list_windows() { return this._wins.slice(); },
    activate() { this.activated = true; },
  };
}

function withGlobalWorkspaceManager(wm, fn) {
  const old = globalThis.global;
  globalThis.global = { workspace_manager: wm };
  try {
    return fn();
  } finally {
    globalThis.global = old;
  }
}

test('_evacuateParkingWorkspace: moves user windows off the parking and activates a real workspace', () => {
  const parking = fakeWorkspace();
  const real = fakeWorkspace();
  const user = fakeWin();
  let userWs = parking;
  user.get_workspace = () => userWs;
  user.change_workspace = (ws) => {
    userWs = ws;
    parking._wins = parking._wins.filter(w => w !== user);
    real._wins.push(user);
  };
  parking._wins.push(user);

  const wm = {
    get_n_workspaces: () => 2,
    get_workspace_by_index: (i) => (i === 0 ? parking : real),
    get_active_workspace: () => parking,
    append_new_workspace: () => real,
  };
  const self = makeSelf({}, {
    _backgroundAppParkingWs: parking,
    _backgroundAppWin: null,
    _matchesBackgroundApp: () => false,
    _currentTime: () => 0,
    _wsIndex: (ws) => (ws === parking ? 0 : 1),
    _scheduleWorkspacePillUpdate() {},
    _debugLog() {},
  });

  withGlobalWorkspaceManager(wm, () => self._evacuateParkingWorkspace());

  assert.equal(userWs, real);
  assert.equal(real.activated, true);
  assert.equal(parking._wins.length, 0);
});

test('_evacuateParkingWorkspace: no user windows + real active is a no-op', () => {
  const parking = fakeWorkspace();
  const real = fakeWorkspace();
  let activated = false;
  real.activate = () => { activated = true; };
  const wm = {
    get_n_workspaces: () => 2,
    get_workspace_by_index: (i) => (i === 0 ? parking : real),
    get_active_workspace: () => real,
    append_new_workspace: () => real,
  };
  const self = makeSelf({}, {
    _backgroundAppParkingWs: parking,
    _backgroundAppWin: null,
    _matchesBackgroundApp: () => false,
    _currentTime: () => 0,
    _wsIndex: () => 1,
    _scheduleWorkspacePillUpdate() {},
    _debugLog() {},
  });

  withGlobalWorkspaceManager(wm, () => self._evacuateParkingWorkspace());

  assert.equal(activated, false);
});
