// Official DeepSeek adapter. One completion, no provider fallback, no credential logs.
// Tool-call validation and transient retry are the COMMON rules (regras.mjs),
// identical for every provider.
import {validarChamadas,mensagemProtocolo,comRetentativa} from '#regras-provedor';
export const DEEPSEEK_AGENT_MODEL = 'deepseek41flash';
export const DEEPSEEK_API_MODEL = 'deepseek-flash';
export interface Msg { role: string; content?: string; toolCallId?: string; toolCalls?: {id: string; name: string; args: unknown}[]; images?: {data: string; mimeType?: string}[] }
export interface Input { maxTokens?: number; system?: string; messages: Msg[]; tools?: {name: string; description?: string; parameters: unknown}[] }
export interface Provider { name: string; complete(input: Input): Promise<Step> }
export type ProtocolCode = 'missing_call_id'|'invalid_tool_name'|'duplicate_call_id'|'invalid_calls_shape'|'invalid_json_args'|'invalid_args_shape'|'unstructured_tool_call'|'output_truncated';
export interface Step { stop: 'end'|'tool'; text?: string; toolCalls?: {id: string; name: string; args: Record<string,unknown>}[]; usage: Record<string,unknown>; protocolError?: {code: ProtocolCode; retryable: true} }
const obj = (v: unknown): Record<string,unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : {};
export function peakAt(date: Date): boolean {
  const day=date.getUTCDay(), h=date.getUTCHours();
  return day>=1 && day<=5 && ((h>=1 && h<4) || (h>=6 && h<10));
}
export interface PreparedDeepSeek { body: Record<string,unknown>; peak: boolean }
export type DeepSeekAttempt = (spec: Record<string,unknown>, dispatch: (body: Record<string,unknown>) => Promise<unknown>) => Promise<unknown>;
export function prepareDeepSeekRequest({system,messages,tools=[],maxTokens:requestedMaxTokens}: Input, maxTokens=32768, date=new Date()): PreparedDeepSeek {
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('Limite de saída DeepSeek inválido.');
    if (requestedMaxTokens !== undefined && (!Number.isSafeInteger(requestedMaxTokens) || requestedMaxTokens < 1 || requestedMaxTokens > maxTokens))
      throw new Error('Limite de saída da chamada DeepSeek inválido.');
    const outputTokens = requestedMaxTokens ?? maxTokens;
    const input: Record<string,unknown>[]=[];
    if(system) input.push({role:'system',content:system});
    for(const m of messages) {
      if(m.role==='tool') input.push({role:'tool',tool_call_id:m.toolCallId,content:m.content||''});
      else if(m.role==='assistant' && m.toolCalls?.length) input.push({role:'assistant',content:m.content||null,
        tool_calls:m.toolCalls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))});
      else if(m.images?.length) input.push({role:m.role,content:[{type:'text',text:m.content||'Analise a imagem.'},...m.images.map(im=>{
        if(!/^image\/(png|jpeg|webp|gif)$/.test(im.mimeType||'image/jpeg')) throw new Error('Formato de imagem não suportado pelo DeepSeek.');
        return {type:'image_url',image_url:{url:`data:${im.mimeType||'image/jpeg'};base64,${im.data}`}};})]});
      else input.push({role:m.role,content:m.content||''});
    }
    // Explicit non-thinking mode supports tools without retaining private reasoning
    // across restarts/model switches; optimized for this economical Flash option.
    const body: Record<string,unknown>={model:DEEPSEEK_API_MODEL,messages:input,max_tokens:outputTokens,thinking:{type:'disabled'}};
    if(tools.length) { body.tools=tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}}));body.tool_choice='auto'; }
    return {body,peak:peakAt(date)};
}
function readDeepSeekUsage(data:unknown,peak:boolean) {
    const raw=obj(obj(data).usage);
    if(!Number.isSafeInteger(raw.prompt_tokens)||Number(raw.prompt_tokens)<0||!Number.isSafeInteger(raw.completion_tokens)||Number(raw.completion_tokens)<0) {
      const error=Object.assign(new Error('DeepSeek retornou uso ausente ou inválido; consumo precisa de reconciliação.'),{code:'PROVIDER_USAGE_MISSING'});
      throw error;
    }
    const number=(v:unknown):number=>typeof v==='number' && Number.isFinite(v) && v>=0 ? v : 0;
    const nIn=number(raw.prompt_tokens),out=number(raw.completion_tokens),cached=Math.min(nIn,number(raw.prompt_cache_hit_tokens ?? obj(raw.prompt_tokens_details).cached_tokens));
    return {model:DEEPSEEK_API_MODEL,in:nIn,cached,out,think:0,total:number(raw.total_tokens)||nIn+out,deepseekPeak:peak};
}
export async function dispatchDeepSeekRequest({body,peak}: PreparedDeepSeek, {secret,request=globalThis.fetch,timeoutMs=120000,attempt}: {
  secret:()=>Promise<string>; request?:typeof fetch; timeoutMs?:number; attempt?:DeepSeekAttempt;
}): Promise<Step> {
    if(body.model!==DEEPSEEK_API_MODEL||!Number.isSafeInteger(body.max_tokens)||Number(body.max_tokens)<1)throw new Error('Preparação DeepSeek inválida.');
    let key: string; try { key=await secret(); } catch { throw new Error('Credencial DeepSeek indisponível. Nenhum outro modelo foi usado.'); }
    if (!key || /[\r\n]/.test(key)) throw new Error('DeepSeek indisponível: confira a credencial do serviço no cofre. Nenhum outro modelo foi usado.');
    const dispatch=async(wire:Record<string,unknown>):Promise<unknown>=>{
      let response:Response;
      try { response=await request('https://api.deepseek.com/chat/completions',{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify(wire)}); }
      catch { throw new Error('DeepSeek indisponível ou demorou demais. Nenhum outro modelo foi usado.'); }
      if(!response.ok) { await response.body?.cancel();throw Object.assign(new Error(`DeepSeek HTTP ${response.status}. Nenhum outro modelo foi usado.`),{httpStatus:response.status,providerRejected:true}); }
      try { return await response.json(); } catch { throw new Error('Resposta inválida da API DeepSeek. Nenhum outro modelo foi usado.'); }
    };
    const spec={provider:'deepseek',model:DEEPSEEK_API_MODEL,body,ready:()=>!!key,readUsage:(data:unknown)=>readDeepSeekUsage(data,peak)};
    const parsed:unknown=await comRetentativa(()=>attempt?attempt(spec,dispatch):dispatch(body));
    const data=obj(parsed),usage=readDeepSeekUsage(data,peak);
    const choice=obj(Array.isArray(data.choices)?data.choices[0]:null), msg=obj(choice.message);
    const fail=(message:string,code?:ProtocolCode):never=>{const e=new Error(message) as Error & {usage:typeof usage; protocolCode?:ProtocolCode};e.usage=usage;e.protocolCode=code;throw e;};
    if(choice.finish_reason==='length') return {stop:'end',usage,text:'A saída desta chamada foi cortada; nenhuma ação do lote incompleto foi executada.',protocolError:{code:'output_truncated',retryable:true}};
    if(choice.finish_reason==='content_filter') return {stop:'end',usage,text:'O DeepSeek não pôde atender a este pedido. Nenhum outro modelo foi usado.'};
    try {
    const checked=validarChamadas(msg.tool_calls) as {code?:ProtocolCode; calls?:{id:string;name:string;args:Record<string,unknown>}[]};
    if(checked.code) return fail(mensagemProtocolo(checked.code,'DeepSeek'),checked.code);
    const calls=checked.calls!;
    const text=typeof msg.content==='string'?msg.content:'';
    if(!calls.length && (text.includes('<｜DSML｜') || text.includes('<tool_call>'))) return fail('DeepSeek não retornou uma resposta válida. Nenhum outro modelo foi usado.','unstructured_tool_call');
    if(!calls.length && !text.trim()) return fail('DeepSeek não retornou uma resposta válida. Nenhum outro modelo foi usado.');
    return {stop:calls.length?'tool':'end',text,toolCalls:calls.length?calls:undefined,usage};
    } catch(error) {
      // Preserve metered usage even when output is malformed; never execute partial actions.
      const code=(error as {protocolCode?:ProtocolCode})?.protocolCode;
      return {stop:'end',text:error instanceof Error ? error.message : 'Resposta DeepSeek inválida; nenhuma ação executada.',usage,...(code?{protocolError:{code,retryable:true as const}}:{})};
    }
}
export function makeDeepSeekFlash({ secret, maxTokens=32768, request=globalThis.fetch, now=()=>new Date(), timeoutMs=120000, attempt }: {
  secret: ()=>Promise<string>; maxTokens?: number; request?: typeof fetch; now?: ()=>Date; timeoutMs?: number; attempt?:DeepSeekAttempt;
}): Provider {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('Limite de saída DeepSeek inválido.');
  return {name:'deepseek:'+DEEPSEEK_API_MODEL, async complete(input) {
    return dispatchDeepSeekRequest(prepareDeepSeekRequest(input,maxTokens,now()),{secret,request,timeoutMs,attempt});
  }};
}
