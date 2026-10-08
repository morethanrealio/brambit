import {recoverOrderPix} from './web/checkout-recovery.mjs';
import { paymentRequest, checkoutFailure, pixCodeDiagnostic, pixCrc16 } from './web/checkout-payment.mjs';
import { confirmedAction, actionEvidenceFor } from './web/action-evidence.mjs';
import { connectorActionReceipt, shareableLink } from './web/connector-action-evidence.mjs';
// Offline: real tool/parser/renderer bodies in VM, synthetic carts/HTTP only.
// Never imports compras.mjs (DB/vault dependencies), starts server or calls a shop.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const src = fs.readFileSync(new URL('./web/compras.mjs', import.meta.url), 'utf8');
const confirm = fs.readFileSync(new URL('./web/confirm.mjs', import.meta.url), 'utf8');
const parsers = src.slice(src.indexOf('// Parsing remains local'), src.indexOf('function totais('));
const factory = src.slice(src.indexOf('export function comprasTools('), src.indexOf('// Short block for the end of the prompt:')).replace('export function', 'function');
const renderer = confirm.slice(confirm.indexOf('export function renderConfirmed('), confirm.indexOf('// WRITE/mutation tools')).replace('export function', 'function');
let checks = 0;
const ok = (v, label) => { assert(v, label); checks++; };
const eq = (a, b) => { assert.deepEqual(a, b); checks++; };
function harness(responses, { exists = true, overrides = {} } = {}) {
  const calls = [], logs = [], saves = [];
  const cart = { origin: 'https://shop.invalid', orderFormId: 'FORM', jar: {}, valor: 1000, pix: { id: 125 }, produto: { nome: 'SYNTHETIC', qtd: 1 }, comprador: { cidade: 'TEST', estado: 'XX', cep: '00000000' }, frete: { nome: 'TEST', prazo: 'TEST' }, ...overrides };
  const ctx = vm.createContext({ recoverOrderPix, checkoutRecoveryStore:{reserve:async()=>({id:'synthetic'}),save:async(...args)=>{saves.push(args);},load:async()=>null}, paymentRequest, checkoutFailure, pixCodeDiagnostic, pixCrc16, confirmedAction, actionEvidenceFor, connectorActionReceipt, shareableLink, URL, console: { log(...args) { logs.push(args.join(' ')); } }, getCarrinho: (uid, id) => exists && uid === 'user-test' && id === 'C' ? cart : null, carrinhoVivoDoThread: () => null, brl: v => String(v / 100), LEGACY_TEXT_LANGUAGE: 'pt-BR', defaultLanguage: () => 'pt-BR', describeDone: () => 'Pedido solicitado', req: async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body });
    assert(responses.length, 'Unexpected mock request');
    const r = responses.shift(); if (r instanceof Error) throw r; return r;
  } });
  vm.runInContext(parsers + factory + renderer + '\nglobalThis.p={extrairPix,crc16:pixCrc16};globalThis.tools=comprasTools("user-test","agent-test",{threadId:"thread-test"});', ctx);
  return { calls, logs, saves, ctx, tool: ctx.tools.find(t => t.name === 'fechar_pedido'), render: r => ctx.renderConfirmed({ name: 'fechar_pedido', label: 'Fechar pedido', args: {} }, r), done: () => eq(responses.length, 0) };
}
const get = { status: 200, json: { value: 1000 } }, pd = { status: 200, json: {} };
const tr = { status: 200, json: { orderGroup: 'ORDER', id: 'TX', receiverUri: 'https://payment.invalid', merchantTransactions: [{ id: 'M', merchantName:'M', transactionId:'MERCHANT_TX', payments:[{paymentSystem:125,value:1000}] }] } };
const pay = { status: 201, ok: true, json: {} }, cb = { status: 200, json: {} };
const run = h => h.tool.run({ carrinho_id: 'C' });
function safe(text) {
  ok(!/cai sozinho|monto de novo|Vale por (alguns|poucos) minutos|nada foi cobrado|A loja não criou o pedido/i.test(text), text);
  ok(text.includes('Confira com a loja antes de tentar outra compra'));
  ok(text.includes('Não consigo consultar o estado atual'));
  ok(!text.includes('PRIVATE_RAW'));
}
function identified(h, r, success=false) {
  eq(r.ok, success); safe(r.saida);
  ok(r.saida.includes('Pedido *ORDER*')); ok(r.saida.includes('Total a pagar: *10*'));
  ok(r.saida.includes('O vencimento do Pix não confirma o cancelamento'));
  const rendered = h.render(r); ok(rendered.includes(r.saida)); safe(rendered); if (!success) { ok(!rendered.includes('✅')); ok(!rendered.includes('Pedido feito')); }
  eq(h.calls.filter(c => c.url.endsWith('/transaction')).length, 1);
  h.done();
}
// Guardrails remain before transaction: no payment/order request when blocked.
for (const options of [{ exists: false }, { overrides: { pix: null } }, { overrides: { plataforma: 'shopify', checkoutUrl: 'https://shop.invalid/cart' } }]) {
  const h = harness([], options); const r = await run(h); eq(r.ok, false); eq(h.calls.length, 0); h.done();
}
{
  const h = harness([], { exists: false }); ok((await h.tool.preflight({ carrinho_id: 'C' })).erro); eq(h.calls.length, 0);
  const valid = harness([]); eq(await valid.tool.preflight({ carrinho_id: 'C' }), null); eq(valid.calls.length, 0);
}
for (const result of [{ status: 200, json: { value: 1200 } }, { status: 503 }, new Error('synthetic GET timeout')]) {
  const h = harness([result]); eq((await run(h)).ok, false); eq(h.calls.map(x => x.method), ['GET']); h.done();
}
{
  const h = harness([get, new Error('synthetic attachment timeout')]); eq((await run(h)).ok, false); eq(h.calls.length, 2); h.done();
}
// Every incomplete/failed transaction stops, reports uncertainty and keeps valid partial IDs.
for (const result of [
  new Error('synthetic timeout'), null, { status: 503 },
  { status: 200, json: { messages: { text: 'PRIVATE_RAW' } } },
  { status: 200, json: { messages: [{ text: 'PRIVATE_RAW' }] } },
  { status: 200, json: { orderGroup: 'ORDER' } },
  { status: 200, json: { id: 'TX' } },
  { status: 400, json: tr.json }, { status: 503, json: tr.json },
  { status: 200, json: { orderGroup: {}, id: 'TX' } },
  { status: 200, json: { orderGroup: 'ORDER', id: [] } },
  { status: 200, json: { orderGroup: ' ', id: '\t' } },
]) {
  const h = harness([get, pd, result]); const r = await run(h);
  eq(r.ok, false); ok(r.error.includes('resultado desta tentativa é incerto')); safe(r.error);
  if (typeof result?.json?.orderGroup === 'string' && result.json.orderGroup.trim()) ok(r.error.includes(result.json.orderGroup.trim()));
  if (typeof result?.json?.id === 'string' && result.json.id.trim()) ok(r.error.includes(result.json.id.trim()));
  const rendered = h.render(r); ok(rendered.includes(r.error)); safe(rendered);
  eq(h.calls.map(c => c.method), ['GET', 'POST', 'POST']); h.done();
}
for (const receiverUri of [null, '', 'not-a-url']) {
  const h = harness([get, pd, { ...tr, json: { ...tr.json, receiverUri } }]); identified(h, await run(h)); eq(h.calls.length, 3);
}
for (const result of [new Error('synthetic payment timeout'), null, { status: 503, ok: false }, { status: 400, ok: false }]) {
  const h = harness([get, pd, tr, result]); const r = await run(h); identified(h, r);
  ok(r.saida.includes('não consegui confirmar o resultado do envio do pagamento')); eq(h.calls.length, 4);
}
const parser = harness([]).ctx.p;
// CRC fixture is deliberately NOT a payable BR Code.
const prefix = '0002010102126304', code = prefix + parser.crc16(prefix);
const badCode = code.slice(0, -1) + (code.endsWith('0') ? '1' : '0');
for (const expiration of ['2026-09-11T12:00:00Z', null, 'invalid-date']) {
  for (const source of ['pay', 'callback']) {
    const fixture = { paymentAppData: { payload: JSON.stringify({ code, expiresAt: expiration, qrCodeBase64Image: 'PRIVATE_RAW' }) } };
    const h = harness([get, pd, tr, { ...pay, json: source === 'pay' ? fixture : {} }, { ...cb, status: 428, json: source === 'callback' ? fixture : {} }]);
    const r = await run(h); identified(h, r, true); eq(h.calls.length, 5);
    ok(r.saida.includes('\n' + code + '\n')); ok(!r.saida.includes('```'));
    ok(r.saida.includes(expiration === '2026-09-11T12:00:00Z' ? 'até as 09:00 (horário de São Paulo)' : 'não tenho um prazo confirmado'));
  }
}
for (const payload of ['https://payment.invalid/pix?u=one&cb=two', { code: badCode }, { qrCodeBase64Image: 'PRIVATE_RAW' }]) {
  const fixture = { paymentAuthorizationAppCollection: [{ appPayload: payload }] };
  const h = harness([get, pd, tr, pay, { ...cb, json: fixture }]); const r = await run(h); identified(h, r, typeof payload === 'string');
  if (typeof payload === 'string') { ok(r.saida.includes(payload)); ok(r.saida.includes('Confira a validade do Pix na tela')); }
  else if (payload.code) { ok(r.saida.includes('não passou na verificação')); ok(!r.saida.includes(badCode)); }
  else ok(r.saida.includes('não consegui puxar o Pix'));
}
for (const result of [null, new Error('synthetic callback timeout'), { status: 503, json: {} }]) {
  const h = harness([get, pd, tr, pay, result]); identified(h, await run(h)); eq(h.calls.length, 5);
}
{
  const h = harness([]); ok(!Array.from(h.ctx.tools, t => t.name).some(n => /consultar_pedido|status_pedido|reemitir_pix/.test(n)));
  eq(parser.extrairPix({ paymentAppData: { payload: { qrCodeBase64Image: 'PRIVATE_RAW' } } }), null);
}

// Contract-correct request: exact orderGroup, authoritative merchant transaction.
{
 const h=harness([get,pd,tr,{status:400,ok:false,json:{error:{code:'CHK0210',message:'Invalid paymentSystem for orderId PRIVATE_RAW'}}}]);const r=await run(h);
 identified(h,r);const p=h.calls[3];eq(p.url,'https://payment.invalid/api/pub/transactions/MERCHANT_TX/payments?orderId=ORDER');
 eq(JSON.parse(JSON.stringify(p.body)),[{paymentSystem:125,installments:1,currencyCode:'BRL',value:1000,installmentsInterestRate:0,installmentsValue:1000,referenceValue:1000,fields:{},transaction:{id:'MERCHANT_TX',merchantName:'M'}}]);
 ok(r.diagnostic_ref);ok(h.logs.some(l=>l.includes('FALHOU')&&l.includes(r.diagnostic_ref)));ok(!h.logs.some(l=>l.includes('fechar_pedido')&&l.includes(' ok ')));ok(!r.saida.includes('PRIVATE_RAW'));const again=await run(h);eq(again.ok,false);eq(h.calls.length,4);
}
for(const result of [{status:400,json:{error:'PRIVATE_RAW'}},{status:200,json:{messages:[{status:'error',text:'PRIVATE_RAW'}]}},{status:500,json:{value:1000}}]){
 const isGet=result.status===500;const h=harness(isGet?[result]:[get,result]);const r=await run(h);eq(r.ok,false);eq(h.calls.length,isGet?1:2);ok(!h.calls.some(x=>x.url.endsWith('/transaction')));h.done();
}
for(const result of [{status:201,ok:true,json:{error:'PRIVATE_RAW'}},{status:200,ok:true},{status:202,ok:true},{status:204,ok:true},{status:302,ok:false}]){const h=harness([get,pd,tr,result]);identified(h,await run(h));eq(h.calls.length,4);}
for(const merchants of [[],null,[{id:'M'}],[{id:'M',transactionId:'TX'},{id:'OTHER',transactionId:'OTHER_TX'}],[{id:'M',transactionId:'TX',payments:[{paymentSystem:125,value:1}]}]]){
 const h=harness([get,pd,{...tr,json:{...tr.json,merchantTransactions:merchants}}]);identified(h,await run(h));eq(h.calls.length,3);
}
// A network timeout after dispatch can never become a second transaction.
{const h=harness([get,pd,new Error('lost response')]);eq((await run(h)).ok,false);eq((await run(h)).ok,false);eq(h.calls.length,3);h.done();}
// Concurrent confirmation attempts are fenced before the first HTTP await.
{const h=harness([get,pd,tr,{status:400}]);const [a,b]=await Promise.all([run(h),run(h)]);eq(a.ok,false);eq(b.ok,false);ok(b.error.includes('sendo processado'));eq(h.calls.length,4);h.done();}
{const h=harness([{status:500,json:{value:1000}},get,pd,tr,{status:400}]);eq((await run(h)).ok,false);eq((await run(h)).ok,false);eq(h.calls.length,5);eq(h.calls.filter(c=>c.url.endsWith('/transaction')).length,1);h.done();}
// Regression from the actual VTEX checkout-ui contract, synthetic payment URLs.
for (const name of ['RedirectResponseCollection','redirectResponseCollection']) {
  const url='https://payment.invalid/pix?u=opaque%2Btoken&cb=https%3A%2F%2Fshop.invalid%2Fdone&cr=a%26b';
  const h=harness([get,pd,tr,pay,{status:428,json:{[name]:[{redirectUrl:url}]}}]);
  const r=await run(h);identified(h,r,true);ok(r.saida.includes(url));eq(h.calls.length,5);
  eq(h.calls.filter(x=>x.url.includes('gatewayCallback')).length,1);
  // Extracting a URL never opens it or posts to a provider.
  ok(!h.calls.some(x=>x.url===url));
}
for (const unsafe of ['http://payment.invalid/pix','javascript:alert(1)','data:text/html,PRIVATE_RAW','https://user:PRIVATE_RAW@payment.invalid/pix','https://payment.invalid/\npix','/relative/pix','//payment.invalid/pix','https://payment.invalid/'+ 'x'.repeat(8200)]) {
  const h=harness([get,pd,tr,pay,{status:428,json:{RedirectResponseCollection:[{redirectUrl:unsafe,value:'https://fallback.invalid'}]}}]);
  const r=await run(h);identified(h,r);eq(h.calls.length,5);ok(!r.saida.includes('fallback.invalid'));
}
for (const json of [
 {RedirectResponseCollection:{redirectUrl:'https://payment.invalid'}},
 {RedirectResponseCollection:[]}, {RedirectResponseCollection:[null]},
 {paymentAuthorizationAppCollection:'PRIVATE_RAW'},
 {paymentAuthorizationAppCollection:{appPayload:'PRIVATE_RAW'}},
 {paymentAuthorizationAppCollection:[{appName:'PRIVATE_RAW',appPayload:JSON.stringify({transactionId:'PRIVATE_RAW',paymentId:'PRIVATE_RAW'})}]},
]) {
 const h=harness([get,pd,tr,pay,{status:428,json}]);const r=await run(h);identified(h,r);eq(h.calls.length,5);
 ok(r.saida.includes('sem código Pix ou link utilizável reconhecido'));ok(!r.saida.includes('tela de pagamento da loja só abre'));
 eq((await run(h)).ok,false);eq(h.calls.length,5); // Never recreate when app requires extra integration.
}
for (const key of ['value','url']) {
 const h=harness([get,pd,tr,pay,{status:428,json:{RedirectResponseCollection:[{[key]:'https://payment.invalid/legacy'}]}}]);
 const r=await run(h);identified(h,r,true);ok(r.saida.includes('https://payment.invalid/legacy'));
}
// Full flow fixture from the BCB manual: legitimate spaces survive through
// parser, confirmed output and renderer. No bank/provider request is made.
{
 const code='00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';
 for(const json of [{paymentAuthorizationAppCollection:[{appPayload:JSON.stringify({code,qrCodeBase64Image:'PRIVATE_RAW'})}]},{paymentAppData:{payload:{code}}}]){
  const h=harness([get,pd,tr,pay,{status:428,json}]);const r=await run(h);identified(h,r,true);ok(r.saida.includes('\n'+code+'\n'));ok(h.render(r).includes(code));eq(h.calls.length,5);
 }
 for(const invalid of [code.slice(0,-1)+'0',code.replace('Fulano de Tal','Fulano\nde Tal'),'',null,{}]){
  const h=harness([get,pd,tr,pay,{status:428,json:{paymentAuthorizationAppCollection:[{appPayload:JSON.stringify({code:invalid,qrCodeBase64Image:'PRIVATE_RAW'})}]}}]);
  const r=await run(h);identified(h,r);ok(!r.saida.includes('Fulano'));eq((await run(h)).ok,false);eq(h.calls.length,5);
 }
}
// Protected capture happens before parsing, including a code the validator rejects.
{
 const raw={code:'000201 INVALID ORIGINAL',qrCodeBase64Image:'PRIVATE_RAW'};
 const h=harness([get,pd,tr,pay,{status:428,json:{paymentAuthorizationAppCollection:[{appPayload:JSON.stringify(raw)}]}}]);
 const r=await run(h);identified(h,r);eq(h.saves.length,2);eq(h.saves[1][3],'pix_received');
 ok(h.saves[1][4][1].paymentAuthorizationAppCollection[0].appPayload.includes(raw.code));
}
// If protected storage cannot be prepared, no new order is sent to the shop.
{
 const h=harness([get,pd]);h.ctx.checkoutRecoveryStore.reserve=async()=>{throw Error('PRIVATE_DATABASE_ERROR');};
 const r=await run(h);eq(r.ok,false);eq(h.calls.length,2);ok(!r.error.includes('PRIVATE'));h.done();
}
// Failure to save the returned order reference stops before payment submission.
{
 const h=harness([get,pd,tr]);h.ctx.checkoutRecoveryStore.save=async()=>{throw Error('PRIVATE');};
 const r=await run(h);eq(r.ok,false);eq(h.calls.length,3);ok(r.error.includes('ORDER'));h.done();
}
// Recovery is actually exposed to the assistant, and performs zero store checkout calls.
{
 const h=harness([]);const tool=h.ctx.tools.find(t=>t.name==='recuperar_pix_pedido');ok(tool);
 const r=await tool.run({pedido_id:'ORDER'});eq(r.ok,false);eq(r.status,'record_missing');eq(h.calls.length,0);h.done();
}
// A DB failure after the callback cannot cause a second creation/payment POST.
{
 const h=harness([get,pd,tr,pay,{status:428,json:{}}]);h.ctx.checkoutRecoveryStore.save=async(s,r,id,stage)=>{if(stage==='pix_received')throw Error('PRIVATE_STORAGE');};
 const r=await run(h);eq(r.ok,false);ok(r.error.includes('ORDER'));ok(!r.error.includes('PRIVATE'));eq(h.calls.length,5);eq((await run(h)).ok,false);eq(h.calls.length,5);h.done();
}
console.log(`${checks} verificações passaram; checkout/parser/render reais em VM, rede/DB/carrinhos/pagamentos reais não utilizados.`);
