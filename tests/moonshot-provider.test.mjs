import test from 'node:test';
import assert from 'node:assert/strict';
import {makeMoonshot} from '../core-proto/providers/moonshot.mjs';

const usage={prompt_tokens:40,completion_tokens:12,total_tokens:52};
const sse=deltas=>new Response([
  ...deltas.map(d=>'data: '+JSON.stringify({choices:[{delta:d.delta,finish_reason:d.finish??null}],...(d.usage?{usage:d.usage}:{})})),
  'data: [DONE]','',
].join('\n\n'));
const tools=[{name:'clima',description:'temperatura',parameters:{type:'object'}}];

async function withFetch(responses,run){
  const oldFetch=globalThis.fetch,oldKey=process.env.MOONSHOT_API_KEY;
  process.env.MOONSHOT_API_KEY='synthetic-test-only';
  const bodies=[];
  globalThis.fetch=async(url,init)=>{bodies.push(JSON.parse(init.body));return responses.shift()();};
  try{await run(bodies);}
  finally{
    globalThis.fetch=oldFetch;
    if(oldKey===undefined)delete process.env.MOONSHOT_API_KEY;else process.env.MOONSHOT_API_KEY=oldKey;
  }
}

test('the tool-loop step sends the model its own reasoning back, and never a temperature',async()=>{
  await withFetch([
    ()=>sse([
      {delta:{reasoning_content:'Preciso da '}},
      {delta:{reasoning_content:'ferramenta.'}},
      {delta:{tool_calls:[{index:0,id:'call_1',function:{name:'clima',arguments:'{"cidade":"Curitiba"}'}}]},finish:'tool_calls',usage},
    ]),
    ()=>sse([{delta:{reasoning_content:'Pronto.'}},{delta:{content:'17 °C.'},finish:'stop',usage}]),
  ],async bodies=>{
    const provider=makeMoonshot({reasoningEffort:'high'});
    const user={role:'user',content:'clima em Curitiba?'};
    const first=await provider.complete({messages:[user],tools});
    assert.equal(first.stop,'tool');
    const history=[user,{role:'assistant',content:first.text||'',toolCalls:first.toolCalls},{role:'tool',toolCallId:'call_1',content:'{"temp_c":17}'}];
    const second=await provider.complete({messages:history,tools});
    assert.equal(second.text,'17 °C.');
    const sent=bodies[1].messages.find(m=>m.role==='assistant');
    assert.equal(sent.reasoning_content,'Preciso da ferramenta.');
    for(const body of bodies){
      assert.equal(body.reasoning_effort,'high');
      assert.equal('temperature' in body,false);
    }
  });
});
