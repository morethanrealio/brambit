// Fictional fixtures only. No network, database, or user audit transcript.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createInventoryCalculationSession, inventoryReport, renderInventoryReport, quantityFromQuote} from '../web/inventory-calculation.mjs';
import {runAgent,ToolRegistry} from '../core-proto/core.mjs';
const room=[3,1,2,2,2,2,2,3,2]; // 19 units, 9 item rows.
const hall=[3,1,10,2,4,8,2,5,3]; // 38 units, 9 item rows.
const locales=[
 {language:'pt-BR',request:'Faça o inventário',item:'objeto',room:'Sala',hall:'Hall',units:'unidades',rows:'Linhas de itens',add:'Adicione 3 peças ao primeiro objeto do Hall',unknown:'quantidade não informada'},
 {language:'en-US',request:'Create the inventory',item:'item',room:'Room',hall:'Hall',units:'units',rows:'Item rows',add:'Add 3 pieces to the first Hall item',unknown:'quantity not stated'},
 {language:'es-ES',request:'Haz el inventario',item:'objeto',room:'Sala',hall:'Hall',units:'unidades',rows:'Filas de artículos',add:'Agrega 3 piezas al primer objeto del Hall',unknown:'cantidad no indicada'},
];
function fixture(l,values=room,title=l.room) {
 const quotes=values.map((n,i)=>`${n} ${l.item} ${i+1}`);
 return {message:`${l.request}\n${quotes.join('\n')}`,input:{sections:[{title,items:quotes.map((quote,i)=>({label:`${l.item} ${i+1}`,sources:[{source:'current',quote}]}))}]}};
}
const toolCall=input=>({stop:'tool',toolCalls:[{id:'calc',name:'calcular_inventario',args:input}]});
async function run(session,answers,{tools=new ToolRegistry().add(session.tool),maxSteps=8,onEvent=()=>{}}={}) {
 let calls=0;
 const result=await runAgent({provider:{name:'offline',complete:async input=>{const a=answers[calls++];assert.ok(a,'unexpected provider retry');return typeof a==='function'?a(input):a;}},tools,userInput:session.promptBlock(),maxSteps,control:{beforeAnswer:()=>session.beforeAnswer()},onEvent});
 return {...result,calls};
}

for(const l of locales) test(`${l.language}: repair bypass, totals 19/38, counts, and native output`,async()=>{
 const first=fixture(l);const session=createInventoryCalculationSession({...first,language:l.language});
 const events=[];
 assert.equal(session.required,false,'the model, not a keyword, opens the contract');
 const result=await run(session,[{stop:'tool',toolCalls:[{id:'calc0',name:'calcular_inventario',args:{sections:[{title:'X',items:[{label:'Y',sources:[{source:'history:9',quote:'nope'}]}]}]}}]},{stop:'end',text:'Total: 13'},input=>{assert.deepEqual(input.tools.map(t=>t.name),['calcular_inventario']);return toolCall(first.input);},{stop:'end',text:'Total: 13; types: 25'}],{onEvent:e=>events.push(e)});
 assert.match(result.text,new RegExp(`19 ${l.units}`));assert.match(result.text,new RegExp(`${l.rows}: 9`));assert.doesNotMatch(result.text,/13|25/);
 assert.ok(events.some(e=>e.type==='answer_contract_retry'));
 assert.ok(!events.some(e=>['assistant','end'].includes(e.type)&&e.text==='Total: 13'));
 assert.equal(result.messages.at(-1).content,result.text);
 const second=fixture(l,hall,l.hall);const s2=createInventoryCalculationSession({...second,language:l.language});
 const out=await run(s2,[toolCall(second.input),{stop:'end',text:'Total: 36; types: 10'}]);
 assert.match(out.text,new RegExp(`38 ${l.units}`));assert.match(out.text,new RegExp(`${l.rows}: 9`));assert.doesNotMatch(out.text,/36|types: 10/);
 assert.equal(s2.finish('Wrong total 36'),out.text,'later prose processing cannot rewrite the report');
});

for(const l of locales)test(`${l.language}: source-linked addition, replacement and removal preserve other rows`,()=>{
 const first=fixture(l,hall,l.hall);const original=createInventoryCalculationSession({...first,language:l.language});
 assert.equal(original.tool.run(first.input).ok,true);
 const history=[{role:'user',content:first.message},{role:'assistant',content:original.finish(''),inventoryCalculation:original.snapshot()}];
 const changed=createInventoryCalculationSession({message:l.add,history,language:l.language});assert.equal(changed.required,false);
 const shown=changed.tool.run({sections:[{title:l.hall,items:[{label:'x',sources:[{source:'current',quote:'nope'}]}]}]});
 assert.equal(shown.ok,false);assert.equal(shown.previous_sections[0].items.length,9,'a failed first call returns the saved rows');assert.equal(changed.required,true);
 const prefix=l.language.startsWith('en')?'3 pieces':l.language.startsWith('es')?'3 piezas':'3 peças';
 const items=first.input.sections[0].items.map((item,i)=>({label:item.label,sources:[{source:`previous:1:${i+1}:1`,quote:item.sources[0].quote}]}));
 items[0].sources.push({source:'current',quote:prefix});
 assert.equal(changed.tool.run({sections:[{title:l.hall,items}]}).ok,true);
 assert.match(changed.finish(''),new RegExp(`41 ${l.units}`));
 assert.match(changed.finish(''),new RegExp(`${l.rows}: 9`));
 // A subsequent correction replaces the first row and drops the last row.
 const replacement='2 replacement items';
 const next=createInventoryCalculationSession({message:`${l.request}: ${replacement}`,history:[...history,{role:'user',content:l.add},{role:'assistant',content:changed.finish(''),inventoryCalculation:changed.snapshot()}],language:l.language});
 const edits=items.slice(0,-1).map((item,i)=>({label:item.label,sources:i===0?[{source:'current',quote:replacement}]:[{source:`previous:1:${i+1}:1`,quote:item.sources[0].quote}]}));
 assert.equal(next.tool.run({sections:[{title:l.hall,items:edits}]}).ok,true);
 assert.match(next.finish(''),new RegExp(`34 ${l.units}`));assert.match(next.finish(''),new RegExp(`${l.rows}: 8`));
 assert.equal(next.snapshot().sections[0].rows[0].parts[0].quote,replacement);
 // Old original messages are no longer aliases of the same previous evidence.
 const stale={sections:[{title:'Test',items:[{label:'Alias',sources:[{source:'history:1',quote:first.input.sections[0].items[0].sources[0].quote}]}]}]};
 assert.equal(next.tool.run(stale).ok,false);
});

test('unknown fields stay unknown; decimal arithmetic is exact and units remain separate',()=>{
 for(const l of locales){
  const quotes=['0.1 kg rice','0,2 kg rice','chairs','2 lamps'];
  const s=createInventoryCalculationSession({message:`${l.request}\n${quotes.join('\n')}`,language:l.language});
  const input={sections:[{title:'Storage',items:[{label:'Rice',sources:quotes.slice(0,2).map(quote=>({source:'current',quote}))},{label:'Chairs',sources:[{source:'current',quote:quotes[2]}]},{label:'Lamps',sources:[{source:'current',quote:quotes[3]}]}]}]};
  const r=s.tool.run(input);assert.equal(r.ok,true);assert.equal(r.inventory_calculation.sections[0].rows[0].knownQuantity,'0.3');
  assert.match(r.report,new RegExp(l.unknown));assert.match(r.report,/\*\*2 (?:units|unidades)\*\*/);assert.doesNotMatch(r.report,/2[.,]3|0\.300000/);
 }
 for(const quote of ['1.234 chairs','1,234 chairs','one thousand chairs','two or three chairs','2/3 chairs'])assert.throws(()=>quantityFromQuote(quote));
 assert.equal(quantityFromQuote('1.234,56 kg rice').quantity,'1234.56');
 assert.equal(quantityFromQuote('1,234.56 kg rice').quantity,'1234.56');
 assert.equal(quantityFromQuote('trinta e oito cadeiras').quantity,'38');
 assert.equal(quantityFromQuote('thirty-eight chairs').quantity,'38');
 assert.equal(quantityFromQuote('treinta y ocho sillas').quantity,'38');
 assert.equal(quantityFromQuote('one hundred and twenty chairs').quantity,'120');
});

test('quotes cannot invent values, split digits or reuse an input span',()=>{
 const src=new Map([['current','12 chairs; 3 desks']]);
 const spec=sources=>({sections:[{title:'Room',items:[{label:'Furniture',sources}]}]});
 for(const refs of [
  [{source:'current',quote:'99 chairs'}],
  [{source:'current',quote:'2 chairs'}],
  [{source:'current',quote:'12 chairs'},{source:'current',quote:'12 chairs'}],
 ])assert.throws(()=>inventoryReport(spec(refs),src));
 for(const line of ['twenty one chairs','one hundred two chairs','vinte e dois bancos']){
  const quote=line.includes('chairs')?line.endsWith('one chairs')?'one chairs':'two chairs':'dois bancos';
  assert.throws(()=>inventoryReport(spec([{source:'current',quote}]),new Map([['current',line]])));
 }
 for(const [line,quote] of [['-2 chairs','2 chairs'],['- 2 chairs','2 chairs'],['2/3 chairs','3 chairs'],['2⁄3 chairs','3 chairs'],['2×3 chairs','3 chairs'],['two times three chairs','three chairs'],['2 - 3 chairs','3 chairs'],['2–3 chairs','3 chairs'],['2—3 chairs','3 chairs'],['de 2 até 3 cadeiras','3 cadeiras'],['two or three chairs','three chairs'],['2 to 3 chairs','3 chairs'],['dos o tres sillas','tres sillas']]){
  assert.throws(()=>inventoryReport(spec([{source:'current',quote}]),new Map([['current',line]])));
 }
 assert.throws(()=>inventoryReport({sections:[{title:'Room',items:[]}]},src));
 const r=inventoryReport(spec([{source:'current',quote:'12 chairs'},{source:'current',quote:'3 desks'}]),src);
 assert.equal(r.sections[0].rows[0].knownQuantity,'15');
 r.sections[0].rows[0].knownQuantity='13';assert.throws(()=>renderInventoryReport(r));
});

test('PostgreSQL JSONB preserves a usable receipt and the 19→38 update in PT/EN/ES',async t=>{
 const {PGlite}=await import('@electric-sql/pglite');
 const db=new PGlite();t.after(()=>db.close());
 await db.exec('CREATE TABLE inventory_threads(id text PRIMARY KEY, history jsonb NOT NULL)');
 for(const l of locales)await t.test(l.language,async()=>{
  const first=fixture(l,[3,2,4,5,5]);
  const session=createInventoryCalculationSession({...first,language:l.language});
  assert.equal(session.tool.run(first.input).ok,true);
  const snapshot=session.snapshot(),native=session.finish('');
  const history=[{role:'user',content:first.message},{role:'assistant',content:native,inventoryCalculation:snapshot}];
  await db.query('INSERT INTO inventory_threads(id,history) VALUES($1,$2::jsonb)',[l.language,JSON.stringify(history)]);
  const stored=(await db.query('SELECT history FROM inventory_threads WHERE id=$1',[l.language])).rows[0].history;
  const persisted=stored.at(-1).inventoryCalculation;
  assert.notDeepEqual(Object.keys(persisted.sections[0].rows[0]),Object.keys(snapshot.sections[0].rows[0]),'real JSONB reordered nested object keys');
  assert.equal(renderInventoryReport(persisted,l.language),native,'persisted receipt renders exactly the original total19');
  const update=createInventoryCalculationSession({message:first.message,history:stored,language:l.language});
  const items=first.input.sections[0].items.map((item,i)=>({label:item.label,sources:[{source:`previous:1:${i+1}:1`,quote:item.sources[0].quote},...item.sources]}));
  const result=update.tool.run({sections:[{title:l.room,items}]});
  assert.equal(result.ok,true,'persisted snapshot supplies prior quantities to the next turn');
  assert.deepEqual(update.snapshot().sections[0].rows.map(row=>row.knownQuantity),['6','4','8','10','10']);
  const updated=update.finish('Total:13');assert.match(updated,new RegExp(`38 ${l.units}`));
  await db.query('UPDATE inventory_threads SET history=$2::jsonb WHERE id=$1',[l.language,JSON.stringify([...stored,{role:'user',content:first.message},{role:'assistant',content:updated,inventoryCalculation:update.snapshot()}])]);
  const final=(await db.query('SELECT history FROM inventory_threads WHERE id=$1',[l.language])).rows[0].history.at(-1);
  assert.equal(renderInventoryReport(final.inventoryCalculation,l.language),final.content,'updated total38 also survives JSONB persistence');
  const changed=structuredClone(final.inventoryCalculation);changed.sections[0].rows[0].knownQuantity='13';
  assert.throws(()=>renderInventoryReport(changed,l.language),/invalid_report/,'quantity tampering still invalidates the digest');
  const reordered=structuredClone(final.inventoryCalculation);reordered.sections[0].rows.reverse();
  assert.throws(()=>renderInventoryReport(reordered,l.language),/invalid_report/,'array order remains part of the receipt');
 });
});

test('mandatory calculation fails closed on refusal, invalid source and final-step exhaustion',async()=>{
 for(const maxSteps of [1,2,8]){
  const f=fixture(locales[0]);const s=createInventoryCalculationSession(f);
  assert.equal(s.tool.run({sections:[{title:'X',items:[{label:'Y',sources:[{source:'current',quote:'nope'}]}]}]}).ok,false);
  const r=await run(s,[{stop:'end',text:'Total:13'},{stop:'end',text:'Total:13'}],{maxSteps});
  assert.doesNotMatch(r.text,/13/);assert.match(r.text,/Não consegui conferir/);assert.ok(r.calls<=2);
 }
 const f=fixture(locales[1]);const s=createInventoryCalculationSession({...f,language:'en-US'});
 const r=await run(s,[toolCall({sections:[{title:'Room',items:[{label:'chairs',sources:[{source:'current',quote:'99 chairs'}]}]}]}),{stop:'end',text:'Total:99'}],{maxSteps:1});
 assert.doesNotMatch(r.text,/99/);assert.match(r.text,/could not verify/);
});

test('answer repair executes no unrelated tool, including a spoofed tool call after an earlier write',async()=>{
 const f=fixture(locales[1]);const s=createInventoryCalculationSession({...f,language:'en-US'});let effects=0;
 const tools=new ToolRegistry().add(s.tool).add({name:'write',run:()=>{effects++;return {ok:true};}});
 const r=await run(s,[{stop:'tool',toolCalls:[{id:'write-1',name:'write',args:{}}]},{stop:'tool',toolCalls:[{id:'calc0',name:'calcular_inventario',args:{sections:[{title:'X',items:[{label:'Y',sources:[{source:'history:9',quote:'nope'}]}]}]}}]},{stop:'end',text:'13'},input=>{assert.deepEqual(input.tools.map(t=>t.name),['calcular_inventario']);return {stop:'tool',toolCalls:[{id:'write-2',name:'write',args:{}}]};}],{tools});
 assert.equal(effects,1);assert.match(r.text,/could not verify/);assert.doesNotMatch(r.text,/13/);
});

test('interjection invalidates old receipt and explicit cancellation releases the calculation contract',()=>{
 const f=fixture(locales[0]);const s=createInventoryCalculationSession(f);s.tool.run(f.input);assert.ok(s.snapshot());
 s.observeInterjection('Adicione 2 cadeiras');assert.equal(s.snapshot(),null);assert.match(s.finish('13'),/Não consegui conferir/);
 assert.ok(s.beforeAnswer().retry.includes('Adicione 2 cadeiras'));
 s.observeInterjection('Cancele o inventário.');assert.equal(s.required,false);assert.equal(s.finish('Cancelado'),'Cancelado');
});

test('credit stops remain authoritative before and after a valid calculation, with no recovery call',async()=>{
 for(const afterCalculation of [false,true])for(const maxSteps of [1,8]){
  const f=fixture(locales[1]);const s=createInventoryCalculationSession({...f,language:'en-US'});
  const credit={stop:'end',creditStop:'insufficient_credit',text:'Credit unavailable.'};
  const r=await run(s,[...(afterCalculation?[toolCall(f.input)]:[]),credit],{maxSteps});
  assert.equal(r.text,credit.text);assert.equal(r.termination,credit.creditStop);
  assert.equal(s.finish(r.text,{termination:r.termination}),credit.text);
  assert.equal(r.calls,afterCalculation?2:1);
 }
});

test('without a tool call, no keyword turns an answer into an inventory report',()=>{
 for(const text of ['Receita para 4 pessoas','Quanto é 2 + 2?','O que é inventário?','Inventário da herança da minha avó no cartório']){const s=createInventoryCalculationSession({message:text});assert.equal(s.enabled,true);assert.equal(s.required,false,text);assert.equal(s.promptBlock(),'');assert.equal(s.beforeAnswer(),null);assert.equal(s.finish('Resposta'),'Resposta');}
 const s=createInventoryCalculationSession({message:'inventory',enabled:false});assert.equal(s.enabled,false);assert.equal(s.required,false);assert.equal(s.finish('General answer'),'General answer');
});

// Execute the actual server's setup and finalizer blocks with a fake provider.
// This detects missing tool registration, mandatory hook, persistence or a later
// free-form overwrite without opening any service or copying server logic.
test('real server setup, provider control and finalization preserve receipts/cards and the typed snapshot',async()=>{
 const source=readFileSync(new URL('../web/server.mjs',import.meta.url),'utf8');
 const setup=source.slice(source.indexOf('  const inventoryCalculation = createInventoryCalculationSession('),source.indexOf('  // noTools: generates text ONLY'));
 const control=source.match(/    control:\{beforeAnswer:\(\)=>inventoryCalculation\.beforeAnswer\(\),afterTool:[^\n]+/)[0].trim().replace(/^control:/,'').replace(/,$/,'');
 const finalize=source.slice(source.indexOf('  // Inventory totals and row counts'),source.indexOf("  // The turn's images do NOT stay in the history:"));
 for(const l of locales){
  const f=fixture(l);const registry=new ToolRegistry();
  const deps={createInventoryCalculationSession,message:f.message,baseHistory:[],userLang:l.language,idiomaResposta:l.language,noTools:false,ephemeral:false,agentCategory:'pessoal',kind:'chat',opts:{},registry,discoveryFrame:'',routineFrame:'',userInput:f.message,nowLine:'',confirmFailureNote:'',tail:''};
  const actual=new Function(...Object.keys(deps),`${setup}\nreturn {inventoryCalculation,userInputForModel,control:${control}};`)(...Object.values(deps));
  assert.equal(registry.defs[0].name,'calcular_inventario');assert.ok(!actual.userInputForModel.includes('inventory_sources'));
  let n=0;const result=await runAgent({provider:{name:'offline',complete:async()=>++n===1?toolCall(f.input):{stop:'end',text:'Total:13'}},tools:registry,control:actual.control,userInput:actual.userInputForModel});
  const fd={inventoryCalculation:actual.inventoryCalculation,text:'Total:13',termination:result.termination,renderCompletedActions:()=>l.language.startsWith('en')?'Action completed':'Ação concluída',actionJournal:{entries:[]},userLang:l.language,idiomaResposta:l.language,deterministicConfirmation:'PENDING CONFIRMATION',curationResult:null,searchCoverage:{finishEmail:text=>text},selo:false,messages:result.messages,stepCeiling:{annotate(){}}};
  const final=new Function(...Object.keys(fd),`${finalize}\nreturn {text,messages};`)(...Object.values(fd));
  assert.match(final.text,new RegExp(`19 ${l.units}`));assert.match(final.text,/PENDING CONFIRMATION/);assert.doesNotMatch(final.text,/13/);
  assert.equal(final.messages.at(-1).content,final.text);assert.ok(final.messages.at(-1).inventoryCalculation.digest);
 }
});
