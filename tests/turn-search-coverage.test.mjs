// These cases expect the Portuguese texts on an instance whose default language is pt-BR.
process.env.BRAMBIT_DEFAULT_LANGUAGE = 'pt-BR';
import { createAppBuildJournal } from '../web/app-build-state.mjs';
import { createActionJournal } from '../web/action-evidence.mjs';
import { createInventoryCalculationSession } from '../web/inventory-calculation.mjs';
// Offline: real worker orchestration/core, fake providers; no customer data.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net'; import tls from 'node:tls'; import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const denied=()=>{throw Error('REAL I/O FORBIDDEN');};
net.Socket.prototype.connect=denied;tls.connect=denied;globalThis.fetch=denied;
for(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[n]=denied;
syncBuiltinESMExports();
const {turnSearchCoverage,preserveSearchCoverageWarning}=await import('../web/turn-search-coverage.mjs');
const {emailQueryCoverage,renderEmailCoverage,renderEmailCoverageLimitations,findEmailCoverageWarnings}=await import('../web/email-search-coverage.mjs');
const {trackEmailPagination,emailPagination}=await import('../web/email-pagination.mjs');
const {createEmailResearchSession}=await import('../web/email-research-session.mjs');
const {EMAIL_RESEARCH_CONTRACT}=await import('../web/email-answer-contract.mjs');
const {SEARCH_FALLBACK,findConnectorSearchLimitations}=await import('../web/connector-search-coverage.mjs');
const {runAgent,ToolRegistry}=await import('../core-proto/core.mjs');
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;},ok=a=>{assert.ok(a);checks++;};
for(const language of ['pt-BR','en','es','en-US','es-MX','fr',undefined]){
 const s=turnSearchCoverage();eq(s.finish('Nada encontrado.',language),'Nada encontrado.');eq(s.hasPartial(),false);
 for(const value of [false,undefined,null,'true',1])s.observe(value);
 eq(s.hasPartial(),false);s.observe(true);s.observe(false);eq(s.hasPartial(),true);
 const fallback=SEARCH_FALLBACK[/^en/.test(language)?'en':/^es/.test(language)?'es':'pt-BR'];
 const guarded=/^en/.test(language)?'These are the results I could check.':/^es/.test(language)?'Estos son los resultados que pude revisar.':'Estes são os resultados que consegui consultar.';
 const out=s.finish('Lista completa.',language);ok(out.includes(fallback));ok(out.startsWith(guarded));ok(!out.includes('Lista completa.'));eq(s.finish(out,language),out);
 eq(s.finish('',language),s.finish(null,language));eq(s.finish(' ',language),s.finish('',language));
 const rewritten=preserveSearchCoverageWarning(out,'Lista completa.');ok(rewritten.startsWith(fallback));ok(!rewritten.includes('\n'));
 eq(preserveSearchCoverageWarning(out,rewritten),rewritten);ok(preserveSearchCoverageWarning(out,out).startsWith(fallback));eq(preserveSearchCoverageWarning('texto comum','Novo texto'),'Novo texto');
 eq(turnSearchCoverage().hasPartial(),false);
}
// Completed queries, including empty ones, do not expose filters or a technical footer.
for(const returned of [0,3]) {
 const c=turnSearchCoverage();
 const rows=[{account:'work@example.invalid',tool:'gmail_search',query:'from:loja after:2026/09/01',status:'complete',returned}];
 c.observeEmailCoverage(rows);c.observeAccountCoverage({account:'work@example.invalid',status:'consulted'});
 c.observe(false,{nonEmailPartial:false});
 const answer=returned ? 'O pedido foi enviado ontem.' : 'Não encontrei esse pedido na conta de trabalho.';
 eq(c.finish(answer),answer);eq(c.finishEmail(answer),answer);
 eq(c.emailWarnings(),[]);
 eq(renderEmailCoverageLimitations(rows,[]),[]);ok(renderEmailCoverage(rows,[]).includes('Cobertura da busca:'));
}
for(const language of ['pt-BR','en','es','en-US','es-MX','fr',undefined]) {
 const c=turnSearchCoverage();
 const rows=[
  {account:'work@example.invalid',tool:'gmail_search',query:'from:loja segredo',status:'partial',reason:'more_pages'},
  {account:'work@example.invalid',tool:'gmail_read',status:'partial',reason:'body_truncated'},
  {account:'work@example.invalid',tool:'gmail_search',query:'consulta agregada',status:'partial',reason:'search_incomplete'},
  {account:'work@example.invalid',tool:'gmail_read_attachment',status:'partial',reason:'attachment_truncated'},
  {account:'work@example.invalid',tool:'gmail_read_attachment',status:'failed',reason:'attachment_failed'},
  {account:'work@example.invalid',tool:'gmail_search',query:'consulta falhou',status:'failed',reason:'query_failed'},
 ];
 const accounts=[{account:'personal@example.invalid',status:'not_consulted'}];
 c.observe(true,{nonEmailPartial:false});c.observeEmailCoverage(rows);c.observeEmailCoverage(rows);c.observeAccountCoverage(accounts[0]);
 const warnings=renderEmailCoverageLimitations(rows,accounts,language);
 eq(c.emailWarnings(language),warnings);
 eq(warnings.length,2);
 const answer='O valor encontrado foi R$ 600. Ainda falta conferir o restante.';
 const out=c.finish(answer,language);
 eq(c.hasPartial(),true);ok(out.startsWith(answer));ok(!out.includes('segredo'));ok(!out.includes('Cobertura da busca:'));ok(!out.includes('⚠️ Busca parcial:'));
 eq(c.finish(out,language),out);eq(c.finishEmail(out,language),out);
 eq(findEmailCoverageWarnings(out),warnings);
 for(const warning of warnings)eq(out.split(warning).length,2);
 // The model must not replace a factual notice with a generic guarantee/caveat.
 const ignored=c.finish('Já verifiquei tudo. A resposta pode estar incompleta.',language);
 for(const warning of warnings)ok(ignored.includes(warning));
 // Free mention of the diagnosis and citation must survive processing.
 const prose='Você perguntou sobre "Cobertura da busca".\n\n> '+warnings[0]+'\n\nIsso é uma citação.';
 const withQuote=c.finish(prose,language);ok(withQuote.includes(prose));eq(withQuote.split(warnings[0]).length,3);
 const wa=preserveSearchCoverageWarning(out,'O valor encontrado foi R$ 600.');
 ok(wa.startsWith(warnings[0]));ok(!wa.includes('\n'));for(const warning of warnings)eq(wa.split(warning).length,2);
 eq(preserveSearchCoverageWarning(out,wa),wa);
 const preserved=preserveSearchCoverageWarning(out,prose);ok(preserved.includes(prose));
 // Per-account limits coexist with the legacy notice when Drive/Slack fails.
 c.observe(true,{nonEmailPartial:true});const mixed=c.finish(answer,language);
 const generic=turnSearchCoverage();generic.observe(true);const genericWarning=generic.finish('',language);
 ok(mixed.includes(genericWarning));for(const warning of warnings)ok(mixed.includes(warning));
 eq(c.finish(mixed,language),mixed);eq(c.finishEmail(mixed,language),mixed);
 const mixedWA=preserveSearchCoverageWarning(mixed,'Resumo.');ok(mixedWA.startsWith(genericWarning));
 eq(preserveSearchCoverageWarning(mixed,mixedWA),mixedWA);
}
// The query may finish, but part of the content may not fit in the handoff to the
// writer. The late limitation stays specific and survives WhatsApp.
for(const [language,phrase] of [
 ['pt-BR','parte do conteúdo das mensagens ficou fora da análise'],
 ['en','part of the message content was excluded from the analysis'],
 ['es','parte del contenido de los mensajes quedó fuera del análisis'],
]) {
 const c=turnSearchCoverage(),account='work@example.invalid';
 c.observeEmailCoverage([{account,tool:'gmail_search',status:'complete',returned:3}]);
 const draft=c.finish('Encontrei três mensagens relevantes.',language);
 eq(draft,'Encontrei três mensagens relevantes.');eq(c.hasPartial(),false);
 const limited={account,tool:'email_evidence',status:'partial',reason:'evidence_limited'};
 c.observeEmailCoverage([limited]);c.observeEmailCoverage([limited]);
 const final=c.finishEmail(draft,language),warnings=findEmailCoverageWarnings(final);
 eq(c.hasPartial(),true);eq(warnings.length,1);ok(warnings[0].includes(phrase));
 eq(final.split(phrase).length,2);eq(c.finish(final,language),final);eq(c.finishEmail(final,language),final);
 ok(!final.includes('query_failed'));ok(!final.includes('body_truncated'));
 const wa=preserveSearchCoverageWarning(final,'Resumo dos e-mails.');
 ok(wa.startsWith(warnings[0]));eq(wa.split(phrase).length,2);eq(preserveSearchCoverageWarning(final,wa),wa);
}
// Access failure without tool execution is material and doesn't become an empty query.
{
 const c=turnSearchCoverage();c.observeAccountCoverage({account:'personal@example.invalid',status:'failed'});
 const out=c.finish('Resultado disponível na outra conta.');
 ok(out.includes('não consegui concluir o acesso'));ok(!out.includes('⚠️ Busca parcial:'));
 eq(c.finishEmail(out),out);
 // An old partial worker doesn't lose the generic notice just because another one read e-mail.
 c.observe(true);const mixed=c.finish('Resultado disponível.');ok(mixed.includes(SEARCH_FALLBACK['pt-BR']));
}
// Attachments from the same e-mail have their own coverage: success of one doesn't clear the failure
// of another, and a return with only a note or empty text doesn't constitute a read.
for(const tool of ['gmail_read_attachment','hotmail_read_attachment']) {
 const c=emailQueryCoverage(),account='attachments@example.invalid';
 const results=[
  {text:'Primeiro trecho legível.',truncated:true},
  {text:'Outro trecho legível.',partial:true},
  {text:'Conteúdo integral.'},
  {note:'Não foi possível extrair texto.'},
  {text:' \n\t '},
  {text:'Prévia presente, mas a leitura falhou.',error:'read_failed'},
 ];
 for(const [index,result] of results.entries())c.observe(tool,{id:'mail',attachmentId:'part-'+index},result,account);
 eq(c.rows().map(row=>[row.attachmentId,row.status,row.reason]),[
  ['part-0','partial','attachment_truncated'],['part-1','partial','attachment_truncated'],['part-2','complete',''],
  ['part-3','failed','attachment_failed'],['part-4','failed','attachment_failed'],['part-5','failed','attachment_failed'],
 ]);
 c.observe(tool,{id:'mail',attachmentId:'part-0'},{text:'Agora foi lido por inteiro.'},account);
 eq(c.rows()[0].status,'complete');eq(c.rows().length,6);eq(c.rows()[3].status,'failed');
 const turn=turnSearchCoverage();turn.observeEmailCoverage(c.rows());
 const output=turn.finish('O anexo disponível informa R$ 600.');
 ok(output.includes('um anexo não pôde ser lido por inteiro'));ok(output.includes('não consegui ler um anexo'));
 eq(turn.finishEmail(output),output);ok(!output.includes('corpo lido'));
 let response={text:'Prévia disponível.',truncated:true};
 const tracked=trackEmailPagination([{name:tool,run:async()=>JSON.stringify(response)}],{account});
 await tracked.tools[0].run({id:'mail',attachmentId:'first'});
 eq(tracked.hasPartial(),true);eq(tracked.hasNonEmailPartial(),false);eq(tracked.coverage()[0].reason,'attachment_truncated');
 response={text:'Conteúdo integral.'};await tracked.tools[0].run({id:'mail',attachmentId:'second'});
 eq(tracked.hasPartial(),true);eq(tracked.coverage().length,2);
 await tracked.tools[0].run({id:'mail',attachmentId:'first'});eq(tracked.hasPartial(),false);
 response={text:'Trecho de leitura parcial.',partial:true};await tracked.tools[0].run({id:'mail',attachmentId:'partial-flag'});
 eq(tracked.hasPartial(),true);eq(tracked.coverage().at(-1).reason,'attachment_truncated');
 response={text:'Conteúdo integral.'};await tracked.tools[0].run({id:'mail',attachmentId:'partial-flag'});eq(tracked.hasPartial(),false);
 response={text:' \n\t '};await tracked.tools[0].run({id:'mail',attachmentId:'blank'});
 eq(tracked.hasPartial(),true);eq(tracked.coverage().at(-1).reason,'attachment_failed');
 response={text:'Conteúdo integral.'};await tracked.tools[0].run({id:'mail',attachmentId:'blank'});eq(tracked.hasPartial(),false);
 response={note:'Falha no leitor.'};await tracked.tools[0].run({id:'mail',attachmentId:'failed'});
 eq(tracked.hasPartial(),true);eq(tracked.coverage().at(-1).reason,'attachment_failed');
}
// Independent identical queries must not erase each other's unfinished chain.
for(const name of ['gmail_search','hotmail_search']){
 const pager=emailPagination({defaultMax:10,cap:50});let native;
 const tracked=trackEmailPagination([{name,run:async args=>{const q=pager.request(args.query,args.max,args.cursor);return pager.result(q,[],native);}}]);
 const tool=tracked.tools[0];native='page2';const first=JSON.parse(await tool.run({query:'same'}));eq(tracked.hasPartial(),true);
 native=null;const independent=JSON.parse(await tool.run({query:'same'}));ok(first.search_id!==independent.search_id);eq(tracked.hasPartial(),true);
 const last=JSON.parse(await tool.run({query:'same',cursor:first.next_cursor}));eq(last.search_id,first.search_id);eq(tracked.hasPartial(),false);
}
for(const result of ['garbage','{}','null',JSON.stringify({has_more:'false'}),null]){
 const t=trackEmailPagination([{name:'gmail_search',run:async()=>result}]);try{await t.tools[0].run({});}catch{}
 eq(t.hasPartial(),true);
}
// REAL subagent functions, extracted without starting server/importing DB.
const source=readFileSync(new URL('../web/server.mjs',import.meta.url),'utf8');
const extract=name=>{const a=source.indexOf('async function '+name+'('),b=source.indexOf('\n}\n',a)+2;assert.ok(a>=0&&b>a);return source.slice(a,b);};
for(const fn of ['runGoogleSubagent','runConnectorSubagent'])for(const toolName of ['gmail_search','hotmail_search','drive_search','slack_search','github_search_issues','github_search_repos','onedrive_search']){
 for(const more of [true,false]){
  let step=0;const coverage=turnSearchCoverage(),usage=[];
  const provider={name:'offline',complete:async()=>++step===1?{stop:'tool',toolCalls:[{id:'c',name:toolName,args:{}}]}:{stop:'end',text:'Síntese sem ressalva.',usage:{model:'mock'}}};
  const deps={runAgent,ToolRegistry,trackEmailPagination,createEmailResearchSession,EMAIL_RESEARCH_CONTRACT,makeSubagentProvider:()=>provider,comIdioma:s=>s,GOOGLE_SUBAGENT_SYSTEM:'Mock'};
  const worker=new Function(...Object.keys(deps),extract(fn)+';return '+fn)(...Object.values(deps));
  const emailOnly=['gmail_search','hotmail_search'].includes(toolName);
  const account=toolName==='hotmail_search' ? undefined : 'worker@example.invalid';
  const result=await worker({objetivo:'Busca sintética',system:'MOCK',account,readTools:[{name:toolName,parameters:{type:'object',properties:{}},run:async()=>JSON.stringify({has_more:more,partial:more,query:'mock',search_id:'test',messages:emailOnly ? [{id:'message',snippet:'Valor encontrado: R$ 600.',account}] : undefined})}],onPagination:coverage.observe,onEmailCoverage:coverage.observeEmailCoverage,onUsage:u=>usage.push(u)});
  eq(coverage.hasPartial(),more);eq(usage.length,1);
  if(emailOnly) {
   const bundle=JSON.parse(result.split('\n').find(line=>line.startsWith('{')));
   eq(bundle.consulta.partial,more);eq(bundle.consulta.status,'sucesso_com_resultados');
   // Invalid synthesis doesn't eliminate the found source, including Outlook without
   // an explicit account in the caller (one authenticated connection per instance).
   eq(bundle.consulta.observed_messages,1);eq(bundle.sources[0].id,'message');
   eq(bundle.conta,account || 'Outlook');eq(bundle.fallback_sources[0].fields[0].text,'Valor encontrado: R$ 600.');
  } else eq(result.includes('AVISO'),more);
  // Final model deliberately ignores the worker disclaimer; postprocessor wins.
  const reg=new ToolRegistry().add({name:'consultar',parameters:{type:'object',properties:{}},run:async()=>result});let n=0;
  const final=await runAgent({provider:{name:'offline',complete:async()=>++n===1?{stop:'tool',toolCalls:[{id:'main',name:'consultar',args:{}}]}:{stop:'end',text:'Lista completa.'}},tools:reg,system:'mock',history:[],userInput:'mock'});
  const statement=source.match(/text = curationResult \? text : searchCoverage\.finish\(text, idiomaResposta, \{suppressEmptyEmailSources: routineNoNews\}\);/)[0];
  const sync=source.slice(source.indexOf('  for (let i = messages.length - 1; i >= 0; i--) {',source.indexOf(statement)),source.indexOf("  // The turn's images do NOT stay in the history:"));
  const finished=new Function('inventoryCalculation','text','messages','searchCoverage','idiomaResposta','curationResult','selo','const routineNoNews=false;'+statement+sync+'return {text,messages};')(createInventoryCalculationSession({enabled:false}),final.text,final.messages,coverage,'pt-BR',false,false);
  eq(findConnectorSearchLimitations(finished.text).length,more && !emailOnly ? 1 : 0);
  ok(!finished.text.includes('⚠️ Busca parcial:'));
  if(more && !emailOnly)ok(!finished.text.includes('Lista completa.'));
  eq(findEmailCoverageWarnings(finished.text).length,more && emailOnly ? 1 : 0);
  eq(finished.messages.at(-1).content,finished.text);
 }
 // Even worker failure AFTER search must report coverage in finally.
 let observed;const fakeRun=async({tools})=>{await tools.run(toolName,{});throw Error('MOCK_PROVIDER_FAILURE');};
 const deps={runAgent:fakeRun,ToolRegistry,trackEmailPagination,createEmailResearchSession,EMAIL_RESEARCH_CONTRACT,makeSubagentProvider:()=>({}),comIdioma:s=>s,GOOGLE_SUBAGENT_SYSTEM:'Mock'};
 const worker=new Function(...Object.keys(deps),extract(fn)+';return '+fn)(...Object.values(deps));
 await assert.rejects(()=>worker({readTools:[{name:toolName,run:async()=>JSON.stringify({has_more:true,partial:true,search_id:'one'})}],onPagination:v=>{observed=v;}}));checks++;
 eq(observed,true);
}
for(const toolName of ['gmail_search','drive_search']){
 const tracked=trackEmailPagination([{name:toolName,run:async()=>{throw Error('mock');}}]);await assert.rejects(()=>tracked.tools[0].run({}));checks++;eq(tracked.hasPartial(),true);
}
// Exercise the real core's recent cap and repeated old-result pruning, not just
// the metadata helper. A large complete API result must still communicate lost
// analysis context through worker -> turn -> channel warning.
{
 const raw=JSON.stringify({search_id:'many',query:'compiled',page:6,pages_completed:6,returned:90,partial:false,has_more:false,next_cursor:null,
   items:Array.from({length:90},(_,i)=>({id:String(i),name:'Férias da equipe '.repeat(12),webViewLink:'https://docs.google.com/spreadsheets/d/'+String(i)+'x'.repeat(100)}))});
 ok(raw.length>24000);
 let step=0;const turn=turnSearchCoverage();
 const provider={name:'offline',complete:async({messages})=>{
  step++;
  if(step===1)return {stop:'tool',toolCalls:[{id:'search',name:'drive_search',args:{query:'férias'}}]};
  const seen=JSON.parse(messages.find(m=>m.role==='tool'&&m.name==='drive_search').content);
  eq(seen.evidence_limited,true);eq(seen.partial,true);ok(seen.retained_items<90);
  if(step<6)return {stop:'tool',toolCalls:[{id:'noop-'+step,name:'noop',args:{step}}]};
  return {stop:'end',text:'Lista completa.',usage:{model:'mock'}};
 }};
 const deps={runAgent,ToolRegistry,trackEmailPagination,createEmailResearchSession,EMAIL_RESEARCH_CONTRACT,makeSubagentProvider:()=>provider,comIdioma:s=>s,GOOGLE_SUBAGENT_SYSTEM:'Mock'};
 const worker=new Function(...Object.keys(deps),extract('runGoogleSubagent')+';return runGoogleSubagent')(...Object.values(deps));
 await worker({objetivo:'Localizar planilha',account:'work@example.invalid',onPagination:turn.observe,readTools:[
   {name:'drive_search',parameters:{type:'object',properties:{}},run:async()=>raw},
   {name:'noop',parameters:{type:'object',properties:{}},run:async()=> 'ok'},
 ]});
 eq(turn.hasPartial(),true);const final=turn.finish('Lista completa.');
 ok(final.includes('parte dos resultados ficou fora da análise'));ok(!final.includes('Lista completa.'));
}
ok(source.includes('onPagination: searchCoverage.observe'));
ok(source.indexOf('text = curationResult ? text : searchCoverage.finish(text, idiomaResposta,')>0);
ok(source.indexOf('text = curationResult ? text : searchCoverage.finish(text, idiomaResposta,')<source.lastIndexOf('await saveThreadTurn(thread.id'));
console.log(`OK: ${checks} verificações de cobertura final; workers/core reais, providers offline, zero I/O real.`);
