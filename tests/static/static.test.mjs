import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const ext = join(root, 'extensions');

const extensionJs = readFileSync(join(ext, 'extension.js'), 'utf8');
const prefsJs = readFileSync(join(ext, 'prefs.js'), 'utf8');
const schemaXml = readFileSync(join(ext, 'schemas', 'org.gnome.shell.extensions.plaid.gschema.xml'), 'utf8');
const metadata = JSON.parse(readFileSync(join(ext, 'metadata.json'), 'utf8'));

// Every shipped source file — the API-usage scans below must cover the
// extracted modules too, or moving code into modules silently drops coverage.
const modulesDir = join(ext, 'modules');
const moduleFiles = existsSync(modulesDir)
  ? readdirSync(modulesDir).filter((f) => f.endsWith('.js')).map((f) => join(modulesDir, f))
  : [];
const sourceFiles = [join(ext, 'extension.js'), join(ext, 'prefs.js'), ...moduleFiles];
const allJs = sourceFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

// Comments legitimately mention removed APIs (documenting why they are gone),
// so the API-usage scans below must ignore comments.
const codeOnly = allJs
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

const schemaKeys = new Set([...schemaXml.matchAll(/<key\s+name="([^"]+)"/g)].map((m) => m[1]));

const keybindingsJs = readFileSync(join(ext, 'modules', 'keybindings.js'), 'utf8');

function extractKeybindKeys() {
  const block = keybindingsJs.match(/const PLAID_KEYBIND_KEYS = \[([\s\S]*?)\];/);
  assert.ok(block, 'PLAID_KEYBIND_KEYS block not found');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('schema declares every PLAID_KEYBIND_KEYS entry', () => {
  for (const key of extractKeybindKeys())
    assert.ok(schemaKeys.has(key), `keybinding "${key}" missing from the schema`);
});

test('every literal settings key read from this._settings exists in the schema', () => {
  const used = [...allJs.matchAll(/this\._settings\.get_(?:int|double|boolean|string|strv)\('([^']+)'\)/g)]
    .map((m) => m[1]);
  const missing = [...new Set(used)].filter((k) => !schemaKeys.has(k));
  assert.deepEqual(missing, [], `settings keys read but not declared: ${missing.join(', ')}`);
});

test('metadata uuid/shell-version are consistent', () => {
  assert.equal(metadata.uuid, 'plaid@plyply99');
  assert.ok(Number.isInteger(metadata.version), 'version must be an integer');
  assert.ok(metadata['shell-version'].includes('50'), 'shell-version must include 50');
  assert.ok(metadata['shell-version'].includes('51'), 'shell-version must include 51');
});

test('no non-introspectable GLib.dir_* calls (removed from the API surface)', () => {
  for (const bad of ['GLib.dir_open', 'GLib.dir_read_name', 'GLib.dir_close'])
    assert.ok(!codeOnly.includes(bad), `${bad} is not introspectable in GJS`);
});

test('Clutter.get_default_backend is only used behind a feature-detect guard', () => {
  if (codeOnly.includes('Clutter.get_default_backend('))
    assert.ok(codeOnly.includes("typeof Clutter.get_default_backend === 'function'"),
      'Clutter.get_default_backend used without the typeof guard');
});

test('no removed St.BoxLayout vertical property usage', () => {
  assert.ok(!codeOnly.includes('.vertical'), 'St.BoxLayout.vertical was removed in GNOME 51');
});

test('prefs.js is present and non-empty', () => {
  assert.ok(prefsJs.length > 1000);
});

test('every relative ./modules/*.js import resolves on disk', () => {
  const importRe = /from\s+['"](\.[^'"]+\.js)['"]/g;
  for (const file of [join(ext, 'extension.js'), join(ext, 'prefs.js'), ...moduleFiles]) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(importRe)) {
      const p = join(dirname(file), m[1]);
      assert.ok(existsSync(p), `import "${m[1]}" in ${file} does not resolve to ${p}`);
    }
  }
});

test('build.sh packs the modules directory', () => {
  const build = readFileSync(join(root, 'build.sh'), 'utf8');
  assert.ok(/paths = \[[^\]]*'modules'/.test(build),
    "build.sh's pack-append list must include 'modules' or the zip will miss them");
});

test('sync.sh syncs the modules directory', () => {
  const sync = readFileSync(join(root, 'sync.sh'), 'utf8');
  assert.ok(sync.includes('$SOURCE/modules'), 'sync.sh must copy extensions/modules');
});

test('entry point stays small and free of lifecycle wrappers', () => {
  const lines = extensionJs.split('\n');
  assert.ok(lines.length <= 100, `extension.js is ${lines.length} lines; keep the default entry point small`);

  const code = extensionJs
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  assert.ok(!code.includes('_disable'), 'the entry point must not keep a _disable() alias');
  assert.ok(!/\btry\s*\{/.test(code), 'the entry point must not wrap enable()/disable() in try/catch');
  assert.ok(!/\bcatch\s*\(/.test(code), 'the entry point must not catch errors');
  assert.ok(!code.includes('Object.assign'), 'prototype augmentation belongs in bootstrap.js');

  const enable = code.indexOf('enable()');
  const disable = code.indexOf('disable()');
  assert.ok(enable >= 0 && disable > enable, 'enable() and disable() must both be present');

  const between = code.slice(enable, disable);
  assert.ok(between.includes('enablePlaid.call(this)'), 'enable() must delegate to lifecycle.js');
  assert.ok(code.slice(disable).includes('disablePlaid.call(this)'), 'disable() must delegate to lifecycle.js');
});

test('every GLib source is tracked or owned by a cleaned-up field', () => {
  const files = [join(ext, 'extension.js'), ...moduleFiles];
  const missed = [];

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const [index, line] of src.split('\n').entries()) {
      if (!/GLib\.(timeout_add|idle_add|timeout_add_seconds)\s*\(/.test(line)) continue;
      if (file.endsWith(join('modules', 'signals.js'))) continue; // the tracker helpers

      const wrapped = /this\._add(?:Timeout|Idle)\s*\(/.test(line);
      const assigned = /(?:^|\s)(?:const\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*=\s*GLib\.(?:timeout_add|idle_add|timeout_add_seconds)\s*\(/.test(line);
      if (!wrapped && !assigned)
        missed.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  }

  assert.deepEqual(missed, [], `untracked GLib sources:\n${missed.join('\n')}`);
});
