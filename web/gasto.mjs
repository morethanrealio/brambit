// Port 1: spend. The core only asks "may it spend?" and reports what it spent;
// how much each person may spend is up to the plugged implementation (e.g. a
// plugin billing in credits, with a plan allowance and a company paying account).
//  vincular({provider,userId,agentId,threadId,kind,language,noBill}) → the same
//    provider, but each physical call reserves first and settles after.
//  vincularDeepSeek({...identidade,maxTokens,secret}) → same for the official
//    DeepSeek route, which measures its own usage.
//  disponivel(userId) → {remaining,held,available}. Preview: reserves nothing.
//  status(userId) → {over,...}. over=true stops the turn before calling the model.
//  registrar({userId,callId,usage,charge,dimensions}) → receipt for spend already
//    made. Idempotent by callId.
//  limparCheckpoints({dias}) and apagarConta(userId) → upkeep and account deletion.
//  creditosDe(item) → how much to charge for a spend, in the implementation's unit
//    (0 = no charge; the real US$ cost is recorded anyway). item:
//    {tipo:'uso',uso} (model call, search, image...), {tipo:'whatsapp'}
//    (one message sent) or {tipo:'video',segundos}.
//  dolarEmReais() → rate used to record in US$ what is charged in reais
//    (the WhatsApp service message).
//  dolarPorCredito() → US$ of one creditosDe unit (the recorded cost of video
//    billing). 0 when the implementation doesn't charge.
// What the person and the model read about balance is also the implementation's
// (the core doesn't know what a credit, plan or pack is):
//  avisoSemSaldo(status,{userId,language,appClient}) → {texto,notaEmergencia}:
//    the reply of a turn stopped by status.over and the note at the end of an
//    emergency turn (app recovery). appClient = iOS app, no purchase call.
//  contextoDoTurno(status) → block that goes to the model every turn ('' = none).
//  ferramentas({userId,appClient,agentId,turnId}) → the turn's balance and
//    spend lookup tools (consultar_gasto, credit-spend.mjs, in the
//    implementation's unit).
//  telaDeCreditos({userId,status,extras}) → body of /api/usage/credits: the
//    status, what the implementation shows of balance and purchase, and the
//    core's `extras` (models and media; media cost in US$, the implementation
//    converts if it shows another unit).
//  conta(status) → `conta` block of /api/me: whose balance the person uses
//    ({tipo:'pessoal'} or, with a company plugin, the paying company and its plan).
//  compraNaWeb() → true when the site sells a plan or pack (goes in /api/config;
//    the front only shows a buy button with it on).
export const METODOS_GASTO=['vincular','vincularDeepSeek','disponivel','status','registrar','limparCheckpoints','apagarConta','creditosDe','dolarEmReais','dolarPorCredito','avisoSemSaldo','contextoDoTurno','ferramentas','telaDeCreditos','conta','compraNaWeb'];
export function conferirGasto(gasto){
 const faltam=METODOS_GASTO.filter(m=>typeof gasto?.[m]!=='function');
 if(faltam.length)throw Error('Porta de gasto incompleta: '+faltam.join(', '));
 return gasto;
}
