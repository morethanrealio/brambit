// Pure checkout contract/diagnostics. No HTTP, DB, vault, cookies or retries here.
import { createHash, randomUUID } from 'node:crypto';
const reference = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v) ? v : null;
export function paymentRequest(transaction, pix, value) {
  const merchants = transaction?.merchantTransactions;
  if (!Array.isArray(merchants) || merchants.length !== 1) throw Error('merchant_count');
  const merchant = merchants[0];
  const orderGroup = reference(transaction.orderGroup), id = reference(merchant?.transactionId);
  // merchantName is authoritative; id is the documented account-name alias.
  const merchantName = reference(merchant?.merchantName ?? merchant?.id);
  if (!orderGroup || !id || !merchantName) throw Error('transaction_reference');
  if (!Number.isSafeInteger(value) || value <= 0 || !Number.isSafeInteger(Number(pix?.id)) || Number(pix.id) <= 0) throw Error('payment_values');
  if (Array.isArray(merchant.payments) && (merchant.payments.length !== 1 || Number(merchant.payments[0].paymentSystem) !== Number(pix.id) || Number(merchant.payments[0].value) !== value)) throw Error('payment_allocation');
  let receiver; try { receiver = new URL(transaction.receiverUri); } catch { throw Error('payment_receiver'); }
  if (receiver.protocol !== 'https:' || receiver.username || receiver.password) throw Error('payment_receiver');
  // Existing-cart VTEX contract uses orderGroup, NOT a fabricated -01 suffix.
  return {url:`${receiver.origin}/api/pub/transactions/${encodeURIComponent(id)}/payments?orderId=${encodeURIComponent(orderGroup)}`,body:[{
    paymentSystem:Number(pix.id), installments:1, currencyCode:'BRL', value,
    installmentsInterestRate:0, installmentsValue:value, referenceValue:value,
    fields:{}, transaction:{id,merchantName},
  }]};
}
// Application safety bound, not a claim about the BR Code specification.
export const PIX_CODE_MAX = 512;
export function pixCrc16(value) {
  let crc=0xffff;
  // Pix BR Code uses ASCII; callers reject other characters before accepting.
  for (let i=0;i<value.length;i++) {
    crc ^= value.charCodeAt(i) << 8;
    for(let b=0;b<8;b++) crc=(crc&0x8000)?((crc<<1)^0x1021)&0xffff:(crc<<1)&0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4,'0');
}
function tlvFields(value) {
  const fields=new Map();
  for(let i=0;i<value.length;) {
    const head=value.slice(i,i+4);
    if(!/^\d{4}$/.test(head)) return null;
    const tag=head.slice(0,2),length=Number(head.slice(2));
    if(fields.has(tag)||i+4+length>value.length) return null;
    fields.set(tag,value.slice(i+4,i+4+length)); i+=4+length;
  }
  return fields;
}
// Return only diagnostics. Never return the code, CRC value, merchant name,
// payment URL, arbitrary field IDs or any other value from the BR Code.
export function pixCodeDiagnostic(raw) {
  const type=raw==null?(raw===null?'null':'missing'):Array.isArray(raw)?'array':typeof raw;
  const d={type,length:typeof raw==='string'?raw.length:null,trimmedLength:null,spaces:null,controls:null,
    prefixValid:null,crcPresent:null,crcValid:null,structureValid:null,valid:false,reason:'not_string'};
  if(typeof raw!=='string') return {...d,reason:type==='missing'?'missing':'not_string'};
  // trim outside only; never strip/normalize whitespace inside the payload.
  const c=raw.trim();d.trimmedLength=c.length;
  if(!c.length) return {...d,reason:'empty'};
  if(raw.length>PIX_CODE_MAX+16||c.length>PIX_CODE_MAX) return {...d,reason:'application_length_limit'};
  d.spaces=(c.match(/ /g)||[]).length;
  d.controls=(c.match(/[\u0000-\u001f\u007f]/g)||[]).length;
  d.prefixValid=c.startsWith('000201');d.crcPresent=/6304[0-9a-f]{4}$/i.test(c);
  const ascii=/^[\x20-\x7e]+$/.test(c);
  d.crcValid=d.crcPresent&&ascii?pixCrc16(c.slice(0,-4))===c.slice(-4).toUpperCase():null;
  if(d.controls) return {...d,reason:'control_character'};
  if(!ascii) return {...d,reason:'unsupported_character'};
  if(!d.prefixValid) return {...d,reason:'invalid_prefix'};
  if(!d.crcPresent) return {...d,reason:'crc_missing'};
  const fields=tlvFields(c);
  d.structureValid=!!fields&&fields.get('00')==='01'&&fields.get('63')?.length===4&&[...fields.keys()].at(-1)==='63';
  if(d.structureValid) for(const [id,value] of fields) {
    if((Number(id)>=26&&Number(id)<=51)||id==='62') {
      if(!tlvFields(value)){d.structureValid=false;break;}
    }
  }
  if(!d.structureValid) return {...d,reason:'invalid_tlv'};
  if(!d.crcValid) return {...d,reason:'crc_mismatch'};
  return {...d,valid:true,reason:'valid'};
}
// Closed schema only: no provider values, arbitrary keys, app names, tokens,
// URLs, QR images, transaction IDs or payload text are logged.
export function pixResponseShape(json) {
  const type = v => v == null ? 'absent' : Array.isArray(v) ? 'array' : typeof v;
  const payload = raw => {
    const shape = {type:type(raw)};
    let obj=raw;
    if (typeof raw === 'string') {
      if (raw.length > 32768) return {...shape,encoding:'oversize'};
      const t=raw.trim();
      if (/^https?:\/\//i.test(t)) return {...shape,encoding:'url'};
      if (t.startsWith('000201')) return {...shape,encoding:'emv',codeChecks:[{field:'raw',...pixCodeDiagnostic(raw)}]};
      try { obj=JSON.parse(t); shape.encoding='json'; } catch { return {...shape,encoding:'text'}; }
    }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      shape.fields=['code','qrCodeText','pixCode','emv','qrCode','url','paymentUrl','redirectUrl','checkoutUrl','expiresAt','expiration','transactionId','paymentId','qrCodeBase64Image'].filter(k=>Object.hasOwn(obj,k));
      shape.codeChecks=['code','qrCodeText','pixCode','emv','qrCode'].filter(k=>Object.hasOwn(obj,k)).map(field=>({field,...pixCodeDiagnostic(obj[field])}));
    }
    return shape;
  };
  const collection = raw => ({type:type(raw),count:Array.isArray(raw)?Math.min(raw.length,99):0});
  const apps=json?.paymentAuthorizationAppCollection;
  const red=json?.RedirectResponseCollection ?? json?.redirectResponseCollection;
  const app=json?.paymentAppData ?? json?.paymentData?.paymentAppData;
  return {paymentApp:{type:type(app),payload:payload(app?.payload)},
    authorizationApps:{...collection(apps),items:Array.isArray(apps)?apps.slice(0,4).map(x=>({payload:payload(x?.appPayload)})):[]},
    redirects:{...collection(red),items:Array.isArray(red)?red.slice(0,4).map(x=>({fields:['redirectUrl','value','url'].filter(k=>x && typeof x==='object' && Object.hasOwn(x,k))})):[]}};
}
// Never copy provider prose/JSON into logs. Free text can echo CPF, addresses,
// tokens or Pix strings. Keep only a closed vocabulary and a one-way fingerprint.
export function paymentDiagnostic(stage, response, contractReason = null) {
  const stages = new Set(['cart','payment_data','transaction','payment_contract','payment','callback','pix']);
  const contractReasons = new Set(['merchant_count','transaction_reference','payment_values','payment_allocation','payment_receiver']);
  let raw = '';
  try { raw = typeof response?.text === 'string' ? response.text : response?.json != null ? JSON.stringify(response.json) : ''; } catch { raw = ''; }
  const clipped = raw.slice(0, 32768);
  const normalized = clipped.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
  const reasons = [];
  for (const [name, re] of [
    ['transaction_not_found',/(transaction|transacao).{0,60}(not found|does not exist|nao encontrad)/],
    ['order_not_found',/(order|pedido).{0,60}(not found|does not exist|nao encontrad)/],
    ['amount_mismatch',/(value|amount|valor).{0,60}(mismatch|different|invalid|diferente|invalido|nao confere)/],
    ['required_field',/required|mandatory|obrigatorio|cannot be null/],
    ['invalid_payment_system',/(payment.?system|meio de pagamento).{0,60}(invalid|invalido|not found)/],
    ['access_denied',/unauthorized|forbidden|access denied|acesso negado/],
    ['transaction_expired',/(transaction|transacao).{0,60}(expired|expirad)/],
  ]) if (re.test(normalized)) reasons.push(name);
  const fields = ['orderId','orderGroup','transactionId','merchantName','paymentSystem','value','referenceValue','currencyCode'].filter(k=>new RegExp('\\b'+k+'\\b','i').test(clipped));
  const codes = [...new Set(clipped.match(/\b(?:CHK\d{4}|PAY\d{3,5})\b/g) || [])].slice(0,8);
  const http = Number.isInteger(response?.status) && response.status>=100 && response.status<=599 ? response.status : null;
  const pixShape=['pix','callback'].includes(stage)?pixResponseShape(response?.json):null;
  const codeChecks=pixShape?[...(pixShape.paymentApp.payload.codeChecks||[]),...pixShape.authorizationApps.items.flatMap(x=>x.payload.codeChecks||[])]:[];
  const pixReasons=[...new Set(codeChecks.filter(x=>!x.valid).map(x=>'pix_'+x.reason))].slice(0,8);
  return {ref:randomUUID(),stage:stages.has(stage)?stage:'payment',http,
    kind:response==null?'no_response':response.json!=null?'json':raw?'text':'empty',
    reason:contractReasons.has(contractReason)?contractReason:pixReasons.length?pixReasons.join(','):reasons.length?reasons.join(','):'unclassified',
    ...(pixShape?{pixShape}:{}),
    fields,codes,fingerprint:raw?createHash('sha256').update(raw).digest('hex'):null};
}
export function checkoutFailure(stage, response, text, contractReason = null) {
  const diagnostic = paymentDiagnostic(stage,response,contractReason);
  console.log('[checkout-diagnostic] '+JSON.stringify(diagnostic));
  return {ok:false,status:'checkout_incomplete',error:'Não consegui concluir a etapa de pagamento. Não repeti a tentativa.',
    saida:text,diagnostic_ref:diagnostic.ref};
}
