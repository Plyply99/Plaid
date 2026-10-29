// Prototype augmentation.
//
// Plaid's subsystems are cohesive modules of instance methods that share the
// extension's state (`this`). Attaching them once keeps the entry point small
// while preserving call sites and instance state. This is the single place
// that merges the method bundles.

import { helperMethods } from './helpers.js';
import { geometryMethods } from './geometry.js';
import { bspMethods } from './bsp.js';
import { borderMathMethods } from './border-math.js';
import { blurMethods } from './blur.js';
import { backgroundAppMethods } from './background-app.js';
import { maskMethods } from './mask.js';
import { borderWidgetMethods } from './borders.js';
import { keybindMethods } from './keybindings.js';
import { scratchpadMethods } from './scratchpad.js';
import { dropdownMethods } from './dropdown-terminal.js';
import { pointerFocusMethods } from './pointer-focus.js';
import { workspacePillMethods } from './workspace-pill.js';
import { workspacesMethods } from './workspaces.js';
import { placementMethods } from './placement.js';
import { grabMethods } from './grab.js';
import { windowMethods } from './windows.js';
import { layoutMethods } from './layouts.js';
import { persistenceMethods } from './persistence.js';
import { procInfoMethods } from './proc-info.js';
import { signalMethods } from './signals.js';
import { actionMethods } from './actions.js';
import { dragPreviewMethods } from './drag-preview.js';

export function attachMethods(klass) {
    Object.assign(
        klass.prototype,
        helperMethods,
        geometryMethods,
        bspMethods,
        borderMathMethods,
        blurMethods,
        backgroundAppMethods,
        maskMethods,
        borderWidgetMethods,
        keybindMethods,
        scratchpadMethods,
        dropdownMethods,
        pointerFocusMethods,
        workspacePillMethods,
        workspacesMethods,
        placementMethods,
        grabMethods,
        windowMethods,
        layoutMethods,
        persistenceMethods,
        procInfoMethods,
        signalMethods,
        actionMethods,
        dragPreviewMethods,
    );
}
