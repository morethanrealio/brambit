import {wantsTechnicalAppDetails} from './app-editing-reply.mjs';
import { appTaskReceipt } from './app-review-receipt.mjs';
import { buildQuestions, buildInterruption, buildProgress } from './build-feedback.mjs';
import { lintDiagnostics } from './app-draft-validation.mjs';
export function createBuildState() {
  let validation = null;
  let interruption = null;
  const targets = new Set();
  const files = new Set();
  const mutations = new Set(['escrever_arquivo_do_app','editar_arquivo_do_app','iniciar_estrutura_do_app','remover_arquivo_do_app']);
  return {
    event(ev) {
      interruption = buildInterruption(ev) || interruption;
      if (ev?.type !== 'tool_result') return;
      if (mutations.has(ev.name)) {
        validation = null;
        if (ev.out?.ok === true) targets.add(ev.out.alvo_validacao || 'desconhecido'); // Even a failed edit may have partially written; fail closed.
        if (ev.out?.ok === true && typeof ev.args?.caminho === 'string') files.add(ev.args.caminho);
        if (ev.out?.ok === true && Array.isArray(ev.out.arquivos_criados))
          for (const path of ev.out.arquivos_criados) if (typeof path === 'string') files.add(path);
      }
      if (ev.name === 'validar_rascunho_do_app') validation = ev.out;
    },
    finish(result) {
      const interrupted = result.termination !== 'completed';
      const checked = validation?.ok === true && (!targets.size || (targets.size === 1 && targets.has(validation.alvo_validacao))) && /^[a-f0-9]{64}$/.test(validation.revisao || '');
      const state = interrupted ? 'interrompido' : !checked ? 'nao_validado'
        : validation.validacao === 'aprovado' ? 'consistencia_validada' : 'requer_correcao';
      return { ok:state === 'consistencia_validada', app_build:{ version:1, estado:state,
        motivo:result.termination, publicado:false, background:false,
        revisao:checked ? validation.revisao : null, arquivos:[...files],
        validacao:checked ? validation.validacao : 'pendente',
        ...(interruption ? { interrupcao:interruption } : {}),
        perguntas:buildQuestions(result.text),
        ...(checked ? lintDiagnostics(validation) : {}) },
        resumo_do_modelo:result.text || '',
        instrucao:'Estado acima é autoritativo. Resumo não comprova conclusão funcional. Só consistência estática validada; publicação exige confirmação e nova validação. Não há trabalho em background.' };
    },
  };
}
const words = {
  pt: { interrupted:'A construção parou antes de concluir. Não há trabalho rodando em background. Posso retomar do ponto em que parei.', unvalidated:'Ainda não consegui validar o rascunho. Não posso confirmar que a correção está pronta.', failed:'A verificação do rascunho ainda encontrou problemas que precisam ser corrigidos.', checked:'O rascunho passou na verificação de consistência do código. Isso não confirma o funcionamento completo do app.', unpublished:'As alterações não foram publicadas.', pending:'A publicação aguarda sua confirmação. Posso publicar?', publishFailed:'Tentei publicar após sua confirmação, mas a publicação foi bloqueada. Não foi concluída.', blocked:'Corrija e valide o rascunho com construir_app antes de solicitar publicação.' },
  en: { interrupted:'The build stopped before finishing. No work is running in the background. I can resume where it stopped.', unvalidated:'I could not validate the draft yet. I cannot confirm that the fix is ready.', failed:'Draft validation still found issues that need correction.', checked:'The draft passed code consistency checks. This does not confirm that the entire app works.', unpublished:'The changes were not published.', pending:'Publication is awaiting your confirmation. May I publish?', publishFailed:'I attempted publication after your confirmation, but it was blocked. It did not complete.', blocked:'Fix and validate the draft with construir_app before requesting publication.' },
  es: { interrupted:'La construcción se detuvo antes de terminar. No hay trabajo en segundo plano. Puedo retomar donde se detuvo.', unvalidated:'Todavía no pude validar el borrador. No puedo confirmar que la corrección esté lista.', failed:'La validación del borrador todavía encontró problemas que necesitan corrección.', checked:'El borrador pasó la verificación de consistencia del código. Esto no confirma el funcionamiento completo de la app.', unpublished:'Los cambios no fueron publicados.', pending:'La publicación espera tu confirmación. ¿Puedo publicar?', publishFailed:'Intenté publicar tras tu confirmación, pero se bloqueó la publicación. No se completó.', blocked:'Corrige y valida el borrador con construir_app antes de solicitar publicación.' },
};
// Deterministic status at the delivery boundary, not a semantic/regex promise detector.
export function createAppBuildJournal({ language='pt-BR', failedPublication=false, publicationError='', userRequest='', technicalDetails=wantsTechnicalAppDetails(userRequest) } = {}) {
  const w = words[/^en\b/i.test(language) ? 'en' : /^es\b/i.test(language) ? 'es' : 'pt'];
  // Só texto de campo `usuario` (escrito pela própria tool) vira recado ao dono.
  // `error` é técnico e pode carregar valor vindo do modelo, então não entra aqui.
  const safeReason = t => String(t || '').replace(/[\u0000-\u001f\u007f<>`]/g, ' ').trim().slice(0, 400);
  let build = null, publication = failedPublication ? 'failed' : null, controlProposal = null, jobReceipt=null;
  let pubError = safeReason(publicationError);
  const failedText = () => pubError || w.publishFailed;
  return {
    blockPublish() { return build && build.estado !== 'consistencia_validada' ? { ok:false, error:w.blocked } : null; },
    toolResult(call, out) {
      if(call.name === 'gerenciar_tarefa_de_app' && typeof out==='string' && out.startsWith('AÇÃO PENDENTE DE CONFIRMAÇÃO')) controlProposal=out;
      if (call.name === 'construir_app') {
        controlProposal=null;jobReceipt=out?.programming_job?out:null;
        build = [1,2].includes(out?.app_build?.version) ? out.app_build : { estado:'nao_validado' };
        // Uma publicação BLOQUEADA não some porque o modelo voltou a mexer no
        // rascunho no mesmo turno. Sem esta guarda o dono recebia só o recado da
        // construção e nunca ficava sabendo que a publicação dele foi barrada,
        // nem por quê (caso de 17/09).
        if (publication !== 'failed') publication = null;
      }
      if (call.name === 'publicar_sistema') {
        if (typeof out === 'string' && out.startsWith('AÇÃO PENDENTE DE CONFIRMAÇÃO')) publication = 'pending';
        else if (out?.ok === true) publication = 'published';
        else { publication = 'failed'; pubError = safeReason(out?.usuario) || pubError; }
      }
      return out;
    },
    finish(text, { proposalShown = false } = {}) {
      if(jobReceipt)return jobReceipt.text;
      // Com o cartão da proposta logo abaixo, este pedido de confirmação seria
      // a mesma pergunta duas vezes; o texto do modelo segue como está.
      if(controlProposal && !proposalShown)return controlProposal.replace(/^AÇÃO PENDENTE DE CONFIRMAÇÃO \(NÃO foi executada\)\. Registrei o pedido para /,'Preciso da sua confirmação para ').replace(/\. (?:Mostre ao usuário|O sistema mostra)[\s\S]*$/,'. Posso seguir?');
      if (publication === 'published') return text; // Actual publisher owns its receipt.
      if (!build) return publication === 'failed' ? failedText() : text;
      const receipt=appTaskReceipt(build,language,{technicalDetails,publication,publicationError:pubError});
      if(receipt&&!technicalDetails)return receipt;
      if(receipt)return receipt + (publication === 'pending' ? ' '+w.pending : publication === 'failed' ? ' '+failedText() : '');
      const status = build.estado === 'interrompido' ? w.interrupted : build.estado === 'consistencia_validada' ? w.checked
        : build.estado === 'requer_correcao' ? w.failed : w.unvalidated;
      const questions = buildQuestions(Array.isArray(build.perguntas) ? build.perguntas.join('\n') : '').map(q => `“${q}”`).join(' ');
      const progress = buildProgress(build, language);
      // Recibo antigo (app_build v1): sem isto uma publicação barrada também
      // sumia neste caminho, pelo mesmo motivo do caso de 17/09.
      const pubLine = publication === 'pending' ? ' ' + w.pending : publication === 'failed' ? ' ' + failedText() : '';
      return `${status}${progress ? ' ' + progress : ''} ${w.unpublished}${pubLine}${questions ? '\n\n' + questions : ''}`;
    },
  };
}
