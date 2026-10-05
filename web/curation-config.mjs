// Shared conversational/API contract. No account IDs, network or writes.
import { normalizeCurationConfig } from './curation-runtime.mjs';
export const curationToolSchema = {
 type:'object', additionalProperties:false,
 properties:{
  source:{type:'string',enum:['web','gmail'],description:'Fonte pedida: web pública ou e-mails/newsletters do Gmail conectado. Não substituir uma pela outra.'},
  sections:{type:'array',minItems:1,maxItems:8,items:{type:'object',additionalProperties:false,properties:{
   id:{type:'string'},label:{type:'string'},min:{type:'integer',minimum:0,maximum:8},max:{type:'integer',minimum:1,maximum:8},maxAgeDays:{type:'integer',minimum:1,maximum:365}
  },required:['id','label','min','max','maxAgeDays']},description:'Critérios acordados. Sem seções pedidas, use uma só. Até N significa min=0,max=N; quantidade exata significa min=max. Soma dos máximos até8; acima disso explique o limite, nunca reduza em silêncio.'},
  summaryBullets:{type:'integer',minimum:1,maximum:3,description:'Tamanho do resumo por item acordado com o dono.'},
  includeWhy:{type:'boolean',description:'Incluir relevância/impacto somente quando solicitado.'},
  language:{type:'string',enum:['pt-BR','en','es']},
 },required:['source','sections','summaryBullets','includeWhy','language']
};
export const curationToolHelp = 'CURADORIAS de artigos/notícias/papers: use tipo="curadoria" e curadoria com os critérios do pedido, em QUALQUER conta. Pergunte só o que falta (fonte, quantidade/período, cadência/canal), aproveitando o contexto. Se sugerir valores, explicite-os na confirmação. Não imponha três seções nem temas fixos. Cada rotina tem uma fonte: web OU Gmail. Não prometa combinar ambas numa configuração que só aceita uma. Fonte Gmail não vira busca web. A plataforma já mantém o histórico dos links entregues e remove repetições; isso não depende da memória da conversa. Resumos de agenda/pendências, orações, preços e monitores checar_monitor NÃO são curadorias. Ao alterar conteúdo de curadoria existente, passe o pedido completo em o_que_fazer e os critérios completos atualizados; listar_rotinas mostra os atuais. Não crie outra rotina nem peça ao dono para ativar proteção/skill.';
export function looksLikeCuration(prompt='') {
 const s=String(prompt).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 if(/checar_monitor|triagem|pendencias|ignore newsletters|ignorar newsletters/.test(s)) return false;
 return /curadoria|curation|curacion|(?:resumo|selecao|resumen|digest|summary|seleccion).{0,100}(?:noticias|news|artigos|articles|papers|boletins)|(?:artigos|articles|papers).{0,80}(?:recentes|recent|novos|new|semana)/s.test(s);
}
export function prepareCurationChange(current, {tipo,curadoria,prompt,channel}={}) {
 const old=current?.config||{};
 const typed=Object.hasOwn(old,'curation');
 if(tipo!==undefined&&!['geral','curadoria','busca_email'].includes(tipo))throw Error('Tipo de rotina inválido.');
 if(tipo==='busca_email'&&typed)throw Error('Esta rotina é uma curadoria; não vira busca de e-mail nesta edição.');
 if(tipo==='geral'&&typed)throw Error('Esta rotina é uma curadoria. Edite seus critérios; não desative as verificações.');
 if(curadoria!==undefined&&tipo==='geral')throw Error('Curadoria não pode ser salva como rotina geral.');
 if(curadoria!==undefined&&tipo==='busca_email')throw Error('Passe curadoria OU busca_email, não os dois.');
 if(old.flight_monitor&&(curadoria!==undefined||tipo==='curadoria'))throw Error('Monitor de voos não pode virar curadoria nesta edição.');
 if(curadoria===undefined){
  if((typed&&prompt!==undefined&&prompt!==current.prompt)||tipo==='curadoria'||(!typed&&tipo!=='busca_email'&&looksLikeCuration(prompt)))throw Error('Faltam os critérios da curadoria. Complete curadoria com fonte, quantidade/período e formato acordados antes de pedir confirmação.');
  if(typed&&!['email','whatsapp','telegram','none','app'].includes(channel??current.channel))throw Error('Canal de curadoria inválido.');
  return undefined;
 }
 if(!curadoria||Object.keys(curadoria).some(k=>!Object.hasOwn(curationToolSchema.properties,k))||curationToolSchema.required.some(k=>!Object.hasOwn(curadoria,k)))throw Error('Critérios de curadoria incompletos ou inválidos.');
 if(typeof prompt!=='string'||!prompt.trim())throw Error('Inclua o pedido completo junto com os critérios da curadoria.');
 if(!['email','whatsapp','telegram','none','app'].includes(channel??current?.channel))throw Error('Confirme onde entregar a curadoria (e-mail, WhatsApp, Telegram ou app).');
 const c=normalizeCurationConfig({...curadoria,version:2,excludeUrls:old.curation?.excludeUrls||[]});
 return {...old,curation:c};
}
export function describeCuration(c) {
 const n=normalizeCurationConfig(c);
 return `${n.source==='gmail'?'Fontes: e-mails/newsletters do Gmail':'Fontes: web'}; ${n.sections.map(s=>`${s.label}: ${s.min===s.max?s.max:s.min+'–'+s.max} ${s.max===1?'item':'itens'}, últimos ${s.maxAgeDays} dias`).join('; ')}; ${n.summaryBullets||3} ${(n.summaryBullets||3)===1?'tópico':'tópicos'} por resumo${n.includeWhy===false?'':', com relevância/impacto'}. Links já entregues não se repetem; limitações são informadas. O período considera a ${n.source==='gmail'?'data de recebimento dos e-mails':'data de publicação das fontes'}.`;
}

export function editableCuration(c) {
 const n=normalizeCurationConfig(c);
 return {source:n.source||'web',sections:n.sections,summaryBullets:n.summaryBullets||3,includeWhy:n.includeWhy!==false,language:n.language||'pt-BR'};
}
// Strictly read-only tools during research, including curations delivered only in app.
export function pruneCurationTools(registry,source) {
 const allowed=new Set(source==='gmail'?['google','memoria_ler']:['buscar_web','abrir_link','memoria_ler']);
 for(const name of registry.map.keys())if(!allowed.has(name))registry.map.delete(name);
}
