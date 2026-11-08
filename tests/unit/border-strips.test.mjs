import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import St from 'gi://St';
import cairo from 'gi://cairo';
import { makeSelf, fakeWin, frameClock } from '../helpers.mjs';

// Gradient borders as four edge strips, borders moved and recoloured in place,
// and the grab loop touching only borders that moved.

class FakeActor {
  constructor(p = {}) {
    Object.assign(this, { x: 0, y: 0, width: 0, height: 0, visible: true, mapped: true }, p);
    this.children = [];
    this.parent = null;
    this.calls = { pos: 0, size: 0, repaint: 0, style: 0 };
    this.handlers = [];
    this.destroyed = false;
  }
  add_child(c) { this.children.push(c); c.parent = this; }
  get_parent() { return this.parent; }
  get_first_child() { return this.children[0] ?? null; }
  get_last_child() { return this.children.at(-1) ?? null; }
  get_previous_sibling() { const k = this.parent?.children ?? []; return k[k.indexOf(this) - 1] ?? null; }
  get_next_sibling() { const k = this.parent?.children ?? []; const i = k.indexOf(this); return i < 0 ? null : k[i + 1] ?? null; }
  set_child_above_sibling(c, sib) { this.children = this.children.filter(k => k !== c); this.children.push(c); this.raises = (this.raises ?? 0) + 1; }
  set_position(x, y) { this.calls.pos++; this.x = x; this.y = y; }
  set_size(w, h) { this.calls.size++; this.width = w; this.height = h; }
  set_style(s) { this.calls.style++; this.style = s; }
  destroy() { this.destroyed = true; if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  connectObject(...a) { const obj = a.pop(); for (let i = 0; i + 1 < a.length; i += 2) this.handlers.push([obj, a[i], a[i + 1]]); }
  disconnectObject() {}
}
// St.DrawingArea on GNOME 50: a size is allocated at the next frame (flush),
// which draws when the allocation changed; queue_repaint draws at once, on
// every call, into the surface of the current allocation. `repaint` counts
// draws; a draw through the handler records get_surface_size().
const NOOP_CR = { translate() {}, setLineWidth() {}, setLineCap() {}, setLineJoin() {}, setSourceRGB() {},
  setSource() {}, moveTo() {}, lineTo() {}, arc() {}, closePath() {}, stroke() {}, $dispose() {} };
class FakeArea extends FakeActor {
  constructor(p) { super(p); this.alloc = [0, 0]; }
  get_surface_size() { return [...this.alloc]; }
  get_context() { return this.cr ?? NOOP_CR; }
  draw() { this.calls.repaint++; for (const [, sig, fn] of this.handlers) if (sig === 'repaint') fn(); }
  queue_repaint() { this.calls.queue = (this.calls.queue ?? 0) + 1; this.draw(); }
  flush() {
    if (this.alloc[0] === this.width && this.alloc[1] === this.height) return;
    this.alloc = [this.width, this.height];
    if (this.visible) this.draw();
  }
}

// The repaint handler's cairo enums (the loader's cairo is empty; a throw
// inside the handler is caught and draws nothing).
cairo.LineCap ??= { ROUND: 1 };
cairo.LineJoin ??= { ROUND: 1 };
cairo.LinearGradient ??= class { constructor(...line) { this.line = line; this.stops = []; }
  addColorStopRGB(o, r, g, b) { this.stops.push([o, r, g, b]); } };

function withSt(fn) {
  const old = { Widget: St.Widget, DrawingArea: St.DrawingArea };
  St.Widget = FakeActor;
  St.DrawingArea = FakeArea;
  try { return fn(); } finally { St.Widget = old.Widget; St.DrawingArea = old.DrawingArea; }
}

const SETTINGS = {
  'borders-enabled': true, 'gradient-borders': true, 'rounded-corners': false, 'border-radius': 15,
  'active-border-width': 2, 'inactive-border-width': 2, 'gradient-direction': 'vertical',
  'active-border-color': ['#ff0000'], 'active-border-color-2': ['#0000ff'],
  'inactive-border-color': ['#202020'], 'inactive-border-color-2': ['#404040'],
  'border-animation-speed': 0, 'enabled': true,
};

function setup(extra = {}) {
  const values = { ...SETTINGS, ...extra };
  const self = makeSelf(values);
  // Writable: a test flips a key between passes.
  Object.assign(self._settings, {
    set_boolean: (k, v) => { values[k] = v; }, set_int: (k, v) => { values[k] = v; },
  });
  const actor = new FakeActor();
  let frame = { x: 100, y: 50, width: 800, height: 600 };
  const win = fakeWin({ actor });
  win.get_frame_rect = () => ({ ...frame });
  win.get_buffer_rect = () => ({ ...frame });
  return { self, actor, win, setFrame: f => { frame = { ...frame, ...f }; } };
}

// Draws so far, after the next frame.
const repaints = b => b._plaidStrips.reduce((n, s) => { s.flush(); return n + s.calls.repaint; }, 0);

test('borderStripRects: four strips tile the border band once, as deep as a corner', () => {
  const self = makeSelf();
  const cover = (info, w, h) => {
    const rects = self.borderMath.borderStripRects(info, w, h);
    const hits = new Map();
    for (const r of rects)
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++) hits.set(`${x},${y}`, (hits.get(`${x},${y}`) ?? 0) + 1);
    return { rects, hits };
  };
  const { rects, hits } = cover({ width: 2, radius: 15 }, 80, 60);
  assert.deepEqual(rects.map(r => [r.x, r.y, r.w, r.h]), [[0, 0, 80, 18], [0, 42, 80, 18], [0, 18, 18, 24], [62, 18, 18, 24]]);
  assert.ok([...hits.values()].every(n => n === 1), 'no pixel in two strips');
  // The band: every pixel within the corner depth of an edge is in a strip.
  for (let y = 0; y < 60; y++)
    for (let x = 0; x < 80; x++)
      if (Math.min(x, y, 79 - x, 59 - y) < 18) assert.ok(hits.has(`${x},${y}`), `${x},${y}`);
  // Smaller than two corners: the strips cover all of it, still once each.
  for (const [w, h] of [[30, 21], [21, 30], [21, 21], [36, 37], [37, 36], [5, 5], [1, 1]]) {
    const c = cover({ width: 2, radius: 15 }, w, h);
    assert.equal(c.hits.size, w * h, `${w}x${h} covered`);
    assert.ok([...c.hits.values()].every(n => n === 1), `${w}x${h} once`);
  }
  // A radius larger than the window is clamped, as the path clamps it.
  assert.equal(self.borderMath.borderStripRects({ width: 4, radius: 400 }, 200, 100)[0].h, 50);
  assert.equal(self.borderMath.borderStripRects({ width: 4, radius: 0 }, 200, 100)[0].h, 5);
});

test('buildBorderSegments: the cache is keyed on the stroke width too', () => {
  const self = makeSelf();
  const b = { width: 100, height: 80, _plaidBorder: { width: 2, radius: 0 } };
  const a = self.borderMath.buildBorderSegments(b);
  b._plaidBorder.width = 8;
  const c = self.borderMath.buildBorderSegments(b);
  assert.notEqual(a, c);
  assert.equal(c[0].y0, 4);
});

test('ensureWindowBorder: a gradient border is four strips laid out and drawn once', () => withSt(() => {
  const { self, actor, win } = setup();
  assert.equal(self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true), true);
  const b = self._windowBorders.get(win);
  assert.equal(actor.children[0], b);
  assert.equal(b._plaidStrips.length, 4);
  assert.deepEqual([b.x, b.y, b.width, b.height], [-2, -2, 804, 604]);
  assert.deepEqual(b._plaidStrips.map(s => [s.x, s.y, s.width, s.height]),
    [[0, 0, 804, 18], [0, 586, 804, 18], [0, 18, 18, 568], [786, 18, 18, 568]]);
  assert.equal(repaints(b), 4);
}));

test('ensureWindowBorder: moved, resized and recoloured in place; same widget', () => withSt(() => {
  const { self, actor, win, setFrame } = setup();
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win);
  // Unchanged: nothing touched.
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.deepEqual([b.calls.pos, b.calls.size, repaints(b)], [1, 1, 4]);
  // A move of the buffer origin: position only, no redraw.
  setFrame({ x: 100 }); win.get_buffer_rect = () => ({ x: 90, y: 50, width: 800, height: 600 });
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.equal(self._windowBorders.get(win), b);
  assert.deepEqual([b.x, b.calls.size, repaints(b)], [8, 1, 4]);
  // A resize: laid out and redrawn.
  win.get_buffer_rect = () => win.get_frame_rect();
  setFrame({ width: 500 });
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.equal(self._windowBorders.get(win), b);
  assert.deepEqual([b.width, b._plaidStrips[0].width, repaints(b)], [504, 504, 8]);
  // Focus lost: recoloured, redrawn, still the same widget.
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), false);
  assert.equal(self._windowBorders.get(win), b);
  assert.ok(Math.abs(b._plaidBorder.color1.r - 0x20 / 255) < 1e-9);
  assert.equal(repaints(b), 12);
  assert.equal(b.destroyed, false);
}));

test('ensureWindowBorder: gradient to solid, a dead actor, or a resized scratch window builds anew', () => withSt(() => {
  const { self, actor, win, setFrame } = setup();
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const g = self._windowBorders.get(win);
  self._settings.set_boolean('gradient-borders', false);
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const solid = self._windowBorders.get(win);
  assert.notEqual(solid, g);
  assert.equal(g.destroyed, true);
  assert.match(solid.style, /border: 2px solid #ff0000/);
  // A solid border recoloured in place: a new style, the same widget.
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), false);
  assert.equal(self._windowBorders.get(win), solid);
  assert.match(solid.style, /#202020/);
  // The actor replaced: rebuilt on the new one.
  const actor2 = new FakeActor();
  win.get_compositor_private = () => actor2;
  self.borders.ensureWindowBorder(win, actor2, win.get_frame_rect(), false);
  assert.notEqual(self._windowBorders.get(win), solid);
  assert.equal(self._windowBorders.get(win).get_parent(), actor2);
  // A scratch window that was resized is rebuilt with its ring (a move
  // carries border and ring with the actor).
  self._scratchpadWindows = new Set([win]);
  self._scratchpadRings = new Map();
  self.borders.ensureWindowBorder(win, actor2, win.get_frame_rect(), true);
  const s1 = self._windowBorders.get(win);
  self.borders.ensureWindowBorder(win, actor2, win.get_frame_rect(), true);
  assert.equal(self._windowBorders.get(win), s1, 'unmoved scratch border kept');
  setFrame({ height: 500 });
  self.borders.ensureWindowBorder(win, actor2, win.get_frame_rect(), true);
  assert.notEqual(self._windowBorders.get(win), s1);
  assert.equal(self._scratchpadRings.size, 1);
}));

test('updateBordersDuringGrab: only a border whose window changed is touched', () => withSt(() => {
  const a = setup(), self = a.self;
  const actorB = new FakeActor();
  const winB = fakeWin({ actor: actorB, frame: { x: 1000, y: 50, width: 400, height: 600 } });
  self.borders.ensureWindowBorder(a.win, a.actor, a.win.get_frame_rect(), true);
  self.borders.ensureWindowBorder(winB, actorB, winB.get_frame_rect(), false);
  const ba = self._windowBorders.get(a.win), bb = self._windowBorders.get(winB);
  const before = [repaints(ba), repaints(bb), bb.calls.pos, bb.calls.size];
  a.setFrame({ width: 700 });
  self.borders.updateBordersDuringGrab();
  self.borders.updateBordersDuringGrab();
  assert.deepEqual([repaints(bb), bb.calls.pos, bb.calls.size], before.slice(1), 'B untouched');
  assert.equal(repaints(ba), before[0] + 4, 'A redrawn once');
  assert.equal(ba.width, 704);
  // The stroke it was drawn with: a focus change mid-grab is the pass's to restyle.
  self._settings.set_int('active-border-width', 8);
  a.setFrame({ width: 690 });
  self.borders.updateBordersDuringGrab();
  assert.equal(ba.width, 694);
}));

test('repaintBorder: a rotating gradient\'s strip draws only the segments reaching it, a run in its first segment\'s colour', () => withSt(() => {
  const { self, actor, win } = setup({ 'border-animation-speed': 5 });
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win);
  const log = [];
  const ctx = () => ({ $dispose() {},
    translate: (x, y) => log.push(['t', x, y]), setLineWidth() {}, setLineCap() {}, setLineJoin() {},
    setSourceRGB: (r, g, bl) => log.push(['c', r, g, bl]), moveTo: (x, y) => log.push(['m', x, y]),
    lineTo: (x, y) => log.push(['l', x, y]), stroke: () => log.push(['s']),
  });
  const runs = () => self.borderMath.borderRuns(self.borderMath.buildBorderSegments(b, 804, 604), 804, 604,
    b._plaidBorder, true, b._plaidTheta);
  for (const strip of b._plaidStrips) {
    log.length = 0;
    strip.cr = ctx();
    self.borders.repaintBorder(b, strip);
    assert.deepEqual(log[0], ['t', -strip.x, -strip.y]);
    assert.ok(log.filter(e => e[0] === 's').length > 0, 'the strip strokes');
    const [sx, sy] = [strip.x, strip.y];
    for (const e of log.filter(e => e[0] === 'm' || e[0] === 'l')) {
      assert.ok(e[1] >= sx - 2 - 12 && e[1] <= sx + strip.width + 2 + 12, `x ${e[1]} near strip`);
      assert.ok(e[2] >= sy - 2 - 12 && e[2] <= sy + strip.height + 2 + 12, `y ${e[2]} near strip`);
    }
    // Every colour set is a run's colour, never a mid-run segment's own.
    const colours = new Set(runs().map(r => `${r.c.r},${r.c.g},${r.c.b}`));
    for (const e of log.filter(e => e[0] === 'c')) assert.ok(colours.has(`${e[1]},${e[2]},${e[3]}`));
  }
  // The left strip starts mid-run (the vertical gradient runs along it).
  const segs = self.borderMath.buildBorderSegments(b, 804, 604);
  const left = b._plaidStrips[2];
  const first = segs.findIndex(s => Math.min(s.x0, s.x1) <= left.width + 2 && Math.max(s.y0, s.y1) >= 18 - 2 &&
    Math.min(s.y0, s.y1) <= 586 + 2 && s.x0 < 20 && s.x1 < 20);
  assert.ok(first >= 0);
}));

test('queueBorderRepaint: all strips at one angle; a plain widget is not redrawn', () => withSt(() => {
  const { self, actor, win } = setup({ 'border-animation-speed': 5 });
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win);
  const oldNow = Date.now;
  let t = 1000;
  Date.now = () => t;
  try {
    self.borders.queueBorderRepaint(b);
    const theta = b._plaidPaintTheta;
    const seen = [];
    for (const strip of b._plaidStrips) {
      t += 7;
      strip.cr = { translate() {}, setLineWidth() {}, setLineCap() {}, setLineJoin() {}, setSourceRGB() {},
        moveTo() {}, lineTo() {}, stroke() {} };
      self.borders.repaintBorder(b, strip);
      seen.push(b._plaidTheta);
    }
    assert.deepEqual(seen, [theta, theta, theta, theta]);
  } finally {
    Date.now = oldNow;
  }
  const plain = new FakeActor();
  self.borders.queueBorderRepaint(plain);
  assert.equal(plain.calls.repaint, 0);
}));

test('borderRuns: each segment carries its run\'s colour, the exact colour of the run\'s first segment', () => {
  const self = makeSelf();
  const m = self.borderMath;
  const info = { width: 2, radius: 15, direction: 'diagonal', color1: m.hexToRgb('#ff0000'), color2: m.hexToRgb('#0000ff') };
  const b = { _plaidBorder: info };
  const segs = m.buildBorderSegments(b, 804, 604);
  const runs = m.borderRuns(segs, 804, 604, info, false, 0);
  const own = segs.map(seg => m.lerpRgb(info.color1, info.color2,
    m.borderGradientPos(804, 604, { x: (seg.x0 + seg.x1) / 2, y: (seg.y0 + seg.y1) / 2 }, 'diagonal', false, 0, 402, 302)));
  const key = c => (Math.round(c.r * 255) << 16) | (Math.round(c.g * 255) << 8) | Math.round(c.b * 255);
  let start = 0, midRun = 0;
  for (let i = 0; i < segs.length; i++) {
    if (i > 0 && key(own[i]) !== key(own[i - 1])) start = i;
    assert.equal(runs[i].key, key(own[i]));
    assert.deepEqual(runs[i].c, own[start], `segment ${i} in the run from ${start}`);
    if (i > start && (own[i].r !== own[start].r || own[i].b !== own[start].b)) midRun++;
  }
  assert.ok(midRun > 0, 'some mid-run segment has a colour of its own (the case this guards)');
});

test('repaintBorder: a strip\'s segments on both sides of a gap are separate runs, never one line across', () => withSt(() => {
  // One colour: every segment is one run, so only the gap cut separates the
  // top strip's right corner from its left one.
  const { self, actor, win } = setup({ 'active-border-color-2': ['#ff0000'], 'border-animation-speed': 5 });
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win);
  const top = b._plaidStrips[0];
  const log = [];
  top.cr = { translate() {}, setLineWidth() {}, setLineCap() {}, setLineJoin() {}, setSourceRGB() {}, $dispose() {},
    moveTo: (x, y) => log.push(['m', x, y]), lineTo: (x, y) => log.push(['l', x, y]), stroke: () => log.push(['s']) };
  self.borders.repaintBorder(b, top);
  assert.ok(log.filter(e => e[0] === 's').length >= 2, 'two runs');
  let last = null;
  for (const e of log) {
    if (e[0] === 's') { last = null; continue; }
    if (e[0] === 'l' && last && Math.abs(e[1] - last[1]) > 2 * top.height)
      assert.ok(Math.abs(e[2] - 1) < 1e-6 && Math.abs(last[2] - 1) < 1e-6, `long line off the top edge: ${last} -> ${e}`);
    last = e;
  }
}));

test('unwrapMaskActor: a border or ring of either kind is never the X11 client surface', () => withSt(() => {
  const { self, actor, win } = setup({ 'gradient-borders': false });
  win.get_client_type = () => 1;
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.equal(self.masks.unwrapMaskActor(actor, win), null, 'only Plaid children: no surface yet');
  const surface = new FakeActor();
  actor.add_child(surface);
  assert.equal(self.masks.unwrapMaskActor(actor, win), surface, 'a solid border is skipped');
  self._settings.set_boolean('gradient-borders', true);
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  actor.children = [self._windowBorders.get(win), surface];
  assert.equal(self.masks.unwrapMaskActor(actor, win), surface, 'a gradient border is skipped');
  self._scratchpadWindows = new Set([win]);
  self._scratchpadRings = new Map();
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  actor.children = [self._scratchpadRings.get(win), self._windowBorders.get(win), surface];
  assert.equal(self.masks.unwrapMaskActor(actor, win), surface, 'the ring is skipped');
}));

test('ensureWindowBorder: a border kept in place goes back above a replaced client surface', () => withSt(() => {
  const { self, actor, win } = setup();
  const surface = new FakeActor();
  actor.add_child(surface);
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win);
  assert.equal(actor.get_last_child(), b);
  // Unchanged and on top: no restack.
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.equal(actor.raises ?? 0, 0);
  // The surface replaced: the new one is appended after the border.
  actor.children = actor.children.filter(c => c !== surface);
  actor.add_child(new FakeActor());
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.equal(self._windowBorders.get(win), b);
  assert.equal(actor.get_last_child(), b);
  // Recoloured in place: also on top.
  actor.add_child(new FakeActor());
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), false);
  assert.equal(actor.get_last_child(), b);
}));

test('updateBordersDuringGrab: a scratch border is left for the pass, which lays it out with its ring', () => withSt(() => {
  const { self, actor, win, setFrame } = setup();
  self._scratchpadWindows = new Set([win]);
  self._scratchpadRings = new Map();
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win);
  setFrame({ width: 600 });
  self.borders.updateBordersDuringGrab();
  assert.equal(b.width, 804, 'not moved by the grab loop');
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.equal(self._windowBorders.get(win).width, 604);
  assert.equal(self._scratchpadRings.get(win).width, 604 + 2 * 2);
}));

test('a rebuilt or removed gradient border drops its strip handlers', () => withSt(() => {
  const { self, actor, win } = setup();
  const n0 = self.borders._tokens.length;
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.equal(self.borders._tokens.length, n0 + 4);
  for (let i = 0; i < 3; i++) {
    self._settings.set_boolean('gradient-borders', i % 2 === 0 ? false : true);
    self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  }
  self.borders.removeBorder(win);
  assert.equal(self.borders._tokens.length, n0);
}));

test('ensureWindowBorder: stopping the rotation redraws the static gradient', () => withSt(() => {
  const { self, actor, win } = setup({ 'border-animation-speed': 5 });
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win);
  const before = repaints(b);
  self._settings.set_int('border-animation-speed', 0);
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.equal(self._windowBorders.get(win), b);
  assert.equal(repaints(b), before + 4);
}));

test('placeBorder: a strip resized and back before it is drawn again is redrawn for the new border', () => withSt(() => {
  const { self, actor, win } = setup({ 'gradient-direction': 'vertical' });
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win);
  const top = b._plaidStrips[0];
  top.flush(); // allocated and drawn at 804 x 18
  const q = top.calls.queue ?? 0;
  // Wider (St would draw it at the next frame), then taller with the old
  // width before any frame: the top strip is 804 x 18 again, as last drawn,
  // but its vertical gradient spans a new height.
  self.borders.placeBorder(b, -2, -2, 904, 604);
  self.borders.placeBorder(b, -2, -2, 804, 704);
  assert.equal(top.width, 804);
  assert.equal((top.calls.queue ?? 0) - q, 1, 'queued: St sees no size change');
}));

test('ensureWindowBorder: a scratch border kept in place goes back on top with its ring above it', () => withSt(() => {
  const { self, actor, win } = setup();
  self._scratchpadWindows = new Set([win]);
  self._scratchpadRings = new Map();
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win), ring = self._scratchpadRings.get(win);
  actor.add_child(new FakeActor());
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.equal(self._windowBorders.get(win), b);
  assert.deepEqual(actor.children.slice(-2), [b, ring]);
}));

test('placeBorder: a draw during a pending resize leaves the strip for St, which redraws it at the new size', () => withSt(() => {
  // The rotating tick draws while a resize waits for its frame: it fills the
  // old surface. Put back to the old size before the frame, St sees no
  // change, so the strip is queued.
  const { self, actor, win } = setup({ 'border-animation-speed': 5 });
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win);
  const top = b._plaidStrips[0];
  top.flush();
  self.borders.placeBorder(b, -2, -2, 904, 604); // top: 904 x 18, pending
  self.borders.queueBorderRepaint(b); // the tick, before the frame
  const q = top.calls.queue;
  self.borders.placeBorder(b, -2, -2, 804, 704); // top back to 804 x 18, new height
  assert.equal(top.calls.queue - q, 1, 'queued for the new border');
}));

test('queueBorderRepaint: a hidden strip is not drawn', () => withSt(() => {
  const { self, actor, win } = setup();
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  const b = self._windowBorders.get(win);
  b._plaidStrips[2].visible = false;
  for (const st of b._plaidStrips) st.calls.queue = 0;
  self.borders.queueBorderRepaint(b);
  assert.deepEqual(b._plaidStrips.map(st => st.calls.queue), [1, 1, 0, 1]);
  // A border under two corners deep: the side strips are empty and hidden,
  // and a new look draws only the top and bottom.
  self.borders.placeBorder(b, -2, -2, 20, 20, true);
  for (const st of b._plaidStrips) st.flush();
  assert.deepEqual(b._plaidStrips.map(st => st.visible), [true, true, false, false]);
  for (const st of b._plaidStrips) st.calls.queue = 0;
  self.borders.placeBorder(b, -2, -2, 20, 20, true);
  assert.deepEqual(b._plaidStrips.map(st => st.calls.queue), [1, 1, 0, 0]);
}));

test('keepBorderOnTop: an unchanged border above the surface, with its ring, is never restacked', () => withSt(() => {
  const { self, actor, win } = setup();
  actor.add_child(new FakeActor());
  self._scratchpadWindows = new Set([win]);
  self._scratchpadRings = new Map();
  self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  for (let i = 0; i < 5; i++) self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
  assert.equal(actor.raises ?? 0, 0);
}));

test('queueBorderRepaint: the strips draw at the angle of the redraw, not the last layout\'s', () => withSt(() => {
  const { self, actor, win } = setup({ 'border-animation-speed': 5 });
  const oldNow = Date.now;
  let t = 1000;
  Date.now = () => t;
  try {
    self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
    const b = self._windowBorders.get(win);
    for (const st of b._plaidStrips) st.flush();
    const laidOut = b._plaidTheta;
    t += 3000;
    self.borders.queueBorderRepaint(b);
    assert.notEqual(b._plaidTheta, laidOut);
    assert.equal(b._plaidTheta, self.borders.borderAngle()[1]);
  } finally {
    Date.now = oldNow;
  }
}));

test('repaintBorder: a static gradient is one stroke of the rounded rect with a linear gradient', () => withSt(() => {
  for (const [dir, line] of [['vertical', [0, 0, 0, 604]], ['horizontal', [0, 0, 804, 0]], ['diagonal', [0, 0, 704, 704]]]) {
    const { self, actor, win } = setup({ 'gradient-direction': dir });
    self.borders.ensureWindowBorder(win, actor, win.get_frame_rect(), true);
    const b = self._windowBorders.get(win);
    const left = b._plaidStrips[2];
    const log = [];
    left.cr = { translate: (x, y) => log.push(['t', x, y]), setLineWidth() {}, setLineCap() {}, setLineJoin() {},
      setSourceRGB: () => log.push(['rgb']), setSource: p => log.push(['src', p]),
      moveTo: (x, y) => log.push(['m', x, y]), lineTo: (x, y) => log.push(['l', x, y]),
      arc: (...a) => log.push(['a', ...a]), closePath: () => log.push(['z']), stroke: () => log.push(['s']),
      $dispose: () => log.push(['d']) };
    self.borders.repaintBorder(b, left);
    const src = log.find(e => e[0] === 'src')[1];
    assert.deepEqual(src.line, line, dir);
    assert.deepEqual(src.stops, [[0, 1, 0, 0], [1, 0, 0, 1]]);
    assert.deepEqual(log.map(e => e[0]).join(''), 'tsrcmlalalalazsd', 'one closed path, one stroke, disposed');
    // The rect inset half the stroke, radius 15.
    assert.deepEqual(log.find(e => e[0] === 'm').slice(1), [1 + 15, 1]);
    assert.deepEqual(log.filter(e => e[0] === 'a').map(e => e[3]), [15, 15, 15, 15]);
    assert.ok(!log.some(e => e[0] === 'rgb'), 'no per-run colours');
  }
}));

test('borderPath: the stroke\'s rect and radius, clamped; none when the stroke fills the border', () => {
  const m = makeSelf().borderMath;
  assert.deepEqual(m.borderPath({ width: 2, radius: 15 }, 804, 604), { x: 1, y: 1, pw: 802, ph: 602, r: 15 });
  assert.equal(m.borderPath({ width: 4, radius: 400 }, 100, 60).r, 28);
  assert.equal(m.borderPath({ width: 2, radius: -3 }, 50, 50).r, 0);
  assert.equal(m.borderPath({ width: 8, radius: 0 }, 8, 100), null);
});

test('noteGeometry: a move that keeps the frame where the last pass saw it in the buffer runs no pass', () => {
  const self = makeSelf({ enabled: true });
  let passes = 0;
  self.signals.scheduleBorders = () => passes++;
  self.grab.resizeLoopRunning = () => false;
  let frame = { x: 10, y: 10, width: 400, height: 300 }, buffer = { x: 0, y: 0, width: 420, height: 330 };
  const win = { get_frame_rect: () => ({ ...frame }), get_buffer_rect: () => ({ ...buffer }) };
  self.borders.noteGeometry(win);
  assert.equal(passes, 1, 'never seen by a pass');
  self.borders.notePass(win);
  frame = { ...frame, x: 510 }; buffer = { ...buffer, x: 500 };
  self.borders.noteGeometry(win);
  assert.equal(passes, 1, 'moved with its buffer');
  frame = { ...frame, x: 515 };
  self.borders.noteGeometry(win);
  assert.equal(passes, 2, 'the frame moved inside the buffer');
  self.borders.notePass(win);
  frame = { ...frame, width: 380 };
  self.borders.noteGeometry(win);
  assert.equal(passes, 3, 'resized');
  // A window waiting for its warp is not recorded: its next move runs a pass.
  const w2 = { get_frame_rect: () => ({ ...frame }), get_buffer_rect: () => ({ ...buffer }) };
  self._pendingWarp = new Set([w2]);
  self.borders.notePass(w2);
  self.borders.noteGeometry(w2);
  assert.equal(passes, 4);
});

test('noteGeometry: during a live resize the loop stands in for the pass, unless a mask or blur needs it', () => {
  const values = { enabled: true, 'rounded-corners': false, 'border-radius': 15, 'window-blur': false };
  const self = makeSelf(values);
  let passes = 0;
  self.signals.scheduleBorders = () => passes++;
  const frame = { x: 0, y: 0, width: 400, height: 300 };
  const actor = {};
  let mon = 0, fullscreen = false;
  const win = { get_frame_rect: () => ({ ...frame }), get_buffer_rect: () => ({ ...frame }), get_compositor_private: () => actor,
    get_monitor: () => mon, is_fullscreen: () => fullscreen };
  const border = { get_parent: () => actor };
  self._windowBorders.set(win, border);
  self._grabWindow = { get_monitor: () => 0 };
  self.grab.resizeLoopRunning = () => true;
  self.borders.noteGeometry(win);
  assert.equal(passes, 0, 'resize loop, no mask or blur');
  values['rounded-corners'] = true;
  self.borders.noteGeometry(win);
  assert.equal(passes, 1, 'masks follow the pass');
  values['rounded-corners'] = false; values['window-blur'] = true;
  self.borders.noteGeometry(win);
  assert.equal(passes, 2, 'blur follows the pass');
  values['window-blur'] = false; values['border-radius'] = 0; values['rounded-corners'] = true;
  self.borders.noteGeometry(win);
  assert.equal(passes, 2, 'rounded at radius 0 draws no mask');
  // Only what the tick lays out: not another monitor's window, a fullscreen
  // one, a scratch border, or a window without a border.
  mon = 1;
  self.borders.noteGeometry(win);
  assert.equal(passes, 3, 'another monitor');
  mon = 0; fullscreen = true;
  self.borders.noteGeometry(win);
  assert.equal(passes, 4, 'fullscreen');
  fullscreen = false; border._plaidScratch = true;
  self.borders.noteGeometry(win);
  assert.equal(passes, 5, 'scratch');
  border._plaidScratch = false; self._windowBorders.delete(win);
  self.borders.noteGeometry(win);
  assert.equal(passes, 6, 'no border');
  self._windowBorders.set(win, { get_parent: () => ({}) });
  self.borders.noteGeometry(win);
  assert.equal(passes, 7, 'a border left on a replaced actor');
  self._windowBorders.set(win, border);
  values.enabled = false;
  self.borders.noteGeometry(win);
  assert.equal(passes, 8, 'tiling off: the tick places no border');
  values.enabled = true;
  self.grab.resizeLoopRunning = () => false;
  self.borders.noteGeometry(win);
  assert.equal(passes, 9, 'no resize loop');
});

test('doUpdateBorders: a window the pass strips or skips is not recorded as laid out', () => {
  const self = makeSelf({ 'borders-enabled': false, 'rounded-corners': false, 'window-blur': true, 'blur-exclude': [] });
  self.blur.ensureWindowBlur = () => {};
  self.blur.removeBlur = () => {};
  self.masks.removeMask = () => {};
  self.borders.syncBorderAnimation = () => {};
  let fs = false;
  const frame = { x: 0, y: 0, width: 400, height: 300 };
  const mk = () => ({ is_fullscreen: () => fs, get_compositor_private: () => ({}), get_frame_rect: () => ({ ...frame }),
    get_buffer_rect: () => ({ ...frame }), get_window_type: () => 0, get_wm_class_instance: () => 'gjs' });
  const tiled = mk(), fl = mk();
  self.windows.getWindowsForWorkspace = () => [tiled];
  self.windows.isFloating = (w) => w === fl;
  const ws = { list_windows: () => [tiled, fl] };
  const old = globalThis.global;
  globalThis.global = { ...old, display: { focus_window: null }, workspace_manager: { get_active_workspace: () => ws } };
  try {
    self.borders.doUpdateBorders();
    assert.ok(tiled._plaidPassGeom && fl._plaidPassGeom, 'both laid out');
    fs = true;
    self.borders.doUpdateBorders();
    assert.equal(tiled._plaidPassGeom, undefined, 'tiled fullscreen: stripped');
    assert.equal(fl._plaidPassGeom, undefined, 'float fullscreen: stripped');
  } finally {
    globalThis.global = old;
  }
  // Back from fullscreen at the same rect: the size-changed runs a pass.
  let passes = 0;
  self.signals.scheduleBorders = () => passes++;
  self.grab.resizeLoopRunning = () => false;
  fs = false;
  self.borders.noteGeometry(tiled);
  self.borders.noteGeometry(fl);
  assert.equal(passes, 2);
});

test('resizeLoopRunning: only while the loop runs in resize mode', () => {
  const self = makeSelf({ enabled: true });
  const clock = frameClock();
  try {
    const win = { get_monitor: () => 0, get_compositor_private: () => ({}), get_frame_rect: () => ({ width: 1, height: 1 }) };
    assert.equal(self.grab.resizeLoopRunning(), false);
    self.grab.startGrabLoop(win, 'move');
    assert.equal(self.grab.resizeLoopRunning(), false, 'a move drag lays out no borders');
    self.grab.startGrabLoop(win, 'resize');
    assert.equal(self.grab.resizeLoopRunning(), true);
    self.grab.stopLiveResizeLoop();
    assert.equal(self.grab.resizeLoopRunning(), false);
  } finally {
    clock.restore();
  }
});

test('borderAngle: the period is read once, again after the setting changes', () => {
  const values = { 'border-animation-speed': 5 };
  const self = makeSelf(values);
  let reads = 0;
  const get = self._settings.get_int;
  self._settings.get_int = k => { if (k === 'border-animation-speed') reads++; return get(k); };
  self.borders.borderAngle(); self.borders.borderAngle();
  assert.equal(reads, 1);
  values['border-animation-speed'] = 0;
  assert.equal(self.borders.borderAngle()[0], true, 'cached until told');
  self.borders.forgetRotation();
  assert.equal(self.borders.borderAngle()[0], false);
  assert.equal(reads, 2);
});

test('disconnectToken: releases a token whichever subsystem made it, once', () => {
  const self = makeSelf({ enabled: true });
  const calls = [];
  const emitter = { connectObject() {}, disconnectObject: t => calls.push(t) };
  const n0 = self.windows._tokens.length;
  const t = self.windows.connectObject(emitter, 'x', () => {});
  assert.equal(self.windows._tokens.length, n0 + 1);
  self.borders.disconnectToken(t); // another subsystem
  assert.equal(self.windows._tokens.length, n0);
  assert.deepEqual(calls, [t]);
  self.windows.disconnectToken(t);
  assert.equal(calls.length, 1, 'a second release does nothing');
  self.windows.disconnectToken(0);
  self.windows.disconnectToken(null);
});

function hookEmitter() {
  const handlers = [];
  return {
    handlers,
    connectObject(...a) { const obj = a.pop(); for (let i = 0; i + 1 < a.length; i += 2) handlers.push([obj, a[i], a[i + 1]]); },
    disconnectObject(obj) { for (let i = handlers.length - 1; i >= 0; i--) if (handlers[i][0] === obj) handlers.splice(i, 1); },
    fire(sig) { for (const [, s, fn] of [...handlers]) if (s === sig) fn(); },
  };
}

test('removeBlur: a blur\'s hooks are released also once its window actor is gone', () => {
  const self = makeSelf({ enabled: true });
  const actor = hookEmitter();
  const win = { get_compositor_private: () => null };
  const n0 = self.blur._tokens.length;
  const blur = {
    _actorDestroyId: self.blur.connectObject(actor, 'destroy', () => {}),
    _actorParentSetId: self.blur.connectObject(actor, 'parent-set', () => {}),
    _viewsToken: self.blur.connectObject(actor, 'stage-views-changed', () => {}),
    _settleNotifyIds: ['notify::x', 'notify::y'].map(sig => self.blur.connectObject(actor, sig, () => {})),
  };
  self._windowBlurs.set(win, blur);
  self.blur.removeBlur(win);
  assert.equal(self.blur._tokens.length, n0);
  assert.equal(actor.handlers.length, 0);
  assert.equal(self._windowBlurs.has(win), false);
});

test('disconnectGrabBoundaryHooks: released with no grab window, or another one', () => {
  const self = makeSelf({ enabled: true });
  const a = hookEmitter();
  const n0 = self.grab._tokens.length;
  self._grabSizeChangedId = self.grab.connectObject(a, 'size-changed', () => {});
  self._grabPositionChangedId = self.grab.connectObject(a, 'position-changed', () => {});
  self._grabWindow = null;
  self.grab.disconnectGrabBoundaryHooks();
  assert.equal(self.grab._tokens.length, n0);
  assert.equal(a.handlers.length, 0);
});

test('dropdown terminal: closing it releases its geometry and unmanaged hooks', () => {
  const self = makeSelf({ enabled: true });
  const win = Object.assign(hookEmitter(), { get_pid: () => 0 });
  const n0 = self.dropdown._tokens.length;
  self.dropdown.armDropdownWindow(win, 'term');
  assert.equal(self.dropdown._tokens.length, n0 + 3);
  win.fire('unmanaged');
  assert.equal(self.dropdown._tokens.length, n0);
  assert.equal(win.handlers.length, 0);
  assert.equal(self._dropdownWin, null);
});

test('background app: an unmanaged or first-frame hook releases its own token, not a later one', () => {
  const self = makeSelf({ enabled: true });
  const n0 = self.bgApp._tokens.length;
  const first = hookEmitter(), second = hookEmitter();
  const t1 = self.bgApp.connectObject(first, 'unmanaged', () => self.bgApp.releaseUnmanagedHook(t1));
  self._backgroundAppUnmanagedId = t1;
  const t2 = self.bgApp.connectObject(second, 'unmanaged', () => self.bgApp.releaseUnmanagedHook(t2));
  self._backgroundAppUnmanagedId = t2; // a later window's hook
  first.fire('unmanaged');
  assert.equal(self._backgroundAppUnmanagedId, t2, 'the later hook stays recorded');
  assert.equal(self.bgApp._tokens.length, n0 + 1);
  second.fire('unmanaged');
  assert.equal(self._backgroundAppUnmanagedId, 0);
  assert.equal(self.bgApp._tokens.length, n0);
});

test('background app: its unmanaged and first-frame hooks release the token they were given', () => {
  // The claim paths need the whole app setup; the wiring is read from the source.
  const src = readFileSync(new URL('../../extensions/modules/background-app.js', import.meta.url), 'utf8');
  const unmanaged = [...src.matchAll(/const (\w+) = this\.core\._backgroundAppUnmanagedId = this\.connectObject\(win, 'unmanaged', \(\) => \{\n\s+this\.releaseUnmanagedHook\((\w+)\);/g)];
  assert.equal(unmanaged.length, 2, 'both claim paths');
  for (const m of unmanaged) assert.equal(m[1], m[2]);
  assert.equal((src.match(/'unmanaged'/g) ?? []).length, 3, 'no other unmanaged hook (the waiter cleans up through cleanup)');
  const ff = src.match(/if \(this\.core\._backgroundAppFirstFrameId\) this\.disconnectToken\(this\.core\._backgroundAppFirstFrameId\);\n\s+const (\w+) = this\.core\._backgroundAppFirstFrameId = this\.connectObject\(actor, 'first-frame', \(\) => \{\n(?:\s+\/\/.*\n)?\s+this\.disconnectToken\((\w+)\);\n\s+if \(this\.core\._backgroundAppFirstFrameId === (\w+)\)\n\s+this\.core\._backgroundAppFirstFrameId = 0;/);
  assert.ok(ff, 'an earlier hook is released first; the hook releases its own token and clears only its own field');
  assert.ok(ff[1] === ff[2] && ff[2] === ff[3]);
});
