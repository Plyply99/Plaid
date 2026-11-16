// Multi-monitor group keys and connector-prefixed persistence entries.
//
// A group is (workspace index, monitor connector). The keyed primary monitor
// reuses the single-monitor workspace-* keys, so its group key is the bare
// index. Every other monitor uses "<index>@<connector>" in memory and
// "<connector>:<existing-entry>" in the monitor-workspace-* settings.
//
// Connectors come from Mutter (DP-1, HDMI-1, eDP-1). A "#N" index stand-in is
// used only while a connector is unresolved and is NEVER persisted.

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
        return conns;
    }

    invalidate() {
        this.core._monitorConnCache = null;
    }

    connectorForMonitor(mon) {
        if (!Number.isInteger(mon) || mon < 0) return '';
        return this.connectors()[mon] || '';
    }

    // A stable in-memory stand-in while a connector is unresolved. Never
    // persisted (see persistableConnector()).
    connectorOrFallback(mon) {
        return this.connectorForMonitor(mon) || `#${mon}`;
    }

    primaryMonitorIndex() {
        return global.display.get_primary_monitor();
    }

    primaryConnector() {
        return this.core._keyedPrimary || this.connectorForMonitor(this.primaryMonitorIndex());
    }

    monitorForConnector(connector) {
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

    getWindowsForGroup(ws, mon) {
        const connector = this.connectorOrFallback(mon);
        return this.core.windows.getWindowsForWorkspace(ws)
            .filter(w => this.windowMonitor(w) === connector);
    }

    groupObj(ws, mon) {
        if (!ws || !this.core._groupObjs) return null;
        let byConnector = this.core._groupObjs.get(ws);
        if (!byConnector) {
            byConnector = new Map();
            this.core._groupObjs.set(ws, byConnector);
        }
        const connector = this.connectorOrFallback(mon);
        let group = byConnector.get(connector);
        if (!group) {
            group = {
                workspace: ws,
                monitor: mon,
                connector,
                key: this.groupKeyFor(this.core.geometry.wsIndex(ws), mon),
            };
            byConnector.set(connector, group);
        }
        return group;
    }

    // The group key for a workspace on a monitor: the keyed primary keeps the
    // bare index (the pre-multi-monitor keys), every other monitor appends its
    // connector.
    groupKeyFor(wsIndex, mon) {
        const connector = this.connectorForMonitor(mon);
        const keyedPrimary = this.core._keyedPrimary || this.primaryConnector();
        if (!connector || connector === keyedPrimary) return groupKey(wsIndex, '');
        return groupKey(wsIndex, connector);
    }

    connectSignals() {
        const mgr = this.manager();
        if (mgr) {
            this.connectObject(mgr, 'monitors-changed-internal',
                () => this.onMonitorsChanged());
        }
        this.connectObject(global.display, 'window-entered-monitor',
            (_display, mon, win) => this.setWindowMonitor(win, mon));
        if (this.core._mutterSettings) {
            this.connectObject(this.core._mutterSettings,
                'changed::workspaces-only-on-primary', () => this.onMonitorsChanged());
        }
    }

    onMonitorsChanged() {
        this.invalidate();
        const map = this.core._windowMonitors;
        if (!map) return;
        for (const win of map.keys()) {
            if (!win.get_compositor_private()) continue;
            this.setWindowMonitor(win, win.get_monitor());
        }
    }
}
