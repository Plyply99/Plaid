import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
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
        this._buildFlairPage(window, settings);
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

        const updateRow = new Adw.SwitchRow({
            title: _('Check for updates'),
            subtitle: _('Notify when a newer Plaid release is available'),
        });
        const updateButton = new Gtk.Button({
            label: _('Check'),
            valign: Gtk.Align.CENTER,
        });
        const updateStatus = new Gtk.Label({
            label: '',
            css_classes: ['dim-label'],
            valign: Gtk.Align.CENTER,
            wrap: true,
        });
        updateRow.add_suffix(updateStatus);
        updateRow.add_suffix(updateButton);
        group.add(updateRow);
        settings.bind('release-check-enabled', updateRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const launchUpdateTerminal = () => {
            const script = `${this.path}/plaid-terminal-settings.sh`;
            const cmd = `source "${script}" && plaid-update && exec bash`;
            const terminals = [
                ['ghostty', '-e', '/bin/bash', '-c', cmd],
                ['gnome-terminal', '--', '/bin/bash', '-c', cmd],
                ['x-terminal-emulator', '-e', '/bin/bash', '-c', cmd],
            ];
            for (const argv of terminals) {
                try {
                    if (!GLib.find_program_in_path(argv[0])) continue;
                    new Gio.Subprocess({ argv });
                    return;
                } catch (_e) {}
            }
            updateStatus.label = _('No terminal found to run plaid-update');
        };

        const runUpdateCheck = () => {
            updateButton.sensitive = false;
            updateStatus.label = _('Checking…');
            const proc = Gio.Subprocess.new(
                ['/bin/sh', '-c',
                    'curl -sL --max-time 10 ' +
                    'https://api.github.com/repos/Plyply99/Plaid/releases/latest'],
                Gio.SubprocessFlags.STDOUT_PIPE);
            proc.communicate_utf8_async(null, null, (sub, result) => {
                let latest = null;
                let url = null;
                let tag = null;
                try {
                    const [, stdout] = sub.communicate_utf8_finish(result);
                    const json = JSON.parse(stdout || '');
                    tag = json.tag_name || '';
                    url = json.html_url || '';
                    const m = String(tag).match(/^v?(\d+)\.(\d+)$/);
                    if (m) latest = parseInt(m[1], 10) * 100 + parseInt(m[2], 10);
                } catch (_e) {}
                updateButton.sensitive = true;
                if (!latest) {
                    updateStatus.label = _('Could not reach GitHub — try again later');
                    return;
                }
                const installed = Number(this.metadata?.version) || 0;
                const ver = (n) => `v${Math.floor(n / 100)}.${n % 100}`;
                if (latest <= installed) {
                    updateStatus.label = _('Plaid is up to date');
                    return;
                }
                updateStatus.label = `${ver(latest)} is available`;
                const dialog = new Adw.AlertDialog({
                    heading: `Plaid ${ver(latest)} is available`,
                    body: _("You're running %s. What would you like to do?").replace('%s', ver(installed)),
                });
                dialog.add_response('update', _('Run plaid-update'));
                dialog.add_response('open', _('Open release page'));
                dialog.add_response('close', _('Close'));
                dialog.set_default_response('update');
                dialog.set_close_response('close');
                dialog.connect('response', (dlg, response) => {
                    settings.set_int('release-check-dismissed', latest);
                    if (response === 'update') {
                        launchUpdateTerminal();
                    } else if (response === 'open') {
                        try {
                            Gio.AppInfo.launch_default_for_uri(url, null);
                        } catch (_e) {}
                    }
                });
                dialog.present(window);
            });
        };
        updateButton.connect('clicked', runUpdateCheck);

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

        const singleEdgeRow = new Adw.ActionRow({
            title: _('Single Window Edges'),
            subtitle: _('Gap between a single tiled window and each screen edge'),
        });
        const edgeGrid = new Gtk.Grid({
            column_spacing: 8,
            row_spacing: 4,
            halign: Gtk.Align.FILL,
            hexpand: true,
        });
        const edgeLabels = [
            ['single-gap-top', _('Top')],
            ['single-gap-bottom', _('Bottom')],
            ['single-gap-left', _('Left')],
            ['single-gap-right', _('Right')],
        ];
        edgeLabels.forEach(([key, label], idx) => {
            const row = Math.floor(idx / 2);
            const col = (idx % 2) * 2;
            const labelWidget = new Gtk.Label({
                label,
                css_classes: ['dim-label'],
                xalign: 1,
            });
            labelWidget.width_request = 56;
            const spin = new Gtk.SpinButton({
                adjustment: new Gtk.Adjustment({
                    lower: 0,
                    upper: 200,
                    step_increment: 1,
                    page_increment: 10,
                    value: settings.get_int(key),
                }),
                width_request: 70,
                valign: Gtk.Align.CENTER,
            });
            edgeGrid.attach(labelWidget, col, row, 1, 1);
            edgeGrid.attach(spin, col + 1, row, 1, 1);
            settings.bind(key, spin, 'value', Gio.SettingsBindFlags.DEFAULT);
        });
        singleEdgeRow.add_suffix(edgeGrid);
        group.add(singleEdgeRow);

        const layoutNames = ['dwindle', 'master-stack', 'centered-master-stack', 'floating'];
        const layoutCaptions = {
            'dwindle': _('Dwindle'),
            'master-stack': _('Master-stack'),
            'centered-master-stack': _('Centered Master-stack'),
            'floating': _('Floating'),
        };
        const previewDrawings = new Map();
        const refreshLayoutPreviews = () => {
            for (const drawing of previewDrawings.values())
                drawing.queue_draw();
        };
        const selectLayout = (layout) => {
            settings.set_string('layout', layout);
            updateRatioVisibility();
            refreshLayoutPreviews();
        };

        const layoutRow = new Adw.PreferencesRow();
        const layoutBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            halign: Gtk.Align.CENTER,
            margin_top: 10,
            margin_bottom: 10,
        });
        layoutRow.set_child(layoutBox);
        group.add(layoutRow);

        for (const layout of layoutNames) {
            layoutBox.append(this._buildLayoutPreviewCard(
                settings, layout, layoutCaptions[layout],
                () => selectLayout(layout), previewDrawings));
        }

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
            masterRatioRow.set_visible(layout === 'master-stack' || layout === 'centered-master-stack');
        };
        updateRatioVisibility();
        settings.connect('changed::layout', () => {
            updateRatioVisibility();
            refreshLayoutPreviews();
        });

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

    _buildLayoutPreviewCard(settings, layout, caption, onSelect, previewDrawings) {
        const drawing = new Gtk.DrawingArea({
            width_request: 140,
            height_request: 80,
            content_width: 140,
            content_height: 80,
        });
        previewDrawings.set(layout, drawing);

        drawing.set_draw_func((area, cr, width, height) => {
            const pad = 5;
            const gap = 3;
            const x0 = pad;
            const y0 = pad;
            const W = width - pad * 2;
            const H = height - pad * 2;

            if (settings.get_string('layout') === layout) {
                let accent = { red: 0.2, green: 0.5, blue: 0.9, alpha: 1 };
                try {
                    const ctx = area.get_style_context();
                    const [ok, color] = ctx.lookup_color('accent_color');
                    if (ok) accent = color;
                } catch (_e) {}
                cr.setSourceRGBA(accent.red, accent.green, accent.blue, accent.alpha);
                cr.setLineWidth(2);
                cr.rectangle(1, 1, width - 2, height - 2);
                cr.stroke();
            }

            const rect = (x, y, w, h) => {
                cr.setSourceRGBA(0.5, 0.5, 0.5, 0.4);
                cr.rectangle(x, y, w, h);
                cr.fill();
            };

            if (layout === 'dwindle') {
                const r = 0.618;
                const aw = Math.floor(W * r);
                const ah = Math.floor(H * r);
                const lw1 = Math.floor(aw * r);
                rect(x0, y0, lw1, ah);
                rect(x0 + lw1 + gap, y0, aw - lw1 - gap, ah);
                rect(x0, y0 + ah + gap, aw, H - ah - gap);
                rect(x0 + aw + gap, y0, W - aw - gap, ah);
                rect(x0 + aw + gap, y0 + ah + gap, W - aw - gap, H - ah - gap);
            } else if (layout === 'master-stack') {
                const mw = Math.floor(W * 0.5);
                rect(x0, y0, mw, H);
                const sx = x0 + mw + gap;
                const sw = W - mw - gap;
                const sh = Math.floor((H - gap * 2) / 3);
                for (let i = 0; i < 3; i++)
                    rect(sx, y0 + i * (sh + gap), sw, sh);
            } else if (layout === 'centered-master-stack') {
                const mw = Math.floor(W * 0.4);
                const mx = x0 + Math.floor((W - mw) / 2);
                rect(mx, y0, mw, H);
                const lw = mx - x0 - gap;
                const rx = mx + mw + gap;
                const rw = W - (mx + mw - x0) - gap;
                const sh = Math.floor((H - gap) / 2);
                if (lw > 0) {
                    rect(x0, y0, lw, sh);
                    rect(x0, y0 + sh + gap, lw, H - sh - gap);
                }
                if (rw > 0) {
                    rect(rx, y0, rw, sh);
                    rect(rx, y0 + sh + gap, rw, H - sh - gap);
                }
            } else if (layout === 'floating') {
                const cw = Math.floor(W * 0.52);
                const ch = Math.floor(H * 0.52);
                const step = 9;
                rect(x0 + step * 2, y0 + step * 2, cw, ch);
                rect(x0 + step, y0 + step, cw, ch);
                rect(x0, y0, cw, ch);
            }
        });

        drawing.tooltip_text = caption;
        try { drawing.set_cursor_from_name('pointer'); } catch (_e) {}
        const gesture = new Gtk.GestureClick();
        gesture.connect('pressed', () => onSelect());
        drawing.add_controller(gesture);

        const card = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
        });
        card.append(drawing);
        card.append(new Gtk.Label({
            label: caption,
            css_classes: ['dim-label'],
        }));
        return card;
    }

    _buildFlairPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Flair'),
            icon_name: 'applications-graphics-symbolic',
        });
        window.add(page);

        const compatGroup = new Adw.PreferencesGroup({
            title: _('Compatibility'),
        });
        page.add(compatGroup);

        const compatRow = new Adw.ActionRow({
            title: _('Disable other window-effect extensions'),
            subtitle: _('Plaid handles window borders, rounded corners, and blur itself. Other window-effect extensions may conflict visually — e.g., Rounded Window Corners Reborn, Blur My Shell, Burn-My-Windows, Compiz effects, and similar.'),
            icon_name: 'dialog-warning-symbolic',
        });
        compatGroup.add(compatRow);

        const mainGroup = new Adw.PreferencesGroup({
            title: _('Window Borders'),
        });
        page.add(mainGroup);

        const showBordersRow = new Adw.SwitchRow({
            title: _('Show Borders'),
            subtitle: _('Draw borders around windows (rounded corners still apply if enabled)'),
        });
        mainGroup.add(showBordersRow);
        settings.bind('borders-enabled', showBordersRow, 'active', Gio.SettingsBindFlags.DEFAULT);

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

        const activeColor2Row = this._buildColorRow(
            settings, 'active-border-color-2', _('Border Color 2')
        );
        activeGroup.add(activeColor2Row);

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

        const inactiveColor2Row = this._buildColorRow(
            settings, 'inactive-border-color-2', _('Border Color 2')
        );
        inactiveGroup.add(inactiveColor2Row);

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

        const roundedRow = new Adw.SwitchRow({
            title: _('Rounded Corners'),
            subtitle: _('Mask window content corners to match the border radius'),
        });
        styleGroup.add(roundedRow);
        settings.bind('rounded-corners', roundedRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const gradientRow = new Adw.SwitchRow({
            title: _('Gradient Borders'),
            subtitle: _('Use a gradient between the two border colors'),
        });
        styleGroup.add(gradientRow);
        settings.bind('gradient-borders', gradientRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const directionModel = new Gtk.StringList({
            strings: ['vertical', 'horizontal', 'diagonal'],
        });
        const directionLabels = {
            'vertical': _('Vertical'),
            'horizontal': _('Horizontal'),
            'diagonal': _('Diagonal'),
        };
        const directionRow = new Adw.ComboRow({
            title: _('Gradient Direction'),
            subtitle: _('Direction of the border gradient'),
            model: directionModel,
        });
        styleGroup.add(directionRow);
        const directionIdx = ['vertical', 'horizontal', 'diagonal'].indexOf(settings.get_string('gradient-direction'));
        if (directionIdx >= 0)
            directionRow.set_selected(directionIdx);
        directionRow.connect('notify::selected', () => {
            const idx = directionRow.get_selected();
            const dirs = ['vertical', 'horizontal', 'diagonal'];
            if (idx >= 0 && idx < dirs.length)
                settings.set_string('gradient-direction', dirs[idx]);
        });

        const animSpeedRow = new Adw.SpinRow({
            title: _('Animation Speed'),
            subtitle: _('Speed of the gradient border rotation (0 = off, 10 = fastest)'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 10,
                step_increment: 1,
                page_increment: 2,
                value: settings.get_int('border-animation-speed'),
            }),
        });
        styleGroup.add(animSpeedRow);
        settings.bind('border-animation-speed', animSpeedRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const updateGradientVisibility = () => {
            const gradient = settings.get_boolean('gradient-borders');
            activeColor2Row.set_sensitive(gradient);
            inactiveColor2Row.set_sensitive(gradient);
            directionRow.set_visible(gradient);
            animSpeedRow.set_visible(gradient);
        };
        updateGradientVisibility();
        settings.connect('changed::gradient-borders', () => updateGradientVisibility());

        const blurGroup = new Adw.PreferencesGroup({
            title: _('Window Blur'),
        });
        page.add(blurGroup);

        const blurRow = new Adw.SwitchRow({
            title: _('Blur Windows'),
            subtitle: _('Blur the content behind windows using the shell\'s native blur'),
        });
        blurGroup.add(blurRow);
        settings.bind('window-blur', blurRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const blurRadiusRow = new Adw.SpinRow({
            title: _('Blur Radius'),
            subtitle: _('Strength of the blur in pixels'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 30,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('window-blur-radius'),
            }),
        });
        blurGroup.add(blurRadiusRow);
        settings.bind('window-blur-radius', blurRadiusRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const blurBrightnessRow = new Adw.SpinRow({
            title: _('Blur Brightness'),
            subtitle: _('Brightness of the blurred layer'),
            digits: 2,
            adjustment: new Gtk.Adjustment({
                lower: 0.1,
                upper: 1.0,
                step_increment: 0.05,
                page_increment: 0.1,
                value: settings.get_double('window-blur-brightness'),
            }),
        });
        blurGroup.add(blurBrightnessRow);
        settings.bind('window-blur-brightness', blurBrightnessRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const blurOpacityRow = new Adw.SpinRow({
            title: _('Window Opacity'),
            subtitle: _('Opacity of window content over the blurred layer (lower values soften the whole window, including text)'),
            adjustment: new Gtk.Adjustment({
                lower: 30,
                upper: 100,
                step_increment: 1,
                page_increment: 10,
                value: settings.get_int('window-blur-opacity'),
            }),
        });
        blurGroup.add(blurOpacityRow);
        settings.bind('window-blur-opacity', blurOpacityRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const updateBlurVisibility = () => {
            const blur = settings.get_boolean('window-blur');
            blurRadiusRow.set_visible(blur);
            blurBrightnessRow.set_visible(blur);
            blurOpacityRow.set_visible(blur);
        };
        updateBlurVisibility();
        settings.connect('changed::window-blur', () => updateBlurVisibility());

        const ddtGroup = new Adw.PreferencesGroup({
            title: _('Drop-Down Terminal'),
        });
        page.add(ddtGroup);

        const ddtCommandRow = new Adw.EntryRow({
            title: _('Terminal Command'),
        });
        ddtCommandRow.set_text(settings.get_string('dropdown-terminal-command'));
        ddtGroup.add(ddtCommandRow);
        settings.bind('dropdown-terminal-command', ddtCommandRow, 'text', Gio.SettingsBindFlags.DEFAULT);

        const ddtHeightRow = new Adw.SpinRow({
            title: _('Terminal Height'),
            subtitle: _('Height of the drop-down terminal as a percentage of the screen'),
            adjustment: new Gtk.Adjustment({
                lower: 20,
                upper: 80,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('dropdown-terminal-height'),
            }),
        });
        ddtGroup.add(ddtHeightRow);
        settings.bind('dropdown-terminal-height', ddtHeightRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const bgAppGroup = new Adw.PreferencesGroup({
            title: _('Background App'),
        });
        page.add(bgAppGroup);

        const bgAppEnabledRow = new Adw.SwitchRow({
            title: _('Enabled'),
        });
        bgAppGroup.add(bgAppEnabledRow);
        settings.bind('background-app-enabled', bgAppEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const bgAppRow = new Adw.ActionRow({
            title: _('Command'),
            subtitle: _('Pinned behind all windows as a live desktop background. Looks best with frameless windows.'),
        });
        const bgAppEntry = new Gtk.Entry({
            text: settings.get_string('background-app'),
            hexpand: true,
            width_request: 320,
            valign: Gtk.Align.CENTER,
        });
        bgAppRow.add_suffix(bgAppEntry);
        bgAppGroup.add(bgAppRow);
        settings.bind('background-app', bgAppEntry, 'text', Gio.SettingsBindFlags.GET);

        const commitBgAppCommand = () => {
            const text = bgAppEntry.get_text().trim();
            if (settings.get_string('background-app') !== text)
                settings.set_string('background-app', text);
        };
        bgAppEntry.connect('activate', () => commitBgAppCommand());
        bgAppEntry.connect('notify::has-focus', () => {
            if (!bgAppEntry.has_focus) commitBgAppCommand();
        });
        bgAppEnabledRow.connect('notify::active', () => commitBgAppCommand());

        const historyButton = new Gtk.MenuButton({
            valign: Gtk.Align.CENTER,
            icon_name: 'document-open-recent-symbolic',
            tooltip_text: _('Recent commands'),
        });
        const rebuildHistory = () => {
            const history = [...settings.get_strv('background-app-history')];
            const current = settings.get_string('background-app').trim();
            const items = history.filter((c) => c && c !== current);
            if (current) items.unshift(current);

            const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
            box.set_margin_top(8);
            box.set_margin_bottom(8);
            box.set_margin_start(8);
            box.set_margin_end(8);

            if (items.length === 0) {
                const emptyLabel = new Gtk.Label({
                    label: _('No recent commands'),
                    margin_top: 4,
                    margin_bottom: 4,
                    margin_start: 12,
                    margin_end: 12,
                    opacity: 0.6,
                });
                box.append(emptyLabel);
            } else {
                for (const cmd of items) {
                    const btn = new Gtk.Button({
                        label: cmd,
                        hexpand: true,
                        halign: Gtk.Align.FILL,
                        css_classes: ['flat'],
                        tooltip_text: cmd,
                    });
                    btn.connect('clicked', () => {
                        bgAppEntry.set_text(cmd);
                        commitBgAppCommand();
                        historyButton.popover.popdown();
                    });
                    box.append(btn);
                }
            }

            if (historyButton.popover) {
                historyButton.popover.set_child(box);
            } else {
                historyButton.popover = new Gtk.Popover({
                    child: box,
                    position: Gtk.PositionType.BOTTOM,
                });
                historyButton.set_popover(historyButton.popover);
            }
            historyButton.sensitive = items.length > 0;
        };
        rebuildHistory();
        historyButton.connect('notify::active', () => {
            if (historyButton.active) rebuildHistory();
        });
        bgAppEntry.connect('notify::text', () => rebuildHistory());
        bgAppRow.add_suffix(historyButton);
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
            xalign: 0,
        });
        label.width_request = 70;
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
        this._addShortcutRow(miscGroup, settings, 'toggle-tiling', _('Toggle Plaid'));
        this._addShortcutRow(miscGroup, settings, 'toggle-maximize', _('Toggle Maximize'));
        this._addShortcutRow(miscGroup, settings, 'cycle-layout', _('Cycle Layout'));
        this._addShortcutRow(miscGroup, settings, 'center-window', _('Center Window'));
        this._addShortcutRow(miscGroup, settings, 'pick-float-window', _('Pick Window to Float'));
        this._addShortcutRow(miscGroup, settings, 'scratchpad-toggle', _('Toggle Scratchpad'));
        this._addShortcutRow(miscGroup, settings, 'scratchpad-add', _('Add Window to Scratchpad'));
        this._addShortcutRow(miscGroup, settings, 'scratchpad-remove', _('Remove Window from Scratchpad'));
        this._addShortcutRow(miscGroup, settings, 'dropdown-terminal', _('Toggle Drop-Down Terminal'));
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

        const minSizeGroup = new Adw.PreferencesGroup({
            title: _('Minimum Window Sizes'),
            description: _('Hard minimum sizes for window classes or exact titles that do not report them (e.g. Steam:1364x810)'),
        });
        page.add(minSizeGroup);
        this._minSizeRows = [];

        const addMinSizeRow = new Adw.ActionRow({
            title: _('Add Minimum Size'),
            activatable: true,
        });
        const addMinSizeButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            css_classes: ['suggested-action', 'circular'],
            can_target: false,
        });
        addMinSizeRow.add_suffix(addMinSizeButton);
        minSizeGroup.add(addMinSizeRow);

        addMinSizeRow.connect('activated', () => {
            this._showAddMinSizeDialog(window, settings, minSizeGroup, addMinSizeRow);
        });

        this._rebuildMinSizeList(settings, minSizeGroup, addMinSizeRow);
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
            margin_top: 12,
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

    _rebuildMinSizeList(settings, group, addRow) {
        for (const row of this._minSizeRows)
            group.remove(row);
        this._minSizeRows = [];

        const entries = settings.get_strv('min-window-sizes');
        for (const entry of entries) {
            const row = new Adw.ActionRow({
                title: entry,
                activatable: false,
            });
            const removeBtn = new Gtk.Button({
                icon_name: 'list-remove-symbolic',
                css_classes: ['flat', 'circular'],
            });
            removeBtn.connect('clicked', () => {
                const current = new Set(settings.get_strv('min-window-sizes'));
                current.delete(entry);
                settings.set_strv('min-window-sizes', [...current]);
                this._rebuildMinSizeList(settings, group, addRow);
            });
            row.add_suffix(removeBtn);
            group.add(row);
            this._minSizeRows.push(row);
        }
    }

    _showAddMinSizeDialog(window, settings, group, addRow) {
        const dialog = new Adw.Window({
            modal: true,
            transient_for: window,
            title: _('Add Minimum Window Size'),
            default_width: 400,
            default_height: 180,
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 24,
            margin_bottom: 24,
            margin_start: 24,
            margin_end: 24,
        });

        const classEntry = new Gtk.Entry({
            placeholder_text: _('WM_CLASS instance or exact window title (e.g. Steam)'),
            hexpand: true,
        });
        box.append(classEntry);

        const sizeEntry = new Gtk.Entry({
            placeholder_text: _('Width x Height (e.g. 1364x810)'),
            hexpand: true,
        });
        box.append(sizeEntry);

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
            const cls = classEntry.get_text().trim().toLowerCase();
            const size = sizeEntry.get_text().trim();
            const m = /^(\d+)x(\d+)$/.exec(size);
            if (cls.length > 0 && m) {
                const entry = `${cls}:${m[1]}x${m[2]}`;
                const current = new Set(settings.get_strv('min-window-sizes'));
                current.add(entry);
                settings.set_strv('min-window-sizes', [...current]);
                this._rebuildMinSizeList(settings, group, addRow);
            }
            dialog.close();
        });
        btnBox.append(addBtn);

        sizeEntry.connect('activate', () => addBtn.emit('clicked'));

        box.append(btnBox);
        dialog.set_content(box);
        dialog.present();

        classEntry.grab_focus();
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
