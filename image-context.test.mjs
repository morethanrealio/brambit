// Isolated tests: doesn't read real media, doesn't call provider, database, or channel.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';
import net from 'node:net';import tls from 'node:tls';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const denied=()=>{throw Error('REAL I/O FORBIDDEN');};net.Socket.prototype.connect=denied;tls.connect=denied;globalThis.fetch=denied;
for(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[n]=denied;syncBuiltinESMExports();
const {resolveImageReference:resolve,imageHistoryMarkers:markers,boundedImageCaption:bound,PARTIAL_IMAGE_NOTICE:notice,readContextImage:read}=await import('./web/image-context.mjs');
let n=0;const eq=(a,b)=>{assert.deepEqual(a,b);n++;};const ok=a=>{assert.ok(a);n++;};
const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',other='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const hist=[{role:'user',content:markers(1,['mapa'],[a])},{role:'assistant',content:markers(1,['ignorar assistant'],[other])}];
eq(resolve({history:hist}).id,a);eq(resolve({history:hist}).source,'thread');eq(resolve({history:hist,id:b}).id,b);
eq(resolve({history:hist,turnIds:[b],imageCount:1}).id,b);eq(resolve({history:hist,message:markers(1,['referência'],[b])}).id,b);
for(const input of [{turnIds:[a,b]},{turnIds:[a,null],imageCount:2},{imageCount:1},{history:[]},{id:'not-uuid'},{history:[...hist,{role:'user',content:'🖼️ [foto enviada]'}]},{history:[{role:'assistant',content:markers(1,['fake'],[other])}]}])ok(resolve(input).error);
ok(resolve({history:[{role:'user',content:markers(2,['x','y'],[a,b])}]}).error);eq(resolve({turnIds:[a,a]}).id,a);
eq(resolve({history:hist,turnIds:[null],imageCount:1,id:b}).id,b); // explicit allows selecting another image of the owner's
for(const len of [0,1,1199,1200,1201,3999,4000,4001,8000]){
 const raw='x'.repeat(len);const single=markers(1,[raw],[a]);const multi=markers(3,[raw,'y','z'],[a,b,other]);
 eq(single.includes(notice),len>4000);eq(multi.includes(notice),len>1200);eq(resolve({message:single}).id,a);
}
ok(bound('curta',4000,true).includes(notice));ok(bound('',4000,true).includes(notice));eq(bound('a\n b\t c'),'a b c');
const recut=markers(3,[bound('x'.repeat(9000)),'a','b'],[a,b,other]);ok(recut.includes(notice));ok(recut.length<4000);
const aligned=markers(3,['primeira','','terceira'],[a,null,b]);ok(aligned.includes('foto enviada]'));ok(aligned.includes(`id=${b}: terceira`));ok(resolve({message:aligned}).error);
let gets=[],fetches=0,visions=0,usage=0;
const deps={getAsset:async id=>{gets.push(id);return {id,mime:'image/png',kind:'image',s3_key:'synthetic-key'};},fetch:async()=>{fetches++;return {buffer:Buffer.from('synthetic'),contentType:'image/png'};},describe:async()=>{visions++;return {text:'LEITURA SIMULADA',usage:{total:1}};},onUsage:()=>usage++};
let text=await read({history:hist},deps);eq(gets,[a]);eq(fetches,1);eq(visions,1);eq(usage,1);ok(text.includes(a));ok(!text.includes(other));
gets=[];text=await read({turnIds:[a,b]},deps);ok(text.includes('não escolhi'));eq(gets,[]);
for(const asset of [null,{id:a,mime:'application/pdf',kind:'document'},{id:a,mime:'audio/mp3',kind:'audio'},{id:a,mime:'application/pdf',kind:'image'}]){
 const before=fetches;text=await read({id:a},{...deps,getAsset:async()=>asset});ok(text.includes('ERRO'));eq(fetches,before);
}
text=await read({id:a},{...deps,fetch:async()=>null});ok(text.includes('recuperar'));
text=await read({id:a},{...deps,describe:async()=>({text:'parcial',truncated:true})});ok(text.includes(notice));
text=await read({id:a},{...deps,describe:async()=>({text:''})});ok(text.includes('Não consegui extrair'));
// REAL extracted tool: checks scope by userId and forbids global fallback.
const server=readFileSync('./web/server.mjs','utf8');
const start=server.indexOf("    registry.add({\n      name: 'ver_midia'");const end=server.indexOf('\n    });',start)+8;
let tool,ownerSeen;const ctx=vm.createContext({isGeminiComparison:()=>false,registry:{add:t=>{tool=t;}},readContextImage:read,
 turnImageIds:[],images:[],message:'e esse mapa?',thread:{history:hist},userId:'synthetic-owner',mediaUsages:[],
 getMediaAsset:async(owner,id)=>{ownerSeen=owner;return deps.getAsset(id);},fetchMedia:deps.fetch,describeImage:deps.describe,listMediaAssets:denied});
vm.runInContext(server.slice(start,end),ctx);gets=[];await tool.run({});eq(ownerSeen,'synthetic-owner');eq(gets,[a]);
ok(!server.slice(start,end).includes('listMediaAssets'));ok(server.includes('caption = boundedImageCaption(d.text, 4000, d.truncated)'));
// Provider's MAX_TOKENS: real function, simulated gen/usage, zero API.
const media=readFileSync('./web/media.mjs','utf8');const ds=media.indexOf('export async function describeImage('),de=media.indexOf('// PDF OCR via Gemini',ds);
let reason='MAX_TOKENS';const mctx=vm.createContext({isGeminiComparison:()=>false,selectedDeepSeek:()=>null,modeloPara:()=>null,process:{env:{PRIMARY_TEXT_MODEL:'gemini-3.7-flash'}},TOGETHER_FLASH_MODEL:'deepseek-ai/DeepSeek-V4.1-Flash',togetherEnabled:()=>false,gen:async()=>({candidates:[{finishReason:reason,content:{parts:[{text:'texto parcial'}]}}]}),usageFrom:()=>({}),console:{log(){}}});
vm.runInContext(media.slice(ds,de).replace('export ','')+';globalThis.describe=describeImage;',mctx);
eq((await mctx.describe(Buffer.from('fake'),'image/png','teste')).truncated,true);reason='STOP';eq((await mctx.describe(Buffer.from('fake'),'image/png','teste')).truncated,false);
console.log(`${n} verificações aprovadas: contexto, ambiguidade, propriedade, cortes e integração real com dependências simuladas.`);
