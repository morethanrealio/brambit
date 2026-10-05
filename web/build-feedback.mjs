// Only prose questions, never fragments of fenced/inline code or ternary syntax.
// Pure, bounded and conservative; not a semantic classifier or execution receipt.
export function buildQuestions(text) {
  let fence = null;
  const prose = [];
  for (const line of String(text || '').slice(0, 30000).split('\n')) {
    const marker = line.trim().match(/^(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1][0]; else if (fence === marker[1][0]) fence = null; continue; }
    if (fence) continue;
    const clean = line.replace(/`[^`]*`/g, '').trim();
    if (!clean || /^(?:>|exemplo\s*:|example\s*:|ejemplo\s*:)/i.test(clean)) continue;
    if (/\b(?:const|let|var|function|return|throw|decodeURIComponent|console\.log)\b|=>|[{};]|\?\.|\?\?|=/i.test(clean.replace(/\?\s*$/, ''))) continue;
    prose.push(clean);
  }
  return prose.flatMap(line => line.split(/(?<=[.!?])\s+/))
    .map(s => s.replace(/^(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter(s => s.endsWith('?') && s.length <= 500 && !/\b(?:publicar|publicação|publicacion|publicación|publish|publishing)\b/i.test(s))
    .filter(s => /^(?:¿\s*)?(?:qual|quais|como|onde|quando|quanto|quantos|quantas|você|vocês|voce|pode|podemos|prefere|quer|precisa|o que|por que|what|which|how|where|when|who|do you|would you|could you|can you|can we|should|is|are|cuál|cuáles|qué|cómo|dónde|cuándo|cuánto|prefieres|quieres|puedes|podemos)(?=\s|[?!:,]|$)/i.test(s))
    .slice(0, 3);
}
export function buildInterruption(ev) {
  if (ev?.type !== 'loop_break') return null;
  return { ferramenta:/^[a-z_]{1,80}$/.test(ev.tool || '') ? ev.tool : 'desconhecida',
    motivo:['unchanged_revision','revision_unavailable','identical_call'].includes(ev.reason) ? ev.reason : 'repeated_calls',
    repeticoes:Number.isSafeInteger(ev.repeatCount) ? ev.repeatCount : 3,
    revisao_considerada:ev.revisionAware === true };
}
const texts = {
  pt: {saved:n=>`Há alterações salvas em ${n} arquivo(s) do rascunho.`,pending:'Falta concluir a validação do rascunho.',checked:'A consistência estática foi verificada, mas a conclusão da tarefa ainda está pendente.',repeat:'Uma operação se repetiu sem progresso comprovado; preciso revisar esse ponto para continuar.'},
  en: {saved:n=>`Changes are saved in ${n} draft file(s).`,pending:'Draft validation still needs to finish.',checked:'Static consistency was checked, but completion of the task is still pending.',repeat:'An operation repeated without verified progress; I need to review that step before continuing.'},
  es: {saved:n=>`Hay cambios guardados en ${n} archivo(s) del borrador.`,pending:'Falta completar la validación del borrador.',checked:'Se verificó la consistencia estática, pero la tarea todavía no está terminada.',repeat:'Una operación se repitió sin progreso verificado; necesito revisar ese paso para continuar.'},
};
export function buildProgress(build, language = 'pt-BR') {
  if (build?.estado === 'consistencia_validada') return '';
  const w = texts[/^en\b/i.test(language) ? 'en' : /^es\b/i.test(language) ? 'es' : 'pt'];
  const n = Array.isArray(build?.arquivos) ? new Set(build.arquivos.filter(x=>typeof x==='string')).size : 0;
  return [n ? w.saved(n) : '', build?.validacao === 'aprovado' ? w.checked : n ? w.pending : '', build?.interrupcao ? w.repeat : ''].filter(Boolean).join(' ');
}
