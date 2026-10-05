// Offline: funções reais extraídas sem importar conectores/server nem abrir serviços.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const blocked = () => { throw Error('Real I/O blocked'); };
net.Socket.prototype.connect = blocked; tls.connect = blocked; globalThis.fetch = blocked;
for (const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp[n] = blocked;
syncBuiltinESMExports();
const src = fs.readFileSync(new URL('./web/connectors.mjs', import.meta.url), 'utf8');
const between = (a,b) => { const start=src.indexOf(a),end=src.indexOf(b,start); assert(start>=0&&end>start); return src.slice(start,end); };
const code = [between('async function gget(', '// Uma busca anterior'), between('const validDriveId', '// PATCH JSON autenticado'),src.slice(src.indexOf('async function findFileInFolder('))].join('\n').replaceAll('export async function ', 'async function ');
let count=0;
const eq=(a,b)=>{assert.deepEqual(a,b);count++};
const ok=x=>{assert(x);count++};
const file=(id='original',name='fixture.xlsx')=>({id,name,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
const folder=(id='owned-folder')=>({id,name:'Assistant',mimeType:'application/vnd.google-apps.folder'});
function harness(replies,{tokenError=false}={}) {
 const calls=[]; let tokenCalls=0;
 const c=vm.createContext({Buffer,DRIVE:'https://www.googleapis.com/drive/v3',b64urlEncode:x=>Buffer.from(x).toString('base64url'), fetch:async(url,options={})=>{
  const call={url,method:options.method||'GET',body:options.body,headers:options.headers}; calls.push(call);
  assert(replies.length,'Unexpected mock HTTP call'); let fixture=replies.shift();
  if(fixture instanceof Error) throw fixture;
  if(typeof fixture==='function')fixture=fixture(call);
  return {ok:!fixture.status||fixture.status<400,status:fixture.status||200,text:async()=>fixture.error||'SYNTHETIC_PRIVATE_REMOTE_ERROR',json:async()=>{if(fixture.invalidJson)throw Error('SYNTHETIC_PRIVATE_JSON');return fixture.body}};
 }});
 vm.runInContext(code+'\nglobalThis.api={ensureAssistantFolder,uploadBinaryToDrive};',c);
 const token=async()=>{tokenCalls++;if(tokenError)throw Error('SYNTHETIC_PRIVATE_TOKEN');return 'mock-token'};
 const upload=(args={})=>c.api.uploadBinaryToDrive({token,name:'fixture.xlsx',buffer:Buffer.from([0,10,255,66]),mimeType:'application/test',folderId:'owned-folder',...args});
 const flow=async()=>upload({folderId:await c.api.ensureAssistantFolder(token,'Assistant')});
 return {calls,upload,flow,folder:()=>c.api.ensureAssistantFolder(token,'Assistant'),remaining:()=>replies.length,tokens:()=>tokenCalls};
}
const good=b=>({body:b});
const failures=[new Error('SYNTHETIC_PRIVATE_NETWORK'),... [400,401,403,404,408,429,500,502,503].map(status=>({status})),{invalidJson:true},... [null,{},[],{files:null},{files:{}},{files:[null]},{files:[{}]},{files:[file('')]},{files:[file('bad/id')]},{files:[{...file(),mimeType:null}]},{files:[],nextPageToken:null},{files:[],nextPageToken:123},{files:[],incompleteSearch:'false'},{files:[file()],nextPageToken:'more'},{files:[],nextPageToken:'more'},{files:[file()],incompleteSearch:true},{files:[],incompleteSearch:true},{files:[file(),file('second')]}].map(good)];
for(const f of failures)for(const stage of ['file','folder']) {
 const h=harness([f]); let error;
 try {await (stage==='file'?h.upload():h.flow())}catch(e){error=e}
 ok(error);ok(!error.message.includes('SYNTHETIC_PRIVATE'));eq(h.calls.filter(c=>c.method!=='GET').length,0);eq(h.calls.length,1);
}
// Nenhum erro de credencial no lookup vira criação, nem do arquivo nem da pasta.
for(const stage of ['file','folder']) {
 const h=harness([],{tokenError:true});await assert.rejects(stage==='file'?h.upload():h.flow());count++;eq(h.calls.length,0);
}
// Resultado único preserva bytes, pasta e ID/link; query pede prova de completude.
{
 const h=harness([good({files:[file()]}),good({id:'original',name:'fixture.xlsx',webViewLink:'https://example.invalid/original'})]);
 const r=await h.upload();eq(r.updated,true);eq(r.id,'original');eq(r.webViewLink,'https://example.invalid/original');eq(h.calls.map(c=>c.method),['GET','PATCH']);eq(h.calls[1].body,Buffer.from([0,10,255,66]));eq(h.calls[1].headers['content-type'],'application/test');
 const u=new URL(h.calls[0].url);eq(u.searchParams.get('pageSize'),'2');eq(u.searchParams.get('fields'),'nextPageToken,incompleteSearch,files(id,name,mimeType)');ok(u.searchParams.get('q').includes("'owned-folder' in parents"));ok(u.searchParams.get('q').includes('trashed = false'));eq(h.remaining(),0);
}
// Vazio confirmado é o único caminho normal para criar; multipart conserva bytes.
{
 const h=harness([good({files:[],nextPageToken:'',incompleteSearch:false}),good({id:'new',name:'fixture.xlsx'})]);const r=await h.upload();eq(r.updated,false);eq(h.calls.map(c=>c.method),['GET','POST']);ok(h.calls[1].body.includes(Buffer.from([0,10,255,66])));ok(h.calls[1].body.toString().includes('"parents":["owned-folder"]'));
}
// Escape da query e rejeição de IDs/localização sem emitir rede.
{
 const name="A'B\\C.xlsx";const h=harness([good({files:[file('original',name)]}),good({id:'original'})]);await h.upload({name});const q=new URL(h.calls[0].url).searchParams.get('q');ok(q.includes("name = 'A\\'B\\\\C.xlsx'"));
}
for(const args of [{folderId:null},{folderId:''},{folderId:"x' or true"},{folderId:'../x'},{name:''},{name:'   '},{name:null}]) {
 const h=harness([]);await assert.rejects(h.upload(args));count++;eq(h.calls.length,0);
}
for(const bad of [folder(),file('original','different.xlsx')]) {
 const h=harness([good({files:[bad]})]);await assert.rejects(h.upload());count++;eq(h.calls.filter(c=>c.method!=='GET').length,0);
}
// Pasta única reutilizada, pasta realmente ausente criada uma vez. Sem HTTP real.
{
 const h=harness([good({files:[folder()]}),good({files:[file()]}),good({id:'original'})]);const r=await h.flow();eq(r.updated,true);eq(h.calls.map(c=>c.method),['GET','GET','PATCH']);ok(new URL(h.calls[0].url).searchParams.get('q').includes('appProperties has'));
}
{
 const h=harness([good({files:[]}),good({id:'new-folder'}),good({files:[]}),good({id:'new'})]);const r=await h.flow();eq(r.updated,false);eq(h.calls.map(c=>c.method),['GET','POST','GET','POST']);const body=JSON.parse(h.calls[1].body);eq(body.appProperties,{brambsAssistant:'1'});ok(new URL(h.calls[2].url).searchParams.get('q').includes("'new-folder' in parents"));
}
{
 const h=harness([good({files:[file()]})]);await assert.rejects(h.flow());count++;eq(h.calls.length,1);
}
for(const bad of [null,{}, {id:''},{id:'bad/id'}]) {
 const h=harness([good({files:[]}),good(bad)]);await assert.rejects(h.flow());count++;eq(h.calls.map(c=>c.method),['GET','POST']);
}
// HTTP de escrita falha: NÃO há fallback para POST nem retry automático.
for(const status of [401,403,404,409,412,429,500,503])for(const exists of [true,false]) {
 const h=harness([good({files:exists?[file()]:[]}),{status}]);await assert.rejects(h.upload());count++;eq(h.calls.map(c=>c.method),['GET',exists?'PATCH':'POST']);
}
// Opção interna explícita de criar cópia continua sendo criação (sem lookup).
{
 const h=harness([good({id:'new'})]);const r=await h.upload({update:false});eq(r.updated,false);eq(h.calls.map(c=>c.method),['POST']);
}
console.log(`${count} verificações aprovadas; lookup do arquivo e da pasta, ambiguidades, falhas, bytes e fluxos reais em VM. Zero API/DB/canal real.`);
