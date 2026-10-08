// ── Demo: the SAME loop + the SAME tools, swapping only the provider ──
// Proves the model-agnostic thesis. Run: node run.mjs

import { runAgent } from './core.mjs';
import { buildTools } from './tools.mjs';
import { makeScripted } from './providers/scripted.mjs';
// Adapters reais (entram quando houver credencial no gateway):
// import { makeAnthropic } from './providers/anthropic.mjs';
// import { makeOpenAI } from './providers/openai.mjs';

const SYSTEM = 'You are a personal shopper. Help find the right product using the tools.';
const PEDIDO = 'I want running shoes for up to 500 reais.';

// Two pluggable "models". In the future: makeAnthropic(), makeOpenAI(), proprietary model.
const providers = [
  makeScripted({ name: 'model-A (rating-focused)', strategy: 'melhor_nota' }),
  makeScripted({ name: 'model-B (price-focused)', strategy: 'mais_barato' }),
];

const trace = (e) => {
  if (e.type === 'start') console.log(`\n=== provider: ${e.provider} ===\nuser: ${e.userInput}`);
  else if (e.type === 'tool_call') console.log(`  → tool ${e.name}(${JSON.stringify(e.args)})`);
  else if (e.type === 'tool_result') console.log(`  ← ${e.out}`);
  else if (e.type === 'end') console.log(`agent: ${e.text}`);
};

for (const provider of providers) {
  const tools = buildTools(); // same tools for everyone
  await runAgent({ provider, tools, system: SYSTEM, userInput: PEDIDO, onEvent: trace });
}
console.log('\nSame loop, same tools, two models. Switching models = switching the provider.');
