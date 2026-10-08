// ── PDF text extraction ──
// Same idea as STT (audio→text) and vision (image→text): we take the PDF the
// user sent (WhatsApp, web attachment, link or Drive), extract the TEXT and
// inject it into the message for the assistant. This way it works with ANY
// model (the primary GLM does not accept inline PDF), just like transcribed audio.
//
// Uses pdf-parse v2 (PDFParse class). It is text extraction only; a PDF that is
// just a scanned image (no text layer) comes back empty — in that case we warn honestly.
import { PDFParse } from 'pdf-parse';

export function pdfEnabled() {
  return true; // depends only on the pdf-parse package (installed on the host)
}

// Extracts text from a PDF Buffer. Returns { text, pages, truncated }.
// maxChars cuts the text so it doesn't blow up the context (a large PDF becomes
// many tokens). The cut is honest: we signal it with `truncated`.
export async function extractPdfText(buffer, { maxChars = 20000 } = {}) {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const parser = new PDFParse({ data });
  try {
    const r = await parser.getText();
    let text = String(r?.text || '');
    // pdf-parse v2 inserts "-- N of M --" markers between pages; we clean those up.
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

// ── PDF → image (PNG) ──
// Not every PDF is text. Brand logo, artwork, letterhead and scanned
// documents arrive as PDF but are IMAGE: the text layer comes back empty and
// the file turned into a dead end ("couldn't extract text"). Rasterizing the
// page solves both sides: the assistant can now LOOK at the page
// (ver_midia) and gets real image material to use in a
// composition (compor_imagem), with the original artwork in pixels, without redrawing.
//
// Uses the same pdf-parse that already extracts text (getScreenshot), so no
// new dependency is added. `desiredWidth` fixes the width in px and ignores the scale, which
// gives a predictable size regardless of the PDF's page size.
export async function renderPdfPagesToPng(buffer, { pages = 1, width = 1600 } = {}) {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const quantas = Math.max(1, Math.min(Number(pages) || 1, 5));
  const largura = Math.max(200, Math.min(Number(width) || 1600, 3000));
  const parser = new PDFParse({ data });
  try {
    const r = await parser.getScreenshot({
      partial: Array.from({ length: quantas }, (_, i) => i + 1),
      desiredWidth: largura,
      imageDataUrl: false, // buffer only; the dataUrl would needlessly double memory usage
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
