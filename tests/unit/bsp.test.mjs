import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin, leaf, empty, split } from '../helpers.mjs';

const W = (id) => fakeWin({ id });

test('_bspInsert: empty/null tree becomes a single leaf', () => {
  const self = makeSelf({ 'dwindle-ratio': 0.5 });
  const a = W('a');
  assert.equal(self._bspInsert(null, a, 0, 0, 200, 100, 0).window, a);
  assert.equal(self._bspInsert(empty(), a, 0, 0, 200, 100, 0).window, a);
});

test('_bspInsert: into a leaf splits on the longer axis', () => {
  const self = makeSelf({ 'dwindle-ratio': 0.5 });
  const a = W('a'), b = W('b');
  const wide = self._bspInsert(leaf(a), b, 0, 0, 200, 100, 0);
  assert.equal(wide.type, 'split');
  assert.equal(wide.direction, 'h');
  const tall = self._bspInsert(leaf(a), b, 0, 0, 100, 200, 0);
  assert.equal(tall.direction, 'v');
});

test('_bspInsert: descends into the second child on a split', () => {
  const self = makeSelf({ 'dwindle-ratio': 0.5 });
  const a = W('a'), b = W('b'), c = W('c');
  const tree = split('h', 0.5, leaf(a), leaf(b));
  self._bspInsert(tree, c, 0, 0, 200, 100, 0);
  assert.deepEqual(self._bspCollectWindows(tree), [a, b, c]);
});

test('_bspRemove: collapses the removed leaf and re-parents the sibling', () => {
  const self = makeSelf({ 'dwindle-ratio': 0.5 });
  const a = W('a'), b = W('b');
  const tree = split('h', 0.5, leaf(a), leaf(b));
  const after = self._bspRemove(tree, a);
  assert.equal(after.type, 'leaf');
  assert.equal(after.window, b);
});

test('_bspRemove: removing the last window yields an empty node', () => {
  const self = makeSelf();
  const a = W('a');
  assert.equal(self._bspRemove(leaf(a), a).type, 'empty');
});

test('_bspRemove: unknown window leaves the tree intact', () => {
  const self = makeSelf();
  const a = W('a'), b = W('b'), z = W('z');
  const tree = split('h', 0.5, leaf(a), leaf(b));
  const after = self._bspRemove(tree, z);
  assert.deepEqual(self._bspCollectWindows(after), [a, b]);
});

test('_bspFindPath / _bspFindLeaf locate a window', () => {
  const self = makeSelf();
  const a = W('a'), b = W('b'), c = W('c');
  const tree = split('h', 0.5, leaf(a), split('v', 0.5, leaf(b), leaf(c)));
  assert.equal(self._bspFindLeaf(tree, c).window, c);
  const path = [];
  assert.equal(self._bspFindPath(tree, c, path), true);
  assert.equal(path.length, 2);
  assert.equal(self._bspFindLeaf(tree, W('nope')), null);
});

test('_bspSwapWindows swaps two leaves in place', () => {
  const self = makeSelf();
  const a = W('a'), b = W('b');
  const tree = split('h', 0.5, leaf(a), leaf(b));
  self._bspSwapWindows(tree, a, b);
  assert.deepEqual(self._bspCollectWindows(tree), [b, a]);
});

test('_bspTagGeometry assigns rects honouring the gap', () => {
  const self = makeSelf();
  const a = W('a'), b = W('b');
  const tree = split('h', 0.5, leaf(a), leaf(b));
  self._bspTagGeometry(tree, 0, 0, 200, 100, 0);
  assert.deepEqual(
    { x: tree.first._x, y: tree.first._y, w: tree.first._w, h: tree.first._h },
    { x: 0, y: 0, w: 100, h: 100 });
  assert.deepEqual(
    { x: tree.second._x, y: tree.second._y, w: tree.second._w, h: tree.second._h },
    { x: 100, y: 0, w: 100, h: 100 });
});

test('_bspFindLeafAtPoint resolves the leaf under a point', () => {
  const self = makeSelf();
  const a = W('a'), b = W('b');
  const tree = split('h', 0.5, leaf(a), leaf(b));
  assert.equal(self._bspFindLeafAtPoint(tree, 0, 0, 200, 100, 20, 50, 0).window, a);
  assert.equal(self._bspFindLeafAtPoint(tree, 0, 0, 200, 100, 180, 50, 0).window, b);
});

test('_bspReplaceLeaf replaces a target leaf with a split holding the new window', () => {
  const self = makeSelf({ 'dwindle-ratio': 0.5 });
  const a = W('a'), b = W('b');
  const tree = leaf(a);
  tree._w = 200; tree._h = 100;
  const replaced = self._bspReplaceLeaf(tree, tree, b, 0.7);
  assert.equal(replaced.type, 'split');
  assert.equal(replaced.ratio, 0.7);
  assert.equal(replaced.first.window, a);
  assert.equal(replaced.second.window, b);
});
