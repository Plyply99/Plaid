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
    if (this._isBgAppProcessWindow(win))
        return false;
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
    // Session-restored windows can map onto the hidden BGAPP parking slot
    // before the delayed evacuation catches them. Move them (and any earlier
    // strays) to the real workspace BEFORE the new-window hide/place logic
    // builds tree state for the parking slot.
    if (this._backgroundAppParkingWs && win.get_workspace() === this._backgroundAppParkingWs) {
        this._evacuateParkingWorkspace();
    }
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
        this._markPendingWindowInvisible(win, win.get_compositor_private());
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
    this._observedMinSizes.delete(win);
    this._minLimitedWindows.delete(win);
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
    win._plaidHoldReveal = false;
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
    sigIds.push({ emitter: win, id: win.connect('notify::workspace', () => {
        if (!this._settings || !this._backgroundAppParkingWs) return;
        if (win.get_workspace() === this._backgroundAppParkingWs)
            this._evacuateParkingWorkspace();
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
        this._removeBorder(win); // border + ring + mask + quarantine
        this._floatMaxRects.delete(win);
        this._gappedMaxSet.delete(win);
        this._maximizeToggleRects.delete(win);
        this._scratchpadWindows.delete(win);
        this._toggleFloatWindows.delete(win);
        this._savedRects.delete(win);
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
                if (this._stackDiagnostics && !this._stackDiagnostics.has(win.get_id())) {
                    this._stackDiagnostics.add(win.get_id());
                    this._debugLog(`stack reassert: transient ${win.get_id()} re-positioned above ${parent.get_wm_class_instance() || '?'}`);
                }
                win.raise();
                moved = true;
            }
        }
    }
    return moved;
}
export function _moveWindow(win, x, y, w, h) {
    if (!win || win.is_fullscreen()) return;
    if (!win.get_workspace()) return;
    const rect = win.get_frame_rect();
    if (rect.width === 0 || rect.height === 0) return;
    if (win.is_maximized()) {
        try { win.unmaximize(); } catch (_e) {}
    }
    if (this._animTargets) {
        this._animTargets.set(win, { x, y, w, h });
        return;
    }
    try {
        const actor = win.get_compositor_private();
        if (actor) actor.remove_all_transitions();
        win.move_resize_frame(true, x, y, w, h);
    } catch (e) {
        log(`[plaid] _moveWindow failed: ${e.message}`);
    }
}

export function _convertMaximizedToGaps(win) {
    if (!this._settings || !win) return;
    if (!this._settings || !this._settings.get_boolean('enabled')) return;
    if (this._dropdownWin === win) return;
    if (win.is_fullscreen() || !win.is_maximized()) return;
    if (this._isFloating(win)) {
        this._handleFloatMaximize(win);
        return;
    }
    const ws = win.get_workspace();
    if (!ws) return;
    let workArea = null;
    try {
        workArea = ws.get_work_area_for_monitor(win.get_monitor());
    } catch (_e) {}
    if (!workArea) return;
    const rect = this._singleWindowRect(workArea);
    if (!rect) return;
    this._debugLog(`maximize: converting to gapped rect=(${rect.x},${rect.y},${rect.w},${rect.h})`);
    try { win.unmaximize(); } catch (_e) {}
    this._moveWindow(win, rect.x, rect.y, rect.w, rect.h);
}

export function _handleFloatMaximize(win) {
    if (this._gappedMaxSet.has(win)) {
        const saved = this._floatMaxRects.get(win);
        try { win.unmaximize(); } catch (_e) {}
        if (saved && saved.w > 0) {
            this._debugLog(`float maximize: restoring (${saved.x},${saved.y},${saved.w},${saved.h})`);
            this._applyFloatRect(win, saved.x, saved.y, saved.w, saved.h, (success) => {
                if (success) this._gappedMaxSet.delete(win);
            });
        } else {
            this._gappedMaxSet.delete(win);
        }
        return;
    }
    if (!this._floatMaxRects.has(win)) {
        this._debugLog('float maximize: no saved rect, leaving window normally maximized');
        return;
    }
    const ws = win.get_workspace();
    if (!ws) return;
    let workArea = null;
    try {
        workArea = ws.get_work_area_for_monitor(win.get_monitor());
    } catch (_e) {}
    if (!workArea) return;
    const rect = this._singleWindowRect(workArea);
    if (!rect) return;
    this._debugLog(`float maximize: gapped rect=(${rect.x},${rect.y},${rect.w},${rect.h})`);
    this._gappedMaxSet.add(win);
    this._applyFloatRect(win, rect.x, rect.y, rect.w, rect.h);
}

export function _applyFloatRect(win, x, y, w, h, onDone) {
    let retries = 0;
    const apply = () => {
        if (!this._settings) return false;
        if (!win.get_workspace()) return false;
        try {
            if (win.is_maximized()) win.unmaximize();
        } catch (_e) {}
        this._moveWindow(win, x, y, w, h);
        const f = win.get_frame_rect();
        if (f.x === x && f.y === y && f.width === w && f.height === h) {
            if (onDone) { try { onDone(true); } catch (_e) {} }
            return false;
        }
        retries++;
        if (retries >= 15) {
            if (onDone) { try { onDone(false); } catch (_e) {} }
            return false;
        }
        return true;
    };
    const retry = () => {
        if (!this._settings) return GLib.SOURCE_REMOVE;
        return apply() ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
    };
    if (apply())
        this._addTimeout(100, retry);
}

export function _trackFloatGeometry(win) {
    if (!this._floatMaxRects || !win) return;
    if (!this._isFloating(win) || win.is_maximized()) return;
    if (this._gappedMaxSet.has(win)) return;
    const f = win.get_frame_rect();
    if (f.width > 0 && f.height > 0)
        this._floatMaxRects.set(win, { x: f.x, y: f.y, w: f.width, h: f.height });
}

export function _onWindowIdentityChanged(win) {
    if (!this._settings || !win) return;
    this._debugLog(`identity: ${this._winClassCandidates(win).join('/') || '?'} appId=${win.get_gtk_application_id() || '?'} ` +
        `ws=${this._wsIndex(win.get_workspace())} managed=${this._windowWorkspaces.has(win)}`);
    // Backstop for the Extensions app / prefs window: its wm-class and GTK
    // app id can resolve AFTER the window was already added to the tiler.
    // If it identifies as the Extensions app now, un-tile it and restore
    // the layout so opening prefs never leaves the workspace rearranged.
    if (this._isExtensionsAppWindow(win)) {
        if (this._windowWorkspaces.has(win)) {
            this._debugLog('extensions app: un-tiling settings window (late identity)');
            const ws = win.get_workspace();
            this._removeWindow(win);
            if (ws) this._retileWorkspace(ws);
        }
        return;
    }
    if (!this._isFloating(win)) return;
    const ws = win.get_workspace();
    if (ws) {
        const tree = this._bspGetTree(ws);
        if (tree && this._bspCollectWindows(tree).includes(win)) {
            this._bspTrees.set(ws, this._bspRemove(tree, win));
            this._retileWorkspace(ws);
        }
    }
    // The window may be in the maximized state from mutter's map-time
    // auto-maximize (a pre-map full-area slot > 80% of the work area) —
    // _restoreFloatNaturalRect refuses maximized windows, so undo the
    // state first, then restore the spawn rect captured at _addWindow.
    if (win.is_maximized()) {
        try { win.unmaximize(); } catch (_e) {}
    }
    this._restoreFloatNaturalRect(win);
    // Reveal: the window can be pending-hidden from the tiled
    // choreography (actor.visible=false + mask uniform 0) when its
    // identity resolved late to floating — nothing else reveals it, so
    // it would sit invisible until the 2.5s safety timer. Reveal now.
    // GUARD: a DELIBERATELY minimized window (the scratch layer, or the
    // user's own minimize) must never be force-shown by an identity /
    // title notify — GTK re-applies titles on state changes, so this
    // reveal un-minimized scratch windows within milliseconds of the
    // scratch-add's minimize (the "add does nothing" bug: hide →
    // instant re-show → net zero on screen).
    if (win.minimized) {
        this._debugLog(`float reveal skipped (minimized): ${win.get_wm_class_instance() || '?'}`);
        return;
    }
    this._debugLog(`float reveal: ${win.get_wm_class_instance() || '?'}`);
    try {
        if (this._pendingWarp) this._pendingWarp.delete(win);
        const a = win.get_compositor_private();
        if (a) {
            a.visible = true;
            a.set_opacity(255);
        }
        const effect = this._windowMasks && this._windowMasks.get(win);
        if (effect && effect.setOpacityUniform)
            effect.setOpacityUniform(1);
    } catch (_e) {}
}

export function _restoreFloatNaturalRect(win) {
    if (!this._savedRects || !this._savedRects.has(win)) return;
    if (win.is_fullscreen() || win.is_maximized()) return;
    const saved = this._savedRects.get(win);
    if (!saved || saved.w === 0) return;
    const frame = win.get_frame_rect();
    if (frame.width === 0) return;
    const ws = win.get_workspace();
    if (!ws) return;
    let workArea = null;
    try {
        workArea = ws.get_work_area_for_monitor(win.get_monitor());
    } catch (_e) {}
    if (!this._isValidWorkArea(workArea)) return;
    if (frame.width < workArea.width - 20 || frame.height < workArea.height - 20) return;
    this._debugLog(`float: restoring natural rect (${saved.x},${saved.y},${saved.w},${saved.h})`);
    this._moveWindow(win, saved.x, saved.y, saved.w, saved.h);
}

export function _reapplyFloatRules() {
    if (!this._settings) return;
    for (let i = 0; i < global.workspace_manager.get_n_workspaces(); i++) {
        const ws = global.workspace_manager.get_workspace_by_index(i);
        for (const win of ws.list_windows()) {
            if (this._isFloating(win)) {
                this._restoreFloatNaturalRect(win);
            }
        }
    }
    this._updateBorders();
}

export function _capturePosition(win) {
    if (!this._savedRects || this._savedRects.has(win)) return;
    try {
        const frame = win.get_frame_rect();
        if (frame.width > 0 && frame.height > 0)
            this._savedRects.set(win, { x: frame.x, y: frame.y, w: frame.width, h: frame.height });
    } catch (_e) {}
}

export function _restoreSavedPositions() {
    if (!this._savedRects) return;
    for (const [win, rect] of this._savedRects) {
        try {
            if (!win.get_compositor_private() || win.is_fullscreen()) continue;
            win.move_resize_frame(true, rect.x, rect.y, rect.w, rect.h);
        } catch (_e) {}
    }
    this._savedRects.clear();
}

export function _repositionWindow(window, ws) {
    if (!window || !ws || !this._settings) return;
    if (this._getWorkspaceLayout(ws) === 'floating') return;
    const [px, py] = global.get_pointer();
    const tiled = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
    if (tiled.length <= 1) return;

    const layout = this._getWorkspaceLayout(ws);
    if (layout === 'dwindle') {
        const targetLeaf = this._computeDwindleDropTarget(ws, px, py);
        if (!targetLeaf || targetLeaf.type !== 'leaf') return;

        const tree = this._bspGetTree(ws);
        if (!tree) return;

        // Preserve the split ratio at the drop target so the re-insert
        // mirrors the previous proportions instead of resetting to the
        // default dwindle-ratio.
        let targetRatio = null;
        const path = [];
        this._bspFindPath(tree, targetLeaf.window, path);
        for (let i = path.length - 1; i >= 0; i--) {
            if (path[i].type === 'split' && path[i].ratio > 0 && path[i].ratio < 1) {
                targetRatio = path[i].ratio;
                break;
            }
        }

        // Dropping the dragged window on its OWN leaf (or on a leaf the
        // removal merges away) must leave the tree untouched: the old
        // code removed the window and never re-inserted it, so the
        // follow-up retile re-added it as the "newest" leaf — a silent
        // arrangement reshuffle (and the reshuffled shape got persisted).
        if (targetLeaf.window === window) {
            this._bspTrees.set(ws, tree);
            return;
        }
        let newTree = this._bspRemove(tree, window);
        if (newTree.type === 'empty') newTree = null;
        if (newTree && !this._bspFindLeaf(newTree, targetLeaf.window)) {
            this._bspTrees.set(ws, tree);
            return;
        }
        if (newTree) {
            newTree = this._bspReplaceLeaf(newTree, targetLeaf, window, targetRatio);
        }
        this._bspTrees.set(ws, newTree);
    } else {
        const targetIdx = this._computeMasterStackDropTarget(ws, px, py);
        if (targetIdx < 0) return;

        const order = this._getWorkspaceOrder(ws);
        // The drop target is expressed in TILED-only index space
        // (master=0, stack=1..N-1) while the order interleaves
        // toggle-floated windows — comparing/splicing across the two
        // spaces placed the window at the wrong relative position
        // whenever a float was interleaved. Map
        // both sides to the tiled space, then back to the order.
        const tiledIdx = tiled.indexOf(window);
        if (tiledIdx === -1) return;
        const currentIdx = order.indexOf(window);
        if (currentIdx === -1 || tiledIdx === targetIdx) return;

        order.splice(currentIdx, 1);
        const adjustedTarget = targetIdx > tiledIdx ? targetIdx - 1 : targetIdx;
        let insertIdx = order.length;
        let tiledSeen = 0;
        for (let i = 0; i < order.length; i++) {
            const w = order[i];
            if (this._isFloating(w) || w.minimized || w.is_skip_taskbar() ||
                w.get_window_type() !== Meta.WindowType.NORMAL) continue;
            if (tiledSeen === adjustedTarget) {
                insertIdx = i;
                break;
            }
            tiledSeen++;
        }
        order.splice(insertIdx, 0, window);
        const tiledOnly = order.filter(w =>
            !this._isFloating(w) &&
            w.get_window_type() === Meta.WindowType.NORMAL &&
            !w.is_skip_taskbar() &&
            !w.minimized
        );
        if (layout === 'centered-master-stack')
            this._retileCenteredMasterStack(ws, tiledOnly);
        else
            this._retileMasterStack(ws, tiledOnly);
    }
    // A drop-swap restructured the tree/order directly (not every path
    // here goes through _doRetileWorkspace) — persist the new
    // arrangement (debounced) so it survives a login.
    this._scheduleSaveLayouts();
}

export const windowMethods = {
    _moveWindow,
    _convertMaximizedToGaps,
    _handleFloatMaximize,
    _applyFloatRect,
    _trackFloatGeometry,
    _onWindowIdentityChanged,
    _restoreFloatNaturalRect,
    _reapplyFloatRules,
    _capturePosition,
    _restoreSavedPositions,
    _repositionWindow,

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
