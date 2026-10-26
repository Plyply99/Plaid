import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAccel } from '../../extensions/modules/helpers.js';

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
