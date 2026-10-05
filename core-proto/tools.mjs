// ── Tools de exemplo (use case: personal shopper) ──
// Shape das defs = JSON Schema, igual ao que MCP espera. Trocar por tools de
// um MCP server real depois é só mapear.

import { ToolRegistry } from './core.mjs';

// Catálogo fake só pra demo (no produto seria busca real na web / parceiros).
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
      description: 'Busca produtos por categoria e preço máximo.',
      parameters: {
        type: 'object',
        properties: {
          categoria: { type: 'string', description: 'ex: corrida, casual' },
          preco_max: { type: 'number', description: 'preço máximo em R$' },
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
