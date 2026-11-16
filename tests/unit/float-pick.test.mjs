import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin } from '../helpers.mjs';

test('floatListMatches: finds class, title and process-token entries', () => {
  const self = makeSelf({
    'float-windows': ['org.gnome.nautilus', 'steamwebhelper'],
    'float-titles': ['Picture-in-Picture'],
  }, {
    _floatingClasses: new Set(['org.gnome.nautilus', 'steamwebhelper']),
    _floatingTitles: new Set(['Picture-in-Picture']),
  });
  self.procInfo._procCmdlineCache.set(42, '/usr/bin/nautilus --gapplication-service');
  self.procInfo._procCmdlineCache.set(43, '/usr/bin/steamwebhelper --type=renderer');

  const nautilus = fakeWin({ pid: 42, instance: 'org.gnome.Nautilus', title: 'Home' });
  assert.deepEqual(self.actions.floatListMatches(nautilus), [
    { key: 'float-windows', value: 'org.gnome.nautilus' },
  ]);

  const pip = fakeWin({ pid: 0, instance: 'firefox', title: 'Picture-in-Picture' });
  assert.deepEqual(self.actions.floatListMatches(pip), [
    { key: 'float-titles', value: 'Picture-in-Picture' },
  ]);

  const steam = fakeWin({ pid: 43, instance: 'steam', title: 'Steam' });
  assert.deepEqual(self.actions.floatListMatches(steam), [
    { key: 'float-windows', value: 'steamwebhelper' },
  ]);

  const other = fakeWin({ pid: 0, instance: 'org.gnome.TextEditor', title: 'New Document' });
  assert.deepEqual(self.actions.floatListMatches(other), []);
});

test('applyFloatRemoval: removes entries from both lists and clears the process cache', () => {
  const self = makeSelf({
    'float-windows': ['org.gnome.nautilus', 'other'],
    'float-titles': ['Picture-in-Picture', 'Keep me'],
  }, {
    _floatingClasses: new Set(['org.gnome.nautilus', 'other']),
    _floatingTitles: new Set(['Picture-in-Picture', 'Keep me']),
    _floatProcessCache: new Map([[42, true]]),
  });

  const removed = self.actions.applyFloatRemoval([
    { key: 'float-windows', value: 'org.gnome.nautilus' },
    { key: 'float-titles', value: 'Picture-in-Picture' },
  ]);

  assert.deepEqual(removed, ['org.gnome.nautilus', 'Picture-in-Picture']);
  assert.deepEqual(self._settings.get_strv('float-windows'), ['other']);
  assert.deepEqual(self._settings.get_strv('float-titles'), ['Keep me']);
  assert.deepEqual([...self._floatingClasses], ['other']);
  assert.deepEqual([...self._floatingTitles], ['Keep me']);
  assert.equal(self._floatProcessCache.size, 0);
});
