// Extensions: optional parts of Brambit that ship in this repository, each in
// web/extensions/<name>/index.mjs, and that an installation turns on or off.
// The core runs without any of them.
//
// An extension's default export is a plugin object (plugins.mjs): same fields,
// same checks. Extensions load before the installation's plugins, so their
// schemas, routes, site folders and catalogs come first, and a plugin can
// rely on them. They reach the server through ligar(servidor), like a plugin;
// servidor also brings what the core keeps for them (see server.mjs).
//
// Each entry of EXTENSIONS names:
//  load: imports the extension. Only the enabled ones are imported.
//  pluginPorts: ports the extension opens for the installation's plugins. A
//   plugin fills them in portas() like a core port; the extension reads them
//   as servidor.ports. They are known even with the extension off, so a
//   plugin written for it still boots there (the piece is just not used).
//
// Which extensions run: BRAMBIT_EXTENSIONS, names separated by commas ("none"
// for none). Without it, the usage profile's default (profiles.mjs), so an
// installation that never set it keeps running what it ran. A profile can
// require an extension or rule one out; a list that contradicts it fails at
// boot. Read once when the server starts.
import { readProfile } from './profiles.mjs';

export const EXTENSIONS = {};

// Per usage profile: what runs by default, what has to run, what can't.
export const PROFILE_EXTENSIONS = {
  complete: { defaults: [], requires: [], forbids: [] },
  personal: { defaults: [], requires: [], forbids: [] },
  'public-support': { defaults: [], requires: [], forbids: [] },
};

export function readExtensions(value = process.env.BRAMBIT_EXTENSIONS, { profile = readProfile(), registry = EXTENSIONS, rules = PROFILE_EXTENSIONS } = {}) {
  const rule = rules[profile];
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return [...rule.defaults];
  const names = raw === 'none' ? [] : [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  for (const n of names) if (!(n in registry)) throw new Error(`BRAMBIT_EXTENSIONS: unknown extension "${n}" (known: ${Object.keys(registry).join(', ') || 'none'})`);
  for (const n of rule.requires) if (!names.includes(n)) throw new Error(`BRAMBIT_EXTENSIONS: the ${profile} profile needs the ${n} extension`);
  for (const n of rule.forbids) if (names.includes(n)) throw new Error(`BRAMBIT_EXTENSIONS: the ${profile} profile runs without the ${n} extension`);
  return names;
}

// Every port any known extension opens, enabled or not.
export function extensionPorts(registry = EXTENSIONS) {
  return Object.values(registry).flatMap((e) => e.pluginPorts || []);
}

export async function loadExtensions(names = readExtensions(), registry = EXTENSIONS) {
  const list = [];
  for (const n of names) {
    const ext = (await registry[n].load()).default;
    if (ext?.nome !== n) throw new Error(`Extension ${n}: its nome has to be "${n}"`);
    list.push(ext);
  }
  return list;
}
