import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin } from '../helpers.mjs';
import { sessionState } from '../../extensions/modules/session-state.js';

function resetSessionState() {
  sessionState.parkingWorkspace = null;
  sessionState.parkingFront = false;
  sessionState.bgAppWindow = null;
  sessionState.parkingHiding = null;
  sessionState.ddtPid = 0;
}

function withGlobal(value, fn) {
  const old = globalThis.global;
  globalThis.global = value;
  try {
    return fn();
  } finally {
    globalThis.global = old;
  }
}

test('workspaceHasUserWindows: sticky DDT and the BGAPP are not parking content', () => {
  resetSessionState();
  const ddt = fakeWin({ sticky: true });
  const bg = fakeWin();
  const user = fakeWin();
  const ws = { list_windows: () => [] };

  const core = makeSelf({}, { _backgroundAppWin: bg });
  core.bgApp.isBgAppProcessWindow = (w) => w === bg;
  core.bgApp.matchesBackgroundApp = () => false;

  ws.list_windows = () => [ddt, bg];
  assert.equal(core.bgApp.workspaceHasUserWindows(ws), false);

  ws.list_windows = () => [ddt, bg, user];
  assert.equal(core.bgApp.workspaceHasUserWindows(ws), true);
});

test('workspaceHasUserWindows: a sticky-only workspace is clear', () => {
  resetSessionState();
  const ddt = fakeWin({ sticky: true });
  const ws = { list_windows: () => [ddt] };
  const core = makeSelf({});
  assert.equal(core.bgApp.workspaceHasUserWindows(ws), false);
});

test('reassertBackgroundAppParking: never appends when the parking is live', () => {
  resetSessionState();
  const parking = {};
  // Parking sits at the LAST index — the old code treated this as invalid
  // and appended a replacement, racing the shell's dynamic workspace check.
  const spaces = [{}, parking];
  let appended = 0;
  const wm = {
    get_n_workspaces: () => spaces.length,
    get_workspace_by_index: (i) => spaces[i],
    append_new_workspace: () => {
      appended++;
      return {};
    },
  };

  const bgWin = fakeWin();
  const core = makeSelf({}, {
    _backgroundAppWin: bgWin,
    _backgroundAppParkingWs: parking,
    _backgroundAppParkingFront: false,
  });
  const parked = [];
  core.bgApp.parkBackgroundAppOnWorkspace = (win) => parked.push(win);

  withGlobal({ workspace_manager: wm }, () => core.bgApp.reassertBackgroundAppParking());

  assert.equal(appended, 0);
  assert.deepEqual(parked, [bgWin]);
  assert.equal(sessionState.parkingWorkspace, parking);
});

test('adoptExistingParking: prefers the session parking and validates identity', () => {
  resetSessionState();
  const front = { list_windows: () => [] };
  const trailing = { list_windows: () => [] };
  const wm = {
    get_n_workspaces: () => 2,
    get_workspace_by_index: (i) => (i === 0 ? front : trailing),
  };
  const core = makeSelf({});

  withGlobal({ workspace_manager: wm }, () => {
    sessionState.parkingWorkspace = trailing;
    assert.equal(core.bgApp.adoptExistingParking(), trailing);

    // A dead workspace object is not adopted; fall back to the BGAPP window.
    const win = fakeWin();
    win.get_workspace = () => trailing;
    core._backgroundAppWin = win;
    sessionState.parkingWorkspace = {};
    assert.equal(core.bgApp.adoptExistingParking(), trailing);
  });
});

test('applyBackgroundAppHiding: reuses the session wraps instead of stacking', () => {
  resetSessionState();
  const token = { wrappedGetNeighbor: () => {} };
  sessionState.parkingHiding = token;
  const core = makeSelf({});

  core.bgApp.applyBackgroundAppHiding();

  assert.equal(core._backgroundAppHiding, token);
  assert.equal(sessionState.parkingHiding, token);

  resetSessionState();
});

test('placeParkingAtFront: reorders an empty trailing parking to index 0', () => {
  resetSessionState();
  const front = { list_windows: () => [] };
  const middle = { list_windows: () => [] };
  const parking = { list_windows: () => [] };
  const spaces = [front, middle, parking];
  let reorder = null;
  const wm = {
    get_n_workspaces: () => spaces.length,
    get_workspace_by_index: (i) => spaces[i],
    reorder_workspace: (ws, index) => {
      reorder = [ws, index];
    },
  };
  const core = makeSelf({});

  const ok = withGlobal({ workspace_manager: wm }, () =>
    core.bgApp.placeParkingAtFront(parking));

  assert.equal(ok, true);
  assert.deepEqual(reorder, [parking, 0]);
});

test('placeParkingAtFront: refuses to reorder a workspace with user windows', () => {
  resetSessionState();
  const user = fakeWin();
  const parking = { list_windows: () => [user] };
  const spaces = [{ list_windows: () => [] }, parking];
  let reordered = false;
  const wm = {
    get_n_workspaces: () => spaces.length,
    get_workspace_by_index: (i) => spaces[i],
    reorder_workspace: () => {
      reordered = true;
    },
  };
  const core = makeSelf({});

  const ok = withGlobal({ workspace_manager: wm }, () =>
    core.bgApp.placeParkingAtFront(parking));

  assert.equal(ok, false);
  assert.equal(reordered, false);
});
