import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';

function landing(overrides = {}) {
  const self = makeSelf({});
  const frame = { x: 0, y: 0, width: 800, height: 800, ...overrides };
  const win = fakeWin({ id: 1, frame });
  win.get_workspace = () => null;
  win.get_compositor_private = () => ({});
  win.get_id = () => 1;
  win._plaidSettleUntil = 0;
  const target = { targetX: 0, targetY: 0, targetW: 1000, targetH: 1000 };
  self._mismatchFrames.set(win, { x: frame.x, y: frame.y, w: frame.width, h: frame.height });
  return { self, win, s: { win, ...target } };
}

test('landing: a stable smaller frame inside its slot is accepted, not floated', () => {
  const { self, win, s } = landing();
  let retried = 0;
  self.placement.retryLanding = () => retried++;
  self.signals.addTimeout = () => { retried++; return 1; };

  assert.equal(self.placement.verifyAnimationLanding(s, 'tiled'), true);
  assert.equal(retried, 0);
  assert.equal(self._landingGivenUp.has(win), false);
  assert.equal(self._landingRetries.has(win), false);
});

test('landing: a stable frame outside its slot still retries', () => {
  const { self, win, s } = landing({ x: 900 });
  let retried = 0;
  self.placement.retryLanding = () => retried++;

  assert.equal(self.placement.verifyAnimationLanding(s, 'tiled'), false);
  assert.equal(retried, 1);
});

test('landing: a stable larger frame is accepted, records the minimum, and retiles once', () => {
  const { self, win, s } = landing({ width: 1200 });
  let retried = 0;
  let scheduled = null;
  self.placement.retryLanding = () => retried++;
  self.placement.recordObservedMin = () => {};
  self.placement.adjustPinnedTree = () => {};
  win.get_workspace = () => ({});
  self.signals.addTimeout = (delay, cb) => {
    scheduled = { delay, cb };
    return 1;
  };

  assert.equal(self.placement.verifyAnimationLanding(s, 'tiled'), true);
  assert.equal(retried, 0);
  assert.equal(self._landingGivenUp.has(win), false);
  assert.equal(scheduled.delay, 100);
});

test('recordObservedMin: an explicit min-size override is never learned', () => {
  const self = makeSelf({}, {
    _minSizeOverrides: new Map([['org.gnome.texteditor', { w: 300, h: 300 }]]),
    _observedMinSizes: new Map(),
  });
  const win = fakeWin({ instance: 'org.gnome.TextEditor', minSize: [1175, 936] });
  win.get_workspace = () => null;

  self.placement.recordObservedMin(win, { width: 1175, height: 936 }, { w: 800, h: 800 });

  assert.equal(self._observedMinSizes.has(win), false);
});

test('landing: a stable larger frame during settle sets a temporary floor instead of retrying', () => {
  const { self, win, s } = landing({ width: 1200 });
  win._plaidSettleUntil = Date.now() + 5000;
  let retried = 0;
  self.placement.retryLanding = () => retried++;

  assert.equal(self.placement.verifyAnimationLanding(s, 'tiled'), true);
  assert.deepEqual(win._plaidSettleMin, { w: 1200, h: 0 });
  assert.equal(retried, 0, 'settle must never retry or float');
  assert.equal(self._landingGivenUp.has(win), false);
  assert.equal(self._observedMinSizes.has(win), false, 'settle floors are not learned');
});

test('finalizeSettleMin: promotes the floor when the client is still large', () => {
  const self = makeSelf({});
  const win = fakeWin({ id: 5, frame: { x: 0, y: 0, width: 1200, height: 800 } });
  win.get_compositor_private = () => ({});
  win.get_workspace = () => ({ get_work_area_for_monitor: () => ({ width: 2560, height: 1440 }) });
  win._plaidSettleMin = { w: 1200, h: 0 };
  let retiles = 0;
  self.layouts.retileWorkspace = () => retiles++;
  self.windows.isFloating = () => false;

  assert.equal(self.placement.finalizeSettleMin(win), true);
  assert.deepEqual(self._observedMinSizes.get(win), { w: 1200, h: 0 });
  assert.equal(win._plaidSettleMin, null);
  assert.equal(retiles, 1);
  assert.equal(self.placement.finalizeSettleMin(win), false, 'idempotent');
});

test('finalizeSettleMin: a client with its own minimum hint is not learned', () => {
  const self = makeSelf({});
  const win = fakeWin({ id: 11, frame: { x: 0, y: 0, width: 360, height: 800 }, minSize: [360, 0] });
  win.get_compositor_private = () => ({});
  win.get_workspace = () => ({ get_work_area_for_monitor: () => ({ width: 2560, height: 1440 }) });
  win._plaidSettleMin = { w: 360, h: 0 };
  self.layouts.retileWorkspace = () => {};
  self.windows.isFloating = () => false;

  assert.equal(self.placement.finalizeSettleMin(win), true);
  assert.equal(self._observedMinSizes.has(win), false,
    'an authoritative hint must not be shadowed by a learned frame');
});

test('finalizeSettleMin: a GNOME 50 [ok, w, h] hint still blocks learning', () => {
  const self = makeSelf({});
  const win = fakeWin({ id: 12, frame: { x: 0, y: 0, width: 360, height: 800 }, minHint: [true, 360, 0] });
  win.get_compositor_private = () => ({});
  win.get_workspace = () => ({ get_work_area_for_monitor: () => ({ width: 2560, height: 1440 }) });
  win._plaidSettleMin = { w: 360, h: 0 };
  self.layouts.retileWorkspace = () => {};
  self.windows.isFloating = () => false;

  assert.equal(self.placement.finalizeSettleMin(win), true);
  assert.equal(self._observedMinSizes.has(win), false);
});

test('finalizeSettleMin: drops the floor when the client shrank back', () => {
  const self = makeSelf({});
  const win = fakeWin({ id: 6, frame: { x: 0, y: 0, width: 400, height: 800 } });
  win.get_compositor_private = () => ({});
  win.get_workspace = () => ({ get_work_area_for_monitor: () => ({ width: 2560, height: 1440 }) });
  win._plaidSettleMin = { w: 1200, h: 0 };
  let retiles = 0;
  self.layouts.retileWorkspace = () => retiles++;
  self.windows.isFloating = () => false;

  assert.equal(self.placement.finalizeSettleMin(win), true);
  assert.equal(self._observedMinSizes.has(win), false);
  assert.equal(win._plaidSettleMin, null);
  assert.equal(retiles, 1);
});

test('noteSettleFrame: two identical off-slot ticks install a settle floor', () => {
  const self = makeSelf({ 'inside-gap': 8 });
  const win = fakeWin({ id: 7, frame: { x: 0, y: 0, width: 360, height: 800 } });
  win.get_compositor_private = () => ({});
  win.get_workspace = () => ({ get_work_area_for_monitor: () => ({ width: 2560, height: 1440 }) });
  win._plaidSettleUntil = Date.now() + 5000;
  self.windows.getWorkspaceLayout = () => 'dwindle';
  self.grab.windowSlotRect = () => ({ x: 0, y: 0, w: 286, h: 800 });
  self.layouts.retileWorkspace = () => {};

  assert.equal(self.placement.noteSettleFrame(win), false, 'first tick only samples');
  assert.equal(win._plaidSettleMin, undefined);
  assert.equal(self.placement.noteSettleFrame(win), true, 'unchanged frame is a refusal');
  assert.deepEqual(win._plaidSettleMin, { w: 360, h: 0 });
  assert.equal(self._observedMinSizes.has(win), false, 'settle floors are not learned');
});

test('noteSettleFrame: a moving frame is left to the settle-end retile', () => {
  const self = makeSelf({ 'inside-gap': 8 });
  const win = fakeWin({ id: 8, frame: { x: 0, y: 0, width: 360, height: 800 } });
  win.get_compositor_private = () => ({});
  win.get_workspace = () => ({ get_work_area_for_monitor: () => ({ width: 2560, height: 1440 }) });
  win._plaidSettleUntil = Date.now() + 5000;
  self.windows.getWorkspaceLayout = () => 'dwindle';
  self.grab.windowSlotRect = () => ({ x: 0, y: 0, w: 286, h: 800 });
  self.layouts.retileWorkspace = () => {};

  self.placement.noteSettleFrame(win);
  win.get_frame_rect = () => ({ x: 0, y: 0, width: 500, height: 800 });
  assert.equal(self.placement.noteSettleFrame(win), false);
  assert.equal(win._plaidSettleMin, undefined);
});

test('finalizeSettleMin: restores the pre-bend split when the client shrank', () => {
  const self = makeSelf({});
  const ws = { get_work_area_for_monitor: () => ({ width: 2560, height: 1440 }) };
  const win = fakeWin({ id: 9, frame: { x: 0, y: 0, width: 400, height: 800 } });
  win.get_compositor_private = () => ({});
  win.get_workspace = () => ws;
  win._plaidSettleMin = { w: 1200, h: 0 };
  win._plaidSettleSnap = {
    layout: 'dwindle',
    dwindle: split('h', 0.5, leaf(null), leaf(null)),
  };
  const live = split('h', 0.75, leaf(win), leaf(fakeWin({ id: 10 })));
  self._bspTrees.set(ws, live);
  self.windows.getWorkspaceLayout = () => 'dwindle';
  let retiles = 0;
  self.layouts.retileWorkspace = () => retiles++;
  self.windows.isFloating = () => false;

  assert.equal(self.placement.finalizeSettleMin(win), true);
  assert.equal(live.ratio, 0.5);
  assert.equal(self._observedMinSizes.has(win), false);
  assert.equal(retiles, 1);
});

test('retryLanding: a settling window is deferred, not retried or floated', () => {
  const self = makeSelf({});
  const win = fakeWin({ id: 3 });
  win.get_compositor_private = () => ({});
  win.get_workspace = () => ({});
  win._plaidSettleUntil = Date.now() + 5000;
  let scheduled = null;
  self.signals.addTimeout = (delay, cb) => {
    scheduled = { delay, cb };
    return 1;
  };

  self.placement.retryLanding(win);
  assert.equal(self._landingRetries.has(win), false);
  assert.equal(self._landingGivenUp.has(win), false);
  assert.ok(scheduled && scheduled.delay >= 5000);

  const first = scheduled;
  self.placement.retryLanding(win);
  assert.equal(scheduled, first, 'only one deferred retile per settle window');
});

test('releaseMinLimitedWindows: also releases give-up landings', () => {
  const self = makeSelf({});
  const win = fakeWin({ id: 2 });
  self._landingGivenUp.add(win);
  self._landingRetries.set(win, 3);
  self._mismatchFrames.set(win, { x: 0, y: 0, w: 1, h: 1 });

  self.placement.releaseMinLimitedWindows();

  assert.equal(self._landingGivenUp.has(win), false);
  assert.equal(self._landingRetries.has(win), false);
  assert.equal(self._mismatchFrames.has(win), false);
});
