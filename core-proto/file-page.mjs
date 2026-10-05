// Bounded JSON pages: cursor uses UTF-16 offsets, never splits a surrogate pair.
// Only the content is paged; hash always identifies the WHOLE file.
export function filePage({ content, hash, arquivo, bytes, inicio = 0, limite = 6000, hash_esperado }) {
  if (!Number.isSafeInteger(inicio) || inicio < 0 || inicio > content.length ||
      !Number.isSafeInteger(limite) || limite < 1) return { ok:false, error:'Intervalo inválido.' };
  if ((inicio > 0 && !hash_esperado) || (hash_esperado && hash_esperado !== hash))
    return { ok:false, error:'A continuação exige o hash atual do arquivo inteiro. Recomece a leitura.', hash };
  if (inicio && /[\uDC00-\uDFFF]/.test(content[inicio]) && /[\uD800-\uDBFF]/.test(content[inicio - 1]))
    return { ok:false, error:'Use o proximo_inicio devolvido pela leitura anterior.' };
  let end = Math.min(content.length, inicio + Math.min(limite, 6000));
  if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end++;
  const pack = () => ({ ok:true, arquivo, bytes, hash, inicio, fim:end, total_chars:content.length,
    parcial:inicio > 0 || end < content.length, proximo_inicio:end < content.length ? end : null,
    conteudo:content.slice(inicio, end),
    obs:'Continue em proximo_inicio com hash_esperado=hash. Conteúdo parcial NÃO é arquivo completo: use edição por trecho, nunca sobrescreva o arquivo com esta página.' });
  // Escaping can amplify sixfold (control chars); stay below the core's 24k cap.
  while (JSON.stringify(pack()).length > 20000 && end > inicio + 2) {
    end = inicio + Math.floor((end - inicio) * .8);
    if (/[\uD800-\uDBFF]/.test(content[end - 1])) end--;
  }
  if (JSON.stringify(pack()).length > 20000) return { ok:false, error:'Metadados do arquivo excedem o limite de leitura.' };
  return pack();
}
export function retainedFilePage(text) {
  try {
    const d = JSON.parse(text);
    if (d?.ok !== true || !Number.isSafeInteger(d.fim) || typeof d.hash !== 'string' || !('proximo_inicio' in d)) return null;
    const { conteudo, ...meta } = d;
    return JSON.stringify({ ...meta, conteudo:'[trecho já lido, recolhido para poupar contexto]' });
  } catch { return null; }
}
