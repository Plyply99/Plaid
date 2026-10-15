// Terminal settings integration — optionally source the Plaid terminal
// settings functions from the user's shell profile. Opt-in, off by default.
//
// Methods are attached to TilingWMExtension.prototype in extension.js.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export function _ensureTerminalSettingsProfile() {
    // Install the terminal settings source line into the user's shell
    // profile based on $SHELL. Bash and fish are auto-injected; other
    // shells get a click-to-dismiss notice with the manual instruction.
    try {
        const scriptPath = `${this.path}/plaid-terminal-settings.sh`;
        const shell = (GLib.getenv('SHELL') || '').toLowerCase();
        const base = shell.split('/').pop() || shell;
        if (base === 'bash') {
            const block = `\n# --- Plaid: terminal settings ---\n[ -f '${scriptPath}' ] && source '${scriptPath}'\n# --- end Plaid ---\n`;
            const written = this._appendToShellProfile(`${GLib.get_home_dir()}/.bashrc`, block);
            if (written) {
                log('[plaid] terminal settings: bash profile updated');
                this._plaidSetupNoticeTerminal = true;
                this._scheduleSetupPopupCheck();
            }
            return;
        }
        if (base === 'fish') {
            const fishScript = `${this.path}/plaid-terminal-settings.fish`;
            const block = `\n# --- Plaid: terminal settings ---\nif test -f '${fishScript}'\n    source '${fishScript}'\nend\n# --- end Plaid ---\n`;
            const written = this._appendToShellProfile(`${GLib.get_home_dir()}/.config/fish/config.fish`, block);
            if (written) {
                log('[plaid] terminal settings: fish profile updated');
                this._plaidSetupNoticeTerminal = true;
                this._scheduleSetupPopupCheck();
            }
            return;
        }
        if (this._plaidTerminalProfileNotified) return;
        this._plaidTerminalProfileNotified = true;
        if (base === 'zsh') {
            this._showWarningPopup('Plaid Terminal Settings',
                `Add this line to ~/.zshrc:\n[ -f '${scriptPath}' ] && source '${scriptPath}'`,
                'Click to dismiss');
        } else {
            this._showWarningPopup('Plaid Terminal Settings',
                `Plaid's terminal settings support bash, zsh and fish. Your shell (${base}) needs manual setup — see the wiki → Terminal Settings.`,
                'Click to dismiss');
        }
    } catch (e) {
        log(`[plaid] terminal settings profile failed: ${e.message}`);
    }
}

export function _appendToShellProfile(path, block) {
    try {
        const f = Gio.File.new_for_path(path);
        let contents = '';
        if (f.query_exists(null)) {
            const [, data] = f.load_contents(null);
            if (data)
                contents = new TextDecoder().decode(data);
        }
        if (contents.includes('# --- Plaid: terminal settings ---')) return false;
        f.replace_contents(
            new TextEncoder().encode(contents + block), null, false,
            Gio.FileCreateFlags.NONE, null);
        return true;
    } catch (e) {
        log(`[plaid] terminal settings: profile write failed: ${e.message}`);
        return false;
    }
}

export const terminalSettingsMethods = {
    _ensureTerminalSettingsProfile,
    _appendToShellProfile,
};
