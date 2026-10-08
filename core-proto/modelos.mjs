// ── Providers and models per function (modelos.yaml) ──
// Whoever installs Brambit picks, in a commented file, WHICH providers to use
// and WHICH model each function uses (with an optional fallback model). A
// provider is data, not code: name + address + the .env variable holding the key.
// Any service speaking the OpenAI protocol (/chat/completions) fits this way;
// Gemini has its own protocol and comes in with `tipo: gemini`.
//
// Without the file, everything returns null and the server follows the usual
// built-in routing (which is the case for our production today). The example model, with each field
// explained, is in modelos.example.yaml at the root of the repo.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { makeOpenAI } from './providers/openai.mjs';
import { makeGemini } from './providers/gemini.mjs';
import { throwIfAttemptControl } from './provider-attempt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIPOS = new Set(['openai', 'gemini']);

// A function without a line in the file uses its "parent" function's; `padrao` is the root of all of them.
export const FUNCOES = {
  padrao: { mae: null, o: 'tudo que não tiver linha própria' },
  conversa: { mae: 'padrao', o: 'turno do assistente com o usuário (precisa chamar ferramentas)' },
  imagem: { mae: 'conversa', o: 'turno em que o usuário mandou foto (precisa enxergar imagem)' },
  leitura_imagem: { mae: 'imagem', o: 'descrever/ler texto de uma imagem guardada ou anexo' },
  pesquisa: { mae: 'padrao', o: 'sub-agentes de leitura: web, Google, conectores, resumo da home' },
  programacao: { mae: 'padrao', o: 'escrever código, construir app, planilhas' },
  memoria: { mae: 'padrao', o: 'manter o perfil e o resumo das conversas' },
  classificacao: { mae: 'padrao', o: 'tarefas curtas de rótulo/JSON: assuntos, moderação, risco de app, ofertas de rotina' },
};

export function arquivoModelos(env = process.env) {
  return env.MODELOS_ARQUIVO ? path.resolve(env.MODELOS_ARQUIVO) : path.join(ROOT, 'modelos.yaml');
}

// Reads and validates. A typo in the file brings down the boot with the
// problem's line, instead of turning into a mysterious "serviço indisponível" in the chat.
export function lerModelos(texto, origem = 'modelos.yaml') {
  const erro = (msg) => { throw new Error(`${origem}: ${msg}`); };
  let doc;
  try { doc = parse(texto) ?? {}; } catch (e) { erro(`não consegui ler o arquivo (${e.message})`); }
  if (typeof doc !== 'object' || Array.isArray(doc)) erro('o arquivo precisa ter as seções provedores e funcoes');
  const provedores = {};
  for (const [nome, p] of Object.entries(doc.provedores ?? {})) {
    if (!p || typeof p !== 'object') erro(`provedor "${nome}" precisa de campos (endereco, chave)`);
    const tipo = p.tipo ?? 'openai';
    if (!TIPOS.has(tipo)) erro(`provedor "${nome}": tipo "${tipo}" não existe (use openai ou gemini)`);
    if (tipo === 'openai' && !p.endereco) erro(`provedor "${nome}": falta o endereco (ex.: https://api.together.xyz/v1)`);
    if (tipo === 'gemini' && !p.chave) erro(`provedor "${nome}": o Gemini precisa da chave`);
    if (p.chave != null && !/^[A-Z][A-Z0-9_]*$/.test(String(p.chave))) {
      erro(`provedor "${nome}": chave é o NOME da variável do .env (ex.: TOGETHER_API_KEY), não a chave em si`);
    }
    provedores[nome] = { nome, tipo, endereco: p.endereco ? String(p.endereco).replace(/\/+$/, '') : null, chave: p.chave ?? null };
  }
  const alvo = (valor, onde) => {
    const v = typeof valor === 'string' ? { modelo: valor } : valor;
    if (!v?.modelo) erro(`${onde}: falta o modelo (formato provedor/modelo)`);
    const s = String(v.modelo), i = s.indexOf('/');
    if (i <= 0 || i === s.length - 1) erro(`${onde}: "${s}" precisa ser provedor/modelo (ex.: together/deepseek-ai/DeepSeek-V4.1-Flash)`);
    const provedor = s.slice(0, i);
    if (!provedores[provedor]) erro(`${onde}: o provedor "${provedor}" não está na seção provedores`);
    if (v.opcoes != null && (typeof v.opcoes !== 'object' || Array.isArray(v.opcoes))) erro(`${onde}: opcoes precisa ser uma lista de campo: valor`);
    return { provedor, modelo: s.slice(i + 1), opcoes: v.opcoes ?? null };
  };
  const funcoes = {};
  for (const [nome, f] of Object.entries(doc.funcoes ?? {})) {
    if (!FUNCOES[nome]) erro(`função "${nome}" não existe (use: ${Object.keys(FUNCOES).join(', ')})`);
    if (f == null) continue;
    const principal = alvo(f, `funcoes.${nome}`);
    const reserva = typeof f === 'object' && f.reserva ? alvo(f.reserva, `funcoes.${nome}.reserva`) : null;
    funcoes[nome] = { principal, reserva };
  }
  if (!funcoes.padrao && !funcoes.conversa) erro('preencha pelo menos funcoes.padrao (ou funcoes.conversa)');
  const precos = {};
  for (const [modelo, p] of Object.entries(doc.precos ?? {})) {
    const n = (k) => { const x = Number(p?.[k] ?? 0); if (!Number.isFinite(x) || x < 0) erro(`precos.${modelo}.${k} precisa ser um número`); return x; };
    precos[modelo] = { in: n('entrada'), cachedIn: n('cache'), out: n('saida') };
  }
  return { provedores, funcoes, precos };
}

let cache;
export function carregarModelos({ env = process.env, recarregar = false } = {}) {
  if (cache !== undefined && !recarregar) return cache;
  const file = arquivoModelos(env);
  cache = existsSync(file) ? lerModelos(readFileSync(file, 'utf8'), path.basename(file)) : null;
  return cache;
}

// Resolves the inheritance: { funcao, de, principal, reserva } or null.
export function escolhaDe(funcao, cfg = carregarModelos()) {
  if (!cfg) return null;
  for (let f = funcao; f; f = FUNCOES[f]?.mae) {
    if (cfg.funcoes[f]) return { funcao, de: f, ...cfg.funcoes[f] };
  }
  return null;
}

export function construirModelo(alvo, { maxTokens = 8192, cfg = carregarModelos(), env = process.env } = {}) {
  const p = cfg.provedores[alvo.provedor];
  const apiKey = p.chave ? (env[p.chave] || '') : null;
  if (p.tipo === 'gemini') {
    // search:false: search comes in through the buscar_web tool, same as the others.
    return makeGemini({ model: alvo.modelo, search: false, maxOutputTokens: maxTokens, apiKey, ...(alvo.opcoes?.thinkingBudget != null ? { thinkingBudget: alvo.opcoes.thinkingBudget } : {}) });
  }
  return makeOpenAI({
    model: alvo.modelo, maxTokens, url: `${p.endereco}/chat/completions`, apiKey, provider: p.nome,
    ...(alvo.opcoes ? { extras: alvo.opcoes } : {}),
  });
}

// Simple fallback for auxiliary modules; the server passes its own (withFallback),
// which also handles billing when the primary fails mid-turn.
function juntarSimples(principal, reserva, tag) {
  let usePrincipal = true;
  return {
    name: `${principal.name}->fallback:${reserva.name}`,
    async complete(args) {
      if (usePrincipal) {
        try { return await principal.complete(args); }
        catch (e) {
          throwIfAttemptControl(e);
          usePrincipal = false;
          console.error(`[${tag}] ${principal.name} failed, falling back to ${reserva.name}: ${e?.message ?? e}`);
        }
      }
      return reserva.complete(args);
    },
  };
}

// Provider ready for the function, or null when the file doesn't exist (the usual routing).
export function modeloPara(funcao, { maxTokens = 8192, juntar = juntarSimples } = {}) {
  const e = escolhaDe(funcao);
  if (!e) return null;
  const principal = construirModelo(e.principal, { maxTokens });
  return e.reserva ? juntar(principal, construirModelo(e.reserva, { maxTokens }), `modelos:${funcao}`) : principal;
}

// Rows of the "function → model" table from boot and from `npm run modelos`.
export function descreverModelos({ cfg = carregarModelos(), env = process.env } = {}) {
  if (!cfg) return null;
  const rotulo = (a) => {
    if (!a) return '-';
    const p = cfg.provedores[a.provedor];
    return `${a.provedor}/${a.modelo}${p.chave && !env[p.chave] ? ` (SEM CHAVE: ${p.chave} vazia no .env)` : ''}`;
  };
  return Object.keys(FUNCOES).map((funcao) => {
    const e = escolhaDe(funcao, cfg);
    return { funcao, principal: rotulo(e?.principal), reserva: rotulo(e?.reserva), herdada: e && e.de !== funcao ? e.de : null };
  });
}

export function tabelaModelos(opts) {
  const linhas = descreverModelos(opts);
  if (!linhas) return null;
  const w = Math.max(...linhas.map((l) => l.funcao.length));
  return linhas.map((l) => `  ${l.funcao.padEnd(w)}  ${l.principal}${l.reserva !== '-' ? `  | reserva: ${l.reserva}` : ''}${l.herdada ? `  (herdada de ${l.herdada})` : ''}`).join('\n');
}
