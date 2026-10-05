import {createHash} from 'node:crypto';
import {createReadCoverage} from './app-read-coverage.mjs';
export const DEFAULT_CODING_CONTEXT_CHARS=144000;
const clone=x=>JSON.parse(JSON.stringify(x));
const digest=x=>createHash('sha256').update(x).digest('hex');
const parse=text=>{try{return JSON.parse(text)}catch{return null}};
const fullPage=d=>d?.ok===true&&typeof d.arquivo==='string'&&typeof d.hash==='string'&&Number.isSafeInteger(d.inicio)&&Number.isSafeInteger(d.fim)&&typeof d.conteudo==='string'&&d.conteudo.length===d.fim-d.inicio&&!d.contexto_recolhido;
// Coverage of code actually present NOW, not a record that a previous model call
// once saw it. A compacted marker or reference never proves available content.
export function visibleCodeCoverage(messages){
 const coverage=createReadCoverage();
 for(const m of messages||[]){if(m.role!=='tool')continue;const d=parse(m.content);if(fullPage(d))coverage.add(d);
  else if(d?.ok===true&&!d.contexto_recolhido&&Array.isArray(d.resultados))for(const x of d.resultados)if(typeof x.trecho==='string'&&x.trecho.length===x.fim-x.inicio)coverage.add(x);
 }
 return coverage;
}
// The worker owns coding context. Do not simultaneously apply the principal
// turn's four-message eviction policy. This is an input working-set bound, not
// a model context-window increase or an accumulated token/call allowance.
export function createCodingContext({store,scope,task,persist,maxChars=DEFAULT_CODING_CONTEXT_CHARS,currentAccess}){
 if(!Number.isSafeInteger(maxChars)||maxChars<4000||maxChars>DEFAULT_CODING_CONTEXT_CHARS)throw Error('Invalid coding context bound');
 task.contextArtifacts??={};task.contextStats??={archived:0,recovered:0,cacheHits:0};
 const artifactScope=ref=>JSON.stringify(['coding-context',scope,task.id,ref]);
 const readRecord=async key=>store.read?store.read(key):store.withTask(key,async({record})=>record);
 async function load(ref){
  if(typeof ref!=='string'||!Object.hasOwn(task.contextArtifacts,ref))return null;
  const record=await readRecord(artifactScope(ref));if(!record||digest(record.text)!==task.contextArtifacts[ref].sha)throw Error('Invalid coding context artifact');
  return record;
 }
 function validAccess(meta,access){
  if(access?.ok!==true)return false;
  if(access.historicalOnly===true||meta.historicalOnly===true)return true;
  if(meta.arquivo)return access.arquivos?.some(x=>x.caminho===meta.arquivo&&x.hash===meta.hash)===true;
  return !!meta.revisao&&access.revisao===meta.revisao;
 }
 async function archive(name,text,extra={}){
  if(text.length>1_000_000)throw Error('Coding context artifact exceeds bound');
  const value=parse(text),sha=digest(text),ref=digest(JSON.stringify([name,sha]));
  const meta={sha,name,...(fullPage(value)?{arquivo:value.arquivo,hash:value.hash,inicio:value.inicio,fim:value.fim,total_chars:value.total_chars}:{}),revisao:value?.revisao||null,...extra};
  if(!meta.arquivo&&!meta.revisao)meta.historicalOnly=true;
  if(!Object.hasOwn(task.contextArtifacts,ref)){
   await store.withTask(artifactScope(ref),async({record,save})=>{if(!record)await save({text});else if(digest(record.text)!==sha)throw Error('Artifact identity mismatch');});
   task.contextArtifacts[ref]=meta;task.contextStats.archived++;await persist();
  }
  return {ref,meta};
 }
 async function prepare({messages,consumedUpTo}){
  let size=JSON.stringify(messages).length;if(size<=maxChars)return;
  // Never remove a result or arguments before the model received them once.
  // Tool IDs and provider metadata (including thought signatures) stay intact.
  for(let i=0;i<Math.min(consumedUpTo,messages.length)&&size>maxChars;i++){
   const m=messages[i];
   if(m.role==='tool'&&typeof m.content==='string'&&m.content.length>=2000){
    if(parse(m.content)?.contexto_recolhido)continue;
    const text=m.content,{ref,meta}=await archive(m.name,text);
    const stub=JSON.stringify({contexto_recolhido:true,ref,origem:m.name,...(meta.arquivo?{arquivo:meta.arquivo,hash:meta.hash,inicio:meta.inicio,fim:meta.fim}:{}),orientacao:'Código/resultado guardado, não visível agora. Use recuperar_contexto_de_codigo com ref. Para arquivo, ler_arquivo_do_app também recupera os intervalos atuais com segurança.'});
    m.content=stub;size=JSON.stringify(messages).length;
   }else if(m.role==='assistant'&&Array.isArray(m.toolCalls)){
    for(const call of m.toolCalls)for(const [key,value] of Object.entries(call.args||{})){
     if(size<=maxChars||typeof value!=='string'||value.length<2000)continue;
     const {ref}=await archive(call.name,JSON.stringify({argumento:key,valor:value}),{historicalOnly:true,argument:key});
     const stub=`[Argumento histórico arquivado: ref=${ref}. Use recuperar_contexto_de_codigo para consultar, não para repetir a operação.]`;
     call.args[key]=stub;size=JSON.stringify(messages).length;
    }
   }
  }
 }
 async function recover({ref,cursor=0,inicio=0}={}){
  const access=await currentAccess();if(access?.ok!==true)return {ok:false,error:'Acesso atual não confirmado.'};
  if(ref===undefined){
   if(!Number.isSafeInteger(cursor)||cursor<0)return {ok:false,error:'Cursor inválido.'};
   const entries=Object.entries(task.contextArtifacts).filter(([,m])=>validAccess(m,access));
   return {ok:true,resultados_arquivados:entries.slice(cursor,cursor+20).map(([ref,{sha,...meta}])=>({ref,...meta})),proximo_cursor:cursor+20<entries.length?cursor+20:null};
  }
  const meta=Object.hasOwn(task.contextArtifacts,ref)?task.contextArtifacts[ref]:null;if(!meta)return {ok:false,error:'Referência não pertence a esta tarefa.'};
  if(!validAccess(meta,access))return {ok:false,error:'O acesso ou a versão mudou. Consulte o código atual; o conteúdo arquivado não autoriza edição da nova versão.'};
  const r=await load(ref);if(!r)return {ok:false,error:'Resultado arquivado indisponível; consulte a fonte atual.'};
  if(!Number.isSafeInteger(inicio)||inicio<0)return {ok:false,error:'Início inválido.'};
  task.contextStats.recovered++;
  const d=parse(r.text);
  if(fullPage(d)&&access.historicalOnly!==true)return {...d,revisao:access.revisao,contexto_recuperado:true};
  if(d&&typeof d==='object'&&!meta.historicalOnly&&!access.historicalOnly&&r.text.length<=20000)
   return {...d,contexto_recuperado:true};
  const text=meta.argument&&typeof d?.valor==='string'?d.valor:r.text;
  if(inicio>text.length)return {ok:false,error:'Início fora do resultado.'};
  let fim=Math.min(inicio+12000,text.length);
  if(inicio&&/[\uDC00-\uDFFF]/.test(text[inicio])&&/[\uD800-\uDBFF]/.test(text[inicio-1]))return {ok:false,error:'Use o proximo_inicio fornecido.'};
  if(fim<text.length&&/[\uD800-\uDBFF]/.test(text[fim-1]))fim++;
  return {ok:true,contexto_recuperado:true,contexto_historico:true,ref,origem:meta.name,inicio,fim,total_chars:text.length,trecho:text.slice(inicio,fim),proximo_inicio:fim<text.length?fim:null,orientacao_contexto:'Resultado/argumento histórico. Não é nova execução, não comprova estado atual nem autoriza repetir operações.'};

 }
 async function cachedRead(args,access){
  if(access?.ok!==true)return null;
  const arquivo=args.caminho,inicio=args.inicio??0,limite=args.limite??6000;
  if(typeof arquivo!=='string'||!Number.isSafeInteger(inicio)||inicio<0||!Number.isSafeInteger(limite)||limite<1)return null;
  const hash=access.arquivos?.find(x=>x.caminho===arquivo)?.hash;
  if(!hash||(inicio>0&&!args.hash_esperado)||(args.hash_esperado&&args.hash_esperado!==hash))return null;
  const entries=Object.entries(task.contextArtifacts).filter(([,x])=>x.arquivo===arquivo&&x.hash===hash&&x.inicio<=inicio&&x.fim>inicio);
  for(const [ref,meta] of entries){
   const fim=Math.min(inicio+Math.min(limite,6000),meta.total_chars);if(!Number.isSafeInteger(fim)||meta.fim<fim)continue;
   const record=await load(ref),d=record&&parse(record.text);if(!fullPage(d))continue;
   const begin=inicio-d.inicio;let end=fim-d.inicio;
   if(begin&&/[\uDC00-\uDFFF]/.test(d.conteudo[begin])&&/[\uD800-\uDBFF]/.test(d.conteudo[begin-1]))return null;
   if(end<d.conteudo.length&&/[\uD800-\uDBFF]/.test(d.conteudo[end-1]))end++;
   const final=d.inicio+end;
   task.contextStats.cacheHits++;
   return {...d,inicio,fim:final,parcial:inicio>0||final<d.total_chars,proximo_inicio:final<d.total_chars?final:null,conteudo:d.conteudo.slice(begin,end),revisao:access.revisao,contexto_recuperado:true};
  }
  return null;
 }
 function isRecovery({call,messages}){
  let ref=null;
  if(call.name==='recuperar_contexto_de_codigo'){
   const meta=Object.hasOwn(task.contextArtifacts,call.args?.ref||'')?task.contextArtifacts[call.args.ref]:null;
   if(meta?.arquivo)ref=meta;
  }else if(call.name==='ler_arquivo_do_app'){
   const a=call.args||{},i=a.inicio??0,n=Math.min(a.limite??6000,6000);
   if(!Number.isSafeInteger(i)||i<0||!Number.isSafeInteger(n)||n<1)return false;
   const candidates=(task.readCoverage||[]).filter(x=>x.arquivo===a.caminho&&(!a.hash_esperado||x.hash===a.hash_esperado));
   const x=candidates.at(-1);if(x?.total_chars!==null&&Number.isSafeInteger(x?.total_chars))ref={arquivo:x.arquivo,hash:x.hash,inicio:i,fim:Math.min(i+n,x.total_chars),total_chars:x.total_chars};
  }
  if(!ref||ref.fim<=ref.inicio)return false;
  const historical=createReadCoverage(task.readCoverage||[]).observe({ok:true,...ref});
  return historical?.novos_chars===0&&visibleCodeCoverage(messages).observe({ok:true,...ref})?.novos_chars>0;
 }
 return {prepare,recover,cachedRead,isRecovery};
}

// Keep a recent complete tool protocol, but not a fixed eight huge messages that
// exceed the working set again immediately after a paid summary.
export function codingCompactionCut(messages,maxTailChars=36000){
 let cut=Math.max(0,messages.length-8);while(cut>0&&messages[cut]?.role==='tool')cut--;
 while(cut<messages.length-2&&JSON.stringify(messages.slice(cut)).length>maxTailChars){
  let next=cut+1;while(next<messages.length&&messages[next]?.role==='tool')next++;
  if(next>=messages.length)break;cut=next;
 }
 return cut;
}
