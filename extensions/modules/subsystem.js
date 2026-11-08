// Shared base for Plaid subsystems. Each subsystem owns the signals it
// connects, so cleanup is a single disconnectObject() sweep in destroy().

export class PlaidSubsystem {
    constructor(core) {
        this.core = core;
        this._tokens = [];
    }

    connectObject(emitter, ...args) {
        const token = { emitter, owner: this };
        emitter.connectObject(...args, token);
        this._tokens.push(token);
        return token;
    }

    disconnectToken(token) {
        if (!token) return;
        const list = token.owner?._tokens;
        const i = list ? list.indexOf(token) : -1;
        if (i < 0) return;
        list.splice(i, 1);
        token.emitter.disconnectObject(token);
    }

    disconnectAll() {
        for (const token of this._tokens)
            token.emitter.disconnectObject(token);
        this._tokens = [];
    }

    destroy() {
        this.disconnectAll();
    }
}
