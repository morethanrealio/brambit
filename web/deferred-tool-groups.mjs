// Deferred tool groups (`abrir_ferramentas`): rare suites (cofre, espacos, skills,
// codigo) stay out of the initial registry to keep the cacheable prefix small, and
// enter only when a group is opened. The groups themselves are assembled per turn in
// server.mjs (their populate() closes over the turn's registry); this module holds
// the opening logic shared by the three paths that open a group: the
// abrir_ferramentas tool, the reopening from history and the automatic opening when
// the model calls a tool of a group that is not open.

// Groups from `abrir_ferramentas` already opened in PREVIOUS turns of this thread.
// Reads the CALL persisted in history (toolCalls), not the result text: the
// `grupo` argument is the data, the returned sentence is just prose.
export function gruposAbertosNoHistory(history) {
  const out = new Set();
  for (const m of Array.isArray(history) ? history : []) {
    for (const c of Array.isArray(m?.toolCalls) ? m.toolCalls : []) {
      if (c?.name !== 'abrir_ferramentas') continue;
      const g = typeof c?.args?.grupo === 'string' ? c.args.grupo.trim() : '';
      if (g) out.add(g);
    }
  }
  return out;
}

// Opens one group: runs its populate() and marks it loaded. Returns the names of the
// tools it added (empty when a 'grupo' agent's allow-list drops them all). Throws
// what populate() throws, and then the group stays closed.
export function openGroup(registry, deferredGroups, loadedGroups, grupo) {
  const before = new Set(registry.map.keys());
  deferredGroups[grupo].populate();
  loadedGroups.add(grupo);
  return [...registry.map.keys()].filter((n) => !before.has(n));
}

// Automatic opening. After compaction the history may keep the CALL to a tool of a
// group (splitwise_add_expense) and lose the abrir_ferramentas that opened it: the
// model then calls the tool directly, the group is closed, the core answered
// `ERRO: tool desconhecida` and the receipt told the user the service could not be
// confirmed (Luffy/Splitwise, 2026-10-24, 2026-11-07 and 2026-11-19). Now, when the
// core asks the registry about a name it does not have, the closed groups are opened
// in order until the name shows up; the tool then runs through its normal path, so a
// write still stops at the confirmation card. A name no group has keeps the error.
// The core asks keepsStepText() before run(), so both look the name up first.
// Only while abrir_ferramentas is in the registry: a turn that prunes it (onboarding,
// curation routine) keeps its groups closed, as the model could not open them either.
export function openGroupsOnDemand(registry, deferredGroups, loadedGroups) {
  const tried = new Set();
  const ensure = (name) => {
    if (typeof name !== 'string' || registry.map.has(name) || tried.has(name)) return;
    if (!registry.map.has('abrir_ferramentas')) return;
    tried.add(name);
    for (const grupo of Object.keys(deferredGroups)) {
      if (loadedGroups.has(grupo)) continue;
      try { openGroup(registry, deferredGroups, loadedGroups, grupo); }
      catch (e) { console.error('[open group on demand]', grupo, e?.message ?? e); continue; }
      if (registry.map.has(name)) { console.log(`[open group on demand] "${grupo}" opened for ${name}`); return; }
    }
  };
  for (const method of ['keepsStepText', 'providerFallbackSafe', 'run']) {
    const original = registry[method].bind(registry);
    registry[method] = (name, ...rest) => { ensure(name); return original(name, ...rest); };
  }
  return registry;
}
