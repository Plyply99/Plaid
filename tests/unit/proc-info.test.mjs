import { test } from 'node:test';
import assert from 'node:assert/strict';
import Gio from 'gi://Gio';
import { makeSelf } from '../helpers.mjs';

// A process's environment is read for Plaid's own markers only: the cache keeps
// those entries, not the whole block.

function withProcFiles(files, fn) {
  const old = Gio.File;
  Gio.File = { new_for_path: path => ({
    load_contents_async(_c, cb) { cb(this, null); },
    load_contents_finish: () => (path in files ? [true, new TextEncoder().encode(files[path])] : [false, null]),
  }) };
  try { return fn(); } finally { Gio.File = old; }
}

test('getProcEnviron: only the PLAID_ entries are kept; the markers still match', () => {
  const env = ['HOME=/home/u', 'PATH=/usr/bin', 'PLAID_DDT=1', 'X'.repeat(5000) + '=y', 'PLAID_BGAPP=1', 'LANG=C'].join('\0');
  withProcFiles({ '/proc/42/environ': env }, () => {
    const self = makeSelf({ enabled: true });
    let got = null;
    self.procInfo.getProcEnviron(42, e => { got = e; });
    assert.equal(got, 'PLAID_DDT=1\0PLAID_BGAPP=1');
    assert.equal(self.procInfo.procEnvironCached(42), 'PLAID_DDT=1\0PLAID_BGAPP=1');
    assert.equal(self.bgApp.procEnvironHasMarker(42, 'PLAID_BGAPP=1'), true);
    assert.equal(self.bgApp.procEnvironHasMarker(42, 'PLAID_DDT=1'), true);
    assert.equal(self.bgApp.procEnvironHasMarker(42, 'LANG=C'), false, 'nothing else is kept');
  });
});

test('getProcEnviron: a process without markers caches an empty string, a failed read nothing', () => {
  withProcFiles({ '/proc/7/environ': 'HOME=/h\0PATH=/p' }, () => {
    const self = makeSelf({ enabled: true });
    self.procInfo.getProcEnviron(7, () => {});
    assert.equal(self.procInfo.procEnvironCached(7), '');
    self.procInfo.getProcEnviron(8, () => {});
    assert.equal(self.procInfo.procEnvironCached(8), undefined, 'retried later');
  });
});
