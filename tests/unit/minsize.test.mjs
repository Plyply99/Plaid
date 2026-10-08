import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, leaf, split } from '../helpers.mjs';

const withMin = (min) => {
  const w = fakeWin();
  w._min = min;
  return w;
};

// A fake `this` whose min-size lookup reads a `_min` attached to each window.
function minSelf(settings = {}) {
  return makeSelf(settings, {
    _minSizeOverrides: new Map(),
    _getWindowMinSize: (w) => w._min ?? { w: 0, h: 0 },
  });
}

test('_treeMinSizes: h-split adds widths, takes max height', () => {
  const self = minSelf();
  const a = withMin({ w: 100, h: 50 });
  const b = withMin({ w: 200, h: 30 });
  const tree = split('h', 0.5, leaf(a), leaf(b));
  assert.deepEqual(self._treeMinSizes(tree), { w: 300, h: 50 });
});

test('_treeMinSizes: v-split adds heights, takes max width (regression: formulas were inverted)', () => {
  const self = minSelf();
  const a = withMin({ w: 100, h: 50 });
  const b = withMin({ w: 200, h: 30 });
  const tree = split('v', 0.5, leaf(a), leaf(b));
  assert.deepEqual(self._treeMinSizes(tree), { w: 200, h: 80 });
});

test('_treeMinSizes: tags each node with its computed minimum', () => {
  const self = minSelf();
  const a = withMin({ w: 100, h: 50 });
  const b = withMin({ w: 200, h: 30 });
  const tree = split('h', 0.5, leaf(a), leaf(b));
  self._treeMinSizes(tree);
  assert.equal(tree._minW, 300);
  assert.equal(tree.first._minW, 100);
  assert.equal(tree.second._minW, 200);
});

test('_clampTreeToMinSizes: clamps a ratio into [minRatio, maxRatio]', () => {
  const self = minSelf();
  const a = withMin({ w: 100, h: 50 });
  const b = withMin({ w: 200, h: 50 });
  const tree = split('h', 0.9, leaf(a), leaf(b));
  self._treeMinSizes(tree);
  self._clampTreeToMinSizes(tree, 400, 100, 0);
  assert.equal(tree.ratio, 0.5); // maxRatio = 1 - 200/400
});

test('_clampTreeToMinSizes: raises a too-small ratio to minRatio', () => {
  const self = minSelf();
  const a = withMin({ w: 100, h: 50 });
  const b = withMin({ w: 200, h: 50 });
  const tree = split('h', 0.1, leaf(a), leaf(b));
  self._treeMinSizes(tree);
  self._clampTreeToMinSizes(tree, 400, 100, 0);
  assert.equal(tree.ratio, 0.25); // minRatio = 100/400
});

test('_clampTreeToMinSizes: unsatisfiable mins fall back to the min-width split', () => {
  const self = minSelf();
  const a = withMin({ w: 300, h: 50 });
  const b = withMin({ w: 300, h: 50 });
  const tree = split('h', 0.9, leaf(a), leaf(b));
  self._treeMinSizes(tree);
  self._clampTreeToMinSizes(tree, 400, 100, 0);
  assert.equal(tree.ratio, 0.5); // 300 / (300+300)
});

function masterSelf(masterRatio) {
  return makeSelf({}, {
    _masterRatios: new Map(),
    _wsIndex: () => 0,
    _scheduleSaveLayouts: () => {},
    _getMasterRatio: () => masterRatio,
    _getWindowMinSize: (w) => w._min ?? { w: 0, h: 0 },
  });
}

const stack = (mins) => mins.map((m) => withMin({ w: m, h: 50 }));

test('_clampMasterStackRatios: unsatisfiable with zero master-min falls back to 0.5 (regression)', () => {
  const self = masterSelf(0.5);
  const wins = stack([0, 500]);
  self._clampMasterStackRatios({}, wins, 500, 0, false);
  assert.equal(self._masterRatios.get(0), 0.5);
});

test('_clampMasterStackRatios: unsatisfiable with a real master-min uses masterMin/need', () => {
  const self = masterSelf(0.5);
  const wins = stack([200, 500]);
  self._clampMasterStackRatios({}, wins, 500, 0, false);
  assert.ok(Math.abs(self._masterRatios.get(0) - 200 / 700) < 1e-9);
});

test('_clampMasterStackRatios: clamps a ratio inside the feasible band', () => {
  const self = masterSelf(0.2);
  const wins = stack([400, 100]);
  self._clampMasterStackRatios({}, wins, 1000, 0, false);
  assert.equal(self._masterRatios.get(0), 0.4); // lo = 400/1000
});

test('_clampMasterStackRatios: leaves a feasible ratio alone', () => {
  const self = masterSelf(0.5);
  const wins = stack([100, 100]);
  self._clampMasterStackRatios({}, wins, 1000, 0, false);
  assert.equal(self._masterRatios.get(0), 0.5);
});

test('_clampMasterStackRatios: single window is a no-op', () => {
  const self = masterSelf(0.5);
  self._clampMasterStackRatios({}, stack([100]), 1000, 0, false);
  assert.equal(self._masterRatios.size, 0);
});
