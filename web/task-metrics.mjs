// Durable measurement only: no prompts, tool arguments, receipts or contact data.
// Each source has its own unit; never add these rows as unique consumer tasks.
export const TASK_METRICS_SCHEMA = `CREATE TABLE IF NOT EXISTS mtr_harness.task_measurements (
 source text NOT NULL CHECK(source IN ('programming','conversation')), id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES mtr_harness.users(id) ON DELETE CASCADE,
 agent_id uuid NOT NULL REFERENCES mtr_harness.agents(id) ON DELETE CASCADE,
 thread_id uuid NOT NULL REFERENCES mtr_harness.threads(id) ON DELETE CASCADE,
 state text NOT NULL, reason text, started_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 finished_at timestamptz, attempts integer NOT NULL DEFAULT 1, version bigint NOT NULL DEFAULT 0,
 usage_complete boolean NOT NULL DEFAULT false,
 PRIMARY KEY(source,id));
 CREATE INDEX IF NOT EXISTS task_measurements_cohort ON mtr_harness.task_measurements(started_at,source);
 CREATE INDEX IF NOT EXISTS task_measurements_owner ON mtr_harness.task_measurements(user_id,thread_id);`;
const STATES=new Set(['queued','running','paused','completed','accepted','partial','uncertain','failed','canceled','awaiting_confirmation','response']);
const safeReason=x=>typeof x==='string'&&/^[a-zA-Z0-9_:-]{1,80}$/.test(x)?x:null;
export function measuredActionState(entries,termination) {
 if(!entries.length)return termination==='completed'?'response':'paused';
 const states=entries.map(e=>e.state);
 const failed=states.some(s=>['failed','routine_failed','routine_content_failed','routine_blocked'].includes(s));
 const unknown=states.includes('unknown'),pending=states.includes('pending');
 const success=states.some(s=>!['unknown','pending','failed','routine_failed','routine_content_failed','routine_blocked','partial','routine_partial'].includes(s));
 if(states.some(s=>['partial','routine_partial'].includes(s))||success&&(failed||unknown||pending))return 'partial';
 if(unknown)return 'uncertain';if(failed)return 'failed';if(pending)return 'awaiting_confirmation';
 return states.some(s=>s==='accepted')?'accepted':'completed';
}
export function programmingMeasurement(job) {
 const reason=job.result?.coding_task?.reason||job.result?.app_build?.motivo;
 const state=job.state==='cancelled'?'canceled':job.state==='paused'&&['uncertain_action','canceled_pending_reconciliation'].includes(reason)?'uncertain':job.state;
 return {source:'programming',id:job.id,userId:job.userId,agentId:job.agentId,threadId:job.threadId,state,reason,
 startedAt:job.createdAt,updatedAt:job.updatedAt,finishedAt:['completed','canceled'].includes(state)?job.updatedAt:null,
 attempts:1+(job.resumeCount||0),version:job.measurementVersion||0,
 usageComplete:['completed','canceled'].includes(state)&&!!job.result&&!job.result?.coding_task?.consumptionPending&&!job.result?.app_build?.consumo_pendente};
}
export function metricPeriod({from,to}={},now=Date.now()) {
 const end=to?new Date(to):new Date(now),start=from?new Date(from):new Date(end.getTime()-30*86400_000);
 if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||start>end||end-start>366*86400_000)throw Object.assign(Error('Escolha um período válido de até 366 dias.'),{status:400});
 return {from:start.toISOString(),to:end.toISOString()};
}
export function createTaskMetrics(pool) {
 let writeFailures=0;
 async function record(v) {
 if(!['programming','conversation'].includes(v.source)||!STATES.has(v.state)||!Number.isSafeInteger(v.attempts??1)||(v.attempts??1)<1)throw Error('Invalid task measurement');
 const args=[v.source,v.id,v.userId,v.agentId,v.threadId,v.state,safeReason(v.reason),new Date(v.startedAt).toISOString(),new Date(v.updatedAt).toISOString(),v.finishedAt?new Date(v.finishedAt).toISOString():null,v.attempts??1,v.version??0,v.usageComplete===true];
 const {rows}=await pool.query(`INSERT INTO mtr_harness.task_measurements AS old
 (source,id,user_id,agent_id,thread_id,state,reason,started_at,updated_at,finished_at,attempts,version,usage_complete)
 SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
 WHERE EXISTS(SELECT 1 FROM mtr_harness.threads t JOIN mtr_harness.agents a ON a.id=t.agent_id
 WHERE t.id=$5 AND t.user_id=$3 AND t.agent_id=$4 AND a.user_id=$3)
 ON CONFLICT(source,id) DO UPDATE SET state=EXCLUDED.state,reason=EXCLUDED.reason,
 updated_at=EXCLUDED.updated_at,finished_at=EXCLUDED.finished_at,attempts=EXCLUDED.attempts,
 version=EXCLUDED.version,usage_complete=EXCLUDED.usage_complete
 WHERE old.user_id=EXCLUDED.user_id AND old.agent_id=EXCLUDED.agent_id AND old.thread_id=EXCLUDED.thread_id AND (old.version<EXCLUDED.version OR old.version=EXCLUDED.version AND old.updated_at<=EXCLUDED.updated_at)
 RETURNING id`,args);
 return rows.length===1;
 }
 return {init:()=>pool.query(TASK_METRICS_SCHEMA),record,
 async observe(v){try{return await record(v)}catch{writeFailures++;return false}},
 async report(input={}) {
 const period=metricPeriod(input);
 // Cohort = work STARTED in the selected interval, with its latest known result.
 // Usage is joined by owner + exact execution ID, never by proximity in time.
 const {rows}=await pool.query(`WITH tasks AS (
 SELECT source,state,reason,started_at,updated_at,finished_at,attempts,id,user_id,usage_complete FROM mtr_harness.task_measurements
 WHERE started_at >= $1 AND started_at < $2
 ), measured AS (
 SELECT t.*,u.calls,u.cost,u.credits,u.missing_credits FROM tasks t
 LEFT JOIN LATERAL(SELECT count(*)::int calls,sum(cost_usd) cost,sum(bill_credits) credits,
 count(*) FILTER(WHERE bill_credits IS NULL)::int missing_credits
 FROM mtr_harness.usage_events e WHERE e.user_id=t.user_id AND e.turn_id=t.id AND e.cost_usd>=0 AND e.kind NOT IN ('grant','purchase'))u ON true
 ) SELECT source,state,reason,count(*)::int count,sum(attempts-1)::int resumptions,
 count(*) FILTER(WHERE state IN ('queued','running','paused','awaiting_confirmation') AND updated_at < now()-interval '24 hours')::int stalled,
 count(*) FILTER(WHERE finished_at IS NOT NULL)::int timed,
 avg(extract(epoch from(finished_at-started_at))*1000) FILTER(WHERE finished_at IS NOT NULL) duration_ms,
 count(*) FILTER(WHERE calls>0)::int with_usage,
 count(*) FILTER(WHERE calls>0 AND usage_complete AND missing_credits=0)::int complete_usage,
 avg(cost) FILTER(WHERE state='completed' AND calls>0 AND usage_complete AND missing_credits=0) cost_per_completed,
 sum(cost) cost_usd,sum(credits) credits
 FROM measured GROUP BY source,state,reason ORDER BY source,state,reason`,[period.from,period.to]);
 const reminders=await pool.query(`SELECT 'reminder' source,
 CASE WHEN delivery_state IN ('delivered','read') THEN 'delivered' WHEN delivery_state='partial' THEN 'partial' ELSE status END state,
 count(*)::int count,avg(extract(epoch from(finished_at-scheduled_at))*1000) FILTER(WHERE finished_at IS NOT NULL) duration_ms,
 count(*) FILTER(WHERE finished_at IS NOT NULL)::int timed
 FROM mtr_harness.reminder_occurrences WHERE scheduled_at >= $1 AND scheduled_at < $2 GROUP BY 2`,[period.from,period.to]);
 const confirmations=await pool.query(`SELECT 'confirmation' source,
 CASE WHEN state='executing' AND lease_until<now() THEN 'uncertain' WHEN state='pending' AND expires_at<now() THEN 'expired' ELSE state END state,
 count(*)::int count FROM mtr_harness.confirmation_requests WHERE created_at >= $1 AND created_at < $2 GROUP BY 2`,[period.from,period.to]);
 const usefulness=await pool.query(`SELECT count(*)::int reports,count(DISTINCT user_id)::int people
 FROM mtr_harness.discovery_events WHERE kind='help' AND outcome='useful_reported' AND created_at >= $1 AND created_at < $2`,[period.from,period.to]);
 const coverage=await pool.query(`SELECT min(started_at) since FROM mtr_harness.task_measurements`);
 return {period,asOf:new Date().toISOString(),cohort:'started',rows:[...rows,...reminders.rows,...confirmations.rows],usefulness:usefulness.rows[0],
 coverage:{since:coverage.rows[0]?.since||null,writeFailuresSinceRestart:writeFailures,
 units:'programming=job; conversation=turn; reminder=occurrence; confirmation=proposal. Overlap is intentional; do not sum sources.',
 usage:'Exact execution IDs only; costs are recorded usage, not guaranteed totals. Missing usage is unknown.',
 usefulness:'No inference from completion, display, silence or tokens.'}};
 }
 };
}
