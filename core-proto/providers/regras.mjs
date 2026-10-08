import {throwIfAttemptControl} from '../provider-attempt.mjs';
// Rules that apply to EVERY text provider (compatible engine and official DeepSeek).
// Behavior differences between providers can only come from configuration or
// model quirks, never from an adapter's own rule.

const obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v:{};

// An invalid tool call rejects the WHOLE batch: nothing is executed and the core
// makes one repair attempt (turn-recovery). Missing or empty argument = {}.
// A name that isn't in the catalog is NOT a rejection: it goes through, and the core
// tells the model "unknown tool" without executing anything, so it can correct itself
// as many times as needed (in prod, 9 out of 2,226 requests; rejecting with 1 repair per
// request made 3 of them worse).
export function validarChamadas(lista){
  if(lista!==undefined&&lista!==null&&!Array.isArray(lista))return {code:'invalid_calls_shape'};
  const vistos=new Set(),calls=[];
  for(const bruta of lista??[]){
    const c=obj(bruta),f=obj(c.function);
    if(typeof c.id!=='string'||!c.id.trim())return {code:'missing_call_id'};
    if(typeof f.name!=='string'||!f.name.trim())return {code:'invalid_tool_name'};
    if(vistos.has(c.id))return {code:'duplicate_call_id'};
    vistos.add(c.id);
    let args=f.arguments;
    if(args===undefined||args===null||(typeof args==='string'&&!args.trim()))args={};
    else if(typeof args==='string'){try{args=JSON.parse(args);}catch{return {code:'invalid_json_args'};}}
    if(!args||typeof args!=='object'||Array.isArray(args))return {code:'invalid_args_shape'};
    calls.push({id:c.id,name:f.name,args});
  }
  return {calls};
}

export function mensagemProtocolo(code,quem='O modelo'){
  if(code==='invalid_calls_shape')return `${quem} retornou uma lista de ferramentas inválida; nenhuma ação foi executada.`;
  if(code==='invalid_json_args')return `${quem} retornou argumentos incompletos; nenhuma ação foi executada.`;
  if(code==='invalid_args_shape')return `${quem} retornou argumentos inválidos; nenhuma ação foi executada.`;
  return `${quem} retornou uma ferramenta inválida; nenhuma ação foi executada.`;
}

// Transient capacity refusal: tries again on the SAME model, with increasing
// wait. Each attempt is a new physical request (and counts against credit).
export const RETENTAR={status:[429,502,503,504],tentativas:4,esperaMs:800};
export async function comRetentativa(fazer){
  for(let tentativa=1;;tentativa++){
    try{return await fazer();}
    catch(e){
      throwIfAttemptControl(e);
      if(!RETENTAR.status.includes(e?.httpStatus)||tentativa>=RETENTAR.tentativas)throw e;
      await new Promise(r=>setTimeout(r,RETENTAR.esperaMs*tentativa));
    }
  }
}
