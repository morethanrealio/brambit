// ── Checagem de sintaxe antes de gravar arquivo de app (parser de verdade) ──
// Medido na bancada de 19/09/2026: das 12 edições reais recusadas por "trecho
// não encontrado", resolver a âncora faz 12 casarem, mas só 7 dos textos NOVOS
// que o modelo mandou geram arquivo que compila. Gravar os outros 5 trocaria uma
// recusa inútil por um app quebrado. Aqui o host passa o resultado por um parser
// e devolve o erro do compilador, que é informação acionável.
//
// Regra de ouro: NUNCA bloquear uma edição que não piora o arquivo. Se o arquivo
// JÁ estava quebrado antes (o modelo pode estar justamente consertando), ou se o
// parser não está disponível, a gravação passa. O parser só parseia: não executa
// o código, não importa módulo, não resolve dependência.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const JS = /\.(js|mjs|cjs)$/i;
const PY = /\.py$/i;
const TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;

export function sintaxeChecavel(rel) { return JS.test(rel) || PY.test(rel) || /\.json$/i.test(rel); }

function rodar(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: 1 << 20, env: { ...process.env, NODE_OPTIONS: '' } },
      (err, stdout, stderr) => resolve({ err, saida: `${stderr || ''}${stdout || ''}` }));
  });
}

// Primeira linha útil do erro do parser, sem caminho temporário nem stack.
function limparErro(saida, arquivoTmp, rel) {
  const linhas = String(saida || '').split('\n')
    .filter((l) => !/^\s+at\s/.test(l) && !/^Node\.js v/.test(l) && !/ExperimentalWarning|Warning:/.test(l) && l.trim());
  const msg = linhas.find((l) => /SyntaxError|Error:/.test(l)) || linhas[0] || 'erro de sintaxe';
  const ctx = linhas.filter((l) => l !== msg).slice(0, 3).join('\n');
  return `${msg}\n${ctx}`.split(arquivoTmp).join(rel).replace(/\s+$/, '').slice(0, 800);
}

/**
 * Retorna { estado: 'ok' | 'erro' | 'pulado', erro? }. 'pulado' = não deu pra
 * checar (extensão sem parser, arquivo grande demais, binário ausente, timeout).
 */
export async function checarSintaxe(rel, fonte) {
  if (typeof fonte !== 'string' || !sintaxeChecavel(rel)) return { estado: 'pulado' };
  if (Buffer.byteLength(fonte, 'utf8') > MAX_BYTES) return { estado: 'pulado' };
  if (/\.json$/i.test(rel)) {
    try { JSON.parse(fonte); return { estado: 'ok' }; }
    catch (e) { return { estado: 'erro', erro: String(e.message).slice(0, 300) }; }
  }
  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), 'appsyn-'));
    if (PY.test(rel)) {
      const f = join(dir, 'a.py');
      await writeFile(f, fonte, 'utf8');
      // compile() só parseia; não importa nem executa o módulo.
      const r = await rodar('python3', ['-c', 'import sys;compile(open(sys.argv[1],encoding="utf-8").read(),"x","exec")', f]);
      if (!r.err) return { estado: 'ok' };
      if (r.err.code === 'ENOENT' || r.err.killed) return { estado: 'pulado' };
      return { estado: 'erro', erro: limparErro(r.saida, f, rel) };
    }
    // JS: o mesmo .js pode ser CommonJS ou ESM conforme o package.json do app.
    // Só é erro o que falha nas DUAS leituras; assim nenhum arquivo válido é
    // barrado por causa do dialeto.
    const cjs = join(dir, 'a.cjs');
    await writeFile(cjs, fonte, 'utf8');
    const r1 = await rodar(process.execPath, ['--check', cjs]);
    if (!r1.err) return { estado: 'ok' };
    if (r1.err.code === 'ENOENT' || r1.err.killed) return { estado: 'pulado' };
    const mjs = join(dir, 'a.mjs');
    await writeFile(mjs, fonte, 'utf8');
    const r2 = await rodar(process.execPath, ['--check', mjs]);
    if (!r2.err) return { estado: 'ok' };
    if (r2.err.killed) return { estado: 'pulado' };
    // Reporta o dialeto que o arquivo aparenta usar.
    const pareceEsm = /^\s*(import\s|export\s|export\{)/m.test(fonte);
    return { estado: 'erro', erro: pareceEsm ? limparErro(r2.saida, mjs, rel) : limparErro(r1.saida, cjs, rel) };
  } catch {
    return { estado: 'pulado' };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Portão de gravação: só bloqueia quando a edição QUEBRA um arquivo que estava
 * íntegro. Retorna null pra liberar, ou { erro } pra recusar.
 */
export async function pioraSintaxe(rel, fonteAntes, fonteDepois) {
  if (!sintaxeChecavel(rel)) return null;
  const depois = await checarSintaxe(rel, fonteDepois);
  if (depois.estado !== 'erro') return null;
  const antes = await checarSintaxe(rel, fonteAntes);
  if (antes.estado !== 'ok') return null;
  return { erro: depois.erro };
}
