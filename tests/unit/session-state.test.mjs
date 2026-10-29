import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSelf } from '../helpers.mjs';
import { sessionState } from '../../extensions/modules/session-state.js';

const stash = () => ({
    bspTrees: new Map(),
    workspaceLayouts: new Map(),
    masterRatios: new Map(),
    stackRatios: new Map(),
    workspaceOrders: new Map(),
    windowWorkspaces: new Map(),
    windowWSIndices: new Map(),
    lastFocusedPerWorkspace: new Map(),
    lastRealFocusedWindow: null,
    scratchpadWindows: new Map(),
    toggleFloatWindows: new Set(),
    scratchpadVisible: false,
    observedMinSizes: new Map(),
});

test('session state survives a new PlaidCore instance', () => {
    const s = stash();
    sessionState.enabledThisShell = true;
    sessionState.stashedTiling = s;

    const core = makeSelf();

    assert.equal(sessionState.enabledThisShell, true);
    assert.equal(sessionState.stashedTiling, s);

    core.restoreTilingState();

    assert.equal(sessionState.stashedTiling, null);
    assert.equal(core._bspTrees, s.bspTrees);
    assert.equal(core._windowWorkspaces, s.windowWorkspaces);
});

test('a fresh core does not clear the shell-wide enable flag', () => {
    sessionState.enabledThisShell = true;
    sessionState.stashedTiling = null;
    makeSelf();
    assert.equal(sessionState.enabledThisShell, true);
    sessionState.enabledThisShell = false;
});
