import {tagIdioma} from './locale.mjs';
import {routineConfirmationSnapshot} from './confirmation-bindings.mjs';

const fold = value => String(value || '').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/\s+/g,' ').trim();
const greeting = /^(?:oi|ola|bom dia|boa tarde|boa noite|hi|hello|good morning|good afternoon|good evening|hola|buenos dias|buenas tardes|buenas noches)(?:[,!.]\s*|\s+)/;

// Linguagem de controle fechada: nunca interpreta uma recusa simples, trecho
// citado, condição ou o conteúdo de uma rotina como autorização para pará-la.
export function routinePauseIntent(message, {hasPendingProposals = false, language = null} = {}) {
  if (typeof message !== 'string' || message.length > 500 || /[\n\r\u2063]/u.test(message)) return null;
  let text = fold(message).replace(/^[¿¡]\s*/,'').replace(/[.!?]+$/,'').trim();
  // Referências explícitas a propostas pertencem ao fluxo de confirmação.
  if (/\b(?:pedido|request|solicitud)\s*#?\s*\d+\b/.test(text)) return null;
  for (let n = 0; n < 2; n++) text = text.replace(greeting,'').trim();
  text = text.replace(/^[¿¡]\s*/,'');
  const request = text.match(/^(?:(?:por favor|please)[, ]+)?(?:(?:pode|poderia|can you|could you|puedes?|podrias?)\s+)?(?:(?:por favor|please)\s+)?(?:pausa|pause|pausar|pare|parar|encerrar|encerre|suspender|suspenda|desative|desativar|stop|disable|halt|end|detener|deten|detenga|suspende|desactivar|desactiva|cancela|cancele|cancelar|cancel|desliga|desligue|desligar|turn off|switch off|shut off)\s+(.+)$/)
    // "apaga" é o "desliga" do espanhol, mas em português é apagar (excluir):
    // só vale quando a conversa está em espanhol.
    || (language && tagIdioma(language) === 'es'
      ? text.match(/^(?:(?:por favor)[, ]+)?(?:(?:puedes?|podrias?)\s+)?(?:(?:por favor)\s+)?(?:apaga|apague|apagar)\s+(.+)$/) : null);
  if (!request) return null;
  // "Cancela a rotina" logo depois de um cartão de criar rotina é recusa da
  // proposta: com proposta pendente, o verbo cancelar fica com a confirmação.
  if (hasPendingProposals && /^(?:(?:por favor|please)[, ]+)?(?:(?:pode|poderia|can you|could you|puedes?|podrias?)\s+)?(?:(?:por favor|please)\s+)?cancel/.test(text)) return null;
  let all = /^(?:todas as|todos os|all the|all|todas las|todos los)\s+/.test(request[1]);
  const subject = request[1].replace(/^(?:todas as|todos os|all the|all|todas las|todos los|a|o|as|os|the|el|la|los|las|minha|minhas|meu|meus|my|mi|mis|estes|esses|estas|essas|these|those|estos|estas)\s+/,'')
    // Inglês põe o adjetivo antes: "all scheduled routines".
    .replace(/^(?:scheduled|automatic|automated|recurring)\s+/,'');
  const noun = subject.match(/^(?:rotinas?|monitoramentos?|monitors?|monitoring|routines?|monitoreos?|monitorizaciones?|rutinas?)(?:\s+(.*))?$/);
  if (!noun) return null;
  let target = (noun[1] || '').replace(/[, ]+(?:por favor|please|obrigad[oa]|thanks|thank you|gracias)$/,'').trim();
  // "o monitoramento programado, todos" descreve o conjunto, não um título.
  target = target.replace(/^(?:programad[oa]s?|agendad[oa]s?|automatic[oa]s?|recorrentes?|scheduled|automatic|recurring|automatizad[oa]s?)(?=$|[, ])/,'')
    .trim().replace(/^[, ]*(?:todos|todas|all)$/,() => { all = true; return ''; }).trim();
  target = target.replace(/^(?:de|do|da|del|named|chamad[oa]|llamad[oa])\s+/,'');
  if (/^(?:".*"|“.*”|'.*')$/.test(target)) target = target.slice(1,-1).trim();
  else if (/^(`+).+\1$/.test(target)) target = target.replace(/^(`+)(.+)\1$/,'$2').trim();
  else if (/\b(?:se|if|unless|si|quando|when|cuando|depois|after|despues|amanha|tomorrow|manana|e|and|y)\b/.test(target)) target = '';
  const family = /^monitor/.test(noun[0]) ? 'monitor' : null;
  return all && !target ? {target,all,family} : {target};
}

const TEXT = {
  'pt-BR': {
    none:'Você não tem rotinas para pausar.',
    choose:'Qual rotina você quer pausar? Responda “pause a rotina” seguido do nome completo ou do código.',
    active:'ativa',paused:'pausada',
    done:title => `Rotina ${title} pausada. Os próximos disparos automáticos estão desativados.`,
    already:title => `A rotina ${title} já está pausada.`,
    running:'Uma execução já encaminhada ou em andamento ainda pode terminar.',
    failed:'Não consegui confirmar a pausa. Confira as rotinas antes de tentar novamente.',
    doneMany:'Pausei estas rotinas; os próximos disparos automáticos estão desativados:',
    failedMany:'Não consegui confirmar a pausa destas, confira antes de tentar de novo:',
  },
  en: {
    none:'You have no routines to pause.',
    choose:'Which routine do you want to pause? Reply with “pause the routine” followed by its full name or code.',
    active:'active',paused:'paused',
    done:title => `Routine ${title} paused. Future automatic runs are disabled.`,
    already:title => `Routine ${title} is already paused.`,
    running:'A run already dispatched or in progress may still finish.',
    failed:'I could not confirm the pause. Check the routines before trying again.',
    doneMany:'I paused these routines; future automatic runs are disabled:',
    failedMany:'I could not confirm the pause of these, check them before trying again:',
  },
  es: {
    none:'No tienes rutinas para pausar.',
    choose:'¿Qué rutina quieres pausar? Responde “pausa la rutina” seguido de su nombre completo o código.',
    active:'activa',paused:'pausada',
    done:title => `Rutina ${title} pausada. Las próximas ejecuciones automáticas están desactivadas.`,
    already:title => `La rutina ${title} ya está pausada.`,
    running:'Una ejecución ya enviada o en curso todavía puede terminar.',
    failed:'No pude confirmar la pausa. Revisa las rutinas antes de volver a intentarlo.',
    doneMany:'Pausé estas rutinas; las próximas ejecuciones automáticas están desactivadas:',
    failedMany:'No pude confirmar la pausa de estas, revísalas antes de volver a intentarlo:',
  },
};
const titleOf = row => {
  const title = String(row.title || '').replace(/[\r\n\t]/g,' ').trim();
  const ticks = '`'.repeat(Math.max(0,...Array.from(title.matchAll(/`+/g), match => match[0].length)) + 1);
  return `${ticks} ${title} ${ticks}`;
};
const codeOf = (row, rows) => {
  let length = 4;
  while (length < row.id.length && rows.filter(candidate => candidate.id.startsWith(row.id.slice(0,length))).length > 1) length += 2;
  return row.id.slice(0,length);
};

export async function handleRoutinePause({message,userId,agent,language = 'pt-BR',hasPendingProposals = false,listRoutines,updateRoutine}) {
  const intent = routinePauseIntent(message,{hasPendingProposals,language});
  if (!intent || !userId || !agent?.id || agent.category === 'grupo') return null;
  const t = TEXT[tagIdioma(language)] || TEXT['pt-BR'];
  const reply = text => ({text,attachments:[]});
  try {
    // A leitura é escopada ao dono no banco, igual a listar_rotinas/editar_rotina:
    // quem pede por um assistente pode parar a rotina que outro assistente do mesmo dono roda.
    // Nunca infere "monitoramento" pelo prompt da rotina, só pelo título.
    const rows = (await listRoutines(userId)).filter(row => row.user_id === undefined || row.user_id === userId);
    if (!rows.length) return reply(t.none);
    if (intent.all) {
      const scope = rows.filter(row => row.enabled !== false && (!intent.family || fold(row.title).includes('monitor')));
      if (!scope.length) return reply(`${t.choose}\n\n${rows.map(row => `• ${titleOf(row)} — ${row.enabled === false ? t.paused : t.active} (#${codeOf(row,rows)})`).join('\n')}`);
      const paused = [], failed = [];
      for (const row of scope) {
        try {
          const result = await updateRoutine(row.id,userId,{enabled:false,
            expected:{...routineConfirmationSnapshot(row),agent_id:row.agent_id}});
          const saved = result?.routine;
          if (result?.ok === true && saved?.id === row.id && saved.user_id === userId && saved.enabled === false) paused.push(titleOf(saved));
          else failed.push(titleOf(row));
        } catch { failed.push(titleOf(row)); }
      }
      let text = paused.length ? `${t.doneMany}\n${paused.map(title => `• ${title}`).join('\n')}` : '';
      if (failed.length) text += `${text ? '\n\n' : ''}${t.failedMany}\n${failed.map(title => `• ${title}`).join('\n')}`;
      return reply(`${text}\n\n${t.running}`);
    }
    const code = /^#[a-f0-9-]{4,36}$/.test(intent.target) ? intent.target.slice(1) : null;
    const matches = intent.target ? rows.filter(row => code
      ? row.id.toLowerCase().startsWith(code)
      : fold(row.title) === intent.target) : [];
    if (matches.length !== 1) return reply(`${t.choose}\n\n${rows.map(row => `• ${titleOf(row)} — ${row.enabled === false ? t.paused : t.active} (#${codeOf(row,rows)})`).join('\n')}`);
    const row = matches[0];
    const result = await updateRoutine(row.id,userId,{enabled:false,
      expected:{...routineConfirmationSnapshot(row),agent_id:row.agent_id}});
    const saved = result?.routine;
    if (result?.ok !== true || saved?.id !== row.id || saved.user_id !== userId || saved.agent_id !== row.agent_id || saved.enabled !== false) return reply(t.failed);
    let text = row.enabled === false ? t.already(titleOf(saved)) : t.done(titleOf(saved));
    // Um extra pode ter sido selecionado antes da pausa, ainda sem heartbeat.
    // Pausar a cadência não é abortar trabalho já encaminhado pelo agendador.
    text += ` ${t.running}`;
    return reply(text);
  } catch {
    // Uma falha de gravação/recibo pode ser incerta; não diga que nada mudou.
    return reply(t.failed);
  }
}
