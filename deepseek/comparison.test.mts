import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {GEMINI_COMPARISON_ID,GEMINI_COMPARISON_MODEL,withGeminiComparison,isGeminiComparison} from './comparison.mjs';
import {requireProviderContent} from '../web/execution-credit-errors.mjs';
const source=readFileSync('web/server.mjs','utf8');
function fn(name:string):string {const start=source.indexOf('function '+name+'(');return source.slice(start,source.indexOf('\n}',start)+2);}
test('real catalog, normalization and fixed factory keep Gemini explicit even during outage',()=>{
 let ready=true;const ctx=vm.createContext({marca:()=>({nome:'Brambit'}),GEMINI_COMPARISON_ID,GEMINI_COMPARISON_MODEL,DEEPSEEK_AGENT_MODEL:'deepseek41flash',deepseekFlashReady:false,kimiAvailable:()=>false,geminiEnabled:()=>ready,makeGemini:(opts:unknown)=>opts});
 vm.runInContext(['assignableAgentModels','normalizeAgentModel','forcedAgentProvider'].map(fn).join('\n'),ctx);
 assert.equal(vm.runInContext("assignableAgentModels()[1].label",ctx),'Gemini 3.7 Flash');
 assert.equal(vm.runInContext("normalizeAgentModel(' GEMINI37FLASH ')",ctx),GEMINI_COMPARISON_ID);
 assert.equal(vm.runInContext("forcedAgentProvider('gemini37flash').model",ctx),GEMINI_COMPARISON_MODEL);
 assert.equal(vm.runInContext("forcedAgentProvider('gemini37flash').search",ctx),false);
 ready=false;assert.equal(vm.runInContext("assignableAgentModels().length",ctx),1);
 assert.equal(vm.runInContext("assignableAgentModels('gemini37flash')[1].id",ctx),GEMINI_COMPARISON_ID);
 assert.equal(vm.runInContext("normalizeAgentModel('gemini37flash')",ctx),GEMINI_COMPARISON_ID);
 assert.throws(()=>vm.runInContext("forcedAgentProvider('gemini37flash')",ctx),/Nenhum outro modelo/);
 assert.equal(vm.runInContext("normalizeAgentModel('inventado')",ctx),'auto');
});
test('Gemini comparison does not leak between simultaneous accounts or after errors',async()=>{
 assert.equal(isGeminiComparison(),false);
 await Promise.all([withGeminiComparison(async()=>{await new Promise(r=>setTimeout(r,5));assert.equal(isGeminiComparison(),true);}), (async()=>{await new Promise(r=>setTimeout(r,2));assert.equal(isGeminiComparison(),false);})()]);
 assert.throws(()=>withGeminiComparison(()=>{throw Error('fixture');}),/fixture/);assert.equal(isGeminiComparison(),false);
});
test('actual router prioritizes explicit Gemini for text and raw images, preserves onboard',()=>{
 const start=source.indexOf('  if (isDeepSeekTurn()) {\n    provider = forcedProvider;');const end=source.indexOf('\n  const measurement = ',start);assert.ok(start>=0&&end>start,'model router anchor not found in web/server.mjs');const route=source.slice(start,end);
 for(const hasImages of [false,true]) {
  const ctx=vm.createContext({isDeepSeekTurn:()=>false,isGeminiComparison:()=>true,kind:'chat',hasImages,GEMINI_COMPARISON_ID,forcedAgentProvider:(id:string)=>({id}),provider:null});
  vm.runInContext(route,ctx);assert.equal((ctx.provider as unknown as {id:string}).id,GEMINI_COMPARISON_ID);
 }
 const ctx=vm.createContext({isDeepSeekTurn:()=>false,isGeminiComparison:()=>true,kind:'onboard',hasImages:false,isNemotron:false,makeSubagentProvider:()=>({name:'cheap'}),console:{log:()=>{}},thread:{id:'fixture'},provider:null});vm.runInContext(route,ctx);assert.equal((ctx.provider as unknown as {name:string}).name,'cheap');
});

test('actual image caption helper honors Gemini selection without Together dispatch or fallback',async()=>{
 const media=readFileSync('web/media.mjs','utf8');const code=media.slice(media.indexOf('export async function describeImage('),media.indexOf('// PDF OCR via Gemini')).replace('export ','');
 let calls=0,ready=true,fail=false;const ctx=vm.createContext({GEMINI_COMPARISON_MODEL,requireProviderContent,isGeminiComparison:()=>true,imageEnabled:()=>ready,makeGemini:(opts:{model:string,search:boolean,maxOutputTokens:number})=>{assert.equal(opts.model,GEMINI_COMPARISON_MODEL);assert.equal(opts.search,false);assert.equal(opts.maxOutputTokens,1400);return {complete:async(arg:{messages:{images:{data:string}[]}[]})=>{calls++;assert.equal(arg.messages[0].images[0].data,Buffer.from('synthetic').toString('base64'));if(fail)throw Error('synthetic rejected');return {text:'417',usage:{model:GEMINI_COMPARISON_MODEL},protocolError:{code:'output_truncated'}};}};}});
 vm.runInContext(code,ctx);const run=()=>vm.runInContext("describeImage(buffer,'image/png','describe',{maxOut:1400})",ctx);ctx.buffer=Buffer.from('synthetic');
 const result=await run();assert.equal(result.text,'417');assert.equal(result.truncated,true);assert.equal(calls,1);
 fail=true;await assert.rejects(run,/synthetic rejected/);assert.equal(calls,2);
 ready=false;await assert.rejects(run,/Nenhum outro modelo/);assert.equal(calls,2);
});

test("production media module imports with real exports, not extracted fixtures",async()=>{const media=await import("../web/media.mjs");assert.equal(typeof media.describeImage,"function");});
