// Offline dry-run: no real DB, accounts, providers or channels.
import assert from 'node:assert/strict';
import net from 'node:net'; import tls from 'node:tls'; import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module'; import { readFileSync } from 'node:fs';
const denied=()=>{throw Error('REAL I/O FORBIDDEN');};
net.Socket.prototype.connect=denied; tls.connect=denied; globalThis.fetch=denied;
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp[name]=denied;
syncBuiltinESMExports();
const { googleTools }=await import('./web/connectors.mjs');
const { githubTools,slackTools,microsoftTools }=await import('./web/connectors-ext.mjs');
const { searchPagination,graphSearchNextPath,githubSearchMeta,slackSearchMeta,trackSearchPagination }=await import('./web/search-pagination.mjs');
const { trackEmailPagination }=await import('./web/email-pagination.mjs');
const { driveSearchQuery }=await import('./web/drive-search.mjs');
const { runAgent,ToolRegistry }=await import('./core-proto/core.mjs');
let checks=0,queue=[],requests=[];
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;},ok=a=>{assert.ok(a);checks++;};
const reject=async f=>{await assert.rejects(f);checks++;},throws=f=>{assert.throws(f);checks++;};
const token=async()=> 'MOCK_ONLY';
const factories={
 drive_search:()=>googleTools({token,caps:{drive:{read:true}}}),
 onedrive_search:()=>microsoftTools({token}),
 slack_search:()=>slackTools({token}),
 github_search_repos:()=>githubTools({token}),
 github_search_issues:()=>githubTools({token}),
};
const tool=name=>factories[name]().find(t=>t.name===name);
const mock=(...rs)=>{assert.equal(queue.length,0);queue=rs;requests=[];};
globalThis.fetch=async(url,opts={})=>{
 assert.equal(opts.method ?? 'GET','GET');assert.equal(opts.headers.Authorization,'Bearer MOCK_ONLY');
 const u=new URL(url);assert.ok(['www.googleapis.com','graph.microsoft.com','slack.com','api.github.com'].includes(u.hostname));
 if(u.hostname==='graph.microsoft.com')assert.equal(opts.redirect,'error');
 requests.push(u);assert.ok(queue.length,'No unexpected network');const j=queue.shift();
 return j.error ? {ok:false,status:j.error,text:async()=> 'MOCK ERROR',json:async()=>({ok:false,error:'MOCK_ERROR'})} : {ok:true,status:200,json:async()=>j};
};
const graphLink="https://graph.microsoft.com/v1.0/me/drive/root/search(q='alvo')?$skiptoken=a%2Bb%3D&$top=1";
const response=(name,page=1,more=true)=>{
 const id=page===1?'primeiro':'alvo';
 if(name==='drive_search')return {files:[{id,name:id}],...(more?{nextPageToken:'native+/token='}:{})};
 if(name==='onedrive_search')return {value:[{id,name:id}],...(more?{'@odata.nextLink':graphLink}:{})};
 if(name==='slack_search')return {ok:true,messages:{matches:[{ts:id,text:id}],paging:{page,pages:more?2:page,total:2}}};
 return {items:[{number:page,title:id,full_name:id}],total_count:2,incomplete_results:false};
};
// Five real tools: target only on the second page, private state/cursor.
for(const name of Object.keys(factories)){
 const t=tool(name);const args={query:'alvo',max:1};
 mock(response(name));const first=JSON.parse(await t.run(args));
 eq(first.items.length,1);eq(first.page,1);eq(first.page_size,1);eq(first.partial,true);eq(first.has_more,true);ok(first.next_cursor);ok(first.note.includes('PARCIAL'));eq(requests.length,1);
 ok(!first.next_cursor.includes('native'));ok(!first.next_cursor.includes('https:'));
 mock(response(name,2,false));const second=JSON.parse(await t.run({query:'alvo',cursor:first.next_cursor}));
 eq(second.page,2);eq(second.search_id,first.search_id);eq(second.has_more,false);eq(second.partial,false);eq(second.next_cursor,null);ok(JSON.stringify(second.items).includes('alvo'));eq(requests.length,1);
 if(name==='drive_search'){eq(requests[0].searchParams.get('pageToken'),'native+/token=');ok(requests[0].searchParams.get('fields').includes('incompleteSearch'));}
 if(name==='onedrive_search')eq(requests[0].href,graphLink);
 if(name.startsWith('github') || name==='slack_search')eq(requests[0].searchParams.get('page'),'2');
 for(const max of [0,-1,1.5,null,'2',Infinity,NaN,{}])await reject(()=>t.run({query:'alvo',max}));
 for(const query of [null,4,{},[], 'x'.repeat(2049)])await reject(()=>t.run({query}));
 for(const cursor of ['',null,'fake','https://evil.invalid',{},3])await reject(()=>t.run({query:'alvo',cursor}));
 await reject(()=>t.run({query:'outra',cursor:first.next_cursor}));
 await reject(()=>t.run({query:'alvo',max:2,cursor:first.next_cursor}));
 await reject(()=>tool(name).run({query:'alvo',cursor:first.next_cursor}));
 // Drive intentionally reuses identical page reads inside one tool instance.
 // A new instance exercises the provider error instead of its successful cache.
 mock({error:429});await reject(()=>tool(name).run(args));eq(requests.length,1);
}
// Default limits and existing cap, no automatic scanning.
for(const [name,def,cap] of [['drive_search',8,15],['onedrive_search',10,25],['slack_search',10,20],['github_search_repos',8,15],['github_search_issues',10,20]]){
 for(const [max,size] of [[undefined,def],[999,cap]]){
  mock(response(name));const r=JSON.parse(await tool(name).run({query:'alvo',max}));eq(r.page_size,size);eq(requests.length,1);
 }
}
// Invalid arguments must remain invalid after warming the Drive page cache:
// null/NaN/Infinity cannot alias omitted fields and bypass cursor/max validation.
{
 const cachedDrive=tool('drive_search');mock({files:[]});await cachedDrive.run({query:'cache aquecido'});
 mock();
 for(const invalid of [{max:null},{max:NaN},{max:Infinity},{cursor:null}])await reject(()=>cachedDrive.run({query:'cache aquecido',...invalid}));
 eq(requests.length,0);
}
// Drive: cursor identity is the compiled query, including escaped literals and
// adapter-owned filters. Never use the raw text as if it were provider syntax.
const d=tool('drive_search');mock({files:[]});let r=JSON.parse(await d.run({query:"O'Reilly\\arquivo"}));
eq(r.query,driveSearchQuery({query:"O'Reilly\\arquivo"}));eq(r.query,requests[0].searchParams.get('q'));ok(r.query.includes("O\\'Reilly\\\\arquivo"));eq(r.partial,false);
mock({files:[],nextPageToken:'A',incompleteSearch:true});const di=JSON.parse(await d.run({query:'alvo'}));eq(di.partial,true);ok(di.next_cursor);
mock({files:[]});r=JSON.parse(await d.run({query:'alvo',cursor:di.next_cursor}));eq(r.has_more,false);eq(r.partial,true);eq(r.incomplete_search,true);
mock({files:[],incompleteSearch:true});r=JSON.parse(await d.run({query:'alvo sem páginas'}));eq(r.partial,true);eq(r.has_more,false);
mock({});r=JSON.parse(await d.run({query:'vazio'}));eq(r.items,[]);eq(r.partial,false);
// Ciclo A -> B -> A termina sem emitir cursor infinito.
mock({files:[],nextPageToken:'A'});const da=JSON.parse(await d.run({query:'ciclo'}));
mock({files:[],nextPageToken:'B'});const db=JSON.parse(await d.run({query:'ciclo',cursor:da.next_cursor}));
mock({files:[],nextPageToken:'A'});r=JSON.parse(await d.run({query:'ciclo',cursor:db.next_cursor}));eq(r.partial,true);eq(r.next_cursor,null);ok(r.note.includes('repetiu'));
for(const bad of [null,[],{files:null},{files:{}},{files:[null]},{files:[{}]},{files:Array(9).fill({id:'x'})},{files:[],incompleteSearch:'false'},{files:[],nextPageToken:''}]){mock(bad);await reject(()=>d.run({query:'bad'}));}
// OneDrive: root and search, full nextLink, without crossing account/path/origin.
const od=tool('onedrive_search'),rootLink='https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=root';
mock({value:[],'@odata.nextLink':rootLink});const root=JSON.parse(await od.run());eq(root.partial,true);
mock({value:[]});r=JSON.parse(await od.run({cursor:root.next_cursor}));eq(requests[0].href,rootLink);eq(r.partial,false);
for(const link of ['https://evil.invalid/v1.0/me/drive/root/children','http://graph.microsoft.com/v1.0/me/drive/root/children',rootLink+'#fragment',rootLink+'\n','https://graph.microsoft.com@evil.invalid/v1.0/me/drive/root/children','https://graph.microsoft.com/v1.0/users/other/drive/root/children','https://graph.microsoft.com/v1.0/me/messages','https://graph.microsoft.com/v1.0/me/drive/root/children\\bad',graphLink]){
 throws(()=>graphSearchNextPath(link,'/me/drive/root/children'));
 mock({value:[],'@odata.nextLink':link});await reject(()=>od.run());eq(requests.length,1);
}
for(const bad of [null,{}, {value:null},{value:{}},{value:[{}]},{value:Array(11).fill({id:'x'})}]){mock(bad);await reject(()=>od.run());}
mock();const restricted=microsoftTools({token,scopes:'User.Read Mail.Read'}).find(t=>t.name==='onedrive_search');ok((await restricted.run()).includes('conect'));eq(requests.length,0);
// GitHub: partial timeout even without a cursor; limit of 1000 doesn't turn into a complete search.
for(const name of ['github_search_repos','github_search_issues']){
 const t=tool(name);mock({items:[],total_count:0,incomplete_results:true});r=JSON.parse(await t.run({query:'timeout'}));eq(r.partial,true);eq(r.has_more,false);
 for(const bad of [{},{items:null,total_count:0,incomplete_results:false},{items:[],total_count:'0',incomplete_results:false},{items:[],total_count:0,incomplete_results:'false'}]){mock(bad);await reject(()=>t.run({query:'bad'}));}
}
let meta=githubSearchMeta({total_count:1001,incomplete_results:false},{page:50,pageSize:20});eq(meta.next,null);eq(meta.limitReached,true);
meta=githubSearchMeta({total_count:1000,incomplete_results:false},{page:50,pageSize:20});eq(meta.limitReached,false);
meta=githubSearchMeta({total_count:1001,incomplete_results:false},{page:49,pageSize:20});eq(meta.next,'50');
// Real pagination of the tools up to the limit, with synthetic responses (no API).
for(const [name,size,count] of [['github_search_repos',15,67],['github_search_issues',20,50]]) {
 const t=tool(name);let cursor;
 for(let n=1;n<=count;n++) {
  mock({items:[],total_count:1001,incomplete_results:false});
  const page=JSON.parse(await t.run({query:'limite',max:size,cursor}));
  eq(page.page,n);eq(requests[0].searchParams.get('page'),String(n));cursor=page.next_cursor;
  if(n<count)ok(cursor);else {eq(cursor,null);eq(page.partial,true);ok(page.note.includes('limite'));}
 }
}
// Slack: both metadata versions, snippet truncation, page100 limit.
const sl=tool('slack_search');mock({ok:true,messages:{matches:[{ts:'1',text:'x'.repeat(801)}],pagination:{page:1,page_count:1,total_count:1}}});
r=JSON.parse(await sl.run({query:'texto'}));eq(r.items[0].text.length,800);eq(r.items[0].text_truncated,true);eq(r.partial,false);
mock({ok:true,messages:{matches:[],paging:{page:1,pages:0,total:0}}});r=JSON.parse(await sl.run({query:'vazio'}));eq(r.partial,false);
for(const bad of [{ok:true},{ok:true,messages:{matches:[],paging:{page:2,pages:2,total:20}}},{ok:true,messages:{matches:[],paging:{page:1,pages:'1',total:0}}}]){mock(bad);await reject(()=>sl.run({query:'bad'}));}
meta=slackSearchMeta({messages:{paging:{page:100,pages:101,total:2020}}},{page:100,pageSize:20});eq(meta.next,null);eq(meta.limitReached,true);
// TTL, cache, chain limit and errors before any API.
let time=0;const pg=searchPagination({defaultMax:1,cap:2,now:()=>time});const req=pg.request('x');
const old=JSON.parse(pg.result(req,[] ,{next:'A'}));time=900000;throws(()=>pg.request('x',undefined,old.next_cursor));
const first=JSON.parse(pg.result(req,[],{next:'A'}));for(let i=0;i<100;i++)pg.result(req,[],{next:String(i)});
throws(()=>pg.request('x',undefined,first.next_cursor));
r=JSON.parse(pg.result({...req,page:200},[],{next:'more'}));eq(r.partial,true);eq(r.has_more,true);eq(r.next_cursor,null);
// Real wrapper used by the server keeps the notice flowing worker -> main.
let reply={search_id:'a',partial:true};const fake={name:'drive_search',run:async()=>JSON.stringify(reply)};
const tracker=trackEmailPagination([fake,{name:'unrelated',run:async()=> 'raw'}]);
await tracker.tools[0].run({});ok(tracker.finish('Nada.').includes('AVISO DE BUSCA PARCIAL'));
reply={search_id:'b',partial:false};await tracker.tools[0].run({});ok(tracker.finish('Outra busca.').includes('AVISO'));
reply={search_id:'a',partial:false};await tracker.tools[0].run({});eq(tracker.finish('Concluiu'),'Concluiu');eq(await tracker.tools[1].run({}),'raw');
for(const action of [async()=> 'Reconecte sua conta',async()=>{throw Error('erro simulado');}]){
 const tr=trackSearchPagination([{name:'slack_search',run:action}]);try{await tr.tools[0].run({});}catch{}ok(tr.finish('Nada').includes('AVISO'));
}
// Real tool-loop and real orchestration functions (server never imported).
const {createEmailResearchSession}=await import('./web/email-research-session.mjs');
const {EMAIL_RESEARCH_CONTRACT}=await import('./web/email-answer-contract.mjs');
const src=readFileSync('./web/server.mjs','utf8');
const orchestration=(name,provider)=>{
 const a=src.indexOf('async function '+name+'('),b=src.indexOf('\n}\n',a)+2;
 const deps={ToolRegistry,runAgent,makeSubagentProvider:()=>provider,trackEmailPagination,createEmailResearchSession,EMAIL_RESEARCH_CONTRACT,comIdioma:x=>x,GOOGLE_SUBAGENT_SYSTEM:'mock system'};
 return new Function(...Object.keys(deps),src.slice(a,b)+';return '+name)(...Object.values(deps));
};
for(const name of Object.keys(factories)) for(const complete of [false,true]){
 mock(response(name),...(complete?[response(name,2,false)]:[]));let step=0;
 const provider={name:'fake',complete:async({messages})=>{
  if(++step===1)return {stop:'tool',toolCalls:[{id:'1',name,args:{query:'alvo',max:1}}]};
  const result=JSON.parse(messages.filter(m=>m.role==='tool').at(-1).content);
  if(step===2 && complete)return {stop:'tool',toolCalls:[{id:'2',name,args:{query:'alvo',cursor:result.next_cursor}}]};
  return {stop:'end',text:complete?'Encontrado alvo':'Não encontrado (síntese omitiu limite).'};
 }};
 const run=orchestration(name==='drive_search'?'runGoogleSubagent':'runConnectorSubagent',provider);
 const text=await run({objetivo:'simulado',system:'mock',readTools:[tool(name)]});
 eq(text.includes('AVISO DE BUSCA PARCIAL'),!complete);eq(requests.length,complete?2:1);
}
eq(queue.length,0);console.log(`${checks} verificações aprovadas: cinco tools, cursores, isolamento, limites, erros e tool-loop real com I/O simulado.`);
