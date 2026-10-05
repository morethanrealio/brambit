// Run explicitly on the source host. No application imports or writes to DB.
// Output is encrypted to the local operator's public key, including the single
// model credential. Never export sessions, password hashes or connector secrets.
import {createCipheriv,randomBytes,publicEncrypt} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const arg=n=>process.argv[process.argv.indexOf(n)+1];
const repo=arg('--repo'),owner=arg('--owner'),agent=arg('--agent');
for(const x of [owner,agent])if(!/^[a-f0-9-]{36}$/.test(x||''))throw Error('Explicit owner and agent required');
for(const k of ['PGHOST','PGDATABASE','PGUSER','TOGETHER_API_KEY'])if(!process.env[k])throw Error('Missing '+k);
const {default:pg}=await import(pathToFileURL(repo+'/node_modules/pg/lib/index.js'));
const db=new pg.Client({host:process.env.PGHOST,port:Number(process.env.PGPORT||5432),database:process.env.PGDATABASE,user:process.env.PGUSER,password:process.env.PGPASSWORD,options:'-c default_transaction_read_only=on'});
await db.connect();let snapshot;
try{
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const rows=async(sql,args=[owner])=>(await db.query(sql,args)).rows;
 const user=(await rows('SELECT id,name,timezone,language,country,model_pref,model_auto FROM mtr_harness.users WHERE id=$1 AND deleted_at IS NULL'))[0];
 const assistant=(await rows('SELECT id,user_id,owner,name,goal,instructions,style,profile,summary,model,former_names,category FROM mtr_harness.agents WHERE user_id=$1 AND id=$2 AND archived_at IS NULL',[owner,agent]))[0];
 const participant=(await rows('SELECT user_id,agent_id,status,timezone,lunch,evening,frequency,duration,sensitive,consent_version,consented_at,started_at,ends_at FROM mtr_harness.discovery_participants WHERE user_id=$1 AND agent_id=$2',[owner,agent]))[0];
 if(!user||!assistant||!participant?.started_at)throw Error('Owned account/journey required');
 if(assistant.category!=='pessoal'||assistant.model)throw Error('Sandbox currently supports personal assistants using the default Together model');
 const from=new Date(new Date(participant.started_at).getTime()-20*86400000).toISOString();
 const args=[owner,agent,from];
 const threads=await rows("SELECT id,user_id,agent_id,title,created_at,updated_at FROM mtr_harness.threads WHERE user_id=$1 AND agent_id=$2 AND deleted_at IS NULL AND COALESCE(webhook_skill,'')='' AND EXISTS(SELECT 1 FROM mtr_harness.messages m WHERE m.thread_id=threads.id AND m.ts>=$3)",args);
 const messages=await rows("SELECT m.id,m.agent_id,m.thread_id,m.role,m.content,m.ts FROM mtr_harness.messages m JOIN mtr_harness.threads t ON t.id=m.thread_id WHERE t.user_id=$1 AND t.agent_id=$2 AND m.agent_id=$2 AND t.deleted_at IS NULL AND COALESCE(t.webhook_skill,'')='' AND m.ts>=$3 AND m.role IN ('user','assistant') ORDER BY m.ts,m.id",args);
 snapshot={version:1,capturedAt:new Date().toISOString(),from,user,agent:assistant,participant,threads,messages,
  notes:await rows('SELECT id,user_id,kind,text,quote,thread_id,source_id,sensitive,basis,created_at FROM mtr_harness.discovery_notes WHERE user_id=$1 ORDER BY created_at,id'),
  wiki:await rows("SELECT user_id,slug,title,body,updated_at FROM mtr_harness.wiki_pages WHERE user_id=$1 AND slug='perfil'"),
  connections:await rows("SELECT DISTINCT provider,kind FROM (SELECT provider,kind FROM mtr_harness.connections WHERE user_id=$1 UNION ALL SELECT provider,'oauth' FROM mtr_harness.oauth_tokens WHERE user_id=$1 AND access_token IS NOT NULL UNION ALL SELECT 'google','oauth' FROM mtr_harness.google_accounts g JOIN mtr_harness.agents a ON a.id=$2 AND a.user_id=g.user_id WHERE g.user_id=$1 AND g.access_token IS NOT NULL AND (a.google_email IS NOT NULL AND lower(a.google_email)=lower(g.google_email) OR a.google_email IS NULL AND g.is_primary=true)) c ORDER BY provider,kind",[owner,agent]),
  apps:await rows("SELECT system,description,status FROM mtr_harness.apps WHERE user_id=$1 AND status<>'deleted'"),
  trackers:await rows('SELECT title,kind,unit FROM mtr_harness.trackers WHERE owner_user_id=$1 AND enabled=true'),
  routines:await rows('SELECT title,prompt FROM mtr_harness.routines WHERE user_id=$1 AND agent_id=$2 AND enabled=true',[owner,agent]),
  modelKey:process.env.TOGETHER_API_KEY};
}finally{await db.query('ROLLBACK');await db.end();}
const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
const body=Buffer.concat([cipher.update(gzipSync(JSON.stringify(snapshot))),cipher.final()]);
const encrypted={key:publicEncrypt(await readFile(arg('--public-key')),key).toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),body:body.toString('base64')};
await writeFile(arg('--output'),JSON.stringify(encrypted),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({exported:true,messages:snapshot.messages.length,notes:snapshot.notes.length,threads:snapshot.threads.length,connections:snapshot.connections.length}));
