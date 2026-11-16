// Multi-monitor group keys and connector-prefixed persistence entries.
//
// A group is (workspace index, monitor connector). The keyed primary monitor
// reuses the single-monitor workspace-* keys, so its group key is the bare
// index. Every other monitor uses "<index>@<connector>" in memory and
// "<connector>:<existing-entry>" in the monitor-workspace-* settings.
//
// Connectors come from Mutter (DP-1, HDMI-1, eDP-1). A "#N" index stand-in is
// used only while a connector is unresolved and is NEVER persisted.

import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { PlaidSubsystem } from './subsystem.js';

export function groupKey(index, connector) {
    const idx = parseInt(index, 10);
    if (!Number.isInteger(idx) || idx < 0) return '';
    if (!connector) return String(idx);
    return `${idx}@${connector}`;
}

export function parseGroupKey(key) {
    if (typeof key !== 'string' || key.length === 0) return null;
    const at = key.indexOf('@');
    const idxStr = at === -1 ? key : key.substring(0, at);
    const idx = parseInt(idxStr, 10);
    if (!Number.isInteger(idx) || idx < 0 || String(idx) !== idxStr) return null;
    const connector = at === -1 ? '' : key.substring(at + 1);
    if (at !== -1 && connector.length === 0) return null;
    return { index: idx, connector };
}

export function isFallbackConnector(connector) {
    return typeof connector === 'string' && connector.startsWith('#');
}

// The connector as it may appear in a persisted entry, or '' when it must not
// be written. Entry values may contain every other character, so the connector
// itself may never contain the ':' separator.
export function persistableConnector(connector) {
    if (typeof connector !== 'string') return '';
    const c = connector.trim();
    if (c.length === 0 || c.startsWith('#') || c.includes(':')) return '';
    return c;
}

export function encodeMonitorEntry(connector, value) {
    const c = persistableConnector(connector);
    if (!c || typeof value !== 'string' || value.length === 0) return '';
    return `${c}:${value}`;
}

export function decodeMonitorEntry(entry) {
    if (typeof entry !== 'string') return null;
    const colon = entry.indexOf(':');
    if (colon <= 0) return null;
    const connector = entry.substring(0, colon);
    const value = entry.substring(colon + 1);
    if (!persistableConnector(connector) || value.length === 0) return null;
    return { connector, value };
}

export class Monitors extends PlaidSubsystem {
    manager() {
        return global.backend ? global.backend.get_monitor_manager() : null;
    }

    nMonitors() {
        return global.display.get_n_monitors();
    }

    // Display index -> connector, rebuilt after any monitor change. Logical
    // monitors ARE the display's monitors (a mirrored group is one logical
    // monitor with several physical ones), so index them by get_number().
    connectors() {
        if (this.core._monitorConnCache) return this.core._monitorConnCache;
        const conns = [];
        const mgr = this.manager();
        if (mgr) {
            for (const lm of mgr.get_logical_monitors()) {
                const conn = lm.get_monitors()[0]?.get_connector();
                if (conn) conns[lm.get_number()] = conn;
            }
        }
        this.core._monitorConnCache = conns;
        if (conns.some(Boolean)) this.syncFallbackConnectors(conns);
        return conns;
    }

    // A window added before the connectors resolved is keyed "#N"; rewrite it
    // to the connector as soon as one is known.
    syncFallbackConnectors(conns) {
        const map = this.core._windowMonitors;
        if (!map) return;
        for (const [win, conn] of map) {
            if (!conn || conn[0] !== '#') continue;
            const mon = parseInt(conn.substring(1), 10);
            const resolved = conns[mon];
            if (resolved) map.set(win, resolved);
        }
    }

    invalidate() {
        this.core._monitorConnCache = null;
    }

    connectorForMonitor(mon) {
        if (!Number.isInteger(mon) || mon < 0) return '';
        return this.connectors()[mon] || '';
    }

    monitorTiled(mon) {
        return this.tiledMonitors().includes(mon);
    }

    // A stable in-memory stand-in while a connector is unresolved. Never
    // persisted (see persistableConnector()).
    connectorOrFallback(mon) {
        return this.connectorForMonitor(mon) || `#${mon}`;
    }

    primaryMonitorIndex() {
        return global.display.get_primary_monitor();
    }

    // The monitor under a point, or -1. Used by drag/drop targeting.
    monitorAt(px, py) {
        const n = this.nMonitors();
        for (let i = 0; i < n; i++) {
            const g = global.display.get_monitor_geometry(i);
            if (g && px >= g.x && px < g.x + g.width && py >= g.y && py < g.y + g.height)
                return i;
        }
        return -1;
    }

    primaryConnector() {
        return this.core._keyedPrimary || this.connectorForMonitor(this.primaryMonitorIndex());
    }

    monitorForConnector(connector) {
        if (typeof connector === 'string') {
            const fallback = /^#(\d+)$/.exec(connector);
            if (fallback) {
                const n = parseInt(fallback[1], 10);
                return n < this.nMonitors() ? n : -1;
            }
        }
        const wanted = persistableConnector(connector);
        if (!wanted) return -1;
        return this.connectors().indexOf(wanted);
    }

    // Monitors that tile their own windows. With mutter's
    // workspaces-only-on-primary the others share the primary workspace, so
    // their windows are not independently tiled.
    tiledMonitors() {
        const n = this.nMonitors();
        if (n === 0) return [];
        const primaryOnly = !!(this.core._mutterSettings &&
            this.core._mutterSettings.get_boolean('workspaces-only-on-primary'));
        const primary = this.primaryMonitorIndex();
        const out = [];
        for (let i = 0; i < n; i++) {
            if (primaryOnly && i !== primary) continue;
            out.push(i);
        }
        return out;
    }

    windowMonitor(win) {
        const map = this.core._windowMonitors;
        const stored = map && win ? map.get(win) : undefined;
        if (stored) return stored;
        if (!win) return '';
        return this.connectorOrFallback(win.get_monitor());
    }

    setWindowMonitor(win, mon) {
        if (!win || !this.core._windowMonitors) return;
        const idx = Number.isInteger(mon) && mon >= 0 ? mon : this.primaryMonitorIndex();
        this.core._windowMonitors.set(win, this.connectorOrFallback(idx));
    }

    // Move a window's tree membership from one monitor group to another.
    regroupWindow(win, ws, fromMon, toMon) {
        if (!win || !ws) return;
        const from = this.groupObj(ws, fromMon);
        const to = this.groupObj(ws, toMon);
        if (from === to) return;
        const tree = this.core.bsp.bspGetTree(from);
        if (tree) this.core._bspTrees.set(from, this.core.bsp.bspRemove(tree, win));
        // The destination's leaf signature changes; drop it so the next retile
        // reads the rebuilt set instead of restoring a stale shape.
        if (this.core._dwindleLeafSigs) this.core._dwindleLeafSigs.delete(to);
        if (this.monitorTiled(toMon) &&
            this.core.windows.getWorkspaceLayout(ws, toMon) === 'dwindle')
            this.core.bsp.bspInsertForWorkspace(ws, win, toMon);
    }

    onWindowEnteredMonitor(win, mon) {
        if (!win || !this.core._windowMonitors) return;
        if (!this.core._windowWorkspaces.has(win)) {
            this.setWindowMonitor(win, mon);
            return;
        }
        const prevConn = this.core._windowMonitors.get(win);
        this.setWindowMonitor(win, mon);
        // A drag keeps its group until grab end; grab.js regroups then.
        if (this.core._grabOp) return;
        if (prevConn === undefined) return;
        const prevMon = this.monitorForConnector(prevConn);
        if (prevMon === mon) return;
        const ws = win.get_workspace();
        if (!ws) return;
        this.regroupWindow(win, ws, prevMon, mon);
        this.core.layouts.retileWorkspace(ws);
    }

    getWindowsForGroup(ws, mon) {
        const connector = this.connectorOrFallback(mon);
        return this.core.windows.getWindowsForWorkspace(ws)
            .filter(w => this.windowMonitor(w) === connector);
    }

    groupObjFor(ws, connector) {
        if (!ws || !this.core._groupObjs) return ws;
        let byConnector = this.core._groupObjs.get(ws);
        if (!byConnector) {
            byConnector = new Map();
            this.core._groupObjs.set(ws, byConnector);
        }
        let group = byConnector.get(connector);
        if (!group) {
            group = {
                plaidGroup: true,
                workspace: ws,
                connector,
                monitor: this.monitorForConnector(connector),
                key: `${this.core.geometry.wsIndex(ws)}@${connector}`,
            };
            byConnector.set(connector, group);
        }
        return group;
    }

    groupObj(ws, mon) {
        if (!ws) return null;
        if (this.isKeyedPrimary(mon)) return ws;
        return this.groupObjFor(ws, this.connectorOrFallback(mon));
    }

    // True when this monitor's group owns the bare workspace index (the
    // pre-multi-monitor keys). An unresolved primary connector counts as the
    // keyed primary; an unresolved secondary does not.
    isKeyedPrimary(mon) {
        if (mon === undefined || mon === null) return true;
        const keyed = this.primaryConnector();
        if (!keyed) return mon === this.primaryMonitorIndex();
        return this.connectorForMonitor(mon) === keyed;
    }

    // The group key for a workspace on a monitor: the keyed primary keeps the
    // bare index (the pre-multi-monitor keys), every other monitor appends its
    // connector.
    groupKeyFor(wsIndex, mon) {
        const idx = parseInt(wsIndex, 10);
        if (this.isKeyedPrimary(mon)) return idx;
        return groupKey(idx, this.connectorOrFallback(mon));
    }

    // Move per-index map state from one keyed primary to the new one:
    // bare index <-> "index@connector", other connectors untouched.
    rekeyMap(map, oldConn, newConn) {
        if (!map || !oldConn || !newConn || oldConn === newConn) return;
        const moved = new Map();
        for (const [key, value] of map) {
            if (typeof key === 'string' && !key.endsWith(`@${newConn}`))
                moved.set(key, value);
        }
        for (const [key, value] of map) {
            if (typeof key === 'number')
                moved.set(`${key}@${oldConn}`, value);
        }
        for (const [key, value] of map) {
            if (typeof key === 'string' && key.endsWith(`@${newConn}`))
                moved.set(parseInt(key, 10), value);
        }
        map.clear();
        for (const [key, value] of moved) map.set(key, value);
    }

    // The runtime primary changed: the new primary takes the bare keys, the
    // old one keeps its arrangement under its connector.
    syncKeyedPrimary(newConn) {
        const oldConn = this.core._keyedPrimary;
        if (!newConn || newConn === oldConn) return;
        this.core._keyedPrimary = newConn;
        if (!oldConn) return;
        for (const map of [
            this.core._workspaceLayouts,
            this.core._masterRatios,
            this.core._stackRatios,
            this.core._persistedLayoutByIndex,
            this.core._persistedMasterByIndex,
            this.core._persistedStackByIndex,
            this.core._persistedDwindleByIndex,
            this.core._persistedDwindleRaw,
        ]) {
            this.rekeyMap(map, oldConn, newConn);
        }
        const moveTree = (map) => {
            if (!map) return;
            for (const [key, value] of [...map]) {
                if (!key) continue;
                if (key.plaidGroup) {
                    if (key.connector !== newConn) continue;
                    map.delete(key);
                    map.set(key.workspace, value);
                    const byConnector = this.core._groupObjs?.get(key.workspace);
                    if (byConnector) byConnector.delete(newConn);
                } else {
                    map.delete(key);
                    map.set(this.groupObjFor(key, oldConn), value);
                }
            }
        };
        moveTree(this.core._bspTrees);
        moveTree(this.core._dwindleLeafSigs);
        this.core.persistence.scheduleSaveLayouts();
        this.core.layouts.retileAll();
        this.core.debugLog(`primary monitor: ${oldConn} -> ${newConn} (keys rekeyed)`);
    }

    connectSignals() {
        const mgr = this.manager();
        if (mgr) {
            this.connectObject(mgr, 'monitors-changed-internal',
                () => this.onMonitorsChanged());
        }
        this.connectObject(global.display, 'window-entered-monitor',
            (_display, mon, win) => this.onWindowEnteredMonitor(win, mon));
        if (this.core._mutterSettings) {
            this.connectObject(this.core._mutterSettings,
                'changed::workspaces-only-on-primary', () => {
                    this.invalidate();
                    // Toggling the setting changes which monitors tile: apply
                    // it now instead of waiting for the next layout event.
                    this.core.layouts.retileAll();
                });
        }
        this.scheduleWorkspacesPrompt(4000);
    }

    // 'skip'  - nothing to do (one monitor, or already offered)
    // 'mark'  - multiple monitors but workspaces already span displays
    // 'ask'   - multiple monitors and workspaces are primary-only
    workspacesPromptAction() {
        if (!this.core._settings) return 'skip';
        if (this.nMonitors() <= 1) return 'skip';
        if (this.core._settings.get_boolean('monitor-workspaces-prompted')) return 'skip';
        const primaryOnly = !!(this.core._mutterSettings &&
            this.core._mutterSettings.get_boolean('workspaces-only-on-primary'));
        return primaryOnly ? 'ask' : 'mark';
    }

    scheduleWorkspacesPrompt(delay = 3000) {
        if (!this.core._settings || this.core._wsPromptCheckId) return;
        this.core._wsPromptCheckId = this.core.signals.addTimeout(delay, () => {
            this.core._wsPromptCheckId = 0;
            this.runWorkspacesPromptCheck();
            return GLib.SOURCE_REMOVE;
        });
    }

    runWorkspacesPromptCheck() {
        const action = this.workspacesPromptAction();
        if (action === 'skip') return;
        // The prompt would sit behind the lock screen; retry for a while and
        // leave the marker unset so a later login can still offer it.
        if (Main.sessionMode.isLocked) {
            if (this.core._wsPromptRetries < 10) {
                this.core._wsPromptRetries++;
                this.scheduleWorkspacesPrompt(3000);
            }
            return;
        }
        this.core._wsPromptRetries = 0;
        // One time only: mark it as offered before showing the dialog.
        this.core._settings.set_boolean('monitor-workspaces-prompted', true);
        if (action === 'mark') return;
        this.core.actions.showWorkspacesOnAllDisplaysPrompt();
    }

    onMonitorsChanged() {
        this.invalidate();
        this.scheduleWorkspacesPrompt();
        let moved = false;
        const map = this.core._windowMonitors;
        if (map) {
            for (const win of [...map.keys()]) {
                if (!win.get_compositor_private()) continue;
                const mon = win.get_monitor();
                if (!Number.isInteger(mon) || mon < 0) continue;
                const prev = map.get(win);
                const next = this.connectorOrFallback(mon);
                if (prev === next) continue;
                map.set(win, next);
                const prevMon = this.monitorForConnector(prev);
                const ws = win.get_workspace();
                if (ws && prevMon !== mon) {
                    this.regroupWindow(win, ws, prevMon, mon);
                    moved = true;
                }
            }
        }
        const livePrimary = this.connectorForMonitor(this.primaryMonitorIndex());
        if (livePrimary) {
            if (!this.core._keyedPrimary)
                this.core._keyedPrimary = livePrimary;
            else if (livePrimary !== this.core._keyedPrimary)
                this.syncKeyedPrimary(livePrimary);
        }
        if (moved && livePrimary === this.core._keyedPrimary)
            this.core.layouts.retileAll();
    }

    destroy() {
        if (this.core._wsPromptCheckId) {
            GLib.source_remove(this.core._wsPromptCheckId);
            this.core.signals.untrackSource(this.core._wsPromptCheckId);
            this.core._wsPromptCheckId = 0;
        }
        super.destroy();
    }
}
