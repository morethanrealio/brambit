// A successful HTTP/extract response can contain only a page's frame. This is
// a reading signal, not a factual judge or a minimum article-length contract.
export function pageContentQuality(text, url = '') {
  const raw = String(text || '');
  const content = raw.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  let host = '', path = '';
  try { const u = new URL(url); host = u.hostname; path = u.pathname; } catch {}
  // arXiv's failed extracts retain a long arXivLabs/footer while omitting the
  // actual abstract. Length alone classified that frame as a useful paper.
  if (/(^|\.)arxiv\.org$/i.test(host) && /^\/abs\//.test(path)) {
    const abstract = content.match(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:Abstract|Resumo)\s*:?\s*([\s\S]*?)(?=\n\s*(?:#{1,6}\s*)?(?:Comments:|Subjects:|Cite as:|Submission history|References|Access Paper:)|$)/i)?.[1] || '';
    const bodyCharacters = abstract.replace(/\s+/g, ' ').trim().length;
    return { sufficient: bodyCharacters >= 80, bodyCharacters, reason: bodyCharacters >= 80 ? '' : 'abstract_missing' };
  }
  const lines = content.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const prose = lines.filter(s => !/^#{1,6}\s|^\||^[-=_\s]+$/.test(s)
    && !/^(?:Home|Menu|Navigation|Sign in|Subscribe|Share|Bookmark|References & Citations|Access Paper|Submission history|Privacy|Terms|Copyright)\b/i.test(s));
  const bodyCharacters = prose.join(' ').replace(/\s+/g, ' ').length;
  return { sufficient: bodyCharacters >= 80, bodyCharacters, reason: bodyCharacters >= 80 ? '' : 'sparse_content' };
}

export const PARTIAL_PAGE_MARKER = '[LEITURA PARCIAL: não consegui obter conteúdo suficiente desta página. Não deduza resumo, autoria ou data a partir do título ou do rodapé.]';

export async function improvePageReading(original, readDirect) {
  const quality = pageContentQuality(original.text, original.url);
  if (quality.sufficient) return { ...original, partial: false };
  try {
    const direct = await readDirect();
    const next = pageContentQuality(direct.text, direct.url || original.url);
    if (next.sufficient || next.bodyCharacters > quality.bodyCharacters) return { ...direct, partial: !next.sufficient };
  } catch { /* Keep observed partial content when the fallback is unavailable. */ }
  return { ...original, partial: true };
}
