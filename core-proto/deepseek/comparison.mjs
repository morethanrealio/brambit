import { AsyncLocalStorage } from 'node:async_hooks';
export const GEMINI_COMPARISON_ID = 'gemini37flash';
export const GEMINI_COMPARISON_MODEL = 'gemini-3.7-flash';
// Per-turn context, never global mutable state: concurrent auto/DeepSeek turns
// must not inherit the comparison choice. Only chat and image reading opt in.
const scope = new AsyncLocalStorage();
export function withGeminiComparison(run) { return scope.run(true, run); }
export function isGeminiComparison() { return scope.getStore() === true; }
