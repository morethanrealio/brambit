// Horário de rotina = hora + MINUTO. Antes só existia a hora cheia: o dono que
// pedia "todo dia às 22h30" ganhava uma rotina às 22h e ainda precisava aceitar
// a troca (caso de 01/10). O minuto é coluna própria (routines.minute,
// default 0), então rotina antiga continua significando exatamente o que era.
//
// Regra de edição: passar `hora` sem `minuto` quer dizer hora CHEIA ("muda pra
// 8h" numa rotina das 22h30 vira 08h00, não 08h30). Passar só `minuto` mantém
// a hora gravada.

const vazio = (v) => v === undefined || v === null || v === '';

// Valida hora/minuto crus da tool. Devolve { hour?, minute? } só com o que veio,
// ou { error } em pt-BR (texto que chega no modelo e, às vezes, no dono).
export function parseRoutineTime({ hora, minuto } = {}) {
  const out = {};
  if (!vazio(hora)) {
    const h = Number(hora);
    if (!Number.isInteger(h) || h < 0 || h > 23) return { error: 'Hora inválida. Use um número inteiro de 0 a 23 (hora local).' };
    out.hour = h;
    out.minute = 0;
  }
  if (!vazio(minuto)) {
    const m = Number(minuto);
    if (!Number.isInteger(m) || m < 0 || m > 59) return { error: 'Minuto inválido. Use um número inteiro de 0 a 59 (ex: 22h30 = hora 22, minuto 30).' };
    out.minute = m;
  }
  return out;
}

const dois = (n) => String(Number(n) || 0).padStart(2, '0');

// "22h", "22h30" (pt). sep=':' dá "22:00"/"22:30" (en/es e a tela).
export function routineTimeLabel(hour, minute, sep = 'h') {
  const m = Number(minute) || 0;
  if (sep === 'h') return `${dois(hour)}h${m ? dois(m) : ''}`;
  return `${dois(hour)}${sep}${dois(m)}`;
}

// Mesmo rótulo a partir dos args crus da tool (cartão de confirmação). Sem hora:
// null, o chamador decide o padrão. Só minuto (edição): ":30".
export function routineArgsTimeLabel(args = {}, sep = 'h') {
  if (vazio(args.hora)) return vazio(args.minuto) ? null : `:${dois(args.minuto)}`;
  return routineTimeLabel(args.hora, vazio(args.minuto) ? 0 : args.minuto, sep);
}

// Minutos desde a meia-noite local do horário gravado da rotina.
export const routineMinuteOfDay = (r) => Number(r.hour) * 60 + (Number(r.minute) || 0);

// Chave de substituição do cartão de criar_rotina: re-propor a MESMA rotina
// (mesmo título) fecha o cartão pendente antigo em vez de empilhar dois cartões
// quase iguais na conversa (caso de 01/10: 2 cartões, o velho às 22h).
export const routineSupersedeKey = (a = {}) => String(a.titulo || '').trim().toLowerCase() || null;
