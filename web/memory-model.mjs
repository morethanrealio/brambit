// Model for memory maintenance tasks: per-turn fact extraction, profile
// patch/rewrite, reconciling conflicting facts and the rolling conversation
// summary. Switched from gemini-3.5-flash (1.50 in / 9.00 out) to DeepSeek
// V4.1 Flash on Together (0.30 in / 1.20 out) on 27/09/2026. Minimum
// reasoning ('low'), equivalent to the thinkingBudget 0 Gemini used here.
// Without a Together key, falls back to Gemini.
import { makeTogether, togetherEnabled, togetherFlashModel } from '../core-proto/providers/together.mjs';
import { makeGemini } from '../core-proto/providers/gemini.mjs';
import { modelFor } from '../core-proto/models.mjs';

export function makeMemoriaModel({ maxTokens = 8192 } = {}) {
  const cfg = modelFor('memory', { maxTokens }); if (cfg) return cfg; // models.yaml
  if (togetherEnabled()) return makeTogether({ model: togetherFlashModel(), maxTokens, reasoningEffort: 'low' });
  return makeGemini({ model: 'gemini-3.5-flash', thinkingBudget: 0, maxOutputTokens: maxTokens });
}
