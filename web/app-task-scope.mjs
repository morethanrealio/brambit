// This detector can only REQUEST CLARIFICATION, never grant write permissions.
// The selected mode remains authoritative; changes to a paused mode use the
// existing parent-only human confirmation gate, never a model-supplied boolean.
export function reviewRequestNeedsClarification(text) {
  const s=String(text||'').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
  const withoutNegated=s.replace(/\b(?:nao|sem|no|sin|don't|do not|without)\b[^.!?;\n]*/g,'');
  return /\b(?:edite|editar|altere|alterar|corrija|corrigir|implemente|implementar|modifique|modificar|edit|modify|implement|fix|edita|editar|corrige|modifica)\b|\b(?:conclua|termine|finalize|complete|finish|termina|completa)\b.{0,50}\b(?:alteracoes|implementacao|changes|edits|cambios)\b|\b(?:execute|executar|rode|rodar|run|ejecuta|ejecutar)\b.{0,35}\b(?:teste|testes|test|tests|pruebas|app|jogo|game)\b/.test(withoutNegated);
}
export function scopeConflict(mode,reason='mode_conflict',taskId=null) {
 return {ok:false,tarefa_id:taskId,app_build:{version:2,modo:mode,estado:'interrompido',motivo:reason,publicado:false,background:false},instrucao:!taskId?'O modo selecionado não atende ao pedido atual. Use o modo correspondente ao pedido explícito, sem conceder edição quando o usuário pediu somente revisão; se ambíguo, esclareça antes. Não existe tarefa anterior para gerenciar.':'O pedido atual diverge do modo/escopo salvo. Não execute a tarefa antiga como se atendesse ao novo pedido. Explique a diferença. Para mudar uma tarefa pausada, chame gerenciar_tarefa_de_app acao atualizar_escopo com app, modo e objetivo completo; o servidor vincula a tarefa automaticamente; a confirmação humana preserva progresso e consumo. Não cancele nem reinicie do zero. Se o pedido for ambíguo, esclareça antes.'};
}
export function validScopeChange({modo,objetivo,arquivos_revisao}) {
 return ['revisao','edicao'].includes(modo)&&typeof objetivo==='string'&&!!objetivo.trim()&&objetivo.length<=2000&&(arquivos_revisao===undefined||(Array.isArray(arquivos_revisao)&&arquivos_revisao.length>0&&arquivos_revisao.length<=50&&arquivos_revisao.every(x=>typeof x==='string'&&!!x&&x.length<=300&&!x.includes('..')&&!x.startsWith('/'))));
}

export function editRequestNeedsClarification(text) {
 const s=String(text||'').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
 return /\b(?:somente|apenas|so|only|solo|solamente)\s+(?:uma?\s+)?(?:revisao|leitura|review|revision|lectura)\b|\bread[- ]only\b|\b(?:nao|sem|don't|do not|without|no|sin)\b[^.!?;\n]{0,30}\b(?:edite|editar|altere|alterar|modifique|modificar|edit|editing|modify|changes|cambios|modifiques|edites)\b/.test(s);
}
