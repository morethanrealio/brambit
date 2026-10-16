import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import http from 'node:http';
import net from 'node:net';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {readBody,readRaw} from '../web/http-body.mjs';
import {createCodingJobs,codingJobScope} from '../web/coding-jobs.mjs';
import {readOnlyCommand} from '../web/read-only-command.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('request reader rejects error/abort/early close, handles late error, and decodes split UTF8 once',async()=>{
 for(const reader of [readBody,readRaw])for(const failure of ['error','aborted','close']){
  const req=new EventEmitter(),pending=reader(req),rejected=assert.rejects(pending,{code:'REQUEST_BODY_INTERRUPTED'});
  req.emit('data',Buffer.from('{'));req.emit(failure,Error('synthetic'));
  if(failure!=='close'){assert.doesNotThrow(()=>req.emit('error',Error('late transport error')));req.emit('close');}
  await rejected;assert.equal(req.listenerCount('data'),0);assert.equal(req.listenerCount('error'),0);
 }
 const req=new EventEmitter(),pending=readBody(req),raw=Buffer.from('{"text":"ação"}');
 for(const byte of raw)req.emit('data',Buffer.from([byte]));req.emit('end');req.emit('error',Error('late'));req.emit('close');
 assert.deepEqual(await pending,{text:'ação'});
 const empty=new EventEmitter(),p=readBody(empty);empty.emit('end');empty.emit('close');assert.deepEqual(await p,{});
 const interrupted=new EventEmitter();interrupted.aborted=true;
 const rejected=assert.rejects(readBody(interrupted),{code:'REQUEST_BODY_INTERRUPTED'});
 assert.doesNotThrow(()=>interrupted.emit('error',Error('already aborted')));interrupted.emit('close');await rejected;
});
test('a real client disconnect mid-body leaves the HTTP service able to answer the next request',{timeout:10000},async()=>{
 const accepted=deferred(),interrupted=deferred();let failures=0;
 const server=http.createServer(async(req,res)=>{accepted.resolve();try{const body=await readBody(req);res.end(JSON.stringify(body));}catch(e){failures++;interrupted.resolve(e);res.destroy();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 try{
  const socket=net.connect(port,'127.0.0.1');socket.on('error',()=>{});
  await new Promise(r=>socket.once('connect',r));socket.write('POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 999\r\n\r\n{"partial":');
  await accepted.promise;socket.destroy();assert.equal((await interrupted.promise).code,'REQUEST_BODY_INTERRUPTED');
  const response=await new Promise((resolve,reject)=>{const q=http.request({host:'127.0.0.1',port,method:'POST',agent:new http.Agent(),headers:{'content-type':'application/json'}},res=>{let s='';res.on('data',x=>s+=x);res.on('end',()=>resolve([res.statusCode,s]));});q.on('error',reject);q.end('{"alive":true}');});
  assert.deepEqual(response,[200,'{"alive":true}']);assert.equal(failures,1);
 }finally{await new Promise(r=>server.close(r));}
});
function jobStore(){
 const records=new Map(),locks=new Map();
 return {records,read:async k=>structuredClone(records.get(k)||null),entries:async()=>[...records].map(([scope,record])=>({scope,record:structuredClone(record)})),
  withTask:async(k,fn)=>{const before=locks.get(k)||Promise.resolve(),d=deferred();locks.set(k,d.promise);await before;try{return await fn({record:structuredClone(records.get(k)||null),save:async r=>records.set(k,structuredClone(r))});}finally{d.resolve();}}};
}
test('delivering a terminal job cannot release the user slot held by another executing job',async()=>{
 const store=jobStore(),started=deferred(),finish=deferred();let runs=0;
 const jobs=createCodingJobs({store,concurrency:3,execute:async()=>{runs++;started.resolve();await finish.promise;return {coding_task:{state:'completed'}};},deliver:async()=>{}});
 const ident=t=>({userId:'synthetic',agentId:'a',threadId:t}),input={kind:'advanced',args:{objetivo:'fixture'}};
 for(const t of ['active','terminal','waiting'])await jobs.submit(ident(t),input,t);
 const terminal=codingJobScope(ident('terminal'));store.records.get(terminal).state='completed';
 const active=jobs.drive(codingJobScope(ident('active')));await started.promise;
 await jobs.drive(terminal);assert.equal((await jobs.metrics()).activeUsers,1);
 await jobs.drive(codingJobScope(ident('waiting')));assert.equal(runs,1,'second execution for same user stays queued');
 finish.resolve();await active;await jobs.drive(codingJobScope(ident('waiting')));assert.equal(runs,2);assert.equal((await jobs.metrics()).activeUsers,0);
});
test('a terminal snapshot that becomes queued before locking must claim a user slot',async()=>{
 const store=jobStore(),started=deferred(),finish=deferred();let runs=0;
 const jobs=createCodingJobs({store,concurrency:3,execute:async()=>{runs++;started.resolve();await finish.promise;return {coding_task:{state:'completed'}};},deliver:async()=>{}});
 const ident=t=>({userId:'synthetic',agentId:'a',threadId:t}),input={kind:'advanced'};
 await jobs.submit(ident('active'),input,'1');await jobs.submit(ident('race'),input,'2');const race=codingJobScope(ident('race'));
 const active=jobs.drive(codingJobScope(ident('active')));await started.promise;
 store.records.get(race).state='completed';const orig=store.withTask;
 store.withTask=async(k,fn)=>{if(k===race)store.records.get(k).state='queued';return orig(k,fn);};
 await jobs.drive(race);assert.equal(runs,1);assert.equal((await jobs.metrics()).activeUsers,1);
 finish.resolve();await active;
});
test('read-only tool rejects writes and executable input before reaching its transport',async()=>{
 process.env.DEVEXEC_URL='https://runner.invalid';process.env.DEVEXEC_TOKEN='synthetic-token';
 const {codingTools}=await import('../web/coding.mjs');const commands=[],original=globalThis.fetch;
 globalThis.fetch=async(url,opts)=>{assert.equal(new URL(url).hostname,'runner.invalid');commands.push(JSON.parse(opts.body).cmd);return {status:200,text:async()=>JSON.stringify({ok:true,saida:'fixture'})};};
 try{
  const tool=codingTools('synthetic',{project:{ownerUserId:'synthetic',nome:'fixture'}}).find(x=>x.name==='rodar_leitura');
  for(const comando of ['touch /tmp/new','python -c "write()"','node --check a.js','npm test','git diff','find . -delete','sed -n "e touch /tmp/x" a','ls; touch x','ls\ntrue','cat $(touch x)','cat `touch x`','cat a > b','ls | sh','FOO=x ls','/tmp/ls','cat <(echo a)','cat "unterminated','ls *','ls \\']){
   assert.equal(readOnlyCommand(comando),null,comando);assert.match(await tool.run({comando}),/não pertence/);
  }
  assert.equal(commands.length,0);
  for(const comando of ['ls -la','cat "a b.txt"',"cat 'a'\\''b.txt'",'head -n 3 -- file','pwd'])assert.equal(await tool.run({comando}),'fixture');
  assert.deepEqual(commands,["command -p 'ls' '-la'","command -p 'cat' 'a b.txt'","command -p 'cat' 'a'\\''b.txt'","command -p 'head' '-n' '3' '--' 'file'","command -p 'pwd'"]);
 }finally{globalThis.fetch=original;}
});
test('PDF extraction records no Tavily usage; real HTML extraction still records provider usage',async()=>{
 const source=readFileSync(new URL('../web/websearch.mjs',import.meta.url),'utf8');
 const functionCode=source.slice(source.indexOf('export function openLinkTool'),source.indexOf('// ── REVERSE image search')).replace('export function','function');
 let pdf=true,providerCalls=0,saves=0;const usages=[];
 const quality=await import('../web/page-content-quality.mjs');const {uaBot}=await import('../web/marca.mjs');
 const context={Buffer,console,uaBot,...quality,assertPublicUrl:async()=>{},safeFetch:async()=>({headers:{get:()=>pdf?'application/pdf':'text/html'},arrayBuffer:async()=>new ArrayBuffer(4),body:{cancel:async()=>{}}}),nameFromUrl:()=> 'fixture.pdf',extractPdfText:async()=>({text:'PDF text',pages:1}),tavilyEnabled:()=>true,tavilyExtract:async()=>{providerCalls++;return {text:'HTML text',url:'https://fixture.invalid',usage:{model:'tavily-search',total:1}};},lerPaginaDireto:async()=>({texto:'HTML text',url:'https://fixture.invalid'}),recortarPagina:text=>({corpo:text,corte:''}),exportGoogleSheets:()=>null,nomeDoDownload:(_r,f)=>f,nomeDoPath:()=>'',tipoPlanilha:()=>null};
 const make=vm.runInNewContext(functionCode+';openLinkTool;',context),tool=make({onUsage:u=>usages.push(u),savePdf:async()=>saves++});
 assert.match(await tool.run({url:'https://fixture.invalid/document.pdf'}),/PDF text/);assert.equal(saves,1);assert.equal(providerCalls,0);assert.equal(usages.length,0);
 pdf=false;assert.match(await tool.run({url:'https://fixture.invalid/page'}),/HTML text/);assert.equal(providerCalls,1);assert.equal(usages.length,1);assert.equal(usages[0].usage.model,'tavily-search');
});
