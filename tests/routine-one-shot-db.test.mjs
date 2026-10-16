// Persistence/idempotency of the extra execution queue. Local in-memory PostgreSQL.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

let n=0;const eq=(a,b)=>{assert.deepEqual(a,b);n++;},ok=v=>{assert.ok(v);n++;};
const pg=new PGlite();
await pg.exec(`CREATE SCHEMA mtr_harness;
CREATE TABLE mtr_harness.users(id uuid PRIMARY KEY,email text,name text,language text);
CREATE TABLE mtr_harness.agents(id uuid PRIMARY KEY,name text);
CREATE TABLE mtr_harness.routines(id uuid PRIMARY KEY,user_id uuid REFERENCES mtr_harness.users,agent_id uuid REFERENCES mtr_harness.agents,title text,prompt text,hour int,days text,tz text,channel text,enabled boolean,last_run_day text,config jsonb,created_at timestamptz);
${readFileSync('migrations/20260914-routine-one-shots.sql','utf8')}`);
const uuid=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');
await pg.query('INSERT INTO mtr_harness.users VALUES($1,$2,$3)',[uuid(1),'owner@example.invalid','Owner']);
await pg.query('INSERT INTO mtr_harness.agents VALUES($1,$2)',[uuid(2),'Bento']);
await pg.query(`INSERT INTO mtr_harness.routines VALUES($1,$2,$3,'Curadoria','Pesquisar',8,'[1,4]','UTC','email',true,'2026-09-14','{}',now())`,[uuid(3),uuid(1),uuid(2)]);

const source=readFileSync('web/db.mjs','utf8');
const names=['createRoutineOneShot','listDueRoutineOneShots','claimRoutineOneShot','finishRoutineOneShot','recoverRoutineOneShots'];
const body=names.map(name=>{
 const start=source.indexOf(`export async function ${name}(`);assert.ok(start>=0);
 let i=source.indexOf(') {',start)+2,depth=0,inString=false,quote='',escape=false;
 for(;i<source.length;i++){
  const ch=source[i];
  if(inString){if(escape)escape=false;else if(ch==='\\')escape=true;else if(ch===quote)inString=false;continue;}
  if(['"',"'",'`'].includes(ch)){inString=true;quote=ch;continue;}
  if(ch==='{')depth++;else if(ch==='}'&&--depth===0)return source.slice(start,i+1).replace(/^export\s+/,'');
 }
 throw Error('função incompleta');
}).join('\n');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const api=await new AsyncFunction('pool','S',`${body};return {${names.join(',')}};`)(pg,'mtr_harness');

const past=new Date(Date.now()-60_000).toISOString();
const a=await api.createRoutineOneShot({userId:uuid(1),routineId:uuid(3),runAt:past});ok(a?.id);eq(a.duplicate,false);
const duplicate=await api.createRoutineOneShot({userId:uuid(1),routineId:uuid(3),runAt:past});eq(duplicate.id,a.id);eq(duplicate.duplicate,true);
eq((await api.listDueRoutineOneShots()).length,1);
eq(await api.claimRoutineOneShot(a.id),true);eq(await api.claimRoutineOneShot(a.id),false);
eq(await api.finishRoutineOneShot(a.id,'completed',{delivery:{status:'accepted'}}),true);
eq((await api.listDueRoutineOneShots()).length,0);
eq((await pg.query('SELECT status,outcome FROM mtr_harness.routine_one_shots WHERE id=$1',[a.id])).rows[0].status,'completed');
eq((await pg.query('SELECT outcome FROM mtr_harness.routine_one_shots WHERE id=$1',[a.id])).rows[0].outcome.delivery.status,'accepted');
eq(await api.createRoutineOneShot({userId:uuid(9),routineId:uuid(3),runAt:new Date().toISOString()}),null);

const b=await api.createRoutineOneShot({userId:uuid(1),routineId:uuid(3),runAt:new Date(Date.now()-120000).toISOString()});
await api.claimRoutineOneShot(b.id);await pg.query("UPDATE mtr_harness.routine_one_shots SET started_at=now()-interval '11 minutes' WHERE id=$1",[b.id]);
eq(await api.recoverRoutineOneShots(),1);
eq((await pg.query('SELECT status FROM mtr_harness.routine_one_shots WHERE id=$1',[b.id])).rows[0].status,'uncertain');

await pg.close();console.log(`PASS ${n}: fila PostgreSQL de execução extra, idempotência e recuperação; offline.`);
