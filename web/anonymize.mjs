// ── Anonimização de snapshot no PUBLISH-para-biblioteca ──
// Quando um app é tornado PÚBLICO (definir_visibilidade_sistema → público), o
// snapshot de CÓDIGO que ficará copiável passa por uma limpeza única: um modelo
// barato (Gemini Flash Lite) detecta conteúdo do dono (nome pessoal, cidade,
// dados reais que sobraram no fonte, seed com registros reais) e devolve uma
// lista de SUBSTITUIÇÕES literais {file, find, replace} por equivalentes
// genéricos/de exemplo. Aplicamos as trocas por match EXATO de substring — nunca
// reescrevemos o arquivo inteiro, então o modelo não tem como quebrar a sintaxe:
// se um `find` não bater, a troca é simplesmente ignorada.
//
// Roda 1x, no momento de publicar na biblioteca (não a cada deploy, não a cada
// cópia). O resultado é gravado no próprio snapshot. É best-effort: se o modelo
// falhar ou não devolver nada, o snapshot original segue intacto (não bloqueia
// a publicação).
//
// Escopo: só o CÓDIGO do snapshot. Segredo não vive aqui (cofre) e dado de
// runtime não viaja (/app/data). Isto cuida do que sobra HARDCODED no fonte.

import zlib from 'node:zlib';
import { makeGemini } from '../core-proto/providers/gemini.mjs';
import { modeloPara } from '../core-proto/modelos.mjs';

const CHEAP_MODEL = 'gemini-3.1-flash-lite';
const TEXT_EXT = /\.(js|mjs|ts|jsx|tsx|html?|css|json|py|txt|md|csv)$/i;
const MAX_FILE_CHARS = 12000;   // trecho por arquivo enviado ao modelo
const MAX_TOTAL_CHARS = 60000;  // teto do prompt inteiro
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

function readSnapshot(blob) {
  if (typeof blob !== 'string' || !blob.startsWith('gz1:')) return null;
  try {
    const gz = Buffer.from(blob.slice(4), 'base64');
    return JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
  } catch { return null; }
}

function buildSnapshot(files) {
  try {
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(files), 'utf8'));
    if (gz.length > MAX_SNAPSHOT_BYTES) return null;
    return 'gz1:' + gz.toString('base64');
  } catch { return null; }
}

function parseJsonArray(t) {
  if (!t) return null;
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = t.indexOf('['); const j = t.lastIndexOf(']');
  if (i === -1 || j === -1 || j < i) return null;
  try { return JSON.parse(t.slice(i, j + 1)); } catch { return null; }
}

function buildPrompt(textFiles) {
  const blocks = [];
  let total = 0;
  for (const [rel, content] of textFiles) {
    const snippet = content.length > MAX_FILE_CHARS ? content.slice(0, MAX_FILE_CHARS) : content;
    if (total + snippet.length > MAX_TOTAL_CHARS) break;
    total += snippet.length;
    blocks.push(`### ARQUIVO: ${rel}\n${snippet}`);
  }
  return [
    'Este é o CÓDIGO-FONTE de um app que vai ser publicado numa biblioteca pública, onde outras pessoas vão COPIAR o app pro próprio espaço.',
    'A cópia não pode carregar nada identificável ou pessoal do dono original. Seu trabalho é achar, no fonte, o conteúdo que precisa virar genérico/de exemplo:',
    '',
    'TROCAR (identificável ou dado real do dono):',
    '• nomes de pessoas reais (dono, clientes, membros, jogadores) → nomes genéricos ("Jogador 1", "Cliente exemplo") ou vazio quando é assinatura/branding pessoal;',
    '• cidade/bairro/endereço/telefone/e-mail/CPF/OAB/@ pessoais → genérico ou vazio;',
    '• nome próprio de negócio/marca do dono em título, cabeçalho, rodapé → um rótulo genérico do TIPO do app (ex: "Ateliê de Cerâmica", "Lista de Presença");',
    '• seed/exemplos com registros REAIS (uma lista de nomes reais, peças reais, contas reais) → exemplos genéricos e plausíveis, MESMO formato e quantidade parecida ("Item de exemplo", "Conta de exemplo").',
    '',
    'NÃO TOCAR (é estrutura de código, tem que continuar funcionando):',
    '• nomes de variáveis, funções, tabelas, colunas, rotas/paths de API, chaves de JSON, imports, seletores CSS/HTML (id/class), nomes de arquivo;',
    '• textos genéricos de interface ("Salvar", "Adicionar", "Nome", "Categoria"), comentários técnicos;',
    '• process.env / os.environ / placeholders.',
    '',
    'Responda SÓ com um array JSON de objetos {"file","find","replace"}, onde:',
    '• "file" = o caminho exato do arquivo (como no cabeçalho ARQUIVO acima);',
    '• "find" = a substring EXATA e literal que está no arquivo (copie idêntica, com acentos e pontuação);',
    '• "replace" = o texto genérico que entra no lugar (pode ser "" pra remover).',
    'Cada "find" tem que existir literalmente no arquivo. Não invente. Se não houver nada pra trocar, responda [].',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

// Recebe o blob de snapshot (gz1:...) e devolve { blob, changed, applied, error }.
// Em qualquer falha, devolve o blob ORIGINAL com changed=false.
export async function anonymizeSnapshotBlob(blob, { log = () => {} } = {}) {
  const files = readSnapshot(blob);
  if (!files || !Object.keys(files).length) return { blob, changed: false, applied: 0 };
  if (!process.env.GEMINI_API_KEY && !modeloPara('classificacao')) { log('[anon] sem GEMINI_API_KEY, pulando'); return { blob, changed: false, applied: 0 }; }

  // Decodifica só os arquivos de texto.
  const textFiles = [];
  const decoded = {};
  for (const [rel, b64] of Object.entries(files)) {
    if (!TEXT_EXT.test(rel)) continue;
    try {
      const txt = Buffer.from(b64, 'base64').toString('utf8');
      decoded[rel] = txt;
      textFiles.push([rel, txt]);
    } catch { /* ignora binário/ilegível */ }
  }
  if (!textFiles.length) return { blob, changed: false, applied: 0 };

  let arr;
  try {
    const r = await (modeloPara('classificacao', { maxTokens: 4096 }) || makeGemini({ model: CHEAP_MODEL, thinkingBudget: 0, maxOutputTokens: 4096 }))
      .complete({
        system: 'Você anonimiza código pra publicação pública. Responde só com JSON válido, sem comentários.',
        messages: [{ role: 'user', content: buildPrompt(textFiles) }],
        tools: [],
      });
    arr = parseJsonArray(r.text);
  } catch (e) {
    log('[anon] erro no modelo: ' + (e?.message || e));
    return { blob, changed: false, applied: 0, error: String(e?.message || e) };
  }
  if (!Array.isArray(arr) || !arr.length) return { blob, changed: false, applied: 0 };

  // Aplica as trocas por match EXATO. Nunca quebra sintaxe: se o find não estiver
  // no arquivo, a troca é ignorada. Guarda contra find vazio/curto demais.
  let applied = 0;
  for (const o of arr) {
    if (!o || typeof o.file !== 'string' || typeof o.find !== 'string') continue;
    const rel = o.file.replace(/^\/+/, '');
    const find = o.find;
    const replace = typeof o.replace === 'string' ? o.replace : '';
    if (find.length < 2) continue;
    if (find === replace) continue;
    if (!(rel in decoded)) continue;
    if (!decoded[rel].includes(find)) continue;
    decoded[rel] = decoded[rel].split(find).join(replace);
    applied++;
  }
  if (!applied) return { blob, changed: false, applied: 0 };

  // Reconstrói o snapshot com os arquivos de texto atualizados (binários intactos).
  const out = { ...files };
  for (const rel of Object.keys(decoded)) {
    out[rel] = Buffer.from(decoded[rel], 'utf8').toString('base64');
  }
  const newBlob = buildSnapshot(out);
  if (!newBlob) return { blob, changed: false, applied: 0 };
  log(`[anon] ${applied} troca(s) aplicada(s) no snapshot`);
  return { blob: newBlob, changed: true, applied };
}
