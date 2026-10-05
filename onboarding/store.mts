import {randomUUID} from 'node:crypto';
export interface Db { query<T=Record<string,unknown>>(sql:string,args?:unknown[]):Promise<{rows:T[]}> }
export interface Pool extends Db {connect():Promise<Db & {release():void}>}
export type Mode='connected'|'starter';
export type Step='connect'|'whatsapp'|'wow'|'done';
export interface WowResult {welcome:string;suggestions:string[];notes:string[]}
export interface State {user_id:string;agent_id:string;step:Step;status:'idle'|'running'|'done'|'error';mode:Mode|null;attempt_id:string|null;attempt_no:number;worker_id:string|null;started_at:string|null;result:WowResult|null;error_code:string|null;viewed_at:string|null;skipped_at:string|null;completed_at:string|null;selected_suggestion?:number|null;refinement_selected?:boolean;feedback_choice?:'useful'|'needs_work'|null}
export class OnboardingError extends Error {constructor(public status:number,message:string){super(message)}}
export const TRUST_EVENTS=['security_viewed','security_details_opened','connection_started','connection_connected','connection_cancelled','connection_failed','connection_returned_unconnected','connection_skipped','starter_offered'] as const;
const TOUCH='mtr_harness.onboarding_touchpoints';
const T='mtr_harness.onboarding_sessions', E='mtr_harness.onboarding_events';
export const SCHEMA=`CREATE TABLE IF NOT EXISTS ${TOUCH} (
 user_id uuid NOT NULL REFERENCES mtr_harness.users(id) ON DELETE CASCADE,
 experience text NOT NULL CHECK(experience='trust-v1'),
 event text NOT NULL CHECK(event IN (${TRUST_EVENTS.map(e=>"'"+e+"'").join(',')})),
 provider text NOT NULL CHECK(provider IN ('none','google','microsoft')),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,experience,event,provider));
CREATE INDEX IF NOT EXISTS onboarding_touchpoints_created ON ${TOUCH}(created_at,event);
CREATE TABLE IF NOT EXISTS ${T} (
 user_id uuid NOT NULL REFERENCES mtr_harness.users(id) ON DELETE CASCADE,
 agent_id uuid NOT NULL REFERENCES mtr_harness.agents(id) ON DELETE CASCADE,
 step text NOT NULL DEFAULT 'connect' CHECK(step IN ('connect','whatsapp','wow','done')),
 status text NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','running','done','error')),
 mode text CHECK(mode IN ('connected','starter')),attempt_id uuid,attempt_no integer NOT NULL DEFAULT 0,
 worker_id uuid,started_at timestamptz,result jsonb,error_code text,viewed_at timestamptz,skipped_at timestamptz,completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,agent_id));
CREATE TABLE IF NOT EXISTS ${E} (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id uuid NOT NULL,agent_id uuid NOT NULL,
 event text NOT NULL CHECK(event IN ('started','connections_connected','connections_skipped','whatsapp_connected','whatsapp_skipped','analysis_started','analysis_ready','analysis_failed','wow_viewed','wow_skipped','suggestion_selected','refinement_selected','starter_requested','starter_ready','starter_viewed','completed')),
 attempt_id uuid,mode text CHECK(mode IN ('connected','starter')),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(user_id,agent_id) REFERENCES ${T}(user_id,agent_id) ON DELETE CASCADE);
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_events_attempt ON ${E}(user_id,agent_id,event,attempt_id) WHERE attempt_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_events_once ON ${E}(user_id,agent_id,event) WHERE attempt_id IS NULL;
CREATE INDEX IF NOT EXISTS onboarding_events_created ON ${E}(created_at,event);
ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS selected_suggestion integer;
ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS refinement_selected boolean NOT NULL DEFAULT false;
ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS feedback_choice text CHECK(feedback_choice IN ('useful','needs_work'));
ALTER TABLE ${E} DROP CONSTRAINT IF EXISTS onboarding_events_event_check;
ALTER TABLE ${E} ADD CONSTRAINT onboarding_events_event_check CHECK(event IN ('started','connections_connected','connections_skipped','whatsapp_connected','whatsapp_skipped','analysis_started','analysis_ready','analysis_failed','wow_viewed','wow_skipped','suggestion_selected','refinement_selected','starter_requested','starter_ready','starter_viewed','completed'));
CREATE TABLE IF NOT EXISTS mtr_harness.onboarding_feedback (
 user_id uuid NOT NULL,agent_id uuid NOT NULL,attempt_id uuid NOT NULL,
 choice text NOT NULL CHECK(choice IN ('useful','needs_work')),mode text NOT NULL CHECK(mode IN ('starter','connected')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,agent_id,attempt_id),FOREIGN KEY(user_id,agent_id) REFERENCES ${T}(user_id,agent_id) ON DELETE CASCADE);`;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function id(x:unknown):string {if(typeof x!=='string'||!UUID.test(x))throw new OnboardingError(400,'Identificador inválido.');return x}
export function resultInput(x:WowResult,mode:Mode):WowResult {
 const welcome=typeof x?.welcome==='string'?x.welcome.trim():'';
 const clean=(a:unknown)=>Array.isArray(a)?a.filter((s):s is string=>typeof s==='string'&&!!s.trim()).map(s=>s.trim().slice(0,1500)):[];
 const suggestions=clean(x?.suggestions).slice(0,3),notes=clean(x?.notes).slice(0,6);
 if(welcome.length<10||welcome.length>16000||(mode==='connected'&&!suggestions.length))throw new OnboardingError(422,'A análise não retornou um resultado completo.');
 return {welcome,suggestions,notes};
}
export const STARTER_TASKS={plan:'Organize as prioridades em um plano de ação curto e concreto, usando apenas o contexto informado.',decision:'Compare as opções apresentadas, explique os critérios e proponha um próximo passo. Separe fatos de suposições.',draft:'Escreva um rascunho útil da mensagem solicitada, sem enviá-la. Use somente as informações fornecidas.'} as const;
export function starterPrompt(task:unknown,context:unknown,language:string):string {
 if(typeof task!=='string'||!Object.hasOwn(STARTER_TASKS,task)||typeof context!=='string'||context.trim().length<10||context.length>2000)throw new OnboardingError(400,'Escolha uma tarefa e conte um pouco do contexto (10 a 2.000 caracteres).');
 return `Responda em ${language}. ${STARTER_TASKS[task as keyof typeof STARTER_TASKS]} Esta é uma primeira tarefa sem acesso a ferramentas, contas, e-mail ou agenda. Não afirme ter acessado essas fontes nem ter executado ações externas. Entregue o resultado diretamente, de forma breve e prática.\nContexto fornecido pela pessoa:\n${context.trim()}`;
}
export function createOnboardingStore(pool:Pool,workerId=randomUUID()) {
 async function tx<T>(fn:(db:Db)=>Promise<T>):Promise<T>{const db=await pool.connect();try{await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='10s'");const r=await fn(db);await db.query('COMMIT');return r}catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}}
 async function event(db:Db,s:State,name:string){await db.query(`INSERT INTO ${E}(user_id,agent_id,event,attempt_id,mode) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[s.user_id,s.agent_id,name,s.attempt_id,s.mode])}
 async function lock(db:Db,user:string,agent:string,create=false,recover=true):Promise<State|null>{id(user);id(agent);
  const owned=await db.query('SELECT id FROM mtr_harness.agents WHERE user_id=$1 AND id=$2 AND archived_at IS NULL',[user,agent]);if(!owned.rows.length)throw new OnboardingError(404,'Assistente não encontrado.');
  if(create)await db.query(`INSERT INTO ${T}(user_id,agent_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[user,agent]);
  const r=await db.query<State>(`SELECT * FROM ${T} WHERE user_id=$1 AND agent_id=$2 FOR UPDATE`,[user,agent]);let s=r.rows[0]||null;
  if(recover&&s?.status==='running'){
   const interrupted=await db.query<State>(`UPDATE ${T} SET status='error',error_code='interrupted',updated_at=now() WHERE user_id=$1 AND agent_id=$2 AND (worker_id<>$3 OR started_at<now()-interval '10 minutes') RETURNING *`,[user,agent,workerId]);
   if(interrupted.rows[0]){s=interrupted.rows[0];await event(db,s,'analysis_failed')}
  }
  return s;
 }
 return {
  init:()=>pool.query(SCHEMA),
  async touch(user:string,name:unknown,provider:unknown='none'){
   id(user);
   if(typeof name!=='string'||!TRUST_EVENTS.includes(name as typeof TRUST_EVENTS[number])||(typeof provider!=='string'||!['none','google','microsoft'].includes(provider)))throw new OnboardingError(400,'Evento inválido.');
   await pool.query(`INSERT INTO ${TOUCH}(user_id,experience,event,provider) VALUES($1,'trust-v1',$2,$3) ON CONFLICT DO NOTHING`,[user,name,provider]);
  },
  async get(user:string,agent?:string){if(!agent){id(user);const r=await pool.query<{agent_id:string}>(`SELECT s.agent_id FROM ${T} s JOIN mtr_harness.agents a ON a.id=s.agent_id AND a.user_id=s.user_id WHERE s.user_id=$1 AND a.archived_at IS NULL AND s.completed_at IS NULL ORDER BY s.created_at DESC LIMIT 1`,[user]);agent=r.rows[0]?.agent_id;if(!agent)return null}return tx(db=>lock(db,user,agent!))},
  async progress(user:string,agent:string,name:string,attempt?:unknown,selection?:unknown){
   if(!['started','connections_connected','connections_skipped','whatsapp_connected','whatsapp_skipped','wow_viewed','wow_skipped','suggestion_selected','refinement_selected','starter_viewed','completed'].includes(name))throw new OnboardingError(400,'Evento inválido.');
   return tx(async db=>{let s=(await lock(db,user,agent,true))!;
    if(['wow_viewed','starter_viewed','suggestion_selected','refinement_selected'].includes(name)){
     if(s.status!=='done'||!s.result||attempt!==s.attempt_id)throw new OnboardingError(409,'O resultado mudou. Atualize a análise.');
     if((name==='wow_viewed'&&s.mode!=='connected')||(name==='starter_viewed'&&s.mode!=='starter'))throw new OnboardingError(400,'Evento incompatível com a análise.');
    }
    if(['suggestion_selected','refinement_selected'].includes(name)&&!s.viewed_at)throw new OnboardingError(409,'Veja o resultado antes de escolher o próximo passo.');
    if(name==='suggestion_selected'&&selection!==undefined){
      if(typeof selection!=='number'||!Number.isInteger(selection)||selection<0||selection>=(s.result?.suggestions.length||0))throw new OnboardingError(400,'Sugestão inválida.');
      await db.query(`UPDATE ${T} SET selected_suggestion=$3,refinement_selected=false WHERE user_id=$1 AND agent_id=$2`,[user,agent,selection]);
    }
    if(name==='refinement_selected')await db.query(`UPDATE ${T} SET selected_suggestion=NULL,refinement_selected=true WHERE user_id=$1 AND agent_id=$2`,[user,agent]);
    if(name==='completed'&&!s.viewed_at&&!s.skipped_at)throw new OnboardingError(409,'Veja o resultado ou escolha continuar sem a análise.');
    const next=name==='started'?s.step:name==='connections_skipped'?'wow':name.startsWith('connections_')?'whatsapp':name.startsWith('whatsapp_')?(s.viewed_at?'done':'wow'):name==='completed'||['suggestion_selected','refinement_selected'].includes(name)?'done':name.endsWith('_viewed')?'wow':s.step;
    const r=await db.query<State>(`UPDATE ${T} SET step=$3,viewed_at=CASE WHEN $4 IN ('wow_viewed','starter_viewed') THEN coalesce(viewed_at,now()) ELSE viewed_at END,skipped_at=CASE WHEN $4='wow_skipped' THEN coalesce(skipped_at,now()) ELSE skipped_at END,completed_at=CASE WHEN $4='completed' THEN coalesce(completed_at,now()) ELSE completed_at END,updated_at=now() WHERE user_id=$1 AND agent_id=$2 RETURNING *`,[user,agent,next,name]);s=r.rows[0];await event(db,s,name);return s;
   })
  },
  async feedback(user:string,agent:string,attempt:unknown,choice:unknown){
   if(choice!=='useful'&&choice!=='needs_work')throw new OnboardingError(400,'Avaliação inválida.');
   return tx(async db=>{const s=await lock(db,user,agent);
    if(!s||s.status!=='done'||!s.viewed_at||s.attempt_id!==attempt)throw new OnboardingError(409,'Veja o resultado atual antes de avaliar.');
    await db.query(`INSERT INTO mtr_harness.onboarding_feedback(user_id,agent_id,attempt_id,choice,mode) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(user_id,agent_id,attempt_id) DO UPDATE SET choice=EXCLUDED.choice,updated_at=now()`,[user,agent,attempt,choice,s.mode]);
    await db.query(`UPDATE ${T} SET feedback_choice=$3 WHERE user_id=$1 AND agent_id=$2`,[user,agent,choice]);
    return {...s,feedback_choice:choice};
   });
  },
  async claim(user:string,agent:string,mode:Mode,retry=false){return tx(async db=>{let s=(await lock(db,user,agent,true))!;
   if(s.status==='running'||s.status==='done'||s.completed_at)return {claimed:false,state:s};
   if(s.status==='error'&&!retry)return {claimed:false,state:s};
   if(s.attempt_no>=5)throw new OnboardingError(429,'Limite de tentativas atingido. Fale com o suporte antes de iniciar outra análise.');
   const r=await db.query<State>(`UPDATE ${T} SET status='running',mode=$3,attempt_id=$4,worker_id=$5,attempt_no=attempt_no+1,started_at=now(),result=NULL,error_code=NULL,viewed_at=NULL,selected_suggestion=NULL,refinement_selected=false,feedback_choice=NULL,updated_at=now() WHERE user_id=$1 AND agent_id=$2 RETURNING *`,[user,agent,mode,randomUUID(),workerId]);s=r.rows[0];await event(db,s,'analysis_started');if(mode==='starter')await event(db,s,'starter_requested');return {claimed:true,state:s};
  })},
  async finish(user:string,agent:string,attempt:string,result:WowResult){return tx(async db=>{const s=await lock(db,user,agent,false,false);if(!s||s.status!=='running'||s.attempt_id!==attempt)return false;const valid=resultInput(result,s.mode!);await db.query(`UPDATE ${T} SET status='done',result=$4::jsonb,error_code=NULL,updated_at=now() WHERE user_id=$1 AND agent_id=$2 AND attempt_id=$3`,[user,agent,attempt,JSON.stringify(valid)]);await event(db,s,'analysis_ready');if(s.mode==='starter')await event(db,s,'starter_ready');return true})},
  async fail(user:string,agent:string,attempt:string){return tx(async db=>{const s=await lock(db,user,agent,false,false);if(!s||s.status!=='running'||s.attempt_id!==attempt)return false;await db.query(`UPDATE ${T} SET status='error',error_code='analysis_failed',updated_at=now() WHERE user_id=$1 AND agent_id=$2 AND attempt_id=$3`,[user,agent,attempt]);await event(db,s,'analysis_failed');return true})},
 };
}
export function publicState(s:State|null){if(!s)return {status:'idle',registered:false};return {registered:true,agentId:s.agent_id,step:s.step,status:s.status,mode:s.mode,attemptId:s.attempt_id,result:s.result,...(s.result||{}),errorCode:s.error_code,viewed:!!s.viewed_at,skipped:!!s.skipped_at,completed:!!s.completed_at,selectedSuggestion:s.selected_suggestion??null,refinementSelected:!!s.refinement_selected,feedback:s.feedback_choice??null};}
