// Núcleo puro, ainda NÃO conectado ao runner/scheduler. Não faz I/O nem decide
// se uma fonte foi lida: proveniência e confirmação de entrega são do chamador.
const TRACKING = /^(?:utm_[a-z0-9_]+|gclid|fbclid)$/i;
export function curationArticleKey(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020]/.test(value)) return null;
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password) return null;
    // Não funde HTTP/HTTPS, www/apex, query de conteúdo ou versões de paper.
    // Rotas hash de SPAs podem identificar artigos diferentes: preservá-las.
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
 * `delivered` é um histórico CONFIRMADO pelo transporte/armazenamento, nunca
 * texto gerado nem declaração do modelo. Não grava nada: integração futura deve
 * registrar só depois do sucesso, distinguindo falha, timeout e resultado incerto.
 * Resultado mede contagem e repetição por URL; NÃO prova leitura, recência,
 * pertinência da seção, veracidade do resumo nem esgotamento das fontes.
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
    // Registro confirmado do nosso escopo com chave inválida não pode sumir
    // silenciosamente e fazer o motor classificar repetição como novidade.
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
    // Dados originais intactos, não reescreve URL de compra/acesso para entregar.
    accepted.push({ index, key, section: item.section });
  }
  const coverage = specs.map(s => ({ ...s, count: counts.get(s.id), missing: Math.max(0, s.min - counts.get(s.id)) }));
  return { state: 'evaluated', accepted, rejected, coverage, coverageSatisfied: coverage.every(s => s.missing === 0) };
}
