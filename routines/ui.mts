type Locale = 'pt-BR'|'en'|'es';
export type Routine = {id:string;agent_id:string;agent_name:string;title:string;prompt:string;hour:number;minute?:number;days:string;tz:string;channel:string;enabled:boolean;repeat_every_min?:number|null;repeat_until?:string|null;last_run_day?:string|null;config?:Record<string,unknown>};
type Agent={id:string;name:string};
type Reply={error?:string;netFail?:boolean;routines?:Routine[]};
type Dependencies={api:(path:string,body?:Record<string,unknown>)=>Promise<Reply>;agents:()=>Agent[];activeAgent:()=>string|null;openDraft:(agentId:string,text:string)=>Promise<boolean>;locale?:string;marca:string};
const PT={title:'Suas rotinas',intro:'Tarefas que seus assistentes executam nos horários combinados. As mesmas rotinas do aplicativo.',new:'Nova rotina',refresh:'Atualizar',agent:'Assistente para a nova rotina',none:'Crie um assistente antes de adicionar uma rotina.',loading:'Carregando rotinas…',empty:'Você ainda não tem rotinas. Combine a primeira com seu assistente.',failed:'Não foi possível carregar as rotinas. Tente atualizar.',active:'Ativa',paused:'Pausada',expired:'Prazo encerrado',pause:'Pausar',resume:'Retomar',edit:'Editar na conversa',remove:'Excluir',cancel:'Cancelar',details:'Ver instruções',cadence:'Frequência',channel:'Entrega',owner:'Assistente',last:'Última execução registrada',until:'até',daily:'Todos os dias',weekdays:'Segunda a sexta',weekends:'Sábado e domingo',month:'Dias do mês',lastday:'último dia',nth:'Ocorrência no mês',every:'A cada',minutes:'minutos',unknown:'Cadência a revisar',app:'Somente no app',save:'Salvando…',saved:'Rotina atualizada.',deleted:'Rotina excluída.',error:'A alteração não foi confirmada. Atualize a lista antes de tentar novamente.',deleteWarn:'A rotina será excluída, não apenas pausada. O histórico de controle vinculado a ela também pode ser removido.',pauseWarn:'As próximas execuções serão pausadas. Uma execução que já começou pode terminar.',resumeWarn:'A rotina voltará a executar nos horários combinados. Esta ação não dispara uma execução agora.',createDraft:'Quero criar uma rotina. Me ajude a combinar a tarefa, a frequência, o horário e onde receber o resultado.',editDraft:'Quero editar minha rotina',editHint:'Ajuste a rotina existente, sem cancelar e recriar. O que quero mudar: ',prepare:'A proposta ficará na conversa para você revisar e enviar. Nenhuma rotina será criada automaticamente.',missing:'O assistente desta rotina não está disponível. Atualize a página.',unsent:'Nada foi enviado. Revise o pedido na conversa.',timezone:'fuso',stale:'Não foi possível confirmar o estado atual. Atualize a lista.',retry:'Tentar novamente'};
const EN:typeof PT={title:'Your routines',intro:'Tasks your assistants run at the agreed times. The same routines as in the app.',new:'New routine',refresh:'Refresh',agent:'Assistant for the new routine',none:'Create an assistant before adding a routine.',loading:'Loading routines…',empty:'You have no routines yet. Plan your first one with your assistant.',failed:'Could not load routines. Please refresh.',active:'Active',paused:'Paused',expired:'Schedule ended',pause:'Pause',resume:'Resume',edit:'Edit in chat',remove:'Delete',cancel:'Cancel',details:'View instructions',cadence:'Schedule',channel:'Delivery',owner:'Assistant',last:'Last recorded run',until:'until',daily:'Every day',weekdays:'Monday to Friday',weekends:'Saturday and Sunday',month:'Days of the month',lastday:'last day',nth:'Occurrence in month',every:'Every',minutes:'minutes',unknown:'Schedule needs review',app:'In-app only',save:'Saving…',saved:'Routine updated.',deleted:'Routine deleted.',error:'The change was not confirmed. Refresh before retrying.',deleteWarn:'The routine will be deleted, not just paused. Its associated tracking history may also be removed.',pauseWarn:'Future runs will be paused. A run already in progress may still finish.',resumeWarn:'The routine will resume its scheduled runs. This does not run it immediately.',createDraft:'I want to create a routine. Help me agree on the task, frequency, time and delivery channel.',editDraft:'I want to edit my routine',editHint:'Update the existing routine without deleting and recreating it. What I want to change: ',prepare:'The request will be drafted in chat for you to review and send. No routine is created automatically.',missing:'This routine’s assistant is unavailable. Please refresh the page.',unsent:'Nothing was sent. Review the request in chat.',timezone:'timezone',stale:'Could not confirm the current state. Refresh the list.',retry:'Try again'};
const ES:typeof PT={title:'Tus rutinas',intro:'Tareas que tus asistentes ejecutan en los horarios acordados. Las mismas rutinas de la aplicación.',new:'Nueva rutina',refresh:'Actualizar',agent:'Asistente para la nueva rutina',none:'Crea un asistente antes de agregar una rutina.',loading:'Cargando rutinas…',empty:'Aún no tienes rutinas. Acuerda la primera con tu asistente.',failed:'No se pudieron cargar las rutinas. Intenta actualizar.',active:'Activa',paused:'Pausada',expired:'Plazo finalizado',pause:'Pausar',resume:'Reanudar',edit:'Editar en la conversación',remove:'Eliminar',cancel:'Cancelar',details:'Ver instrucciones',cadence:'Frecuencia',channel:'Entrega',owner:'Asistente',last:'Última ejecución registrada',until:'hasta',daily:'Todos los días',weekdays:'Lunes a viernes',weekends:'Sábado y domingo',month:'Días del mes',lastday:'último día',nth:'Ocurrencia en el mes',every:'Cada',minutes:'minutos',unknown:'Revisar frecuencia',app:'Solo en la app',save:'Guardando…',saved:'Rutina actualizada.',deleted:'Rutina eliminada.',error:'No se confirmó el cambio. Actualiza antes de volver a intentarlo.',deleteWarn:'Se eliminará la rutina, no solo se pausará. También se puede eliminar su historial de control asociado.',pauseWarn:'Se pausarán las próximas ejecuciones. Una ejecución iniciada puede terminar.',resumeWarn:'Se reanudarán las ejecuciones programadas. Esta acción no ejecuta la rutina ahora.',createDraft:'Quiero crear una rutina. Ayúdame a acordar la tarea, frecuencia, horario y canal de entrega.',editDraft:'Quiero editar mi rutina',editHint:'Actualiza la rutina existente, sin eliminarla y volver a crearla. Qué quiero cambiar: ',prepare:'La propuesta quedará en la conversación para revisar y enviar. No se crea ninguna rutina automáticamente.',missing:'El asistente de esta rutina no está disponible. Actualiza la página.',unsent:'No se envió nada. Revisa la propuesta en la conversación.',timezone:'zona horaria',stale:'No se pudo confirmar el estado actual. Actualiza la lista.',retry:'Reintentar'};
function language(value='pt-BR'):Locale{return value.startsWith('en')?'en':value.startsWith('es')?'es':'pt-BR';}
function words(locale:Locale){return locale==='en'?EN:locale==='es'?ES:PT;}
function dateLabel(value:string,locale:Locale,tz='UTC'){try{return new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeZone:tz}).format(new Date(value));}catch{return value;}}
export function cadence(r:Routine,locale:Locale='pt-BR'):string {
 const t=words(locale);let text=t.unknown;
 if(r.repeat_every_min&&r.repeat_every_min>0)text=`${t.every} ${r.repeat_every_min} ${t.minutes}`;
 else {
  const names=Array.from({length:7},(_,i)=>new Intl.DateTimeFormat(locale,{weekday:'long',timeZone:'UTC'}).format(new Date(Date.UTC(2026,0,4+i))));
  let d:unknown=r.days;try{if(/^[\[{]/.test(r.days))d=JSON.parse(r.days);}catch{/* show unknown, never invent daily */}
  if(d==='daily')text=t.daily;else if(d==='weekdays')text=t.weekdays;else if(d==='weekends')text=t.weekends;
  else if(Array.isArray(d)&&d.length&&d.every(n=>Number.isInteger(n)&&n>=0&&n<=6))text=d.map(n=>names[n]).join(', ');
  else if(d&&typeof d==='object'){
   const obj=d as {mes?:unknown;nth?:number;dow?:unknown};
   if(Array.isArray(obj.mes)&&obj.mes.length&&obj.mes.every(n=>Number.isInteger(n)&&(n===-1||n>=1&&n<=31)))text=`${t.month}: ${obj.mes.map(n=>n===-1?t.lastday:n).join(', ')}`;
   else if((obj.nth===-1||Number.isInteger(obj.nth)&&Number(obj.nth)>=1&&Number(obj.nth)<=5)&&Array.isArray(obj.dow)&&obj.dow.length&&obj.dow.every(n=>Number.isInteger(n)&&n>=0&&n<=6))text=`${t.nth}: ${obj.nth===-1?t.lastday:obj.nth} — ${obj.dow.map(n=>names[n]).join(', ')}`;
  }
  if(Number.isInteger(r.hour)&&r.hour>=0&&r.hour<=23)text+=` · ${String(r.hour).padStart(2,'0')}:${String(r.minute||0).padStart(2,'0')}`;
 }
 if(r.tz)text+=` (${r.tz})`;
 if(r.repeat_until)text+=` · ${t.until} ${dateLabel(r.repeat_until,locale,r.tz||'UTC')}`;
 return text;
}
function el<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,className?:string):HTMLElementTagNameMap[K]{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;}
function button(text:string,action:()=>void){const b=el('button',text,'routine-button');b.type='button';b.addEventListener('click',action);return b;}
function expected(r:Routine){return {title:r.title,prompt:r.prompt,channel:r.channel,hour:r.hour,minute:r.minute,days:r.days,tz:r.tz,enabled:r.enabled,config:r.config||{},repeat_every_min:r.repeat_every_min??null,repeat_until:r.repeat_until??null};}
export function mountRoutines(root:HTMLElement,deps:Dependencies){
 const locale=language(deps.locale),t=words(locale);let busy=false,generation=0,chosen='';
 root.classList.add('routine-manager');root.replaceChildren();
 const header=el('div',undefined,'routine-heading'),heading=el('h2',t.title);heading.id='routine-title';root.setAttribute('aria-labelledby',heading.id);
 const refresh=button(t.refresh,()=>{void load();});header.append(heading,refresh);root.append(header,el('p',t.intro,'routine-intro'));
 const controls=el('div',undefined,'routine-create'),label=el('label',t.agent),select=el('select');select.id='routine-agent';label.htmlFor=select.id;
 const create=button(t.new,()=>{void draft();});create.classList.add('routine-main');controls.append(label,select,create);root.append(controls,el('p',t.prepare,'routine-note'));
 const status=el('p','','routine-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 const list=el('div',undefined,'routine-list');root.append(status,list);
 function state(on:boolean){busy=on;root.setAttribute('aria-busy',String(on));root.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=on||b.dataset.locked==='true');select.disabled=on;}
 function message(text:string,error=false){status.textContent=text;status.classList.toggle('routine-error',error);status.setAttribute('role',error?'alert':'status');}
 function populateAgents(){const agents=deps.agents();chosen=select.value||chosen||deps.activeAgent()||agents[0]?.id||'';select.replaceChildren();for(const a of agents){const o=el('option',a.name);o.value=a.id;select.append(o);}select.value=agents.some(a=>a.id===chosen)?chosen:agents[0]?.id||'';create.dataset.locked=String(!agents.length);if(!agents.length)message(t.none);}
 async function draft(r?:Routine,review=false){
  if(busy)return;const id=r?.agent_id||select.value;
  if(!deps.agents().some(a=>a.id===id)){message(t.missing,true);return;}
  const text=review&&r?`${locale==='en'?'Review the last failed execution of my routine':locale==='es'?'Revisa la última ejecución fallida de mi rutina':'Revise a última execução com problema da minha rotina'} “${r.title}”. ${locale==='en'?'Check what actually happened before proposing another attempt. Do not repeat actions or sends without my confirmation.':locale==='es'?'Verifica qué ocurrió antes de proponer otro intento. No repitas acciones ni envíos sin mi confirmación.':'Confira o que realmente aconteceu antes de propor nova tentativa. Não repita ações ou envios sem minha confirmação.'}`:r?`${t.editDraft} “${r.title}” (${cadence(r,locale)}). ${t.editHint}`:t.createDraft;
  state(true);try{if(await deps.openDraft(id,text))message(t.unsent);}catch{message(t.error,true);}finally{state(false);}
 }
 async function confirm(r:Routine,action:'pause'|'resume'|'delete'){
  const caption=action==='delete'?t.remove:action==='pause'?t.pause:t.resume;
  const dialog=el('dialog',undefined,'routine-dialog');dialog.setAttribute('aria-labelledby','routine-confirm-title');dialog.setAttribute('aria-describedby','routine-confirm-body');
  const title=el('h3',`${caption}: ${r.title}`);title.id='routine-confirm-title';const body=el('p',action==='delete'?t.deleteWarn:action==='pause'?t.pauseWarn:t.resumeWarn);body.id='routine-confirm-body';
  const buttons=el('div',undefined,'routine-actions');const cancel=button(t.cancel,()=>dialog.close('cancel')),accept=button(caption,()=>dialog.close('ok'));if(action==='delete')accept.classList.add('routine-danger');buttons.append(cancel,accept);dialog.append(title,body,buttons);document.body.append(dialog);
  const focus=document.activeElement;
  return new Promise<boolean>(resolve=>{dialog.addEventListener('close',()=>{const approved=dialog.returnValue==='ok';dialog.remove();if(focus instanceof HTMLElement&&focus.isConnected)focus.focus();resolve(approved);},{once:true});dialog.showModal();cancel.focus();});
 }
 async function change(r:Routine,action:'pause'|'resume'|'delete'){
  if(busy)return;state(true);
  try{
   if(!await confirm(r,action))return;
   message(t.save);
   const response=await deps.api(action==='delete'?'api/routine/delete':'api/routine/update',{id:r.id,expected:expected(r),...(action==='delete'?{}:{enabled:action==='resume'})});
   if(response.error||response.netFail){list.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.dataset.locked='true');message(`${response.error||t.error} ${t.stale}`,true);return;}
   await load(action==='delete'?t.deleted:t.saved);
  }catch{message(t.error,true);}finally{state(false);}
 }
 function render(routines:Routine[]){
  list.replaceChildren();if(!routines.length){list.append(el('p',t.empty,'routine-empty'));return;}
  for(const r of routines){
   const expired=!!r.repeat_until&&Number.isFinite(Date.parse(r.repeat_until))&&Date.parse(r.repeat_until)<=Date.now();
   const card=el('article',undefined,'routine-card');const top=el('div',undefined,'routine-card-heading');const title=el('h3',r.title);const badge=el('span',expired?t.expired:r.enabled?t.active:t.paused,`routine-badge ${r.enabled&&!expired?'is-active':'is-paused'}`);top.append(title,badge);
   const meta=el('dl',undefined,'routine-meta');const pair=(name:string,value:string)=>{meta.append(el('dt',name),el('dd',value));};pair(t.owner,r.agent_name||'—');pair(t.cadence,cadence(r,locale));pair(t.channel,({none:t.app,app:t.app,email:locale==='en'?`E-mail via ${deps.marca} (not Gmail)`:locale==='es'?`E-mail mediante ${deps.marca} (no Gmail)`:`E-mail pela plataforma ${deps.marca} (não usa Gmail)`,whatsapp:'WhatsApp',telegram:'Telegram'} as Record<string,string>)[r.channel]||r.channel||t.app);
   if(r.last_run_day)pair(t.last,dateLabel(r.last_run_day,locale));
   const health=routineHealth(r,locale);
   if(health)pair(locale==='en'?'Last attempt':locale==='es'?'Último intento':'Última tentativa',health.label);
   const details=el('details');details.append(el('summary',t.details),el('p',r.prompt,'routine-prompt'));
   // Rotina tipada "busca_email": mostra a consulta que a plataforma executa
   // (dado do servidor, texto puro). Mantida na fonte TS para o build não apagar
   // o detalhe que já existe no bundle publicado.
   const es=r.config?.email_search as {provider?:string;account?:string;terms?:string[];senders?:string[];days?:number;unreadOnly?:boolean;withAttachment?:boolean}|undefined;
   if(es&&typeof es==='object'){
    const label=locale==='en'?'E-mail search run by the platform':locale==='es'?'Búsqueda de correo ejecutada por la plataforma':'Busca de e-mail executada pela plataforma';
    const parts=[es.provider==='outlook'?'Outlook':'Gmail'+(es.account?` (${es.account})`:'')];
    if(Array.isArray(es.terms)&&es.terms.length)parts.push(es.terms.join(' | '));
    if(Array.isArray(es.senders)&&es.senders.length)parts.push((locale==='en'?'from: ':locale==='es'?'de: ':'de: ')+es.senders.join(' | '));
    parts.push(locale==='en'?`last ${es.days} day${es.days===1?'':'s'}`:locale==='es'?`últimos ${es.days} día${es.days===1?'':'s'}`:`últimos ${es.days} dia${es.days===1?'':'s'}`);
    if(es.unreadOnly)parts.push(locale==='en'?'unread only':locale==='es'?'solo no leídos':'só não lidos');
    if(es.withAttachment)parts.push(locale==='en'?'with attachment':locale==='es'?'con adjunto':'só com anexo');
    details.append(el('p',`${label}: ${parts.join(' · ')}`,'routine-prompt'));
   }
   const actions=el('div',undefined,'routine-actions');const toggle=button(r.enabled?t.pause:t.resume,()=>{void change(r,r.enabled?'pause':'resume');});
   if(expired&&!r.enabled){toggle.dataset.locked='true';toggle.title=t.expired;toggle.disabled=true;}
   const edit=button(t.edit,()=>{void draft(r);});const remove=button(t.remove,()=>{void change(r,'delete');});remove.classList.add('routine-danger');
   for(const b of [toggle,edit,remove])b.setAttribute('aria-label',`${b.textContent}: ${r.title}`);
   actions.append(toggle,edit,remove);
   if(health?.needsReview){const review=button(locale==='en'?'Review failure in chat':locale==='es'?'Revisar fallo en la conversación':'Revisar falha na conversa',()=>{void draft(r,true);});actions.append(review);}card.append(top,meta,details,actions);list.append(card);
  }
 }
 async function load(notice=''){
  const seq=++generation;state(true);list.replaceChildren();populateAgents();message(t.loading);
  try{const response=await deps.api('api/routines');if(seq!==generation)return;
   if(response.error||!Array.isArray(response.routines))throw Error(t.failed);
   if(response.routines.some(r=>!r||typeof r.id!=='string'||typeof r.title!=='string'||typeof r.agent_id!=='string'||typeof r.enabled!=='boolean'))throw Error(t.failed);
   render(response.routines);message(notice||(!deps.agents().length?t.none:''));
  }catch{if(seq===generation)message(t.failed,true);}finally{if(seq===generation)state(false);}
 }
 return {load};
}

export function routineHealth(r:Routine,locale:Locale='pt-BR'):{label:string;needsReview:boolean}|null {
 const e=r.config?.execution as {status?:string;leaseUntil?:string;content?:{status?:string};delivery?:{status?:string;channel?:string;notification?:{status?:string;channel?:string}}}|undefined;
 if(!e?.status)return null;
 let status=e.status;if(status==='running'&&e.leaseUntil&&Date.parse(e.leaseUntil)<Date.now())status='interrupted';
 if(e.content?.status||e.delivery?.status){
  const content:Record<Locale,Record<string,string>>={
   'pt-BR':{complete:'completo',partial:'parcial',no_output:'sem conteúdo',failed:'falhou',unknown:'não determinado'},
   en:{complete:'complete',partial:'partial',no_output:'no content',failed:'failed',unknown:'undetermined'},
   es:{complete:'completo',partial:'parcial',no_output:'sin contenido',failed:'falló',unknown:'no determinado'},
  };
  const delivery:Record<Locale,Record<string,string>>={
   'pt-BR':{accepted:'aceita pela plataforma; não confirma leitura',saved:'salva no app',not_attempted:'não tentada',failed:'falhou',uncertain:'incerta',unknown:'não registrada separadamente'},
   en:{accepted:'accepted by the platform; not a read receipt',saved:'saved in the app',not_attempted:'not attempted',failed:'failed',uncertain:'uncertain',unknown:'not recorded separately'},
   es:{accepted:'aceptada por la plataforma; no confirma lectura',saved:'guardada en la aplicación',not_attempted:'no intentada',failed:'falló',uncertain:'incierta',unknown:'no registrada por separado'},
  };
  const c=e.content?.status||'unknown',d=e.delivery?.status||'unknown';
  const prefix=locale==='en'?['Content','Delivery']:locale==='es'?['Contenido','Entrega']:['Conteúdo','Entrega'];
  const notification=e.delivery?.notification;
  const notice=notification&&['email','telegram','whatsapp'].includes(notification.channel||'')&&['failed','uncertain'].includes(notification.status||'')?notification:null;
  const noticeLabel=notice?(locale==='en'?`Additional notice on ${notice.channel}: ${notice.status==='failed'?'failed':'unconfirmed'}`:locale==='es'?`Aviso adicional en ${notice.channel}: ${notice.status==='failed'?'falló':'sin confirmar'}`:`Aviso adicional no ${notice.channel}: ${notice.status==='failed'?'falhou':'não confirmado'}`):'';
  const channel=e.delivery?.channel&&['email','telegram','whatsapp','app'].includes(e.delivery.channel)?` (${e.delivery.channel})`:'';
  return {label:`${prefix[0]}: ${content[locale][c]||content[locale].unknown} · ${prefix[1]}: ${delivery[locale][d]||delivery[locale].unknown}${channel}${noticeLabel?' · '+noticeLabel:''}`,needsReview:!!notice||['partial','failed','unknown'].includes(c)||['failed','uncertain','unknown'].includes(d)};
 }
 const labels:Record<Locale,Record<string,string>>={
  'pt-BR':{running:'Em andamento',completed:'Processamento concluído — não é confirmação de leitura da entrega',partial:'Conteúdo parcial — revise as limitações',no_output:'Terminou sem conteúdo para entregar',failed:'Conteúdo falhou; a entrega não foi registrada separadamente nesta tentativa antiga',uncertain:'Entrega não confirmada — pode ter ocorrido; não repetir sem conferir',interrupted:'Execução interrompida ou sem confirmação — revise antes de repetir'},
  en:{running:'In progress',completed:'Processing completed — not a read receipt',partial:'Partial content — review the limitations',no_output:'Finished without content to deliver',failed:'Content failed; delivery was not recorded separately for this older run',uncertain:'Delivery unconfirmed — it may have occurred; verify before retrying',interrupted:'Interrupted or unconfirmed execution — review before retrying'},
  es:{running:'En curso',completed:'Procesamiento finalizado — no es confirmación de lectura',partial:'Contenido parcial — revisa las limitaciones',no_output:'Terminó sin contenido para entregar',failed:'El contenido falló; la entrega no se registró por separado en esta ejecución anterior',uncertain:'Entrega no confirmada — puede haber ocurrido; verificar antes de repetir',interrupted:'Ejecución interrumpida o no confirmada — revisar antes de repetir'}
 };
 return {label:labels[locale][status]||({ 'pt-BR':'Estado não confirmado',en:'Unconfirmed status',es:'Estado no confirmado'})[locale],needsReview:['partial','failed','uncertain','interrupted'].includes(status)};
}
