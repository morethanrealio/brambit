import test from 'node:test';
import assert from 'node:assert/strict';
import { googleTools } from '../web/connectors.mjs';
import { driveSearchQuery, driveSearchParameters } from '../web/drive-search.mjs';
import { trackSearchPagination } from '../web/search-pagination.mjs';
import { turnSearchCoverage, preserveSearchCoverageWarning } from '../web/turn-search-coverage.mjs';
import { retainedSearchPage } from '../core-proto/search-page.mjs';
import { guardConnectorSearchClaims } from '../web/connector-search-coverage.mjs';
import { trackEmailPagination } from '../web/email-pagination.mjs';

test('shared Drive result appears with real structured filters and no extra account scope',async()=>{
  const old=globalThis.fetch;let calls=0;
  globalThis.fetch=async(url,options)=>{
    calls++;const u=new URL(url);assert.equal(u.origin,'https://www.googleapis.com');assert.equal(options.headers.Authorization,'Bearer MOCK');
    assert.equal(u.searchParams.get('includeItemsFromAllDrives'),'true');assert.equal(u.searchParams.get('supportsAllDrives'),'true');assert.equal(u.searchParams.get('corpora'),'user');
    const q=u.searchParams.get('q');assert.match(q,/name contains 'férias' or name contains 'ferias'/);assert.match(q,/mimeType = 'application\/vnd.google-apps.spreadsheet'/);assert.doesNotMatch(q,/fullText/);
    return {ok:true,json:async()=>({files:[{id:'shared-sheet',name:'Férias da equipe',driveId:'team-drive',webViewLink:'https://docs.google.com/spreadsheets/d/shared-sheet/edit'}]})};
  };
  try{const t=googleTools({token:async()=>'MOCK',caps:{drive:{read:true}}}).find(t=>t.name==='drive_search');const r=JSON.parse(await t.run({terms:['férias','ferias'],search_in:'name',file_type:'spreadsheet',complete:true}));assert.equal(calls,1);assert.equal(r.partial,false);assert.equal(r.items[0].id,'shared-sheet');}finally{globalThis.fetch=old;}
});
test('query operators are rejected before a misleading empty result; values escaped',()=>{
  for(const query of ["name contains 'férias'",'type:spreadsheet',"mimeType='text/csv'",'férias OR escala'])assert.throws(()=>driveSearchQuery({query}),/não operadores/);
  assert.match(driveSearchQuery({query:"O'Reilly\\arquivo"}),/O\\'Reilly\\\\arquivo/);
  assert.match(driveSearchQuery({file_type:'spreadsheet',folder_id:'folder-safe'}),/'folder-safe' in parents/);
  assert.equal(driveSearchParameters.properties.shared_with_me,undefined);
  assert.throws(()=>driveSearchQuery({shared_with_me:true}),/excluiria arquivos de equipes/);
  assert.throws(()=>driveSearchQuery({query:'a',terms:['b']}));
});
test('bounded completion finds page two and duplicate calls reuse observed pages',async()=>{
  const old=globalThis.fetch;let calls=0;
  globalThis.fetch=async url=>{calls++;const second=new URL(url).searchParams.has('pageToken');return {ok:true,json:async()=>second?{files:[{id:'target',name:'Escala'}]}:{files:[{id:'first',name:'Outra'}],nextPageToken:'second'}};};
  try{const tool=googleTools({token:async()=>'MOCK',caps:{drive:{read:true}}}).find(t=>t.name==='drive_search');const args={query:'escala',search_in:'name',complete:true};const r=JSON.parse(await tool.run(args));assert.deepEqual(r.items.map(x=>x.id),['first','target']);assert.equal(r.partial,false);assert.equal(r.pages_completed,2);assert.equal(await tool.run(args),JSON.stringify(r));assert.equal(calls,2);}finally{globalThis.fetch=old;}
});
test('error on later page preserves findings and does not assert completion',async()=>{
  const old=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>++calls===1?{ok:true,json:async()=>({files:[{id:'first'}],nextPageToken:'next'})}:{ok:false,status:503,text:async()=>'unavailable'};
  try{const tool=googleTools({token:async()=>'MOCK',caps:{drive:{read:true}}}).find(t=>t.name==='drive_search');const r=JSON.parse(await tool.run({query:'x',complete:true}));assert.equal(r.partial,true);assert.equal(r.completion_reason,'page_failed');assert.equal(r.items.length,1);}finally{globalThis.fetch=old;}
});
test('coverage retains account/reason; completed chain clears only its own warning',async()=>{
  let reply={search_id:'one',query:'q',page:1,partial:true,has_more:true};
  const tracker=trackSearchPagination([{name:'drive_search',run:async()=>JSON.stringify(reply)}],{account:'work@example.invalid'});
  const turn=turnSearchCoverage();await tracker.tools[0].run({query:'q'});turn.observe(true,{nonEmailPartial:true,nonEmailCoverage:tracker.coverage()});
  let out=turn.finish('Encontrei a escala.');assert.match(out,/Drive \(work@example.invalid\): ainda há resultados por conferir/);assert.doesNotMatch(out,/⚠️|erro\/limite|query_failed/);assert.match(preserveSearchCoverageWarning(out,'Encontrei a escala.'),/resultados por conferir/);
  reply={...reply,page:2,partial:false,has_more:false};await tracker.tools[0].run({query:'q'});turn.observe(false,{nonEmailPartial:false,nonEmailCoverage:tracker.coverage()});assert.equal(turn.hasPartial(),false);assert.equal(turn.finish('Achei.'),'Achei.');
  reply={...reply,page:1,partial:true,has_more:true};await tracker.tools[0].run({query:'q'});assert.equal(tracker.hasPartial(),false);
});
test('pruning retains filenames and continuation instead of forgetting the search',()=>{
  const r={search_id:'s',query:'q',page:2,partial:true,has_more:true,next_cursor:'latest',items:[{id:'sheet',name:'Escala',webViewLink:'https://docs.google.com/spreadsheets/d/sheet/edit',unnecessary:'x'.repeat(10000)}]};
  const kept=JSON.parse(retainedSearchPage(JSON.stringify(r),'drive_search'));assert.equal(kept.next_cursor,'latest');assert.equal(kept.items[0].name,'Escala');assert.equal(kept.items[0].unnecessary,undefined);assert.equal(retainedSearchPage(JSON.stringify(r),'execute_code'),null);
});
test('partial search qualifies direct absence claims while preserving titles and attributed facts',()=>{
  for(const text of ['Não há planilha de férias.','Não existe arquivo compartilhado.','Também não vi nada compartilhado com você.','Lista completa.']) {
    assert.notEqual(guardConnectorSearchClaims(text,{partial:true}),text);
    assert.equal(guardConnectorSearchClaims(text,{partial:false}),text);
  }
  for(const text of ['A planilha "Lista completa de férias" foi localizada na pasta RH.','Segundo o documento, não tem planilhas anexas.','Encontrei [Lista completa de férias](https://docs.google.com/spreadsheets/d/real/edit).']) {
    assert.equal(guardConnectorSearchClaims(text,{partial:true}),text);
  }
});
test('90-item result preserves handoff loss across repeated pruning and distinguishes it from API failure',async()=>{
  const original={search_id:'many',query:'compiled',page:6,pages_completed:6,returned:90,partial:false,has_more:false,next_cursor:null,
    items:Array.from({length:90},(_,i)=>({id:String(i),name:'Férias da equipe '.repeat(12),webViewLink:'https://docs.google.com/spreadsheets/d/'+String(i)+'x'.repeat(100)}))};
  const first=JSON.parse(retainedSearchPage(JSON.stringify(original),'drive_search'));
  assert.equal(first.evidence_limited,true);assert.equal(first.partial,true);
  assert.equal(first.retained_items,first.items.length);assert.ok(first.items.length<90);assert.equal(first.returned,90);
  const second=JSON.parse(retainedSearchPage(JSON.stringify(first),'drive_search'));
  assert.equal(second.evidence_limited,true);assert.equal(second.retained_items,second.items.length);
  const tracker=trackEmailPagination([{name:'drive_search',run:async()=>JSON.stringify(original)}],{account:'work@example.invalid'});
  await tracker.tools[0].run({query:'x'});assert.equal(tracker.hasPartial(),false);
  tracker.observeRetainedResults([{role:'tool',name:'drive_search',content:JSON.stringify(second)}]);
  assert.equal(tracker.hasPartial(),true);
  const turn=turnSearchCoverage();turn.observe(true,{nonEmailPartial:true,nonEmailCoverage:tracker.nonEmailCoverage()});
  const text=turn.finish('Lista completa.');
  assert.match(text,/Drive \(work@example.invalid\): parte dos resultados ficou fora da análise/);
  assert.doesNotMatch(text,/Lista completa|não consegui concluir uma consulta|o serviço não devolveu/);
  const wa=preserveSearchCoverageWarning(text,'Resumo.');assert.match(wa,/parte dos resultados ficou fora da análise/);
});
