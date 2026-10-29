// Session-scoped state that must survive the shell's lock/unlock re-enable
// cycle. The shell disables extensions on lock and re-enables them on unlock;
// because this module is cached, the values persist across enable()/disable().
// Keeping them here lets extracted modules read them without importing the
// entry point (which would be a circular import).

export const sessionState = {
    // True while the session is on the lock screen / unlocking. disable() and
    // enable() behave like a resume instead of a full teardown, so the bg-app
    // stays alive and tiled windows keep their arrangement.
    lockCycle: false,

    // True once the extension has been enabled in this shell process. A
    // manual disable/enable must resume pre-existing windows instead of
    // running the new-window choreography, which force-shows windows from
    // other workspaces.
    enabledThisShell: false,

    // Exact tiling maps stashed on disable and restored on re-enable, so a
    // lock cycle or manual toggle does not rebuild the layout from scratch.
    stashedTiling: null,

    // The BGAPP reservation must survive a lock cycle too. The shell destroys
    // and recreates the extension core on lock/unlock, so keeping the parking
    // workspace here lets the next core adopt it instead of appending a second
    // one (each extra parking leaked a workspace pinned by keepWorkspaceAlive).
    parkingWorkspace: null,
    parkingFront: false,

    // The BGAPP window itself, for the overview wrappers. They must not close
    // over a core instance: a wrap installed by a destroyed core would resolve
    // every field to null and silently skip the parking hide.
    bgAppWindow: null,

    // Overview/switcher wrap bookkeeping. Owned by the session, not the core,
    // so a lock cycle can reuse the existing wraps instead of stacking new
    // ones over closures that point at a dead core.
    parkingHiding: null,

    // PID of the surviving dropdown terminal. The window wrapper (and its
    // `_plaidDdt` property) can be collected while Plaid is disabled, and the
    // per-core /proc env cache is cold on re-enable; the pid is durable for the
    // whole shell session and lets adoption find the terminal immediately.
    ddtPid: 0,
};
