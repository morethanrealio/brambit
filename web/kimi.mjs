import { makeDeepInfra, deepinfraEnabled } from '../core-proto/providers/deepinfra.mjs';
import { makeTogether, togetherEnabled } from '../core-proto/providers/together.mjs';
import { makeMoonshot, moonshotEnabled } from '../core-proto/providers/moonshot.mjs';
// ── Kimi (Moonshot): optional ADVANCED model, manually ASSIGNED to an agent
// (outside of routing). "Enabling" = KIMI_ENABLED=1 in the box's .env; without it,
// the option doesn't even show up in settings. Who serves it comes from
// KIMI_PROVIDER: 'moonshot' (the maker's own API, which carries kimi-k3.1-pro),
// 'together' (default, kept for installs that already run K3 there) or 'deepinfra'.
// KIMI_MODEL overrides the id; the default follows the provider.

const PROVIDERS = {
  moonshot: { enabled: moonshotEnabled, model: 'kimi-k3.1-pro' },
  together: { enabled: togetherEnabled, model: 'moonshotai/Kimi-K3' },
  deepinfra: { enabled: deepinfraEnabled, model: 'moonshotai/Kimi-K3' },
};
const EFFORTS = ['low', 'high', 'max'];

export function kimiProviderName() {
  const name = (process.env.KIMI_PROVIDER || 'together').toLowerCase();
  return PROVIDERS[name] ? name : 'together';
}
export const kimiModel = () => process.env.KIMI_MODEL || PROVIDERS[kimiProviderName()].model;
// Version shown in the model picker, read from the id being served.
export const kimiVersion = () => (/k3[.-]1/i.test(kimiModel()) ? '3.1' : '3');

export function kimiAvailable() {
  if (!/^(1|true|on|sim)$/i.test(String(process.env.KIMI_ENABLED || ''))) return false;
  return PROVIDERS[kimiProviderName()].enabled();
}

// Without the fallback: whoever offers the model in the product wraps it.
export function makeKimi() {
  const model = kimiModel();
  if (kimiProviderName() === 'moonshot') {
    const effort = String(process.env.KIMI_REASONING_EFFORT || 'high').toLowerCase();
    return makeMoonshot({ model, reasoningEffort: EFFORTS.includes(effort) ? effort : 'high' });
  }
  const opts = { model, maxTokens: 8192, temperature: 0.6 };
  return kimiProviderName() === 'together' ? makeTogether(opts) : makeDeepInfra(opts);
}
