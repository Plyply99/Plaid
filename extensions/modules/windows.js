// Window lifecycle: management policy, float rules, window signals, workspace
// ordering, spawn hide, and float layering. Methods are attached to
// TilingWMExtension.prototype in extension.js.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

export function _shouldManage(win) {
    if (this._dropdownWin === win ||
        (this._dropdownWaiters && this._dropdownWaiters.has(win))) return false;
    if (this._backgroundAppWin === win) return false;
    // The bg-app window must never be tiled — even mid-cycle when the new
    // instance hasn't claimed it yet (its skip_taskbar state does not
    // reliably survive a lock cycle). The PLAID_BGAPP env marker on the
    // process identifies it precisely — never the class/token, so user
    // windows of the same app (ghostty) are never excluded.
    try {
        if (this._isBgAppProcessWindow(win))
            return false;
    } catch (_e) {}
    const title = win.get_title();
    if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
    if (win.is_skip_taskbar()) return false;
    if (win.get_transient_for()) return false;
    // The GNOME Extensions app (and its Plaid prefs window) is a settings
    // dialog — keep it out of the tiler so opening prefs never re-arranges
    // the workspace. The process cmdline match works at add time (before
    // the wm-class/GTK app id resolve); the class/app-id checks and the
    // late-identity backstop cover the remaining cases.
    if (this._isExtensionsAppWindow(win))
        return false;
    // Float-listed apps whose wm-class hasn't resolved yet (flatpaks
    // especially) must not be registered as tiled — the process cmdline
    // is available immediately (cached per PID).
    if (this._isFloatProcessWindow(win))
        return false;
    if (this._floatClassMatches(win)) return false;
    if (this._floatingTitleMatches(title)) return false;
    if (this._isFixedSizeWindow(win)) return false;
    return true;
}

export function _moveCursorToWindow(win) {
    try {
        const frame = win.get_frame_rect();
        if (frame.width === 0 || frame.height === 0) return false;
        const centerX = frame.x + frame.width / 2;
        const centerY = frame.y + frame.height / 2;
        // mutter-51 removed Clutter.get_default_backend (the 51.β→.rc
        // window); the context-accessor route works on both 50 and 51.
        const backend = (typeof Clutter.get_default_backend === 'function')
            ? Clutter.get_default_backend()
            : global.stage.get_context().get_backend();
        const seat = backend.get_default_seat();
        seat.warp_pointer(centerX, centerY);
        return true;
    } catch (e) {
        log(`[plaid] _moveCursorToWindow failed: ${e.message}`);
        return false;
    }
}

export function _cursorWarpDeferred(win) {
    if (!this._settings) return;
    let prevFrame = null;
    let retries = 0;
    const MAX_RETRIES = 6;
    const tryWarp = () => {
        if (!this._settings || retries >= MAX_RETRIES) return false;
        retries++;
        if (!win || !win.get_workspace()) return false;
        const frame = win.get_frame_rect();
        if (frame.width === 0 || frame.height === 0) return true;
        if (prevFrame && frame.x === prevFrame.x && frame.y === prevFrame.y &&
            frame.width === prevFrame.w && frame.height === prevFrame.h) {
            this._moveCursorToWindow(win);
            return false;
        }
        prevFrame = { x: frame.x, y: frame.y, w: frame.width, h: frame.height };
        return true;
    };
    if (tryWarp()) {
        this._addTimeout(50, tryWarp);
    }
}

export function _isFloating(win) {
    if (this._toggleFloatWindows && this._toggleFloatWindows.has(win)) return true;
    // Auto-floated because no slot could meet its real size minimum —
    // excluded from tiling until released (see _releaseMinLimitedWindows).
    if (this._minLimitedWindows && this._minLimitedWindows.has(win)) return true;
    if (this._floatClassMatches(win)) return true;
    if (this._isExtensionsAppWindow(win)) return true;
    const title = win.get_title();
    if (this._floatingTitleMatches(title)) return true;
    // Process-based fallback: at window-created the wm-class may not be
    // resolved yet (flatpak apps especially), so a float-listed app would
    // be registered as tiled and churn the retile pipeline at launch.
    // The process cmdline is available immediately — and the verdict is
    // cached per PID (process-lifetime stable).
    if (this._isFloatProcessWindow(win)) return true;
    if (win.is_fullscreen()) return true;
    if (win.get_window_type() !== Meta.WindowType.NORMAL) return true;
    if (win.is_skip_taskbar()) return true;
    if (win.get_transient_for()) return true;
    if (this._isFixedSizeWindow(win)) return true;
    return false;
}

export function _isFloatProcessWindow(win) {
    if (!win) return false;
    let pid = 0;
    try { pid = win.get_pid(); } catch (_e) {}
    if (pid <= 0) return false;
    if (this._floatProcessCache) {
        const cached = this._floatProcessCache.get(pid);
        if (cached !== undefined) return cached;
    }
    const evaluate = (cmd) => {
        if (!this._settings) return;
        const lower = (cmd || '').toLowerCase();
        let verdict = false;
        for (const token of this._floatingClasses) {
            if (!token || token.length < 3) continue;
            if (lower.includes(token)) {
                verdict = true;
                break;
            }
        }
        if (!this._floatProcessCache) return;
        if (this._floatProcessCache.size >= 256)
            this._floatProcessCache.clear();
        this._floatProcessCache.set(pid, verdict);
        if (verdict && !win._plaidProcIdentityNotified) {
            win._plaidProcIdentityNotified = true;
            this._addIdle(() => { this._onWindowIdentityChanged(win); return false; });
        }
    };
    const cachedCmd = this._procCmdlineCached(pid);
    if (cachedCmd !== undefined) {
        evaluate(cachedCmd);
        return !!this._floatProcessCache && this._floatProcessCache.get(pid) === true;
    }
    // Unknown process: register as tiled and re-evaluate once the async
    // read lands (a flatpak float rule has class/app-id fallbacks too).
    this._getProcCmdline(pid, evaluate);
    return false;
}

export function _isFixedSizeWindow(win) {
    // Non-resizable windows: Mutter refuses atomic move_resize_frame
    // placements, so tiling them only buys a ~2s retry dance before the
    // give-up float. A min===max hint is the cheap, reliable signal —
    // float such windows up front instead.
    const [mw, mh] = win.get_min_size();
    const [xw, xh] = win.get_max_size();
    return mw > 0 && xw > 0 && mw === xw && mh === xh;
}

export function _getWorkspaceOrder(workspace) {
    if (!this._workspaceOrders.has(workspace))
        this._workspaceOrders.set(workspace, []);
    return this._workspaceOrders.get(workspace);
}

export function _getWorkspaceLayout(workspace) {
    // Live overrides, remembered slot rules, and the default all live in
    // the SAME index space — the lookup is deterministic per workspace
    // index, so a recreated workspace (dynamic-workspace churn) resolves
    // identically every time. Object-keyed live entries caused layout
    // flip-flops when workspaces were removed and recreated.
    const idx = this._wsIndex(workspace);
    const live = this._workspaceLayouts.get(idx);
    if (live) return live;
    if (this._persistedLayoutByIndex && this._persistedLayoutByIndex.size > 0) {
        const rule = this._persistedLayoutByIndex.get(idx);
        if (rule) return rule;
    }
    return this._settings.get_string('layout');
}

export function _markPendingWindowInvisible(win, actor) {
    if (!this._settings || !win || !actor) {
        this._debugLog(`hide skip: ${!this._settings ? 'disabled' : 'null actor'} class=${win ? (win.get_wm_class_instance() || '?') : '?'}`);
        return;
    }
    if (!this._settings || !this._settings.get_boolean('enabled')) {
        this._debugLog('hide skip: disabled');
        return;
    }
    if (this._isFloating(win)) {
        if (this._settings.get_boolean('follow-focus') &&
            win.get_window_type() === Meta.WindowType.NORMAL)
            this._cursorWarpDeferred(win);
        this._debugLog('hide skip: floating');
        return;
    }
    if (this._getAnimationTime() <= 0) {
        this._debugLog('hide skip: anim-time 0');
        return;
    }
    if (!this._pendingWarp || !this._newWindowSet) {
        this._debugLog('hide skip: maps null');
        return;
    }
    if (!this._newWindowSet.has(win)) {
        this._debugLog('hide skip: not in newWindowSet');
        return;
    }
    try {
        // An invisible actor is never painted — even by the offscreen mask
        // pipeline — so this hide cannot be bypassed by any effect. The
        // actor opacity + mask uniform stay as belt-and-suspenders for the
        // non-mask and partial-cover paths.
        actor.visible = false;
        actor.set_opacity(0);
        this._pendingWarp.add(win);
        try {
            const effect = this._windowMasks && this._windowMasks.get(win);
            if (effect && effect.setOpacityUniform)
                effect.setOpacityUniform(0);
        } catch (_e) {}
        this._debugLog(`hide applied: ${win.get_wm_class_instance() || '?'}`);
    } catch (_e) {}
    if (!win._plaidInvisibleTimer) {
        win._plaidInvisibleTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
            win._plaidInvisibleTimer = 0;
            if (!this._settings) return GLib.SOURCE_REMOVE;
            const fr = win.get_frame_rect();
            this._debugLog(`backstop reveal: ${win.get_wm_class_instance() || '?'} ws=${this._wsIndex(win.get_workspace())} tiled=${this._windowWorkspaces.has(win)} ` +
                `frame=(${Math.round(fr.x)},${Math.round(fr.y)},${Math.round(fr.width)},${Math.round(fr.height)})`);
            if (this._pendingWarp) this._pendingWarp.delete(win);
            try {
                const a = win.get_compositor_private();
                if (a) {
                    a.visible = true;
                    a.set_opacity(255);
                }
            } catch (_e) {}
            try {
                const effect = this._windowMasks && this._windowMasks.get(win);
                if (effect && effect.setOpacityUniform)
                    effect.setOpacityUniform(1);
            } catch (_e) {}
            // The blur/flair skipped during the pending-warp window must
            // attach once the reveal fires.
            this._scheduleBorders();
            this._updateBorders();
            return GLib.SOURCE_REMOVE;
        });
    }
}

export function _addWindow(win, resume = false) {
    if (!this._settings) return;
    if (this._windowWorkspaces.has(win)) {
        // Belt-and-braces: if the maps survived a disable/enable but the
        // window signals did not (stale flag from a previous instance),
        // re-arm them instead of leaving the window deaf.
        if (!win._plaidSignalsConnected) this._connectWindowSignals(win);
        return;
    }
    this._debugLog(`ADD_WINDOW: ${this._winClassCandidates(win)[0] || '?'} title=${win.get_title() || '?'} ` +
        `skipTaskbar=${win.is_skip_taskbar()} ws=${this._wsIndex(win.get_workspace())} type=${win.get_window_type()}`);
    // Lock-cycle resumes register windows that are already on screen and
    // tiled — the new-window fade-in (opacity 0 → landing check → fade
    // back) would make every window vanish and reappear at unlock and
    // break focus. Only real new windows go through it.
    // Tiling toggled off: still REGISTER the window (so flair — borders,
    // mask, blur — keeps rendering via _workspaceOrders) but skip the
    // new-window hide/place choreography entirely. Otherwise a window
    // opened while tiling was off was force-placed at the full work-area
    // slot (and its mask opacity driven to 0 with no retile to reveal it,
    // since every retile path bails on !enabled).
    const tilingEnabled = this._settings.get_boolean('enabled');
    if (!resume && tilingEnabled) {
        this._newWindowSet.add(win);
        try { this._markPendingWindowInvisible(win, win.get_compositor_private()); } catch (_e) {}
    }
    const ws = win.get_workspace();
    this._windowWorkspaces.set(win, ws);
    this._windowWSIndices.set(win, this._wsIndex(ws));
    this._capturePosition(win);
    this._connectWindowSignals(win);
    if (ws) {
        const order = this._getWorkspaceOrder(ws);
        if (!order.includes(win)) {
            order.push(win);
        }
        if (!this._isFloating(win)) {
            const layout = this._getWorkspaceLayout(ws);
            if (layout === 'dwindle')
                this._bspInsertForWorkspace(ws, win);
        }
    }
    if (!resume && tilingEnabled) {
        // The new window must be invisible AND at its slot before the
        // compositor paints its first frame — otherwise it flashes at
        // GNOME's center spawn point. Two synchronous guarantees:
        // 1) attach the mask now (the borders update can lag behind the
        //    retile pipeline) and drive its opacity uniform to 0 — the
        //    actor opacity is ignored by the offscreen mask, but the
        //    uniform is the shader's real visibility control.
        // 2) place the window at its slot now that it is registered in
        //    the order (the retile later finds it already landed).
        try {
            const actorNow = win.get_compositor_private();
            if (actorNow && this._settings.get_boolean('rounded-corners') &&
                this._settings.get_int('border-radius') > 0) {
                this._ensureWindowMask(win, actorNow,
                    this._settings.get_int('border-radius') + 1);
                const effect = this._windowMasks && this._windowMasks.get(win);
                if (effect && effect.setOpacityUniform)
                    effect.setOpacityUniform(0);
            }
        } catch (_e) {}
        try {
            const wsNow = win.get_workspace();
            // Placement guard: a window whose identity is still
            // unresolved (no wm-class, no GTK app id) may be float-listed
            // — the class resolves AFTER window-created for flatpaks and
            // for native apps whose /usr/bin/name misses the float-list
            // token (e.g. org.gnome.nautilus vs /usr/bin/nautilus), so
            // _shouldManage registered it as tiled. Pre-mapping it at
            // the single-window full-area slot makes mutter AUTO-MAXIMIZE
            // it on map (placement area > 80% of the work area —
            // MAX_UNMAXIMIZED_WINDOW_AREA in core/place.c), and the later
            // float flip cannot restore the remembered size (the restore
            // refuses maximized windows). Unresolved windows are placed
            // by the first-frame retile, after identity resolution —
            // float-listed ones are then never touched by the tiler and
            // open at their own remembered geometry.
            const idKnown = !!(win.get_wm_class_instance() ||
                (win.get_gtk_application_id ? win.get_gtk_application_id() : ''));
            if (wsNow && idKnown && !this._isFloating(win)) {
                const slot = this._windowSlotRect(win, wsNow,
                    this._getWorkspaceLayout(wsNow),
                    wsNow.get_work_area_for_monitor(global.display.get_primary_monitor()),
                    this._settings.get_int('inside-gap'));
                if (slot && win.get_compositor_private())
                    win.move_resize_frame(true, slot.x, slot.y, slot.w, slot.h);
            }
        } catch (_e) {}
    }
}

export function _removeWindow(win) {
    if (!this._settings) return;
    const ws = this._windowWorkspaces.get(win) || win.get_workspace();
    const wmClass = win.get_wm_class_instance() || '?';
    this._debugLog(`REMOVE_WINDOW: ${wmClass} ws=${this._wsIndex(ws)}`);
    this._windowWorkspaces.delete(win);
    this._windowWSIndices.delete(win);
    this._toggleFloatWindows.delete(win);
    this._observedMinSizes?.delete(win);
    this._minLimitedWindows?.delete(win);
    win._plaidFloatAnim = false;
    // Prune the landing/choreography maps so dead windows (and the
    // actors they hold) don't linger until disable.
    if (this._landingRetries) this._landingRetries.delete(win);
    if (this._landingGivenUp) this._landingGivenUp.delete(win);
    if (this._mismatchFrames) this._mismatchFrames.delete(win);
    if (this._slotReassertTimes) this._slotReassertTimes.delete(win);
    if (this._pendingWarp) this._pendingWarp.delete(win);
    if (this._newWindowSet) this._newWindowSet.delete(win);
    if (win._plaidInvisibleTimer) {
        GLib.source_remove(win._plaidInvisibleTimer);
        win._plaidInvisibleTimer = 0;
    }
    if (win._plaidSettlePollId) {
        // The poll self-stops next tick via the _windowWorkspaces guard,
        // but remove it eagerly so no source id outlives the window.
        GLib.source_remove(win._plaidSettlePollId);
        win._plaidSettlePollId = 0;
    }
    win._plaidSettleUntil = 0;
    win._plaidSurfaceStrikes = 0;
    if (this._maximizeToggleRects) this._maximizeToggleRects.delete(win);
    this._savedRects.delete(win);
    this._scratchpadWindows.delete(win);
    this._gappedMaxSet.delete(win);
    this._floatMaxRects.delete(win);
    this._disconnectWindowSignals(win);
    this._removeBorder(win);
    for (const [workspace, lastWin] of this._lastFocusedPerWorkspace) {
        if (lastWin === win) this._lastFocusedPerWorkspace.delete(workspace);
    }
    if (ws) {
        const order = this._getWorkspaceOrder(ws);
        const idx = order.indexOf(win);
        if (idx !== -1) order.splice(idx, 1);
        const layout = this._getWorkspaceLayout(ws);
        if (layout === 'dwindle') {
            const tree = this._bspGetTree(ws);
            if (tree) this._bspTrees.set(ws, this._bspRemove(tree, win));
        }
        this._retileWorkspace(ws);
    }
}

export function _connectWindowSignals(win) {
    if (win._plaidSignalsConnected) return;
    win._plaidSignalsConnected = true;
    if (!this._windowSignals)
        this._windowSignals = new Map();
    const sigIds = [];
    sigIds.push({ emitter: win, id: win.connect('position-changed', () => {
        this._updateBorders();
        this._convertMaximizedToGaps(win);
        this._trackFloatGeometry(win);
    }) });
    sigIds.push({ emitter: win, id: win.connect('size-changed', () => {
        this._updateBorders();
        this._convertMaximizedToGaps(win);
        this._trackFloatGeometry(win);
        // Settle window (event-driven client-resize correction): a
        // freshly placed window can be re-sized by the client itself
        // (Firefox's session restore) — correct it the INSTANT the
        // size-changed fires, with the tight tolerance + direct
        // re-place. After the window settles, the normal (16px/retile)
        // path takes over so user resizes are free.
        if (win._plaidSettleUntil && win._plaidSettleUntil > Date.now()) {
            this._debugLog(`settle event: ${win.get_wm_class_instance() || '?'} remaining=${Math.round((win._plaidSettleUntil - Date.now()) / 1000)}s`);
            this._maybeReassertSlot(win, 4, 'direct');
        } else {
            this._maybeReassertSlot(win);
        }
    }) });
    sigIds.push({ emitter: win, id: win.connect('notify::wm-class', () => {
        this._onWindowIdentityChanged(win);
    }) });
    sigIds.push({ emitter: win, id: win.connect('notify::gtk-application-id', () => {
        this._onWindowIdentityChanged(win);
    }) });
    sigIds.push({ emitter: win, id: win.connect('notify::title', () => {
        this._onWindowIdentityChanged(win);
    }) });
    sigIds.push({ emitter: win, id: win.connect('notify::window-type', () => {
        this._onWindowIdentityChanged(win);
    }) });
    sigIds.push({ emitter: win, id: win.connect('unmanaged', () => this._removeWindow(win)) });
    sigIds.push({ emitter: win, id: win.connect('workspace-changed', () => {
        const oldWs = this._windowWorkspaces.get(win);
        const newWs = win.get_workspace();
        if (oldWs) {
            const order = this._getWorkspaceOrder(oldWs);
            const idx = order.indexOf(win);
            if (idx !== -1) order.splice(idx, 1);
            this._retileWorkspace(oldWs);
        }
        if (newWs) {
            const order = this._getWorkspaceOrder(newWs);
            if (!order.includes(win)) order.push(win);
            this._windowWorkspaces.set(win, newWs);
            this._windowWSIndices.set(win, this._wsIndex(newWs));
            this._retileWorkspace(newWs);
        }
    }) });
    sigIds.push({ emitter: win, id: win.connect('notify::minimized', () => {
        // Scratch members are float-class but stay in _windowWorkspaces
        // (scratch-add never un-manages them), so their minimize /
        // unminimize from the scratchpad choreography fired a workspace
        // retile here on EVERY toggle — the animated path moved the
        // blurred tiled windows around the reveal, and their
        // constraint-bound blur siblings lagged a frame → transient blur
        // smears at the trailing (right/bottom) edges of the windows
        // ("2 blur glitch areas" when revealing the
        // scratchpad). A float's minimized state never changes the tiled
        // layout — skip the retile. _scratchpadRemove still retiles
        // explicitly, so the intentional path is unaffected.
        if (this._isFloating(win)) return;
        const ws = win.get_workspace();
        if (ws) this._retileWorkspace(ws);
    }) });
    const actor = win.get_compositor_private();
    if (actor)
        sigIds.push({ emitter: actor, id: actor.connect('destroy', () => this._removeWindow(win)) });
    this._windowSignals.set(win, sigIds);
}

export function _disconnectWindowSignals(win) {
    if (!this._windowSignals) return;
    const sigIds = this._windowSignals.get(win);
    if (sigIds) {
        for (const { emitter, id } of sigIds) {
            emitter.disconnect(id);
        }
        this._windowSignals.delete(win);
    }
    win._plaidSignalsConnected = false;
}

export function _connectFloatHooks(win) {
    if (!this._settings || !this._floatHooks || this._floatHooks.has(win)) return;
    const ids = [
        win.connect('position-changed', () => {
            this._updateBorders();
            this._convertMaximizedToGaps(win);
            this._trackFloatGeometry(win);
        }),
        win.connect('size-changed', () => {
            this._updateBorders();
            this._convertMaximizedToGaps(win);
            this._trackFloatGeometry(win);
        }),
    ];
    ids.push(win.connect('unmanaged', () => {
        this._disconnectFloatHooks(win);
        // Floats never pass through _removeWindow — prune the per-window
        // state their flair created, or every closed float/popup leaks a
        // widget, an effect, and map entries for the session (and the
        // stale border map keeps the gradient animation tick alive with
        // no live windows).
        try { this._removeBorder(win); } catch (_e) {} // border + ring + mask + quarantine
        this._floatMaxRects?.delete(win);
        this._gappedMaxSet?.delete(win);
        this._maximizeToggleRects?.delete(win);
        this._scratchpadWindows?.delete(win);
        this._toggleFloatWindows?.delete(win);
        this._savedRects?.delete(win);
    }));
    this._floatHooks.set(win, ids);
}

export function _disconnectFloatHooks(win) {
    if (!this._floatHooks) return;
    const ids = this._floatHooks.get(win);
    if (!ids) return;
    for (const id of ids) {
        win.disconnect(id);
    }
    this._floatHooks.delete(win);
}

export function _getWindowsForWorkspace(workspace) {
    const order = this._getWorkspaceOrder(workspace);
    return order.filter(w =>
        w.get_window_type() === Meta.WindowType.NORMAL &&
        !w.is_skip_taskbar() &&
        !w.minimized &&
        w !== this._backgroundAppWin &&
        this._windowWSIndices.get(w) === this._wsIndex(workspace)
    );
}

export function _reassertFloatingTransients() {
    try {
        if (!this._settings || !this._settings.get_boolean('enabled'))
            return false;
        let moved = false;
        const index = (w) => {
            const a = w.get_compositor_private();
            // get_child_index() does not exist on Clutter.Actor in
            // GNOME 50/51 — the helper threw on every call (swallowed
            // by the outer catch) and this whole routine was dead.
            // get_children() returns a fresh array, so indexOf tracks
            // live order — required because raises inside this routine
            // mutate the child order (a prebuilt map would go stale).
            return a && a.get_parent() === global.window_group
                ? global.window_group.get_children().indexOf(a) : -1;
        };
        // ACTIVE WORKSPACE ONLY: raising/reordering windows on inactive
        // (hidden) workspaces mutates window_group child order →
        // ::children-changed → a full stage queue_redraw → every
        // offscreen mask/blur re-renders — a visible flash on the
        // workspace being switched TO, even though the reordered actors
        // are on the leaving workspace (the "unfocused float → redraw
        // jank" case: an unfocused float sits below the top tile, so
        // every switch re-raised it and repainted the whole stage).
        // Inactive-workspace floats are re-asserted when their
        // workspace activates (ws-changed + restacked + the 50ms
        // settle poll), so scoping to the active workspace loses
        // nothing.
        const activeWs = global.workspace_manager.get_active_workspace();
        if (activeWs) {
            const order = activeWs.list_windows();
            // The tiled stack = windows Plaid actually manages AND that
            // are not floating. Everything else — float-listed windows,
            // transients, and UNMANAGED windows (non-NORMAL types like
            // Steam's "Update News" child that the tiler never claims)
            // — is naturally floating and must be re-raised above the
            // tiles on restacks/workspace changes. The old "not
            // _isFloating" bucket lumped the unmanaged windows into the
            // tiles, so they sank below them.
            const tiled = order.filter(w => this._windowWorkspaces.has(w) && !this._isFloating(w));
            // Floats: reposition each float's actor above the topmost
            // tiled actor — pure compositor layering, no meta above state.
            // Transients are included: a floating transient of a TILED
            // parent (e.g. a floating Steam child window) would otherwise
            // sink below the tiles on restacks/workspace changes (loop 2
            // only covers transients of floating parents).
            for (const win of order) {
                if (tiled.includes(win) || win === this._backgroundAppWin) continue;
                const a = win.get_compositor_private();
                if (!a || a.get_parent() !== global.window_group) continue;
                // Pre-stage raises even for HIDDEN floats (minimized DDT/scratch,
                // a not-yet-committed XWayland window): reordering a
                // hidden actor changes no pixels, and at ws-switch time
                // we're inside mutter's switch animation (repaints are
                // masked there) — so raising BEFORE the show is free,
                // while raising AFTER it (the old `!a.visible` skip
                // forced a post-show raise) caused a visible stage
                // repaint — the "X11 float arrival flash". The float
                // then shows already above the tiles: no pop, no
                // correction repaint. The sibling-overlap risk this
                // skip used to guard is owned by the visibility sync in
                // _syncBlurStackingNow (a hidden source keeps its
                // sibling hidden). The active-workspace-only scope above
                // already excludes hidden floats on other workspaces.
                let topTiledIdx = -1;
                let topTiledActor = null;
                for (const t of tiled) {
                    const ti = index(t);
                    if (ti > topTiledIdx) {
                        topTiledIdx = ti;
                        topTiledActor = t.get_compositor_private();
                    }
                }
                if (topTiledActor && index(win) < topTiledIdx) {
                    // win.raise() (mutter-native) instead of a Clutter
                    // set_child_above_sibling: a Clutter reorder emits
                    // ::children-changed → full-stage queue_redraw —
                    // the whole screen re-renders (every blur/mask
                    // offscreen re-captures) as an extra frame at a
                    // quiet moment = the "switch arrival flash". A
                    // mutter raise carries REGIONAL damage (smooth, like
                    // a focus click) and — crucially — updates MUTTER'S
                    // OWN internal z, so the reveal choreography can't
                    // undo it (the Clutter-only reorder fought mutter's
                    // z on every restack — the root of the float-sink
                    // tug-of-war). raise() is one-shot, unlike
                    // make_above (the persistent above-state that broke
                    // Qt popups historically).
                    win.raise();
                    moved = true;
                }
            }
            // Transients above their floating parents.
            for (const win of order) {
                const parent = win.get_transient_for();
                if (!parent || !this._isFloating(parent)) continue;
                const a = win.get_compositor_private();
                const pa = parent.get_compositor_private();
                if (!a || !pa || a.get_parent() !== global.window_group) continue;
                // Same pre-stage + mutter-native rationale as loop 1: raise() puts
                // the transient at the top of the stack (above its
                // parent too) with regional damage and a persistent
                // mutter z.
                if (index(win) >= 0 && index(win) < index(parent)) {
                    try {
                        if (this._stackDiagnostics && !this._stackDiagnostics.has(win.get_id())) {
                            this._stackDiagnostics.add(win.get_id());
                            this._debugLog(`stack reassert: transient ${win.get_id()} re-positioned above ${parent.get_wm_class_instance() || '?'}`);
                        }
                    } catch (_e) {}
                    win.raise();
                    moved = true;
                }
            }
        }
        return moved;
    } catch (_e) {}
    return false;
}
export const windowMethods = {
    _shouldManage,
    _moveCursorToWindow,
    _cursorWarpDeferred,
    _isFloating,
    _isFloatProcessWindow,
    _isFixedSizeWindow,
    _getWorkspaceOrder,
    _getWorkspaceLayout,
    _markPendingWindowInvisible,
    _addWindow,
    _removeWindow,
    _connectWindowSignals,
    _disconnectWindowSignals,
    _connectFloatHooks,
    _disconnectFloatHooks,
    _getWindowsForWorkspace,
    _reassertFloatingTransients,
};
