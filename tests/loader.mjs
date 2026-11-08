// Test-only ESM loader.
//
// Plaid's extension.js is a single module that imports gi:// namespaces and
// resource:// gnome-shell modules — neither resolves under plain Node. This
// loader maps both schemes to minimal stubs so the REAL extension.js (and its
// extracted ./modules/*.js) can be imported and its pure logic exercised in
// unit tests.
//
// Register it with: node --import ./tests/register.mjs --test tests/

const GI_SOURCES = {
  Clutter: 'export default { Orientation: { HORIZONTAL: 0, VERTICAL: 1 }, AnimationMode: { EASE_OUT_CUBIC: 0 }, get_default_backend: undefined };',
  Cogl: 'export default { SnippetHook: { FRAGMENT: 1, VERTEX: 2, TEXTURE_LOOKUP: 3 } };',
  GObject: 'export default { registerClass: () => { throw new Error("GObject.registerClass invoked at import time"); } };',
  Gio: 'export default {};',
  GLib: 'export default { PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, SOURCE_CONTINUE: true, idle_add: () => 1, timeout_add: () => 1, source_remove: () => true, MainContext: { default: () => ({ find_source_by_id: () => true }) } };',
  Graphene: 'export default {};',
  Meta: 'export default { WindowType: { NORMAL: 0 }, WindowClientType: { WAYLAND: 0, X11: 1 }, GrabOp: { NONE: 0, KEYBOARD_RESIZING_UNKNOWN: 769 }, KeyBindingAction: {}, KeyBindingFlags: { NONE: 0 }, DisplayDirection: { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3 }, prefs_get_keybinding_action: () => 0, external_binding_name_for_action: () => null };',
  Shell: 'export default {};',
  St: 'export default {};',
  cairo: 'export default {};',
};

const RESOURCE_SOURCES = [
  [/\/extensions\/extension\.js$/, 'export class Extension {}\nexport function gettext(s) { return s; }'],
  [/\/ui\/main\.js$/, 'export const wm = {};\nexport const overview = { visible: false };\n' +
    'export const sessionMode = { currentMode: \'user\', isLocked: false, connectObject() {}, disconnectObject() {} };\n' +
    'export const layoutManager = {};\nexport const popped = [];\nexport function popModal(grab) { popped.push(grab); }\n' +
    'export let modalCount = 0;\nexport function setModalCount(n) { modalCount = n; }\n'],
  [/\/modalDialog\.js$/, 'export class ModalDialog {}'],
  [/\/workspaceSwitcherPopup\.js$/, 'export class WorkspaceSwitcherPopup {}\nexport class MonitorWorkspaceSwitcherPopup {}'],
];

function resourceSource(url) {
  for (const [re, src] of RESOURCE_SOURCES) {
    if (re.test(url)) return src;
  }
  return 'export {};';
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('gi://') || specifier.startsWith('resource://'))
    return { url: specifier, shortCircuit: true };
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('gi://')) {
    const name = url.slice('gi://'.length).split('/')[0];
    if (!(name in GI_SOURCES))
      throw new Error(`Unknown gi:// namespace in tests: gi://${name} — check the exact namespace casing`);
    return { format: 'module', source: GI_SOURCES[name], shortCircuit: true };
  }
  if (url.startsWith('resource://')) {
    return { format: 'module', source: resourceSource(url), shortCircuit: true };
  }
  return nextLoad(url, context);
}
