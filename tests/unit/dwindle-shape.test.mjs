import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, leaf, empty, split } from '../helpers.mjs';

const shapeToString = (self, node) => self._dwindleShapeToString(node);
const shapeFromString = (self, str) => self._dwindleShapeFromString(str);

test('shape: leaf/empty encode to l/e', () => {
  const self = makeSelf();
  assert.equal(shapeToString(self, leaf(fakeWin())), 'l');
  assert.equal(shapeToString(self, empty()), 'e');
  assert.equal(shapeToString(self, null), 'e');
});

test('shape: split encodes direction + 4dp ratio + children', () => {
  const self = makeSelf();
  const tree = split('h', 0.848, leaf(null), leaf(null));
  assert.equal(shapeToString(self, tree), 'h0.8480(l,l)');
});

test('shape: round-trips structure and ratios', () => {
  const self = makeSelf();
  const tree = split('v', 0.3333, leaf(null), split('h', 0.75, leaf(null), leaf(null)));
  const str = shapeToString(self, tree);
  const back = shapeFromString(self, str);
  assert.equal(back.type, 'split');
  assert.equal(back.direction, 'v');
  assert.equal(back.ratio, 0.3333);
  assert.equal(back.second.type, 'split');
  assert.equal(back.second.direction, 'h');
  assert.equal(back.second.ratio, 0.75);
});

test('shape: ratios are clamped away from 1.0000/0.0000 (parser rejects those)', () => {
  const self = makeSelf();
  assert.equal(shapeToString(self, split('h', 0.99999, leaf(null), leaf(null))), 'h0.9999(l,l)');
  assert.equal(shapeToString(self, split('h', 0.00001, leaf(null), leaf(null))), 'h0.0001(l,l)');
  // and the clamped form parses
  assert.notEqual(shapeFromString(self, 'h0.9999(l,l)'), null);
});

test('shape: parser rejects malformed / out-of-range input', () => {
  const self = makeSelf();
  for (const bad of ['', 'z', 'h0.5(l)', 'h0.5(l,l)x', 'h1.0000(l,l)', 'h0.0000(l,l)', 'h0.5(l,l,l)']) {
    assert.equal(shapeFromString(self, bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('_parsePersistedDwindleShapes: keeps valid entries, drops bad/zero/negative indices', () => {
  const self = makeSelf({
    'workspace-dwindle-trees': ['3:h0.8480(l,l)', '0:l', '-1:l', 'bad', '5:h1.0000(l,l)', '2:v0.5(l,e)'],
  });
  const map = self._parsePersistedDwindleShapes();
  assert.deepEqual([...map.keys()].sort((a, b) => a - b), [2, 3]);
  assert.equal(map.get(3).direction, 'h');
  assert.equal(map.get(3).ratio, 0.848);
  assert.equal(self._persistedDwindleRaw.get(3), 'h0.8480(l,l)');
  assert.equal(self._persistedDwindleRaw.has(5), false);
});

test('_reconcileTreeRatios: copies matching-direction ratios into the live tree', () => {
  const self = makeSelf();
  const saved = split('h', 0.8, leaf(null), leaf(null));
  const live = split('h', 0.5, leaf(null), leaf(null));
  assert.equal(self._reconcileTreeRatios(saved, live), true);
  assert.equal(live.ratio, 0.8);
});

test('_reconcileTreeRatios: idempotent (second pass reports no change)', () => {
  const self = makeSelf();
  const saved = split('h', 0.8, leaf(null), leaf(null));
  const live = split('h', 0.8, leaf(null), leaf(null));
  assert.equal(self._reconcileTreeRatios(saved, live), false);
});

test('_reconcileTreeRatios: direction mismatch stops descent', () => {
  const self = makeSelf();
  const saved = split('h', 0.8, leaf(null), leaf(null));
  const live = split('v', 0.5, leaf(null), leaf(null));
  assert.equal(self._reconcileTreeRatios(saved, live), false);
  assert.equal(live.ratio, 0.5);
});

test('_reconcileTreeRatios: ignores ratios outside the sane 0.02..0.98 band', () => {
  const self = makeSelf();
  const saved = split('h', 0.99, leaf(null), leaf(null));
  const live = split('h', 0.5, leaf(null), leaf(null));
  assert.equal(self._reconcileTreeRatios(saved, live), false);
  assert.equal(live.ratio, 0.5);
});
