// Pure core, NOT yet wired to the runner/scheduler. Does no I/O and doesn't
// decide whether a source was read: provenance and delivery confirmation belong
// to the caller.
const TRACKING = /^(?:utm_[a-z0-9_]+|gclid|fbclid)$/i;
export function curationArticleKey(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020]/.test(value)) return null;
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password) return null;
    // Doesn't merge HTTP/HTTPS, www/apex, a content query string, or paper
    // versions. SPA hash routes may identify different articles: preserve them.
    if (!(u.hostname==='mail.google.com'&&/^#all\/[a-f0-9]{8,40}$/i.test(u.hash)) && !/^#(?:\/|!)/.test(u.hash)) u.hash = '';
    for (const name of [...u.searchParams.keys()]) if (TRACKING.test(name)) u.searchParams.delete(name);
    u.searchParams.sort();
    return u.href;
  } catch { return null; }
}
export function normalizeCurationSections(sections) {
  if (!Array.isArray(sections) || !sections.length || sections.length > 20) throw Error('Seções inválidas.');
  const ids = new Set();
  return sections.map(s => {
    if (!s || !/^[a-z][a-z0-9_-]{0,39}$/.test(s.id || '') || ids.has(s.id)
      || !Number.isInteger(s.min) || !Number.isInteger(s.max) || s.min < 0 || s.max < 1 || s.min > s.max || s.max > 50) throw Error('Seção inválida.');
    ids.add(s.id); return { id: s.id, min: s.min, max: s.max };
  });
}
/**
 * `delivered` is a history CONFIRMED by the transport/storage layer, never
 * generated text nor a model statement. Writes nothing: any future integration
 * must record only after success, distinguishing failure, timeout, and
 * uncertain outcome. The result measures count and repetition by URL; it does
 * NOT prove reading, recency, section relevance, summary accuracy, or source
 * exhaustion.
 */
export function evaluateCuration({ userId, routineId, sections, items, delivered, historyAvailable }) {
  if (typeof userId !== 'string' || !userId || typeof routineId !== 'string' || !routineId) throw Error('Escopo inválido.');
  const specs = normalizeCurationSections(sections);
  if (!Array.isArray(items) || items.length > 1000) throw Error('Itens inválidos.');
  if (historyAvailable !== true) return { state: 'blocked', reason: 'history_unavailable', accepted: [], rejected: [], coverage: [], coverageSatisfied: false };
  if (!Array.isArray(delivered) || delivered.length > 10000) throw Error('Histórico inválido.');
  const previous = new Set();
  for (const row of delivered) {
    if (!row || row.userId !== userId || row.routineId !== routineId || row.confirmed !== true) continue;
    const key = curationArticleKey(row.url);
    // A confirmed record from our own scope with an invalid key cannot
    // disappear silently and make the engine classify a repeat as novelty.
    if (!key) return { state: 'blocked', reason: 'invalid_history', accepted: [], rejected: [], coverage: [], coverageSatisfied: false };
    previous.add(key);
  }
  const counts = new Map(specs.map(s => [s.id, 0]));
  const limits = new Map(specs.map(s => [s.id, s.max]));
  const seen = new Set(), accepted = [], rejected = [];
  for (const [index, item] of items.entries()) {
    const key = curationArticleKey(item?.url);
    let reason = !key ? 'invalid_url' : !counts.has(item?.section) ? 'unknown_section'
      : previous.has(key) ? 'already_delivered' : seen.has(key) ? 'duplicate_in_edition'
      : counts.get(item.section) >= limits.get(item.section) ? 'section_limit' : null;
    if (reason) { rejected.push({ index, key, reason }); continue; }
    seen.add(key); counts.set(item.section, counts.get(item.section) + 1);
    // Original data stays intact, doesn't rewrite a purchase/access URL for delivery.
    accepted.push({ index, key, section: item.section });
  }
  const coverage = specs.map(s => ({ ...s, count: counts.get(s.id), missing: Math.max(0, s.min - counts.get(s.id)) }));
  return { state: 'evaluated', accepted, rejected, coverage, coverageSatisfied: coverage.every(s => s.missing === 0) };
}
