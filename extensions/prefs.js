import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class TilingWMPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const display = Gdk.Display.get_default();
        if (display) {
            let screenW = 0, screenH = 0;
            for (const monitor of display.get_monitors()) {
                const geo = monitor.get_geometry();
                screenW = Math.max(screenW, geo.width);
                screenH = Math.max(screenH, geo.height);
            }
            if (screenW > 0 && screenH > 0) {
                const minW = Math.max(560, Math.floor(screenW / 5));
                const minH = Math.max(480, Math.floor(screenH / 2));
                window.set_size_request(minW, minH);
                window.set_default_size(minW, minH);
            }
        }

        this._buildGeneralPage(window, settings);
        this._buildBordersPage(window, settings);
        this._buildKeybindingsPage(window, settings);
        this._buildFloatPage(window, settings);
    }

    _buildGeneralPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: _('General Settings'),
        });
        page.add(group);

        const enableRow = new Adw.SwitchRow({
            title: _('Enable Tiling'),
            subtitle: _('Turn tiling on or off'),
        });
        group.add(enableRow);
        settings.bind('enabled', enableRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const followRow = new Adw.SwitchRow({
            title: _('Cursor Follows Focus'),
            subtitle: _('Warp cursor to focused window on keybind navigation and new windows'),
        });
        group.add(followRow);
        settings.bind('follow-focus', followRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const mouseResizeRow = new Adw.SwitchRow({
            title: _('Mouse Resize and Swap'),
            subtitle: _('Drag window edges to resize splits, drag title bar to swap windows'),
        });
        group.add(mouseResizeRow);
        settings.bind('mouse-resize', mouseResizeRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const workspacePopupRow = new Adw.SwitchRow({
            title: _('Show Workspace Popup'),
            subtitle: _('Show workspace number and layout when switching workspaces'),
        });
        group.add(workspacePopupRow);
        settings.bind('workspace-popup', workspacePopupRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const tilingPopupRow = new Adw.SwitchRow({
            title: _('Show Tiling Popup'),
            subtitle: _('Show a popup when tiling is toggled on or off'),
        });
        group.add(tilingPopupRow);
        settings.bind('tiling-popup', tilingPopupRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const gapRow = new Adw.SpinRow({
            title: _('Window Gap'),
            subtitle: _('Gap between windows in pixels'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 50,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('gap'),
            }),
        });
        group.add(gapRow);
        settings.bind('gap', gapRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const singleGapRow = new Adw.SpinRow({
            title: _('Single Window Gap'),
            subtitle: _('Gap around a single tiled window (0 = no gap)'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 200,
                step_increment: 1,
                page_increment: 10,
                value: settings.get_int('single-gap'),
            }),
        });
        group.add(singleGapRow);
        settings.bind('single-gap', singleGapRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const layoutModel = new Gtk.StringList({
            strings: ['dwindle', 'master-stack', 'centered-master-stack'],
        });
        const layoutRow = new Adw.ComboRow({
            title: _('Layout'),
            subtitle: _('Window tiling layout'),
            model: layoutModel,
        });
        group.add(layoutRow);
        const layoutBinding = settings.bind('layout', layoutRow, 'selected-item', Gio.SettingsBindFlags.DEFAULT);
        const layoutIdx = ['dwindle', 'master-stack', 'centered-master-stack'].indexOf(settings.get_string('layout'));
        if (layoutIdx >= 0)
            layoutRow.set_selected(layoutIdx);
        layoutRow.connect('notify::selected', () => {
            const idx = layoutRow.get_selected();
            const layouts = ['dwindle', 'master-stack', 'centered-master-stack'];
            if (idx >= 0 && idx < layouts.length)
                settings.set_string('layout', layouts[idx]);
        });

        const dwindleRatioRow = new Adw.SpinRow({
            title: _('Dwindle Split Ratio'),
            subtitle: _('Ratio for dwindle splits. Default 0.618 (golden ratio)'),
            digits: 4,
            adjustment: new Gtk.Adjustment({
                lower: 0.0,
                upper: 1.0,
                step_increment: 0.05,
                page_increment: 0.1,
                value: settings.get_double('dwindle-ratio'),
            }),
        });
        group.add(dwindleRatioRow);
        settings.bind('dwindle-ratio', dwindleRatioRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const masterRatioRow = new Adw.SpinRow({
            title: _('Master Ratio'),
            subtitle: _('Ratio of the screen allocated to the master window'),
            digits: 4,
            adjustment: new Gtk.Adjustment({
                lower: 0.15,
                upper: 0.85,
                step_increment: 0.05,
                page_increment: 0.1,
                value: settings.get_double('master-ratio'),
            }),
        });
        group.add(masterRatioRow);
        settings.bind('master-ratio', masterRatioRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const updateRatioVisibility = () => {
            const layout = settings.get_string('layout');
            dwindleRatioRow.set_visible(layout === 'dwindle');
            masterRatioRow.set_visible(layout !== 'dwindle');
        };
        updateRatioVisibility();
        settings.connect('changed::layout', () => updateRatioVisibility());

        const resizeAmountRow = new Adw.SpinRow({
            title: _('Resize Step'),
            subtitle: _('Pixels to resize per keypress'),
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 200,
                step_increment: 5,
                page_increment: 20,
                value: settings.get_int('resize-amount'),
            }),
        });
        group.add(resizeAmountRow);
        settings.bind('resize-amount', resizeAmountRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    }

    _buildBordersPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Borders'),
            icon_name: 'preferences-other-symbolic',
        });
        window.add(page);

        const activeGroup = new Adw.PreferencesGroup({
            title: _('Active Window Border'),
        });
        page.add(activeGroup);

        const activeWidthRow = new Adw.SpinRow({
            title: _('Border Thickness'),
            subtitle: _('Width of the active window border in pixels'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 20,
                step_increment: 1,
                page_increment: 2,
                value: settings.get_int('active-border-width'),
            }),
        });
        activeGroup.add(activeWidthRow);
        settings.bind('active-border-width', activeWidthRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const activeColorRow = this._buildColorRow(
            settings, 'active-border-color', _('Border Color')
        );
        activeGroup.add(activeColorRow);

        const inactiveGroup = new Adw.PreferencesGroup({
            title: _('Inactive Window Border'),
        });
        page.add(inactiveGroup);

        const inactiveWidthRow = new Adw.SpinRow({
            title: _('Border Thickness'),
            subtitle: _('Width of inactive window borders in pixels'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 20,
                step_increment: 1,
                page_increment: 2,
                value: settings.get_int('inactive-border-width'),
            }),
        });
        inactiveGroup.add(inactiveWidthRow);
        settings.bind('inactive-border-width', inactiveWidthRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const inactiveColorRow = this._buildColorRow(
            settings, 'inactive-border-color', _('Border Color')
        );
        inactiveGroup.add(inactiveColorRow);

        const styleGroup = new Adw.PreferencesGroup({
            title: _('Border Style'),
        });
        page.add(styleGroup);

        const radiusRow = new Adw.SpinRow({
            title: _('Corner Radius'),
            subtitle: _('Radius of border corners in pixels'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 50,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('border-radius'),
            }),
        });
        styleGroup.add(radiusRow);
        settings.bind('border-radius', radiusRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    }

    _buildColorRow(settings, key, title) {
        const currentColor = (settings.get_strv(key) || [])[0] || '#3584e4';
        const row = new Adw.ActionRow({
            title: title,
            activatable: true,
        });

        const colorDot = new Gtk.DrawingArea({
            width_request: 32,
            height_request: 32,
            content_width: 32,
            content_height: 32,
        });
        colorDot.set_draw_func((_area, cr) => {
            const color = new Gdk.RGBA();
            color.parse((settings.get_strv(key) || [])[0] || '#3584e4');
            cr.setSourceRGB(color.red, color.green, color.blue);
            cr.arc(16, 16, 14, 0, Math.PI * 2);
            cr.fill();
            cr.setSourceRGBA(0, 0, 0, 0.25);
            cr.setLineWidth(1);
            cr.arc(16, 16, 14, 0, Math.PI * 2);
            cr.stroke();
        });
        const label = new Gtk.Label({
            label: currentColor,
            css_classes: ['dim-label'],
        });
        const suffixBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
        });
        suffixBox.append(colorDot);
        suffixBox.append(label);
        row.add_suffix(suffixBox);

        row.connect('activated', () => {
            const dialog = new Gtk.ColorDialog({
                title: _('Choose Border Color'),
                modal: true,
                with_alpha: false,
            });

            const initial = new Gdk.RGBA();
            initial.parse((settings.get_strv(key) || [])[0] || '#3584e4');

            dialog.choose_rgba(row.get_root(), initial, null, (_source, result) => {
                try {
                    const rgba = dialog.choose_rgba_finish(result);
                    const hex = `#${Math.round(rgba.red * 255).toString(16).padStart(2, '0')}${Math.round(rgba.green * 255).toString(16).padStart(2, '0')}${Math.round(rgba.blue * 255).toString(16).padStart(2, '0')}`;
                    settings.set_strv(key, [hex]);
                    label.label = hex;
                    colorDot.queue_draw();
                } catch (_e) {}
            });
        });

        return row;
    }

    _buildKeybindingsPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Keybindings'),
            icon_name: 'input-keyboard-symbolic',
        });
        window.add(page);

        const focusGroup = new Adw.PreferencesGroup({
            title: _('Window Focus'),
            description: _('Move focus between tiled windows'),
        });
        page.add(focusGroup);

        this._addShortcutRow(focusGroup, settings, 'move-focus-left', _('Focus Left'));
        this._addShortcutRow(focusGroup, settings, 'move-focus-right', _('Focus Right'));
        this._addShortcutRow(focusGroup, settings, 'move-focus-up', _('Focus Up'));
        this._addShortcutRow(focusGroup, settings, 'move-focus-down', _('Focus Down'));

        const swapGroup = new Adw.PreferencesGroup({
            title: _('Window Swapping'),
            description: _('Swap positions between tiled windows'),
        });
        page.add(swapGroup);

        this._addShortcutRow(swapGroup, settings, 'swap-left', _('Swap Left'));
        this._addShortcutRow(swapGroup, settings, 'swap-right', _('Swap Right'));
        this._addShortcutRow(swapGroup, settings, 'swap-up', _('Swap Up'));
        this._addShortcutRow(swapGroup, settings, 'swap-down', _('Swap Down'));

        const resizeGroup = new Adw.PreferencesGroup({
            title: _('Window Resizing'),
            description: _('Resize the focused window'),
        });
        page.add(resizeGroup);

        this._addShortcutRow(resizeGroup, settings, 'resize-shrink-width', _('Shrink Width'));
        this._addShortcutRow(resizeGroup, settings, 'resize-grow-width', _('Grow Width'));
        this._addShortcutRow(resizeGroup, settings, 'resize-shrink-height', _('Shrink Height'));
        this._addShortcutRow(resizeGroup, settings, 'resize-grow-height', _('Grow Height'));

        const miscGroup = new Adw.PreferencesGroup({
            title: _('Miscellaneous'),
        });
        page.add(miscGroup);

        this._addShortcutRow(miscGroup, settings, 'toggle-float', _('Toggle Float'));
        this._addShortcutRow(miscGroup, settings, 'toggle-tiling', _('Toggle Tiling'));
        this._addShortcutRow(miscGroup, settings, 'cycle-layout', _('Cycle Layout'));
        this._addShortcutRow(miscGroup, settings, 'fill-screen', _('Fill Screen'));
        this._addShortcutRow(miscGroup, settings, 'center-window', _('Center Window'));
        this._addShortcutRow(miscGroup, settings, 'pick-float-window', _('Pick Window to Float'));
        this._addShortcutRow(miscGroup, settings, 'scratchpad-toggle', _('Toggle Scratchpad'));
        this._addShortcutRow(miscGroup, settings, 'scratchpad-add', _('Add Window to Scratchpad'));
        this._addShortcutRow(miscGroup, settings, 'scratchpad-remove', _('Remove Window from Scratchpad'));
    }

    _addShortcutRow(group, settings, key, title) {
        const row = new Adw.ActionRow({
            title: title,
            activatable: true,
        });

        const current = settings.get_strv(key);
        const label = new Gtk.Label({
            label: current.length > 0 ? current[0] : _('Disabled'),
            css_classes: ['dim-label', 'monospace'],
        });
        row.add_suffix(label);

        row.connect('activated', () => {
            this._captureShortcut(row, settings, key, label);
        });

        group.add(row);
    }

    _captureShortcut(row, settings, key, label) {
        const dialog = new Adw.Window({
            modal: true,
            transient_for: row.get_root(),
            title: _('Set Shortcut'),
            default_width: 400,
            default_height: 150,
        });

        const content = new Adw.StatusPage({
            title: _('Press a new shortcut'),
            description: _('Press Backspace to clear, Escape to cancel'),
            icon_name: 'input-keyboard-symbolic',
        });
        dialog.set_content(content);

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_c, keyval, _keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask();

            if (keyval === Gdk.KEY_Escape && mask === 0) {
                dialog.close();
                return true;
            }
            if (keyval === Gdk.KEY_BackSpace && mask === 0) {
                settings.set_strv(key, []);
                label.label = _('Disabled');
                dialog.close();
                return true;
            }
            if (!Gtk.accelerator_valid(keyval, mask))
                return false;

            const accel = Gtk.accelerator_name(keyval, mask);
            settings.set_strv(key, [accel]);
            label.label = accel;
            dialog.close();
            return true;
        });
        dialog.add_controller(controller);
        dialog.present();
    }

    _buildFloatPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Windows'),
            icon_name: 'view-dual-symbolic',
        });
        window.add(page);

        const pickGroup = new Adw.PreferencesGroup({
            title: _('Quick Pick'),
            description: _('Click anywhere on this row, then click any window on the desktop'),
        });
        page.add(pickGroup);

        const pickRow = new Adw.ActionRow({
            title: _('Pick Window to Float'),
            subtitle: _('Click any window on the desktop to capture it'),
            activatable: true,
        });
        const pickButton = new Gtk.Button({
            icon_name: 'input-mouse-symbolic',
            css_classes: ['suggested-action', 'circular'],
            can_target: false,
        });
        pickRow.add_suffix(pickButton);
        pickGroup.add(pickRow);

        let pickWatchId = 0;
        const startPick = () => {
            settings.set_boolean('pick-mode', false);
            settings.set_string('pick-mode-class', '');
            settings.set_string('pick-mode-title', '');
            settings.set_boolean('pick-mode', true);
            window.minimize();

            if (pickWatchId) settings.disconnect(pickWatchId);
            pickWatchId = settings.connect('changed::pick-mode', () => {
                if (settings.get_boolean('pick-mode')) return;
                settings.disconnect(pickWatchId);
                pickWatchId = 0;

                const cls = settings.get_string('pick-mode-class');
                const title = settings.get_string('pick-mode-title');
                if (!cls && !title) {
                    window.present();
                    return;
                }

                this._showPickChoiceDialog(window, settings, cls, title,
                    (target, value) => {
                        const current = new Set(settings.get_strv(target));
                        current.add(value);
                        settings.set_strv(target, [...current]);
                        if (target === 'float-windows')
                            this._rebuildFloatList(settings, this._floatClassGroup, this._floatClassAddRow, 'float-windows', '_floatClassRows');
                        else
                            this._rebuildFloatList(settings, this._floatTitleGroup, this._floatTitleAddRow, 'float-titles', '_floatTitleRows');
                    },
                    () => window.present()
                );
            });
        };
        pickRow.connect('activated', startPick);

        const classGroup = new Adw.PreferencesGroup({
            title: _('Floating by Window Class'),
            description: _('WM_CLASS instance names of windows that should float (not be tiled)'),
        });
        page.add(classGroup);
        this._floatClassGroup = classGroup;

        this._floatClassRows = [];

        const addClassRow = new Adw.ActionRow({
            title: _('Add Window Class'),
            activatable: true,
        });
        const addClassButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            css_classes: ['suggested-action', 'circular'],
            can_target: false,
        });
        addClassRow.add_suffix(addClassButton);
        classGroup.add(addClassRow);
        this._floatClassAddRow = addClassRow;

        addClassRow.connect('activated', () => {
            this._showAddFloatDialog(window, settings, classGroup, addClassRow, 'float-windows', _('WM_CLASS instance name (e.g. gimp)'));
        });

        this._rebuildFloatList(settings, classGroup, addClassRow, 'float-windows', '_floatClassRows');

        const titleGroup = new Adw.PreferencesGroup({
            title: _('Floating by Window Title'),
            description: _('Exact window titles that should float (case-sensitive)'),
        });
        page.add(titleGroup);
        this._floatTitleGroup = titleGroup;

        this._floatTitleRows = [];

        const addTitleRow = new Adw.ActionRow({
            title: _('Add Window Title'),
            activatable: true,
        });
        const addTitleButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            css_classes: ['suggested-action', 'circular'],
            can_target: false,
        });
        addTitleRow.add_suffix(addTitleButton);
        titleGroup.add(addTitleRow);
        this._floatTitleAddRow = addTitleRow;

        addTitleRow.connect('activated', () => {
            this._showAddFloatDialog(window, settings, titleGroup, addTitleRow, 'float-titles', _('Exact window title (e.g. Picture-in-Picture)'));
        });

        this._rebuildFloatList(settings, titleGroup, addTitleRow, 'float-titles', '_floatTitleRows');
    }

    _showPickChoiceDialog(window, settings, cls, title, onAdd, onDone) {
        const dialog = new Adw.Window({
            modal: true,
            transient_for: window,
            title: _('Add Floating Window'),
            default_width: 420,
            default_height: 200,
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 24,
            margin_bottom: 24,
            margin_start: 24,
            margin_end: 24,
        });

        const infoLabel = new Gtk.Label({
            label: _('Which identifier should be used?'),
            css_classes: ['heading'],
        });
        box.append(infoLabel);

        const btnBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            halign: Gtk.Align.CENTER,
            marginTop: 12,
        });

        if (cls) {
            const classBtn = new Gtk.Button({
                label: _('WM_CLASS: %s').replace('%s', cls),
                css_classes: ['suggested-action'],
                hexpand: true,
            });
            classBtn.connect('clicked', () => {
                onAdd('float-windows', cls.toLowerCase());
                dialog.close();
                onDone();
            });
            btnBox.append(classBtn);
        }

        if (title) {
            const titleBtn = new Gtk.Button({
                label: _('Title: %s').replace('%s', title),
                css_classes: ['suggested-action'],
                hexpand: true,
            });
            titleBtn.connect('clicked', () => {
                onAdd('float-titles', title);
                dialog.close();
                onDone();
            });
            btnBox.append(titleBtn);
        }

        box.append(btnBox);

        const cancelBtn = new Gtk.Button({
            label: _('Cancel'),
            halign: Gtk.Align.CENTER,
        });
        cancelBtn.connect('clicked', () => {
            dialog.close();
            onDone();
        });
        box.append(cancelBtn);

        dialog.set_content(box);
        dialog.present();
    }

    _rebuildFloatList(settings, group, addRow, settingsKey, rowsProperty) {
        for (const row of this[rowsProperty])
            group.remove(row);
        this[rowsProperty] = [];

        const classes = settings.get_strv(settingsKey);
        for (const cls of classes) {
            const row = new Adw.ActionRow({
                title: cls,
                activatable: false,
            });
            const removeBtn = new Gtk.Button({
                icon_name: 'list-remove-symbolic',
                css_classes: ['flat', 'circular'],
            });
            removeBtn.connect('clicked', () => {
                const current = new Set(settings.get_strv(settingsKey));
                current.delete(cls);
                settings.set_strv(settingsKey, [...current]);
                this._rebuildFloatList(settings, group, addRow, settingsKey, rowsProperty);
            });
            row.add_suffix(removeBtn);
            group.add(row);
            this[rowsProperty].push(row);
        }
    }

    _showAddFloatDialog(window, settings, group, addRow, settingsKey, placeholder) {
        const dialog = new Adw.Window({
            modal: true,
            transient_for: window,
            title: _('Add Floating Window'),
            default_width: 400,
            default_height: 150,
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 24,
            margin_bottom: 24,
            margin_start: 24,
            margin_end: 24,
        });

        const entry = new Gtk.Entry({
            placeholder_text: placeholder,
            hexpand: true,
        });
        box.append(entry);

        const btnBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            halign: Gtk.Align.END,
        });

        const cancelBtn = new Gtk.Button({ label: _('Cancel') });
        cancelBtn.connect('clicked', () => dialog.close());
        btnBox.append(cancelBtn);

        const addBtn = new Gtk.Button({
            label: _('Add'),
            css_classes: ['suggested-action'],
        });
        addBtn.connect('clicked', () => {
            const text = entry.get_text().trim();
            if (text.length > 0) {
                const current = new Set(settings.get_strv(settingsKey));
                current.add(text);
                settings.set_strv(settingsKey, [...current]);
                const rowsProperty = settingsKey === 'float-titles' ? '_floatTitleRows' : '_floatClassRows';
                this._rebuildFloatList(settings, group, addRow, settingsKey, rowsProperty);
            }
            dialog.close();
        });
        btnBox.append(addBtn);

        entry.connect('activate', () => addBtn.emit('clicked'));

        box.append(btnBox);
        dialog.set_content(box);
        dialog.present();

        entry.grab_focus();
    }
}
