import {throwIfAttemptControl} from '../provider-attempt.mjs';
// Regras que valem pra TODO provedor de texto (motor compatível e DeepSeek oficial).
// Diferença de comportamento entre provedores só pode vir de configuração ou de
// mania de modelo, nunca de regra própria de um adaptador.

const obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v:{};

// Chamada de ferramenta inválida recusa o LOTE inteiro: nada é executado e o core
// faz uma tentativa de reparo (turn-recovery). Argumento ausente ou vazio = {}.
// Nome que não está no catálogo NÃO é recusa: passa, e o core responde ao modelo
// "tool desconhecida" sem executar nada, pra ele se corrigir quantas vezes precisar
// (em prod, 9 em 2.226 pedidos; recusar com 1 reparo por pedido piorava 3 deles).
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

// Recusa passageira de capacidade: tenta de novo NO MESMO modelo, com espera
// crescente. Cada tentativa é uma requisição física nova (e conta no crédito).
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
