// No network dependency: recovery can NEVER create a transaction or payment.
// Raw Pix strings are retained only inside the encrypted, owner-bound envelope.
import {randomUUID} from 'node:crypto';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF=/^[a-zA-Z0-9_-]{1,100}$/;
const TABLE='mtr_harness.checkout_pix_records';
function scope(s,thread=false){if(!UUID.test(s?.userId||'')||!UUID.test(s?.agentId||'')||(thread&&!UUID.test(s?.threadId||'')))throw Error('invalid_scope');}
function origin(raw){const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password)throw Error('invalid_origin');return u.origin;}
function payload(raw){
 if(typeof raw==='string'){
  if(raw.length>1024*1024)throw Error('payload_limit');
  const t=raw.trim();if(t.startsWith('{')){try{raw=JSON.parse(t);}catch{return null;}}
  else return raw.length<=8192?raw:null;
 }
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const out={};
 for(const k of ['code','qrCodeText','pixCode','emv','qrCode','url','paymentUrl','redirectUrl','checkoutUrl','expiresAt','expiration']){
  const v=raw[k];if(typeof v==='string'&&v.length<=8192)out[k]=v;
 }
 return out;
}
export function snapshotPixResponses(...responses){
 return responses.slice(0,2).map(r=>{
  const out={},app=r?.paymentAppData??r?.paymentData?.paymentAppData;
  if(app)out.paymentAppData={payload:payload(app.payload)};
  if(Array.isArray(r?.paymentAuthorizationAppCollection))out.paymentAuthorizationAppCollection=r.paymentAuthorizationAppCollection.slice(0,4).map(x=>({appPayload:payload(x?.appPayload)}));
  const redirects=r?.RedirectResponseCollection??r?.redirectResponseCollection;
  if(Array.isArray(redirects))out.RedirectResponseCollection=redirects.slice(0,4).map(x=>payload(x));
  return out;
 });
}
export function createCheckoutRecoveryStore(pool,{encrypt,decrypt,enabled}){
 const ready=()=>{if(!enabled())throw Error('vault_unavailable');};
 return {
  async ensureSchema(){await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
   id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES mtr_harness.users(id) ON DELETE CASCADE,
   agent_id uuid NOT NULL REFERENCES mtr_harness.agents(id) ON DELETE CASCADE,
   thread_id uuid NOT NULL REFERENCES mtr_harness.threads(id) ON DELETE CASCADE,
   order_id text, stage text NOT NULL CHECK(stage IN ('prepared','created','payment_failed','callback_failed','pix_received')),
   payload_enc text NOT NULL CHECK(payload_enc LIKE 'v1:%'), created_at timestamptz NOT NULL DEFAULT now(),
   updated_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
   UNIQUE(user_id,agent_id,order_id))`);
   await pool.query(`CREATE INDEX IF NOT EXISTS checkout_pix_expiry_idx ON ${TABLE}(expires_at)`);},
  async purgeExpired(){await pool.query(`DELETE FROM ${TABLE} WHERE expires_at<=now()`);},
  async reserve(s,details){
   scope(s,true);ready();const id=randomUUID();
   const data={userId:s.userId,agentId:s.agentId,threadId:s.threadId,id,origin:origin(details.origin),total:details.total};
   if(!Number.isSafeInteger(data.total)||data.total<=0)throw Error('invalid_total');
   const sealed=encrypt(JSON.stringify(data));if(!sealed.startsWith('v1:'))throw Error('vault_format');
   const r=await pool.query(`INSERT INTO ${TABLE}(id,user_id,agent_id,thread_id,stage,payload_enc)
    SELECT $1,$2,$3,$4,'prepared',$5 FROM mtr_harness.threads t JOIN mtr_harness.agents a ON a.id=t.agent_id AND a.user_id=t.user_id JOIN mtr_harness.users u ON u.id=t.user_id
    WHERE t.id=$4 AND t.user_id=$2 AND t.agent_id=$3 AND t.deleted_at IS NULL AND u.deleted_at IS NULL RETURNING id`,[id,s.userId,s.agentId,s.threadId,sealed]);
   if(r.rows.length!==1)throw Error('not_owned');return {...data};
  },
  async save(s,record,orderId,stage,responses=[]){
   scope(s,true);ready();if(!UUID.test(record?.id||'')||record.userId!==s.userId||record.agentId!==s.agentId||record.threadId!==s.threadId||!REF.test(orderId)||!['created','payment_failed','callback_failed','pix_received'].includes(stage))throw Error('invalid_record');
   const data={...record,orderId,responses:snapshotPixResponses(...responses)};
   const sealed=encrypt(JSON.stringify(data));if(!sealed.startsWith('v1:'))throw Error('vault_format');
   const r=await pool.query(`UPDATE ${TABLE} r SET order_id=$5,stage=$6,payload_enc=$7,updated_at=now()
    WHERE r.id=$1 AND r.user_id=$2 AND r.agent_id=$3 AND r.thread_id=$4 AND r.expires_at>now() AND (r.order_id IS NULL OR r.order_id=$5)
    AND EXISTS(SELECT 1 FROM mtr_harness.threads t JOIN mtr_harness.users u ON u.id=t.user_id WHERE t.id=r.thread_id AND t.user_id=$2 AND t.agent_id=$3 AND t.deleted_at IS NULL AND u.deleted_at IS NULL) RETURNING id`,[record.id,s.userId,s.agentId,s.threadId,orderId,stage,sealed]);
   if(r.rows.length!==1)throw Error('record_not_saved');
  },
  async load(s,orderId){
   scope(s);ready();if(!REF.test(orderId||''))throw Error('invalid_order');
   const {rows}=await pool.query(`SELECT r.* FROM ${TABLE} r JOIN mtr_harness.threads t ON t.id=r.thread_id JOIN mtr_harness.agents a ON a.id=r.agent_id AND a.user_id=r.user_id JOIN mtr_harness.users u ON u.id=r.user_id
    WHERE r.user_id=$1 AND r.agent_id=$2 AND r.order_id=$3 AND r.expires_at>now() AND t.user_id=$1 AND t.agent_id=$2 AND t.deleted_at IS NULL AND u.deleted_at IS NULL`,[s.userId,s.agentId,orderId]);
   if(!rows.length)return null;if(rows.length!==1)throw Error('ambiguous_order');
   const r=rows[0],data=JSON.parse(decrypt(r.payload_enc));
   if(data.userId!==s.userId||data.agentId!==s.agentId||data.orderId!==orderId||data.id!==r.id||data.threadId!==r.thread_id)throw Error('record_binding');
   return {...data,stage:r.stage,savedAt:r.updated_at};
  },
 };
}
export async function recoverOrderPix({store,parsePix,now=Date.now},s,orderId){
 const fail=(status,error)=>({ok:false,status,error});
 if(!REF.test(orderId||''))return fail('invalid_order','Informe a referência exata do pedido. Não criei pedido ou pagamento.');
 let r;try{r=await store.load(s,orderId);}catch{return fail('recovery_unavailable','Não consegui ler o registro protegido deste pedido. Não tentei outro checkout nem gerei cobrança.');}
 if(!r)return fail('record_missing','Não tenho um retorno de Pix preservado para esse pedido nesta conta e assistente, ou o registro já venceu. Pedidos anteriores à implantação desta ferramenta podem não ter registro. Isso não prova cancelamento. Não vou recriar o pedido.');
 if(r.stage!=='pix_received')return fail('no_pix_response','O registro deste pedido não contém uma resposta de continuação de pagamento aceita. Não vou reenviar pagamento, repetir o checkout ou criar outro pedido para tentar recuperar.');
 let pix;try{pix=parsePix(...r.responses);}catch{return fail('invalid_saved_payload','Não consegui interpretar o retorno salvo. Não criei outro pedido.');}
 if(!pix||pix.tipo==='quebrado')return fail('invalid_saved_pix','O retorno salvo ainda não contém Pix ou link utilizável após a validação. Não alterei o código nem repeti o pedido.');
 // A preserved URL may initiate an unknown provider flow; don't open it here.
 if(pix.tipo!=='copia-e-cola')return fail('payment_app_required','Este pedido tem apenas continuação por aplicativo de pagamento, não um código Pix salvo. Não abri o link nem gerei outro pedido.');
 if(pix.expira){const deadline=Date.parse(pix.expira);if(!Number.isFinite(deadline))return fail('invalid_expiry','O prazo salvo do Pix não é reconhecível; não vou reapresentar o código como válido. Não gerei outro Pix.');if(deadline<=now())return fail('pix_expired','A validade informada pela loja para o Pix salvo já passou. Isso não confirma cancelamento do pedido. Não reemiti cobrança nem criei outro pedido.');}
 return {ok:true,status:'pix_recovered',saida:[`Pix recuperado do registro protegido do pedido ${orderId}.`,
 `Total registrado: R$ ${(r.total/100).toFixed(2).replace('.',',')}.`,
 'É o código já recebido da loja, não uma nova cobrança. Reproduza a linha abaixo literalmente, sem remover espaços:',pix.code,
 pix.expira?`Validade informada pela loja: ${new Date(pix.expira).toISOString()}.`:'A loja não informou validade reconhecível para o código salvo.',
 'Não consultei o estado atual do pagamento na loja. Confira no banco o recebedor, valor e se já houve pagamento antes de pagar.'].join('\n')};
}
