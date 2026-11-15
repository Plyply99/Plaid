import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin } from '../helpers.mjs';

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

test('landing: a stable larger frame is still treated as a size refusal', () => {
  const { self, win, s } = landing({ width: 1200 });
  let retried = 0;
  self.placement.retryLanding = () => retried++;

  assert.equal(self.placement.verifyAnimationLanding(s, 'tiled'), false);
  assert.equal(retried, 1);
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
