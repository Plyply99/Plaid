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
  Clutter: 'export default { Orientation: { HORIZONTAL: 0, VERTICAL: 1 }, get_default_backend: undefined };',
  Cogl: 'export default { SnippetHook: { FRAGMENT: 1, VERTEX: 2, TEXTURE_LOOKUP: 3 } };',
  GObject: 'export default { registerClass: () => { throw new Error("GObject.registerClass invoked at import time"); } };',
  Gio: 'export default {};',
  GLib: 'export default {};',
  Graphene: 'export default {};',
  Meta: 'export default { WindowType: { NORMAL: 0 } };',
  Shell: 'export default {};',
  St: 'export default {};',
  cairo: 'export default {};',
};

const RESOURCE_SOURCES = [
  [/\/extensions\/extension\.js$/, 'export class Extension {}\nexport function gettext(s) { return s; }'],
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
    return { format: 'module', source: GI_SOURCES[name] ?? 'export default {};', shortCircuit: true };
  }
  if (url.startsWith('resource://')) {
    return { format: 'module', source: resourceSource(url), shortCircuit: true };
  }
  return nextLoad(url, context);
}
