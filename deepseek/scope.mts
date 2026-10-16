import {AsyncLocalStorage} from 'node:async_hooks';
import type {Provider} from './provider.mjs';
type Factory=(maxTokens?:number)=>Provider;
const scope=new AsyncLocalStorage<Factory>();
export function withDeepSeek<T>(factory:Factory, run:()=>T): T {return scope.run(factory,run);}
export function selectedDeepSeek(maxTokens?:number): Provider|null {return scope.getStore()?.(maxTokens)||null;}
export function isDeepSeekTurn(): boolean {return !!scope.getStore();}
// Defense in depth: direct Gemini media/classifier calls must not escape the selection.
export function assertDeepSeekEgress(host:string): void {
  if(isDeepSeekTurn() && (host==='generativelanguage.googleapis.com' || host.endsWith('.generativelanguage.googleapis.com')))
    throw new Error('Gemini está desabilitado neste turno: o assistente foi configurado com DeepSeek V4.1 Flash.');
}
