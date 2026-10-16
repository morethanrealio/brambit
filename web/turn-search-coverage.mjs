import { tagIdioma } from './locale.mjs';
import { createEmailEvidence } from './email-evidence.mjs';
import { guardEmailCoverageClaims, renderEmailCoverageLimitations, findEmailCoverageWarnings, placeEmailCoverageWarning } from './email-search-coverage.mjs';
import { connectorSearchLimitations, findConnectorSearchLimitations, guardConnectorSearchClaims, SEARCH_FALLBACK } from './connector-search-coverage.mjs';
const WARN = {
  'pt-BR': '⚠️ Busca parcial: pelo menos uma consulta não foi concluída ou teve erro/limite de cobertura. Esta resposta pode deixar itens de fora; não deve ser tratada como lista completa nem como prova de ausência.',
  en: '⚠️ Partial search: at least one query was unfinished or encountered an error/coverage limit. This answer may omit items; do not treat it as a complete list or proof of absence.',
  es: '⚠️ Búsqueda parcial: al menos una consulta quedó incompleta o tuvo un error/límite de cobertura. Esta respuesta puede omitir elementos; no debe considerarse una lista completa ni prueba de ausencia.',
};
// State per TURN, not per user/global, outside the text controlled by the model.
// One complete worker doesn't erase the limitation of another independent worker.
export function turnSearchCoverage() {
  let partial = false, nonEmailPartial = false;
  const connectorCoverage=new Map();
  const email = createEmailEvidence();
  const emailCoverage = [], accountCoverage = [];
  const emailWarnings = language => renderEmailCoverageLimitations(emailCoverage,accountCoverage,language);
  const hasPartial = () => partial || [...connectorCoverage.values()].some(row=>row.status!=='complete');
  let onEmailGuard = null; // TEMPORARY: diagnosticoDosFiltros port
  const finishEmail = (text, language, {suppressEmptyEmailSources = false} = {}) => {
    let guarded = guardEmailCoverageClaims(text, {partial,active:emailCoverage.length>0,language});
    for (const warning of emailWarnings(language)) {
      guarded = placeEmailCoverageWarning(guarded,warning);
    }
    onEmailGuard?.(text, guarded); // TEMPORARY: diagnosticoDosFiltros port
    // Only the routine with a validated silence protocol asks for this. The notices have
    // already been applied, and any partial coverage prevents omitting the sources.
    if (suppressEmptyEmailSources === true && !String(guarded ?? '').trim() && !hasPartial()) return guarded;
    return email.finish(guarded,language);
  };
  return {
    observeEmail: rows => email.observe(rows),
    observeEmailCoverage(rows = []) {
      emailCoverage.push(...rows);
      if (rows.some(r=>r.status!=='complete')) partial=true;
    },
    observeAccountCoverage(row) {
      accountCoverage.push(row);
      if (row.status!=='consulted') partial=true;
    },
    emailWarnings,
    emailSourceLinks: () => new Set(email.rows().map(row=>row.link).filter(Boolean)),
    finishEmail,
    observeEmailGuard(fn) { onEmailGuard = fn; }, // TEMPORARY: diagnosticoDosFiltros port
    observe(value, details) {
      if(Array.isArray(details?.nonEmailCoverage)){
        for(const row of details.nonEmailCoverage)connectorCoverage.set(JSON.stringify([row.tool,row.account||'',row.search_id||row.query||row.reason]),row);
        if(value===true&&details.nonEmailPartial===false)partial=true;
        return;
      }
      if (value !== true) return;
      partial = true;
      // Older callers only report a boolean: keep the legacy notice.
      // Don't infer "email only" from the presence of an email query in the turn.
      if (details?.nonEmailPartial !== false) nonEmailPartial = true;
    },
    hasPartial,
    finish(text, language, options) {
      const current = [...emailWarnings(language), ...connectorSearchLimitations([...connectorCoverage.values()],language), ...(nonEmailPartial ? [SEARCH_FALLBACK[tagIdioma(language)] || SEARCH_FALLBACK['pt-BR']] : [])];
      let s = finishEmail(dropStaleNotices(text, new Set(current), new Set(email.rows().map(row=>row.link).filter(Boolean))), language, options);
      s=guardConnectorSearchClaims(s,{partial:nonEmailPartial || [...connectorCoverage.values()].some(row=>row.status!=='complete'),language});
      for(const warning of connectorSearchLimitations([...connectorCoverage.values()],language))s=appendWarning(s,warning);
      if (nonEmailPartial) s=appendWarning(s,SEARCH_FALLBACK[tagIdioma(language)] || SEARCH_FALLBACK['pt-BR']);
      return s;
    },
  };
}

const SOURCES_TITLE = /^(?:E-mails consultados|Emails consulted|Correos consultados):$/;
// The final text goes into the history, so the model learns to copy the notices
// and the source list into later answers, including turns where every search
// completed (2026-10-13 case: "Não consegui concluir parte da busca" with zero
// errors, and the plain source list above the linked one). Platform notices are
// removed from the model's text here, except the ones this turn really
// observed, which finish() keeps or adds once. Free prose about coverage is not touched.
function dropStaleNotices(text, current, observedLinks) {
  const notices = new Set([...Object.values(WARN), ...findConnectorSearchLimitations(text), ...findEmailCoverageWarnings(text)].filter(n=>!current.has(n)));
  const staleSources = p => {
    const [title, ...rows] = p.split('\n').map(line=>line.trim());
    return SOURCES_TITLE.test(title) && rows.length > 0 && rows.every(row=>row.startsWith('- '))
      && observedLinks.size > 0 && ![...observedLinks].some(link=>p.includes(link));
  };
  const parts = String(text ?? '').split(/(\n\s*\n)/); // paragraphs at even indexes, separators kept
  const stale = parts.map((p,i)=>i%2===0 && (notices.has(p.trim()) || staleSources(p.trim())));
  if (!stale.some(Boolean)) return String(text ?? '');
  return parts.filter((p,i)=>!stale[i] && !(i%2 && stale[i+1])).join('').trim();
}

function appendWarning(text, warning) {
  const s = String(text ?? '');
  // Only a literal copy in its own paragraph satisfies the protection. A free
  // sentence from the model about coverage, or a citation, doesn't substitute for it.
  if (s.split(/\n\s*\n/).some(paragraph=>paragraph.trim()===warning)) return s;
  return s.trim() ? `${s.trim()}\n\n${warning}` : warning;
}

// WhatsApp template goes through another synthesis step. It only preserves exact notices
// the checker already attached; it doesn't infer coverage from free sentences.
export function preserveSearchCoverageWarning(original, rewritten) {
  const warnings = [...Object.values(WARN).filter(w=>String(original).includes(w)), ...findConnectorSearchLimitations(original), ...findEmailCoverageWarnings(original)];
  let out = String(rewritten ?? '');
  if (!warnings.length) return out;
  // Only remove isolated literal copies or the prefix emitted by this
  // function. Don't delete prose just for words like "coverage" or "incomplete".
  out = out.split(/\n\s*\n/).filter(paragraph=>!warnings.includes(paragraph.trim())).join('\n\n').trim();
  for (const warning of warnings) {
    if (out.startsWith(warning) && (out.length===warning.length || /^\s/.test(out.slice(warning.length)))) out = out.slice(warning.length).trimStart();
  }
  // Prefix survives the template's size cut too; don't leave it at the end.
  return `${warnings.join(' ')} ${out}`.trim();
}
