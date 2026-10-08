// Typed flight monitoring: doesn't use the LLM to pick the reference,
// calculate variation, or draft the delivery. External dependencies are
// injected.
import { createHash } from 'node:crypto';
import { hostDaMarca } from './marca.mjs';
import { flightPriceCents, percentageDrop } from './flight-alert-policy.mjs';
const money = n => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);
const oneLine = s => String(s).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
const validDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s+'T12:00:00Z').toISOString().slice(0,10) === s;
export function normalizeFlightMonitor(raw) {
  if (raw?.version === 2) return normalizeFlightAlerts(raw);
  if (!raw || raw.version !== 1 || (raw.currency !== undefined && raw.currency !== 'BRL')) throw Error('Configuração de monitoramento inválida.');
  const q = raw.query || {};
  if (q.data_volta !== undefined && (typeof q.data_volta !== 'string' || !q.data_volta)) throw Error('Data de volta inválida.');
  for (const k of ['origem','destino']) if (!/^[A-Z]{3}$/.test(q[k] || '')) throw Error('Aeroporto inválido.');
  if (q.origem === q.destino || !validDate(q.data_ida) || (q.data_volta && (!validDate(q.data_volta) || q.data_volta < q.data_ida))) throw Error('Datas/rota inválidas.');
  const query = { origem:q.origem, destino:q.destino, data_ida:q.data_ida,
    ...(q.data_volta ? {data_volta:q.data_volta} : {}), adultos:q.adultos ?? 1, criancas:q.criancas ?? 0,
    classe:q.classe ?? 'economica', paradas:q.paradas ?? 'qualquer' };
  if (!Number.isInteger(query.adultos) || query.adultos<1 || query.adultos>9 || !Number.isInteger(query.criancas) || query.criancas<0 || query.criancas>8) throw Error('Passageiros inválidos.');
  if (!['economica','premium','executiva','primeira'].includes(query.classe) || !['qualquer','direto','1_parada'].includes(query.paradas)) throw Error('Filtros inválidos.');
  // The target isn't a search filter: above the ceiling there's still a
  // daily report.
  if (q.max_preco !== undefined) throw Error('Use targetPrice, não filtre resultados pela meta.');
  if (Object.keys(q).some(k => !['origem','destino','data_ida','data_volta','adultos','criancas','classe','paradas','companhias'].includes(k))) throw Error('Parâmetro de busca não suportado.');
  if (q.companhias !== undefined) {
    if (!Array.isArray(q.companhias) || !q.companhias.length || q.companhias.length > 5 || q.companhias.some(v => typeof v !== 'string' || !/^(?:[A-Z][A-Z0-9]|[0-9][A-Z])$/.test(v))) throw Error('Companhias inválidas.');
    query.companhias = [...new Set(q.companhias)].sort();
  }
  const targetPrice = raw.targetPrice ?? null;
  if (targetPrice !== null && (typeof targetPrice !== 'number' || !Number.isFinite(targetPrice) || targetPrice<=0 || targetPrice>1e8)) throw Error('Meta inválida.');
  return {version:1,query,targetPrice,currency:'BRL'};
}
export function flightQueryKey(config) {
  const c = normalizeFlightMonitor(config);
  if (c.version!==1) throw Error('Use a identidade de cada rota para monitor v2.');
  return createHash('sha256').update(JSON.stringify({query:c.query,currency:c.currency})).digest('hex');
}
export function localFlightDay(iso, tz) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) throw Error('Data da observação inválida.');
  return new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
}
export function previousFlightDay(day) {
  const d = new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-1);return d.toISOString().slice(0,10);
}
function safeLink(s) {
  try { const u=new URL(s);return u.protocol==='https:' && ['www.google.com','google.com'].includes(u.hostname) && u.pathname.startsWith('/travel/flights') && !u.username && !u.password ? u.href : ''; } catch {return '';}
}
export function flightComparison(current, previous, {key,today,tz}) {
  if (!current || current.stale || current.currency!=='BRL' || !Number.isFinite(current.price) || current.price<=0 || localFlightDay(current.observedAt,tz)!==today) return {state:'unavailable'};
  if (!previous || previous.query_key!==key || previous.currency!=='BRL' || previous.observation_day!==previousFlightDay(today) || !Number.isFinite(Number(previous.price)) || Number(previous.price)<=0 || localFlightDay(previous.observed_at,tz)!==previous.observation_day) return {state:'no_baseline'};
  const deltaCents=Math.round(current.price*100)-Math.round(Number(previous.price)*100);
  return {state:deltaCents<0?'down':deltaCents>0?'up':'equal',delta:deltaCents/100,previousPrice:Number(previous.price),previousDay:previous.observation_day};
}
export function renderFlightMonitor(config, current, comparison, {today,tz,storageOk=true}) {
  const c=normalizeFlightMonitor(config),q=c.query;
  const cabin={economica:'econômica',premium:'premium economy',executiva:'executiva',primeira:'primeira classe'}[q.classe];
  const stops={qualquer:'qualquer número de escalas',direto:'voo direto','1_parada':'até uma parada'}[q.paradas];
  const route=`${q.origem}–${q.destino}, ida ${q.data_ida}${q.data_volta?`, volta ${q.data_volta}`:', só ida'}, ${q.adultos} adulto${q.adultos===1?'':'s'}${q.criancas?`, ${q.criancas} criança${q.criancas===1?'':'s'}`:''}, classe ${cabin}, ${stops}`;
  const parts=[`Monitoramento de passagens: ${route}.`];
  if (!current) parts.push('Não consegui obter uma cotação válida nesta execução. Não há comparação disponível; a meta não substitui uma medição.');
  else {
    const stamp=new Intl.DateTimeFormat('pt-BR',{timeZone:tz,dateStyle:'short',timeStyle:'short'}).format(new Date(current.observedAt));
    parts.push(`Menor preço encontrado: ${money(current.price)}. Consulta de ${stamp} (${tz})${current.fromCache?', resultado em cache':''}.`);
    if (current.stale || localFlightDay(current.observedAt,tz)!==today) parts.push('Cotação antiga: não representa uma nova consulta de hoje. Sem comparação diária válida.');
    else {
      if (comparison.state==='down') parts.push(`Caiu ${money(-comparison.delta)} desde ${comparison.previousDay} (antes: ${money(comparison.previousPrice)}).`);
      else if (comparison.state==='up') parts.push(`Subiu ${money(comparison.delta)} desde ${comparison.previousDay} (antes: ${money(comparison.previousPrice)}).`);
      else if (comparison.state==='equal') parts.push(`Preço igual ao de ${comparison.previousDay}: ${money(comparison.previousPrice)}.`);
      else parts.push('Sem medição comparável do dia anterior; não é possível afirmar alta ou queda.');
      if (c.targetPrice!==null) {
        const diff=(Math.round(current.price*100)-Math.round(c.targetPrice*100))/100;
        parts.push(diff<0?`Abaixo da meta de ${money(c.targetPrice)} por ${money(-diff)}.`:diff>0?`${money(diff)} acima da meta de ${money(c.targetPrice)}.`:`Igual à meta de ${money(c.targetPrice)}; ainda não está abaixo dela.`);
      }
    }
    // Details of up to three options, not the source's free HTML/text.
    for (const [i,o] of (current.options||[]).slice(0,3).entries()) {
      if (!Number.isFinite(o.price)||o.price<=0) continue;
      const airline=oneLine(o.airline||'Companhia não informada').replace(/[*_`]/g,'').slice(0,90);
      parts.push(`Opção ${i+1}: ${money(o.price)}, ${airline}, ${Number.isInteger(o.stops)&&o.stops>=0?o.stops+' parada(s)':'escalas não informadas'}.`);
    }
    const link=safeLink(current.link);if(link)parts.push(`Conferir e comprar: ${link}`);
  }
  if (!storageOk) parts.push('Histórico de comparação indisponível nesta execução.');
  // The legacy gateway truncates variables at 900 characters. Never depend on
  // that truncation: it drops additional options/the LONG link in full, while
  // preserving price, reference, delta, target and age. The full version is
  // still in the app.
  let templateParts=[...parts];
  if (oneLine(templateParts.join(' ')).length>900) {
    templateParts=templateParts.filter(p=>!p.startsWith('Conferir e comprar:')&&!p.startsWith('Opção '));
    templateParts.push(`Link e opções completas no app ${hostDaMarca()}.`);
  }
  const templateText=oneLine(templateParts.join(' '));
  if (templateText.length>900) throw Error('Relatório não cabe no template sem perda de dados.');
  return {type:'flight-monitor-v1',text:parts.join('\n'),templateText};
}
export async function executeFlightMonitor({config,userId,routineId,tz,now=new Date().toISOString()}, deps) {
  if (config?.version === 2) return executeFlightAlerts({config,userId,routineId,tz,now}, deps);
  const c=normalizeFlightMonitor(config),key=flightQueryKey(c),today=localFlightDay(now,tz);
  if (today>c.query.data_ida) return {type:'flight-monitor-v1',
    text:'A data de ida deste monitoramento já passou. Não consultei preços. Revise as datas da rotina no app.',
    templateText:'A data de ida deste monitoramento já passou. Não consultei preços. Revise as datas da rotina no app.'};
  // Migration not applied or unavailable: don't start a partially activated
  // routine or mask a database error as an absence of history.
  let previous;
  try {previous=await deps.readPrevious({userId,routineId,key,day:previousFlightDay(today),tz});}
  catch {return renderFlightMonitor(c,null,{state:'unavailable'},{today,tz,storageOk:false});}
  let quote=null;
  try {quote=await deps.search(c.query);} catch { /* failure becomes a deterministic notice */ }
  if (quote && (quote.currency!=='BRL'||!Number.isFinite(quote.price)||quote.price<=0||!quote.observedAt||!Number.isFinite(new Date(quote.observedAt).getTime())||new Date(quote.observedAt)>new Date(deps.now ? deps.now() : Date.now()))) quote=null;
  const cmp=flightComparison(quote,previous,{key,today,tz});
  let storageOk=true;
  if (quote && !quote.stale && localFlightDay(quote.observedAt,tz)===today) {
    try {await deps.record({userId,routineId,key,day:today,query:c.query,quote,tz});} catch {storageOk=false;}
  }
  return renderFlightMonitor(c,quote,cmp,{today,tz,storageOk});
}


// V2 is opt-in and doesn't migrate v1/free-form routines. Up to three queries
// per run; a fixed reference needs to be tied to the SAME query/unit by hash.
export function flightAlertQueryKey(query) {
  const normalized = normalizeFlightMonitor({version:1,query}).query;
  return createHash('sha256').update(JSON.stringify({version:2,query:normalized,currency:'BRL',priceBasis:'provider_price'})).digest('hex');
}
function normalizeFlightAlerts(raw) {
  if (Object.keys(raw).some(k => !['version','routes','dropBps'].includes(k)) || !Number.isInteger(raw.dropBps) || raw.dropBps<=0 || raw.dropBps>=10000
    || !Array.isArray(raw.routes) || !raw.routes.length || raw.routes.length>3) throw Error('Configuração de alerta inválida.');
  const keys = new Set();
  const routes = raw.routes.map(r => {
    if (!r || Object.keys(r).some(k => !['query','reference'].includes(k))) throw Error('Rota de alerta inválida.');
    const query = normalizeFlightMonitor({version:1,query:r.query}).query;
    const key = flightAlertQueryKey(query), ref = r.reference;
    if (keys.has(key)) throw Error('Consulta de alerta duplicada.'); keys.add(key);
    if (!ref || ref.currency!=='BRL' || ref.priceBasis!=='provider_price' || ref.queryKey!==key
      || Object.keys(ref).some(k => !['kind','priceCents','queryKey','currency','priceBasis'].includes(k))) throw Error('Referência não corresponde à consulta/unidade.');
    if (ref.kind==='fixed') {
      if (!Number.isSafeInteger(ref.priceCents) || ref.priceCents<=0 || ref.priceCents>1e10) throw Error('Referência fixa inválida.');
    } else if (ref.kind!=='previous_day' || ref.priceCents!==undefined) throw Error('Tipo de referência inválido.');
    return {query,reference:{...ref}};
  });
  return {version:2,routes,dropBps:raw.dropBps};
}
const alertEnvelope = (lines, deliver = true) => {
  const text = lines.join('\n');
  // The short summary never truncates a number. Details stay in the app.
  const compact = oneLine(text);
  return {type:'flight-monitor-v1', text, templateText:compact.length<=900 ? compact
    : oneLine(lines.filter(l=>!l.startsWith('Conferir:')).join(' ')) + ` Relatório completo no app ${hostDaMarca()}.`, deliver};
};
async function executeFlightAlerts({config,userId,routineId,tz,now}, deps) {
  const c=normalizeFlightAlerts(config),today=localFlightDay(now,tz),started=new Date(now).getTime();
  if (c.routes.some(r=>r.query.data_ida<today)) return alertEnvelope(['Monitoramento não executado: há data de viagem no passado. Confirme as datas antes de ativar.']);
  const prepared=[];
  try {
    // Preflight de armazenamento completo antes de consultar/cobrar qualquer rota.
    for (const r of c.routes) {
      const key=flightAlertQueryKey(r.query);
      const prev=await deps.readPrevious({userId,routineId,key,day:previousFlightDay(today),tz});
      prepared.push({...r,key,prev});
    }
  } catch { return alertEnvelope(['Monitoramento não executado: histórico indisponível. Não consultei preços nem confirmei ausência de oportunidades.']); }
  const lines=[`Monitor de passagens: alerta somente para queda MAIOR que ${c.dropBps/100}%.`];
  let hasAlert=false,hasError=false;
  const short=[`Passagens: alerta se queda > ${c.dropBps/100}%.`];
  for (const r of prepared) {
    const q=r.query,label=`${q.origem}–${q.destino} (${q.data_ida}${q.data_volta?' a '+q.data_volta:''})`;
    lines.push(`${label}: filtros ${q.adultos} adulto(s), ${q.criancas} criança(s), ${q.classe}, escalas ${q.paradas}, companhias ${q.companhias?.join(', ') || 'sem restrição'}.`);
    const brief=`${q.origem}–${q.destino}`;
    let quote=null;
    try { quote=await deps.search(q,{fresh:true}); } catch { /* limitations below */ }
    const cents=flightPriceCents(quote?.price),stamp=new Date(quote?.observedAt).getTime();
    // Cache never fires the alert. freshRequested should come from the
    // adapter, not from the LLM.
    const valid=!!quote && cents!==null && quote.currency==='BRL' && quote.freshRequested===true && quote.fromCache===false && quote.stale===false
      && Number.isFinite(stamp) && stamp>=started-1000 && stamp<=new Date(deps.now?deps.now():Date.now()).getTime()
      && localFlightDay(quote.observedAt,tz)===today;
    if (!valid) {hasError=true;short.push(`${brief}: cotação indisponível.`);lines.push(`${label}: sem cotação nova válida; não concluí ausência de oportunidade.`);continue;}
    let refCents=r.reference.kind==='fixed'?r.reference.priceCents:null;
    if (r.reference.kind==='previous_day') {
      // Malformed/old history counts as no reference, never an alert.
      try {
        if (['down','up','equal'].includes(flightComparison(quote,r.prev,{key:r.key,today,tz}).state)) refCents=flightPriceCents(Number(r.prev.price));
      } catch { /* invalid reference */ }
    }
    try {await deps.record({userId,routineId,key:r.key,day:today,query:q,quote,tz});}
    catch {hasError=true;short.push(`${brief}: histórico não gravado.`);lines.push(`${label}: falha ao guardar histórico; não refarei a busca/envio nesta execução.`);}
    if (refCents===null) {hasError=true;short.push(`${brief}: ${money(cents/100)}, sem referência.`);lines.push(`${label}: cotação ${money(cents/100)}, sem referência comparável de ontem; não calculei desconto.`);continue;}
    const drop=percentageDrop(cents,refCents,c.dropBps);hasAlert ||= drop.triggered;
    const delta=Math.abs(drop.percent).toFixed(4).replace('.',',');
    const change=drop.differenceCents>0?`queda de ${money(drop.differenceCents/100)} (aprox. ${delta}%)`:drop.differenceCents<0?`alta de ${money(-drop.differenceCents/100)} (aprox. ${delta}%)`:'preço igual';
    const verdict=drop.triggered?'ALERTA acionado.':'Limiar não ultrapassado.';
    lines.push(`${label}: ${money(cents/100)}; referência ${r.reference.kind==='fixed'?'fixa confirmada':'de ontem'} ${money(refCents/100)}; ${change}. ${verdict} Comparação sem arredondar o percentual. Consulta ${new Date(stamp).toISOString()}.`);
    short.push(`${brief}: ${money(cents/100)}, ref. ${r.reference.kind==='fixed'?'fixa':'ontem'} ${money(refCents/100)}; ${change}. ${drop.triggered?'ALERTA.':'Sem alerta.'}`);
    // Doesn't invent a per-person/group unit or use the price as a purchase
    // guarantee.
    if (drop.triggered) {const link=safeLink(quote.link);if(link && link.length<=350)lines.push(`Conferir: ${link}`);}
  }
  lines.push('Valores da fonte para os passageiros/filtros configurados; não é confirmação de disponibilidade ou total de compra.');
  if (!hasAlert&&!hasError) lines.push('Nenhuma condição acionada; nenhuma mensagem será enviada.');
  const result=alertEnvelope(lines,hasAlert||hasError);
  if (result.templateText.length>900) {
    // Lean deterministic summary, without truncating data; full list in the
    // app.
    result.templateText=oneLine([...short,`Preço da fonte, sem garantia de disponibilidade/total. Filtros, datas e links no app ${hostDaMarca()}.`].join(' '));
    if (result.templateText.length>900) throw Error('Resumo de alerta excede o limite seguro do template.');
  }
  return result;
}
