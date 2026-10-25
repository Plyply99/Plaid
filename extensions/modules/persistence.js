// Per-workspace layout/ratio persistence (across logins) — serializes the live
// layout and ratio maps to the settings keys, and reloads them at startup.
// Keyed by workspace INDEX (never by workspace object).
//
// Methods are attached to TilingWMExtension.prototype in extension.js.

import GLib from 'gi://GLib';

export function _scheduleSaveLayouts() {
    // Trailing (quiet-period) debounce: every change RESETS the timer, so
    // exactly one write lands 10s after interaction stops. A fixed-from-
    // first-event window would hammer dconf during sustained resizing.
    if (!this._settings) return;
    const now = Date.now();
    if (!this._saveDirtySince) this._saveDirtySince = now;
    // Starvation cap: under back-to-back activity the quiet timer keeps
    // getting reset — force a save once we've been continuously dirty
    // for 60s, so a crash loses at most ~60s of layout changes.
    // (disable() flushes synchronously regardless.)
    if (now - this._saveDirtySince >= 60000) {
        if (this._workspaceLayoutsSaveId) {
            GLib.source_remove(this._workspaceLayoutsSaveId);
            this._workspaceLayoutsSaveId = 0;
        }
        this._saveDirtySince = 0;
        this._savePersistedLayouts();
        return;
    }
    if (this._workspaceLayoutsSaveId)
        GLib.source_remove(this._workspaceLayoutsSaveId);
    this._workspaceLayoutsSaveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
        this._workspaceLayoutsSaveId = 0;
        if (!this._settings) return GLib.SOURCE_REMOVE;
        this._saveDirtySince = 0;
        this._savePersistedLayouts();
        return GLib.SOURCE_REMOVE;
    });
}

export function _savePersistedLayouts() {
    try {
        const layouts = [];
        const masterRatios = [];
        const stackRatios = [];
        const dwindleRaw = new Map(this._persistedDwindleRaw || []);
        const n = global.workspace_manager.get_n_workspaces();
        for (let i = 1; i < n; i++) {
            const ws = global.workspace_manager.get_workspace_by_index(i);
            if (!ws) continue;
            // "The layout last used is the persistent one" — store the
            // effective layout of every real workspace (the parking ws at
            // index 0 is never stored).
            layouts.push(`${i}:${this._getWorkspaceLayout(ws)}`);
            const mr = this._masterRatios.get(i);
            if (mr !== undefined)
                masterRatios.push(`${i}:${mr}`);
            const sr = this._stackRatios.get(i);
            if (sr && sr.size > 0) {
                const idx = [];
                for (const [k, v] of sr)
                    idx.push(`${k}:${v}`);
                stackRatios.push(`${i}:${idx.join(',')}`);
            }
            // Dwindle trees are in-memory only — serialize the shape+ratios
            // (no window refs) so resized arrangements survive logins.
            //
            // MERGE, don't rebuild: a full rewrite would drop every workspace
            // with no live tree at save time (at boot the first save deletes a
            // not-yet-opened workspace's shape). Mid-session churn is worse —
            // a collapsed single-leaf tree would overwrite a good shape. So
            // only a live 2+-window tree may overwrite an entry; no tree /
            // leaf / empty PRESERVES the previously-saved shape.
            const tree = this._bspTrees.get(ws);
            if (tree && tree.type === 'split' &&
                this._getWorkspaceLayout(ws) === 'dwindle')
                dwindleRaw.set(i, this._dwindleShapeToString(tree));
        }
        this._settings.set_strv('workspace-layouts', layouts);
        this._settings.set_strv('workspace-master-ratios', masterRatios);
        this._settings.set_strv('workspace-stack-ratios', stackRatios);
        // Write merged dwindle shapes: filter out non-split leftovers, keep
        // entries for workspaces beyond the current count, and re-sync the raw
        // map to exactly what we wrote.
        const dwindleTrees = [];
        for (const [i, shape] of dwindleRaw) {
            const node = this._dwindleShapeFromString(shape);
            if (node && node.type === 'split')
                dwindleTrees.push(`${i}:${shape}`);
        }
        dwindleTrees.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
        this._settings.set_strv('workspace-dwindle-trees', dwindleTrees);
        this._persistedDwindleRaw = new Map(
            dwindleTrees.map(e => [parseInt(e, 10), e.substring(e.indexOf(':') + 1)]));
        this._debugLog(`persisted layouts: ${layouts.length} ws, ${masterRatios.length} master, ${stackRatios.length} stack, ${dwindleTrees.length} dwindle`);
    } catch (e) {
        log(`[plaid] persist layouts failed: ${e.message}`);
    }
}

export function _loadPersistedLayoutRules() {
    // Persisted layouts/ratios are RULES keyed by workspace slot (index):
    // "whatever workspace occupies slot N uses layout Y". Parsed once at enable
    // and read by the getters at use time — no binding to workspace objects
    // (which churn during login restores). Rules for slots beyond the current
    // workspace count persist and apply when those slots spawn.
    this._persistedLayoutByIndex = new Map();
    this._persistedMasterByIndex = new Map();
    this._persistedStackByIndex = new Map();
    this._persistedDwindleByIndex = this._parsePersistedDwindleShapes();
    try {
        const layouts = this._settings.get_strv('workspace-layouts') || [];
        for (const entry of layouts) {
            const [idxStr, layout] = entry.split(':');
            const idx = parseInt(idxStr, 10);
            if (idx <= 0 || !Number.isInteger(idx)) continue;
            if (!['dwindle', 'master-stack', 'centered-master-stack', 'floating'].includes(layout)) continue;
            this._persistedLayoutByIndex.set(idx, layout);
        }
        const masterEntries = this._settings.get_strv('workspace-master-ratios') || [];
        for (const entry of masterEntries) {
            const [idxStr, ratioStr] = entry.split(':');
            const idx = parseInt(idxStr, 10);
            const ratio = parseFloat(ratioStr);
            if (idx <= 0 || !Number.isInteger(idx) || !Number.isFinite(ratio)) continue;
            if (ratio < 0.05 || ratio > 0.95) continue;
            this._persistedMasterByIndex.set(idx, ratio);
        }
        const stackEntries = this._settings.get_strv('workspace-stack-ratios') || [];
        for (const entry of stackEntries) {
            const [idxStr, weightsStr] = entry.split(':');
            const idx = parseInt(idxStr, 10);
            if (idx <= 0 || !Number.isInteger(idx)) continue;
            const map = new Map();
            for (const part of (weightsStr || '').split(',')) {
                const [kStr, vStr] = part.split(':');
                const k = parseInt(kStr, 10);
                const v = parseFloat(vStr);
                if (k >= 0 && Number.isFinite(v) && v > 0)
                    map.set(k, v);
            }
            if (map.size > 0)
                this._persistedStackByIndex.set(idx, map);
        }
        this._debugLog(`persisted rules: ${this._persistedLayoutByIndex.size} layouts, ` +
            `${this._persistedMasterByIndex.size} master, ${this._persistedStackByIndex.size} stack, ` +
            `${this._persistedDwindleByIndex.size} dwindle`);
    } catch (e) {
        log(`[plaid] load persisted layout rules failed: ${e.message}`);
    }
}

export function _parsePersistedDwindleShapes() {
    // "index:shape" slot rules, same keying as workspace-layouts: the shape
    // carries only structure + ratios (no window refs) — leaves are
    // placeholders, matched to live windows by position at reconcile time. Raw
    // strings are kept alongside (in _persistedDwindleRaw) so saves MERGE
    // rather than rebuild — see _savePersistedLayouts.
    const map = new Map();
    const raw = new Map();
    try {
        for (const entry of (this._settings.get_strv('workspace-dwindle-trees') || [])) {
            const sep = entry.indexOf(':');
            if (sep <= 0) continue;
            const idx = parseInt(entry.substring(0, sep), 10);
            if (idx <= 0 || !Number.isInteger(idx)) continue;
            const shapeStr = entry.substring(sep + 1);
            const shape = this._dwindleShapeFromString(shapeStr);
            if (shape) {
                map.set(idx, shape);
                raw.set(idx, shapeStr);
            }
        }
    } catch (e) {
        log(`[plaid] parse dwindle shapes failed: ${e.message}`);
    }
    this._persistedDwindleRaw = raw;
    return map;
}

export const persistenceMethods = {
    _scheduleSaveLayouts,
    _savePersistedLayouts,
    _loadPersistedLayoutRules,
    _parsePersistedDwindleShapes,
};
