// ── Extração de texto de PDF ──
// Mesma ideia do STT (áudio→texto) e da visão (imagem→texto): pegamos o PDF que o
// usuário mandou (WhatsApp, anexo web, link ou Drive), extraímos o TEXTO e
// injetamos na mensagem pro assistente. Assim funciona com QUALQUER modelo
// (o primário GLM não recebe PDF inline), igual ao áudio transcrito.
//
// Usa pdf-parse v2 (classe PDFParse). É só extração de texto; PDF que é só imagem
// escaneada (sem camada de texto) volta vazio — nesse caso avisamos honestamente.
import { PDFParse } from 'pdf-parse';

export function pdfEnabled() {
  return true; // depende só do pacote pdf-parse (instalado no host)
}

// Extrai texto de um Buffer de PDF. Retorna { text, pages, truncated }.
// maxChars corta o texto pra não estourar o contexto (PDF grande vira muitos
// tokens). O corte é honesto: sinalizamos com `truncated`.
export async function extractPdfText(buffer, { maxChars = 20000 } = {}) {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const parser = new PDFParse({ data });
  try {
    const r = await parser.getText();
    let text = String(r?.text || '');
    // pdf-parse v2 insere marcadores "-- N of M --" entre páginas; limpamos.
    text = text.replace(/\n*-- \d+ of \d+ --\n*/g, '\n\n').replace(/\n{3,}/g, '\n\n').trim();
    const pages = r?.pages?.length ?? r?.total ?? 0;
    const truncated = text.length > maxChars;
    if (truncated) text = text.slice(0, maxChars);
    return { text, pages, truncated };
  } finally {
    // libera recursos do worker do pdfjs
    try { await parser.destroy?.(); } catch { /* noop */ }
  }
}

// ── PDF → imagem (PNG) ──
// Nem todo PDF é texto. Logo de marca, arte, papel timbrado e documento
// escaneado chegam como PDF mas são IMAGEM: a camada de texto vem vazia e o
// arquivo virava beco sem saída ("não consegui extrair texto"). Rasterizar a
// página resolve os dois lados: o assistente passa a poder OLHAR a página
// (ver_midia) e passa a ter material de imagem de verdade pra usar numa
// composição (compor_imagem), com a arte original em pixel, sem redesenhar.
//
// Usa o mesmo pdf-parse que já extrai o texto (getScreenshot), então não entra
// dependência nova. `desiredWidth` fixa a largura em px e ignora a escala, o que
// dá tamanho previsível independente do tamanho da página do PDF.
export async function renderPdfPagesToPng(buffer, { pages = 1, width = 1600 } = {}) {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const quantas = Math.max(1, Math.min(Number(pages) || 1, 5));
  const largura = Math.max(200, Math.min(Number(width) || 1600, 3000));
  const parser = new PDFParse({ data });
  try {
    const r = await parser.getScreenshot({
      partial: Array.from({ length: quantas }, (_, i) => i + 1),
      desiredWidth: largura,
      imageDataUrl: false, // só o buffer; o dataUrl dobraria o uso de memória à toa
    });
    const total = r?.total ?? r?.pages?.length ?? 0;
    const imagens = (r?.pages || [])
      .filter((p) => p?.data?.length)
      .map((p) => ({
        png: Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data),
        width: p.width,
        height: p.height,
        page: p.pageNumber,
      }));
    return { imagens, total };
  } finally {
    try { await parser.destroy?.(); } catch { /* noop */ }
  }
}
