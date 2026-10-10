// Shared test fixtures: fake GSettings, fake Meta windows, BSP tree builders,
// and a `makeSelf` that produces an object whose prototype is the real
// TilingWMExtension.prototype so methods can call sibling methods normally.

import TilingWMExtension from '../extensions/extension.js';

export { normalizeAccel, schemaDefaultValue, maskSdfRect } from '../extensions/modules/helpers.js';

export const proto = TilingWMExtension.prototype;

export function fakeSettings(values = {}) {
  return {
    get_int: (k) => (k in values ? values[k] : 0),
    get_double: (k) => (k in values ? values[k] : 0.5),
    get_boolean: (k) => (k in values ? values[k] : false),
    get_string: (k) => (k in values ? values[k] : ''),
    get_strv: (k) => (k in values ? values[k] : []),
    get_default_value: (k) => (k in values ? { deep_unpack: () => values[k] } : null),
  };
}

// An object that inherits every real method but owns its own state. Assigning
// own properties (e.g. `_settings`, stubbed collaborators) shadows prototype
// state without touching the class.
export function makeSelf(settings = {}, overrides = {}) {
  const self = Object.create(proto);
  self._settings = fakeSettings(settings);
  Object.assign(self, overrides);
  return self;
}

let _winId = 0;

export function fakeWin(opts = {}) {
  const frame = opts.frame ?? { x: 0, y: 0, width: 100, height: 100 };
  const buffer = opts.buffer ?? frame;
  return {
    _testId: opts.id ?? ++_winId,
    get_frame_rect: () => ({ ...frame }),
    get_buffer_rect: () => ({ ...buffer }),
    get_wm_class_instance: () => opts.instance ?? null,
    get_wm_class: () => opts.wmClass ?? null,
    get_gtk_application_id: () => opts.appId ?? null,
    get_title: () => opts.title ?? '',
    get_min_size: () => opts.minSize ?? [0, 0],
    get_window_type: () => opts.type ?? 0,
    is_skip_taskbar: () => opts.skipTaskbar ?? false,
    is_fullscreen: () => opts.fullscreen ?? false,
    is_maximized: () => opts.maximized ?? false,
    minimized: opts.minimized ?? false,
  };
}

export const leaf = (win) => ({ type: 'leaf', window: win });
export const empty = () => ({ type: 'empty' });
export const split = (direction, ratio, first, second) =>
  ({ type: 'split', direction, ratio, first, second });
