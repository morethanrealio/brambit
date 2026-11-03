import {makeCompativel} from './compatible.mjs';
// ── Real adapter: Moonshot (Kimi API, OpenAI-compatible Chat Completions) ──
// Preset of the compatible engine (compatible.mjs). The key comes from
// process.env.MOONSHOT_API_KEY (NEVER hardcoded in the repo).
//
// K3 series (kimi-k3, kimi-k3.1-pro, kimi-k3.1-pro-highspeed), per the
// platform's parameter reference:
//   - always reasons; depth goes in the top-level `reasoning_effort`
//     ('low' | 'high' | 'max', model default 'max'). Changing it mid-session
//     loses the prefix cache, so it is fixed per provider instance;
//   - temperature, top_p, n and penalties are FIXED: sending any other value is an
//     error, so they are never sent;
//   - in the tool loop the assistant message must go back with its
//     `reasoning_content` (devolverRaciocinio). Without it the API still answers,
//     but the model reasons again from scratch at every step;
//   - max_tokens covers reasoning + text, so it stays generous. Reasoning can't be
//     turned off: the empty-answer retry runs at 'low'.

const BASE = () => process.env.MOONSHOT_URL || 'https://api.moonshot.ai/v1/chat/completions';

export function moonshotEnabled() {
  return !!process.env.MOONSHOT_API_KEY;
}

export function makeMoonshot({
  model = 'kimi-k3.1-pro',
  maxTokens = 16384,
  reasoningEffort = 'high',
} = {}) {
  return makeCompativel({
    provedor: 'moonshot', model, url: BASE(), chave: process.env.MOONSHOT_API_KEY,
    campos: () => ({ max_tokens: maxTokens, reasoning_effort: reasoningEffort }),
    camposDiretos: () => ({ max_tokens: maxTokens, reasoning_effort: 'low' }),
    // Time to the first token on a long context also counts as inactivity.
    stream: { inatividadeMs: 60_000 },
    devolverRaciocinio: true, retryVazio: 'completo',
  });
}
