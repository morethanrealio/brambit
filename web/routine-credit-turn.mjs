import { tagIdioma } from './locale.mjs';

// Broad TRIGGER (not the executor) for the no-credit routine-management turn.
// Over credit the model never runs, so a routine the owner wants to stop used to
// go through a closed-grammar rule (the retired routine-control.mjs) that only
// paused and missed phrasings like "para esse lembrete". Here the model does the
// real interpretation once the turn opens; this only decides WHETHER to open it.
// A false positive costs one cheap turn (capped by a per-thread cooldown); a
// false negative falls back to the standard no-credit notice. Deliberately looser
// than the old rule: reminder/alert/digest nouns and plain "para" count too, but
// bare "para" only when followed by a determiner so "o resumo para hoje" does not
// trip it. Matching runs on accent-folded lowercase text.
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const VERB = /\b(?:parar|pare|para(?=\s+(?:o|a|os|as|esse|essa|esses|essas|este|esta|estes|estas|com|de|do|da|minha|meu|minhas|meus|the|my)\b)|pausar?|pause|cancel(?:ar|a|e|o)?|encerr(?:ar|a|e)|suspend(?:er|e)|desativ(?:ar|a|e)|desabilit(?:ar|a|e)|deslig(?:ar|a|ue)|apag(?:ar|a|ue)|exclu(?:ir|i|a)|remov(?:er|e|a)|tir(?:ar|a)|mud(?:ar|a|e)|alter(?:ar|a|e)|troc(?:ar|a|e)|edit(?:ar|a|e)|stop|disable|delete|remove|change|edit|turn\s+off|deten(?:er)?|quit(?:ar|a)|elimin(?:ar|a)|borr(?:ar|a)|cambi(?:ar|a)|modific(?:ar|a)|desactiv(?:ar|a))\b/;
const NOUN = /\b(?:rotinas?|lembretes?|alertas?|avisos?|resumos?|monitoramentos?|monitores?|routines?|reminders?|alerts?|digests?|summar(?:y|ies)|schedules?|monitors?|rutinas?|recordatorios?|resumen(?:es)?|monitoreos?)\b/;

export function routineManagementIntent(message) {
  if (typeof message !== 'string' || message.length > 500) return false;
  const s = fold(message);
  return VERB.test(s) && NOUN.test(s);
}

// System note that scopes the single no-credit turn to managing the owner's own
// routines. Appended to the agent's prompt; the only tool available is cancelar_rotina.
const NOTE = {
  'pt-BR': 'MODO SEM SALDO: os créditos do mês acabaram. Este é um ÚNICO turno, só para a pessoa gerenciar as próprias rotinas (pausar, retomar ou apagar). A única ferramenta disponível é cancelar_rotina: pausar vale na hora; apagar de vez pede a confirmação dela. Não execute nenhuma outra tarefa nem prometa fazer depois; para o resto, ela precisa repor créditos. Se não houver rotina para mexer, diga isso. Seja breve e direta.',
  en: 'NO-BALANCE MODE: this month\'s credits are exhausted. This is a SINGLE turn, only for the owner to manage their own routines (pause, resume or delete). The only tool available is cancelar_rotina: pausing takes effect immediately; a permanent delete asks for their confirmation. Do not run any other task and do not promise to do it later; for anything else they need to top up credits. If there is no routine to act on, say so. Be brief and direct.',
  es: 'MODO SIN SALDO: los créditos del mes se agotaron. Este es un ÚNICO turno, solo para que la persona gestione sus propias rutinas (pausar, reanudar o eliminar). La única herramienta disponible es cancelar_rotina: pausar vale al instante; eliminar del todo pide su confirmación. No ejecutes ninguna otra tarea ni prometas hacerla después; para lo demás necesita reponer créditos. Si no hay rutina para gestionar, dilo. Sé breve y directa.',
};
export function routineManagementSystemNote(language) {
  return NOTE[tagIdioma(language)] || NOTE['pt-BR'];
}
