import { actionResult } from './web/action-evidence.mjs';
import { reminderChannelSelection } from './web/reminder-channel.mjs';
import { recurrenceSchema, recurrenceOccurrences, recurrenceLabel } from './web/calendar-recurrence.mjs';
// Dry-run local: relógio, registros e entregas simulados. Zero canais/BD reais.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const forbidden=()=>{throw Error('REAL I/O FORBIDDEN');};
net.Socket.prototype.connect=forbidden;tls.connect=forbidden;globalThis.fetch=forbidden;
for(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])childProcess[n]=forbidden;
syncBuiltinESMExports();
const {routineExecutionFrame,routineReminderDeliveryConflict,ROUTINE_REMINDER_CONFLICT}=await import('./web/routine-delivery.mjs');
const {runAgent,ToolRegistry}=await import('./core-proto/core.mjs');
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};const ok=a=>{assert.ok(a);checks++;};
let clock=Date.parse('2026-09-10T11:09:15Z');const RealDate=Date;
globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}};
const source=readFileSync(new URL('./web/server.mjs',import.meta.url),'utf8');
function extract(name){const a=source.indexOf('function '+name+'('),b=source.indexOf('\n}\n',a)+2;assert.ok(a>=0&&b>a);return source.slice(a,b);}
const resolveReminderWhen=new Function(extract('resolveReminderWhen')+'; return resolveReminderWhen;')();
// Extrai a implementação REAL de criar_lembrete, sem importar servidor.
const a=source.indexOf("    name: 'criar_lembrete'"),b=source.indexOf('\n  });',a);
const literal='{'+source.slice(a,b)+'\n}';
let writes=[],registryReads=0;
function reminder({kind='routine',channel='whatsapp',tz='America/Sao_Paulo',stored=null}={}){
 const deps={actionResult,reminderChannelSelection,recurrenceSchema,recurrenceOccurrences,recurrenceLabel,kind,routineChannel:channel,userTz:tz,userId:'mock-user',agent:{id:'mock-agent'},thread:{id:'mock-thread'},randomUUID:()=> 'mock-action',
 routineReminderDeliveryConflict,ROUTINE_REMINDER_CONFLICT,resolveReminderWhen,
 setUserTimezone:async(u,f)=>{writes.push(['tz',u,f]);return f;},
 getTelegramBotForDelivery:async()=>{registryReads++;return {chat_id:'mock'};},waEnabled:()=>true,getWhatsAppLinkForUser:async()=>{registryReads++;return {wa_phone:'mock',enabled:true};},
 mailEnabled:()=>true,getUserById:async()=>({email:'mock@example.invalid'}),
 parseRecurrence:args=>args.repetirCadaMin?{stepMin:args.repetirCadaMin,untilIso:args.repetirAte||null}:null,
 createReminder:async row=>{writes.push(['reminder',row]);return {id:'mock',status:'pending',run_at:row.runAt,channel:row.channel,repeat_every_min:row.repeatEveryMin,repeat_until:row.repeatUntil,...(stored||{})};},intervalLabel:n=>String(n),};
 return new Function(...Object.keys(deps),'return '+literal)(...Object.values(deps));
}
for(const channel of ['whatsapp','telegram','email']){
 const frame=routineExecutionFrame({kind:'routine',title:'Teste',channel});ok(frame.includes('ENTREGA AUTOMÁTICA'));ok(frame.includes('Não diga'));ok(frame.includes('próximos dias/horários'));ok(frame.includes('criar_lembrete'));ok(frame.includes('boa noite depois')&&frame.includes('nunca a de entregas anteriores'));
 const conflict=delay=>routineReminderDeliveryConflict({kind:'routine',channel,reminderChannel:channel,whenMs:clock+delay});
 for(const delay of [-60000,0,1000,45000,60000])eq(conflict(delay),true);
 for(const delay of [-60001,60001,3600000,86400000])eq(conflict(delay),false);
}
eq(routineExecutionFrame({kind:'chat',channel:'whatsapp'}),'');
for(const channel of [undefined,'none','slack'])ok(!routineExecutionFrame({kind:'routine',channel}).includes('ENTREGA AUTOMÁTICA'));
eq(routineReminderDeliveryConflict({kind:'chat',channel:'whatsapp',reminderChannel:'whatsapp',whenMs:clock}),false);
eq(routineReminderDeliveryConflict({kind:'routine',channel:'none',reminderChannel:'whatsapp',whenMs:clock}),false);
eq(routineReminderDeliveryConflict({kind:'routine',channel:'whatsapp',reminderChannel:'email',whenMs:clock}),false);
const tool=reminder();
// Caso observado: execução 08:09:15 cria outro lembrete para 08:10. Nem timezone
// nem banco/conector devem ser tocados ao recusar essa duplicação imediata.
for(const extra of [{},{canal:'whatsapp'},{canal:'WHATSAPP'}, {fuso:'America/Sao_Paulo'}, {repetir_cada_min:1440}]){
 writes=[];registryReads=0;
 eq(await tool.run({quando:'2026-09-10T08:10:00',mensagem:'Lembrete sintético',...extra}),ROUTINE_REMINDER_CONFLICT);eq(writes,[]);eq(registryReads,0);
}
// Futuro legítimo, rotina sem canal, outro canal e conversa comum conservam criação.
for(const test of [
 {opts:{},args:{quando:'2026-09-11T08:00:00',repetir_cada_min:1440}},
 {opts:{channel:'none'},args:{quando:'2026-09-10T08:10:00',canal:'whatsapp'}},
 {opts:{},args:{quando:'2026-09-10T08:10:00',canal:'email'}},
 {opts:{kind:'whatsapp'},args:{quando:'2026-09-10T08:10:00',canal:'whatsapp'}},
 ]){
 writes=[];const out=await reminder(test.opts).run({mensagem:'Futuro sintético',...test.args});ok(out.includes('agendado'));eq(writes.filter(x=>x[0]==='reminder').length,1);
 const recorded=writes.find(x=>x[0]==='reminder')[1];eq(recorded.actionId,'mock-action');eq(recorded.originThreadId,'mock-thread');
 if(test.args.repetir_cada_min)eq(writes[0][1].repeatEveryMin,1440);
}
// Duplicata: a prova usa canal/recorrência já gravados, não o pedido divergente.
{writes=[];const actual=JSON.parse(await reminder({stored:{duplicate:true,channel:'email',repeat_every_min:30,repeat_until:'2026-09-12T12:00:00Z'}}).run({mensagem:'Futuro sintético',quando:'2026-09-11T08:00:00',canal:'whatsapp'}));eq(actual.action_evidence.target,'e-mail');ok(actual.action_evidence.at.includes('30'));ok(actual.text.includes('não criei outro'));eq(writes.filter(x=>x[0]==='reminder').length,1);}
// A processed/canceled row must never be presented as a newly scheduled action.
for(const status of ['sent','failed','uncertain','canceled']){
 const out=await reminder({stored:{duplicate:true,status}}).run({mensagem:'Futuro sintético',quando:'2026-09-11T08:00:00',canal:'whatsapp'});
 ok(out.includes('processado ou cancelado'));ok(!out.includes('action_evidence'));
}
// Recusa antes de gravar = { ok:false, error } (recibo 'failed'); o texto lido pelo modelo é o mesmo.
writes=[];eq(JSON.parse(await tool.run({quando:'2026-09-10T08:10:00',mensagem:'Teste',fuso:'Invalid/Zone'})),{ok:false,error:'Fuso inválido para o lembrete. Use um fuso IANA válido.'});eq(writes,[]);
// Frame realmente usado em produção; a proteção de envio direto segue intacta.
ok(source.includes('const routineFrame = routineExecutionFrame({ kind, title: routineTitle, channel: routineChannel })'));
ok(source.includes("registry.map.delete('enviar_mensagem')"));
// Scheduler REAL com batidas e relógio simulados. Nenhum timer de background.
const realSetInterval=globalThis.setInterval,realClearInterval=globalThis.clearInterval;
globalThis.setInterval=()=>({unref(){}});globalThis.clearInterval=()=>{};
const {startScheduler}=await import('./web/scheduler.mjs');
const r={id:'mock-routine',user_id:'mock-user',agent_id:'mock-agent',title:'Lembrete diário sintético',prompt:'Envie um lembrete curto.',channel:'whatsapp',enabled:true,hour:8,tz:'America/Sao_Paulo',days:'daily',last_run_day:'',email:'mock@example.invalid'};
const configBefore=JSON.stringify({...r,last_run_day:''});const deliveries=[];let runs=0;
const scheduler=startScheduler({
 listDueRoutines:async()=>[r],markRoutineRun:async(id,day)=>{eq(id,r.id);r.last_run_day=day;},
 runRoutine:async()=>{
  runs++;let step=0;const localTool=reminder();const reg=new ToolRegistry().add(localTool);
  const {text}=await runAgent({tools:reg,system:'MOCK',history:[],userInput:routineExecutionFrame({kind:'routine',channel:r.channel,title:r.title})+'\n'+r.prompt,
   provider:{name:'offline-fake',complete:async({messages})=>{
    if(++step===1)return {stop:'tool',toolCalls:[{id:'mock-call',name:'criar_lembrete',args:{quando:new Date(clock+45000).toISOString(),mensagem:'Lembrete sintético',canal:'whatsapp'}}]};
    const result=messages.findLast(m=>m.role==='tool');eq(result.content,ROUTINE_REMINDER_CONFLICT);
    return {stop:'end',text:'Lembrete sintético direto.'};
   }},maxSteps:3});
  return text;
 },
 deliver:async(row,text)=>{deliveries.push({id:row.id,text,day:new Date(clock).toISOString().slice(0,10)});},
 listDueReminders:async()=>[],markRoutineNext:forbidden,
});
writes=[];
try{
 await scheduler.tick();eq(runs,1);eq(deliveries.length,1);eq(writes,[]);
 await scheduler.tick();eq(runs,1);eq(deliveries.length,1);
 clock=Date.parse('2026-09-11T11:09:15Z');await scheduler.tick();eq(runs,2);eq(deliveries.length,2);eq(writes,[]);
 eq(deliveries.map(x=>x.day),['2026-09-10','2026-09-11']);eq(deliveries.map(x=>x.text),['Lembrete sintético direto.','Lembrete sintético direto.']);
 eq(JSON.stringify({...r,last_run_day:''}),configBefore);
}finally{scheduler.stop();globalThis.Date=RealDate;globalThis.setInterval=realSetInterval;globalThis.clearInterval=realClearInterval;}
console.log(`OK: ${checks} verificações. Scheduler/loop/tools reais com dependências simuladas: dois dias, uma entrega por dia, zero lembretes extras e zero I/O real.`);
