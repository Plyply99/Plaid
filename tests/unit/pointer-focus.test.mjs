import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin } from '../helpers.mjs';

// Focus on hover focuses the window the pointer enters, never the window it
// moves over while another one holds focus (a menu that took focus from it).

function hoverWorld() {
  const self = makeSelf({ 'pointer-focus': true });
  const pf = self.pointerFocus;
  const focused = [];
  const win = (title) => Object.assign(fakeWin({ title }), {
    focus() { focused.push(title); global.display.focus_window = this; },
  });
  let under = null;
  pf.resolveWindowByScan = () => under;
  pf.canPointerFocusWindow = () => true;
  const prevFocus = global.display.focus_window;
  const prevTime = global.get_current_time;
  global.display.focus_window = null;
  global.get_current_time = () => 0;
  return {
    self, pf, focused, win,
    // One tick at a new pointer position over `w` (null: nothing under it).
    move(w, i) { under = w; pf.applyPointerFocus(10 + i, 10); },
    restore() { global.display.focus_window = prevFocus; global.get_current_time = prevTime; },
  };
}

test('hover: entering a window focuses it once', () => {
  const t = hoverWorld();
  try {
    const a = t.win('A');
    t.move(a, 1);
    t.move(a, 2);
    assert.deepEqual(t.focused, ['A']);
  } finally { t.restore(); }
});

test('hover: moving over the window a menu took focus from keeps the menu focused', () => {
  const t = hoverWorld();
  try {
    const meet = t.win('Meeting');
    const menu = t.win('Toolbar Menu');
    t.move(meet, 1);
    // The app opens its menu as a new window and gives it focus.
    global.display.focus_window = menu;
    for (let i = 2; i < 8; i++) t.move(meet, i);
    assert.deepEqual(t.focused, ['Meeting']);
    assert.equal(global.display.focus_window, menu);
    // Entering the menu itself: already focused, nothing to do.
    t.move(menu, 9);
    assert.deepEqual(t.focused, ['Meeting']);
  } finally { t.restore(); }
});

test('hover: crossing to another window and back focuses each on entry', () => {
  const t = hoverWorld();
  try {
    const a = t.win('A');
    const b = t.win('B');
    t.move(a, 1);
    t.move(b, 2);
    t.move(a, 3);
    assert.deepEqual(t.focused, ['A', 'B', 'A']);
  } finally { t.restore(); }
});

test('hover: leaving to nothing and coming back is an entry', () => {
  const t = hoverWorld();
  try {
    const a = t.win('A');
    t.move(a, 1);
    global.display.focus_window = null; // focus went elsewhere meanwhile
    t.move(null, 2);
    t.move(a, 3);
    assert.deepEqual(t.focused, ['A', 'A']);
  } finally { t.restore(); }
});

test('hover: turning it off forgets the hovered window, so the first move after re-enabling focuses', () => {
  const t = hoverWorld();
  try {
    const a = t.win('A');
    t.move(a, 1);
    global.display.focus_window = null;
    t.pf.teardownPointerFocus();
    t.move(a, 2);
    assert.deepEqual(t.focused, ['A', 'A']);
  } finally { t.restore(); }
});

test('hover: a window whose process verdict was pending is focused once the verdict lands', () => {
  const t = hoverWorld();
  try {
    const a = t.win('A');
    let pending = true;
    t.pf.canPointerFocusWindow = () => !pending;
    t.move(a, 1);
    assert.deepEqual(t.focused, []);
    // The async cmdline read lands (not Chromium): the callback forgets the
    // hovered window (next test), then the forced re-tick at the same position.
    pending = false;
    t.self._pointerFocusHover = null;
    t.move(a, 1);
    assert.deepEqual(t.focused, ['A']);
  } finally { t.restore(); }
});

test('hover: the async verdict callback forgets the hovered window', () => {
  const t = hoverWorld();
  try {
    const a = Object.assign(t.win('A'), { get_pid: () => 4242 });
    const pf = t.pf;
    let landed = null;
    t.self.procInfo.procCmdlineCached = () => undefined;
    t.self.procInfo.getProcCmdline = (_pid, cb) => { landed = cb; };
    t.self._chromiumProcessCache = new Map();
    t.self._pointerFocusHover = a;
    assert.equal(pf.isChromiumProcessWindow(a), true); // pending: skipped
    landed('/usr/bin/zoom');
    assert.equal(t.self._pointerFocusHover, null);
    assert.equal(t.self._pointerFocusLastX, -1);
  } finally { t.restore(); }
});
