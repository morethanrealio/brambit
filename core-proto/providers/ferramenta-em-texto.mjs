// ── Tool call written as TEXT ──
// Open models sometimes write the call in the content instead of filling the
// structured tool_calls field. This is a MODEL thing (GLM, DeepSeek), not a provider
// thing: the same model does the same at any endpoint. That's why the readers live here,
// outside any adapter, and the compatible engine (compativel.mjs) uses them according to
// each provider's configuration.

// Parses the GLM TEXT tool-call format:
//   <tool_call>nome_da_funcao
//   <arg_key>chave</arg_key><arg_value>valor</arg_value>
//   ...
//   </tool_call>
// Robust to multiple blocks, multiline values (code) and missing closing tag
// (truncation). Value becomes JSON when it looks like number/bool/object; otherwise string.
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
    // The OPENING <arg_key> sometimes disappears from GLM's output (seen on 2026-07-15:
    // "...<arg_value>x</arg_value>chave</arg_key><arg_value>y..."), so it is
    // optional; the key is the text without '<' up to </arg_key>.
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

// ── DeepSeek dialect (DSML) ──
// Since 2026-08-29 the primary is DeepSeek V4 Pro, served by the SAME adapter that
// was born for GLM. When the Together parser fails, it doesn't emit <tool_call>
// (GLM's format): it emits its NATIVE format, with the fullwidth vertical bar
// U+FF5C:
//   <｜DSML｜tool_calls>
//   <｜DSML｜invoke name="sandbox_shell">
//   <｜DSML｜parameter name="command" string="true">valor</｜DSML｜parameter>
//   </｜DSML｜invoke>
//   </｜DSML｜tool_calls>
// Together can also serialize the same dialect with a space after the
// marker (`<｜DSML｜ invoke ...>` / `</｜DSML｜ invoke>`). The space is just a
// wire-format variation: it must not turn the tool-call into final text.
// Since nothing here recognized this, the residue slipped past the guard and leaked
// RAW to the user, with the tool never running (8 messages, 2 people,
// 2026-09-01: three cases, the last one in an enviar_mensagem).
const DSML = '｜'; // ｜ (fullwidth vertical line), the DeepSeek separator
const DSML_TAG = `<${DSML}DSML${DSML}`;
export function parseDsmlToolCalls(content) {
  const s = String(content ?? '');
  if (!s.includes(DSML_TAG)) return [];
  const D = DSML;
  const calls = [];
  // Robust to truncated block (missing the closing tag) for the same reason as GLM.
  // `\\s*` after the marker accepts both the official compact format and
  // the spaced variant observed live, without accepting tags that don't contain the
  // full DSML marker in fullwidth. Name and args still go through the
  // normal ToolRegistry validation before any execution.
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
      // Same criterion as GLM: only converts when the value IS JSON, otherwise raw
      // string (DeepSeek's `string="true"` is a hint, not a guarantee).
      if (/^(\{[\s\S]*\}|\[[\s\S]*\]|-?\d+(\.\d+)?|true|false|null)$/.test(t)) {
        try { val = JSON.parse(t); } catch { val = v; }
      }
      if (k) args[k] = val;
    }
    calls.push({ id: `dsml_${idx++}`, name, args });
  }
  return calls;
}
// Text left over for the user: whatever came BEFORE the first DSML marker.
export function stripDsml(content) {
  const s = String(content ?? '');
  const i = s.indexOf(DSML_TAG);
  return i < 0 ? s : s.slice(0, i).trim();
}
export const hasDsmlResidue = (s) => String(s ?? '').includes(DSML_TAG);
