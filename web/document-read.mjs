// Leitura textual paginada: preserva tabelas e declara estruturas não textuais.
import { createHash } from 'node:crypto';
export function readGoogleDocument(doc, { offset = 0, max_chars = 8000, revision = null } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset inválido');
  if (!Number.isSafeInteger(max_chars) || max_chars < 1 || max_chars > 16000) throw new Error('max_chars deve estar entre 1 e 16000');
  const warnings = new Set(); let tables = 0;
  const walk = (content = []) => content.map(c => {
    if (c.paragraph) return (c.paragraph.elements || []).map(e => {
      if (e.textRun) return e.textRun.content || '';
      if (e.inlineObjectElement) { warnings.add('Imagens/objetos não foram lidos por esta ferramenta.'); return '[objeto não textual]'; }
      if (e.footnoteReference) { warnings.add('Há notas de rodapé fora do corpo principal.'); return '[nota de rodapé]'; }
      if (e.person || e.richLink) { warnings.add('Há chips/links estruturados; conteúdo externo não foi lido.'); return e.person?.personProperties?.name || e.richLink?.richLinkProperties?.title || '[chip]'; }
      if (e.pageBreak || e.columnBreak) return '\n';
      warnings.add('Há elementos de parágrafo não textuais não extraídos.'); return '';
    }).join('');
    if (c.table) { tables++; return '\n[tabela]\n' + (c.table.tableRows || []).map(row => (row.tableCells || []).map(cell => walk(cell.content).trim()).join('\t')).join('\n') + '\n[/tabela]\n'; }
    if (c.tableOfContents) return '\n[sumário]\n' + walk(c.tableOfContents.content);
    if (c.sectionBreak) return '\n';
    warnings.add('Há estruturas não extraídas.'); return '';
  }).join('');
  const parts=[];
  function tab(t) {
    if (t.documentTab) { parts.push(`[aba: ${t.tabProperties?.title || t.tabProperties?.tabId || 'sem título'}]\n` + walk(t.documentTab.body?.content));
      if (Object.keys(t.documentTab.headers || {}).length || Object.keys(t.documentTab.footers || {}).length || Object.keys(t.documentTab.footnotes || {}).length) warnings.add('Cabeçalhos, rodapés e notas não incluídos no corpo.'); }
    for (const child of t.childTabs || []) tab(child);
  }
  if (doc.tabs?.length) for (const t of doc.tabs) tab(t); else parts.push(walk(doc.body?.content));
  if (Object.keys(doc.headers || {}).length || Object.keys(doc.footers || {}).length || Object.keys(doc.footnotes || {}).length) warnings.add('Cabeçalhos, rodapés e notas não incluídos no corpo.');
  const all=parts.join('\n'); const version=createHash('sha256').update(all).digest('hex');
  if (offset && (!revision || revision !== version)) return {title:doc.title, text:'', changed:true, partial:true, restart_offset:0, warning:'Para continuar, use revision da primeira página. Se mudou, releia desde offset 0; não misture versões.'};
  if (offset > all.length) throw new Error('offset além do texto');
  let end=Math.min(all.length,offset+max_chars);
  // Não quebrar um caractere suplementar entre páginas UTF-16.
  if(end<all.length && /[\uD800-\uDBFF]/.test(all[end-1])) end--;
  if(end===offset && end<all.length) end=Math.min(all.length,offset+2);
  const has_more=end<all.length;
  return { title:doc.title,text:all.slice(offset,end),offset,total_chars:all.length,revision:version,has_more,next_offset:has_more?end:null,partial:has_more||offset>0||warnings.size>0,tables, warnings:[...warnings],...(has_more?{continuation:'Leia docs_read novamente com o mesmo id, revision e next_offset como offset antes de afirmar leitura completa.'}:{}) };
}
