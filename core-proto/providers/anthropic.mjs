// ── Adapter real: Anthropic Messages API ──
// Pronto pra uso assim que houver credencial pra api.anthropic.com no gateway.
// Repare: implementa o MESMO contrato (~40 linhas). Trocar de modelo = isto.

import { STOP } from '../provider.mjs';

let counter = 0;
const nextId = () => `call_${++counter}`;

export function makeAnthropic({ model = 'claude-haiku-4-5-20251001', maxTokens = 1024 } = {}) {
  return {
    name: `anthropic:${model}`,
    async complete({ system, messages, tools }) {
      // Traduz Msg[] -> formato Anthropic (tool_use / tool_result).
      const amsgs = messages.map((m) => {
        if (m.role === 'tool') {
          return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }] };
        }
        if (m.role === 'assistant' && m.toolCalls?.length) {
          return { role: 'assistant', content: m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args })) };
        }
        return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content };
      });

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'onecli-managed', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: maxTokens, system, messages: amsgs,
          tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        }),
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
      const data = await res.json();

      const toolCalls = (data.content ?? []).filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id || nextId(), name: b.name, args: b.input ?? {} }));
      const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      return toolCalls.length
        ? { stop: STOP.TOOL, toolCalls, text: text || undefined }
        : { stop: STOP.END, text };
    },
  };
}
