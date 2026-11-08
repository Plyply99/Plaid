import { test } from 'node:test';
import assert from 'node:assert/strict';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import { makeSelf, fakeWin } from '../helpers.mjs';

// The pill's numbers row is rebuilt only when its shape changes: a focus change
// within a workspace keeps the labels and updates the icon and title.

class Box {
  constructor() { this.kids = []; this.parent = null; this.text = ''; this.visible = true; this.destroyed = false; }
  add_child(c) { this.kids.push(c); c.parent = this; }
  remove_child(c) { this.kids = this.kids.filter(k => k !== c); c.parent = null; }
  get_children() { return [...this.kids]; }
  get_parent() { return this.parent; }
  destroy() { this.destroyed = true; this.parent?.remove_child(this); }
  set_text(t) { this.text = t; this.sets = (this.sets ?? 0) + 1; }
  set_gicon(g) { this.gicon = g; }
  add_style_pseudo_class() {}
}

function setup() {
  const old = { Label: St.Label, Tracker: Shell.WindowTracker, Align: Clutter.ActorAlign, wm: global.workspace_manager, display: global.display };
  let made = 0;
  St.Label = class extends Box { constructor(p) { super(); this.text = p.text; made++; } };
  Shell.WindowTracker = { get_default: () => ({ get_window_app: w => ({ get_icon: () => `icon-${w.get_title()}` }) }) };
  Clutter.ActorAlign ??= { CENTER: 2 };
  let active = 0;
  global.workspace_manager = { n_workspaces: 3, get_active_workspace_index: () => active, get_n_workspaces: () => 3,
    get_workspace_by_index: () => null };
  const display = { focus_window: null };
  global.display = { ...(old.display ?? {}), get focus_window() { return display.focus_window; } };
  const self = makeSelf({ enabled: true });
  const numbers = new Box(), icon = new Box(), title = new Box();
  Object.assign(self, { _workspacePill: new Box(), _workspacePillNumbers: numbers, _workspacePillIcon: icon, _workspacePillTitle: title });
  const restore = () => {
    St.Label = old.Label; Shell.WindowTracker = old.Tracker;
    global.workspace_manager = old.wm; global.display = old.display;
  };
  return { self, numbers, icon, title, display, made: () => made, setActive: a => { active = a; }, restore };
}

const win = t => Object.assign(fakeWin({ title: t }), { skip_taskbar: false });

test('workspace pill: a focus change in the same workspace keeps the numbers row', () => {
  const s = setup();
  try {
    s.display.focus_window = win('one');
    s.self.workspacePill.updateWorkspacePill();
    const labels = s.numbers.get_children().filter(c => c !== s.icon);
    assert.equal(s.made(), 2);
    assert.equal(s.numbers.get_children()[0], s.icon, 'the icon at the active slot');
    assert.equal(s.title.text, 'one');
    s.display.focus_window = win('two');
    s.self.workspacePill.updateWorkspacePill();
    assert.equal(s.made(), 2, 'no label rebuilt');
    assert.deepEqual(s.numbers.get_children().filter(c => c !== s.icon), labels);
    assert.equal(s.title.text, 'two');
    assert.equal(s.icon.gicon, 'icon-two');
    // The same title is not set again.
    const sets = s.title.sets;
    s.self.workspacePill.updateWorkspacePill();
    assert.equal(s.title.sets, sets);
    // No focus: the icon leaves the row, a label takes its slot.
    s.display.focus_window = null;
    s.self.workspacePill.updateWorkspacePill();
    assert.equal(s.made(), 5);
    assert.ok(!s.numbers.get_children().includes(s.icon));
    // Another workspace: rebuilt.
    s.display.focus_window = win('three');
    s.setActive(2);
    s.self.workspacePill.updateWorkspacePill();
    assert.equal(s.made(), 7);
    assert.equal(s.numbers.get_children()[2], s.icon);
    assert.ok(labels.every(l => l.destroyed));
    // Another workspace with a window focused there too: rebuilt, the icon moves.
    s.display.focus_window = win('four');
    s.setActive(1);
    s.self.workspacePill.updateWorkspacePill();
    assert.equal(s.made(), 9);
    assert.equal(s.numbers.get_children()[1], s.icon);
  } finally {
    s.restore();
  }
});

test('workspace pill: a focused window that closes leaves none of its hooks behind', () => {
  const s = setup();
  try {
    const handlers = [];
    const w = Object.assign(win('closing'), {
      connectObject(...a) { const obj = a.pop(); for (let i = 0; i + 1 < a.length; i += 2) handlers.push([obj, a[i], a[i + 1]]); },
      disconnectObject(obj) { for (let i = handlers.length - 1; i >= 0; i--) if (handlers[i][0] === obj) handlers.splice(i, 1); },
    });
    const n0 = s.self.workspacePill._tokens.length;
    s.display.focus_window = w;
    s.self.workspacePill.updateWorkspacePill();
    assert.equal(s.self.workspacePill._tokens.length, n0 + 2, 'title and unmanaged hooks');
    handlers.find(h => h[1] === 'unmanaged')[2]();
    assert.equal(s.self.workspacePill._tokens.length, n0);
    assert.equal(handlers.length, 0);
    assert.equal(s.self._workspacePillFocusedWin, null);
  } finally {
    s.restore();
  }
});
