// ── Live demo with real Gemini ──
// Requires: export GEMINI_API_KEY=...   Run: node run-gemini.mjs
// Shows the SAME loop + the SAME tools running on real Gemini, with
// 3.5 Flash as orchestrator and 3.1 Pro as heavy-reasoning fallback.

import { runAgent } from './core.mjs';
import { buildTools } from './tools.mjs';
import { makeGemini } from './providers/gemini.mjs';

if (!process.env.GEMINI_API_KEY) {
  console.error('Set GEMINI_API_KEY in the environment.');
  process.exit(1);
}

const SYSTEM = 'You are a Brazilian personal shopper. Use the tools to find the right product and recommend it with price and rating. Be direct.';

const casos = [
  { provider: makeGemini({ model: 'gemini-3.5-flash' }), pedido: 'I want running shoes for up to 500 reais.' },
  { provider: makeGemini({ model: 'gemini-3.1-pro-preview' }), pedido: 'Among running shoes up to 500, which is the best option and why? Compare price and rating.' },
];

const trace = (e) => {
  if (e.type === 'start') console.log(`\n=== ${e.provider} ===\nuser: ${e.userInput}`);
  else if (e.type === 'tool_call') console.log(`  → tool ${e.name}(${JSON.stringify(e.args)})`);
  else if (e.type === 'tool_result') console.log(`  ← ${e.out}`);
  else if (e.type === 'end') console.log(`agent: ${e.text}`);
};

for (const c of casos) {
  await runAgent({ provider: c.provider, tools: buildTools(), system: SYSTEM, userInput: c.pedido, onEvent: trace });
}
