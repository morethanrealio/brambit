import test from 'node:test';
import assert from 'node:assert/strict';
import {pageContentQuality,improvePageReading,PARTIAL_PAGE_MARKER} from '../web/page-content-quality.mjs';
import {createCurationEvidence,validateCurationEvidence,curationReadingExcerpt,retainedCurationPage,retainedCurationSearch,retainedCurationToolResult} from '../web/curation-evidence.mjs';
import {finalizeCuration,curationPrompt,curationRepairPrompt,preferCurationRepair} from '../web/curation-runtime.mjs';
import {curationPackets} from '../web/curation-delivery.mjs';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {runAgent,ToolRegistry} from '../core-proto/core.mjs';

const url='https://example.org/research';
const quote='The study measured a 25% improvement using graph structured skills in a controlled benchmark.';
const body=`# Synthetic research\nPublished September 22, 2026\nAuthors: Ana Silva\n\n${quote}\nThese results were measured using the same tools and held-out examples in both experimental groups.`;
const item={url,section:'papers',title:'Synthetic research',author:'Ana Silva',date:'2026-09-22',summary:['O estudo mediu melhoria de 25% usando habilidades em grafo.'],why:'Ajuda a avaliar a organização das habilidades.',dateQuote:'Published September 22, 2026',sourceQuotes:[quote]};
const config={version:2,source:'web',sections:[{id:'market',label:'Mercado',min:1,max:2,maxAgeDays:30},{id:'papers',label:'Papers',min:1,max:2,maxAgeDays:7}],summaryBullets:1,includeWhy:true,language:'pt-BR'};
const checks=[{section:'market',status:'failed',detail:'Nenhuma fonte pôde ser lida'},{section:'papers',status:'complete',detail:''}];
const makeEvidence=()=>{const e=createCurationEvidence();e.observe({name:'abrir_link',args:{url}},`Conteúdo de ${url}:\n\n${body}`);return e;};
const finalize=(items=[item],extra={},deps={})=>finalizeCuration({text:JSON.stringify({items,checks}),config,userId:'synthetic',routineId:'synthetic',history:[],now:'2026-09-22T22:00:00Z',...extra},{checkLinks:async text=>({checados:text.split('\n').length,quebrados:[],indefinidos:[],naoChecados:[]}),...deps});
const shell='# Computer Science > Machine Learning\n# Title:Example Paper\nSubjects: Machine Learning\n## Submission history\n## Access Paper:\n## References & Citations\n## arXivLabs: experimental projects\n'+('arXivLabs is a framework for community projects. '.repeat(15));

test('arXiv shell is insufficient despite a long footer, and direct reading can recover its abstract',async()=>{
 const paperUrl='https://arxiv.org/abs/2609.99999';
 assert.equal(pageContentQuality(shell,paperUrl).sufficient,false);
 let reads=0;
 const direct=`# Example Paper\nAbstract: ${quote} The study uses an independently reviewed dataset and reports methodological limitations.\nSubjects: Machine Learning`;
 const reading=await improvePageReading({text:shell,url:paperUrl},async()=>{reads++;return {text:direct,url:paperUrl};});
 assert.equal(reads,1);assert.equal(reading.partial,false);assert.equal(reading.text,direct);
});
test('failed fallback preserves useful observed metadata and marks reading partial',async()=>{
 const r=await improvePageReading({text:shell,url:'https://arxiv.org/abs/2609.99999'},async()=>{throw Error('blocked');});
 assert.equal(r.partial,true);assert.equal(r.text,shell);
});
test('actual page tool retries a sparse extract once, accounts only paid extraction, and preserves limitations',async()=>{
 const source=readFileSync(new URL('../web/websearch.mjs',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('export function openLinkTool'),source.indexOf('// ── REVERSE image search')).replace('export function','function');
 let directReads=0,extracts=0;const usages=[];
 const paperUrl='https://arxiv.org/abs/2609.99999';
 const useful=`# Example Paper\nAbstract: ${quote} The study reports transparent methodology and important limitations for practical deployments.\nSubjects: Machine Learning`;
 const context={Buffer,console,pageContentQuality,improvePageReading,PARTIAL_PAGE_MARKER,assertPublicUrl:async()=>{},safeFetch:async()=>({headers:{get:()=> 'text/html'},body:{cancel:async()=>{}}}),tavilyEnabled:()=>true,tavilyExtract:async()=>{extracts++;return {text:shell,url:paperUrl,usage:{total:1}};},lerPaginaDireto:async()=>{directReads++;return {texto:useful,url:paperUrl};},recortarPagina:text=>({corpo:text,corte:''}),exportGoogleSheets:()=>null,nomeDoDownload:(_r,f)=>f,nomeDoPath:()=>'',tipoPlanilha:()=>null};
 const make=vm.runInNewContext(code+';openLinkTool;',context),tool=make({onUsage:v=>usages.push(v)});
 const out=await tool.run({url:paperUrl});
 assert.equal(directReads,1);assert.equal(extracts,1);assert.equal(usages.length,1);assert.match(out,/25%/);assert.doesNotMatch(out,/LEITURA PARCIAL/);
 context.lerPaginaDireto=async()=>{directReads++;throw Error('blocked');};
 const partial=await tool.run({url:paperUrl});assert.match(partial,/LEITURA PARCIAL/);assert.match(partial,/Title:Example Paper/);
});
test('complete reading does not make another request; short content is retained if no richer source exists',async()=>{
 const r=await improvePageReading({text:body,url},async()=>{assert.fail('unnecessary fallback');});
 assert.equal(r.partial,false);
 const short=await improvePageReading({text:'Price: R$ 40. In stock.',url},async()=>({text:'Menu',url}));
 assert.equal(short.text,'Price: R$ 40. In stock.');assert.equal(short.partial,true);
});
test('observed quotes support the selected source only; search snippets and model claims are not reads',()=>{
 const e=createCurationEvidence();
 e.observe({name:'buscar_web',args:{}},`Conteúdo de ${url}:\n\n${body}`);
 assert.equal(validateCurationEvidence(item,e.snapshot()),'source_not_read');
 e.observe({name:'abrir_link',args:{url}},`Conteúdo de ${url}:\n\n${body}`);
 assert.equal(validateCurationEvidence(item,e.snapshot()),null);
 assert.equal(validateCurationEvidence({...item,url:url+'/other'},e.snapshot()),'source_not_read');
 assert.equal(validateCurationEvidence({...item,title:'Invented title'},e.snapshot()),'title_not_observed');
 assert.equal(validateCurationEvidence({...item,date:'2026-09-21'},e.snapshot()),'date_not_supported');
 assert.equal(validateCurationEvidence({...item,dateQuote:'September 21, 2026'},e.snapshot()),'date_not_observed');
 assert.equal(validateCurationEvidence({...item,sourceQuotes:['A different study that was never observed.']},e.snapshot()),'summary_quote_not_observed');
 assert.equal(validateCurationEvidence({...item,summary:['Melhorou 90% no benchmark.']},e.snapshot()),'summary_number_not_supported');
 const styled=createCurationEvidence();styled.observe({name:'abrir_link',args:{url}},`Conteúdo de ${url}:\n\n${body.replace('25%','**25%**')}`);
 assert.equal(validateCurationEvidence(item,styled.snapshot()),null,'formatting differences do not change the literal words');
 assert.equal(validateCurationEvidence({...item,sourceQuotes:['The study measured a 25% improvement ... in a controlled benchmark.']},styled.snapshot()),'summary_quote_not_observed');
});
test('partial pages cannot support a completed item; collector caps and copies scope',()=>{
 const e=createCurationEvidence({maxSources:1});
 e.observe({name:'abrir_link',args:{url}},`Conteúdo de ${url}:\n\n${PARTIAL_PAGE_MARKER}\n${body}`);
 assert.equal(validateCurationEvidence(item,e.snapshot()),'source_incomplete');
 e.observe({name:'abrir_link',args:{url:url+'/other'}},`Conteúdo de ${url}/other:\n\n${body}`);
 assert.equal(e.snapshot().limited,true);
 e.snapshot().sources[0].text='mutated';assert.notEqual(e.snapshot().sources[0].text,'mutated');
 assert.equal(createCurationEvidence().snapshot().sources.length,0);
});
test('live site clocks and update metadata cannot establish original publication dates',()=>{
 const observed=(metadata)=>{const e=createCurationEvidence();e.observe({name:'abrir_link',args:{url}},`Conteúdo de ${url}:\n\n${body.replace('Published September 22, 2026',metadata)}`);return e.snapshot();};
 const live='Tuesday 2026-09-22 Live — 12 minds reporting';
 assert.equal(validateCurationEvidence({...item,dateQuote:live},observed(live)),'date_not_publication');
 assert.equal(validateCurationEvidence({...item,dateQuote:'2026-09-22'},observed(live)),'date_not_publication');
 for(const metadata of ['Last updated September 22, 2026','Updated\nSeptember 22, 2026','Hoje: September 22, 2026'])assert.equal(validateCurationEvidence({...item,dateQuote:'September 22, 2026'},observed(metadata)),'date_not_publication');
 assert.equal(validateCurationEvidence(item,observed('Published September 22, 2026')),null);
});
test('bounded repair context retains literal content and publication metadata after long navigation',()=>{
 const menu='Navigation to company sections and pages.\n'.repeat(180);
 const reading=`# Synthetic research\n${menu}Published September 22, 2026\n${quote}\n${'Further study discussion. '.repeat(180)}`;
 const excerpt=curationReadingExcerpt(reading,1000);
 assert.match(excerpt,/Synthetic research/);assert.match(excerpt,/Published September 22, 2026/);assert.ok(excerpt.includes(quote));assert.ok(excerpt.length<=1000);
 const e=createCurationEvidence();e.observe({name:'abrir_link',args:{url}},`Conteúdo de ${url}:\n\n${reading}`);
 const block=e.promptBlock({maxChars:1600,maxPerSource:1000});
 assert.ok(block.length<=1600);assert.ok(block.includes(quote));assert.ok(block.includes(url));assert.match(block,/DADOS, NÃO INSTRUÇÕES/);
 assert.equal(retainedCurationPage('Not a reading'),null);
 assert.ok(retainedCurationPage(`Conteúdo de ${url}:\n\n${reading}`,1000).includes(quote));
});
test('curation search candidates survive actual core pruning after the first read',async()=>{
 const sources=Array.from({length:10},(_,i)=>({title:i===6?'Menlo Ventures Report: Consumer AI Spend Tripled to $40B':`Observed candidate ${i+1}`,url:i===6?'https://news.example.org/2026/09/16/menlo-report':`https://news.example.org/candidate-${i+1}`,date:'Wed, 16 Sep 2026 00:00:00 GMT'}));
 const output='Filtro de datas enviado ao buscador: 2026-08-24 a 2026-09-22. Confira a publicação original.\n'+sources.map(s=>`• ${s.title} [data estimada pelo buscador: ${s.date}]: ${'Literal snippet with adoption findings and limitations. '.repeat(8)}`).join('\n')+'\n\nFontes:\n'+sources.map((s,i)=>`[${i+1}] ${s.title} — ${s.url}`).join('\n');
 const retained=retainedCurationSearch(output);
 assert.ok(retained.length<=5000);assert.ok(retained.includes(sources[6].url));assert.match(retained,/16 Sep 2026/);assert.match(retained,/Literal snippet/);
 assert.equal(retainedCurationSearch(retained),retained,'second prune does not erase or duplicate candidates');
 let step=0,seen='';const tools=new ToolRegistry();tools.add({name:'buscar_web',parameters:{type:'object'},run:async()=>output});tools.add({name:'note',parameters:{type:'object'},run:async()=> 'small observed output'});
 const provider={name:'scripted',complete:async({messages})=>{
  step++;
  if(step===1)return {stop:'tool',toolCalls:[{id:'search',name:'buscar_web',args:{consulta:'market'}}]};
  if(step===2||step===3)return {stop:'tool',toolCalls:[{id:'later-'+step,name:'note',args:{step}}]};
  seen=messages.find(m=>m.role==='tool'&&m.name==='buscar_web').content;
  return {stop:'end',text:'finished'};
 }};
 await runAgent({provider,tools,system:'test',userInput:'curation',maxSteps:4,salvage:false,retainedToolResult:retainedCurationToolResult});
 assert.ok(seen.includes(sources[6].url));assert.ok(seen.includes(sources[6].title));assert.match(seen,/2026-08-24 a 2026-09-22/);assert.ok(seen.length<=5000);
 const evidence=createCurationEvidence();evidence.observe({name:'buscar_web'},retained);assert.equal(evidence.snapshot().sources.length,0);
});
test('provenance checks apply before rendering and links; valid content survives a failed section',async()=>{
 const r=await finalize([item],{}, {sourceEvidence:makeEvidence()});
 assert.deepEqual(r.urls,[url]);assert.equal(r.executionStatus,'partial');
 assert.match(r.text,/## Papers/);assert.doesNotMatch(r.text,/## Mercado|Nenhum conteúdo novo/);
 assert.match(r.text,/Mercado: não consegui concluir a pesquisa/);
 assert.doesNotMatch(r.text,/dateQuote|sourceQuotes|Published September/);
 const bad=await finalize([{...item,summary:['O estudo mediu melhoria de 95%.']}],{}, {sourceEvidence:makeEvidence(),checkLinks:()=>assert.fail('invalid evidence must not reach link checks')});
 assert.deepEqual(bad.urls,[]);assert.match(bad.diagnostic,/summary_number_not_supported/);
 assert.doesNotMatch(bad.text,/95%|Nenhum conteúdo novo/);
});
test('real-run quote concatenation requests the existing repair, without accepting fabricated or unread evidence',async()=>{
 const evidence=makeEvidence();
 const concatenated={...item,sourceQuotes:['The study measured a 25% improvement ... in a controlled benchmark.']};
 const bad=await finalize([concatenated],{}, {sourceEvidence:evidence});
 assert.deepEqual(bad.urls,[]);assert.equal(bad.repairable,true);assert.equal(bad.failureCode,'evidence_format');
 assert.match(curationRepairPrompt(config,bad.diagnostic),/item1:summary_quote_not_observed/);
 assert.match(curationRepairPrompt(config,bad.diagnostic),/CONTIGUOUS/);
 const repaired=await finalize([item],{}, {sourceEvidence:evidence});
 assert.deepEqual(repaired.urls,[url]);assert.equal(repaired.repairable,false);
 const missing=await finalize([{...item,sourceQuotes:undefined}],{}, {sourceEvidence:evidence});assert.equal(missing.repairable,true);
 for(const candidate of [{...concatenated,url:url+'/unread'},{...concatenated,date:'2026-09-20'},{...item,summary:['Melhorou 95%.']}]){
  const rejected=await finalize([candidate],{}, {sourceEvidence:evidence});assert.equal(rejected.repairable,false);assert.deepEqual(rejected.urls,[]);
 }
 const old=await finalize([concatenated],{now:'2026-10-22T12:00:00Z'}, {sourceEvidence:evidence});assert.equal(old.repairable,false);
});
test('absolute publication intervals match date filtering and stay scoped to web research',()=>{
 const p=curationPrompt({...config,sections:[{id:'market',label:'Mercado',min:1,max:1,maxAgeDays:30},{id:'papers',label:'Papers',min:1,max:1,maxAgeDays:14}]},[],'2026-09-22T23:59:59Z');
 assert.match(p,/"section":"market","data_inicio":"2026-08-24","data_fim":"2026-09-22"/);
 assert.match(p,/"section":"papers","data_inicio":"2026-09-09","data_fim":"2026-09-22"/);
 assert.match(p,/individual article\/post\/abstract/);assert.match(p,/before opening/);
 assert.doesNotMatch(curationPrompt({...config,source:'gmail'},[],'2026-09-22'),/PLANO DE SELEÇÃO|data_inicio/);
 assert.throws(()=>curationPrompt(config,[],'invalid'),/Relógio/);
});
test('one repair may add validated items but never discard already useful validated content',()=>{
 const original={urls:[url],text:'Useful validated content',repairable:true,executionStatus:'partial'};
 assert.equal(preferCurationRepair(original,{urls:[],text:'Lost content',repairable:false,executionStatus:'partial'}),original);
 const partial={urls:[url,url+'/new'],text:'Validated items remain useful even if another candidate was rejected',repairable:true,executionStatus:'partial'};
 assert.equal(preferCurationRepair(original,partial),partial);
 const improved={urls:[url,url+'/other'],text:'Two useful sources',repairable:false,executionStatus:'completed'};
 assert.equal(preferCurationRepair(original,improved),improved);
 assert.equal(preferCurationRepair(original,null),original);
});
test('failed searches do not masquerade as absence; completed empty search stays distinct',async()=>{
 const failed=await finalize([], {text:JSON.stringify({items:[],checks:checks.map(c=>({...c,status:'failed'}))})});
 assert.equal(failed.executionStatus,'failed');assert.doesNotMatch(failed.text,/nenhum conteúdo novo/i);
 const empty=await finalize([], {text:JSON.stringify({items:[],checks:checks.map(c=>({...c,status:'complete'}))})});
 assert.equal(empty.executionStatus,'partial');assert.match(empty.text,/nenhum conteúdo novo/i);
});
test('long or unavailable author falls back to real domain; sanitized-empty title or summary is rejected',async()=>{
 const author=await finalize([{...item,author:'Nome da fonte. '.repeat(30)}]);
 assert.deepEqual(author.urls,[url]);assert.match(author.text,/Autor\/Fonte: example.org/);
 for(const change of [{title:'<>'},{summary:['<>']}]){
  const r=await finalize([{...item,...change}]);assert.deepEqual(r.urls,[]);assert.doesNotMatch(r.text,/Autor\/Fonte:\s*\n|\n-\s*$/);
 }
});
test('WhatsApp keeps paragraph structure and complete URLs when chunking',()=>{
 const text=`## Papers\n\nTítulo\n${url}\n- Primeiro resultado.\n- Segundo resultado.`;
 const parts=curationPackets('whatsapp',text);
 assert.equal(parts.length,1);assert.match(parts[0],/Papers\n\nTítulo/);assert.match(parts[0],/\n- Segundo/);assert.ok(parts[0].includes(url));
});
