// The AI providers the setup page offers, how to test a key before saving it,
// and the modelos.yaml written from the choice. Model ids are the ones the
// core already prices (web/pricing.mjs); "outro" is any service speaking the
// OpenAI protocol (OpenRouter, Ollama, vLLM...), with the model typed by hand.
import { stringify } from 'yaml';

export const PROVEDORES = {
  together: { endereco: 'https://api.together.xyz/v1', modelo: 'deepseek-ai/DeepSeek-V4.1-Flash', chave: 'TOGETHER_API_KEY' },
  openai: { endereco: 'https://api.openai.com/v1', modelo: 'gpt-5.4-mini', chave: 'OPENAI_API_KEY' },
  gemini: { tipo: 'gemini', endereco: 'https://generativelanguage.googleapis.com/v1beta', modelo: 'gemini-3.7-flash', chave: 'GEMINI_API_KEY' },
  outro: { endereco: null, modelo: null, chave: 'OUTRO_API_KEY' },
};

// What the person chose → {provedor, endereco, modelo, chave} or {erro}.
export function escolha({ provedor, endereco, modelo, chave }) {
  const p = PROVEDORES[provedor];
  if (!p) return { erro: 'provedor_invalido' };
  const k = String(chave || '').trim();
  if (provedor !== 'outro') return k ? { provedor, endereco: p.endereco, modelo: p.modelo, chave: k } : { erro: 'falta_chave' };
  let url;
  try { url = new URL(String(endereco || '').trim()); } catch { return { erro: 'endereco_invalido' }; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return { erro: 'endereco_invalido' };
  const m = String(modelo || '').trim();
  if (!m) return { erro: 'falta_modelo' };
  return { provedor, endereco: url.href.replace(/\/+$/, ''), modelo: m, chave: k };
}

// Lists the provider's models with the key: proves the key works and that the
// model exists, without spending anything. → {ok:true} or {ok:false, erro}.
export async function testarChave({ provedor, endereco, modelo, chave }, fetchImpl = fetch) {
  const gemini = PROVEDORES[provedor]?.tipo === 'gemini';
  const headers = gemini ? { 'x-goog-api-key': chave } : (chave ? { authorization: `Bearer ${chave}` } : {});
  let res;
  try { res = await fetchImpl(`${endereco}/models${gemini ? '?pageSize=1000' : ''}`, { headers, signal: AbortSignal.timeout(15000) }); }
  catch { return { ok: false, erro: 'sem_conexao' }; }
  if (res.status === 401 || res.status === 403) return { ok: false, erro: 'chave_recusada' };
  if (!res.ok) return { ok: false, erro: 'provedor_erro', status: res.status };
  const corpo = await res.json().catch(() => null);
  const lista = gemini ? corpo?.models : (Array.isArray(corpo) ? corpo : corpo?.data);
  if (!Array.isArray(lista)) return { ok: false, erro: 'provedor_erro', status: res.status };
  const ids = new Set(lista.map((m) => String(gemini ? m?.name : m?.id).replace(/^models\//, '')));
  return ids.has(modelo) ? { ok: true } : { ok: false, erro: 'modelo_ausente' };
}

// modelos.yaml with a single provider doing every function. The key is NOT in
// it: only the name of the environment variable the launcher fills in.
export function modelosYaml({ provedor, endereco, modelo, chave }) {
  const p = PROVEDORES[provedor];
  const prov = p.tipo === 'gemini' ? { tipo: 'gemini', chave: p.chave } : { endereco, ...(chave ? { chave: p.chave } : {}) };
  return `# Gerado pelo instalador do Brambit. Pra trocar, rode a configuração de novo.\n${stringify({ provedores: { [provedor]: prov }, funcoes: { padrao: { modelo: `${provedor}/${modelo}` } } })}`;
}
