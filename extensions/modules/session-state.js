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
};
