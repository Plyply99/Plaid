// Shared base for Plaid subsystems. Each subsystem owns the signals it
// connects, so cleanup is a single disconnectObject() sweep in destroy().

export class PlaidSubsystem {
    constructor(core) {
        this.core = core;
        this._tokens = [];
    }

    connectObject(emitter, ...args) {
        const token = {};
        emitter.connectObject(...args, token);
        this._tokens.push({ emitter, token });
        return token;
    }

    disconnectAll() {
        for (const { emitter, token } of this._tokens)
            emitter.disconnectObject(token);
        this._tokens = [];
    }

    destroy() {
        this.disconnectAll();
    }
}
