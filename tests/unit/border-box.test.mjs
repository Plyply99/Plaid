import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin } from '../helpers.mjs';

// The border's box in the window actor. An X11 window actor repaints only its
// surface and shadow, so on X11 the box stays inside the buffer.

const box = (opts, width = 2) => {
  const self = makeSelf();
  const win = fakeWin(opts);
  return self.borders.borderBox(win, win.get_frame_rect(), win.get_buffer_rect(), width);
};

test('borderBox: Wayland draws the border outside the frame, even past the buffer', () => {
  const frame = { x: 100, y: 50, width: 400, height: 300 };
  assert.deepEqual(box({ frame, clientType: 0 }), [-2, -2, 404, 304]);
});

test('borderBox: a frameless X11 window (frame == buffer) keeps the border inside its buffer', () => {
  const frame = { x: 100, y: 50, width: 400, height: 300 };
  assert.deepEqual(box({ frame, clientType: 1 }), [0, 0, 400, 300]);
});

test('borderBox: an X11 window with a margin (GNOME frame, shadow) is unchanged', () => {
  const frame = { x: 100, y: 50, width: 400, height: 300 };
  const buffer = { x: 80, y: 30, width: 440, height: 340 };
  assert.deepEqual(box({ frame, buffer, clientType: 1 }), [18, 18, 404, 304]);
});

test('borderBox: an X11 margin narrower than the border clamps only that side', () => {
  const frame = { x: 100, y: 50, width: 400, height: 300 };
  const buffer = { x: 99, y: 40, width: 401, height: 320 }; // 1 px left, 0 right, 10 top/bottom
  assert.deepEqual(box({ frame, buffer, clientType: 1 }), [0, 8, 401, 304]);
});

test('borderBox: the scratch ring box (border + ring width) is clamped the same way', () => {
  const frame = { x: 100, y: 50, width: 400, height: 300 };
  assert.deepEqual(box({ frame, clientType: 1 }, 6), [0, 0, 400, 300]);
  assert.deepEqual(box({ frame, clientType: 0 }, 6), [-6, -6, 412, 312]);
});

test('borderBox is the one place the border box is computed from the buffer', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../extensions/modules/borders.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  // Calibrated on the helper's own line: one site, and it is borderBox.
  assert.equal(code.match(/frame\.x - buffer\.x/g)?.length, 1);
  assert.match(code, /borderBox\(win, frame, buffer, width\) \{\n\s+let x = frame\.x - buffer\.x - width/);
});
