// Only trusted tool implementations emit this envelope; prose and model arguments
// are never evidence that a side effect did/did not happen.
export function rejectedEdit(error, extra={}) {
  return {...extra,ok:false,error,effect:{version:1,state:'not_applied',operation:'file_edit'}};
}

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
  if(['editar_arquivo_do_app','escrever_arquivo_do_app'].includes(call?.name)&&
    out?.ok===false&&out?.effect?.version===1&&out.effect.operation==='file_edit'&&out.effect.state==='not_applied')return 'not_applied';
  if(legacyPrewriteRejection(call,out))return 'not_applied';
  // HTTP call to the user's app: the tool knows, and only it knows, whether the request
  // actually went out and whether the method could change anything. A GET that returned 404
  // is not an "uncertain effect"; treating it as such used to lock up the entire task.
  if(call?.name==='chamar_sistema'&&out?.ok===false&&out?.efeito?.versao===1&&
    out.efeito.operacao==='chamada_http'&&out.efeito.estado==='nao_aplicado')return 'not_applied';
  if(legacyHttpRead(call,out))return 'not_applied';
  return 'unknown';
}
