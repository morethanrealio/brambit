// ── Scheduler de rotinas ──
// Loop simples (1x/min) que dispara rotinas baseadas em HORÁRIO. Cada rotina
// pertence a (usuário + assistente), tem um horário local (hora + minuto), dias e um prompt que o
// agente executa; o resultado vai pro usuário por e-mail (canal escolhido: email).
//
// Dedup: grava o DIA local em que rodou (last_run_day). Só roda 1x por dia. A
// janela aceita atraso de até 3h: além de tolerar um tick atrasado, recupera uma
// fila que ficou esperando outra rotina longa ou um restart curto do serviço.
// Sem cron externo: só Node.

import { routineMinuteOfDay } from './routine-time.mjs';

export const ROUTINE_LATE_GRACE_MIN = 180;

// Pausar, sem mudar mais nada, e uma operacao reversivel que reduz automacao e
// custo. Ela pode rodar assim que o dono pede; retomada e qualquer edicao
// combinada continuam sujeitas a confirmacao. A lista fechada evita que uma
// mudanca de horario, canal, prompt ou titulo viaje escondida junto da pausa.
export function isPauseOnlyRoutineChange(args = {}) {
  return args.ativa === false
    && Object.keys(args).every((key) => ['ativa', 'titulo', 'id'].includes(key));
}

// Dia local (YYYY-MM-DD) e hora/minuto local pra um timezone IANA.
export function localParts(tz, at = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  const day = `${p.year}-${p.month}-${p.day}`;
  const hour = Number(p.hour === '24' ? '0' : p.hour);
  const minute = Number(p.minute);
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  const dom = Number(p.day);                                    // dia do mês (1..31)
  const dim = new Date(Date.UTC(Number(p.year), Number(p.month), 0)).getUTCDate(); // dias no mês
  return { day, hour, minute, dow, dom, dim };
}

// ── Cadência da rotina (coluna `routines.days`, texto) ──────────────────────
// A coluna guarda a cadência inteira, sem migração de schema. Formas aceitas:
//   'daily' | 'weekdays' | 'weekends'   baldes legados (seguem valendo)
//   '[1,4]'                             dias da semana (0=dom .. 6=sáb)
//   '{"mes":[1,15]}'                    dias do mês (-1 = último dia do mês)
//   '{"nth":2,"dow":[1]}'               a Nª ocorrência do dia no mês (-1 = última)
// Existia só o trio de baldes, e por isso "todo domingo às 18h" virava weekends
// (chegava sábado também) e "a segunda da 2ª semana do mês" não era exprimível —
// a condição de data acabava DENTRO do texto da rotina e ela disparava em dia
// errado (auditoria 04/09, dois casos). Aqui a cadência volta a ser dado.
export const DOW_KEYS = { dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6 };
const DOW_NOMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

// Texto guardado -> forma estruturada. Nunca lança: valor estragado vira 'daily'.
export function parseRoutineDays(days) {
  let d = days ?? 'daily';
  if (typeof d === 'string') {
    const t = d.trim();
    if (t.startsWith('[') || t.startsWith('{')) {
      try { d = JSON.parse(t); } catch { return 'daily'; }
    } else {
      return ['daily', 'weekdays', 'weekends'].includes(t) ? t : 'daily';
    }
  }
  if (Array.isArray(d)) {
    const dow = [...new Set(d.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
    return dow.length ? dow : 'daily';
  }
  if (d && typeof d === 'object') {
    if (Array.isArray(d.mes)) {
      const mes = [...new Set(d.mes.map(Number).filter((n) => Number.isInteger(n) && ((n >= 1 && n <= 31) || n === -1)))].sort((a, b) => a - b);
      return mes.length ? { mes } : 'daily';
    }
    if (d.nth !== undefined && Array.isArray(d.dow)) {
      const nth = Number(d.nth);
      const dow = [...new Set(d.dow.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
      if (dow.length && (nth === -1 || (Number.isInteger(nth) && nth >= 1 && nth <= 5))) return { nth, dow };
    }
  }
  return 'daily';
}

// A cadência inclui ESTE dia local? (dow 0=dom, dom = dia do mês, dim = dias no mês)
export function daysMatch(days, { dow, dom, dim }) {
  const d = parseRoutineDays(days);
  if (d === 'weekdays') return dow !== 0 && dow !== 6;
  if (d === 'weekends') return dow === 0 || dow === 6;
  if (Array.isArray(d)) return d.includes(dow);
  if (d && typeof d === 'object' && Array.isArray(d.mes)) {
    // -1 = último dia do mês (fevereiro/meses de 30 dias entram certo).
    // "Todo dia 31" num mês de 30 cai no dia 30, e "dia 30" em fevereiro cai no
    // 28/29: o dia pedido não existe, e pular o mês inteiro em silêncio é pior
    // que entregar no último dia (é o que a pessoa quer dizer com "todo mês").
    // Dispara uma vez só, porque só o último dia satisfaz a condição.
    return d.mes.some((n) => (n === -1 || n > dim ? dom === dim : n === dom));
  }
  if (d && typeof d === 'object' && Array.isArray(d.dow)) {
    if (!d.dow.includes(dow)) return false;
    // A Nª ocorrência de um dia da semana no mês: a 1ª cai entre 1 e 7, a 2ª entre
    // 8 e 14, e assim por diante. A ÚLTIMA é aquela sem outra igual 7 dias depois.
    return d.nth === -1 ? dom + 7 > dim : Math.ceil(dom / 7) === d.nth;
  }
  return true; // 'daily'
}

// Argumentos da tool -> valor canônico pra coluna. Devolve { days } ou { error }
// (texto pronto pro dono). Precedência: dia do mês > Nª semana > dia da semana >
// balde. Uma cadência só, pra não existir rotina com duas regras conflitantes.
export function normalizeRoutineDays({ dias, dias_da_semana, dias_do_mes, semana_do_mes } = {}) {
  const listaDow = (v) => {
    const out = [];
    for (const item of (Array.isArray(v) ? v : [v])) {
      if (item === undefined || item === null || item === '') continue;
      // Aceita nome ("seg", "segunda", "Segunda-feira") e também o número do dow,
      // porque o modelo às vezes manda 0..6 direto.
      const n = Number(item);
      if (Number.isInteger(n) && n >= 0 && n <= 6 && String(item).trim() === String(n)) { out.push(n); continue; }
      // Tira o acento ANTES de cortar em 3: "s\u00e1bado" decomposto ("sa" + acento +
      // "bado") perderia o "b" no corte e n\u00e3o casaria mais com sab.
      const k = String(item).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().trim().slice(0, 3);
      if (!(k in DOW_KEYS)) return null;
      out.push(DOW_KEYS[k]);
    }
    return out.length ? [...new Set(out)].sort() : null;
  };
  if (dias_do_mes !== undefined && dias_do_mes !== null && String(dias_do_mes) !== '') {
    const mes = [...new Set((Array.isArray(dias_do_mes) ? dias_do_mes : [dias_do_mes])
      .map(Number).filter((n) => Number.isInteger(n) && ((n >= 1 && n <= 31) || n === -1)))].sort((a, b) => a - b);
    if (!mes.length) return { error: 'Dias do mês inválidos. Use números de 1 a 31 (ou -1 pro último dia do mês).' };
    return { days: JSON.stringify({ mes }) };
  }
  if (semana_do_mes !== undefined && semana_do_mes !== null && String(semana_do_mes) !== '') {
    const nth = Number(semana_do_mes);
    if (!(nth === -1 || (Number.isInteger(nth) && nth >= 1 && nth <= 5))) {
      return { error: 'Semana do mês inválida. Use 1 a 5, ou -1 pra última do mês.' };
    }
    const dow = listaDow(dias_da_semana);
    if (!dow) return { error: 'Pra usar semana_do_mes eu preciso também do dia da semana (ex: dias_da_semana: ["seg"]).' };
    if (dow.length > 1) return { error: 'Com semana_do_mes, passe UM dia da semana só (ex: "a 2ª segunda do mês").' };
    return { days: JSON.stringify({ nth, dow }) };
  }
  if (dias_da_semana !== undefined && dias_da_semana !== null && String(dias_da_semana) !== '') {
    const dow = listaDow(dias_da_semana);
    if (!dow) return { error: 'Dias da semana inválidos. Use dom, seg, ter, qua, qui, sex, sab.' };
    return { days: JSON.stringify(dow) };
  }
  if (dias !== undefined && dias !== null && String(dias) !== '') {
    if (!['daily', 'weekdays', 'weekends'].includes(dias)) {
      return { error: 'Dias inválidos. Use daily, weekdays ou weekends, ou passe dias_da_semana/dias_do_mes.' };
    }
    return { days: dias };
  }
  return { days: null }; // nada informado: quem chama decide o default
}

// Rótulo pt-BR de um intervalo em minutos: "5 min", "1 hora", "2 horas", "1 dia".
// Mora aqui (e não no server) porque o cartão de confirmação precisa dizer a
// MESMA cadência que vai ser gravada.
export function intervalLabel(min) {
  const m = Number(min);
  if (m % 1440 === 0) { const d = m / 1440; return d === 1 ? '1 dia' : `${d} dias`; }
  if (m % 60 === 0) { const h = m / 60; return h === 1 ? '1 hora' : `${h} horas`; }
  return `${m} min`;
}

// Cadência (valor guardado OU args da tool já normalizados) em português.
export function routineDaysLabel(days) {
  const d = parseRoutineDays(days);
  if (d === 'weekdays') return 'seg–sex';
  if (d === 'weekends') return 'sáb–dom';
  if (Array.isArray(d)) {
    if (d.length === 7) return 'todo dia';
    const nomes = d.map((n) => DOW_NOMES[n]);
    const artigo = (d[0] === 0 || d[0] === 6) ? 'todo' : 'toda';
    const lista = nomes.length === 1 ? nomes[0] : `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`;
    return `${artigo} ${lista}`;
  }
  if (d && typeof d === 'object' && Array.isArray(d.mes)) {
    const nomes = d.mes.map((n) => (n === -1 ? 'último dia' : `dia ${n}`));
    const lista = nomes.length === 1 ? nomes[0] : `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`;
    // Diz o que a plataforma vai fazer quando o dia não existir no mês, senão o
    // dono confirma "todo dia 31" achando que fevereiro não recebe nada.
    const curto = d.mes.some((n) => n > 28) ? ' (nos meses mais curtos, no último dia)' : '';
    return `todo mês no ${lista}${curto}`;
  }
  if (d && typeof d === 'object' && Array.isArray(d.dow)) {
    const nome = DOW_NOMES[d.dow[0]];
    const ord = d.nth === -1 ? 'última' : `${d.nth}ª`;
    return `${ord} ${nome} do mês`;
  }
  return 'todo dia';
}

// A rotina deve rodar AGORA? (hora local bate, dia certo, ainda não rodou hoje.)
export function isDue(routine, at = new Date()) {
  if (!routine.enabled) return false;
  // Modo INTERVALO (recorrência de granularidade livre): dispara quando next_run já
  // passou. A janela (repeat_until) é garantida na hora de gravar o next_run — quando
  // o próximo passaria do fim, a rotina é DESLIGADA em vez de ganhar um next_run fora
  // da janela; então aqui basta checar next_run <= agora.
  if (routine.repeat_every_min) {
    if (!routine.next_run) return false;
    return new Date(routine.next_run).getTime() <= at.getTime();
  }
  const parts = localParts(routine.tz, at);
  if (routine.last_run_day === parts.day) return false;     // já rodou hoje
  if (!daysMatch(routine.days || 'daily', parts)) return false;
  const atrasoMin = parts.hour * 60 + parts.minute - routineMinuteOfDay(routine);
  return atrasoMin >= 0 && atrasoMin <= ROUTINE_LATE_GRACE_MIN;
}

// Sobe o loop. Injeta deps pra evitar import circular com server/db.
//   deps.listDueRoutines()  -> [{ ...routine, email, agent_name, user_name }]
//   deps.markRoutineRun(id, day)
//   deps.runRoutine(routine) -> texto gerado pelo agente
//   deps.deliver(routine, text) -> entrega (e-mail)
//   deps.listDueRoutineOneShots()/claimRoutineOneShot()/finishRoutineOneShot()
//      -> execução futura única da rotina, sem mudar a cadência normal
//   deps.listDueReminders()      -> [{ ...reminder, email, user_name, agent_name }] (run_at<=now, pending)
//   deps.executeReminder(reminder) -> claim, envio e resultado persistente
//   deps.recoverReminderDeliveries() -> recupera claims anteriores ao envio;
//      envios interrompidos ficam incertos e nunca são repetidos automaticamente
export function startScheduler(deps, { intervalMs = 60_000, now = () => new Date() } = {}) {
  let running = false, stopped=false;
  let drained;let drainPromise=Promise.resolve();
  async function tick() {
    if (running || stopped) return;            // evita sobreposição se um tick demora
    running = true;
    drainPromise=new Promise(resolve=>{drained=resolve;});
    try {
      // Uma foto só do relógio pro lote inteiro. Antes, isDue() lia Date a cada
      // item: se a primeira rotina das 8h levasse 11 minutos, as seguintes eram
      // reavaliadas depois da janela e simplesmente puladas.
      const tickAt = now();
      if(deps.recoverRoutineExecutions)await deps.recoverRoutineExecutions();
      const routines = await deps.listDueRoutines();
      for (const r of routines) {
        if(stopped)break;
        // Fim de janela (repeat_until) vale nos DOIS modos. Antes só o modo
        // INTERVALO olhava essa data, então rotina por HORÁRIO com fim natural
        // ("todo dia às 5h durante a Quaresma") não tinha como parar: disparava
        // pra sempre e sobrava pro dono cancelar na mão.
        if (!r.repeat_every_min && r.repeat_until && tickAt.getTime() > new Date(r.repeat_until).getTime()) {
          await deps.markRoutineNext(r.id, null);                  // desliga, não apaga
          console.log(`[rotina] ${r.id} (${r.title}) encerrada: passou de repeat_until`);
          continue;
        }
        if (!isDue(r, tickAt)) continue;
        const prepare=async()=>{
        // Marca ANTES de rodar: se a geração falhar, não fica re-disparando.
        if (r.repeat_every_min) {
          // Modo INTERVALO: agenda o próximo disparo (pulando slots perdidos p/ não
          // disparar em rajada). Se o próximo passa da janela, ESTE é o último: encerra.
          const stepMs = Number(r.repeat_every_min) * 60_000;
          let next = new Date(r.next_run).getTime() + stepMs;
          const now = Date.now();
          while (next <= now) next += stepMs;
          if (r.repeat_until && next > new Date(r.repeat_until).getTime()) {
            await deps.markRoutineNext(r.id, null);                 // fim da janela: desliga
          } else {
            await deps.markRoutineNext(r.id, new Date(next).toISOString());
          }
        } else {
          const { day } = localParts(r.tz, tickAt);
          await deps.markRoutineRun(r.id, day);
        }
        };
        if(deps.executeRoutine){
          const slot=r.repeat_every_min?`interval:${new Date(r.next_run).toISOString()}`:`day:${localParts(r.tz,tickAt).day}`;
          try {await deps.executeRoutine(r,{slot,prepare,run:deps.runRoutine,deliver:deps.deliver});}
          catch(e){console.error(`[rotina] ${r.id} falhou (estado persistido quando possível):`,e?.message??e);}
          continue;
        }
        await prepare(); // compatibility for existing isolated integrations

        try {
          const text = await deps.runRoutine(r);
          // Texto vazio = rodou e não tem o que entregar (ex.: dono sem crédito
          // já avisado nesta semana). Não mentir "entregue" no log: é justamente
          // aqui que se diagnostica rotina que sumiu do canal da pessoa.
          const typed = text?.type === 'flight-monitor-v1' || text?.type === 'curation-v1';
          const body = typed ? text.text : text;
          if (body && body.trim()) {
            await deps.deliver(r, typed ? text : body.trim());
            console.log(`[rotina] ${r.id} (${r.title}) entregue p/ ${r.email}`);
          } else {
            console.log(`[rotina] ${r.id} (${r.title}) rodou sem resposta — nada entregue`);
          }
        } catch (e) {
          console.error(`[rotina] ${r.id} falhou:`, e?.message ?? e);
        }
      }
      // Execução EXTRA futura de uma rotina existente. É uma fila própria: um
      // lembrete só envia texto fixo e nunca pode fingir que executará a rotina.
      // Claim acontece antes de gerar; worker interrompido vira uncertain e não
      // é repetido automaticamente (a geração pode ter efeitos externos).
      if (!stopped && deps.listDueRoutineOneShots) {
        if(deps.recoverRoutineOneShots)await deps.recoverRoutineOneShots();
        const jobs=await deps.listDueRoutineOneShots();
        for(const job of jobs){
          if(stopped)break;
          if(!await deps.claimRoutineOneShot(job.one_shot_id))continue;
          try{
            const result=await deps.executeRoutine(job,{
              slot:`once:${job.one_shot_id}`,prepare:async()=>{},run:deps.runRoutine,deliver:deps.deliver,
            });
            const status=result?.status==='completed'?'completed':result?.status==='partial'?'partial':'failed';
            await deps.finishRoutineOneShot(job.one_shot_id,status,{contentStatus:result?.contentStatus||'unknown',delivery:result?.delivery||{status:'unknown'}});
            console.log(`[rotina extra] ${job.one_shot_id} (${job.title}) terminou: conteúdo=${result?.contentStatus||'unknown'} entrega=${result?.delivery?.status||'unknown'}`);
          }catch(e){
            await deps.finishRoutineOneShot(job.one_shot_id,'failed',{error:'execution_failed'}).catch(()=>{});
            console.error(`[rotina extra] ${job.one_shot_id} (${job.title}) falhou:`,e?.message??e);
          }
        }
      }
      // Jobs de geração de vídeo (async): avança/entrega os que ficaram prontos.
      // Best-effort; erro aqui não derruba o resto do tick.
      if (!stopped && deps.pollVideoJobs) {
        try { await deps.pollVideoJobs(); }
        catch (e) { console.error('[scheduler] pollVideoJobs falhou:', e?.message ?? e); }
      }
      // O executor registra uma ocorrência e obtém o claim atômico antes do
      // envio. Aceite e reagendamento são persistidos juntos só DEPOIS do canal.
      if (!stopped && deps.listDueReminders) {
        if (deps.recoverReminderDeliveries) await deps.recoverReminderDeliveries();
        const reminders = await deps.listDueReminders();
        if (reminders.length && !deps.executeReminder) throw Error('Executor persistente de lembretes indisponível');
        for (const rem of reminders) {
          if(stopped)break;
          try {
            const result = await deps.executeReminder(rem);
            if (result?.status === 'skipped') continue;
            console.log(`[lembrete] ${rem.id} canal=${rem.channel} status=${result?.status || 'unknown'}`);
          } catch (e) {
            console.error(`[lembrete] ${rem.id} falhou (estado persistido quando possível):`, e?.message ?? e);
          }
        }
      }
    } catch (e) {
      console.error('[scheduler] tick falhou:', e?.message ?? e);
    } finally {
      running = false;drained?.();
    }
  }
  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  console.log(`[scheduler] rotinas ativas (tick ${Math.round(intervalMs / 1000)}s)`);
  return { stop: () => {stopped=true;clearInterval(handle);return drainPromise;}, tick };
}
