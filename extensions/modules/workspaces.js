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
        this.core._origWorkspaceSwitcherDisplay = WorkspaceSwitcherPopup.prototype.display;
        WorkspaceSwitcherPopup.prototype.display = function (index) {
            this.destroy();
        };
    }

    restoreWorkspaceSwitcherPopup() {
        if (this.core._origWorkspaceSwitcherDisplay) {
            WorkspaceSwitcherPopup.prototype.display = this.core._origWorkspaceSwitcherDisplay;
            this.core._origWorkspaceSwitcherDisplay = null;
        }
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
