import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin } from '../helpers.mjs';

test('_parseMinSizeOverrides parses "Name:WxH" and lowercases keys', () => {
  const self = makeSelf();
  const map = self._parseMinSizeOverrides(['Steam:1364x810', 'Friends List:306x540', 'bad', 'x:1x2']);
  assert.deepEqual(map.get('steam'), { w: 1364, h: 810 });
  assert.deepEqual(map.get('friends list'), { w: 306, h: 540 });
  assert.deepEqual(map.get('x'), { w: 1, h: 2 });
  assert.equal(map.has('bad'), false);
  assert.equal(map.size, 3);
});

test('_parseMinSizeOverrides tolerates empty input', () => {
  const self = makeSelf();
  assert.equal(self._parseMinSizeOverrides(undefined).size, 0);
  assert.equal(self._parseMinSizeOverrides([]).size, 0);
});

test('_compileTitlePatterns anchors wildcards and escapes regex metacharacters', () => {
  const self = makeSelf();
  const [foo, bar, dot] = self._compileTitlePatterns(['Foo*', '*Bar*', 'a.b*']);
  assert.equal(foo.test('Foo'), true);
  assert.equal(foo.test('Foobar'), true);
  assert.equal(foo.test('xFoo'), false);
  assert.equal(bar.test('xBarx'), true);
  assert.equal(dot.test('a.bc'), true);
  assert.equal(dot.test('axbc'), false);
});

test('_compileTitlePatterns ignores literal-only entries', () => {
  const self = makeSelf();
  assert.equal(self._compileTitlePatterns(['NoWildcard']).length, 0);
});

test('_floatingTitleMatches checks the exact set first, then patterns', () => {
  const self = makeSelf();
  self._floatingTitles = new Set(['Exact']);
  self._floatingTitlePatterns = self._compileTitlePatterns(['Pic*']);
  assert.equal(self._floatingTitleMatches('Exact'), true);
  assert.equal(self._floatingTitleMatches('Picture-in-Picture'), true);
  assert.equal(self._floatingTitleMatches('Other'), false);
  assert.equal(self._floatingTitleMatches(''), false);
});

test('_winClassCandidates returns instance, class and GTK app id (lowercased)', () => {
  const self = makeSelf();
  const win = fakeWin({ instance: 'Foo', wmClass: 'Bar', appId: 'org.Baz' });
  assert.deepEqual(self._winClassCandidates(win), ['foo', 'bar', 'org.baz']);
});

test('_winClassCandidates drops the empty instance mutter 51 leaves on Wayland', () => {
  const self = makeSelf();
  const win = fakeWin({ instance: '', wmClass: 'Bar', appId: 'org.Baz' });
  assert.deepEqual(self._winClassCandidates(win), ['bar', 'org.baz']);
});
