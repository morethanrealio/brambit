// Publish shrink-guard (pure, no I/O): compares the source map that is live
// (`prev`) with what is about to be published (`files`), both { path: base64 }.
//
// Blocks the worst failure mode observed: rewriting a whole file from an OLD
// version in the model's context → full-replace publish wipes out good code.
//
// Does NOT block reorganization: the model splits a big server.js into
// lib/*.js and the original file shrinks, but nothing was lost (case of
// 2026-09-25: server.js 5,9→2,5 KB, app 20→110 KB, all old routes still present).
// Only counts as reorganization when all three hold together:
//   1) the app's total size did not shrink;
//   2) the NEW files add up to at least the bytes that left the ones that
//      shrank/disappeared;
//   3) every /api/... route from the old server is still in the new server.
// The typical old-style rewrite fails at (2) or (3).

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
