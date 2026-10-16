// Generates a minimal VALID PDF in memory, so tests don't depend on any
// committed binary file or on the network. Two flavors:
//   - comTexto: a page with real text (text layer filled in)
//   - soDesenho: a page with just a colored rectangle (text layer
//     EMPTY, which is exactly the case for a logo/art/scan)
// Truly raw PDF: numbered objects, xref with the right offsets and trailer. No
// compression, so the file stays readable for whoever debugs the test.
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
  // White background + a blue block in the middle: it's the format of a vector logo
  // exported to PDF (with no extractable text at all).
  return pagina({
    conteudo: '1 1 1 rg 0 0 400 300 re f\n0.05 0.16 0.35 rg 100 90 200 120 re f',
    recursos: '/ProcSet [/PDF]',
  });
}
