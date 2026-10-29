// Workspace-switch popups, warning popups, and the Just Perfection overlap
// warning. Methods live on this subsystem class.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { WorkspaceSwitcherPopup } from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';

import { LAYOUT_NAMES } from './helpers.js';
import { PlaidSubsystem } from './subsystem.js';





// --- Workspace Switcher Popup ---

















// --- Notifications ---


export class Workspaces extends PlaidSubsystem {
    constructor(core) {
        super(core);
    }

    showWorkspacePopup(ws) {
        if (!ws) return;
        // The hidden parking slot must never be announced as a workspace — it
        // renders as a duplicate "Workspace 1".
        if (ws === this.core._backgroundAppParkingWs) return;
        const layout = this.core.windows.getWorkspaceLayout(ws);
        this.showPopup(`Workspace ${this.core.geometry.bgAppRealToDisplay(this.core.geometry.wsIndex(ws)) + 1}`,
            `Layout: ${LAYOUT_NAMES[layout] || layout}`);
    }

    showPopup(title, subtitle = null, duration = 3000, onActivate = null) {
        if (this.core._layoutPopupHideId) {
            GLib.source_remove(this.core._layoutPopupHideId);
            this.core._layoutPopupHideId = 0;
        }
        if (this.core._layoutPopup) {
            this.core._layoutPopup.remove_all_transitions();
            this.core._layoutPopup.destroy();
            this.core._layoutPopup = null;
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
        this.core._layoutPopup = popup;
        popup.set_position(0, 0);
        popup.set_size(maxX, maxY);
        Main.layoutManager.uiGroup.add_child(popup);
        this.core.debugLog(`popup shown: ${title}`);

        const dismissPopup = () => {
            if (this.core._layoutPopupHideId) {
                GLib.source_remove(this.core._layoutPopupHideId);
                this.core._layoutPopupHideId = 0;
            }
            if (this.core._layoutPopup === popup) {
                popup.ease({
                    opacity: 0,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => {
                        if (this.core._layoutPopup === popup) {
                            this.core._layoutPopup.destroy();
                            this.core._layoutPopup = null;
                        }
                    },
                });
            }
        };

        if (onActivate) {
            this.connectObject(popup, 'button-press-event', () => {
                dismissPopup();
                { onActivate(); }
                return Clutter.EVENT_STOP;
            });
        }

        popup.opacity = 0;
        popup.ease({
            opacity: 255,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this.core._layoutPopupHideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration, () => {
            this.core._layoutPopupHideId = 0;
            dismissPopup();
            return GLib.SOURCE_REMOVE;
        });
    }

    suppressWorkspaceSwitcherPopup() {
        try {
            this.core._origWorkspaceSwitcherDisplay = WorkspaceSwitcherPopup.prototype.display;
            WorkspaceSwitcherPopup.prototype.display = function (index) {
                this.destroy();
            };
        } catch (e) {
            this.core.debugLog(`workspace switcher suppression failed: ${e.message}`);
            this.core._origWorkspaceSwitcherDisplay = null;
        }
    }

    restoreWorkspaceSwitcherPopup() {
        if (this.core._origWorkspaceSwitcherDisplay) {
            WorkspaceSwitcherPopup.prototype.display = this.core._origWorkspaceSwitcherDisplay;
            this.core._origWorkspaceSwitcherDisplay = null;
        }
    }

    getJPSettings() {
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
                this.core.debugLog('workspace popup: JP settings acquired');
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
            this.core.debugLog('workspace popup: JP settings acquired (schema source)');
            return settings;
        } catch (e) {
            this.core.debugLog('workspace popup: JP settings lookup failed:', String(e));
            return null;
        }
    }

    initWorkspacePopupWarning() {
        try {
            this.core._shellSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
            this.core._shellSettingsChangedId = this.connectObject(this.core._shellSettings,
                'changed::enabled-extensions',
                () => this.updateWorkspacePopupWarning());
        } catch (_e) {
            this.core._shellSettings = null;
        }
        this.core._jpSettings = this.getJPSettings();
        if (this.core._jpSettings) {
            this.core._jpSettingsChangedId = this.connectObject(this.core._jpSettings,
                'changed::workspace-popup',
                () => this.updateWorkspacePopupWarning());
        }
        this.core._warningPopupId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this.core._warningPopupId = 0;
            if (!this.core._settings) return GLib.SOURCE_REMOVE;
            this.updateWorkspacePopupWarning();
            return GLib.SOURCE_REMOVE;
        });
    }

    updateWorkspacePopupWarning() {
        if (!this.core._settings) return;
        let jpEnabled = false;
        jpEnabled = !!(this.core._shellSettings &&
            this.core._shellSettings.get_strv('enabled-extensions')
                .includes('just-perfection-desktop@just-perfection'));
        if (!jpEnabled) {
            if (this.core._jpSettings) {
                if (this.core._jpSettingsChangedId) {
                    this.core._jpSettings.disconnectObject(this.core._jpSettingsChangedId);
                }
                this.core._jpSettings = null;
                this.core._jpSettingsChangedId = 0;
            }
        } else if (!this.core._jpSettings) {
            this.core._jpSettings = this.getJPSettings();
            if (this.core._jpSettings) {
                this.core._jpSettingsChangedId = this.connectObject(this.core._jpSettings,
                    'changed::workspace-popup',
                    () => this.updateWorkspacePopupWarning());
            }
        }
        let overlap = false;
        try {
            const jpSuppresses = !!(this.core._jpSettings &&
                !this.core._jpSettings.get_boolean('workspace-popup'));
            overlap = jpEnabled && jpSuppresses;
            this.core.debugLog(`workspace popup: jpEnabled=${jpEnabled} jpSuppresses=${jpSuppresses} overlap=${overlap}`);
        } catch (e) {
            overlap = false;
            this.core.debugLog('workspace popup: overlap check error:', String(e));
        }
        if (overlap) {
            if (!this.core._warningPopup) {
                this.core.debugLog('workspace popup: showing warning');
                this.showWarningPopup('Workspace Popup Hidden',
                    'Just Perfection also manages the workspace popup — workspace-switch popups may be suppressed. Plaid’s tiling popups are unaffected.',
                    'Click to dismiss');
            }
        } else {
            this.hideWarningPopup();
        }
    }

    hideWarningPopup() {
        const popup = this.core._warningPopup;
        if (!popup) return;
        this.core._warningPopup = null;
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

    showWarningPopup(title, subtitle, hint) {
        if (Main.overview && Main.overview.visible) {
            this.core._pendingWarning = { title, subtitle, hint };
            if (!this.core._pendingWarningOverviewId) {
                this.core._pendingWarningOverviewId = this.connectObject(Main.overview, 'hidden', () => {
                    if (this.core._pendingWarningOverviewId) {
                        Main.overview.disconnectObject(this.core._pendingWarningOverviewId);
                        this.core._pendingWarningOverviewId = 0;
                    }
                    if (this.core._pendingWarning) {
                        const pending = this.core._pendingWarning;
                        this.core._pendingWarning = null;
                        this.displayWarningPopup(pending.title, pending.subtitle, pending.hint);
                    }
                });
            }
            return;
        }
        this.displayWarningPopup(title, subtitle, hint);
    }

    displayWarningPopup(title, subtitle, hint) {
        if (this.core._warningPopup) {
            this.core._warningPopup.remove_all_transitions();
            this.core._warningPopup.destroy();
            this.core._warningPopup = null;
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
        this.core._warningPopup = popup;
        popup.set_position(0, 0);
        popup.set_size(maxX, maxY);
        Main.layoutManager.uiGroup.add_child(popup);

        this.connectObject(popup, 'button-press-event', () => {
            if (this.core._warningPopup !== popup) return;
            popup.remove_all_transitions();
            popup.ease({
                opacity: 0,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    if (this.core._warningPopup === popup) {
                        this.core._warningPopup.destroy();
                        this.core._warningPopup = null;
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

    notifyCritical(title, body) {
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
            this.core.debugLog(`critical notification failed: ${e.message}`);
        }
    }

    destroy() {
        if (this.core._layoutPopupHideId) {
            GLib.source_remove(this.core._layoutPopupHideId);
            this.core._layoutPopupHideId = 0;
        }
        if (this.core._layoutPopup) {
            this.core._layoutPopup.remove_all_transitions();
            this.core._layoutPopup.destroy();
            this.core._layoutPopup = null;
        }
        this.restoreWorkspaceSwitcherPopup();
        if (this.core._shellSettings) {
            if (this.core._shellSettingsChangedId)
                this.core._shellSettings.disconnectObject(this.core._shellSettingsChangedId);
            this.core._shellSettings = null;
        }
        if (this.core._jpSettings) {
            if (this.core._jpSettingsChangedId)
                this.core._jpSettings.disconnectObject(this.core._jpSettingsChangedId);
            this.core._jpSettings = null;
        }
        this.core._shellSettingsChangedId = 0;
        this.core._jpSettingsChangedId = 0;
        if (this.core._warningPopupId) {
            GLib.source_remove(this.core._warningPopupId);
            this.core._warningPopupId = 0;
        }
        if (this.core._warningPopup) {
            this.core._warningPopup.remove_all_transitions();
            this.core._warningPopup.destroy();
            this.core._warningPopup = null;
        }
        if (this.core._pendingWarningOverviewId) {
            Main.overview.disconnectObject(this.core._pendingWarningOverviewId);
            this.core._pendingWarningOverviewId = 0;
        }
        this.core._pendingWarning = null;
            super.destroy();
}
}
