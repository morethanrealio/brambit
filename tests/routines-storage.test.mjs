// Isolated PostgreSQL semantics, extracted real functions. No production imports/I/O.
import {prepareCurationChange} from '../web/curation-config.mjs';
import {prepareEmailSearchChange} from '../web/email-search-config.mjs';
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite();await db.exec(`CREATE SCHEMA mtr_harness;
CREATE TABLE mtr_harness.agents(id text PRIMARY KEY,name text);
CREATE TABLE mtr_harness.routines(id text PRIMARY KEY,user_id text,agent_id text,title text,prompt text,hour int,minute int NOT NULL DEFAULT 0,days text,tz text,channel text,enabled bool,last_run_day text,repeat_every_min int,repeat_until timestamptz,next_run timestamptz,config jsonb,created_at timestamptz DEFAULT now());
INSERT INTO mtr_harness.agents VALUES ('a','Synthetic');
INSERT INTO mtr_harness.routines(id,user_id,agent_id,title,config,repeat_until) VALUES ('r','u','a','Test','{"curation":{"version":2,"source":"gmail"}}','2027-04-28T22:00:00Z'),('other','other','a','Other','{}',NULL); UPDATE mtr_harness.routines SET channel='email';`);
const src=readFileSync('web/db.mjs','utf8'),pool={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),release(){}})};
function extractSync(name,deps={}){const plain=`function ${name}(`,exported=`export function ${name}(`;const start=src.indexOf(exported)>=0?src.indexOf(exported):src.indexOf(plain),end=src.indexOf('\n}',start)+2;assert(start>=0&&end>start);return Function(...Object.keys(deps),src.slice(start,end).replace('export ','')+`;return ${name}`)(...Object.values(deps));}
const emailSearchTipo=extractSync('emailSearchTipo');
const composeRoutineConfig=extractSync('composeRoutineConfig',{prepareCurationChange,prepareEmailSearchChange});
function extract(name){const start=src.indexOf(`export async function ${name}(`),end=src.indexOf('\n}',start)+2;assert(start>=0&&end>start);return Function('pool','S','composeRoutineConfig','emailSearchTipo',src.slice(start,end).replace('export ','')+`;return ${name}`)(pool,'mtr_harness',composeRoutineConfig,emailSearchTipo);}
const list=extract('listRoutinesForUser'),remove=extract('deleteRoutine'),update=extract('updateRoutine');
const rows=await list('u');assert.equal(rows.length,1);assert.equal(rows[0].config.curation.source,'gmail');assert.equal((await list('missing')).length,0);
await assert.rejects(()=>remove('r','other',{title:'Test'}),{code:'ROUTINE_CHANGED'});assert.equal((await list('u')).length,1);
await assert.rejects(()=>remove('r','u',{title:'stale'}),{code:'ROUTINE_CHANGED'});
await assert.rejects(()=>remove('r','u',{repeat_until:null}),{code:'ROUTINE_CHANGED'});
await db.exec("UPDATE mtr_harness.routines SET config=jsonb_set(config,'{execution}','{\"status\":\"running\"}') WHERE id='r'");
await update('r','u',{enabled:false,expected:{title:'Test',config:rows[0].config,repeat_until:JSON.parse(JSON.stringify(rows[0].repeat_until)),repeat_every_min:null}});
assert.equal((await list('u'))[0].enabled,false);
await assert.rejects(()=>update('r','u',{enabled:true,expected:{enabled:true}}),{code:'ROUTINE_CHANGED'});
assert.equal((await list('u'))[0].config.execution.status,'running');
await remove('r','u',{title:'Test',config:rows[0].config,repeat_until:'2027-04-28T22:00:00.000Z'});assert.equal((await list('u')).length,0);assert.equal((await list('other')).length,1);
await remove('other','u');assert.equal((await list('other')).length,1);
const server=readFileSync('web/server.mjs','utf8');assert.match(server,/deleteRoutine\(id, user.id, expected\)/);assert.match(server,/e.code==='ROUTINE_CHANGED'\)return send\(res,409/);
await db.close();console.log('PASS: config projection, ownership, stale deletion, timestamp normalization, legacy ownership, HTTP guards');
