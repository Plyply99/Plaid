import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAccel, schemaDefaultValue } from '../../extensions/modules/helpers.js';

test('normalizeAccel: modifier order is irrelevant', () => {
  assert.equal(normalizeAccel('<Super><Shift>h'), normalizeAccel('<Shift><Super>h'));
});

test('normalizeAccel: lowercases key and modifiers', () => {
  assert.equal(normalizeAccel('<super>H'), '<super>h');
  assert.equal(normalizeAccel('<Shift><Super>H'), '<shift><super>h');
});

test('normalizeAccel: no-modifier combo is just the key', () => {
  assert.equal(normalizeAccel('F5'), 'f5');
});

test('normalizeAccel: empty stays empty (no throw)', () => {
  assert.equal(normalizeAccel(''), '');
});

test('schemaDefaultValue: unwraps a GLib.Variant-like default', () => {
  const settings = { get_default_value: () => ({ deep_unpack: () => '<Super>h' }) };
  assert.equal(schemaDefaultValue(settings, 'x'), '<Super>h');
});

test('schemaDefaultValue: null default -> null', () => {
  assert.equal(schemaDefaultValue({ get_default_value: () => null }, 'x'), null);
});

test('schemaDefaultValue: throwing settings -> null (no throw)', () => {
  const settings = { get_default_value: () => { throw new Error('nope'); } };
  assert.equal(schemaDefaultValue(settings, 'x'), null);
});
