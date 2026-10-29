import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAccel, normalizeTypedAccel } from '../../extensions/modules/helpers.js';

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

test('normalizeAccel: Mutter Above_Tab aliases the US grave key', () => {
  assert.equal(normalizeAccel('<Super><Shift>Above_Tab'),
    normalizeAccel('<Super><Shift>grave'));
  assert.equal(normalizeAccel('<Super><Shift>above_tab'), '<shift><super>grave');
});

test('normalizeTypedAccel: accepts Mutter Above_Tab from the shortcut box', () => {
  assert.equal(normalizeTypedAccel('<Super><Shift>above_tab'), '<Super><Shift>grave');
  assert.equal(normalizeTypedAccel('<Super><Shift>Above_Tab'), '<Super><Shift>grave');
  assert.equal(normalizeTypedAccel('<Super><Shift>BackSpace'), '<Super><Shift>BackSpace');
});
