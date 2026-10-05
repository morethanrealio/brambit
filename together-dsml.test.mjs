import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTogether,parseDsmlToolCalls,stripDsml,hasDsmlResidue} from './core-proto/providers/together.mjs';

const MODEL='deepseek-ai/DeepSeek-V4.1-Flash';
const usage=(input=20,output=10)=>({prompt_tokens:input,completion_tokens:output,total_tokens:input+output});
const sse=({content='',toolCalls,finish='stop',meter=usage()})=>new Response([
  'data: '+JSON.stringify({choices:[{delta:{content,...(toolCalls?{tool_calls:toolCalls}:{})},finish_reason:finish}],usage:meter}),
  'data: [DONE]',
  '',
].join('\n\n'));

const observed=`<｜DSML｜ calls>
<｜DSML｜ invoke name="ler_arquivo_do_app">
<｜DSML｜ parameter name="caminho" string="true">public/game.js</｜DSML｜ parameter>
<｜DSML｜ parameter name="inicio" string="false">22600</｜DSML｜ parameter>
</｜DSML｜ invoke>
<｜DSML｜ invoke name="ler_arquivo_do_app">
<｜DSML｜ parameter name="caminho" string="true">public/game.js</｜DSML｜ parameter>
<｜DSML｜ parameter name="inicio" string="false">39600</｜DSML｜ parameter>
</｜DSML｜ invoke>
</｜DSML｜ calls>`;

test('parser preserves compact DSML and accepts the spaced Together variant',()=>{
  const compact='<｜DSML｜invoke name="ler"><｜DSML｜parameter name="inicio">12</｜DSML｜parameter></｜DSML｜invoke>';
  assert.deepEqual(parseDsmlToolCalls(compact),[{id:'dsml_0',name:'ler',args:{inicio:12}}]);
  assert.deepEqual(parseDsmlToolCalls(observed),[
    {id:'dsml_0',name:'ler_arquivo_do_app',args:{caminho:'public/game.js',inicio:22600}},
    {id:'dsml_1',name:'ler_arquivo_do_app',args:{caminho:'public/game.js',inicio:39600}},
  ]);
  assert.equal(hasDsmlResidue(observed),true);
  assert.equal(stripDsml('texto visível\n'+observed),'texto visível');
});

test('parser remains scoped to the fullwidth DSML marker',()=>{
  assert.deepEqual(parseDsmlToolCalls('<|DSML| invoke name="danger"><|DSML| parameter name="x">1</|DSML| parameter></|DSML| invoke>'),[]);
  assert.deepEqual(parseDsmlToolCalls('<invoke name="danger"><parameter name="x">1</parameter></invoke>'),[]);
  assert.equal(hasDsmlResidue('ordinary assistant text'),false);
});

test('empty-response recovery turns the exact observed spaced DSML into tools',async()=>{
  const oldFetch=globalThis.fetch,oldKey=process.env.TOGETHER_API_KEY;
  process.env.TOGETHER_API_KEY='synthetic-test-only';
  let calls=0;
  globalThis.fetch=async()=>++calls===1?sse({meter:usage(0,0)}):sse({content:observed,meter:usage(31811,291)});
  try{
    const provider=makeTogether({model:MODEL,maxTokens:32768,reasoningEffort:'high'});
    const result=await provider.complete({system:'synthetic',messages:[{role:'user',content:'read'}],tools:[{name:'ler_arquivo_do_app',description:'read',parameters:{type:'object'}}]});
    assert.equal(calls,2);
    assert.equal(result.stop,'tool');
    assert.equal(result.text,undefined);
    assert.deepEqual(result.toolCalls.map(x=>({name:x.name,args:x.args})),[
      {name:'ler_arquivo_do_app',args:{caminho:'public/game.js',inicio:22600}},
      {name:'ler_arquivo_do_app',args:{caminho:'public/game.js',inicio:39600}},
    ]);
    assert.deepEqual(result.usage,{model:MODEL,in:31811,cached:0,out:291,think:0,total:32102});
  } finally {
    globalThis.fetch=oldFetch;
    if(oldKey===undefined)delete process.env.TOGETHER_API_KEY;else process.env.TOGETHER_API_KEY=oldKey;
  }
});

test('unparseable DSML from empty-response recovery never becomes final text',async()=>{
  const oldFetch=globalThis.fetch,oldKey=process.env.TOGETHER_API_KEY;
  process.env.TOGETHER_API_KEY='synthetic-test-only';
  let calls=0;
  globalThis.fetch=async()=>++calls===1?sse({meter:usage(0,0)}):sse({content:'<｜DSML｜ calls><｜DSML｜ unknown>private protocol</｜DSML｜ unknown></｜DSML｜ calls>',meter:usage(10,3)});
  try{
    const provider=makeTogether({model:MODEL,reasoningEffort:'high'});
    await assert.rejects(()=>provider.complete({messages:[{role:'user',content:'x'}],tools:[{name:'safe',parameters:{type:'object'}}]}),/resíduo de tool-call/);
    assert.equal(calls,2);
  } finally {
    globalThis.fetch=oldFetch;
    if(oldKey===undefined)delete process.env.TOGETHER_API_KEY;else process.env.TOGETHER_API_KEY=oldKey;
  }
});
