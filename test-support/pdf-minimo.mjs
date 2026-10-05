// Gera um PDF mínimo VÁLIDO em memória, pra os testes não dependerem de nenhum
// arquivo binário commitado nem de rede. Dois sabores:
//   - comTexto: uma página com texto de verdade (camada de texto preenchida)
//   - soDesenho: uma página só com um retângulo colorido (camada de texto
//     VAZIA, que é exatamente o caso do logo/arte/escaneado)
// PDF cru mesmo: objetos numerados, xref com os offsets certos e trailer. Sem
// compressão, pra o arquivo continuar legível por quem for depurar o teste.
function montar(objetos) {
  const header = '%PDF-1.4\n';
  let corpo = '';
  const offsets = [];
  objetos.forEach((obj, i) => {
    offsets.push(header.length + corpo.length);
    corpo += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const startxref = header.length + corpo.length;
  let xref = `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(header + corpo + xref + trailer, 'latin1');
}

function pagina({ conteudo, recursos, largura = 400, altura = 300 }) {
  return montar([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${largura} ${altura}] /Contents 4 0 R /Resources << ${recursos} >> >>`,
    `<< /Length ${Buffer.byteLength(conteudo, 'latin1')} >>\nstream\n${conteudo}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}

export function pdfComTexto(texto = 'CONTRATO DE TESTE') {
  return pagina({
    conteudo: `BT /F1 24 Tf 40 150 Td (${texto.replace(/([()\\])/g, '\\$1')}) Tj ET`,
    recursos: '/Font << /F1 5 0 R >>',
  });
}

export function pdfSoDesenho() {
  // Fundo branco + um bloco azul no meio: é o formato de um logo vetorial
  // exportado em PDF (sem nenhum texto extraível).
  return pagina({
    conteudo: '1 1 1 rg 0 0 400 300 re f\n0.05 0.16 0.35 rg 100 90 200 120 re f',
    recursos: '/ProcSet [/PDF]',
  });
}
