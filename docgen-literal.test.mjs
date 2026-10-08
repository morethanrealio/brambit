// Offline: verifies the generated artifact, without provider, database, or external calls.
import assert from 'node:assert/strict';
import { generateDocument, extractDocumentText } from './web/docgen.mjs';
let passed = 0;
const literals = [
  '00020101021226580014BR.GOV.BCB.PIX5204000053039865802BR62070503***6304ABCD',
  'Codigo: abc*123',
  'Senha: a*b&c<d',
  'Token: abc*def*ghi',
  'Calculo: 2 * 3 = 6',
  'Asterisco final*',
];
for (const format of ['docx', 'pdf', 'html', 'txt', 'md']) {
  for (const content of literals) {
    const out = await generateDocument({ format, content });
    // The house's minimal PDF writes the content-stream text without compression.
    const text = format === 'pdf' ? out.buffer.toString('latin1') : extractDocumentText({ ...out });
    assert.ok(text.includes(content), `${format}: literal changed: ${content}`);
    passed++;
  }
}
for (const format of ['docx', 'html']) {
  const out = await generateDocument({ format, content: '# Titulo\n**Negrito**\n* Item\n- Outro item\n1. Item numerado' });
  const text = extractDocumentText({ ...out });
  assert.ok(text.includes('Negrito') && !text.includes('**Negrito**'), `${format}: bold`);
  assert.ok(text.includes('Item') && text.includes('Outro item') && text.includes('Item numerado'), `${format}: lists`);
  if (format === 'html') assert.ok(out.buffer.toString().includes('<strong>Negrito</strong>'));
  passed++;
}
// The PDF content stream is serialized in latin1, but the fonts are declared
// with /WinAnsiEncoding: bullet, curly quotes, dash, and ellipsis have to
// turn into bytes 0x95/0x93/0x94/0x97/0x85. Without the table, the remainder of division by
// 256 turned "•" into quotes in the journey's feedback.
{
  const out = await generateDocument({ format: 'pdf', content: '- Item com “aspas” e travessão — aqui\n- Reticências…' });
  const pdf = out.buffer.toString('latin1');
  for (const [byte, nome] of [['\x95', 'bullet'], ['\x93', 'aspa de abertura'], ['\x94', 'aspa de fechamento'], ['\x97', 'travessão'], ['\x85', 'reticências']]) {
    assert.ok(pdf.includes(byte), `pdf: ${nome} outside WinAnsi`);
  }
  assert.ok(!pdf.includes('(" Item com'), 'pdf: bullet must not turn into quotes');
  passed++;
}
// What doesn't exist in the 8-bit table turns into '?', never the byte of another glyph.
{
  const out = await generateDocument({ format: 'pdf', content: 'Kanji 夢 fora da tabela' });
  assert.ok(out.buffer.toString('latin1').includes('Kanji ? fora da tabela'), 'pdf: character outside WinAnsi');
  passed++;
}
console.log(`${passed} verificacoes aprovadas (offline)`);
