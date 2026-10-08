// ── Demo: the SAME loop + the SAME tools, swapping only the provider ──
// Proves the model-agnostic thesis. Run: node run.mjs

import { runAgent } from './core.mjs';
import { buildTools } from './tools.mjs';
import { makeScripted } from './providers/scripted.mjs';
// Adapters reais (entram quando houver credencial no gateway):
// import { makeAnthropic } from './providers/anthropic.mjs';
// import { makeOpenAI } from './providers/openai.mjs';

const SYSTEM = 'Você é um personal shopper. Ajude a achar o produto certo usando as tools.';
const PEDIDO = 'Quero um tênis de corrida até 500 reais.';

// Two pluggable "models". In the future: makeAnthropic(), makeOpenAI(), proprietary model.
const providers = [
  makeScripted({ name: 'modelo-A (foca nota)', strategy: 'melhor_nota' }),
  makeScripted({ name: 'modelo-B (foca preço)', strategy: 'mais_barato' }),
];

const trace = (e) => {
  if (e.type === 'start') console.log(`\n=== provider: ${e.provider} ===\nusuário: ${e.userInput}`);
  else if (e.type === 'tool_call') console.log(`  → tool ${e.name}(${JSON.stringify(e.args)})`);
  else if (e.type === 'tool_result') console.log(`  ← ${e.out}`);
  else if (e.type === 'end') console.log(`agente: ${e.text}`);
};

for (const provider of providers) {
  const tools = buildTools(); // same tools for everyone
  await runAgent({ provider, tools, system: SYSTEM, userInput: PEDIDO, onEvent: trace });
}
console.log('\nMesmo loop, mesmas tools, dois modelos. Trocar de modelo = trocar o provider.');
