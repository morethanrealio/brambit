// Opt-in real-model end-to-end test. The target must be the local sandbox.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
if(!process.argv.includes('--live'))throw Error('Explicit --live required (model API cost)');
const running=process.argv[process.argv.indexOf('--running')+1];
const config=JSON.parse(await fs.readFile(running,'utf8')),url=new URL(config.url),origin=url.origin;
assert.equal(url.hostname,'127.0.0.1');assert.ok(config.root.includes('brambs-discovery-sandbox-'));
const headers={cookie:'sandbox='+url.pathname.split('/').at(-1),origin,'content-type':'application/json'};
const state=async()=>{const r=await fetch(origin+'/state',{headers});assert.equal(r.status,200);return r.json();};
const post=async(route,body)=>{const r=await fetch(origin+route,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(r.status,200,await r.text());};
assert.equal((await fetch(origin+'/state')).status,401);
assert.equal((await fetch(origin+'/message',{method:'POST',headers:{...headers,origin:'https://example.invalid'},body:'{}'})).status,403);
assert.equal(await new Promise((resolve,reject)=>{http.get(origin+'/state',{headers:{...headers,host:'example.invalid'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);}),403);
const before=await state();assert.equal(before.journey,'paused');assert.equal(before.report,null);
await post('/message',{message:'Quero finalizar minha jornada agora e receber a devolutiva.'});
const proposed=await state();assert.equal(proposed.journey,'paused');assert.equal(proposed.report,null);assert.ok(proposed.messages.some(m=>m.role==='assistant'&&/posso|confirm/i.test(m.content)));
console.log('Request proposed without completing the journey');
await post('/message',{message:'Pode sim.'});
console.log('Confirmation submitted; waiting for the real closing worker');
let finished;
for(let n=0;n<100;n++){const s=await state();if(['accepted','failed','uncertain'].includes(s.report?.state)){finished=s;break;}if(n%6===0)console.log('Journey '+s.journey+'; report '+(s.report?.state||'absent'));await new Promise(r=>setTimeout(r,5000));}
assert.ok(finished,'Report did not reach a terminal state');
await fs.writeFile(path.join(path.dirname(running),'smoke-result.json'),JSON.stringify({testedAt:new Date().toISOString(),...finished},null,2),{mode:0o600});
assert.equal(finished.report.state,'accepted');assert.equal(finished.journey,'completed');
assert.ok(finished.messages.some(m=>m.role==='assistant'&&m.content.length>2000),'Full report must appear in the same chat');
console.log(JSON.stringify({passed:true,notes:finished.notes,sourceMessages:finished.sourceMessages,report:finished.report.state,chatMessages:finished.messages.length}));
