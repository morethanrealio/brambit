// Shrink-guard do publish (puro, sem I/O): compara o map de fonte que está no ar
// (`prev`) com o que vai ser publicado (`files`), ambos { caminho: base64 }.
//
// Bloqueia o pior modo de falha observado: reescrita de arquivo inteiro a partir de
// uma versão VELHA no contexto do modelo → publish full-replace apaga código bom.
//
// NÃO bloqueia reorganização: o modelo quebra um server.js grande em lib/*.js e o
// arquivo original encolhe, mas nada se perdeu (caso de 25/09: server.js
// 5,9→2,5 KB, app 20→110 KB, todas as rotas antigas presentes). Conta como
// reorganização só quando as três coisas valem juntas:
//   1) o app no total não encolheu;
//   2) os arquivos NOVOS somam pelo menos os bytes que saíram dos que encolheram/sumiram;
//   3) toda rota /api/... do servidor antigo continua no servidor novo.
// A reescrita velha típica falha no (2) ou no (3).

const size = (b64) => { try { return Buffer.from(b64, 'base64').length; } catch { return 0; } };
const text = (b64) => { try { return Buffer.from(b64, 'base64').toString('utf8'); } catch { return ''; } };
const isClient = (p) => p.startsWith('public/') || /\.(html|css|svg|png|jpe?g|gif|ico|md)$/i.test(p);
const ROTA = /["'`](\/api\/[A-Za-z0-9_\-/.:]*[A-Za-z0-9_\-:])/g;

export function rotasDoServidor(map) {
  const out = new Set();
  for (const [p, b64] of Object.entries(map || {})) {
    if (isClient(p)) continue;
    for (const m of text(b64).matchAll(ROTA)) out.add(m[1]);
  }
  return out;
}

export function avaliarReducao(prev, files) {
  let oldTotal = 0;
  let perdido = 0;
  const reducoes = [];
  for (const [p, b64] of Object.entries(prev || {})) {
    const antes = size(b64);
    oldTotal += antes;
    if (!(p in files)) {
      if (antes >= 512) { reducoes.push({ tipo: 'arquivo_sumiu', arquivo: p, antes, depois: 0 }); perdido += antes; }
      continue;
    }
    const depois = size(files[p]);
    if (antes >= 2048 && depois < antes * 0.5) {
      reducoes.push({ tipo: 'arquivo_encolheu', arquivo: p, antes, depois });
      perdido += antes - depois;
    }
  }
  let newTotal = 0;
  let novos = 0;
  for (const [p, b64] of Object.entries(files || {})) {
    const n = size(b64);
    newTotal += n;
    if (!(p in (prev || {}))) novos += n;
  }
  const encolheuTotal = newTotal < oldTotal * 0.6;
  if (encolheuTotal) reducoes.unshift({ tipo: 'total_encolheu', arquivo: '(app inteiro)', antes: oldTotal, depois: newTotal });

  let rotasSumidas = [];
  let reorganizacao = false;
  if (reducoes.length && !encolheuTotal && newTotal >= oldTotal && novos >= perdido) {
    const depois = rotasDoServidor(files);
    rotasSumidas = [...rotasDoServidor(prev)].filter((r) => !depois.has(r));
    reorganizacao = rotasSumidas.length === 0;
  }
  return { bloquear: reducoes.length > 0 && !reorganizacao, reorganizacao, reducoes, rotasSumidas, oldTotal, newTotal };
}
