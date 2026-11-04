// Auto-update from the project's GitHub releases. Checks the latest release,
// downloads its zip, and installs it with gnome-extensions; the new version
// loads on the next login.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { PlaidSubsystem } from './subsystem.js';

const RELEASES_API = 'https://api.github.com/repos/Plyply99/Plaid/releases/latest';
const ASSET_NAME = 'plaid@plyply99.zip';
const UPDATE_MESSAGE = 'Log out and back in to apply.';
const UPDATE_FAILED = 'Could not install the update. Check the release page.';

export class Updater extends PlaidSubsystem {
    constructor(core) {
        super(core);
        this._destroyed = false;
    }

    async checkForUpdates() {
        if (this._destroyed || this.core._shuttingDown || !this.core._settings)
            return;
        // A system-wide install is managed externally; never overwrite it
        // with a self-update.
        if (this.core.ext.path.startsWith('/usr/share/'))
            return;
        if (!this.core._settings.get_boolean('release-check-enabled'))
            return;

        let updateFound = false;
        try {
            const stdout = await this._communicate(
                ['curl', '-sL', '--max-time', '10', RELEASES_API]);
            if (this._destroyed)
                return;
            const json = JSON.parse(stdout || '');
            const tag = String(json.tag_name || '');
            const version = tag.match(/^v?(\d+)\.(\d+)$/);
            if (!version)
                return;
            const latest = parseInt(version[1], 10) * 100 + parseInt(version[2], 10);
            const installed = parseInt(this.core.ext.metadata.version, 10);
            if (latest <= installed)
                return;
            let assetUrl = null;
            for (const asset of (json.assets || [])) {
                if (asset.name === ASSET_NAME) {
                    assetUrl = asset.browser_download_url || null;
                    break;
                }
            }
            if (!assetUrl) {
                Main.notify('Plaid update failed',
                    'Could not find the update zip. Check the release page.');
                return;
            }
            updateFound = true;
            await this._install(assetUrl, version[1], version[2]);
        } catch (e) {
            if (updateFound && !this._destroyed)
                Main.notify('Plaid update failed', UPDATE_FAILED);
            else
                this.core.debugLog(`update: check failed: ${e.message}`);
        }
    }

    async _install(assetUrl, major, minor) {
        const zipPath = `${GLib.get_home_dir()}/Downloads/${ASSET_NAME}`;
        await this._run(['curl', '-sfL', '--max-time', '60', '-o', zipPath, assetUrl]);
        if (this._destroyed)
            return;
        await this._run(['gnome-extensions', 'install', '--force', zipPath]);
        if (!this._destroyed)
            Main.notify(`Plaid v${major}.${minor} available`, UPDATE_MESSAGE);
    }

    _communicate(argv) {
        return new Promise((resolve, reject) => {
            // A spawn failure rejects the promise (the executor catches it).
            const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE);
            proc.communicate_utf8_async(null, null, (sub, res) => {
                try {
                    const [, stdout] = sub.communicate_utf8_finish(res);
                    resolve(stdout || '');
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    _run(argv) {
        return new Promise((resolve, reject) => {
            const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
            proc.wait_check_async(null, (sub, res) => {
                try {
                    sub.wait_check_finish(res);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    destroy() {
        this._destroyed = true;
        super.destroy();
    }
}
