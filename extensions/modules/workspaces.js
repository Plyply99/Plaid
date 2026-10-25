// Workspace-switch popups, warning popups, and the Just Perfection overlap
// warning. Methods are attached to TilingWMExtension.prototype in extension.js.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { WorkspaceSwitcherPopup } from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';

import { LAYOUT_NAMES } from './helpers.js';

export function _showWorkspacePopup(ws) {
    if (!ws) return;
    // The hidden parking slot must never be announced as a workspace — it
    // renders as a duplicate "Workspace 1".
    if (ws === this._backgroundAppParkingWs) return;
    const layout = this._getWorkspaceLayout(ws);
    this._showPopup(`Workspace ${this._bgAppRealToDisplay(this._wsIndex(ws)) + 1}`,
        `Layout: ${LAYOUT_NAMES[layout] || layout}`);
}

export function _showPopup(title, subtitle = null, duration = 3000, onActivate = null) {
    if (this._layoutPopupHideId) {
        GLib.source_remove(this._layoutPopupHideId);
        this._layoutPopupHideId = 0;
    }
    if (this._layoutPopup) {
        this._layoutPopup.remove_all_transitions();
        this._layoutPopup.destroy();
        this._layoutPopup = null;
    }

    const monitors = global.display.get_n_monitors();
    let maxX = 0, maxY = 0;
    for (let i = 0; i < monitors; i++) {
        const geom = global.display.get_monitor_geometry(i);
        maxX = Math.max(maxX, geom.x + geom.width);
        maxY = Math.max(maxY, geom.y + geom.height);
    }
    const bottomMargin = Math.floor(maxY * 0.70);

    const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style: `background-color: rgba(0, 0, 0, 0.7); border-radius: 12px; padding: 14px 28px; spacing: 4px; margin-top: ${bottomMargin}px;`,
    });
    box.add_child(new St.Label({
        text: title,
        style: 'font-size: 20px; font-weight: bold; color: #ffffff;',
    }));
    if (subtitle) {
        box.add_child(new St.Label({
            text: subtitle,
            style: 'font-size: 14px; color: rgba(255, 255, 255, 0.8);',
        }));
    }

    const popup = new St.Bin({
        child: box,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        reactive: onActivate !== null,
    });
    this._layoutPopup = popup;
    popup.set_position(0, 0);
    popup.set_size(maxX, maxY);
    Main.layoutManager.uiGroup.add_child(popup);
    this._debugLog(`popup shown: ${title}`);

    const dismissPopup = () => {
        if (this._layoutPopupHideId) {
            GLib.source_remove(this._layoutPopupHideId);
            this._layoutPopupHideId = 0;
        }
        if (this._layoutPopup === popup) {
            popup.ease({
                opacity: 0,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    if (this._layoutPopup === popup) {
                        this._layoutPopup.destroy();
                        this._layoutPopup = null;
                    }
                },
            });
        }
    };

    if (onActivate) {
        popup.connect('button-press-event', () => {
            dismissPopup();
            try { onActivate(); } catch (_e) {}
            return Clutter.EVENT_STOP;
        });
    }

    popup.opacity = 0;
    popup.ease({
        opacity: 255,
        duration: 150,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });

    this._layoutPopupHideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration, () => {
        this._layoutPopupHideId = 0;
        dismissPopup();
        return GLib.SOURCE_REMOVE;
    });
}

// --- Workspace Switcher Popup ---

export function _suppressWorkspaceSwitcherPopup() {
    try {
        this._origWorkspaceSwitcherDisplay = WorkspaceSwitcherPopup.prototype.display;
        WorkspaceSwitcherPopup.prototype.display = function (index) {
            this.destroy();
        };
    } catch (e) {
        this._debugLog(`workspace switcher suppression failed: ${e.message}`);
        this._origWorkspaceSwitcherDisplay = null;
    }
}

export function _restoreWorkspaceSwitcherPopup() {
    if (this._origWorkspaceSwitcherDisplay) {
        try {
            WorkspaceSwitcherPopup.prototype.display = this._origWorkspaceSwitcherDisplay;
        } catch (_e) {}
        this._origWorkspaceSwitcherDisplay = null;
    }
}

export function _getJPSettings() {
    try {
        // Cross-extension read: the extension manager record exposes the
        // live extension object as stateObj; fall back to building a
        // schema source from the extension directory (EGO installs keep
        // their schema outside the default source).
        const uuid = 'just-perfection-desktop@just-perfection';
        const jpExt = Main.extensionManager.lookup(uuid);
        if (!jpExt) return null;
        const live = jpExt.stateObj && jpExt.stateObj.getSettings
            ? jpExt.stateObj.getSettings() : null;
        if (live) {
            this._debugLog('workspace popup: JP settings acquired');
            return live;
        }
        const schemaDir = jpExt.dir.get_child('schemas');
        const def = Gio.SettingsSchemaSource.get_default();
        const src = schemaDir.query_exists(null)
            ? Gio.SettingsSchemaSource.new_from_directory(
                schemaDir.get_path(), def, false)
            : def;
        const schema = src.lookup('org.gnome.shell.extensions.just-perfection', true);
        if (!schema) return null;
        const settings = new Gio.Settings({ settings_schema: schema });
        this._debugLog('workspace popup: JP settings acquired (schema source)');
        return settings;
    } catch (e) {
        this._debugLog('workspace popup: JP settings lookup failed:', String(e));
        return null;
    }
}

export function _initWorkspacePopupWarning() {
    try {
        this._shellSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
        this._shellSettingsChangedId = this._shellSettings.connect(
            'changed::enabled-extensions',
            () => this._updateWorkspacePopupWarning());
    } catch (_e) {
        this._shellSettings = null;
    }
    this._jpSettings = this._getJPSettings();
    if (this._jpSettings) {
        this._jpSettingsChangedId = this._jpSettings.connect(
            'changed::workspace-popup',
            () => this._updateWorkspacePopupWarning());
    }
    this._warningPopupId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
        this._warningPopupId = 0;
        if (!this._settings) return GLib.SOURCE_REMOVE;
        this._updateWorkspacePopupWarning();
        return GLib.SOURCE_REMOVE;
    });
}

export function _updateWorkspacePopupWarning() {
    if (!this._settings) return;
    let jpEnabled = false;
    try {
        jpEnabled = !!(this._shellSettings &&
            this._shellSettings.get_strv('enabled-extensions')
                .includes('just-perfection-desktop@just-perfection'));
    } catch (_e) {}
    if (!jpEnabled) {
        if (this._jpSettings) {
            if (this._jpSettingsChangedId) {
                this._jpSettings.disconnect(this._jpSettingsChangedId);
            }
            this._jpSettings = null;
            this._jpSettingsChangedId = 0;
        }
    } else if (!this._jpSettings) {
        this._jpSettings = this._getJPSettings();
        if (this._jpSettings) {
            this._jpSettingsChangedId = this._jpSettings.connect(
                'changed::workspace-popup',
                () => this._updateWorkspacePopupWarning());
        }
    }
    let overlap = false;
    try {
        const jpSuppresses = !!(this._jpSettings &&
            !this._jpSettings.get_boolean('workspace-popup'));
        overlap = jpEnabled && jpSuppresses;
        this._debugLog(`workspace popup: jpEnabled=${jpEnabled} jpSuppresses=${jpSuppresses} overlap=${overlap}`);
    } catch (e) {
        overlap = false;
        this._debugLog('workspace popup: overlap check error:', String(e));
    }
    if (overlap) {
        if (!this._warningPopup) {
            this._debugLog('workspace popup: showing warning');
            this._showWarningPopup('Workspace Popup Hidden',
                'Just Perfection also manages the workspace popup — workspace-switch popups may be suppressed. Plaid’s tiling popups are unaffected.',
                'Click to dismiss');
        }
    } else {
        this._hideWarningPopup();
    }
}

export function _hideWarningPopup() {
    const popup = this._warningPopup;
    if (!popup) return;
    this._warningPopup = null;
    popup.remove_all_transitions();
    popup.ease({
        opacity: 0,
        duration: 200,
        mode: Clutter.AnimationMode.EASE_IN_QUAD,
        onComplete: () => {
            popup.destroy();
        },
    });
}

export function _showWarningPopup(title, subtitle, hint) {
    if (Main.overview && Main.overview.visible) {
        this._pendingWarning = { title, subtitle, hint };
        if (!this._pendingWarningOverviewId) {
            this._pendingWarningOverviewId = Main.overview.connect('hidden', () => {
                if (this._pendingWarningOverviewId) {
                    Main.overview.disconnect(this._pendingWarningOverviewId);
                    this._pendingWarningOverviewId = 0;
                }
                if (this._pendingWarning) {
                    const pending = this._pendingWarning;
                    this._pendingWarning = null;
                    this._displayWarningPopup(pending.title, pending.subtitle, pending.hint);
                }
            });
        }
        return;
    }
    this._displayWarningPopup(title, subtitle, hint);
}

export function _displayWarningPopup(title, subtitle, hint) {
    if (this._warningPopup) {
        this._warningPopup.remove_all_transitions();
        this._warningPopup.destroy();
        this._warningPopup = null;
    }

    const monitors = global.display.get_n_monitors();
    let maxX = 0, maxY = 0;
    for (let i = 0; i < monitors; i++) {
        const geom = global.display.get_monitor_geometry(i);
        maxX = Math.max(maxX, geom.x + geom.width);
        maxY = Math.max(maxY, geom.y + geom.height);
    }
    const bottomMargin = Math.floor(maxY * 0.70);

    const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style: `background-color: rgba(0, 0, 0, 0.75); border-radius: 16px; padding: 22px 40px; spacing: 8px; margin-top: ${bottomMargin}px; min-width: 480px;`,
    });
    box.add_child(new St.Label({
        text: title,
        style: 'font-size: 24px; font-weight: bold; color: #ffffff;',
    }));
    if (subtitle) {
        box.add_child(new St.Label({
            text: subtitle,
            style: 'font-size: 16px; color: rgba(255, 255, 255, 0.85);',
        }));
    }
    if (hint) {
        box.add_child(new St.Label({
            text: hint,
            style: 'font-size: 14px; color: rgba(255, 255, 255, 0.6);',
        }));
    }

    const popup = new St.Bin({
        child: box,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        reactive: true,
    });
    this._warningPopup = popup;
    popup.set_position(0, 0);
    popup.set_size(maxX, maxY);
    Main.layoutManager.uiGroup.add_child(popup);

    popup.connect('button-press-event', () => {
        if (this._warningPopup !== popup) return;
        popup.remove_all_transitions();
        popup.ease({
            opacity: 0,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (this._warningPopup === popup) {
                    this._warningPopup.destroy();
                    this._warningPopup = null;
                }
            },
        });
    });

    popup.opacity = 0;
    popup.ease({
        opacity: 255,
        duration: 150,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
}

// --- Notifications ---

export function _notifyCritical(title, body) {
    try {
        const conn = Gio.DBus.session;
        const variant = new GLib.Variant('(susssasa{sv}i)', [
            'org.gnome.Shell.Extensions.Plaid', 0, '',
            title, body, [],
            { urgency: new GLib.Variant('y', 2) }, -1,
        ]);
        conn.call(
            'org.freedesktop.Notifications', '/org/freedesktop/Notifications',
            'org.freedesktop.Notifications', 'Notify',
            variant, null, Gio.DBusCallFlags.NONE, -1, null, null);
    } catch (e) {
        log(`[plaid] critical notification failed: ${e.message}`);
    }
}

export const workspacesMethods = {
    _showWorkspacePopup,
    _showPopup,
    _suppressWorkspaceSwitcherPopup,
    _restoreWorkspaceSwitcherPopup,
    _getJPSettings,
    _initWorkspacePopupWarning,
    _updateWorkspacePopupWarning,
    _hideWarningPopup,
    _showWarningPopup,
    _displayWarningPopup,
    _notifyCritical,
};
