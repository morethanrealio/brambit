// Core default implementation of the spend port (gasto.mjs). No credits and no
// billing: the model is called directly and usage is recorded as is, in US$.
// Optional: monthly US$ cap per person (tetoUsd), and `spend` (createCreditSpend
// with unit 'usd') so the assistant can say how much the person spent. Past the cap,
// status.over stops the turn before calling the model, like a plan allowance would. It's
// a soft cap: the call that crosses it finishes; the next one doesn't start.
import {randomUUID} from 'node:crypto';
import {conferirGasto} from './gasto.mjs';
import {tagIdioma} from './locale.mjs';
import {ferramentaConsultarGasto} from './credit-spend.mjs';
// Without credit or a plan, the only reason to block a turn is the US$ cap.
const SEM_SALDO={
 'pt-BR':{texto:t=>`Você chegou ao limite de uso deste mês (US$ ${t}). O limite volta no começo do mês que vem; quem administra esta instalação pode aumentá-lo.`,nota:'⚠️ Este foi um turno de emergência (só para recuperar app). O limite de uso deste mês acabou.'},
 en:{texto:t=>`You've reached this month's usage limit (US$ ${t}). It resets at the start of next month; whoever runs this installation can raise it.`,nota:"⚠️ This was an emergency turn (app recovery only). This month's usage limit has been reached."},
 es:{texto:t=>`Llegaste al límite de uso de este mes (US$ ${t}). Se reinicia a principios del mes que viene; quien administra esta instalación puede aumentarlo.`,nota:'⚠️ Este fue un turno de emergencia (solo para recuperar la app). Se alcanzó el límite de uso de este mes.'},
};
export function createGastoSimples({tetoUsd=null,gastoDoMes,gravarUso,deepseek=null,usdBrl=5.40,spend=null}){
 if(tetoUsd!==null&&!(Number.isFinite(tetoUsd)&&tetoUsd>0))throw Error('tetoUsd precisa ser um número maior que zero');
 if(tetoUsd!==null&&typeof gastoDoMes!=='function')throw Error('Com teto, gastoDoMes(userId) é obrigatório');
 if(typeof gravarUso!=='function')throw Error('gravarUso é obrigatório');
 // Idempotency only within the process: there's no money at stake here, so a
 // repeated record after a restart costs one extra row, not a charge.
 const registrados=new Map();
 return conferirGasto({
  vincular:({provider})=>provider,
  vincularDeepSeek:({maxTokens,secret})=>{
   if(!deepseek)throw Error('DeepSeek oficial não configurado');
   return deepseek({maxTokens,secret});
  },
  // No reservation and no credit balance: null says "there's no balance to
  // show".
  disponivel:async()=>null,
  async status(userId){
   if(tetoUsd===null)return {over:false,limitUsd:null,usedUsd:null};
   const usedUsd=Number(await gastoDoMes(userId))||0;
   return {over:usedUsd>=tetoUsd,limitUsd:tetoUsd,usedUsd};
  },
  async registrar({userId,callId,usage,charge,dimensions={}}){
   if(!registrados.has(callId)){
    registrados.set(callId,(async()=>{
     await gravarUso({...dimensions,...usage,cost:charge?.cost||0,billCredits:0,userId,callId});
     return {userId,callId,attempt:randomUUID(),settled:true};
    })().catch(e=>{registrados.delete(callId);throw e;}));
   }
   return registrados.get(callId);
  },
  limparCheckpoints:async()=>0,
  apagarConta:async()=>{},
  // No credit: nothing is charged; usage is tracked only with the real US$
  // cost.
  creditosDe:()=>0,
  dolarEmReais:()=>usdBrl,
  dolarPorCredito:()=>0,
  async avisoSemSaldo(status,{language}={}){
   const t=SEM_SALDO[tagIdioma(language)]||SEM_SALDO['pt-BR'];
   const teto=Number(status?.limitUsd??tetoUsd??0).toFixed(2);
   return {texto:t.texto(teto),notaEmergencia:t.nota};
  },
  contextoDoTurno:()=>'',
  // No balance to query; only the US$ spend, if there's somewhere to read it
  // from.
 ferramentas:({userId,agentId,turnId}={})=>spend?[ferramentaConsultarGasto({spend,unidade:'usd',userId,agentId,turnId})]:[],
  // No plan or package: the screen shows the month's spend in US$ and the
  // cap, if there is one.
  telaDeCreditos:async({status,extras={}})=>({...status,...extras}),
  // No company paying: the balance is always the person's own.
  conta:()=>({tipo:'pessoal'}),
  // Nothing for sale: the cap belongs to the operator.
  compraNaWeb:()=>false,
 });
}
