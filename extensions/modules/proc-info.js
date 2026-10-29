// Async /proc reads with per-extension caches. Process identity is needed at
// window-add and hover time; synchronous reads would block the compositor.

import Gio from 'gi://Gio';

const CACHE_LIMIT = 256;

export function readProcFile(path, callback) {
    const file = Gio.File.new_for_path(path);
    file.load_contents_async(null, (f, res) => {
        let data = null;
        try {
            const [ok, bytes] = f.load_contents_finish(res);
            if (ok)
                data = bytes;
        } catch (e) {
            // A cancelled/failed /proc read is expected while processes exit.
        }
        callback(data);
    });
}

export function readProcFilePromise(path) {
    return new Promise((resolve) => readProcFile(path, resolve));
}

export class ProcInfo {
    constructor(core) {
        this.core = core;
        this._procCmdlineCache = new Map();
        this._procCmdlineWaiters = new Map();
        this._procEnvironCache = new Map();
        this._procEnvironWaiters = new Map();
    }

    readProcFilePromise(path) {
        return readProcFilePromise(path);
    }

    getProcCmdline(pid, callback) {
        if (!pid) {
            callback('');
            return;
        }
        if (this._procCmdlineCache.has(pid)) {
            callback(this._procCmdlineCache.get(pid));
            return;
        }
        const queued = this._procCmdlineWaiters.get(pid);
        if (queued) {
            queued.push(callback);
            return;
        }
        this._procCmdlineWaiters.set(pid, [callback]);
        readProcFile(`/proc/${pid}/cmdline`, (data) => {
            const cmd = data
                ? new TextDecoder().decode(data).replace(/\0/g, ' ')
                : '';
            // Do not cache a failed read; PID reuse and transient failures
            // should be retried. A successful read is process-lifetime stable.
            if (data) {
                if (this._procCmdlineCache.size >= CACHE_LIMIT) {
                    const oldest = this._procCmdlineCache.keys().next().value;
                    this._procCmdlineCache.delete(oldest);
                }
                this._procCmdlineCache.set(pid, cmd);
            }
            const callbacks = this._procCmdlineWaiters.get(pid) || [];
            this._procCmdlineWaiters.delete(pid);
            for (const cb of callbacks)
                cb(cmd);
        });
    }

    procCmdlineCached(pid) {
        if (!pid) return '';
        return this._procCmdlineCache.get(pid);
    }

    getProcEnviron(pid, callback) {
        if (!pid) {
            callback('');
            return;
        }
        if (this._procEnvironCache.has(pid)) {
            callback(this._procEnvironCache.get(pid));
            return;
        }
        const queued = this._procEnvironWaiters.get(pid);
        if (queued) {
            queued.push(callback);
            return;
        }
        this._procEnvironWaiters.set(pid, [callback]);
        readProcFile(`/proc/${pid}/environ`, (data) => {
            const env = data ? new TextDecoder().decode(data) : '';
            if (data) {
                if (this._procEnvironCache.size >= CACHE_LIMIT) {
                    const oldest = this._procEnvironCache.keys().next().value;
                    this._procEnvironCache.delete(oldest);
                }
                this._procEnvironCache.set(pid, env);
            }
            const callbacks = this._procEnvironWaiters.get(pid) || [];
            this._procEnvironWaiters.delete(pid);
            for (const cb of callbacks)
                cb(env);
        });
    }

    procEnvironCached(pid) {
        if (!pid) return '';
        return this._procEnvironCache.get(pid);
    }

    destroy() {
        this._procCmdlineCache.clear();
        this._procCmdlineWaiters.clear();
        this._procEnvironCache.clear();
        this._procEnvironWaiters.clear();
    }
}
