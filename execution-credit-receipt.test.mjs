import assert from 'node:assert/strict';
import test from 'node:test';
import {attestSettledUsage,isSettledUsage} from './web/execution-credit-receipt.mjs';
const usage={model:'synthetic',in:10,out:2};
const receipt={settled:true,userId:'owner',callId:'call',attempt:'attempt'};
test('only an attested, unchanged, same-account usage skips legacy billing',()=>{
 const settled=attestSettledUsage(usage,receipt);
 assert.equal(isSettledUsage(settled,{userId:'owner'}),true);
 assert.equal(isSettledUsage({...settled,kind:'subagent'},{userId:'owner'}),true);
 assert.equal(isSettledUsage(settled,{userId:'other'}),false);
 assert.equal(isSettledUsage({...settled,out:100},{userId:'owner'}),false);
 assert.equal(isSettledUsage({...usage,creditReceipt:receipt},{userId:'owner'}),false);
 assert.equal(isSettledUsage(JSON.parse(JSON.stringify(settled)),{userId:'owner'}),false);
 assert.equal(isSettledUsage({...usage,[Symbol('settled-execution-credit')]:{}},{userId:'owner'}),false);
 assert.equal(JSON.stringify(settled),JSON.stringify(usage));
});
// Exercise the actual final-flush function, not a hand-written imitation.
test('server final flush skips settled charges and preserves legacy/noBill accounting',async()=>{
 const {readFileSync}=await import('node:fs');const vm=await import('node:vm');
 const source=readFileSync(new URL('./web/server.mjs',import.meta.url),'utf8');const start=source.indexOf('async function recordUsages(');const end=source.indexOf('\n}',start)+2;
 const rows=[];const ctx=vm.createContext({isSettledUsage,SEARCH_FREE_MONTHLY:{},costOf:()=>.25,gasto:{creditosDe:()=>7},insertUsageEvent:async e=>rows.push(e),console:{error:()=>assert.fail('unexpected storage failure')}});
 vm.runInContext(source.slice(start,end),ctx);
 const recorded=attestSettledUsage(usage,receipt);ctx.input=[recorded,{...recorded},{...usage}];ctx.dims={userId:'owner',kind:'subagent'};
 await vm.runInContext('recordUsages(input,dims)',ctx);assert.equal(rows.length,1);assert.equal(rows[0].billCredits,7);
 ctx.input=[{...usage}];await vm.runInContext('recordUsages(input,dims,{noBill:true})',ctx);assert.equal(rows.length,2);assert.equal(rows[1].billCredits,0);assert.equal(rows[1].cost,.25);
 ctx.input=[{...usage,creditReceipt:receipt}];await vm.runInContext('recordUsages(input,dims)',ctx);assert.equal(rows.length,3);
});
