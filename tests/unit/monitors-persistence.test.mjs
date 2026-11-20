import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf } from '../helpers.mjs';

function withMonitors(primary, fn) {
  const list = ['eDP-1', 'DP-1', 'HDMI-1'].map(c => ({
    connector: c,
    get_connector() { return this.connector; },
  }));
  const mgr = {
    get_logical_monitors: () => list.map((m, i) => ({
      get_number: () => i,
      get_monitors: () => [m],
    })),
  };
  const oldBackend = globalThis.global.backend;
  const oldPrimary = globalThis.global.display.get_primary_monitor;
  const oldCount = globalThis.global.display.get_n_monitors;
  const oldWm = globalThis.global.workspace_manager;
  globalThis.global.backend = { get_monitor_manager: () => mgr };
  globalThis.global.display.get_primary_monitor = () => primary;
  globalThis.global.display.get_n_monitors = () => list.length;
  globalThis.global.workspace_manager = {
    get_n_workspaces: () => 3,
    get_workspace_by_index: () => null,
  };
  try {
    fn(list);
  } finally {
    globalThis.global.backend = oldBackend;
    globalThis.global.display.get_primary_monitor = oldPrimary;
    globalThis.global.display.get_n_monitors = oldCount;
    globalThis.global.workspace_manager = oldWm;
  }
}

test('persistence: loads connector-keyed rules alongside the bare keys', () => {
  withMonitors(0, () => {
    const self = makeSelf({
      'monitor-primary-connector': 'eDP-1',
      'workspace-layouts': ['1:dwindle'],
      'monitor-workspace-layouts': ['DP-1:2:master-stack'],
      'monitor-workspace-master-ratios': ['DP-1:2:0.65'],
      'monitor-workspace-stack-ratios': ['DP-1:2:0:1.0,1:0.8'],
      'monitor-workspace-dwindle-trees': ['DP-1:3:h0.8480(l,l)'],
    });

    self.persistence.loadPersistedLayoutRules();

    assert.equal(self._keyedPrimary, 'eDP-1');
    assert.equal(self._persistedLayoutByIndex.get(1), 'dwindle');
    assert.equal(self._persistedLayoutByIndex.get('2@DP-1'), 'master-stack');
    assert.equal(self._persistedMasterByIndex.get('2@DP-1'), 0.65);
    assert.deepEqual([...self._persistedStackByIndex.get('2@DP-1')], [[0, 1], [1, 0.8]]);
    assert.ok(self._persistedDwindleByIndex.has('3@DP-1'));
    assert.equal(self._persistedDwindleRaw.get('3@DP-1'), 'h0.8480(l,l)');
  });
});

test('persistence: saves live connector groups and preserves disconnected ones', () => {
  withMonitors(0, () => {
    const self = makeSelf({
      'monitor-workspace-layouts': ['HDMI-9:1:floating'],
    });
    self.persistence.loadPersistedLayoutRules();
    self.geometry.wsIndex = () => 2;
    self._workspaceLayouts.set('2@DP-1', 'master-stack');
    self._masterRatios.set('2@DP-1', 0.7);
    self._persistedLayoutByIndex.set('3@DP-1', 'centered-master-stack');

    self.persistence.savePersistedLayouts();

    const layouts = self._settings.get_strv('monitor-workspace-layouts');
    assert.ok(layouts.includes('DP-1:2:master-stack'));
    assert.ok(layouts.includes('DP-1:3:centered-master-stack'));
    assert.ok(layouts.includes('HDMI-9:1:floating'), 'disconnected monitor kept');
    assert.deepEqual(self._settings.get_strv('monitor-workspace-master-ratios'), ['DP-1:2:0.7']);
    assert.equal(self._settings.get_string('monitor-primary-connector'), 'eDP-1');
  });
});

test('persistence: bare keys are left alone while the keyed primary is absent', () => {
  withMonitors(0, () => {
    const self = makeSelf({
      'monitor-primary-connector': 'HDMI-9',
      'workspace-layouts': ['1:dwindle'],
      'workspace-master-ratios': ['1:0.6'],
      'workspace-dwindle-trees': ['1:h0.5000(l,l)'],
    });

    self.persistence.loadPersistedLayoutRules();
    self.persistence.savePersistedLayouts();

    assert.deepEqual(self._settings.get_strv('workspace-layouts'), ['1:dwindle']);
    assert.deepEqual(self._settings.get_strv('workspace-master-ratios'), ['1:0.6']);
    assert.deepEqual(self._settings.get_strv('workspace-dwindle-trees'), ['1:h0.5000(l,l)']);
    assert.equal(self._settings.get_string('monitor-primary-connector'), 'HDMI-9');
  });
});

test('persistence: loads and saves fixed-mode rules per connector', () => {
  withMonitors(0, () => {
    const self = makeSelf({
      'monitor-fixed-layouts': ['DP-1:dwindle', 'HDMI-9:floating'],
      'monitor-fixed-master-ratios': ['DP-1:0.6'],
      'monitor-fixed-stack-ratios': ['DP-1:0:1.0,1:0.5'],
      'monitor-fixed-dwindle-trees': ['DP-1:h0.5000(l,l)'],
    });

    self.persistence.loadPersistedLayoutRules();
    assert.equal(self._persistedLayoutByIndex.get('m@DP-1'), 'dwindle');
    assert.equal(self._persistedMasterByIndex.get('m@DP-1'), 0.6);
    assert.deepEqual([...self._persistedStackByIndex.get('m@DP-1')], [[0, 1], [1, 0.5]]);
    assert.equal(self._persistedDwindleRaw.get('m@DP-1'), 'h0.5000(l,l)');

    self._workspaceLayouts.set('m@DP-1', 'master-stack');
    self.geometry.wsIndex = () => 2;
    self.persistence.savePersistedLayouts();

    const layouts = self._settings.get_strv('monitor-fixed-layouts');
    assert.ok(layouts.includes('DP-1:master-stack'));
    assert.ok(layouts.includes('HDMI-9:floating'), 'disconnected connector preserved');
    assert.ok(self._settings.get_strv('monitor-fixed-master-ratios').includes('DP-1:0.6'));
  });
});
