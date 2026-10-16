import { AsyncLocalStorage } from 'node:async_hooks';
const scope = new AsyncLocalStorage();
export function withDeepSeek(factory, run) { return scope.run(factory, run); }
export function selectedDeepSeek(maxTokens) { return scope.getStore()?.(maxTokens) || null; }
export function isDeepSeekTurn() { return !!scope.getStore(); }
// Defense in depth: direct Gemini media/classifier calls must not escape the selection.
export function assertDeepSeekEgress(host) {
    if (isDeepSeekTurn() && (host === 'generativelanguage.googleapis.com' || host.endsWith('.generativelanguage.googleapis.com')))
        throw new Error('Gemini está desabilitado neste turno: o assistente foi configurado com DeepSeek V4.1 Flash.');
}
