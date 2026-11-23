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
import Meta from 'gi://Meta';

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
        const n = this.nMonitors();
        let full = conns.length >= n;
        for (let i = 0; i < n && full; i++) full = !!conns[i];
        this.core._monitorConnPartial = !full;
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
        const out = [];
        for (let i = 0; i < n; i++) out.push(i);
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
        // A hotplug emits this with transient monitor indices and can arrive
        // BEFORE monitors-changed sets the settling flag. Defer the regroup
        // so the settled pass wins; a normal Move to Monitor still applies a
        // moment later.
        if (this.core._monitorsSettling || this.core._monitorConnPartial) return;
        if (!this.core._windowWorkspaces.has(win)) {
            this.setWindowMonitor(win, mon);
            return;
        }
        if (win._plaidMonitorRegroupId) return;
        win._plaidMonitorRegroupId = this.core.signals.addTimeout(100, () => {
            win._plaidMonitorRegroupId = 0;
            if (!this.core._settings || this.core._shuttingDown) return;
            if (this.core._monitorsSettling || this.core._monitorConnPartial) return;
            if (!this.core._windowWorkspaces.has(win)) return;
            // A drag keeps its group until grab end; grab.js regroups then.
            if (this.core._grabOp) return;
            const prevConn = this.core._windowMonitors.get(win);
            if (prevConn === undefined) return;
            const cur = win.get_monitor();
            const next = this.connectorOrFallback(cur);
            if (prevConn === next) return;
            const prevMon = this.monitorForConnector(prevConn);
            this.core._windowMonitors.set(win, next);
            const ws = win.get_workspace();
            if (!ws) return;
            if (prevMon >= 0)
                this.regroupWindow(win, ws, prevMon, cur);
            else if (this.monitorTiled(cur) &&
                this.core.windows.getWorkspaceLayout(ws, cur) === 'dwindle')
                this.core.bsp.bspInsertForWorkspace(ws, win, cur);
            this.core.layouts.retileWorkspace(ws);
        });
    }

    getWindowsForGroup(ws, mon) {
        const connector = this.connectorOrFallback(mon);
        if (this.fixedModeFor(mon)) {
            // Fixed groups span workspaces: Mutter keeps these windows visible
            // across workspace switches. Prefer the managed set — the
            // per-workspace order can disagree with the live workspace of a
            // sticky secondary window, which made it invisible to focus.
            const seen = new Set();
            const out = [];
            const managed = this.core._windowWorkspaces;
            if (managed && managed.size > 0) {
                for (const win of managed.keys()) {
                    if (seen.has(win) || win.minimized) continue;
                    if (win === this.core._backgroundAppWin) continue;
                    if (win.get_window_type() !== Meta.WindowType.NORMAL) continue;
                    if (win.is_skip_taskbar()) continue;
                    if (this.windowMonitor(win) !== connector) continue;
                    seen.add(win);
                    out.push(win);
                }
                return out;
            }
            const wm = global.workspace_manager;
            if (!wm) return out;
            for (let i = 0; i < wm.get_n_workspaces(); i++) {
                const w = wm.get_workspace_by_index(i);
                if (!w) continue;
                for (const win of this.core.windows.getWindowsForWorkspace(w)) {
                    if (seen.has(win)) continue;
                    seen.add(win);
                    if (this.windowMonitor(win) === connector) out.push(win);
                }
            }
            return out;
        }
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
        if (this.fixedModeFor(mon)) return this.fixedGroupObj(mon);
        if (!ws) return null;
        if (this.isKeyedPrimary(mon)) return ws;
        return this.groupObjFor(ws, this.connectorOrFallback(mon));
    }

    // True when this monitor's group owns the bare workspace index (the
    // pre-multi-monitor keys). An unresolved primary connector counts as the
    // keyed primary; an unresolved secondary does not.
    isKeyedPrimary(mon) {
        if (mon === undefined || mon === null) return true;
        const connector = this.connectorForMonitor(mon);
        // An unresolved connector must not turn the primary into a phantom
        // group during a monitor reconfiguration.
        if (!connector) return mon === this.primaryMonitorIndex();
        const keyed = this.primaryConnector();
        if (!keyed) return false;
        return connector === keyed;
    }

    // Non-primary monitors use one workspace-independent group while GNOME
    // keeps workspaces on the primary display. Mutter shows their windows on
    // every workspace, so a per-workspace arrangement has no meaning there.
    fixedModeFor(mon) {
        if (!this.core._mutterSettings) return false;
        if (!this.core._mutterSettings.get_boolean('workspaces-only-on-primary'))
            return false;
        if (this.nMonitors() <= 1) return false;
        return mon !== this.primaryMonitorIndex();
    }

    fixedKey(mon) {
        return `m@${this.connectorOrFallback(mon)}`;
    }

    fixedGroupObj(mon) {
        const connector = this.connectorOrFallback(mon);
        if (!this.core._fixedGroupObjs) return null;
        let group = this.core._fixedGroupObjs.get(connector);
        if (!group) {
            group = {
                plaidGroup: true,
                fixed: true,
                workspace: null,
                monitor: mon,
                connector,
                key: `m@${connector}`,
            };
            this.core._fixedGroupObjs.set(connector, group);
        }
        return group;
    }

    // The group key for a workspace on a monitor: the keyed primary keeps the
    // bare index (the pre-multi-monitor keys), every other monitor appends its
    // connector.
    groupKeyFor(wsIndex, mon) {
        if (this.fixedModeFor(mon)) return this.fixedKey(mon);
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
            // Fixed-mode keys ("m@CONN") are monitor-scoped, not workspace
            // scoped, and must never take part in a primary rekey.
            if (typeof key === 'string' && key.startsWith('m@') ) {
                moved.set(key, value);
            } else if (typeof key === 'string' && !key.endsWith(`@${newConn}`)) {
                moved.set(key, value);
            }
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
    }

    onMonitorsChanged() {
        // Monitors reconfigure in bursts and index order can change
        // transiently. Coalesce into one settled pass so trees are never
        // rebuilt from a half-applied layout.
        this.invalidate();
        this.core._monitorsSettling = true;
        this.scheduleMonitorsSettled();
    }

    processMonitorsChanged() {
        // Clear the settling flag first: an exception later in this pass must
        // never leave every future retile deferred.
        this.core._monitorsSettling = false;
        this.invalidate();
        this.connectors();
        this.core.debugLog(`monitors: settled pass begin partial=${this.core._monitorConnPartial} ` +
            `retries=${this.core._monitorSettleRetries}`);
        if (this.core._monitorConnPartial && this.core._monitorSettleRetries < 10) {
            this.core._monitorSettleRetries++;
            this.scheduleMonitorsSettled();
            return;
        }
        this.core._monitorSettleRetries = 0;
        let rekeyed = false;
        const map = this.core._windowMonitors;
        const connected = new Set(this.connectors().filter(Boolean));
        if (map) {
            for (const win of [...map.keys()]) {
                if (!win.get_compositor_private()) continue;
                const prev = map.get(win);
                const detached = !!(prev && !connected.has(prev));
                if (detached) {
                    // Its monitor is gone. Put it on the workspace it came
                    // from, not the primary's current workspace, so only that
                    // workspace reflows. Fixed group trees stay as the return
                    // snapshot.
                    const home = win._plaidHomeWs || this.core._windowWorkspaces.get(win);
                    const homeIdx = home ? this.core.geometry.wsIndex(home) : -1;
                    if (home && homeIdx >= 1 && home !== win.get_workspace())
                        win.change_workspace(home);
                }
                const mon = win.get_monitor();
                if (!Number.isInteger(mon) || mon < 0) continue;
                const next = this.connectorOrFallback(mon);
                if (prev === next) continue;
                map.set(win, next);
                const prevMon = this.monitorForConnector(prev);
                const ws = win.get_workspace();
                if (!ws || prevMon === mon) continue;
                if (detached) {
                    if (this.monitorTiled(mon) &&
                        this.core.windows.getWorkspaceLayout(ws, mon) === 'dwindle') {
                        const group = this.groupObj(ws, mon);
                        const tree = this.core.bsp.bspGetTree(group);
                        if (!tree || !this.core.bsp.bspCollectWindows(tree).includes(win))
                            this.core.bsp.bspInsertForWorkspace(ws, win, mon);
                        if (this.core._dwindleLeafSigs)
                            this.core._dwindleLeafSigs.delete(group);
                    }
                    this.core.layouts.retileWorkspace(ws);
                } else if (prevMon >= 0) {
                    this.regroupWindow(win, ws, prevMon, mon);
                }
            }
        }
        const livePrimary = this.connectorForMonitor(this.primaryMonitorIndex());
        if (livePrimary) {
            if (!this.core._keyedPrimary)
                this.core._keyedPrimary = livePrimary;
            else if (livePrimary !== this.core._keyedPrimary) {
                this.syncKeyedPrimary(livePrimary);
                rekeyed = true;
            }
        }
        // A settled monitor change (resolution, rotation, scale) changes work
        // areas even when no window changed displays.
        if (!rekeyed) this.core.layouts.retileAll();
        // X11 frame/buffer offsets and mask bounds can be left stale by the
        // reconfiguration even when the window itself never resized.
        this.core.signals.addTimeout(150, () => {
            if (!this.core._settings) return GLib.SOURCE_REMOVE;
            this.core.borders.updateBorders();
            return GLib.SOURCE_REMOVE;
        });
        this.logSettleShapes();
        this.core.debugLog('monitors: settled pass done');
    }

    // Debug-only snapshot of the dwindle shape per workspace and monitor, so
    // an intermittent shuffle after a monitor event has a before/after trail.
    logSettleShapes() {
        if (!this.core._settings || !this.core._settings.get_boolean('debug')) return;
        if (!global.workspace_manager) return;
        const parts = [];
        for (let i = 1; i < global.workspace_manager.get_n_workspaces(); i++) {
            const ws = global.workspace_manager.get_workspace_by_index(i);
            if (!ws) continue;
            const groups = [];
            for (const mon of this.tiledMonitors()) {
                const group = this.groupObj(ws, mon);
                const tree = this.core._bspTrees && this.core._bspTrees.get(group);
                if (!tree || tree.type !== 'split') continue;
                groups.push(`${this.connectorOrFallback(mon)}:${this.core.bsp.dwindleShapeToString(tree)}`);
            }
            if (groups.length) parts.push(`${i}:[${groups.join(' ')}]`);
        }
        this.core.debugLog(`settle shapes: ${parts.join(' ') || 'none'}`);
    }

    scheduleMonitorsSettled(delay = 300) {
        if (!this.core._settings || this.core._monitorSettleId) return;
        this.core._monitorSettleId = this.core.signals.addTimeout(delay, () => {
            this.core._monitorSettleId = 0;
            this.processMonitorsChanged();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this.core._monitorSettleId) {
            GLib.source_remove(this.core._monitorSettleId);
            this.core.signals.untrackSource(this.core._monitorSettleId);
            this.core._monitorSettleId = 0;
        }
        super.destroy();
    }
}
