import {test} from 'node:test';
import assert from 'node:assert/strict';
import {paymentRequest,paymentDiagnostic,pixResponseShape,pixCodeDiagnostic,pixCrc16} from '../web/checkout-payment.mjs';
const tr={id:'TOP',orderGroup:'GROUP-01',receiverUri:'https://shop.vtexpayments.com.br/split/GROUP-01/payments',merchantTransactions:[{id:'ALIAS',merchantName:'shop',transactionId:'MERCHANT_TX',payments:[{paymentSystem:'125',value:14089}]}]};
test('uses order group exactly without appending/stripping suffix; merchant transaction and name',()=>{
 const p=paymentRequest(tr,{id:125},14089);assert.equal(new URL(p.url).searchParams.get('orderId'),'GROUP-01');assert.ok(p.url.includes('/MERCHANT_TX/payments'));assert.deepEqual(p.body[0].transaction,{id:'MERCHANT_TX',merchantName:'shop'});assert.equal(p.body[0].value,14089);
});
test('fails closed for ambiguous or incomplete allocations, never invents identifiers',()=>{
 for(const merchants of [null,[],[{}],[{...tr.merchantTransactions[0],transactionId:undefined}],[tr.merchantTransactions[0],tr.merchantTransactions[0]],[{...tr.merchantTransactions[0],payments:[]}],[{...tr.merchantTransactions[0],payments:[{paymentSystem:125,value:1}]}]])assert.throws(()=>paymentRequest({...tr,merchantTransactions:merchants},{id:125},14089));
 for(const receiverUri of ['http://shop.invalid','https://user:secret@shop.invalid','invalid'])assert.throws(()=>paymentRequest({...tr,receiverUri},{id:125},14089));
 for(const value of [NaN,Infinity,0,-1,1.5])assert.throws(()=>paymentRequest(tr,{id:125},value));
});
test('safe useful diagnostic: codes, reason, field names and correlation, not raw private data',()=>{
 const response={status:400,json:{error:{code:'CHK0210',message:'Value mismatch; transaction not found; orderId required; merchantName Ana Silva; email ana@example.invalid; cpf 12345678901; Authorization Bearer SECRET_TOKEN; Pix 000201SECRET; Rua Privada 100'},cookie:'SESSION_SECRET'}};
 const d=paymentDiagnostic('payment',response);const serialized=JSON.stringify(d);
 assert.equal(d.http,400);assert.equal(d.kind,'json');assert.deepEqual(d.codes,['CHK0210']);assert.ok(d.reason.includes('transaction_not_found'));assert.ok(d.reason.includes('amount_mismatch'));assert.ok(d.reason.includes('required_field'));assert.ok(d.fields.includes('orderId'));assert.match(d.fingerprint,/^[a-f0-9]{64}$/);assert.match(d.ref,/^[a-f0-9-]{36}$/);
 for(const forbidden of ['Ana','Silva','example','12345678901','SECRET','Privada','000201'])assert.ok(!serialized.includes(forbidden),forbidden);
 assert.equal(paymentDiagnostic('payment',response).fingerprint,d.fingerprint);
});
test('unknown, HTML, long body and malicious diagnostic fields remain private/unclassified',()=>{
 for(const response of [null,{status:503,text:'<html>PRIVATE_NAME secret_cookie</html>'},{status:400,json:{code:'PRIVATE_TOKEN',message:'private unknown'}},{status:400,text:'PRIVATE_NAME '.repeat(10000)}]){
  const d=paymentDiagnostic('PRIVATE_STAGE',response,'PRIVATE_REASON');assert.equal(d.stage,'payment');assert.equal(d.reason,'unclassified');assert.ok(!JSON.stringify(d).includes('PRIVATE'));if(!response){assert.equal(d.kind,'no_response');assert.equal(d.fingerprint,null);}
 }
 assert.equal(paymentDiagnostic('payment_contract',null,'payment_receiver').reason,'payment_receiver');
});

test('Pix diagnostics distinguish app/redirect shapes without provider values',()=>{
 const json={paymentAuthorizationAppCollection:[{appName:'PRIVATE_NAME',appPayload:JSON.stringify({transactionId:'PRIVATE_TX',paymentId:'PRIVATE_PAYMENT',nestedSecret:'PRIVATE_SECRET'})}],RedirectResponseCollection:[{redirectUrl:'https://private.invalid/?token=PRIVATE_TOKEN'}]};
 const d=paymentDiagnostic('pix',{status:428,json});
 assert.equal(d.pixShape.authorizationApps.count,1);
 assert.deepEqual(d.pixShape.authorizationApps.items[0].payload,{type:'string',encoding:'json',fields:['transactionId','paymentId'],codeChecks:[]});
 assert.deepEqual(d.pixShape.redirects.items[0].fields,['redirectUrl']);
 const output=JSON.stringify(d);for(const value of ['PRIVATE','private.invalid','appName','nestedSecret'])assert.ok(!output.includes(value),value);
 assert.equal(d.http,428);assert.equal(d.reason,'unclassified');
});
test('Pix shape is bounded, tolerates malformed and missing collections',()=>{
 for(const raw of [null,undefined,42,'PRIVATE',{},[]])assert.doesNotThrow(()=>pixResponseShape(raw));
 const s=pixResponseShape({paymentAuthorizationAppCollection:Array.from({length:1000},()=>({appPayload:'PRIVATE'.repeat(10000)})),RedirectResponseCollection:{url:'PRIVATE'}});
 assert.equal(s.authorizationApps.count,99);assert.equal(s.authorizationApps.items.length,4);assert.equal(s.authorizationApps.items[0].payload.encoding,'oversize');assert.equal(s.redirects.type,'object');assert.deepEqual(s.redirects.items,[]);assert.ok(!JSON.stringify(s).includes('PRIVATE'));
 for(const [raw,encoding] of [['https://private.invalid/?token=PRIVATE','url'],['000201PRIVATE','emv'],['PRIVATE','text']]){
  const s=pixResponseShape({paymentAppData:{payload:raw}});assert.equal(s.paymentApp.payload.encoding,encoding);assert.ok(!JSON.stringify(s).includes('PRIVATE'));
 }
});

const bcb='00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';
const withCrc=prefix=>prefix+pixCrc16(prefix);
test('official BCB example accepts ordinary spaces with original CRC, without rewriting code',()=>{
 const d=pixCodeDiagnostic(bcb);assert.equal(d.valid,true);assert.equal(d.reason,'valid');assert.equal(d.spaces,2);assert.equal(d.controls,0);assert.equal(d.crcValid,true);assert.equal(d.structureValid,true);assert.equal(d.length,bcb.length);
 assert.equal(pixCodeDiagnostic('  '+bcb+'  ').valid,true);
 // Stripping internal spaces is NOT a valid fix: changes CRC and TLV lengths.
 assert.equal(pixCodeDiagnostic(bcb.replaceAll(' ','')).valid,false);
});
test('typed rejection reasons cover missing, empty, invalid, length, control, TLV and CRC',()=>{
 for(const [raw,reason] of [[undefined,'missing'],[null,'not_string'],[{},'not_string'],[123,'not_string'],['','empty'],['   ','empty'],['000201'+'x'.repeat(600),'application_length_limit'],['PRIVATE','invalid_prefix'],['000201010212','crc_missing'],[bcb.slice(0,-1)+'0','crc_mismatch'],[withCrc('0002015909TEST6304'),'invalid_tlv'],[withCrc('0002015901X5901Y6304'),'invalid_tlv'],[withCrc('0002016205WRONG6304'),'invalid_tlv'],[withCrc('00020163086304'),'invalid_tlv']]){
  const d=pixCodeDiagnostic(raw);assert.equal(d.valid,false);assert.equal(d.reason,reason,reason);
 }
 for(const value of ['\n','\t','\r','\u0000','\u007f'])assert.equal(pixCodeDiagnostic(bcb.replace('Fulano de Tal','Fulano'+value+'de Tal')).reason,'control_character');
 assert.equal(pixCodeDiagnostic(bcb.replace('Fulano','Fulánó')).reason,'unsupported_character');
});
test('callback diagnostics describe rejected code without raw payment details',()=>{
 const invalid=bcb.slice(0,-1)+'0';
 const d=paymentDiagnostic('pix',{status:428,json:{paymentAuthorizationAppCollection:[{appPayload:JSON.stringify({code:invalid,qrCodeBase64Image:'PRIVATE_IMAGE',expiresAt:'PRIVATE_DATE',paymentId:'PRIVATE_PAYMENT'})}]}});
 assert.equal(d.reason,'pix_crc_mismatch');
 const v=d.pixShape.authorizationApps.items[0].payload.codeChecks[0];assert.equal(v.field,'code');assert.equal(v.reason,'crc_mismatch');assert.equal(v.spaces,2);assert.equal(v.crcValid,false);assert.equal(v.structureValid,true);assert.equal(v.type,'string');assert.equal(v.length,bcb.length);
 const serialized=JSON.stringify(d);for(const secret of ['Fulano','Tal','123e4567','PRIVATE',invalid,'1D3D'])assert.ok(!serialized.includes(secret),secret);
 for(const value of ['',null,{},[],false,1]){
  const shape=pixResponseShape({paymentAppData:{payload:{code:value}}});assert.equal(shape.paymentApp.payload.codeChecks[0].valid,false);
 }
});
