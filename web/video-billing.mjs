import { ownedMediaKey } from './security-boundaries.mjs';

// Um job é a chave de cobrança, não uma tentativa de polling. Não inicia rede
// nem executa DDL. A transação mantém débito e conclusão local inseparáveis.
// Roda na transação da conta pagadora (conta-pagadora.mjs, injetada em
// `transacao`) e carimba org_id com a conta que paga agora; no Brambs o débito
// do vídeo de um membro sai do saldo da empresa. creditUsd = US$ por unidade de
// cobrança (gasto.dolarPorCredito()); só precisa ser > 0 quando há cobrança.
export function createVideoBillingStore(pool, schema = 'mtr_harness', { transacao } = {}) {
  if (typeof transacao !== 'function') throw new Error('Cobrança de vídeo sem conta pagadora');
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error('Invalid schema');
  return {
    async settle({ jobId, userId, videoKey, videoSeconds, credits, creditUsd }) {
      if (!jobId || !userId || !ownedMediaKey(userId, videoKey)) throw new Error('Vídeo sem arquivo próprio confirmado');
      if (!Number.isFinite(videoSeconds) || videoSeconds <= 0 || videoSeconds > 15
          || !Number.isSafeInteger(credits) || credits < 0 || !Number.isFinite(creditUsd) || creditUsd < 0
          || (credits > 0 && creditUsd <= 0)) throw new Error('Cobrança de vídeo inválida');
      return transacao(pool, { userId }, async (c, orgId) => {
        const {rows} = await c.query(`SELECT * FROM ${schema}.video_jobs WHERE id=$1 AND user_id=$2 FOR UPDATE`, [jobId,userId]);
        const job=rows[0];
        if (!job || !['queued','processing'].includes(job.status)) {
          return {settled:false,reason:job?'already_final':'not_found'};
        }
        // Compatibilidade conservadora: um débito legado sem chave de job não
        // pode ser atribuído/cobrado novamente por aproximação. Só sinaliza para
        // revisão; não estorna, altera cobrança antiga ou inventa vínculo.
        const legacy=await c.query(`SELECT 1 FROM ${schema}.usage_events u
          WHERE u.user_id=$1 AND u.kind='video' AND u.ts >= $2
            AND u.bill_credits > 0
            AND NOT EXISTS (SELECT 1 FROM ${schema}.video_jobs v WHERE v.id=u.turn_id AND v.user_id=u.user_id)
          LIMIT 1`,[userId,job.created_at]);
        if (legacy.rows.length || Number(job.credits_charged)>0) {
          return {settled:false,reason:'legacy_charge_needs_review'};
        }
        // Proteção complementar contra reentrada com registro estável já presente.
        const billed=await c.query(`SELECT user_id,bill_credits FROM ${schema}.usage_events WHERE turn_id=$1 AND kind='video'`,[jobId]);
        if (billed.rows.length) {
          return {settled:false,reason:'inconsistent_charge_needs_review'};
        }
        if (credits>0) await c.query(`INSERT INTO ${schema}.usage_events
          (user_id,agent_id,thread_id,turn_id,kind,model,tok_in,tok_cached,tok_out,tok_think,tok_total,cost_usd,bill_credits,org_id)
          VALUES ($1,$2,$3,$4,'video','comfy-h3',0,0,0,0,0,$5,$6,$7)`,
          [job.user_id,job.agent_id||null,job.thread_id||null,job.id,credits*creditUsd,credits,orgId||null]);
        await c.query(`UPDATE ${schema}.video_jobs SET status='delivered', video_seconds=$3,
          video_key=$4, credits_charged=$5, updated_at=now() WHERE id=$1 AND user_id=$2`,
          [jobId,userId,videoSeconds,videoKey,credits]);
        // 'delivered' é estado LOCAL legado (arquivo pronto). Não é recibo de
        // Telegram/push. Apenas este vencedor pode tentar a notificação externa.
        return {settled:true,credits,videoKey};
      });
    },
  };
}
