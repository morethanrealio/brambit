import {randomUUID} from 'node:crypto';
const copy=x=>JSON.parse(JSON.stringify(x));
// Only idempotent coding lifecycle controls may use this store. It never
// serializes executable closures or recovers arbitrary email/shell actions.
export function createCodingApprovals({store,scope,now=()=>Date.now(),ttlMs=24*60*60_000}) {
  const key=JSON.stringify(['coding-approval',scope]);
  return {
    async propose(proposal){
      if(proposal.name!=='gerenciar_tarefa_de_app'||proposal.binding?.version!==1)throw Error('Unsupported durable approval');
      return store.withTask(key,async({record,save})=>{
        if(record&&(record.state==='approved'||record.state==='pending'&&record.expiresAt>now()))throw Error('Já existe uma confirmação de programação pendente.');
        const next={...copy(proposal),id:randomUUID(),state:'pending',at:now(),expiresAt:now()+ttlMs};
        await save(next);return next;
      });
    },
    async acknowledge(id){return store.withTask(key,async({record,save})=>{if(record?.id===id&&record.state==='approved'&&record.result){record.state='completed';await save(record);}});},
    async cancel(){return store.withTask(key,async({record,save})=>{if(record&&['pending','approved'].includes(record.state)){record.state='cancelled';await save(record);}});},
    async peek(){const record=store.read?await store.read(key):await store.withTask(key,async({record})=>record);return record&&['pending','approved'].includes(record.state)?copy(record):null;},
    async resolve(id,decision,execute){
      return store.withTask(key,async({record,save})=>{
        if(!record||record.id!==id)throw Error('Confirmação não encontrada.');
        if(record.state==='completed'||record.state==='approved'&&record.result)return copy(record.result);
        if(!['pending','approved'].includes(record.state))return {ok:false,error:'Confirmação já encerrada.'};
        if(record.state==='pending'&&(decision!==true||record.expiresAt<=now())){
          record.state=record.expiresAt<=now()?'expired':'cancelled';await save(record);return {ok:false,error:'A proposta não foi executada.'};
        }
        record.state='approved';await save(record);
        // Crash after effect and before this receipt is safe ONLY because execute
        // receives the same server-bound operation ID stored atomically by control.
        const result=await execute(record);record.result=copy(result);record.state=result?.ok&&result.continuation?'approved':'completed';await save(record);return result;
      });
    },
  };
}
