import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { attachMethods } from './modules/bootstrap.js';
import { enablePlaid, disablePlaid } from './modules/lifecycle.js';

export default class TilingWMExtension extends Extension {
    enable() {
        enablePlaid.call(this);
    }

    disable() {
        disablePlaid.call(this);
    }
}

attachMethods(TilingWMExtension);
