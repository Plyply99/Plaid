// Terminal settings integration — optionally source the Plaid terminal
// settings functions from the user's shell profile. Opt-in, off by default;
// the setting writes the source line on enable and strips it on disable.
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
            const profile = `${GLib.get_home_dir()}/.bashrc`;
            const block = `\n# --- Plaid: terminal settings ---\n[ -f '${scriptPath}' ] && source '${scriptPath}'\n# --- end Plaid ---\n`;
            if (this._appendToShellProfile(profile, block)) {
                this._noteTerminalProfile(profile);
            }
            return;
        }
        if (base === 'fish') {
            const fishScript = `${this.path}/plaid-terminal-settings.fish`;
            const profile = `${GLib.get_home_dir()}/.config/fish/config.fish`;
            const block = `\n# --- Plaid: terminal settings ---\nif test -f '${fishScript}'\n    source '${fishScript}'\nend\n# --- end Plaid ---\n`;
            if (this._appendToShellProfile(profile, block)) {
                this._noteTerminalProfile(profile);
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

export function _noteTerminalProfile(profile) {
    // Remember that the shell profile changed so the setup popup can name it.
    log(`[plaid] terminal settings: profile updated (${profile})`);
    this._plaidSetupNoticeTerminal = true;
    this._plaidTerminalProfilePath = profile;
    this._scheduleSetupPopupCheck();
}

export function _removeTerminalSettingsProfile() {
    // Undo the source line when the user turns the setting off. Strips the
    // block from whichever profile has it; safe to call when none do.
    const home = GLib.get_home_dir();
    this._removeFromShellProfile(`${home}/.bashrc`);
    this._removeFromShellProfile(`${home}/.config/fish/config.fish`);
    // A notice queued by the enable path would now be misleading.
    this._plaidSetupNoticeTerminal = false;
    this._plaidTerminalProfilePath = '';
}

export function _removeFromShellProfile(path) {
    try {
        const f = Gio.File.new_for_path(path);
        if (!f.query_exists(null))
            return false;
        const [, data] = f.load_contents(null);
        if (!data)
            return false;
        const lines = new TextDecoder().decode(data).split('\n');
        let changed = false;
        for (;;) {
            const start = lines.findIndex(l => l.trim() === '# --- Plaid: terminal settings ---');
            if (start < 0) break;
            const end = lines.findIndex((l, i) => i > start && l.trim() === '# --- end Plaid ---');
            // A start marker whose block was not written by us (an earlier start
            // marker before its end marker) means the file is not the shape we
            // expect — leave it alone rather than delete unrelated lines.
            if (end < 0 || lines.slice(start + 1, end).some(l => l.trim() === '# --- Plaid: terminal settings ---'))
                break;
            // Drop the block plus the blank line the append inserted before it.
            const from = (start > 0 && lines[start - 1] === '') ? start - 1 : start;
            lines.splice(from, end - from + 1);
            changed = true;
        }
        if (!changed)
            return false;
        f.replace_contents(
            new TextEncoder().encode(lines.join('\n')), null, false,
            Gio.FileCreateFlags.NONE, null);
        log(`[plaid] terminal settings: removed source block (${path})`);
        return true;
    } catch (e) {
        log(`[plaid] terminal settings: profile cleanup failed: ${e.message}`);
        return false;
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
    _noteTerminalProfile,
    _removeTerminalSettingsProfile,
    _removeFromShellProfile,
    _appendToShellProfile,
};
