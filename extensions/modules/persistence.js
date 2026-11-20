// Per-workspace layout/ratio persistence (across logins) — serializes the live
// layout and ratio maps to the settings keys, and reloads them at startup.
// Keyed by workspace INDEX (never by workspace object).
//
// Methods live on this subsystem class.

import GLib from 'gi://GLib';

import { decodeMonitorEntry, encodeMonitorEntry, persistableConnector } from './monitors.js';


export class Persistence {
    constructor(core) {
        this.core = core;
    }

    scheduleSaveLayouts() {
        // Trailing (quiet-period) debounce: every change RESETS the timer, so
        // exactly one write lands 10s after interaction stops. A fixed-from-
        // first-event window would hammer dconf during sustained resizing.
        if (!this.core._settings || this.core._shuttingDown) return;
        const now = Date.now();
        if (!this.core._saveDirtySince) this.core._saveDirtySince = now;
        // Starvation cap: under back-to-back activity the quiet timer keeps
        // getting reset — force a save once we've been continuously dirty
        // for 60s, so a crash loses at most ~60s of layout changes.
        // (disable() flushes synchronously regardless.)
        if (now - this.core._saveDirtySince >= 60000) {
            if (this.core._workspaceLayoutsSaveId) {
                GLib.source_remove(this.core._workspaceLayoutsSaveId);
                this.core._workspaceLayoutsSaveId = 0;
            }
            this.core._saveDirtySince = 0;
            this.savePersistedLayouts();
            return;
        }
        if (this.core._workspaceLayoutsSaveId)
            GLib.source_remove(this.core._workspaceLayoutsSaveId);
        this.core._workspaceLayoutsSaveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
            this.core._workspaceLayoutsSaveId = 0;
            if (!this.core._settings || this.core._shuttingDown) return GLib.SOURCE_REMOVE;
            this.core._saveDirtySince = 0;
            this.savePersistedLayouts();
            return GLib.SOURCE_REMOVE;
        });
    }

    savePersistedLayouts() {
        const primaryConnector = this.core._keyedPrimary || this.core.monitors.primaryConnector();
        const primaryConnected = !primaryConnector ||
            this.core.monitors.monitorForConnector(primaryConnector) >= 0;
        const bareLayouts = [];
        const bareMaster = [];
        const bareStack = [];
        const dwindleRaw = new Map(this.core._persistedDwindleRaw || []);
        const n = global.workspace_manager.get_n_workspaces();

        // Bare keys belong to the keyed primary. While that connector is
        // absent, leave them untouched: they are its arrangement, waiting for
        // it to come back.
        if (primaryConnected) {
            for (let i = 1; i < n; i++) {
                const ws = global.workspace_manager.get_workspace_by_index(i);
                if (!ws) continue;
                bareLayouts.push(`${i}:${this.core.windows.getWorkspaceLayout(ws)}`);
                const mr = this.core._masterRatios.get(i);
                if (mr !== undefined)
                    bareMaster.push(`${i}:${mr}`);
                const sr = this.core._stackRatios.get(i);
                if (sr && sr.size > 0) {
                    const idx = [];
                    for (const [k, v] of sr)
                        idx.push(`${k}:${v}`);
                    bareStack.push(`${i}:${idx.join(',')}`);
                }
                const group = this.core.monitors.groupObj(ws, this.core.monitors.primaryMonitorIndex());
                const tree = this.core._bspTrees.get(group);
                if (tree && tree.type === 'split' &&
                    this.core.windows.getWorkspaceLayout(ws) === 'dwindle')
                    dwindleRaw.set(i, this.core.bsp.dwindleShapeToString(tree));
            }
        }

        // Connector groups: live state first, then saved rules for slots that
        // are not currently open.
        const layoutEntries = new Map();
        for (const [key, layout] of this.core._persistedLayoutByIndex || [])
            if (typeof key === 'string') layoutEntries.set(key, `${parseInt(key, 10)}:${layout}`);
        for (const [key, layout] of this.core._workspaceLayouts || [])
            if (typeof key === 'string') layoutEntries.set(key, `${parseInt(key, 10)}:${layout}`);

        const masterEntries = new Map();
        for (const [key, ratio] of this.core._persistedMasterByIndex || [])
            if (typeof key === 'string') masterEntries.set(key, `${parseInt(key, 10)}:${ratio}`);
        for (const [key, ratio] of this.core._masterRatios || [])
            if (typeof key === 'string') masterEntries.set(key, `${parseInt(key, 10)}:${ratio}`);

        const stackEntries = new Map();
        const addStack = (key, map) => {
            const parts = [];
            for (const [k, v] of map || []) parts.push(`${k}:${v}`);
            if (parts.length) stackEntries.set(key, `${parseInt(key, 10)}:${parts.join(',')}`);
        };
        for (const [key, map] of this.core._persistedStackByIndex || [])
            if (typeof key === 'string') addStack(key, map);
        for (const [key, map] of this.core._stackRatios || [])
            if (typeof key === 'string') addStack(key, map);

        for (const [ws, byConnector] of this.core._groupObjs || []) {
            const wsIndex = this.core.geometry.wsIndex(ws);
            for (const [connector, group] of byConnector) {
                const tree = this.core._bspTrees.get(group);
                if (!tree || tree.type !== 'split') continue;
                const mon = this.core.monitors.monitorForConnector(connector);
                if (mon >= 0 &&
                    this.core.windows.getWorkspaceLayout(ws, mon) !== 'dwindle') continue;
                dwindleRaw.set(`${wsIndex}@${connector}`,
                    this.core.bsp.dwindleShapeToString(tree));
            }
        }

        if (primaryConnected) {
            this.core._settings.set_strv('workspace-layouts', bareLayouts);
            this.core._settings.set_strv('workspace-master-ratios', bareMaster);
            this.core._settings.set_strv('workspace-stack-ratios', bareStack);
        }

        const bareDwindle = [];
        const monitorDwindle = new Map();
        for (const [key, shape] of dwindleRaw) {
            const node = this.core.bsp.dwindleShapeFromString(shape);
            if (!node || node.type !== 'split') continue;
            if (typeof key === 'number')
                bareDwindle.push(`${key}:${shape}`);
            else
                monitorDwindle.set(key, `${parseInt(key, 10)}:${shape}`);
        }
        if (primaryConnected) {
            bareDwindle.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
            this.core._settings.set_strv('workspace-dwindle-trees', bareDwindle);
        }

        const fixedLayouts = new Map();
        for (const [key, value] of this.core._persistedLayoutByIndex || [])
            if (typeof key === 'string' && key.startsWith('m@')) fixedLayouts.set(key.substring(2), value);
        for (const [key, value] of this.core._workspaceLayouts || [])
            if (typeof key === 'string' && key.startsWith('m@')) fixedLayouts.set(key.substring(2), value);

        const fixedMaster = new Map();
        for (const [key, value] of this.core._persistedMasterByIndex || [])
            if (typeof key === 'string' && key.startsWith('m@')) fixedMaster.set(key.substring(2), String(value));
        for (const [key, value] of this.core._masterRatios || [])
            if (typeof key === 'string' && key.startsWith('m@')) fixedMaster.set(key.substring(2), String(value));

        const fixedStack = new Map();
        const addFixedStack = (key, map) => {
            const parts = [];
            for (const [k, v] of map || []) parts.push(`${k}:${v}`);
            if (parts.length) fixedStack.set(key.substring(2), parts.join(','));
        };
        for (const [key, map] of this.core._persistedStackByIndex || [])
            if (typeof key === 'string' && key.startsWith('m@')) addFixedStack(key, map);
        for (const [key, map] of this.core._stackRatios || [])
            if (typeof key === 'string' && key.startsWith('m@')) addFixedStack(key, map);

        const fixedDwindle = new Map();
        for (const [key, shape] of dwindleRaw)
            if (typeof key === 'string' && key.startsWith('m@')) fixedDwindle.set(key.substring(2), shape);
        for (const [connector, group] of this.core._fixedGroupObjs || []) {
            const tree = this.core._bspTrees.get(group);
            if (!tree || tree.type !== 'split') continue;
            fixedDwindle.set(connector, this.core.bsp.dwindleShapeToString(tree));
        }

        this.saveMonitorEntries('monitor-workspace-layouts', layoutEntries);
        this.saveMonitorEntries('monitor-workspace-master-ratios', masterEntries);
        this.saveMonitorEntries('monitor-workspace-stack-ratios', stackEntries);
        this.saveMonitorEntries('monitor-workspace-dwindle-trees', monitorDwindle);
        this.saveFixedEntries('monitor-fixed-layouts', fixedLayouts);
        this.saveFixedEntries('monitor-fixed-master-ratios', fixedMaster);
        this.saveFixedEntries('monitor-fixed-stack-ratios', fixedStack);
        this.saveFixedEntries('monitor-fixed-dwindle-trees', fixedDwindle);

        const keyedPrimary = this.core._keyedPrimary || this.core.monitors.primaryConnector();
        this.core._settings.set_string('monitor-primary-connector',
            persistableConnector(keyedPrimary) || '');

        // Re-sync the raw dwindle map to exactly what was written.
        const raw = new Map();
        for (const entry of bareDwindle) {
            const sep = entry.indexOf(':');
            raw.set(parseInt(entry.substring(0, sep), 10), entry.substring(sep + 1));
        }
        for (const [key, rest] of monitorDwindle) {
            const sep = rest.indexOf(':');
            raw.set(key, rest.substring(sep + 1));
        }
        for (const [connector, shape] of fixedDwindle)
            raw.set(`m@${connector}`, shape);
        this.core._persistedDwindleRaw = raw;

        this.core.debugLog(`persisted layouts: ${bareLayouts.length} ws, ${bareMaster.length} master, ` +
            `${bareStack.length} stack, ${bareDwindle.length} dwindle, ` +
            `${layoutEntries.size} monitor layouts, ${monitorDwindle.size} monitor dwindle`);
    }

    // Write CONNECTOR:ENTRY rules. Entries for monitors that are not currently
    // connected are preserved: unplugging must not erase their arrangement.
    saveMonitorEntries(settingKey, entries) {
        const connected = new Set(this.core.monitors.connectors().filter(Boolean));
        const merged = new Map();
        for (const raw of this.core._settings.get_strv(settingKey) || []) {
            const decoded = decodeMonitorEntry(raw);
            if (!decoded || connected.has(decoded.connector)) continue;
            const idx = parseInt(decoded.value, 10);
            if (!Number.isInteger(idx)) continue;
            merged.set(`${idx}@${decoded.connector}`, decoded.value);
        }
        for (const [key, value] of entries) merged.set(key, value);
        const out = [];
        for (const [key, value] of merged) {
            const at = key.indexOf('@');
            if (at <= 0) continue;
            const encoded = encodeMonitorEntry(key.substring(at + 1), value);
            if (encoded) out.push(encoded);
        }
        this.core._settings.set_strv(settingKey, out);
    }

    // Fixed-mode entries are CONNECTOR:VALUE (no workspace index). Preserve
    // entries for monitors that are not currently connected.
    saveFixedEntries(settingKey, entries) {
        const connected = new Set(this.core.monitors.connectors().filter(Boolean));
        const merged = new Map();
        for (const raw of this.core._settings.get_strv(settingKey) || []) {
            const decoded = decodeMonitorEntry(raw);
            if (!decoded || connected.has(decoded.connector)) continue;
            merged.set(decoded.connector, decoded.value);
        }
        for (const [connector, value] of entries) merged.set(connector, value);
        const out = [];
        for (const [connector, value] of merged) {
            const encoded = encodeMonitorEntry(connector, value);
            if (encoded) out.push(encoded);
        }
        this.core._settings.set_strv(settingKey, out);
    }

    loadPersistedLayoutRules() {
        // Persisted layouts/ratios are RULES keyed by workspace slot (index):
        // "whatever workspace occupies slot N uses layout Y". Parsed once at enable
        // and read by the getters at use time — no binding to workspace objects
        // (which churn during login restores). Rules for slots beyond the current
        // workspace count persist and apply when those slots spawn.
        this.core._persistedLayoutByIndex = new Map();
        this.core._persistedMasterByIndex = new Map();
        this.core._persistedStackByIndex = new Map();
        this.core._persistedDwindleByIndex = this.parsePersistedDwindleShapes();
        this.core._keyedPrimary = this.core._settings.get_string('monitor-primary-connector') || '';
        const layouts = this.core._settings.get_strv('workspace-layouts') || [];
        for (const entry of layouts) {
            const [idxStr, layout] = entry.split(':');
            const idx = parseInt(idxStr, 10);
            if (idx <= 0 || !Number.isInteger(idx)) continue;
            if (!['dwindle', 'master-stack', 'centered-master-stack', 'floating'].includes(layout)) continue;
            this.core._persistedLayoutByIndex.set(idx, layout);
        }
        const masterEntries = this.core._settings.get_strv('workspace-master-ratios') || [];
        for (const entry of masterEntries) {
            const [idxStr, ratioStr] = entry.split(':');
            const idx = parseInt(idxStr, 10);
            const ratio = parseFloat(ratioStr);
            if (idx <= 0 || !Number.isInteger(idx) || !Number.isFinite(ratio)) continue;
            if (ratio < 0.05 || ratio > 0.95) continue;
            this.core._persistedMasterByIndex.set(idx, ratio);
        }
        const stackEntries = this.core._settings.get_strv('workspace-stack-ratios') || [];
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
                this.core._persistedStackByIndex.set(idx, map);
        }
        this.loadMonitorRules();
        this.core.debugLog(`persisted rules: ${this.core._persistedLayoutByIndex.size} layouts, ` +
            `${this.core._persistedMasterByIndex.size} master, ${this.core._persistedStackByIndex.size} stack, ` +
            `${this.core._persistedDwindleByIndex.size} dwindle`);
    }

    // CONNECTOR:INDEX:VALUE rules for monitors that do not own the bare keys.
    loadMonitorRules() {
        const validLayouts = ['dwindle', 'master-stack', 'centered-master-stack', 'floating'];
        const each = (key, fn) => {
            for (const raw of this.core._settings.get_strv(key) || []) {
                const decoded = decodeMonitorEntry(raw);
                if (decoded) fn(decoded.connector, decoded.value);
            }
        };
        each('monitor-fixed-layouts', (connector, value) => {
            if (!validLayouts.includes(value)) return;
            this.core._persistedLayoutByIndex.set(`m@${connector}`, value);
        });
        each('monitor-fixed-master-ratios', (connector, value) => {
            const ratio = parseFloat(value);
            if (!Number.isFinite(ratio) || ratio < 0.05 || ratio > 0.95) return;
            this.core._persistedMasterByIndex.set(`m@${connector}`, ratio);
        });
        each('monitor-fixed-stack-ratios', (connector, value) => {
            const map = new Map();
            for (const part of value.split(',')) {
                const [kStr, vStr] = part.split(':');
                const k = parseInt(kStr, 10);
                const v = parseFloat(vStr);
                if (k >= 0 && Number.isFinite(v) && v > 0) map.set(k, v);
            }
            if (map.size > 0)
                this.core._persistedStackByIndex.set(`m@${connector}`, map);
        });
        each('monitor-workspace-layouts', (connector, rest) => {
            const sep = rest.indexOf(':');
            if (sep <= 0) return;
            const idx = parseInt(rest.substring(0, sep), 10);
            const layout = rest.substring(sep + 1);
            if (idx <= 0 || !Number.isInteger(idx) || !validLayouts.includes(layout)) return;
            this.core._persistedLayoutByIndex.set(`${idx}@${connector}`, layout);
        });
        each('monitor-workspace-master-ratios', (connector, rest) => {
            const sep = rest.indexOf(':');
            if (sep <= 0) return;
            const idx = parseInt(rest.substring(0, sep), 10);
            const ratio = parseFloat(rest.substring(sep + 1));
            if (idx <= 0 || !Number.isInteger(idx) || !Number.isFinite(ratio)) return;
            if (ratio < 0.05 || ratio > 0.95) return;
            this.core._persistedMasterByIndex.set(`${idx}@${connector}`, ratio);
        });
        each('monitor-workspace-stack-ratios', (connector, rest) => {
            const sep = rest.indexOf(':');
            if (sep <= 0) return;
            const idx = parseInt(rest.substring(0, sep), 10);
            if (idx <= 0 || !Number.isInteger(idx)) return;
            const map = new Map();
            for (const part of rest.substring(sep + 1).split(',')) {
                const [kStr, vStr] = part.split(':');
                const k = parseInt(kStr, 10);
                const v = parseFloat(vStr);
                if (k >= 0 && Number.isFinite(v) && v > 0)
                    map.set(k, v);
            }
            if (map.size > 0)
                this.core._persistedStackByIndex.set(`${idx}@${connector}`, map);
        });
    }

    parsePersistedDwindleShapes() {
        // "index:shape" slot rules, same keying as workspace-layouts: the shape
        // carries only structure + ratios (no window refs) — leaves are
        // placeholders, matched to live windows by position at reconcile time. Raw
        // strings are kept alongside (in _persistedDwindleRaw) so saves MERGE
        // rather than rebuild — see _savePersistedLayouts.
        const map = new Map();
        const raw = new Map();
        for (const entry of (this.core._settings.get_strv('workspace-dwindle-trees') || [])) {
            const sep = entry.indexOf(':');
            if (sep <= 0) continue;
            const idx = parseInt(entry.substring(0, sep), 10);
            if (idx <= 0 || !Number.isInteger(idx)) continue;
            const shapeStr = entry.substring(sep + 1);
            const shape = this.core.bsp.dwindleShapeFromString(shapeStr);
            if (shape) {
                map.set(idx, shape);
                raw.set(idx, shapeStr);
            }
        }
        for (const entry of (this.core._settings.get_strv('monitor-fixed-dwindle-trees') || [])) {
            const decoded = decodeMonitorEntry(entry);
            if (!decoded) continue;
            const shape = this.core.bsp.dwindleShapeFromString(decoded.value);
            if (shape) {
                const key = `m@${decoded.connector}`;
                map.set(key, shape);
                raw.set(key, decoded.value);
            }
        }
        for (const entry of (this.core._settings.get_strv('monitor-workspace-dwindle-trees') || [])) {
            const decoded = decodeMonitorEntry(entry);
            if (!decoded) continue;
            const sep = decoded.value.indexOf(':');
            if (sep <= 0) continue;
            const idx = parseInt(decoded.value.substring(0, sep), 10);
            if (idx <= 0 || !Number.isInteger(idx)) continue;
            const shapeStr = decoded.value.substring(sep + 1);
            const shape = this.core.bsp.dwindleShapeFromString(shapeStr);
            if (shape) {
                const key = `${idx}@${decoded.connector}`;
                map.set(key, shape);
                raw.set(key, shapeStr);
            }
        }
        this.core._persistedDwindleRaw = raw;
        return map;
    }

    destroy() {
        if (this.core._workspaceLayoutsSaveId) {
            GLib.source_remove(this.core._workspaceLayoutsSaveId);
            this.core._workspaceLayoutsSaveId = 0;
        }
        this.savePersistedLayouts();
    }
}
