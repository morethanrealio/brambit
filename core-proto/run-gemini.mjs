// ── Live demo with real Gemini ──
// Requires: export GEMINI_API_KEY=...   Run: node run-gemini.mjs
// Shows the SAME loop + the SAME tools running on real Gemini, with
// 3.5 Flash as orchestrator and 3.1 Pro as heavy-reasoning fallback.

import { runAgent } from './core.mjs';
import { buildTools } from './tools.mjs';
import { makeGemini } from './providers/gemini.mjs';

if (!process.env.GEMINI_API_KEY) {
  console.error('Defina GEMINI_API_KEY no ambiente.');
  process.exit(1);
}

const SYSTEM = 'Você é um personal shopper brasileiro. Use as tools pra achar o produto certo e recomende com preço e nota. Seja direto.';

const casos = [
  { provider: makeGemini({ model: 'gemini-3.5-flash' }), pedido: 'Quero um tênis de corrida até 500 reais.' },
  { provider: makeGemini({ model: 'gemini-3.1-pro-preview' }), pedido: 'Entre os tênis de corrida até 500, qual a melhor opção e por quê? Compare preço e nota.' },
];

const trace = (e) => {
  if (e.type === 'start') console.log(`\n=== ${e.provider} ===\nusuário: ${e.userInput}`);
  else if (e.type === 'tool_call') console.log(`  → tool ${e.name}(${JSON.stringify(e.args)})`);
  else if (e.type === 'tool_result') console.log(`  ← ${e.out}`);
  else if (e.type === 'end') console.log(`agente: ${e.text}`);
};

for (const c of casos) {
  await runAgent({ provider: c.provider, tools: buildTools(), system: SYSTEM, userInput: c.pedido, onEvent: trace });
}
