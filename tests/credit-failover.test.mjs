import test from 'node:test';
import assert from 'node:assert/strict';
import {runAgent,ToolRegistry} from '../core-proto/core.mjs';

const pending = () => ({stop:'end',text:'generic stop',creditStop:'credit_reconciliation_required',unavailable:true});
const end = text => ({stop:'end',text});
const tool = (name,id='t') => ({stop:'tool',toolCalls:[{id,name,args:{}}]});

function route(primarySteps,fallbackSteps){
 let usePrimary=true,primaryCalls=0,fallbackCalls=0,recoveries=0;const recoveryInputs=[];
 return {
  provider:{
   name:'together->fallback:gemini',
   complete:async()=>usePrimary?primarySteps[primaryCalls++]:fallbackSteps[fallbackCalls++],
   recoverCreditStop:async input=>{
    if(!usePrimary)return null;
    usePrimary=false;recoveries++;recoveryInputs.push(input);
   return {from:'together',to:'gemini',result:fallbackSteps[fallbackCalls++]};
   },
  },
  counts:()=>({primaryCalls,fallbackCalls,recoveries}),recoveryInputs,
 };
}

test('enabled conversational route fails over once to Gemini instead of exposing the generic stop',async()=>{
 const r=route([pending()],[end('Gemini respondeu.')]);const events=[];
 const out=await runAgent({provider:r.provider,tools:new ToolRegistry(),userInput:'oi',allowCreditFailover:true,onEvent:e=>events.push(e)});
 assert.equal(out.text,'Gemini respondeu.');
 assert.deepEqual(r.counts(),{primaryCalls:1,fallbackCalls:1,recoveries:1});
 assert.deepEqual(events.find(e=>e.type==='provider_credit_failover'),{type:'provider_credit_failover',step:0,reason:'credit_reconciliation_required',from:'together',to:'gemini',mode:'continue'});
});

test('read-only listar_rotinas may be followed by one cross-provider failover',async()=>{
 let reads=0;
 const tools=new ToolRegistry().add({name:'listar_rotinas',readOnly:true,description:'fixture',parameters:{},run:async()=>{reads++;return 'uma rotina';}});
 const r=route([tool('listar_rotinas'),pending()],[end('Você tem uma rotina.')]);
 const out=await runAgent({provider:r.provider,tools,userInput:'quais?',allowCreditFailover:true});
 assert.equal(out.text,'Você tem uma rotina.');assert.equal(reads,1);
 assert.deepEqual(r.counts(),{primaryCalls:2,fallbackCalls:1,recoveries:1});
 assert.ok(!tools.defs[0].readOnly,'internal safety metadata must not be model-visible');
 assert.equal(r.recoveryInputs[0].messages.some(m=>m.toolCalls?.length||m.role==='tool'),false);
 assert.ok(r.recoveryInputs[0].messages.some(m=>m.content?.includes('uma rotina')));
 assert.equal(r.recoveryInputs[0].tools.length,1);
});

test('after a mutating tool, fallback answers with tools disabled instead of abandoning the user',async()=>{
 let writes=0;
 const tools=new ToolRegistry().add({name:'criar_lembrete',description:'fixture',parameters:{},run:async()=>{writes++;return 'feito';}});
 const r=route([tool('criar_lembrete'),pending()],[end('must not run')]);
 const out=await runAgent({provider:r.provider,tools,userInput:'crie',allowCreditFailover:true});
 assert.equal(out.text,'must not run');assert.equal(out.termination,'completed');assert.equal(writes,1);
 assert.deepEqual(r.counts(),{primaryCalls:2,fallbackCalls:1,recoveries:1});
 assert.deepEqual(r.recoveryInputs[0].tools,[]);
});

test('route can disable failover and backup cannot cascade after its own unconfirmed call',async()=>{
 const disabled=route([pending()],[end('must not run')]);
 const a=await runAgent({provider:disabled.provider,tools:new ToolRegistry(),userInput:'oi',allowCreditFailover:false});
 assert.equal(a.text,'generic stop');assert.equal(disabled.counts().recoveries,0);

 const once=route([pending()],[pending()]);
 const b=await runAgent({provider:once.provider,tools:new ToolRegistry(),userInput:'oi',allowCreditFailover:true});
 assert.equal(b.text,'generic stop');assert.equal(b.termination,'credit_reconciliation_required');
 assert.deepEqual(once.counts(),{primaryCalls:1,fallbackCalls:1,recoveries:1});
});

test('a confirmed tool executed before the loop forces answer-only failover',async()=>{
 const tools=new ToolRegistry().add({name:'enviar_email',description:'fixture',parameters:{},run:async()=>{throw Error('not called');}});
 const r=route([pending()],[end('must not run')]);
 const out=await runAgent({provider:r.provider,tools,userInput:'continue',initialToolLog:[{name:'enviar_email'}],allowCreditFailover:true});
 assert.equal(out.text,'must not run');assert.equal(r.counts().recoveries,1);
});

test('answer-only failover cannot execute a hallucinated tool call',async()=>{
 let writes=0;
 const tools=new ToolRegistry().add({name:'enviar_email',description:'fixture',parameters:{},run:async()=>{writes++;return 'sent';}});
 const r=route([pending()],[tool('enviar_email','again')]);
 const out=await runAgent({provider:r.provider,tools,userInput:'continue',initialToolLog:[{name:'enviar_email'}],allowCreditFailover:true});
 assert.equal(writes,0);assert.equal(out.termination,'completed');
 assert.ok(out.text.includes('não repeti nenhuma ação'));
});

test('two uncertain providers advance Together -> Gemini -> OpenAI without replay',async()=>{
 let stage=0;const calls=[0,0,0];const names=['together','gemini','openai'];
 const steps=[[pending()],[pending()],[end('OpenAI respondeu.')]];
 const provider={name:names.join('->'),complete:async()=>steps[stage][calls[stage]++],recoverCreditStop:async input=>{
  if(stage>=2)return null;const from=names[stage];stage++;return {from,to:names[stage],result:steps[stage][calls[stage]++]};
 }};
 const events=[];const out=await runAgent({provider,tools:new ToolRegistry(),userInput:'oi',allowCreditFailover:true,onEvent:e=>events.push(e)});
 assert.equal(out.text,'OpenAI respondeu.');assert.deepEqual(calls,[1,1,1]);
 assert.deepEqual(events.filter(e=>e.type==='provider_credit_failover').map(e=>e.to),['gemini','openai']);
});
