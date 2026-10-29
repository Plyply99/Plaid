import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { PlaidCore } from './modules/core.js';

export default class TilingWMExtension extends Extension {
    enable() {
        this._plaid = new PlaidCore(this);
        this._plaid.enable();
    }

    disable() {
        this._plaid.destroy();
        this._plaid = null;
    }
}
