import {microsoftContextServices,onboardingSources} from './connections.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {OnboardingError,id,publicState,starterPrompt,type State} from './store.mjs';
// Módulo puro de geração textual; não importa servidor/DB/pollers.
// @ts-expect-error runtime ESM legacy without declarations
import {generateMessageDraft} from '../web/message-draft.mjs';
const source=readFileSync('web/server.mjs','utf8');const a=source.indexOf('  // Estado persistente, recuperação e telemetria'),b=source.indexOf('  // Atualização automática dos boxes da home.',a);assert(a>0&&b>a);const handler=source.slice(a,b);
const U='00000000-0000-4000-8000-000000000001',A='00000000-0000-4000-8000-000000000002';
const state=():State=>({user_id:U,agent_id:A,step:'wow',status:'running',mode:'starter',attempt_id:'00000000-0000-4000-8000-000000000010',attempt_no:1,worker_id:null,started_at:null,result:null,error_code:null,viewed_at:null,skipped_at:null,completed_at:null});
async function run({auth=true,body={agentId:A,mode:'starter',task:'plan',context:'Tenho uma entrega e duas reuniões amanhã.'} as Record<string,unknown>|null,path='/api/onboard',method='POST',credit=true,malformed=false,claim=true,google=[] as string[],msScope=undefined as string|null|undefined}={}){
 const calls={model:0,tools:0,usage:0,failed:0,finished:0,connections:0,standardChat:0,touches:[] as unknown[],feedback:[] as unknown[],scope:[] as string[]};let response:{code:number;data:unknown}|undefined;let pending=false;const s=state();
 const deps={req:{method},res:{},url:new URL('http://fixture'+path),currentUser:async()=>auth?{id:U}:null,readBody:async()=>body,
 tooManyRequests:()=>false,onboardingStore:{feedback:async(user:string,agent:string,attempt:unknown,choice:unknown)=>{calls.feedback.push({user,agent,attempt,choice});return s},touch:async(user:string,event:unknown,provider:unknown)=>{calls.touches.push({user,event,provider})},get:async(user:string,agent?:string)=>{calls.scope.push(user+':'+agent);return s},progress:async()=>s,claim:async()=>({claimed:claim,state:s}),finish:async()=>{calls.finished++;pending=false;return true},fail:async()=>{calls.failed++;pending=false;return true}},
 publicState,starterPrompt,OnboardingError,onboardingId:id,send:(_r:unknown,code:number,data:unknown)=>{response={code,data}},fail:(_r:unknown,code:number,message:string)=>{response={code,data:{error:message}}},
 getAgentOwned:async(agent:string,user:string)=>agent===A&&user===U?{id:A,name:'Sintético'}:null,getUserLocale:async()=>({language:'pt-BR'}),tagIdioma:(s:string)=>s,
 connectedServices:async()=>{calls.connections++;return google},listOAuthProviders:async()=>msScope===undefined?[]:['microsoft'],getOAuthToken:async()=>({scope:msScope}),microsoftContextServices,onboardingSources,ONBOARD_PROMPT:()=>'',
 getOrCreateThreadByTitle:async()=>{pending=true;return {id:'thread-fixture'}},generateMessageDraft,getCreditStatus:async()=>({over:!credit}),comIdioma:(s:string)=>s,
 makeSubagentProvider:()=>({complete:async(input:{tools:unknown[];system:string})=>{calls.model++;assert.deepEqual(input.tools,[]);assert(!input.system.includes('perfil'));return {text:'Plano útil: comece pela entrega e reserve tempo para as reuniões.',stop:malformed?'tool':'end',...(malformed?{toolCalls:[{name:'send_email'}]}:{}),usage:{tokens:10}}}}),
 recordUsages:async(_u:unknown,meta:{kind:string;userId:string;turnId:string})=>{calls.usage++;assert.equal(meta.kind,'onboard');assert.equal(meta.userId,U);assert.equal(meta.turnId,s.attempt_id)},
 runConversationInThread:async()=>{calls.standardChat++;throw new Error('Unexpected normal conversation')},parseOnboard:()=>({welcome:'x',notes:[],suggestions:[]}),clearHomeItems:async()=>{calls.tools++},addHomeItem:async()=>{calls.tools++},randomUUID:()=>A,console:{error:()=>{}},
 };
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 await new AsyncFunction(...Object.keys(deps),handler)(...Object.values(deps));
 for(let i=0;i<100&&pending;i++)await new Promise(r=>setTimeout(r,1));assert(!pending,'background must finish in fixture');return {calls,response};
}
test('starter uses isolated one-shot generation, checks credits, no tools/connectors/history/normal chat',async()=>{const r=await run();assert.equal(r.response?.code,200);assert.equal(r.calls.model,1);assert.equal(r.calls.usage,1);assert.equal(r.calls.finished,1);assert.equal(r.calls.failed,0);assert.equal(r.calls.tools+r.calls.connections+r.calls.standardChat,0)});
test('credit rejection and hallucinated tools are failure, never delivered as result',async()=>{let r=await run({credit:false});assert.equal(r.calls.model,0);assert.equal(r.calls.failed,1);assert.equal(r.calls.finished,0);r=await run({malformed:true});assert.equal(r.calls.tools,0);assert.equal(r.calls.failed,1);assert.equal(r.calls.finished,0);assert.equal(r.calls.usage,1)});
test('invalid input, unauthenticated requests, unowned agent and missing connector do not invoke model',async()=>{for(const opts of [{auth:false},{body:null},{body:{agentId:'bad'}},{body:{agentId:U}},{body:{agentId:A,mode:'connected'}},{body:{agentId:A,mode:'starter',task:'plan',context:'x'}}]){const r=await run(opts);assert(r.response!.code>=400);assert.equal(r.calls.model,0);assert.equal(r.calls.finished,0)}});
test('all endpoints enforce authentication; status is scoped and duplicate claim does not rerun model',async()=>{for(const path of ['/api/onboard/status','/api/onboard/progress','/api/onboard/touch','/api/onboard/feedback','/api/onboard']){const r=await run({path,method:path.endsWith('status')?'GET':'POST',auth:false});assert.equal(r.response?.code,401)}let r=await run({path:'/api/onboard/status?agentId='+A,method:'GET'});assert.deepEqual(r.calls.scope,[U+':'+A]);r=await run({claim:false});assert.equal(r.calls.model,0);assert.equal(r.response?.code,200)});

test('touch endpoint is authenticated, identity comes from session and extra payload is rejected',async()=>{
 const r=await run({path:'/api/onboard/touch',body:{event:'security_viewed',provider:'none'}});assert.equal(r.response?.code,200);assert.deepEqual(r.calls.touches,[{user:U,event:'security_viewed',provider:'none'}]);
 for(const body of [null,{event:'security_viewed',userId:A},{event:'security_viewed',text:'private content'}]){const bad=await run({path:'/api/onboard/touch',body});assert.equal(bad.response?.code,400);assert.deepEqual(bad.calls.touches,[])}
});

test('connected route accepts calendar only and refuses identity-only Microsoft before claiming work',async()=>{
 for(const opts of [{google:['calendar']},{msScope:'Calendars.ReadWrite'}]){const r=await run({...opts,body:{agentId:A,mode:'connected'},claim:false});assert.equal(r.response?.code,200);assert.equal(r.calls.model,0)}
 const r=await run({msScope:'openid User.Read',body:{agentId:A,mode:'connected'},claim:false});assert.equal(r.response?.code,400);assert.equal(r.calls.model,0);
});

test('feedback endpoint uses authenticated owner, rejects extra data and makes no paid calls',async()=>{
 const r=await run({path:'/api/onboard/feedback',body:{agentId:A,attemptId:'attempt',choice:'useful'}});assert.equal(r.response?.code,200);assert.deepEqual(r.calls.feedback,[{user:U,agent:A,attempt:'attempt',choice:'useful'}]);assert.equal(r.calls.model+r.calls.usage+r.calls.tools,0);
 for(const body of [null,{agentId:A,choice:'useful',userId:A},{agentId:A,choice:'useful',text:'private'}]){const bad=await run({path:'/api/onboard/feedback',body});assert.equal(bad.response?.code,400);assert.equal(bad.calls.feedback.length,0)}
});
