// Atendimento ao público no WhatsApp: quem escreve pro número sem conta vai pro
// assistente público só quando a instalação ligou; o código de conexão do número
// continua valendo antes disso; o dono vinculado nunca cai no público. Inbox real
// (PostgreSQL local) e o handler real; o turno público é falso. Mensagens picadas
// viram um turno só, e saídas ricas do plugin saem como mensagens próprias.
import test from 'node:test';
import assert from 'node:assert/strict';
import {inboxFixture,uuid} from './test-support/wa-inbox-fixture.mjs';
import {postgresSkipReason} from './test-support/local-postgres.mjs';
import {createWaInbox} from './web/whatsapp-inbox.mjs';
import {encryptSecret,decryptSecret} from './web/vault.mjs';
import {createWhatsAppHandler} from './web/whatsapp.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<500;i++){if(await fn())return;await wait(10);}throw Error('Expected state did not arrive');}
Object.assign(process.env,{WA_PHONE_NUMBER_ID:'synthetic-phone',WA_TOKEN:'synthetic',WA_DEBOUNCE_MS:'50',WA_TURN_HEARTBEAT_MS:'0',CANAL_REENVIO_MS:'0,0',WA_PUBLICO_JUNTAR_MS:'50',WA_PUBLICO_JUNTAR_MAX_MS:'2000',WA_ESPERA_ENTREGA_MS:'0'});
const payload=messages=>({entry:[{changes:[{value:{metadata:{phone_number_id:'synthetic-phone'},messages}}]}]});
const DONO='5511000000001',CLIENTE='5511000000002';
let n=0;const msg=(from,text,extra={})=>({id:'publico-'+(++n),from,type:'text',text:{body:text},...extra});

test('WhatsApp: desconhecido vai pro atendimento público só quando ligado; dono e código de conexão seguem como antes',{timeout:40000,skip:postgresSkipReason()},async t=>{
 const f=await inboxFixture();const handlers=[];t.after(async()=>{for(const h of handlers)await h.stop();await f.close();});

 const original=globalThis.fetch;const sent=[];t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,options)=>{
  assert(String(url).startsWith('https://graph.facebook.com/'),'unexpected network');
  const body=JSON.parse(options?.body||'{}');
  if(body.type==='text'){sent.push({to:body.to,text:body.text.body});return {ok:true,json:async()=>({messages:[{id:'out-'+sent.length}]})};}
  if(body.template?.name==='recusado')return {ok:false,status:400,json:async()=>({error:{message:'(#132000) recusado'}})};
  if(['image','interactive','template'].includes(body.type)){sent.push({to:body.to,[body.type]:body[body.type]});return {ok:true,json:async()=>({messages:[{id:'out-'+sent.length}]})};}
  return {ok:true,json:async()=>({success:true})};
 };
 const links=new Map([[DONO,{enabled:true,user_id:uuid(1),active_agent_id:uuid(11)}]]);
 const db={getWhatsAppLink:async from=>links.get(from)||null,listAgents:async()=>[{id:uuid(11),name:'Alpha'}],touchWaInbound:async()=>{},saveWaMsgRef:async()=>{},getWaMsgRef:async()=>null,
  consumeWaClaim:async(from,texto)=>texto==='CODIGO-123'?{link:true}:null};
 const lookupRecipient=from=>db.getWhatsAppLink(from);
 const done=async()=>!(await f.pool.query("SELECT 1 FROM mtr_harness.whatsapp_inbox WHERE state NOT IN ('completed','ignored','uncertain')")).rows.length;
 const estado=async id=>(await f.pool.query('SELECT state FROM mtr_harness.whatsapp_inbox WHERE wamid=$1',[id])).rows[0]?.state;
 let ligado=true;const turnos=[],dono=[];let turno=async({mensagem})=>({text:'público: '+mensagem});
 const publico={atende:async()=>ligado,turno:async m=>{turnos.push(m);return turno(m);}};
 const inbox=createWaInbox(f.pool,{seal:encryptSecret,open:decryptSecret,lookupRecipient});t.after(()=>inbox.release());
 const h=createWhatsAppHandler({inbox,db,publico,
  loadAgent:async(id,user)=>user===uuid(1)&&id===uuid(11)?{id,name:'Alpha'}:null,runConversation:async(a,u,text)=>{dono.push(text);return {text:'dono: '+text};}});
 handlers.push(h);await h.start();
 const chegar=async(...msgs)=>{await h.accept(payload(msgs));await h.process(payload(msgs));await until(done);};

 await t.test('mensagens picadas viram um turno; o que chega durante o turno vai junto no seguinte',async()=>{
  let soltar;const lento=new Promise(r=>{soltar=r;});
  turno=async({mensagem})=>{if(mensagem.startsWith('primeira'))await lento;return {text:'público: '+mensagem};};
  const a=msg(CLIENTE,'primeira'),b=msg(CLIENTE,'segunda'),c=msg(CLIENTE,'terceira'),d=msg(CLIENTE,'quarta');
  await h.accept(payload([a,b]));await h.process(payload([a,b]));
  await until(async()=>turnos.length===1);
  await h.accept(payload([c]));await h.process(payload([c]));await wait(80);
  await h.accept(payload([d]));await h.process(payload([d]));await wait(150);
  assert.deepEqual(sent,[]);assert.equal(turnos.length,1);soltar();await until(done);
  assert.deepEqual(sent.map(s=>s.text),['público: primeira\nsegunda','público: terceira\nquarta']);
  assert.deepEqual(turnos.map(x=>x.endereco),[CLIENTE,CLIENTE]);
  for(const m of [a,b,c,d])assert.equal(await estado(m.id),'completed');
  assert.deepEqual(dono,[]);
  turno=async({mensagem})=>({text:'público: '+mensagem});
 });
 await t.test('dono vinculado segue o fluxo dele; código de conexão vale antes do público',async()=>{
  sent.length=0;turnos.length=0;
  await chegar(msg(DONO,'oi do dono'));await until(async()=>sent.length===1);
  assert.deepEqual(sent.map(s=>s.text),['dono: oi do dono']);
  await chegar(msg(CLIENTE,'CODIGO-123'));
  assert.match(sent[1].text,/Número confirmado/);assert.deepEqual(turnos,[]);
 });
 await t.test('fora texto: resposta fixa sem turno; reação: nada',async()=>{
  sent.length=0;
  await chegar(msg(CLIENTE,null,{type:'audio',text:undefined,audio:{id:'m1'}}),msg(CLIENTE,null,{type:'reaction',text:undefined,reaction:{emoji:'👍'}}));
  assert.equal(sent.length,1);assert.match(sent[0].text,/só consigo ler mensagens de texto/);assert.deepEqual(turnos,[]);
 });
 await t.test('saídas do plugin: texto, imagem, botão de link e template, na ordem',async()=>{
  sent.length=0;
  turno=async()=>({text:'versão em texto',saidas:[{tipo:'texto',texto:'Oi!'},{tipo:'imagem',url:'https://x.example/a.jpg',legenda:'Blusa'},
   {tipo:'botao',texto:'Prove agora',rotulo:'Provar',url:'https://x.example/p'},{tipo:'botao',texto:'Batom',rotulo:'Ver',url:'https://x.example/b',imagem:'https://x.example/b.jpg'},{tipo:'template',nome:'boas_vindas',idioma:'pt_BR',componentes:[]}]});
  const m=msg(CLIENTE,'oi');await chegar(m);
  assert.deepEqual(sent,[{to:CLIENTE,text:'Oi!'},{to:CLIENTE,image:{link:'https://x.example/a.jpg',caption:'Blusa'}},
   {to:CLIENTE,interactive:{type:'cta_url',body:{text:'Prove agora'},action:{name:'cta_url',parameters:{display_text:'Provar',url:'https://x.example/p'}}}},
   {to:CLIENTE,interactive:{type:'cta_url',header:{type:'image',image:{link:'https://x.example/b.jpg'}},body:{text:'Batom'},action:{name:'cta_url',parameters:{display_text:'Ver',url:'https://x.example/b'}}}},
   {to:CLIENTE,template:{name:'boas_vindas',language:{code:'pt_BR'}}}]);
  assert.equal(await estado(m.id),'completed');
  turno=async({mensagem})=>({text:'público: '+mensagem});
 });
 await t.test('saída recusada vira a reserva; com imagem, a seguinte espera a entrega',async()=>{
  sent.length=0;process.env.WA_ESPERA_ENTREGA_MS='3000';t.after(()=>{process.env.WA_ESPERA_ENTREGA_MS='0';});
  turno=async()=>({text:'x',saidas:[{tipo:'template',nome:'recusado',idioma:'pt_BR',componentes:[],reserva:'Opções: 1. Blusa'},
   {tipo:'imagem',url:'https://x.example/a.jpg',reserva:'Foto: https://x.example/a.jpg'},{tipo:'texto',texto:'Gostou?'}]});
  const m=msg(CLIENTE,'oi');await h.accept(payload([m]));await h.process(payload([m]));
  await until(async()=>sent.length===2);await wait(100);assert.equal(sent.length,2,'o texto espera a entrega da foto');
  await h.process({entry:[{changes:[{value:{statuses:[{id:'out-2',status:'failed',recipient_id:CLIENTE,errors:[{code:131053}]}]}}]}]});
  await until(done);
  assert.deepEqual(sent.map(x=>x.text??Object.keys(x)[1]),['Opções: 1. Blusa','image','Foto: https://x.example/a.jpg','Gostou?']);
  turno=async({mensagem})=>({text:'público: '+mensagem});
 });
 await t.test('turno que falha: nada enviado e a entrada fica incerta (sem repetir)',async()=>{
  sent.length=0;turno=async()=>{throw Error('modelo fora');};const m=msg(CLIENTE,'vai falhar');
  await chegar(m);assert.deepEqual(sent,[]);assert.equal(await estado(m.id),'uncertain');
  turno=async({mensagem})=>({text:'público: '+mensagem});
 });
 await t.test('desligado: mensagem de login de hoje, sem turno público',async()=>{
  sent.length=0;turnos.length=0;ligado=false;
  await chegar(msg(CLIENTE,'oi'));assert.match(sent[0].text,/faça login/);assert.deepEqual(turnos,[]);
 });
});
