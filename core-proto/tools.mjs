// ── Example tools (use case: personal shopper) ──
// Shape of the defs = JSON Schema, same as what MCP expects. Swapping in tools from
// a real MCP server later is just a matter of mapping.

import { ToolRegistry } from './core.mjs';

// Fake catalog just for the demo (in the product it would be a real search on the web / partners).
const CATALOGO = [
  { nome: 'Tênis de corrida AeroRun', categoria: 'corrida', preco: 459, nota: 4.6 },
  { nome: 'Tênis de corrida SpeedX Pro', categoria: 'corrida', preco: 899, nota: 4.8 },
  { nome: 'Tênis casual UrbanStep', categoria: 'casual', preco: 320, nota: 4.3 },
  { nome: 'Tênis de corrida CloudLite', categoria: 'corrida', preco: 380, nota: 4.4 },
];

export function buildTools() {
  return new ToolRegistry()
    .add({
      name: 'search_products',
      description: 'Searches products by category and maximum price.',
      parameters: {
        type: 'object',
        properties: {
          categoria: { type: 'string', description: 'e.g.: corrida, casual' },
          preco_max: { type: 'number', description: 'maximum price in R$' },
        },
        required: ['categoria'],
      },
      run: async ({ categoria, preco_max }) => {
        const r = CATALOGO.filter(
          (p) => p.categoria === categoria && (preco_max == null || p.preco <= preco_max),
        ).sort((a, b) => b.nota - a.nota);
        return JSON.stringify(r);
      },
    });
}
