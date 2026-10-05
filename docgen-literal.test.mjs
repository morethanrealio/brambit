// Offline: verifica o artefato gerado, sem provider, banco ou chamadas externas.
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
    // O PDF mínimo da casa grava o texto do content stream sem compressão.
    const text = format === 'pdf' ? out.buffer.toString('latin1') : extractDocumentText({ ...out });
    assert.ok(text.includes(content), `${format}: literal alterado: ${content}`);
    passed++;
  }
}
for (const format of ['docx', 'html']) {
  const out = await generateDocument({ format, content: '# Titulo\n**Negrito**\n* Item\n- Outro item\n1. Item numerado' });
  const text = extractDocumentText({ ...out });
  assert.ok(text.includes('Negrito') && !text.includes('**Negrito**'), `${format}: negrito`);
  assert.ok(text.includes('Item') && text.includes('Outro item') && text.includes('Item numerado'), `${format}: listas`);
  if (format === 'html') assert.ok(out.buffer.toString().includes('<strong>Negrito</strong>'));
  passed++;
}
// O content stream do PDF é serializado em latin1, mas as fontes são declaradas
// com /WinAnsiEncoding: bullet, aspas curvas, travessão e reticências têm que
// virar os bytes 0x95/0x93/0x94/0x97/0x85. Sem a tabela, o resto da divisão por
// 256 transformava "•" em aspas na devolutiva da jornada.
{
  const out = await generateDocument({ format: 'pdf', content: '- Item com “aspas” e travessão — aqui\n- Reticências…' });
  const pdf = out.buffer.toString('latin1');
  for (const [byte, nome] of [['\x95', 'bullet'], ['\x93', 'aspa de abertura'], ['\x94', 'aspa de fechamento'], ['\x97', 'travessão'], ['\x85', 'reticências']]) {
    assert.ok(pdf.includes(byte), `pdf: ${nome} fora do WinAnsi`);
  }
  assert.ok(!pdf.includes('(" Item com'), 'pdf: bullet não pode virar aspas');
  passed++;
}
// O que não existe na tabela de 8 bits vira '?', nunca o byte de outro glifo.
{
  const out = await generateDocument({ format: 'pdf', content: 'Kanji 夢 fora da tabela' });
  assert.ok(out.buffer.toString('latin1').includes('Kanji ? fora da tabela'), 'pdf: caractere fora do WinAnsi');
  passed++;
}
console.log(`${passed} verificacoes aprovadas (offline)`);
