// Only trusted tool implementations emit this envelope; prose and model arguments
// are never evidence that a side effect did/did not happen.
// operation names what was refused; each tool may only claim its own (RECEIPT_OPERATIONS).
export function rejectedEdit(error, extra={}, operation='file_edit') {
  return {...extra,ok:false,error,effect:{version:1,state:'not_applied',operation}};
}
const RECEIPT_OPERATIONS=new Map([['editar_arquivo_do_app','file_edit'],['escrever_arquivo_do_app','file_edit'],
  ['iniciar_estrutura_do_app','app_scaffold'],['definir_segredo','app_secret']]);

// Checkpoints created before every pre-write validation returned an effect
// receipt may contain a tool result but still be marked as an uncertain write.
// Recover only from arguments that make it impossible to reach any write. Do
// not trust the error prose: it can contain model-controlled values.
function legacyPrewriteRejection(call,out) {
  if(out?.ok!==false||!['editar_arquivo_do_app','escrever_arquivo_do_app'].includes(call?.name))return false;
  const args=call?.args&&typeof call.args==='object'&&!Array.isArray(call.args)?call.args:{};
  const rel=String(args.caminho||'').replace(/^\/+/, '').trim();
  if(!rel)return true;
  if(call.name!=='editar_arquivo_do_app')return false;
  if(Array.isArray(args.edicoes)&&args.edicoes.length)
    return args.edicoes.some(e=>!e||typeof e.trecho_antigo!=='string'||e.trecho_antigo===''||typeof e.trecho_novo!=='string');
  return typeof args.trecho_antigo!=='string'||args.trecho_antigo===''||typeof args.trecho_novo!=='string';
}
// Plan-cap refusals of iniciar_estrutura_do_app saved before that tool had a
// receipt. Only the permissions port sets numeric teto/atuais, never the model,
// and the cap is checked before any draft file is written.
function legacyScaffoldCap(call,out) {
  return call?.name==='iniciar_estrutura_do_app'&&out?.ok===false&&out?.effect===undefined&&
    Number.isFinite(out?.teto)&&Number.isFinite(out?.atuais);
}
// Checkpoints recorded before the HTTP call's effect receipt store the
// result but are marked as an uncertain write. Here too, only the
// ARGUMENTS decide, never the error text: GET doesn't change data by HTTP's
// definition, so repeating the call can never duplicate any mutation.
function legacyHttpRead(call,out) {
  if(out?.ok!==false||call?.name!=='chamar_sistema')return false;
  if(out?.efeito!==undefined)return false; // already has a receipt: the clause above decides.
  const args=call?.args&&typeof call.args==='object'&&!Array.isArray(call.args)?call.args:{};
  return String(args.metodo||'GET').toUpperCase()==='GET';
}
export function effectState(call,out) {
  if(out?.ok===true)return 'applied';
  if(out?.ok===false&&out?.effect?.version===1&&out.effect.state==='not_applied'&&
    RECEIPT_OPERATIONS.get(call?.name)===out.effect.operation)return 'not_applied';
  if(legacyPrewriteRejection(call,out)||legacyScaffoldCap(call,out))return 'not_applied';
  // HTTP call to the user's app: the tool knows, and only it knows, whether the request
  // actually went out and whether the method could change anything. A GET that returned 404
  // is not an "uncertain effect"; treating it as such used to lock up the entire task.
  if(call?.name==='chamar_sistema'&&out?.ok===false&&out?.efeito?.versao===1&&
    out.efeito.operacao==='chamada_http'&&out.efeito.estado==='nao_aplicado')return 'not_applied';
  if(legacyHttpRead(call,out))return 'not_applied';
  return 'unknown';
}
// A write refused by the installation's app cap (permissions port): nothing was
// written, and no write to this app can succeed until a slot is freed or the plan
// changes. Only the port sets numeric teto/atuais, never the model.
export function planCapRefusal(call,out) {
  if(!['iniciar_estrutura_do_app','escrever_arquivo_do_app'].includes(call?.name)||effectState(call,out)!=='not_applied')return null;
  if(!Number.isFinite(out?.teto)||!Number.isFinite(out?.atuais))return null;
  return {mensagem:typeof out.error==='string'?out.error.slice(0,400):'',teto:out.teto,atuais:out.atuais};
}
