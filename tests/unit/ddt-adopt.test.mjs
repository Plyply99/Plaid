import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf, fakeWin } from '../helpers.mjs';

function withGlobal(value, fn) {
    const old = globalThis.global;
    globalThis.global = value;
    try {
        return fn();
    } finally {
        globalThis.global = old;
    }
}

test('adoptExistingDropdown: adopts a matching surviving DDT window', () => {
    const win = fakeWin();
    win._plaidDdt = true;
    win._plaidDdtCommand = 'ghostty';
    const ws = { list_windows: () => [win] };
    const wm = { get_n_workspaces: () => 1, get_workspace_by_index: () => ws };
    const core = makeSelf({ 'dropdown-terminal-command': 'ghostty' });

    withGlobal({ workspace_manager: wm, get_current_time: () => 0 }, () => {
        core.dropdown.adoptExistingDropdown();
    });

    assert.equal(core.dropdown.core._dropdownWin, win);
});

test('adoptExistingDropdown: closes a window from a different command', () => {
    const win = fakeWin();
    win._plaidDdt = true;
    win._plaidDdtCommand = 'old-terminal';
    let deleted = false;
    win.delete = () => { deleted = true; };
    const ws = { list_windows: () => [win] };
    const wm = { get_n_workspaces: () => 1, get_workspace_by_index: () => ws };
    const core = makeSelf({ 'dropdown-terminal-command': 'ghostty' });

    withGlobal({ workspace_manager: wm, get_current_time: () => 0 }, () => {
        core.dropdown.adoptExistingDropdown();
    });

    assert.equal(deleted, true);
    assert.equal(win._plaidDdt, false);
    assert.equal(core.dropdown.core._dropdownWin, null);
});

test('adoptExistingDropdown: minimizes the adopted terminal', () => {
    const win = fakeWin({ minimized: false });
    win._plaidDdt = true;
    win._plaidDdtCommand = 'ghostty';
    const ws = { list_windows: () => [win] };
    const wm = { get_n_workspaces: () => 1, get_workspace_by_index: () => ws };
    const core = makeSelf({ 'dropdown-terminal-command': 'ghostty' });

    withGlobal({ workspace_manager: wm, get_current_time: () => 0 }, () => {
        core.dropdown.adoptExistingDropdown();
    });

    assert.equal(win.minimized, true);
});

test('shouldManage: never tiles a surviving DDT window', () => {
    const win = fakeWin();
    win._plaidDdt = true;
    const core = makeSelf({});
    assert.equal(core.windows.shouldManage(win), false);
});
