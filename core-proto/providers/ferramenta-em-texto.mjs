// ── Chamada de ferramenta escrita como TEXTO ──
// Modelos abertos às vezes escrevem a chamada no content em vez de preencher o
// campo tool_calls estruturado. Isso é do MODELO (GLM, DeepSeek), não do provedor:
// o mesmo modelo faz igual em qualquer endereço. Por isso os leitores ficam aqui,
// fora de qualquer adaptador, e o motor compatível (compativel.mjs) usa conforme
// a configuração de cada provedor.

// Parseia o formato de tool-call em TEXTO do GLM:
//   <tool_call>nome_da_funcao
//   <arg_key>chave</arg_key><arg_value>valor</arg_value>
//   ...
//   </tool_call>
// Robusto a múltiplos blocos, valores multilinha (código) e tag final ausente
// (truncamento). Valor vira JSON quando parece número/bool/objeto; senão string.
export function parseGlmToolCalls(content) {
  if (!content || !content.includes('<tool_call>')) return [];
  const calls = [];
  const blockRe = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g;
  let bm, idx = 0;
  while ((bm = blockRe.exec(content)) !== null) {
    const block = bm[1];
    const nameMatch = block.match(/^([\s\S]*?)(?:<arg_key>|$)/);
    const name = (nameMatch ? nameMatch[1] : '').replace(/[\r\n]+/g, ' ').trim();
    if (!name) continue;
    const args = {};
    // O <arg_key> de ABERTURA às vezes some na saída do GLM (visto 15/07:
    // "...<arg_value>x</arg_value>chave</arg_key><arg_value>y..."), então ele é
    // opcional; a chave é o texto sem '<' até </arg_key>.
    const argRe = /(?:<arg_key>)?([^<]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)(?:<\/arg_value>|$)/g;
    let am;
    while ((am = argRe.exec(block)) !== null) {
      const k = am[1].trim();
      let v = am[2].replace(/^\r?\n/, '').replace(/\r?\n$/, '');
      const t = v.trim();
      let val = v;
      if (/^(\{[\s\S]*\}|\[[\s\S]*\]|-?\d+(\.\d+)?|true|false|null)$/.test(t)) {
        try { val = JSON.parse(t); } catch { val = v; }
      }
      if (k) args[k] = val;
    }
    calls.push({ id: `glm_${idx++}`, name, args });
  }
  return calls;
}

// ── Dialeto do DeepSeek (DSML) ──
// Desde 29/08 o primário é o DeepSeek V4 Pro, servido pelo MESMO adaptador que
// nasceu pro GLM. Quando o parser da Together falha, ele não emite <tool_call>
// (formato do GLM): emite o formato NATIVO dele, com a barra vertical fullwidth
// U+FF5C:
//   <｜DSML｜tool_calls>
//   <｜DSML｜invoke name="sandbox_shell">
//   <｜DSML｜parameter name="command" string="true">valor</｜DSML｜parameter>
//   </｜DSML｜invoke>
//   </｜DSML｜tool_calls>
// A Together também pode serializar o mesmo dialeto com espaço depois do
// marcador (`<｜DSML｜ invoke ...>` / `</｜DSML｜ invoke>`). O espaço é só uma
// variação de wire-format: não pode transformar a tool-call em texto final.
// Como nada aqui reconhecia isso, o resíduo passava batido pelo guard e vazava
// CRU pro usuário, com a ferramenta nunca rodando (8 mensagens, 2 pessoas,
// 01/09: três casos, o último num enviar_mensagem).
const DSML = '｜'; // ｜ (fullwidth vertical line), o separador do DeepSeek
const DSML_TAG = `<${DSML}DSML${DSML}`;
export function parseDsmlToolCalls(content) {
  const s = String(content ?? '');
  if (!s.includes(DSML_TAG)) return [];
  const D = DSML;
  const calls = [];
  // Robusto a bloco truncado (sem a tag de fechamento) pelo mesmo motivo do GLM.
  // `\\s*` depois do marcador aceita tanto o formato compacto oficial quanto
  // a variante espaçada observada ao vivo, sem aceitar tags que não contenham o
  // marcador DSML completo em fullwidth. Nome e args continuam passando pela
  // validação normal do ToolRegistry antes de qualquer execução.
  const open = `<${D}DSML${D}\\s*`;
  const close = `</${D}DSML${D}\\s*`;
  const invokeRe = new RegExp(`${open}invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)(?:${close}invoke\\s*>|$)`, 'g');
  const paramRe = new RegExp(`${open}parameter\\s+name="([^"]+)"[^>]*>([\\s\\S]*?)(?:${close}parameter\\s*>|$)`, 'g');
  let im, idx = 0;
  while ((im = invokeRe.exec(s)) !== null) {
    const name = im[1].trim();
    if (!name) continue;
    const args = {};
    paramRe.lastIndex = 0;
    let pm;
    while ((pm = paramRe.exec(im[2])) !== null) {
      const k = pm[1].trim();
      const v = pm[2].replace(/^\r?\n/, '').replace(/\r?\n$/, '');
      const t = v.trim();
      let val = v;
      // Mesmo critério do GLM: só converte quando o valor É JSON, senão string
      // crua (o `string="true"` do DeepSeek é dica, não garantia).
      if (/^(\{[\s\S]*\}|\[[\s\S]*\]|-?\d+(\.\d+)?|true|false|null)$/.test(t)) {
        try { val = JSON.parse(t); } catch { val = v; }
      }
      if (k) args[k] = val;
    }
    calls.push({ id: `dsml_${idx++}`, name, args });
  }
  return calls;
}
// Texto que sobra pro usuário: o que veio ANTES da primeira marcação DSML.
export function stripDsml(content) {
  const s = String(content ?? '');
  const i = s.indexOf(DSML_TAG);
  return i < 0 ? s : s.slice(0, i).trim();
}
export const hasDsmlResidue = (s) => String(s ?? '').includes(DSML_TAG);
