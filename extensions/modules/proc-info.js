// Async /proc reads with per-extension caches.
//
// Process identity (cmdline/environ) is needed at window-add and hover time,
// but synchronous reads block the compositor main loop. The helpers read
// asynchronously and cache by PID, so callers can use a cached verdict and
// fall back to a conservative answer until the first read settles.

import Gio from 'gi://Gio';

const CACHE_LIMIT = 256;

export function readProcFile(path, callback) {
    let file = null;
    try {
        file = Gio.File.new_for_path(path);
    } catch (_e) {
        callback(null);
        return;
    }
    file.load_contents_async(null, (f, res) => {
        let data = null;
        try {
            const [ok, bytes] = f.load_contents_finish(res);
            if (ok)
                data = bytes;
        } catch (_e) {}
        callback(data);
    });
}

export function readProcFilePromise(path) {
    return new Promise((resolve) => readProcFile(path, resolve));
}

export const procInfoMethods = {
    _procCaches() {
        if (!this._procCmdlineCache) {
            this._procCmdlineCache = new Map();
            this._procCmdlineWaiters = new Map();
            this._procEnvironCache = new Map();
            this._procEnvironWaiters = new Map();
        }
    },

    _readProcAsync(path, callback) {
        readProcFile(path, callback);
    },

    _readProcFilePromise(path) {
        return readProcFilePromise(path);
    },

    _getProcCmdline(pid, callback) {
        if (!pid) {
            callback('');
            return;
        }
        this._procCaches();
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
        this._readProcAsync(`/proc/${pid}/cmdline`, (data) => {
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
            for (const cb of callbacks) {
                try {
                    cb(cmd);
                } catch (_e) {}
            }
        });
    },

    _procCmdlineCached(pid) {
        if (!pid) return '';
        this._procCaches();
        return this._procCmdlineCache.get(pid);
    },

    _getProcEnviron(pid, callback) {
        if (!pid) {
            callback('');
            return;
        }
        this._procCaches();
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
        this._readProcAsync(`/proc/${pid}/environ`, (data) => {
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
            for (const cb of callbacks) {
                try {
                    cb(env);
                } catch (_e) {}
            }
        });
    },

    _procEnvironCached(pid) {
        if (!pid) return '';
        this._procCaches();
        return this._procEnvironCache.get(pid);
    },
};
