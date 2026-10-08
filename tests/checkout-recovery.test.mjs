import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {createCheckoutRecoveryStore,snapshotPixResponses,recoverOrderPix} from '../web/checkout-recovery.mjs';
import {pixCodeDiagnostic,pixCrc16} from '../web/checkout-payment.mjs';
import {encryptSecret,decryptSecret,vaultEnabled} from '../web/vault.mjs';
// Synthetic local key, never cloud KMS or production secrets.
process.env.VAULT_KEY=Buffer.alloc(32,7).toString('base64');
const s={userId:'11111111-1111-4111-8111-111111111111',agentId:'22222222-2222-4222-8222-222222222222',threadId:'33333333-3333-4333-8333-333333333333'};
const other={...s,userId:'44444444-4444-4444-8444-444444444444'};
const code='00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';
const src=fs.readFileSync(new URL('../web/compras.mjs',import.meta.url),'utf8'),ctx=vm.createContext({URL,pixCodeDiagnostic,pixCrc16});
vm.runInContext(src.slice(src.indexOf('// Parsing remains local'),src.indexOf('function totais('))+';globalThis.parse=extrairPix;',ctx);
const parsePix=ctx.parse;
function fakeDb(){const rows=new Map(),calls=[];return {rows,calls,async query(sql,p=[]){
 calls.push({sql,p});
 if(sql.startsWith('CREATE'))return {rows:[]};
 if(sql.startsWith('DELETE')){for(const [id,r] of rows)if(r.expires_at<=Date.now())rows.delete(id);return {rows:[]};}
 if(sql.startsWith('INSERT')){
  assert.match(sql,/t\.user_id=\$2 AND t\.agent_id=\$3/);assert.match(sql,/t\.deleted_at IS NULL AND u\.deleted_at IS NULL/);
  if(p[1]!==s.userId||p[2]!==s.agentId||p[3]!==s.threadId)return {rows:[]};
  rows.set(p[0],{id:p[0],user_id:p[1],agent_id:p[2],thread_id:p[3],stage:'prepared',payload_enc:p[4],expires_at:Date.now()+86400000});return {rows:[{id:p[0]}]};
 }
 if(sql.startsWith('UPDATE')){
  assert.match(sql,/r\.id=\$1 AND r\.user_id=\$2 AND r\.agent_id=\$3 AND r\.thread_id=\$4/);
  assert.match(sql,/u\.deleted_at IS NULL/);const r=rows.get(p[0]);
  if(!r||r.user_id!==p[1]||r.agent_id!==p[2]||r.thread_id!==p[3]||(r.order_id&&r.order_id!==p[4]))return {rows:[]};
  Object.assign(r,{order_id:p[4],stage:p[5],payload_enc:p[6],updated_at:new Date()});return {rows:[{id:r.id}]};
 }
 if(sql.startsWith('SELECT')){
  assert.match(sql,/r\.user_id=\$1 AND r\.agent_id=\$2 AND r\.order_id=\$3/);assert.match(sql,/t\.deleted_at IS NULL AND u\.deleted_at IS NULL/);
  return {rows:[...rows.values()].filter(r=>r.user_id===p[0]&&r.agent_id===p[1]&&r.order_id===p[2]&&r.expires_at>Date.now())};
 }
 throw Error('Unexpected SQL');
 }};}
const make=db=>createCheckoutRecoveryStore(db,{encrypt:encryptSecret,decrypt:decryptSecret,enabled:vaultEnabled});
const response=(c=code,expiresAt='2099-01-01T00:00:00Z')=>({paymentAuthorizationAppCollection:[{appName:'PRIVATE_APP',appPayload:JSON.stringify({code:c,expiresAt,qrCodeBase64Image:'PRIVATE_IMAGE',paymentId:'PRIVATE_ID',email:'PRIVATE_EMAIL'})}]});
test('snapshot preserves exact code/expiry but never unrelated private payload',()=>{
 const snap=snapshotPixResponses(response());assert.equal(snap[0].paymentAuthorizationAppCollection[0].appPayload.code,code);
 assert.ok(!JSON.stringify(snap).includes('PRIVATE'));assert.throws(()=>snapshotPixResponses({paymentAppData:{payload:'x'.repeat(1048577)}}));
});
test('encrypted record survives new store instance and recovers exact code with spaces',async()=>{
 const db=fakeDb(),a=make(db);await a.ensureSchema();const rec=await a.reserve(s,{origin:'https://shop.invalid',total:14089});
 await a.save(s,rec,'ORDER','created');await a.save(s,rec,'ORDER','pix_received',[response()]);
 const row=db.rows.get(rec.id);assert.match(row.payload_enc,/^v1:/);assert.ok(!row.payload_enc.includes(code));
 // Simulated process restart: a fresh repository instance, same durable DB adapter.
 const b=make(db),r=await recoverOrderPix({store:b,parsePix},s,'ORDER');assert.equal(r.ok,true);assert.equal(r.status,'pix_recovered');assert.ok(r.saida.includes('\n'+code+'\n'));assert.ok(r.saida.includes('140,89'));assert.ok(!r.saida.includes('PRIVATE'));
});
test('owner and agent isolation, no record existence leaked',async()=>{
 const db=fakeDb(),store=make(db),rec=await store.reserve(s,{origin:'https://shop.invalid',total:1});await store.save(s,rec,'ORDER','pix_received',[response()]);
 for(const wrong of [other,{...s,agentId:other.userId}]){assert.equal(await store.load(wrong,'ORDER'),null);assert.equal((await recoverOrderPix({store,parsePix},wrong,'ORDER')).status,'record_missing');}
 await assert.rejects(()=>store.reserve(other,{origin:'https://shop.invalid',total:1}));
 await assert.rejects(()=>store.save(other,rec,'ORDER','pix_received',[response()]));
});
test('swapped encrypted envelope and ciphertext tampering fail closed',async()=>{
 const db=fakeDb(),store=make(db),rec=await store.reserve(s,{origin:'https://shop.invalid',total:1});await store.save(s,rec,'ORDER','pix_received',[response()]);const row=db.rows.get(rec.id),valid=row.payload_enc;
 row.payload_enc=encryptSecret(JSON.stringify({...JSON.parse(decryptSecret(valid)),userId:other.userId}));assert.equal((await recoverOrderPix({store,parsePix},s,'ORDER')).status,'recovery_unavailable');
 row.payload_enc=valid.slice(0,-7)+'AAAAAAA';assert.equal((await recoverOrderPix({store,parsePix},s,'ORDER')).status,'recovery_unavailable');
});
test('vault unavailable blocks reserve; never plaintext fallback',async()=>{
 const db=fakeDb(),store=createCheckoutRecoveryStore(db,{encrypt:()=>{throw Error('must not call');},decrypt:()=>{},enabled:()=>false});
 await assert.rejects(()=>store.reserve(s,{origin:'https://shop.invalid',total:1}),/vault_unavailable/);assert.equal(db.calls.length,0);
});
test('expired record purged; no code delivered after TTL',async()=>{
 const db=fakeDb(),store=make(db),rec=await store.reserve(s,{origin:'https://shop.invalid',total:1});await store.save(s,rec,'ORDER','pix_received',[response()]);db.rows.get(rec.id).expires_at=0;
 assert.equal((await recoverOrderPix({store,parsePix},s,'ORDER')).status,'record_missing');await store.purgeExpired();assert.equal(db.rows.size,0);
});
test('expired/invalid expiry, missing/invalid Pix and partial stages never recreate or pay',async()=>{
 const db=fakeDb(),store=make(db),rec=await store.reserve(s,{origin:'https://shop.invalid',total:1});
 for(const [stage,payload,expected] of [['created',response(),'no_pix_response'],['payment_failed',response(),'no_pix_response'],['callback_failed',response(),'no_pix_response'],['pix_received',response(code,'2020-01-01'),'pix_expired'],['pix_received',response(code,'PRIVATE'),'invalid_expiry'],['pix_received',response(code.slice(0,-1)+'0'),'invalid_saved_pix'],['pix_received',{},'invalid_saved_pix'],['pix_received',{RedirectResponseCollection:[{redirectUrl:'https://payment.invalid/secret'}]},'payment_app_required']]){
  await store.save(s,rec,'ORDER',stage,[payload]);const before=db.calls.length;const r=await recoverOrderPix({store,parsePix},s,'ORDER');assert.equal(r.ok,false);assert.equal(r.status,expected);assert.equal(db.calls.length,before+1);assert.ok(db.calls.at(-1).sql.startsWith('SELECT'));assert.ok(!JSON.stringify(r).includes(code));
 }
});
test('unrecognized code is captured BEFORE validation and can be reprocessed without a store request',async()=>{
 const db=fakeDb(),store=make(db),rec=await store.reserve(s,{origin:'https://shop.invalid',total:1});await store.save(s,rec,'ORDER','pix_received',[response()]);
 assert.equal((await recoverOrderPix({store,parsePix:()=>null},s,'ORDER')).status,'invalid_saved_pix');
 assert.equal((await recoverOrderPix({store,parsePix},s,'ORDER')).ok,true);
});
test('invalid inputs and missing legacy record cannot trigger network or a checkout',async()=>{
 const db=fakeDb(),store=make(db);assert.equal((await recoverOrderPix({store,parsePix},s,'../ORDER')).status,'invalid_order');assert.equal(db.calls.length,0);
 assert.equal((await recoverOrderPix({store,parsePix},s,'LEGACY')).status,'record_missing');
 await assert.rejects(()=>store.reserve({...s,userId:'SQL INJECTION'},{origin:'https://shop.invalid',total:1}));
 await assert.rejects(()=>store.reserve(s,{origin:'http://shop.invalid',total:1}));
 await assert.rejects(()=>store.reserve(s,{origin:'https://shop.invalid',total:NaN}));
});
test('runtime registry exposes recovery as read tool, while checkout stays gated',()=>{
 const server=fs.readFileSync(new URL('../web/server.mjs',import.meta.url),'utf8');assert.ok(src.includes("name:'recuperar_pix_pedido'"));
 assert.ok(server.includes("cTools.filter((t) => t.name !== 'fechar_pedido')"));assert.ok(server.includes("addGated(registry, cTools.filter((t) => t.name === 'fechar_pedido')"));
 const recovery=fs.readFileSync(new URL('../web/checkout-recovery.mjs',import.meta.url),'utf8');assert.ok(!/\bfetch\s*\(|gatewayCallback|\/transaction|\/payments\b/.test(recovery));
});
